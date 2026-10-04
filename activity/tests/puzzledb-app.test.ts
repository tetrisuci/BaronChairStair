/**
 * The puzzle database over HTTP: exactly the routes it means to have, each
 * answering as the plan's table says, and nothing personal in any byte.
 *
 * Driven through `app.request` against a dataset built from the planted game
 * database, and a build root holding what a real build holds besides the
 * page — `petr.png`, and a `.env` somebody left there — because serving those
 * is the failure a catch-all static handler has, and this app must not.
 *
 * Three things are pinned beyond each route's own answer:
 *
 * - **A miss says nothing about why.** An unpublished puzzle, a player's
 *   puzzle, today, a future day and a path that was never a page all get the
 *   same 404 document, byte for byte. A difference between them is a way to
 *   ask the site what it is hiding.
 * - **The headers go on everything**, the 404s, 429s, 503s and 500s
 *   included, since those are the responses nobody looks at.
 * - **Nothing planted comes out**, walking every page, every day, both data
 *   routes, the health check and the built files.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createSiteApp, DOWNLOADS_PER_MINUTE, PER_MINUTE, type SiteDependencies } from "../puzzledb/server/app";
import { buildDataset } from "../puzzledb/server/dataset";
import { HEAD_PLACEHOLDER, injectHead, renderHead } from "../puzzledb/server/head";
import { siteCallerKey } from "../puzzledb/server/main";
import { FIRST_TIERED_DAY } from "../puzzledb/server/policy";
import { openGameDatabase, readSnapshot } from "../puzzledb/server/snapshot";
import type { Dataset, RefreshStatus } from "../puzzledb/server/types";
import {
  NOT_FOUND_TEXT,
  type PageText,
  pageText,
  parsePage,
  type SiteLookup,
  UNAVAILABLE_TEXT,
} from "../puzzledb/wire";
import {
  COMMUNITY_AUTHOR,
  COMMUNITY_ID,
  COMMUNITY_TITLE,
  CORRECTED_ID,
  CORRECTED_TITLE,
  fixtureSources,
  gameFixture,
  type GameFixture,
  NOW,
  PLANTED,
  TODAY,
  UNPUBLISHED_ID,
} from "./puzzledb-fixture";

/** The page template as the build writes it: the placeholder, and one module script. */
const TEMPLATE = [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="utf-8" />',
  `    ${HEAD_PLACEHOLDER}`,
  '    <script type="module" crossorigin src="/assets/app.js"></script>',
  "  </head>",
  '  <body><div id="puzzledb" class="pdb"></div></body>',
  "</html>",
  "",
].join("\n");

const APP_JS = "export const page = 'the archive';\n";
const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02, 0x03]);
/** What Vite copies beside the fonts from `client/public/fonts`: the OFL asks that a licence travel with them. */
const FONT_LICENCE = "Copyright 2020 The Example Project Authors. SIL Open Font License, Version 1.1.\n";
const FONTS_README = "# Fonts\n\nServed from here because Discord blocks the CDN.\n";
const NOT_BUILT = "The page is not built yet. /puzzles.json and /puzzles.sqlite still answer.";
const UNAVAILABLE_JSON = { error: "The puzzle archive is not available yet. Try again in a minute." };

/**
 * The four security headers, written out rather than imported from `app.ts`:
 * a check that asked that module would agree with any change made there, a
 * policy loosened to let an inline script run or a frame embed it included.
 * The CSP is the page's XSS and framing backstop, so its every word is pinned.
 */
const EXPECTED_SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
} as const;

const READY: RefreshStatus = Object.freeze({ ready: true, builtAt: NOW, checkedAt: NOW + 5_000, failing: null });

/** Withheld while the policy keeps player-written puzzles off the site. */
const WITHHELD = [...PLANTED, COMMUNITY_AUTHOR, COMMUNITY_TITLE];
/** Seventeen digits or more: a Discord id is 17 to 20, and nothing public runs that long. */
const DISCORD_SHAPED = /\d{17,}/;
const ATTRIBUTION = /discord:/i;
const AVATAR = /discordapp\.(com|net)|\/avatars\//i;

const scratch: string[] = [];
let game: GameFixture;
let dataset: Dataset;
let lookup: SiteLookup;
/** A complete build. */
let built: string;
/** A deploy that never ran the build: the directory, and nothing in it. */
let unbuilt: string;

