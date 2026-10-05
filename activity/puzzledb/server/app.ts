/**
 * The puzzle database over HTTP: seven pages, two downloads, the pages'
 * bodies, a health check and the built page's own files — and nothing else.
 *
 * | Path | Answers |
 * |---|---|
 * | `/`, `/days`, `/puzzle/:id`, `/day/:day`, `/leaderboards`, `/players`, `/player/:key` | the built page, with this page's head written in |
 * | `/puzzles.json`, `/puzzles.sqlite` | the dataset's bytes, exactly as built |
 * | `/data/*` | one page's body, exactly as built, or the one JSON miss |
 * | `/health` | counts and times, never an error's text |
 * | `/assets/*`, `/fonts/*` | files from the build, cached long |
 *
 * Every other path and method is a 404, and that is a decision rather than
 * an absence of one:
 *
 * - **No catch-all static serving and no single-page fallback.** Hono's
 *   static handler serves dotfiles inside its root — a probe answered `/.env`
 *   with 200 — and the build holds more than the page: `petr.png` and the
 *   template itself. So static files are served from the two prefixes the
 *   page actually asks for, and `/.env`, `/petr.png` and `/index.html` are as
 *   missing as any path that never existed. `/fonts/*` does serve the fonts'
 *   licence texts and README along with the fonts, on purpose: the OFL asks
 *   that the licence travel with the font files.
 * - **A path no file can have is a miss, not a fault.** `Bun.file` throws on
 *   a NUL byte or a path past the system's limit rather than finding nothing,
 *   and Hono's static handler does not catch it, so without a guard an
 *   encoded NUL would answer 500 and write a stack trace to the log.
 * - **No CORS.** The page is same-origin and no other consumer is named;
 *   `/api/public` on the game server stays the club's cross-origin contract.
 * - **A miss says nothing about why.** A puzzle that is unpublished, written
 *   by a player while those are withheld, or simply absent, and a day that is
 *   today, in the future or before history, all get the same 404 document,
 *   byte for byte. `pageText` decides from the dataset alone, so a stranger
 *   cannot ask this server what it is holding back. A player who chose to
 *   hide, a key nobody holds and a key from before a hide are one miss in the
 *   same way, and so is every path under `/data/` the build made no body for:
 *   a body exists exactly where its page does, and the rest share one JSON 404.
 *
 * The security headers go on every response — the 404s, 429s, 503s and 500s
 * included — set after the handler has run, the way Hono's own
 * `secureHeaders` does, so they land on whatever the handler, the limiter or
 * the error handler built.
 *
 * **One app, built from what it is handed.** It reads no setting and opens no
 * file but the build's, so it could be mounted in the game server one day.
 * Only by delegation on the Host header, though:
 * `if (host === "db.tetrisatuci.org") return siteApp.fetch(c.req.raw, c.env)`.
 * Never `app.route()`, which merges middleware by path — a probe showed the
 * game's CORS `*` reaching `/api/session` that way — and never a `register*`
 * function, which this module deliberately does not export.
 */

import { join } from "node:path";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { rateLimit } from "../../server/rate-limit";
import {
  NOT_FOUND_TEXT,
  type PageText,
  pageText,
  parsePage,
  type SiteLookup,
  type SitePlayerEntry,
  UNAVAILABLE_TEXT,
} from "../wire";
import { injectHead, renderHead } from "./head";
import type { Dataset, RefreshStatus } from "./types";

/** Requests a caller may make a minute, across everything: ample for reading, nothing for a loop. */
export const PER_MINUTE = 600;
/**
 * Downloads of the whole database a caller may make a minute: the one heavy
 * answer here that nobody needs twice.
 *
 * `/puzzles.json` is as large, and deliberately not under this budget: the
 * page fetches it once per visit, so a cap of thirty would lock out a whole
 * campus arriving from one NAT address. It answers a revalidation with a
 * bodyless 304 instead, and stays under the per-minute budget like everything.
 */
export const DOWNLOADS_PER_MINUTE = 30;

