/**
 * The fixture the puzzle database's tests stand on, tested before anything
 * leans on it.
 *
 * Every privacy test downstream scans the site's output for the values this
 * plants. A fixture that quietly stopped planting one — a renamed column, a
 * write helper that began storing a default, a row that never landed — leaves
 * those scans passing over nothing, and green then means less than it says. So
 * this asserts the plant itself: every listed value is on disk, every column
 * whose name says it holds a person holds one, and nothing unplanted sits
 * beside them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readPublishedArchive } from "../server/archive-rows";
import { trackedAnswers } from "../server/archive-solutions";
import { Store } from "../server/db";
import { readOverrides } from "../server/puzzle-overrides";
import { PuzzleArchive } from "../server/puzzles";
import { readAcceptedPuzzles } from "../server/submissions";
import { dayNumber } from "../shared/daily";
import { FIRST_EXTREME_DAY, FIRST_TIERED_DAY } from "../puzzledb/server/policy";
import type { DayPin } from "../puzzledb/server/types";
import {
  COMMUNITY_AUTHOR,
  COMMUNITY_ID,
  COMMUNITY_TITLE,
  CORRECTED_ID,
  CORRECTED_TITLE,
  DEFAULT_PINS,
  DEPARTED_ID,
  fixtureSources,
  gameFixture,
  type GameFixture,
  LA,
  NOW,
  PLANTED,
  PUBLISHED_ID,
  TODAY,
  UNPUBLISHED_ID,
} from "./puzzledb-fixture";

const COMMITTED_PUZZLES = resolve(import.meta.dir, "../data/puzzles.json");
const TRACKED_ARCHIVE = resolve(import.meta.dir, "../data/archive/puzzles.sqlite");

/** Column names that say they hold a person, a server, or an officer's name. */
const NAMES_A_PERSON = /^(by|.+_by|player_id|guild_id|username|avatar_url|author_name)$/;

/** Never-public columns whose names do not say so. */
const ALSO_NEVER_PUBLIC: Readonly<Record<string, readonly string[]>> = {
  players: ["id"],
  preferences: ["payload"],
  submissions: ["reviewer_note", "events"],
  puzzle_override_log: ["was"],
  puzzle_solutions: ["canonical_key", "placements", "events"],
};

const built: GameFixture[] = [];
const scratch: string[] = [];

function build(...options: Parameters<typeof gameFixture>): GameFixture {
  const fixture = gameFixture(...options);
  built.push(fixture);
  return fixture;
}

