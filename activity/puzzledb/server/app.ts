/**
 * The puzzle database over HTTP: four pages, two downloads, a health check
 * and the built page's own files — and nothing else.
 *
 * | Path | Answers |
 * |---|---|
 * | `/`, `/days`, `/puzzle/:id`, `/day/:day` | the built page, with this page's head written in |
 * | `/puzzles.json`, `/puzzles.sqlite` | the dataset's bytes, exactly as built |
 * | `/health` | counts and times, never an error's text |
 * | `/assets/*`, `/fonts/*` | files from the build, cached long |
 *
 * Every other path and method is a 404, and that is a decision rather than
 * an absence of one:
 *
 * - **No catch-all static serving and no single-page fallback.** Hono's
 *   static handler serves dotfiles inside its root — a probe answered `/.env`
 *   with 200 — and the build holds more than the page: `petr.png`, the fonts'
 *   README. So static files are served from two prefixes the page actually
 *   asks for, and `/.env`, `/petr.png` and `/index.html` are as missing as
 *   any path that never existed.
 * - **No CORS.** The page is same-origin and no other consumer is named;
 *   `/api/public` on the game server stays the club's cross-origin contract.
 * - **A miss says nothing about why.** A puzzle that is unpublished, written
 *   by a player while those are withheld, or simply absent, and a day that is
 *   today, in the future or before history, all get the same 404 document,
 *   byte for byte. `pageText` decides from the dataset alone, so a stranger
 *   cannot ask this server what it is holding back.
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
  UNAVAILABLE_TEXT,
} from "../wire";
import { injectHead, renderHead } from "./head";
import type { Dataset, RefreshStatus } from "./types";

/** Requests a caller may make a minute, across everything: ample for reading, nothing for a loop. */
export const PER_MINUTE = 600;
/** Downloads of the whole database a caller may make a minute: the one heavy answer here. */
export const DOWNLOADS_PER_MINUTE = 30;

/**
 * On every response.
 *
 * The policy allows exactly what the page uses: its own script, stylesheet,
 * fonts and images, and `fetch` back to this origin for `/puzzles.json`.
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
/** A minute old at most: the refresher looks every thirty seconds. */
const DATA_CACHE = "public, max-age=60";
const NOT_BUILT = "The page is not built yet. /puzzles.json and /puzzles.sqlite still answer.";
const UNAVAILABLE = Object.freeze({
  error: "The puzzle archive is not available yet. Try again in a minute.",
});

const PAGE_PATHS = ["/", "/puzzle/:id{[0-9]+}", "/days", "/day/:day{[0-9]+}"] as const;

export function createSiteApp(deps: SiteDependencies): Hono {
  const limits = deps.limits ?? { perMinute: PER_MINUTE, downloadsPerMinute: DOWNLOADS_PER_MINUTE };
  const app = new Hono();

  app.use("*", securityHeaders);
  app.use("*", rateLimit({ max: limits.perMinute, windowMs: MINUTE }, deps.callerKey));
  app.use("/puzzles.sqlite", rateLimit({ max: limits.downloadsPerMinute, windowMs: MINUTE }, deps.callerKey));
  app.onError(answerFault);

  addDataRoutes(app, deps);
  for (const path of PAGE_PATHS) app.get(path, (c) => page(c, deps));
  app.get("/assets/*", serveStatic({ root: deps.buildRoot, onFound: cachedFor(ASSET_CACHE) }));
  app.get("/fonts/*", serveStatic({ root: deps.buildRoot, onFound: cachedFor(FONT_CACHE) }));

  app.notFound((c) => missing(c, deps.buildRoot));
  return app;
}

const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
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
    return c.body(sent(dataset.json), 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": DATA_CACHE,
    });
  });
  app.get("/puzzles.sqlite", (c) => {
    const dataset = deps.dataset();
    if (!dataset) return c.json(UNAVAILABLE, 503, { ...NO_STORE, "Retry-After": RETRY_AFTER });
    return c.body(sent(dataset.sqlite), 200, {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Disposition": 'attachment; filename="tetrisatuci-puzzles.sqlite"',
      "Cache-Control": DATA_CACHE,
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
  const route = parsePage(new URL(c.req.url).pathname);
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

function lookupIn(dataset: Dataset): SiteLookup {
  return {
    puzzle: (id) => dataset.puzzleById.get(id),
    day: (day) => dataset.dayByNumber.get(day),
  };
}

function cachedFor(cacheControl: string): (path: string, c: Context) => void {
  return (_path, c) => {
    c.header("Cache-Control", cacheControl);
  };
}

function isoOrNull(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}