/**
 * On every response.
 *
 * The policy allows exactly what the page uses: its own script, stylesheet,
 * fonts and images, and `fetch` back to this origin for `/puzzles.json` and
 * the `/data/` bodies.
 * Inline styling done through the CSSOM — `el()`, the glyphs, the board's
 * canvas — is allowed under `style-src 'self'`; inline `<script>` and
 * `style=` attributes are not, and the build has neither. Nobody may frame
 * the site, and it sends no form anywhere.
 */
export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
} as const);

export interface SiteDependencies {
  /** Asked per request, because the refresher swaps it. */
  dataset(): Dataset | null;
  status(): RefreshStatus;
  /** The absolute path of the page's build, `puzzledb/dist`. */
  readonly buildRoot: string;
  readonly callerKey: (c: Context) => string;
  /** The two budgets, which a test shrinks. */
  readonly limits?: { readonly perMinute: number; readonly downloadsPerMinute: number };
}

const MINUTE = 60_000;
/** One poll of the refresher: by then there may be something to serve. */
const RETRY_AFTER = "30";
const NO_STORE = Object.freeze({ "Cache-Control": "no-store" });
/** Hashed file names change with their content, so a year is safe. Fonts keep their names. */
const ASSET_CACHE = "public, max-age=31536000, immutable";
const FONT_CACHE = "public, max-age=604800";
/**
 * Revalidated on every use, never cached blind. Documents are always fresh, so
 * a page holding even a minute-old `/puzzles.json` could call a puzzle missing
 * that the server just answered 200 for. With the ETag, asking costs a 304.
 */
const DATA_CACHE = "no-cache";
const NOT_BUILT = "The page is not built yet. /puzzles.json and /puzzles.sqlite still answer.";
const UNAVAILABLE = Object.freeze({
  error: "The puzzle archive is not available yet. Try again in a minute.",
});

/**
 * The page routes. `/player/:key` takes any segment and leaves the spelling to
 * `parsePage`, which every page route reads the raw path through anyway: a
 * second copy of the key's alphabet here could only disagree with it.
 */
const PAGE_PATHS = [
  "/",
  "/puzzle/:id{[0-9]+}",
  "/days",
  "/day/:day{[0-9]+}",
  "/leaderboards",
  "/players",
  "/player/:key",
] as const;

/** Every miss under `/data/`, byte for byte: a page's body is JSON, so its miss is too. */
const DATA_MISS = JSON.stringify({ error: "Not found" });
const JSON_TYPE = "application/json; charset=utf-8";

export function createSiteApp(deps: SiteDependencies): Hono {
  const limits = deps.limits ?? { perMinute: PER_MINUTE, downloadsPerMinute: DOWNLOADS_PER_MINUTE };
  const app = new Hono();

  app.use("*", finishEveryAnswer);
  app.use("*", rateLimit({ max: limits.perMinute, windowMs: MINUTE }, deps.callerKey));
  app.use("/puzzles.sqlite", rateLimit({ max: limits.downloadsPerMinute, windowMs: MINUTE }, deps.callerKey));
  app.onError(answerFault);

  addDataRoutes(app, deps);
  for (const path of PAGE_PATHS) app.get(path, (c) => page(c, deps));
  app.get("/assets/*", builtFiles(deps.buildRoot, ASSET_CACHE));
  app.get("/fonts/*", builtFiles(deps.buildRoot, FONT_CACHE));

  app.notFound((c) => missing(c, deps.buildRoot));
  return app;
}

/**
 * What every response gets once its handler has run: the security headers,
 * and for a HEAD the length GET would have sent.
 *
 * Hono answers HEAD by running the GET route and dropping its body, and with
 * no length set Bun then writes `Content-Length: 0`, which RFC 9110 forbids
 * for a body that is not empty. So a HEAD reads its own body's length here,
 * while it still has the body. Only HEAD pays for that, and nothing here is
 * large. One middleware rather than two, so the route table stays the short
 * list a test pins.
 */
const finishEveryAnswer: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
  if (c.req.method === "HEAD" && c.res.body !== null && !c.res.headers.has("Content-Length")) {
    c.res.headers.set("Content-Length", String((await c.res.clone().arrayBuffer()).byteLength));
  }
};

/**
 * The limiter's 429 keeps the response it was thrown with, `Retry-After` and
 * all. Anything else is a fault of ours: logged whole, answered with a
 * sentence that says nothing about the server.
 */