beforeAll(() => {
  game = gameFixture();
  const db = openGameDatabase(game.databasePath);
  try {
    dataset = buildDataset(readSnapshot(db, TODAY, FIRST_TIERED_DAY), fixtureSources(game), NOW);
  } finally {
    db.close();
  }
  lookup = { puzzle: (id) => dataset.puzzleById.get(id), day: (day) => dataset.dayByNumber.get(day) };
  built = buildRoot(TEMPLATE);
  unbuilt = buildRoot(null);
});

afterAll(() => {
  game?.cleanup();
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/** A build root as Vite leaves one, with the files around the page that must never be served. */
function buildRoot(template: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "puzzledb-app-"));
  scratch.push(root);
  if (template === null) return root;
  mkdirSync(join(root, "assets"));
  mkdirSync(join(root, "fonts"));
  writeFileSync(join(root, "index.html"), template);
  writeFileSync(join(root, "assets/app.js"), APP_JS);
  writeFileSync(join(root, "fonts/x.woff2"), FONT);
  writeFileSync(join(root, "fonts/OFL-X.txt"), FONT_LICENCE);
  writeFileSync(join(root, "fonts/README.md"), FONTS_README);
  writeFileSync(join(root, "petr.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(root, ".env"), "SESSION_SECRET=planted-build-root-secret\n");
  return root;
}

interface AppOptions {
  readonly dataset?: Dataset | null;
  readonly status?: RefreshStatus;
  readonly buildRoot?: string;
  readonly limits?: SiteDependencies["limits"];
}

/** The site as `main.ts` wires it — the same caller key — over whatever a test hands in. */
function siteApp(options: AppOptions = {}): Hono {
  const served = options.dataset === undefined ? dataset : options.dataset;
  return createSiteApp({
    dataset: () => served,
    status: () => options.status ?? READY,
    buildRoot: options.buildRoot ?? built,
    callerKey: siteCallerKey,
    limits: options.limits,
  });
}

function from(address: string): RequestInit {
  return { headers: { "Cf-Connecting-Ip": address } };
}

/** Everything a caller receives, so two answers can be compared whole. */
async function answerOf(app: Hono, path: string, init?: RequestInit) {
  const response = await app.request(path, init);
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

function documentWith(text: PageText): string {
  return injectHead(TEMPLATE, renderHead(text));
}

/** All four security headers on `response`, each with exactly the value written above. */
function expectSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
    expect(response.headers.get(name)).toBe(value);
  }
}

async function bytesOf(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** Every listed page, and every listed day's page. */
function listedPages(): string[] {
  return [
    "/",
    "/days",
    ...dataset.data.puzzles.map((puzzle) => `/puzzle/${puzzle.id}`),
    ...dataset.data.days.map((day) => `/day/${day.day}`),
  ];
}

describe("the data", () => {
  test("serves the dataset's JSON and SQLite byte for byte, with their types, caching and download name", async () => {
    const app = siteApp();

    // Twice, because the same bytes go out to every caller until the next build.
    for (let round = 0; round < 2; round += 1) {
      const json = await app.request("/puzzles.json");
      expect(json.status).toBe(200);
      expect(json.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(json.headers.get("Cache-Control")).toBe("no-cache");
      expect(json.headers.get("ETag")).toMatch(/^"[0-9a-z]+"$/);
      expect((await bytesOf(json)).equals(Buffer.from(dataset.json))).toBe(true);

      const sqlite = await app.request("/puzzles.sqlite");
      expect(sqlite.status).toBe(200);
      expect(sqlite.headers.get("Content-Type")).toBe("application/vnd.sqlite3");
      expect(sqlite.headers.get("Content-Disposition")).toBe('attachment; filename="tetrisatuci-puzzles.sqlite"');
      expect(sqlite.headers.get("Cache-Control")).toBe("no-cache");
      expect(sqlite.headers.get("ETag")).toMatch(/^"[0-9a-z]+"$/);
      expect((await bytesOf(sqlite)).equals(Buffer.from(dataset.sqlite))).toBe(true);
    }

    const head = await app.request("/puzzles.json", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await head.text()).toBe("");
  });

  test("lets a reader revalidate either download: 304 and no body while it holds these bytes, the bytes once they change", async () => {
    // Revalidated, never cached blind: a page holding last minute's JSON would
    // call a puzzle published since missing while the server's own document
    // for it answers 200. A 304 costs a header, so asking every time is cheap.
    const app = siteApp();
    for (const path of ["/puzzles.json", "/puzzles.sqlite"]) {
      const tag = (await app.request(path)).headers.get("ETag")!;
      for (const method of ["GET", "HEAD"]) {
        for (const held of [tag, `W/${tag}`, `"another", ${tag}`, "*"]) {
          const again = await app.request(path, { method, headers: { "If-None-Match": held } });
          expect(again.status).toBe(304);
          expect(again.headers.get("ETag")).toBe(tag);
          expect(again.headers.get("Cache-Control")).toBe("no-cache");
          expectSecurityHeaders(again);
          expect(await again.text()).toBe("");
        }
      }
      expect((await app.request(path, { headers: { "If-None-Match": '"stale"' } })).status).toBe(200);
    }

    // A new build is new bytes, so a new tag, and a reader holding the old one gets the new data.
    const db = openGameDatabase(game.databasePath);
    let rebuilt: Dataset;
    try {
      rebuilt = buildDataset(readSnapshot(db, TODAY, FIRST_TIERED_DAY), fixtureSources(game), NOW + 60_000);
    } finally {
      db.close();
    }
    const newer = siteApp({ dataset: rebuilt });
    for (const path of ["/puzzles.json", "/puzzles.sqlite"]) {
      const held = (await app.request(path)).headers.get("ETag")!;
      const answer = await newer.request(path, { headers: { "If-None-Match": held } });
      expect(answer.status).toBe(200);
      expect(answer.headers.get("ETag")).not.toBe(held);
    }
  });

  test("answers HEAD with what GET would send, its length included", async () => {
    // Hono answers HEAD by dropping GET's body, and with no length of its own
    // Bun then writes Content-Length: 0 — which RFC 9110 forbids when GET's
    // body is not empty, and which a link checker reads as an empty page.
    const app = siteApp();
    const puzzle = dataset.data.puzzles[0]!.id;
    const paths = ["/", `/puzzle/${puzzle}`, "/days", "/puzzles.json", "/puzzles.sqlite", "/health"];
    for (const path of [...paths, "/assets/app.js", "/fonts/x.woff2", "/no-such-page"]) {
      const get = await app.request(path);
      const length = (await get.arrayBuffer()).byteLength;
      const head = await app.request(path, { method: "HEAD" });

      expect(head.status).toBe(get.status);
      expect(head.headers.get("Content-Length")).toBe(String(length));
      expect(await head.text()).toBe("");
    }
  });

  test("answers 503 with Retry-After and no-store before the first dataset, and the health check says only ok: false", async () => {
    const app = siteApp({
      dataset: null,
      status: { ready: false, builtAt: null, checkedAt: NOW, failing: "cannot open /srv/planted-failure-path" },
    });

    for (const path of ["/puzzles.json", "/puzzles.sqlite"]) {
      const response = await app.request(path);
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Disposition")).toBeNull();
      expect(await response.json()).toEqual(UNAVAILABLE_JSON);
    }

    const health = await app.request("/health");
    expect(health.status).toBe(503);
    expect(health.headers.get("Cache-Control")).toBe("no-store");
    expect(await health.json()).toEqual({ ok: false, checkedAt: iso(NOW) });
  });

  test("reports health without error text, never cached", async () => {
    const app = siteApp({
      status: { ready: true, builtAt: NOW, checkedAt: NOW + 5_000, failing: "planted-failure-text" },
    });

    const health = await app.request("/health");
    const body = await health.text();

    expect(health.status).toBe(200);
    expect(health.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(body)).toEqual({
      ok: true,
      puzzles: dataset.data.puzzles.length,
      days: dataset.data.days.length,
      throughDay: TODAY - 1,
      builtAt: iso(NOW),
      checkedAt: iso(NOW + 5_000),
    });
    expect(body).not.toContain("planted-failure-text");
  });
});

describe("the pages", () => {
  test("serves each listed puzzle and day with its own title and description", async () => {
    const app = siteApp();

    for (const path of listedPages()) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      expect(await response.text()).toBe(documentWith(pageText(parsePage(path)!, lookup)!));
    }
    // One read by eye: the corrected title, as players are dealt it.
    expect(await (await app.request(`/puzzle/${CORRECTED_ID}`)).text()).toContain(
      `<title>#${CORRECTED_ID} ${CORRECTED_TITLE} — Puzzle archive</title>`,
    );
  });

  test("answers an unlisted puzzle, whether unpublished, player-written or missing, byte for byte like a page that never existed", async () => {
    const app = siteApp();
    const never = await answerOf(app, "/no-such-page");
    expect(never.status).toBe(404);
    expect(never.body).toBe(documentWith(NOT_FOUND_TEXT));

    for (const id of [UNPUBLISHED_ID, COMMUNITY_ID, 9999]) {
      expect(dataset.puzzleById.has(id)).toBe(false);
      expect(await answerOf(app, `/puzzle/${id}`)).toEqual(never);
    }
  });

  test("answers today, a future day, a day before history and an unrecorded day byte for byte like a missing page", async () => {
    const app = siteApp();
    const never = await answerOf(app, "/no-such-page");
    const unrecorded = FIRST_TIERED_DAY + 2;
    expect(dataset.dayByNumber.has(unrecorded)).toBe(false);

    for (const day of [TODAY, TODAY + 1, FIRST_TIERED_DAY - 1, unrecorded]) {
      expect(await answerOf(app, `/day/${day}`)).toEqual(never);
    }
  });

  test("treats /puzzle/007, /puzzle/12abc and /days/ as missing pages", async () => {
    const app = siteApp();
    const never = await answerOf(app, "/no-such-page");

    // A second spelling of a real page included: the page's own router reads
    // the path undecoded, so the server must too, or the two would disagree.
    for (const path of ["/puzzle/007", "/puzzle/12abc", "/days/", "/PUZZLE/12", "/day/0", "/puzzle/%31%32"]) {
      expect(await answerOf(app, path)).toEqual(never);
    }
  });

  test("serves a 503 page while there is no dataset, and a plain 503 while the page is not built", async () => {
    const empty = siteApp({ dataset: null });
    for (const path of ["/", "/days", `/puzzle/${CORRECTED_ID}`, `/day/${TODAY - 1}`]) {
      const response = await empty.request(path);
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(await response.text()).toBe(documentWith(UNAVAILABLE_TEXT));
    }
    // What is never a page needs no data to say so.
    expect((await empty.request("/no-such-page")).status).toBe(404);

    const unbuiltSite = siteApp({ buildRoot: unbuilt });
    const page = await unbuiltSite.request("/");
    expect(page.status).toBe(503);
    expect(await page.text()).toBe(NOT_BUILT);
    expect((await unbuiltSite.request("/no-such-page")).status).toBe(404);
    expect((await unbuiltSite.request("/puzzles.json")).status).toBe(200);
    expect((await unbuiltSite.request("/health")).status).toBe(200);
  });
});

describe("what else answers", () => {
  test("serves the fonts' licence and README beside them, as the OFL asks", async () => {
    const app = siteApp();
    for (const [path, body] of [["/fonts/OFL-X.txt", FONT_LICENCE], ["/fonts/README.md", FONTS_README]] as const) {
      const answer = await app.request(path);
      expect(answer.status).toBe(200);
      expect(answer.headers.get("Cache-Control")).toBe("public, max-age=604800");
      expect(await answer.text()).toBe(body);
    }
  });

  test("serves built assets and fonts with long caching, and nothing else from the build", async () => {
    const app = siteApp();
    const never = await answerOf(app, "/no-such-page");

    const script = await app.request("/assets/app.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await script.text()).toBe(APP_JS);

    const font = await app.request("/fonts/x.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("Cache-Control")).toBe("public, max-age=604800");
    expect((await bytesOf(font)).equals(Buffer.from(FONT))).toBe(true);

    const strays = ["/.env", "/petr.png", "/index.html", "/assets/missing.js", "/assets", "/assets/"];
    const tricks = ["/ASSETS/app.js", "/assets/../.env", "/assets/%2e%2e/.env", "/fonts/..%2f.env"];
    for (const path of [...strays, ...tricks]) {
      expect(await answerOf(app, path)).toEqual(never);
    }
  });

  test("answers a name no file can have like any other miss, and logs nothing", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = siteApp();
      const never = await answerOf(app, "/no-such-page");
      // `Bun.file` throws, rather than missing, on a NUL byte or on a path past
      // the system's limit — 1,024 bytes on macOS, 4,096 on Linux, so 5,000 is
      // past both. And Hono decodes the path twice on the way to the disk, so
      // `%%300` arrives there as a NUL as surely as `%00` does.
      const unnameable = [
        "/assets/%00",
        "/fonts/x%00.woff2",
        "/assets/%%300",
        `/assets/${"a".repeat(5_000)}`,
        `/assets/${"a/".repeat(2_500)}app.js`,
      ];

      for (const path of unnameable) expect(await answerOf(app, path)).toEqual(never);
      // A thrown miss would have been logged whole, stack and checkout path included.
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test("answers POST, PUT, PATCH, DELETE and OPTIONS with 404 everywhere", async () => {
    const app = siteApp();
    const paths = [...listedPages().slice(0, 4), "/puzzles.json", "/puzzles.sqlite", "/health"];

    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const path of [...paths, "/assets/app.js", "/fonts/x.woff2", "/no-such-page"]) {
        const response = await app.request(path, { method });
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("Not found");
      }
    }
  });

  test("registers exactly these routes and middleware, and nothing else on any method", () => {
    const table = siteApp().routes.map((route) => `${route.method} ${route.path}`);

    // The whole table, ALL entries too. Hono lists middleware as ALL, and
    // lists `app.all()` and `app.mount()` the same way — and those answer
    // every method — so waving ALL through as "middleware" would let a route
    // that takes a POST land unseen. The three are the security headers and
    // the per-minute limiter on everything, and the download limiter.
    expect(table.sort()).toEqual(
      [
        "ALL /*",
        "ALL /*",
        "ALL /puzzles.sqlite",
        "GET /puzzles.json",
        "GET /puzzles.sqlite",
        "GET /health",
        "GET /",
        "GET /puzzle/:id{[0-9]+}",
        "GET /days",
        "GET /day/:day{[0-9]+}",
        "GET /assets/*",
        "GET /fonts/*",
      ].sort(),
    );
  });
});

describe("headers and limits", () => {
  test("puts the four security headers on every response, 404, 429 and 503 included", async () => {
    const app = siteApp({ limits: { perMinute: 1_000, downloadsPerMinute: 1 } });
    const answers = [
      await app.request("/"),
      await app.request(`/puzzle/${CORRECTED_ID}`, { method: "HEAD" }),
      await app.request("/puzzles.json"),
      await app.request("/health"),
      await app.request("/assets/app.js"),
      await app.request("/no-such-page"),
      await app.request("/", { method: "POST" }),
      await app.request("/puzzles.sqlite"),
      await app.request("/puzzles.sqlite"),
      await siteApp({ dataset: null }).request("/"),
      await siteApp({ dataset: null }).request("/puzzles.json"),
      await siteApp({ buildRoot: unbuilt }).request("/"),
    ];

    expect(answers.map((response) => response.status)).toEqual([
      200, 200, 200, 200, 200, 404, 404, 200, 429, 503, 503, 503,
    ]);
    for (const response of answers) expectSecurityHeaders(response);
  });

  test("answers a fault with a plain 500 that keeps its headers, and logs it", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      // A template with no placeholder: a build this server was not written against.
      const app = siteApp({ buildRoot: buildRoot("<!doctype html><html><head></head></html>") });

      const response = await app.request("/");

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Something went wrong on the server");
      expectSecurityHeaders(response);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[0]).toBe("[puzzledb]");
    } finally {
      error.mockRestore();
    }
  });

  test("limits a caller to the per-minute budget without slowing anybody else", async () => {
    expect(PER_MINUTE).toBe(600);
    const app = siteApp({ limits: { perMinute: 3, downloadsPerMinute: 3 } });
    for (let i = 0; i < 3; i += 1) expect((await app.request("/", from("198.51.100.1"))).status).toBe(200);

    const refused = await app.request("/days", from("198.51.100.1"));

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await refused.json()).toEqual({ error: "Slow down a moment." });
    expect((await app.request("/", from("198.51.100.2"))).status).toBe(200);
  });

  test("limits SQLite downloads to their own budget per caller", async () => {
    // The default budget, so the number that ships is the number tested.
    const app = siteApp();
    for (let i = 0; i < DOWNLOADS_PER_MINUTE; i += 1) {
      expect((await app.request("/puzzles.sqlite", from("198.51.100.3"))).status).toBe(200);
    }

    expect((await app.request("/puzzles.sqlite", from("198.51.100.3"))).status).toBe(429);
    expect((await app.request("/puzzles.json", from("198.51.100.3"))).status).toBe(200);
    expect((await app.request("/puzzles.sqlite", from("198.51.100.4"))).status).toBe(200);
  });

  test("keys callers on Cf-Connecting-Ip, then the last X-Forwarded-For entry", async () => {
    const app = siteApp({ limits: { perMinute: 1, downloadsPerMinute: 1 } });
    const forwarded = (chain: string): RequestInit => ({ headers: { "X-Forwarded-For": chain } });

    expect((await app.request("/", from("198.51.100.7"))).status).toBe(200);
    expect((await app.request("/", from("198.51.100.7"))).status).toBe(429);
    // The same caller, as the proxy's last hop wrote it.
    expect((await app.request("/", forwarded("203.0.113.1, 198.51.100.7"))).status).toBe(429);
    // The client writes the front of the chain, so that is no way to borrow a bucket.
    expect((await app.request("/", forwarded("198.51.100.7, 198.51.100.8"))).status).toBe(200);
    // And Cf-Connecting-Ip is asked first.
    const both = { headers: { "Cf-Connecting-Ip": "198.51.100.9", "X-Forwarded-For": "198.51.100.7" } };
    expect((await app.request("/", both)).status).toBe(200);
  });
});

