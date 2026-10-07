/**
 * The privacy boundary: the one module that decides what can leave the puzzle
 * database, and the evidence that nothing personal does.
 *
 * Everything public — `/puzzles.json`, the `/puzzles.sqlite` download, every
 * `/data/…` body, every page head — is read back out of one in-memory SQLite
 * database built from an allowlist, so its schema is the complete list of what
 * can be public. These tests pin that list as a literal, then hold a full build
 * over the planted fixture to it: no planted value, no Discord-shaped number,
 * no `discord:` attribution and no avatar URL — in the file's bytes, in any
 * cell read as text, in the JSON, or in any body.
 *
 * Since the site began publishing players, some values are public for one row
 * and forbidden for the next: a shown player's name beside a hidden one's, a
 * named server beside one on the owner's hide list. So every scan here has a
 * positive control beside it — the fixture's printable names and keys must be
 * found — because a scan that finds nothing proves nothing if the build simply
 * printed nobody. The fixture's quiet server is on the hide list in every build
 * here but one, and that one shows its name is withheld by the list and not by
 * accident.
 *
 * Values, not names. `tracked-archive.test.ts` checks the committed archive's
 * column names, which is the right check for a file built from a fixed schema
 * and the wrong one here: an id stored as INTEGER in an innocently named
 * column passes a name check and leaks anyway, and in the file's bytes it is
 * eight binary bytes no text search would find. So every cell is also cast to
 * text by SQLite itself and scanned.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicPuzzle } from "../server/public-routes";
import { blueprintLink } from "../shared/blueprint/viewer";
import { buildBodies } from "../puzzledb/server/bodies";
import { buildDataset } from "../puzzledb/server/dataset";
import { FIRST_TIERED_DAY, POLICY } from "../puzzledb/server/policy";
import {
  PUBLIC_COLUMNS,
  PUBLIC_SCHEMA,
  type PublicRows,
  type PuzzleRow,
  readPublicDatabase,
  writePublicDatabase,
} from "../puzzledb/server/public-db";
import { NO_PLAYER_ROWS, readPlayerData } from "../puzzledb/server/public-db-players";
import { openGameDatabase, readSnapshot } from "../puzzledb/server/snapshot";
import type { Dataset, GameSnapshot, Policy } from "../puzzledb/server/types";
import { bodyPathFor, dateOfDay, SCHEMA_VERSION, type SitePuzzle } from "../puzzledb/wire";
import {
  COMMUNITY_AUTHOR,
  COMMUNITY_ID,
  COMMUNITY_TITLE,
  CORRECTED_ID,
  fixtureSources,
  gameFixture,
  type GameFixture,
  LINES,
  MAY_PUBLISH,
  NOW,
  PLANTED,
  PLAYERS,
  SERVERS,
  TODAY,
} from "./puzzledb-fixture";

/**
 * The allowlist, written out a second time on purpose: a column added there
 * must be added here too, by somebody who then has to read this file. Typed
 * exactly, so a drift fails the type check as well as the test.
 */
const ALLOWLIST = {
  puzzles: [
    "id",
    "title",
    "author",
    "difficulty",
    "tier",
    "goal",
    "set_name",
    "board",
    "queue",
    "hold",
    "pieces",
    "target_attack",
    "required_clears",
    "solution",
    "source_puzzle",
    "source_solution",
  ],
  day_puzzles: ["day", "date", "tier", "puzzle_id"],
  about: ["key", "value"],
  servers: ["key", "name"],
  players: [
    "key",
    "name",
    "days_solved",
    "dailies",
    "current_streak",
    "best_streak",
    "puzzles_cleared",
    "lines_found",
    "rush_runs",
    "rush_best",
    "rush_best_ms",
    "rush_best_day",
  ],
  player_clears: ["player_key", "puzzle_id"],
  tier_boards: [
    "day",
    "tier",
    "rank",
    "server_key",
    "player_key",
    "puzzle_id",
    "solved",
    "time_ms",
    "attack",
    "target_attack",
  ],
  day_boards: ["day", "scope", "rank", "player_key", "solved", "time_ms", "easy", "medium", "hard", "extreme"],
  rush_boards: ["day", "rank", "server_key", "player_key", "solved", "time_ms"],
  standings: ["board", "scope", "rank", "player_key", "value", "detail", "time_ms", "day"],
  puzzle_stats: ["puzzle_id", "hand_ins", "solves", "fastest_ms", "median_ms", "fastest_player_key"],
  lines: ["puzzle_id", "position", "day", "attack", "clears", "steps"],
} as const;

