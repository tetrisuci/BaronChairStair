/**
 * The alternates page over HTTP: `/alternates` and its body, answering as
 * every other list page does, and carrying the day each line was found and
 * never the moment.
 *
 * Beside `puzzledb-app-profiles.test.ts`, driving the same app the same way —
 * `app.request` against a dataset built from the planted game database — and
 * held to the same three rules: one spelling per page whatever the query
 * string says, the one JSON miss for a near-spelling of the body, and nothing
 * planted in any byte, with a positive control beside the scan.
 *
 * **The day is published; the time is planted.** The owner chose to publish
 * the day each line was found so lines can be sorted by it. The fixture plants
 * every line's `found_at` in milliseconds, and a millisecond would name its
 * finder far more surely than a day, so the body must hold the day and not
 * that number.
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
import { ALTERNATES_TEXT, bodyPathFor, NOT_FOUND_TEXT, type PageText } from "../puzzledb/wire";
import type { SiteAlternatesBody } from "../puzzledb/wire-alternates";
import {
  COMMUNITY_AUTHOR,
  COMMUNITY_TITLE,
  fixtureSources,
  gameFixture,
  type GameFixture,
  LINES,
  NOW,
  PLANTED,
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

const PRIVATE: Policy = Object.freeze({ ...POLICY, hiddenServerKeys: new Set([SERVERS.quiet.key]) });

const DATA_MISS = '{"error":"Not found"}';
const ALTERNATES_BODY = bodyPathFor({ kind: "alternates" })!;

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
  root = mkdtempSync(join(tmpdir(), "puzzledb-app-alternates-"));
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

async function answerOf(app: Hono, path: string) {
  const response = await app.request(path);
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

function documentWith(text: PageText): string {
  return injectHead(TEMPLATE, renderHead(text));
}

function decoded(): SiteAlternatesBody {
  return JSON.parse(new TextDecoder().decode(dataset.bodies.get(ALTERNATES_BODY)!)) as SiteAlternatesBody;
}

describe("the alternates page", () => {
  test("serves the page with its own title and description", async () => {
    const response = await siteApp().request("/alternates");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    const text = await response.text();
    expect(text).toBe(documentWith(ALTERNATES_TEXT));
    expect(text).toContain("<title>Alternate solutions — Puzzle archive</title>");
  });

  test("answers the same bytes whatever the query string asks: the sort is the page's", async () => {
    const app = siteApp();
    const plain = await answerOf(app, "/alternates");

    for (const query of ["?sort=attack&dir=asc", "?sort=<script>&dir=sideways", "?"]) {
      expect({ query, ...(await answerOf(app, `/alternates${query}`)) }).toEqual({ query, ...plain });
    }
  });

  test("answers every other spelling byte for byte like a page that never existed", async () => {
    const app = siteApp();
    const never = await answerOf(app, "/no-such-page");

    for (const path of ["/alternates/", "/Alternates", "/alternates/1", "/alternates.html", "/alternate"]) {
      expect({ path, ...(await answerOf(app, path)) }).toEqual({ path, ...never });
    }
    expect(never.body).toBe(documentWith(NOT_FOUND_TEXT));
  });
});

describe("the alternates body", () => {
  test("is served byte for byte as JSON, revalidated by its own tag", async () => {
    const app = siteApp();
    const answer = await app.request(ALTERNATES_BODY);

    expect(answer.status).toBe(200);
    expect(answer.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(Buffer.from(await answer.arrayBuffer()).equals(Buffer.from(dataset.bodies.get(ALTERNATES_BODY)!))).toBe(true);
    const again = await app.request(ALTERNATES_BODY, { headers: { "If-None-Match": answer.headers.get("ETag")! } });
    expect(again.status).toBe(304);
  });

  test("answers a near-spelling with the one JSON miss", async () => {
    const app = siteApp();

    for (const path of ["/data/alternates.json/", "/data/Alternates.json", "/data/alternates/1.json"]) {
      expect((await answerOf(app, path)).body).toBe(DATA_MISS);
    }
  });

  test("lists the finished days' published lines, each with the day it was found", () => {
    const lines = decoded().lines;

    expect(lines.map((line) => [line.puzzleId, line.position, line.day, line.attack])).toEqual([
      [LINES.hidden.puzzleId, 1, LINES.hidden.day, LINES.hidden.attack],
      [LINES.visible.puzzleId, 1, LINES.visible.day, LINES.visible.attack],
    ]);
  });

  test("carries no planted value, no long number, no discord: and no avatar, the lines' exact times included", async () => {
    const app = siteApp();
    const leaks: string[] = [];

    for (const path of ["/alternates", ALTERNATES_BODY]) {
      const text = Buffer.from(await (await app.request(path)).arrayBuffer()).toString("latin1");
      for (const value of WITHHELD.filter((planted) => text.includes(planted))) leaks.push(`${path}: ${value}`);
      for (const shape of SHAPES.flatMap((pattern) => pattern.exec(text)?.[0] ?? [])) leaks.push(`${path}: ${shape}`);
    }

    expect(leaks).toEqual([]);
    // The positive control: the day is there, so the scan above looked at a body that dated its lines.
    expect(new TextDecoder().decode(dataset.bodies.get(ALTERNATES_BODY)!)).toContain(`"day":${LINES.visible.day}`);
  });
});