afterAll(() => {
  for (const fixture of built) fixture.cleanup();
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function readOnly<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function tablesOf(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function columnsOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
    .all()
    .map((row) => row.name);
}

/** Every non-null cell of one column, as text — an id stored as INTEGER included. */
function cells(db: Database, table: string, column: string): string[] {
  return db
    .query<{ value: string }, []>(
      `SELECT CAST("${column}" AS TEXT) AS value FROM "${table}" WHERE "${column}" IS NOT NULL`,
    )
    .all()
    .map((row) => row.value);
}

function pinsOn(path: string): DayPin[] {
  return readOnly(path, (db) =>
    db
      .query<DayPin, []>("SELECT day, tier, puzzle_id AS puzzleId FROM day_puzzles ORDER BY day, tier")
      .all(),
  );
}

const byDayThenTier = (a: DayPin, b: DayPin) => a.day - b.day || a.tier.localeCompare(b.tier);

function sha256(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

describe("the calendar it assumes", () => {
  test("sets the history days apart from the days around today, on Irvine's clock", () => {
    expect(FIRST_TIERED_DAY + 1).toBeLessThan(FIRST_EXTREME_DAY);
    expect(FIRST_EXTREME_DAY).toBeLessThan(TODAY - 2);
    expect(dayNumber(NOW, { timeZone: LA })).toBe(TODAY);
  });
});

describe("the database it builds", () => {
  let fixture: GameFixture;
  let hashBefore: string;

  beforeAll(() => {
    hashBefore = sha256(TRACKED_ARCHIVE);
    fixture = build();
  });

  test("has exactly the tables the game's own Store creates", () => {
    const directory = mkdtempSync(join(tmpdir(), "puzzledb-fixture-store-"));
    scratch.push(directory);
    const path = join(directory, "fresh.sqlite");
    new Store(path).close();

    expect(readOnly(fixture.databasePath, tablesOf)).toEqual(readOnly(path, tablesOf));
  });

  test("plants every value it lists", () => {
    const everything = readOnly(fixture.databasePath, (db) =>
      tablesOf(db).flatMap((table) => columnsOf(db, table).flatMap((column) => cells(db, table, column))),
    ).join("\n");

    expect(PLANTED.filter((value) => !everything.includes(value))).toEqual([]);
  });

  test("puts a planted value in every column that names a person, and nothing else there", () => {
    const allowed = [...PLANTED, COMMUNITY_AUTHOR];
    const empty: string[] = [];
    const unplanted: string[] = [];

    readOnly(fixture.databasePath, (db) => {
      for (const table of tablesOf(db)) {
        const watched = columnsOf(db, table).filter(
          (column) => NAMES_A_PERSON.test(column) || ALSO_NEVER_PUBLIC[table]?.includes(column),
        );
        for (const column of watched) {
          const values = cells(db, table, column);
          if (values.length === 0) empty.push(`${table}.${column}`);
          for (const value of values) {
            if (!allowed.some((planted) => value.includes(planted))) {
              unplanted.push(`${table}.${column} = ${value}`);
            }
          }
        }
      }
    });

    expect(empty).toEqual([]);
    expect(unplanted).toEqual([]);
  });

  test("loads through PuzzleArchive.load the way the site will", () => {
    const sources = fixtureSources(fixture);
    const archive = readOnly(fixture.databasePath, (db) =>
      PuzzleArchive.load(
        sources.puzzlesPath,
        { timeZone: sources.timeZone },
        readAcceptedPuzzles(db),
        readOverrides(db),
        trackedAnswers(sources.trackedArchivePath),
        readPublishedArchive(db),
      ),
    );

    expect(archive.get(PUBLISHED_ID)).toBeDefined();
    expect(archive.get(UNPUBLISHED_ID)).toBeUndefined();
    expect(archive.get(DEPARTED_ID)).toBeUndefined();
    expect(archive.get(CORRECTED_ID)?.title).toBe(CORRECTED_TITLE);
    // The first id of the community band, allocated by the game's own accept.
    expect(archive.get(COMMUNITY_ID)?.author).toBe(COMMUNITY_AUTHOR);
    expect(archive.get(COMMUNITY_ID)?.title).toBe(COMMUNITY_TITLE);
  });

  test("pins the default days", () => {
    expect(pinsOn(fixture.databasePath)).toEqual([...DEFAULT_PINS].sort(byDayThenTier));
    expect(fixture.pins).toEqual(DEFAULT_PINS);
  });

  test("copies puzzles.json alone, the way a deploy box holds it", () => {
    expect(readFileSync(fixture.puzzlesPath, "utf8")).toBe(readFileSync(COMMITTED_PUZZLES, "utf8"));
    expect(existsSync(join(dirname(fixture.puzzlesPath), "solutions.json"))).toBe(false);
    expect(fixture.trackedArchivePath).toBe(TRACKED_ARCHIVE);
    expect(fixtureSources(fixture)).toEqual({
      puzzlesPath: fixture.puzzlesPath,
      trackedArchivePath: TRACKED_ARCHIVE,
      timeZone: LA,
    });
  });

  test("leaves the committed tracked archive byte for byte as it was", () => {
    expect(sha256(TRACKED_ARCHIVE)).toBe(hashBefore);
  });

  test("writes the game's WAL journal unless asked for a rollback journal", () => {
    const journal = (path: string) =>
      readOnly(path, (db) => db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode);
    const rollback = build({ journal: "delete" });
    // Read before anything opens it: one file, whichever SQLite built it.
    const files = readdirSync(rollback.dir).sort();

    expect(journal(fixture.databasePath)).toBe("wal");
    expect(journal(rollback.databasePath)).toBe("delete");
    expect(files).toEqual(["daily.sqlite", "puzzles.json"]);
  });
});

describe("the days it can be asked for", () => {
  test("leaves today and everything after it unpinned when asked to", () => {
    // Just after midnight nothing has asked for the new day, and nothing can
    // have pinned a later one before it.
    const fixture = build({ withoutToday: true });
    const pins = pinsOn(fixture.databasePath);

    expect(pins.filter((pin) => pin.day >= TODAY)).toEqual([]);
    expect(pins).toEqual(DEFAULT_PINS.filter((pin) => pin.day < TODAY).sort(byDayThenTier));
    expect(fixture.pins).toEqual(DEFAULT_PINS.filter((pin) => pin.day < TODAY));
  });

  test("pins exactly the rows it is handed instead", () => {
    const pins: DayPin[] = [
      { day: TODAY - 1, tier: "easy", puzzleId: 1 },
      { day: TODAY - 1, tier: "legacy", puzzleId: 2 },
    ];
    const fixture = build({ pins });

    expect(pinsOn(fixture.databasePath)).toEqual([...pins].sort(byDayThenTier));
  });
});

describe("cleaning up", () => {
  test("removes everything it made, and can be asked twice", () => {
    const fixture = gameFixture();

    fixture.cleanup();
    fixture.cleanup();

    expect(existsSync(fixture.dir)).toBe(false);
    expect(existsSync(TRACKED_ARCHIVE)).toBe(true);
  });
});
