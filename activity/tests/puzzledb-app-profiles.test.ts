/**
 * The profile browser over HTTP: the `/solves` page, the players table's body
 * and the feed's steering body, each answering as the plan's table says, and
 * nothing personal in any byte of them.
 *
 * Beside `puzzledb-app.test.ts` rather than in it only for length; it drives
 * the same app the same way, through `app.request` against a dataset built
 * from the planted game database, and holds the new routes to the same three
 * rules:
 *
 * - **One spelling per page.** `/solves` is the page whatever its query
 *   string says — the filters are the page's business, read in the browser —
 *   and every other spelling of it is the 404 document, byte for byte.
 * - **A miss under `/data/` is the one JSON miss**, a near-spelling of a new
 *   body included.
 * - **Nothing planted comes out**, with a positive control beside each scan,
 *   because a scan of a body that printed nobody proves nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createSiteApp } from "../puzzledb/server/app";
import { buildDataset } from "../puzzledb/server/dataset";
import { HEAD_PLACEHOLDER, injectHead, renderHead } from "../puzzledb/server/head";
import { siteCallerKey } from "../puzzledb/server/main";
import { FIRST_TIERED_DAY, POLICY } from "../puzzledb/server/policy";
import { openGameDatabase, readSnapshot } from "../puzzledb/server/snapshot";
import type { Dataset, Policy } from "../puzzledb/server/types";
import { bodyPathFor, NOT_FOUND_TEXT, type PageText, SOLVES_TEXT, UNAVAILABLE_TEXT } from "../puzzledb/wire";
import type { SitePlayersBody, SiteSolvesBody } from "../puzzledb/wire-profiles";
import {
  COMMUNITY_AUTHOR,
  COMMUNITY_TITLE,
  fixtureSources,
  gameFixture,
  type GameFixture,
  NOW,
  PLANTED,
  PLAYERS,
  SERVERS,
  TODAY,
} from "./puzzledb-fixture";

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

/** The owner's policy with the fixture's quiet server listed, as every privacy test has it. */
const PRIVATE: Policy = Object.freeze({ ...POLICY, hiddenServerKeys: new Set([SERVERS.quiet.key]) });

const DATA_MISS = '{"error":"Not found"}';
const PLAYERS_BODY = bodyPathFor({ kind: "players" })!;
const SOLVES_BODY = bodyPathFor({ kind: "solves" })!;

/** Withheld while the policy keeps player-written puzzles off the site. */
const WITHHELD = [...PLANTED, COMMUNITY_AUTHOR, COMMUNITY_TITLE];
const SHAPES = [/\d{17,}/, /discord:/i, /cdn\.discordapp\.com|\/avatars\//i];

const scratch: string[] = [];
let game: GameFixture;
let dataset: Dataset;
let root: string;

beforeAll(() => {
  game = gameFixture();
  const db = openGameDatabase(game.databasePath);
  try {
    dataset = buildDataset(readSnapshot(db, TODAY, FIRST_TIERED_DAY), fixtureSources(game), NOW, PRIVATE);
  } finally {
    db.close();
  }
  root = mkdtempSync(join(tmpdir(), "puzzledb-app-profiles-"));
  scratch.push(root);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), TEMPLATE);
  writeFileSync(join(root, "assets/app.js"), "export const page = 'the archive';\n");
});