function answerFault(error: Error, c: Context): Response {
  if (error instanceof HTTPException) return error.getResponse();
  console.error("[puzzledb]", error);
  return c.text("Something went wrong on the server", 500);
}

function addDataRoutes(app: Hono, deps: SiteDependencies): void {
  app.get("/puzzles.json", (c) => {
    const dataset = deps.dataset();
    if (!dataset) return c.json(UNAVAILABLE, 503, { ...NO_STORE, "Retry-After": RETRY_AFTER });
    return download(c, dataset.json, { "Content-Type": JSON_TYPE });
  });
  app.get("/data/*", (c) => body(c, deps));
  app.get("/puzzles.sqlite", (c) => {
    const dataset = deps.dataset();
    if (!dataset) return c.json(UNAVAILABLE, 503, { ...NO_STORE, "Retry-After": RETRY_AFTER });
    return download(c, dataset.sqlite, {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Disposition": 'attachment; filename="tetrisatuci-puzzles.sqlite"',
    });
  });
  // Counts and times only. Why a build failed is for the log, which an
  // operator reads; this answers anybody.
  app.get("/health", (c) => {
    const dataset = deps.dataset();
    const checkedAt = isoOrNull(deps.status().checkedAt);
    if (!dataset) return c.json({ ok: false, checkedAt }, 503, NO_STORE);
    const { about, puzzles, days } = dataset.data;
    return c.json(
      { ok: true, puzzles: puzzles.length, days: days.length, throughDay: about.throughDay, builtAt: about.builtAt, checkedAt },
      200,
      NO_STORE,
    );
  });
}

/**
 * One of the dataset's byte arrays — a download or a body — or a bodyless 304 when the caller
 * already holds exactly these bytes.
 *
 * The tag is the bytes' own hash, so it changes exactly when they do. Every
 * build stamps `about.built_at` into both, so each rebuild — a restart
 * included — is a new tag; between rebuilds the same bytes keep it.
 */
function download(c: Context, bytes: Uint8Array, headers: Readonly<Record<string, string>>): Response {
  const tag = etagOf(bytes);
  const fresh = { ETag: tag, "Cache-Control": DATA_CACHE };
  if (holds(c.req.header("If-None-Match"), tag)) return c.body(null, 304, fresh);
  return c.body(sent(bytes), 200, { ...headers, ...fresh });
}

/**
 * One page's body, looked up by the path exactly as the browser sent it.
 *
 * Undecoded, for the reason `page` gives: `/data/day/%32%37%34.json` is not a
 * second address for day 274's body. The build keyed every body by the path
 * `bodyPathFor` gives its page, so a lookup is the whole of the routing, and
 * anything it does not find — today, a puzzle withheld, a player who hid, a
 * typo — is the same miss.
 */
function body(c: Context, deps: SiteDependencies): Response {
  const dataset = deps.dataset();
  if (!dataset) return c.json(UNAVAILABLE, 503, { ...NO_STORE, "Retry-After": RETRY_AFTER });
  const pathname = URL.parse(c.req.url)?.pathname;
  const bytes = pathname === undefined ? undefined : dataset.bodies.get(pathname);
  if (bytes === undefined) return c.body(DATA_MISS, 404, { "Content-Type": JSON_TYPE });
  return download(c, bytes, { "Content-Type": JSON_TYPE });
}

/** Hashed once per array: a dataset's bytes never change, the refresher swaps whole datasets. */
const etags = new WeakMap<Uint8Array, string>();

function etagOf(bytes: Uint8Array): string {
  let tag = etags.get(bytes);
  if (tag === undefined) {
    tag = `"${Bun.hash(bytes).toString(36)}"`;
    etags.set(bytes, tag);
  }
  return tag;
}

/**
 * Whether an `If-None-Match` names `tag`: any entry of the list, weak or
 * strong (a GET compares them weakly), or `*`.
 */
function holds(ifNoneMatch: string | undefined, tag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((entry) => {
    const held = entry.trim();
    return held === "*" || held === tag || held === `W/${tag}`;
  });
}

/**
 * The bytes a dataset holds, as Hono's body type spells them.
 *
 * Both arrays are backed by a plain `ArrayBuffer` — one from `TextEncoder`,
 * one from SQLite's `serialize()` — which is what the narrower type says.
 * Sent as they are, never copied: every caller gets the same bytes until the
 * refresher swaps the dataset.
 */