/** The fixture's policy: the owner's, with the quiet server on the hide list, as every privacy test has it. */
const PRIVATE: Policy = { ...POLICY, hiddenServerKeys: new Set([SERVERS.quiet.key]) };

/** Withheld while the policy keeps community puzzles off the site, and public once it lists them. */
const WITHHELD_WITH_COMMUNITY = [COMMUNITY_AUTHOR, COMMUNITY_TITLE];

/** Seventeen digits or more: a Discord id is 17 to 20, and nothing public runs that long. */
const DISCORD_SHAPED = /\d{17,}/;
/** An officer's attribution, as `published_by` and the logs spell it. */
const ATTRIBUTION = /discord:/i;
/** Discord's CDN, where every avatar lives. */
const AVATAR = /discordapp\.(com|net)|\/avatars\//i;

/** Everything in `text` that must never be public: each planted value, and the three shapes. */
function leaksIn(text: string, alsoWithheld: readonly string[] = []): string[] {
  const values = [...PLANTED, ...alsoWithheld].filter((value) => text.includes(value));
  const shapes = [DISCORD_SHAPED, ATTRIBUTION, AVATAR].flatMap((pattern) => pattern.exec(text)?.[0] ?? []);
  return [...values, ...shapes];
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

function jsonText(dataset: Dataset): string {
  return new TextDecoder().decode(dataset.json);
}

/** Every `/data/…` body of a build, as one text per body. */
function bodyTexts(dataset: Dataset): string[] {
  return [...dataset.bodies.values()].map((bytes) => new TextDecoder().decode(bytes));
}

/** Everything a build serves, as text: the JSON, the download's bytes, and every body. */
function everythingServed(dataset: Dataset): string[] {
  return [jsonText(dataset), latin1(dataset.sqlite), ...bodyTexts(dataset)];
}

function withDownload<T>(bytes: Uint8Array, read: (db: Database) => T): T {
  const db = Database.deserialize(bytes, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * Every column a table has, generated and hidden ones included.
 *
 * `table_xinfo`, not `table_info`: the plain list leaves out generated
 * columns, STORED and VIRTUAL alike, so a column computed from public ones
 * would pass the exact-columns check without anybody adding it to the
 * allowlist, and the per-cell scan would never select it.
 */
function columnsOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_xinfo("${table}")`)
    .all()
    .map((row) => row.name);
}

function tablesOf(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

/**
 * Every non-null cell of the download, generated columns' included, cast to
 * text by SQLite — so an INTEGER id reads as its digits.
 */
function cellsAsText(bytes: Uint8Array): string[] {
  return withDownload(bytes, (db) =>
    tablesOf(db).flatMap((table) =>
      columnsOf(db, table).flatMap((column) =>
        db
          .query<{ value: string }, []>(
            `SELECT CAST("${column}" AS TEXT) AS value FROM "${table}" WHERE "${column}" IS NOT NULL`,
          )
          .all()
          .map((row) => row.value),
      ),
    ),
  );
}

/** Hand-made rows, for what the module does with whatever it is handed. */
function sampleRows(): PublicRows {
  const answer = '[{"piece":"T","cells":[[0,0],[1,0],[2,0],[1,1]],"clear":"tsd","attack":4}]';
  return {
    puzzles: [
      [1, "Jelly", "baron", 6, "hard", "Clear 3 TSTs", null, '["GGGGGGGGG."]', '["T","I"]', "I", 3, 12,
        null, null, "code-a", "code-b"],
      [2, "", "", null, "hard", "", "tspins 101", "[]", '["T"]', null, 1, 4,
        "[]", answer, "code-c", null],
    ],
    // Out of order on purpose, days and tiers both. Hard goes in before medium,
    // which is also SQLite's byte order for the two, so neither the insertion
    // order nor the primary key's can pass for daily order.
    days: [
      [FIRST_TIERED_DAY + 1, dateOfDay(FIRST_TIERED_DAY + 1), "hard", 1],
      [FIRST_TIERED_DAY + 1, dateOfDay(FIRST_TIERED_DAY + 1), "medium", 2],
      [FIRST_TIERED_DAY, dateOfDay(FIRST_TIERED_DAY), "medium", null],
    ],
    about: [
      ["schema", String(SCHEMA_VERSION)],
      ["built_at", new Date(NOW).toISOString()],
      ["first_day", String(FIRST_TIERED_DAY)],
      ["through_day", String(FIRST_TIERED_DAY + 1)],
    ],
  };
}

let game: GameFixture;
let snapshot: GameSnapshot;
let dataset: Dataset;
const scratch: string[] = [];

beforeAll(() => {
  game = gameFixture();
  const db = openGameDatabase(game.databasePath);
  try {
    snapshot = readSnapshot(db, TODAY, FIRST_TIERED_DAY);
  } finally {
    db.close();
  }
  dataset = buildDataset(snapshot, fixtureSources(game), NOW, PRIVATE);
});

afterAll(() => {
  game.cleanup();
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

describe("the allowlist", () => {
  test("has exactly the allowlisted tables, with exactly these columns", () => {
    expect(PUBLIC_COLUMNS).toEqual(ALLOWLIST);
    withDownload(dataset.sqlite, (db) => {
      const objects = db
        .query<{ type: string; name: string }, []>("SELECT type, name FROM sqlite_master")
        .all();
      const extras = objects.filter(
        (object) =>
          object.type !== "table" &&
          !(object.type === "index" && object.name.startsWith("sqlite_autoindex_")),
      );

      expect(tablesOf(db)).toEqual(Object.keys(ALLOWLIST).sort());
      // No sqlite_sequence, view or trigger, and no index but those the primary keys make.
      expect(extras).toEqual([]);
      for (const [table, columns] of Object.entries(ALLOWLIST)) {
        expect(columnsOf(db, table)).toEqual([...columns]);
      }
    });
  });

  test("would refuse a generated column, which a plain column list leaves out", () => {
    // The schema as it ships, plus one column computed from an allowlisted
    // one. An INSERT cannot name a generated column, so it is the one kind
    // that could be added to PUBLIC_SCHEMA without touching PUBLIC_COLUMNS,
    // and a VIRTUAL one is not even in the file's bytes for the latin1 scan.
    const db = new Database(":memory:");
    try {
      db.exec(PUBLIC_SCHEMA);
      db.exec("ALTER TABLE about ADD COLUMN derived TEXT GENERATED ALWAYS AS ('discord:' || value) VIRTUAL");
      db.run("INSERT INTO about (key, value) VALUES ('schema', 'planted-derived')");

      // What the exact-columns check above compares, and so where it fails.
      expect(columnsOf(db, "about")).toEqual([...ALLOWLIST.about, "derived"]);
      // And what the per-cell scan reads: the computed value, though it is stored nowhere.
      expect(cellsAsText(db.serialize())).toContain("discord:planted-derived");
    } finally {
      db.close();
    }
  });

  test("documents itself: each CREATE TABLE in sqlite_master keeps its column comments", () => {
    const comments = PUBLIC_SCHEMA.match(/--[^\n]*/g) ?? [];
    const stored = withDownload(dataset.sqlite, (db) =>
      db
        .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.sql),
    );

    expect(comments.length).toBeGreaterThan(Object.keys(ALLOWLIST).length);
    // A comment outside a table's parentheses is dropped on the way in.
    expect(comments.filter((comment) => !stored.some((sql) => sql.includes(comment)))).toEqual([]);
    for (const sql of stored) expect(sql).toMatch(/^CREATE TABLE \w+ \(\n\s*--/);
  });

  test("stamps PRAGMA user_version = SCHEMA_VERSION", () => {
    const version = withDownload(dataset.sqlite, (db) =>
      db.query<{ user_version: number }, []>("PRAGMA user_version").get(),
    );

    expect(version?.user_version).toBe(SCHEMA_VERSION);
    expect(dataset.data.about.schema).toBe(SCHEMA_VERSION);
  });

  test("refuses a row that leaves a column out or names a tier the daily does not have", () => {
    // Out rather than NULL: a column the rows and the schema disagree about is
    // a bug, and writing NULL into it would hide one.
    const rows = sampleRows();
    const row = rows.puzzles[0]!;
    const tier = PUBLIC_COLUMNS.puzzles.indexOf("tier");
    const short = row.slice(0, -1) as unknown as PuzzleRow;
    const legacy = row.map((cell, index) => (index === tier ? "legacy" : cell)) as unknown as PuzzleRow;

    expect(() => writePublicDatabase({ ...rows, puzzles: [short] })).toThrow(/expected 16 values/);
    expect(() => writePublicDatabase({ ...rows, puzzles: [legacy] })).toThrow(/CHECK/);
  });
});

describe("no personal data (full fixture)", () => {
  test("carries no planted value, 17-20 digit number, discord: or avatar URL in the file's latin1 bytes or the JSON", () => {
    // The scan is only as good as what it looks over: a full build's worth.
    expect(dataset.data.puzzles.length).toBeGreaterThan(100);
    expect(dataset.data.days.length).toBeGreaterThan(0);

    expect(leaksIn(latin1(dataset.sqlite), WITHHELD_WITH_COMMUNITY)).toEqual([]);
    expect(leaksIn(jsonText(dataset), WITHHELD_WITH_COMMUNITY)).toEqual([]);
  });

  test("carries none of them in any /data/ body either", () => {
    const bodies = bodyTexts(dataset);

    // A body for every finished day, listed puzzle and shown player, the leaderboards, the players table, the feed's and the alternates table's.
    expect(bodies.length).toBe(dataset.data.days.length + dataset.data.puzzles.length + dataset.data.players.length + 4);
    for (const kind of ["players", "solves"] as const) expect(dataset.bodies.has(bodyPathFor({ kind })!)).toBe(true);
    expect(bodies.flatMap((text) => leaksIn(text, WITHHELD_WITH_COMMUNITY))).toEqual([]);
  });

  test("does print what it exists to print: the shown players, their keys, the named servers", () => {
    const served = everythingServed(dataset).join("\n");

    expect(MAY_PUBLISH.filter((value) => !served.includes(value))).toEqual([]);
    expect(dataset.data.players.map((player) => player.name)).toEqual([PLAYERS.unchosen.name, PLAYERS.visible.name]);
  });

  test("does print the day each published line was found, the one thing about when that leaves the game", () => {
    // The positive control for the planted `found_at`: the scans above find no
    // exact time, and here the day worked out of it is in the download.
    const db = Database.deserialize(dataset.sqlite, { readonly: true });
    try {
      const days = db
        .query<{ puzzleId: number; day: number }, []>("SELECT puzzle_id AS puzzleId, day FROM lines ORDER BY puzzle_id, position")
        .all();
      expect(days).toEqual([
        { puzzleId: LINES.hidden.puzzleId, day: LINES.hidden.day },
        { puzzleId: LINES.visible.puzzleId, day: LINES.visible.day },
      ]);
    } finally {
      db.close();
    }
  });

  test("has no cell holding any of them when read as text, which catches an id stored as INTEGER", () => {
    const cells = cellsAsText(dataset.sqlite);

    expect(cells.length).toBeGreaterThan(1000);
    expect(cells.flatMap((cell) => leaksIn(cell, WITHHELD_WITH_COMMUNITY))).toEqual([]);
  });

  test("hands over nothing but what it serves", () => {
    const fields = ["bodies", "builtAt", "data", "dayByNumber", "json", "puzzleById", "sqlite"];

    expect(Object.keys(dataset).sort()).toEqual(fields);
  });

  test("with community listed, a display name is all a submission contributes", () => {
    const listing = buildDataset(snapshot, fixtureSources(game), NOW, { ...PRIVATE, publishCommunity: true });
    const community = listing.puzzleById.get(COMMUNITY_ID);

    expect(community?.author).toBe(COMMUNITY_AUTHOR);
    expect(community?.title).toBe(COMMUNITY_TITLE);
    expect(everythingServed(listing).flatMap((text) => leaksIn(text))).toEqual([]);
    expect(cellsAsText(listing.sqlite).flatMap((cell) => leaksIn(cell))).toEqual([]);
  });
});

describe("the cleared lists", () => {
  test("read back each shown player's listed clears, and nothing for anyone else", () => {
    const cleared = withDownload(dataset.sqlite, (db) => readPlayerData(db).cleared);

    // The visible player's player-written puzzle is withheld, and #51 came after midnight.
    expect([...cleared]).toEqual([
      [PLAYERS.unchosen.key, [50]],
      [PLAYERS.visible.key, [CORRECTED_ID]],
    ]);
    expect(dataset.data.players.find((player) => player.key === PLAYERS.visible.key)).toBeDefined();
  });

  test("list a withheld puzzle once the policy lists it", () => {
    const listing = buildDataset(snapshot, fixtureSources(game), NOW, { ...PRIVATE, publishCommunity: true });
    const cleared = withDownload(listing.sqlite, (db) => readPlayerData(db).cleared);

    expect(cleared.get(PLAYERS.visible.key)).toEqual([CORRECTED_ID, COMMUNITY_ID]);
  });

  test("refuse a clear naming a key the players table does not hold", () => {
    const players = { ...NO_PLAYER_ROWS, playerClears: [["zzzzzzzzz2", 1] as const] };

    expect(() => writePublicDatabase({ ...sampleRows(), players })).toThrow(
      "A public board names a player key the players table does not hold",
    );
  });
});

describe("the server hide list", () => {
  test("keeps a listed server's name out of every byte, and leaves its key and the others' names", () => {
    const quiet = SERVERS.quiet;

    expect(everythingServed(dataset).filter((text) => text.includes(quiet.name!))).toEqual([]);
    expect(dataset.data.servers).toContainEqual({ key: quiet.key, name: null });
    expect(dataset.data.servers).toContainEqual({ key: SERVERS.club.key, name: SERVERS.club.name });
    withDownload(dataset.sqlite, (db) => {
      expect(db.query("SELECT name FROM servers WHERE key = ?1").get(quiet.key)).toEqual({ name: null });
    });
  });

  test("is what withholds it: the owner's empty list prints the name Discord gave", () => {
    const unlisted = buildDataset(snapshot, fixtureSources(game), NOW, POLICY);

    expect(unlisted.data.servers).toContainEqual({ key: SERVERS.quiet.key, name: SERVERS.quiet.name });
  });

  test("shows a server with a Discord-shaped name, and one never named, as unnamed", () => {
    expect(dataset.data.servers).toContainEqual({ key: SERVERS.digitRun.key, name: null });
    expect(dataset.data.servers).toContainEqual({ key: SERVERS.unnamed.key, name: null });
  });
});

describe("one allowlist", () => {
  test("builds its JSON from the public database, so the two cannot disagree", () => {
    const fromFile = withDownload(dataset.sqlite, (db) => ({
      data: readPublicDatabase(db),
      rows: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM puzzles").get()?.n,
      deals: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM day_puzzles").get()?.n,
    }));

    expect(JSON.parse(jsonText(dataset))).toEqual(fromFile.data);
    expect(dataset.data).toEqual(fromFile.data);
    expect(fromFile.rows).toBe(dataset.data.puzzles.length);
    expect(fromFile.deals).toBe(dataset.data.days.flatMap((day) => day.deals).length);
  });

  test("cuts every body from the download, so a body can say nothing the file does not", () => {
    const fromFile = withDownload(dataset.sqlite, (db) => buildBodies(readPublicDatabase(db), readPlayerData(db)));

    expect([...fromFile.keys()]).toEqual([...dataset.bodies.keys()]);
    for (const [path, bytes] of fromFile) expect(Buffer.from(bytes).equals(Buffer.from(dataset.bodies.get(path)!))).toBe(true);
  });

  test("reads days back grouped, deals in daily order, and links a code only where there is one", () => {
    const { data } = writePublicDatabase(sampleRows());
    const [jelly, untitled] = data.puzzles;

    expect(data.days).toEqual([
      {
        day: FIRST_TIERED_DAY,
        date: dateOfDay(FIRST_TIERED_DAY),
        deals: [{ tier: "medium", puzzleId: null }],
      },
      {
        day: FIRST_TIERED_DAY + 1,
        date: dateOfDay(FIRST_TIERED_DAY + 1),
        deals: [
          { tier: "medium", puzzleId: 2 },
          { tier: "hard", puzzleId: 1 },
        ],
      },
    ]);
    expect(data.about).toEqual({
      schema: SCHEMA_VERSION,
      builtAt: new Date(NOW).toISOString(),
      firstDay: FIRST_TIERED_DAY,
      throughDay: FIRST_TIERED_DAY + 1,
    });
    expect(jelly).toMatchObject({
      difficulty: 6,
      set: null,
      requiredClears: null,
      solution: null,
      source: { puzzle: "code-a", solution: "code-b" },
      puzzleUrl: blueprintLink("code-a"),
      solutionUrl: blueprintLink("code-b"),
    });
    // Half a pair of codes is a link to the puzzle and no source.
    expect(untitled).toMatchObject({
      difficulty: null,
      set: "tspins 101",
      requiredClears: [],
      source: null,
      puzzleUrl: blueprintLink("code-c"),
      solutionUrl: null,
    });
    expect(untitled?.solution).toHaveLength(1);
  });

  test("builds identical bytes from identical rows", () => {
    const first = writePublicDatabase(sampleRows());
    const second = writePublicDatabase(sampleRows());
    const again = buildDataset(snapshot, fixtureSources(game), NOW, PRIVATE);

    expect(Buffer.from(second.sqlite).equals(Buffer.from(first.sqlite))).toBe(true);
    expect(second.data).toEqual(first.data);
    expect(Buffer.from(again.sqlite).equals(Buffer.from(dataset.sqlite))).toBe(true);
    expect(Buffer.from(again.json).equals(Buffer.from(dataset.json))).toBe(true);
  });

  test("is one rollback-journal file with no free pages that opens with Database.deserialize(…, { readonly: true })", () => {
    const bytes = dataset.sqlite;
    // Bytes 18 and 19 are the write and read versions: 1 is a rollback journal, 2 is WAL.
    expect(latin1(bytes.subarray(0, 16))).toBe("SQLite format 3\0");
    expect([bytes[18], bytes[19]]).toEqual([1, 1]);

    withDownload(bytes, (db) => {
      const pages = db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
      const size = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;

      expect(db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count).toBe(0);
      expect(pages * size).toBe(bytes.length);
      expect(() => db.exec("DELETE FROM about")).toThrow(/readonly/);
    });

    // As a downloader holds it: opening it read-only writes nothing beside it.
    const directory = mkdtempSync(join(tmpdir(), "puzzledb-download-"));
    scratch.push(directory);
    const path = join(directory, "tetrisatuci-puzzles.sqlite");
    writeFileSync(path, bytes);
    const opened = new Database(path, { readonly: true });
    try {
      const count = opened.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM puzzles").get();
      expect(count?.n).toBe(dataset.data.puzzles.length);
    } finally {
      opened.close();
    }
    expect(readdirSync(directory)).toEqual(["tetrisatuci-puzzles.sqlite"]);
  });

  test("keeps SitePuzzle assignable to Omit<PublicPuzzle, \"addedOn\" | \"solveCount\">", () => {
    // Checked by the type checker, not at run time: a field the two public
    // shapes spell differently fails `bun run typecheck` on this line.
    const asPublic = (puzzle: SitePuzzle): Omit<PublicPuzzle, "addedOn" | "solveCount"> => puzzle;
    const first = dataset.data.puzzles[0];

    expect(first).toBeDefined();
    expect(asPublic(first!)).toBe(first!);
  });
});