afterAll(() => {
  game?.cleanup();
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function siteApp(served: Dataset | null = dataset): Hono {
  return createSiteApp({
    dataset: () => served,
    status: () => ({ ready: served !== null, builtAt: NOW, checkedAt: NOW, failing: null }),
    buildRoot: root,
    callerKey: siteCallerKey,
    limits: { perMinute: 10_000, downloadsPerMinute: 10 },
  });
}

async function answerOf(app: Hono, path: string, init?: RequestInit) {
  const response = await app.request(path, init);
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

function documentWith(text: PageText): string {
  return injectHead(TEMPLATE, renderHead(text));
}

function decoded<T>(path: string): T {
  return JSON.parse(new TextDecoder().decode(dataset.bodies.get(path)!)) as T;
}

describe("the solves page", () => {
  test("serves the page with its own title and description", async () => {
    const response = await siteApp().request("/solves");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    const text = await response.text();
    expect(text).toBe(documentWith(SOLVES_TEXT));
    expect(text).toContain("<title>Recent solves — Puzzle archive</title>");
  });

  test("answers the same bytes whatever the query string asks: the filters are the page's", async () => {
    const app = siteApp();
    const plain = await answerOf(app, "/solves");
    const queries = ["?tier=hard&puzzle=42", `?server=${SERVERS.club.key}`, "?tier=<script>&puzzle=-1", "?"];

    for (const query of queries) {
      expect({ query, ...(await answerOf(app, `/solves${query}`)) }).toEqual({ query, ...plain });
    }
  });

  test("answers every other spelling byte for byte like a page that never existed", async () => {
    const app = siteApp();
    const never = await answerOf(app, "/no-such-page");
    expect(never.body).toBe(documentWith(NOT_FOUND_TEXT));

    for (const path of ["/solves/", "/Solves", "/SOLVES", "/solves/1", "/solves.html", "/solves%2F"]) {
      expect({ path, ...(await answerOf(app, path)) }).toEqual({ path, ...never });
    }
  });

  test("is the 503 page before the first dataset", async () => {
    const response = await siteApp(null).request("/solves");

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.text()).toBe(documentWith(UNAVAILABLE_TEXT));
  });
});

describe("the two new bodies", () => {
  test("are served byte for byte as JSON, revalidated by their own tags", async () => {
    const app = siteApp();

    for (const path of [PLAYERS_BODY, SOLVES_BODY]) {
      const answer = await app.request(path);
      expect(answer.status).toBe(200);
      expect(answer.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(answer.headers.get("Cache-Control")).toBe("no-cache");
      expect(Buffer.from(await answer.arrayBuffer()).equals(Buffer.from(dataset.bodies.get(path)!))).toBe(true);

      const tag = answer.headers.get("ETag")!;
      expect(tag).toMatch(/^"[0-9a-z]+"$/);
      const again = await app.request(path, { headers: { "If-None-Match": tag } });
      expect(again.status).toBe(304);
      expect(await again.text()).toBe("");
    }
  });

  test("answer HEAD with GET's headers, its length included, and no body", async () => {
    const app = siteApp();

    for (const path of [PLAYERS_BODY, SOLVES_BODY, "/solves"]) {
      const get = await app.request(path);
      const length = (await get.arrayBuffer()).byteLength;
      const head = await app.request(path, { method: "HEAD" });

      expect(head.status).toBe(get.status);
      expect(head.headers.get("Content-Length")).toBe(String(length));
      expect(head.headers.get("ETag")).toBe(get.headers.get("ETag"));
      expect(head.headers.get("Content-Type")).toBe(get.headers.get("Content-Type"));
      expect(await head.text()).toBe("");
    }
  });

  test("answer a near-spelling with the one JSON miss, byte for byte", async () => {
    const app = siteApp();
    const first = await answerOf(app, "/data/nothing.json");
    expect(first.body).toBe(DATA_MISS);

    const paths = [`/data/solves/${TODAY - 1}.json`, "/data/players/x.json", "/data/solves.json/", "/data/Players.json"];
    for (const path of paths) {
      expect({ path, ...(await answerOf(app, path)) }).toEqual({ path, ...first });
    }
  });

  test("answer 503 before the first dataset, as every body does", async () => {
    const app = siteApp(null);

    for (const path of [PLAYERS_BODY, SOLVES_BODY]) {
      const response = await app.request(path);
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("privacy over HTTP", () => {
  test("no byte of the players or solves page, or of either body, carries a planted value, a long number, discord: or an avatar", async () => {
    const app = siteApp();
    const leaks: string[] = [];

    for (const path of ["/players", "/solves", PLAYERS_BODY, SOLVES_BODY]) {
      const text = Buffer.from(await (await app.request(path)).arrayBuffer()).toString("latin1");
      for (const value of WITHHELD.filter((planted) => text.includes(planted))) leaks.push(`${path}: ${value}`);
      for (const shape of SHAPES.flatMap((pattern) => pattern.exec(text)?.[0] ?? [])) leaks.push(`${path}: ${shape}`);
    }

    expect(leaks).toEqual([]);
  });

  test("does carry what each body exists to carry: the shown players' keys, and the servers solves were in", () => {
    const players = decoded<SitePlayersBody>(PLAYERS_BODY).rows.map((row) => row.key);
    const solves = decoded<SiteSolvesBody>(SOLVES_BODY).days;

    expect(players).toEqual([PLAYERS.unchosen.key, PLAYERS.visible.key]);
    expect(solves.length).toBeGreaterThan(0);
    expect(solves.flatMap((day) => day.servers)).toContain(SERVERS.club.key);
  });

  test("keeps a player who hid out of the players table, though their solves are counted in the feed's", () => {
    const text = new TextDecoder().decode(dataset.bodies.get(PLAYERS_BODY)!);
    const yesterday = decoded<SiteSolvesBody>(SOLVES_BODY).days.find((day) => day.day === TODAY - 1);

    for (const withheld of [PLAYERS.hidden, PLAYERS.digitRun, PLAYERS.guest]) {
      expect(text).not.toContain(withheld.key);
      expect(text).not.toContain(withheld.name);
    }
    // Yesterday's easy: the visible, unchosen, hidden, digit-run and guest players all solved it.
    expect(yesterday?.tiers.easy).toBe(5);
  });
});