describe("privacy over HTTP", () => {
  test("no body on any registered GET route carries a planted value, a Discord-shaped number, discord: or an avatar URL", async () => {
    const app = siteApp({ limits: { perMinute: 10_000, downloadsPerMinute: 10 } });
    const paths = [
      ...listedPages(),
      `/puzzle/${UNPUBLISHED_ID}`,
      `/day/${TODAY}`,
      "/puzzles.json",
      "/puzzles.sqlite",
      "/health",
      "/assets/app.js",
      "/fonts/x.woff2",
    ];
    const leaks: string[] = [];

    for (const path of paths) {
      const response = await app.request(path);
      // latin1, so every byte of the download is a character a search can see.
      const body = (await bytesOf(response)).toString("latin1");
      const values = WITHHELD.filter((value) => body.includes(value));
      const shapes = [DISCORD_SHAPED, ATTRIBUTION, AVATAR].flatMap((pattern) => pattern.exec(body)?.[0] ?? []);
      for (const leak of [...values, ...shapes]) leaks.push(`${path}: ${leak}`);
    }

    expect(paths.length).toBeGreaterThan(dataset.data.puzzles.length);
    expect(leaks).toEqual([]);
  });
});

/**
 * One request written straight onto a socket, and the response read back by
 * its Content-Length: for what `app.request` cannot build and `fetch` will not
 * send, such as a Host header no URL can be made of. Read by length, not until
 * the server hangs up, because Bun keeps the connection open after the app's
 * answers even when asked to close it.
 */