function sent(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

/**
 * A page: the built document with this page's head written in.
 *
 * The template is read per request, so a page-only rebuild needs no restart.
 * The route is read from the path as the browser has it, undecoded — Hono
 * decodes `c.req.path`, which would make `/puzzle/%31%32` a second address for
 * `/puzzle/12`, while the page's own router reads `location.pathname` raw and
 * calls it missing. One spelling per page, on both sides.
 */
async function page(c: Context, deps: SiteDependencies): Promise<Response> {
  const template = await readTemplate(deps.buildRoot);
  if (template === null) return c.text(NOT_BUILT, 503, NO_STORE);
  // `URL.parse`, not `new URL`: a Host header no URL can be made of (`a b`,
  // `[::1`) reaches the app as an unparseable URL, and a miss must never be a 500.
  const pathname = URL.parse(c.req.url)?.pathname;
  const route = pathname === undefined ? null : parsePage(pathname);
  if (route === null) return documentFor(c, template, NOT_FOUND_TEXT, 404);
  const dataset = deps.dataset();
  if (!dataset) return documentFor(c, template, UNAVAILABLE_TEXT, 503);
  const text = pageText(route, lookupIn(dataset));
  return text ? documentFor(c, template, text, 200) : documentFor(c, template, NOT_FOUND_TEXT, 404);
}

/**
 * Everything no route answered, and every miss a route passed on.
 *
 * A GET or HEAD gets the 404 document, the same bytes as a missing puzzle;
 * any other method gets two words, since nothing here takes a body.
 */
async function missing(c: Context, buildRoot: string): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Not found", 404);
  const template = await readTemplate(buildRoot);
  if (template === null) return c.text("Not found", 404);
  return documentFor(c, template, NOT_FOUND_TEXT, 404);
}

function documentFor(c: Context, template: string, text: PageText, status: 200 | 404 | 503): Response {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    ...(status === 503 ? { "Retry-After": RETRY_AFTER } : {}),
  };
  return c.body(injectHead(template, renderHead(text)), status, headers);
}

/** The built `index.html`, or null when there is no build: a deploy that skipped `build:puzzledb`. */
async function readTemplate(buildRoot: string): Promise<string | null> {
  try {
    return await Bun.file(join(buildRoot, "index.html")).text();
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return null;
    throw error;
  }
}

/** Each dataset's players by key, built on its first player page and dropped with it. */
const playersByKey = new WeakMap<Dataset, ReadonlyMap<string, SitePlayerEntry>>();

function lookupIn(dataset: Dataset): SiteLookup {
  return {
    puzzle: (id) => dataset.puzzleById.get(id),
    day: (day) => dataset.dayByNumber.get(day),
    player: (key) => {
      let players = playersByKey.get(dataset);
      if (players === undefined) {
        players = new Map(dataset.data.players.map((player) => [player.key, player]));
        playersByKey.set(dataset, players);
      }
      return players.get(key);
    },
  };
}

/**
 * The build's files under one prefix, cached for `cacheControl`, with every
 * path no file can have answered as the miss it is.
 *
 * Caught where `Bun.file` throws rather than guessed at beforehand: Hono
 * decodes the path twice on the way to the disk, so `%%300` arrives there as
 * a NUL that no check of the request's own path would see. Any other error is
 * a real fault and still reaches the error handler.
 */
function builtFiles(buildRoot: string, cacheControl: string): MiddlewareHandler {
  const serve = serveStatic({ root: buildRoot, onFound: cachedFor(cacheControl) });
  return async (c, next) => {
    try {
      return await serve(c, next);
    } catch (error) {
      if (unnameable(error)) return missing(c, buildRoot);
      throw error;
    }
  };
}

/** What `Bun.file` throws for a name no file can have: a NUL, or past the system's path limit. */
function unnameable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ERR_INVALID_ARG_VALUE" || code === "ENAMETOOLONG";
}

function cachedFor(cacheControl: string): (path: string, c: Context) => void {
  return (_path, c) => {
    c.header("Cache-Control", cacheControl);
  };
}

function isoOrNull(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}