function rawRequest(port: number, lines: readonly string[]): Promise<{ head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const received = Buffer.concat(chunks);
      const end = received.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = received.subarray(0, end).toString("latin1");
      const body = received.subarray(end + 4);
      if (body.length < Number(/^content-length:\s*(\d+)/im.exec(head)?.[1] ?? 0)) return;
      socket.destroy();
      resolve({ head, body: body.toString("utf8") });
    });
    socket.on("error", reject);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

/** The site behind a real `Bun.serve`, as `main.ts` wires it, for as long as `use` runs. */
async function overSocket(use: (port: number) => Promise<void>): Promise<void> {
  const app = siteApp();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request, bun) => app.fetch(request, bun) });
  try {
    await use(server.port!);
  } finally {
    server.stop(true);
  }
}

describe("over a socket", () => {
  test("answers a Host no URL can be made of with the 404 document, never a 500", async () => {
    // Bun builds the request's URL from the Host header as sent, so these reach
    // the app as URLs nothing can parse. No proxy in the deploy guide forwards
    // one, but a request straight to the port can.
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await overSocket(async (port) => {
        for (const host of ["a b", "[::1", "x:99999"]) {
          const { head, body } = await rawRequest(port, [`GET /day/${TODAY - 1} HTTP/1.1`, `Host: ${host}`]);

          expect(head.split("\r\n")[0]).toBe("HTTP/1.1 404 Not Found");
          expect(body).toBe(documentWith(NOT_FOUND_TEXT));
        }
      });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
