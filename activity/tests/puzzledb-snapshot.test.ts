/**
 * The only SQL the puzzle database runs against the game's own database.
 *
 * Two promises rest on that one module, and each is held here by a test rather
 * than by the code being careful.
 *
 * **It cannot write.** The handle is SQLite's read-only kind, so SQLite itself
 * refuses an INSERT, a missing file is refused rather than created, and a
 * snapshot and a whole build leave the file byte for byte as they found it.
 * What it reads is pinned too: with every table but the four it needs dropped
 * from a copy, a build still succeeds. A future read of `runs` or `players`
 * fails here, loudly, long before it could reach anything public.
 *
 * **It cannot show a day that is not over.** Never today, never a later day
 * even when one is pinned, and yesterday only once something has pinned today
 * — so a site clock running ahead cannot pull the game's today into history.
 * History starts at the first tiered day.
 *
 * And it must not hold on. A read transaction left open would pin the game's
 * write-ahead log, so the game's own writer checkpoints after a read, with a
 * control beside it to show the checkpoint can see a reader that did hold on.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDataset } from "../puzzledb/server/dataset";
import { FIRST_TIERED_DAY } from "../puzzledb/server/policy";
import {
  BUSY_TIMEOUT_MS,
  dataVersion,
  openGameDatabase,
  readSnapshot,
} from "../puzzledb/server/snapshot";
import type { DayPin, GameSnapshot } from "../puzzledb/server/types";
import {
  COMMUNITY_ID,
  CORRECTED_ID,
  DEFAULT_PINS,
  type FixtureOptions,
  fixtureSources,
  gameFixture,
  type GameFixture,
  NOW,
  PUBLISHED_ID,
  TODAY,
} from "./puzzledb-fixture";

/** The tables a build may read. Everything else in the game's database is somebody's. */
const READ_SET = ["archive_puzzles", "day_puzzles", "puzzle_overrides", "submissions"];

/** Tables that hold players, their play, or who did what. A build that reads one fails the read-set test. */
const NEVER_READ = [
  "archive_content_log",
  "day_rush",
  "players",
  "preferences",
  "puzzle_clears",
  "puzzle_override_log",
  "puzzle_solutions",
  "runs",
  "rush_runs",
];

const built: GameFixture[] = [];
const scratch: string[] = [];

afterAll(() => {
  for (const fixture of built) fixture.cleanup();
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function fixture(options?: FixtureOptions): GameFixture {
  const made = gameFixture(options);
  built.push(made);
  return made;
}

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "puzzledb-snapshot-"));
  scratch.push(directory);
  return directory;
}

/** One snapshot through a handle of its own, opened and closed the way the refresher's would be. */
function snapshotOf(path: string, clockToday = TODAY, firstTieredDay = FIRST_TIERED_DAY): GameSnapshot {
  const db = openGameDatabase(path);
  try {
    return readSnapshot(db, clockToday, firstTieredDay);
  } finally {
    db.close();
  }
}

/** SQLite's own order for `ORDER BY day, tier`: tiers compare as bytes, not as daily tiers. */
function byDayThenTier(a: DayPin, b: DayPin): number {
  if (a.day !== b.day) return a.day - b.day;
  return a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0;
}

/** The rows the cut should hand back: from the first tiered day up to, and not including, `end`. */
function pinsBefore(pins: readonly DayPin[], end: number): DayPin[] {
  return pins.filter((pin) => pin.day >= FIRST_TIERED_DAY && pin.day < end).sort(byDayThenTier);
}

function sha256(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

function tablesIn(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

/** Drops every table but `keep` from a database, as a writer the site never is. Returns what went. */
function keepOnly(path: string, keep: readonly string[]): string[] {
  const doomed = tablesIn(path).filter((table) => !keep.includes(table));
  const db = new Database(path, { readwrite: true });
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    for (const table of doomed) db.exec(`DROP TABLE "${table}"`);
  } finally {
    db.close();
  }
  return doomed;
}

/** What the game's own writer gets when it tries to fold the log back into the file. */
function checkpoint(writer: Database): { busy: number } {
  const result = writer.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (!result) throw new Error("wal_checkpoint answered nothing");
  return result;
}

/**
 * A commit from the game's side, so the log holds frames a reader could pin.
 *
 * `user_version` because it writes a page and changes nothing any build reads.
 */
function commitSomething(writer: Database): void {
  writer.exec(`PRAGMA user_version = ${TODAY}`);
}

describe("read-only by construction", () => {
  test("opens the game's database read-only, so SQLite refuses an INSERT and a CREATE", () => {
    const db = openGameDatabase(fixture().databasePath);
    try {
      expect(() =>
        db.exec(`INSERT INTO day_puzzles (day, tier, puzzle_id) VALUES (${TODAY + 9}, 'easy', 1)`),
      ).toThrow(/readonly/);
      expect(() => db.exec("CREATE TABLE intruder (anything TEXT)")).toThrow(/readonly/);
    } finally {
      db.close();
    }
  });

  test("waits a moment for a locked database rather than failing at once", () => {
    const db = openGameDatabase(fixture().databasePath);
    try {
      expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });

  test("refuses a database that is not there instead of creating one", () => {
    // The game's own open creates a missing file, so a wrong path there is a
    // fresh, empty database. Here it must be an error an operator can read.
    const directory = scratchDirectory();
    const path = join(directory, "daily.sqlite");

    expect(() => openGameDatabase(path)).toThrow(/unable to open database file/);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  test("leaves the game's database file byte-for-byte unchanged", () => {
    // A rollback journal, so the database is exactly one file on every
    // platform and a hash of it is a hash of everything.
    const game = fixture({ journal: "delete" });
    const before = sha256(game.databasePath);
    const files = readdirSync(game.dir).sort();

    const db = openGameDatabase(game.databasePath);
    try {
      dataVersion(db);
      buildDataset(readSnapshot(db, TODAY, FIRST_TIERED_DAY), fixtureSources(game), NOW);
    } finally {
      db.close();
    }

    expect(sha256(game.databasePath)).toBe(before);
    expect(readdirSync(game.dir).sort()).toEqual(files);
  });

  test("reads nothing but archive_puzzles, submissions, puzzle_overrides and day_puzzles", () => {
    const game = fixture({ journal: "delete" });
    // One file, so a copy of it is a copy of the whole database.
    const copy = join(scratchDirectory(), "daily.sqlite");
    copyFileSync(game.databasePath, copy);
    const dropped = keepOnly(copy, READ_SET);

    const snapshot = snapshotOf(copy);
    const dataset = buildDataset(snapshot, fixtureSources(game), NOW);

    expect(NEVER_READ.filter((table) => !dropped.includes(table))).toEqual([]);
    // Each of the four was read, not merely survived.
    expect(snapshot.accepted.map((puzzle) => puzzle.id)).toEqual([COMMUNITY_ID]);
    expect(snapshot.overrides.map((override) => override.puzzleId)).toEqual([CORRECTED_ID]);
    expect(snapshot.published.map((puzzle) => puzzle.id)).toEqual([PUBLISHED_ID]);
    expect(snapshot.pins.length).toBeGreaterThan(0);
    expect(dataset.data.puzzles.length).toBeGreaterThan(0);
    // And nothing put them back: no Store, no migration, no schema run.
    expect(tablesIn(copy)).toEqual(READ_SET);
  });

  test("leaves no read transaction open", () => {
    const game = fixture();
    const writer = new Database(game.databasePath, { readwrite: true });
    const reader = openGameDatabase(game.databasePath);
    try {
      commitSomething(writer);
      dataVersion(reader);
      readSnapshot(reader, TODAY, FIRST_TIERED_DAY);

      expect(reader.inTransaction).toBe(false);
      expect(checkpoint(writer).busy).toBe(0);
    } finally {
      reader.close();
      writer.close();
    }
  });

  test("would see a read transaction left open, which is what makes the test above mean anything", () => {
    const game = fixture();
    const writer = new Database(game.databasePath, { readwrite: true });
    const holder = openGameDatabase(game.databasePath);
    try {
      commitSomething(writer);
      holder.exec("BEGIN");
      holder.query("SELECT COUNT(*) AS n FROM day_puzzles").get();

      expect(checkpoint(writer).busy).toBe(1);
      holder.exec("COMMIT");
    } finally {
      holder.close();
      writer.close();
    }
  });

  test("notices when the game commits, through data_version", () => {
    const game = fixture();
    const writer = new Database(game.databasePath, { readwrite: true });
    const reader = openGameDatabase(game.databasePath);
    try {
      const before = dataVersion(reader);
      expect(dataVersion(reader)).toBe(before);

      commitSomething(writer);

      expect(dataVersion(reader)).not.toBe(before);
    } finally {
      reader.close();
      writer.close();
    }
  });
});

describe("what it reads", () => {
  test("reads the accepted puzzles, the corrections and the published rows, unpublished rows aside", () => {
    const snapshot = snapshotOf(fixture().databasePath);

    expect(snapshot.accepted.map((puzzle) => puzzle.id)).toEqual([COMMUNITY_ID]);
    expect(snapshot.overrides.map((override) => override.puzzleId)).toEqual([CORRECTED_ID]);
    expect(snapshot.published.map((puzzle) => puzzle.id)).toEqual([PUBLISHED_ID]);
  });

  test("hands back a snapshot nobody can edit", () => {
    const snapshot = snapshotOf(fixture().databasePath);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.pins)).toBe(true);
    expect(snapshot.pins.every((pin) => Object.isFrozen(pin))).toBe(true);
  });
});

describe("finished days only", () => {
  test("never lists today or a later day, even when both are pinned", () => {
    const game = fixture();
    const snapshot = snapshotOf(game.databasePath);

    expect(game.pins.some((pin) => pin.day === TODAY)).toBe(true);
    expect(game.pins.some((pin) => pin.day > TODAY)).toBe(true);
    expect(snapshot.pins).toEqual(pinsBefore(DEFAULT_PINS, TODAY));
  });

  test("keeps yesterday back until something has pinned today", () => {
    // Just after midnight: the clock says TODAY and nothing has asked for it.
    const snapshot = snapshotOf(fixture({ withoutToday: true }).databasePath);

    expect(snapshot.pins).toEqual(pinsBefore(DEFAULT_PINS, TODAY - 1));
    expect(snapshot.pins.some((pin) => pin.day === TODAY - 1)).toBe(false);
  });

  test("cannot be pushed into the game's today by a site clock running ahead", () => {
    // The stray pin past today goes: with it MAX(day) would pass TODAY, and the
    // clock alone would decide — which is a different case, tested above.
    const pins = DEFAULT_PINS.filter((pin) => pin.day <= TODAY);
    const snapshot = snapshotOf(fixture({ pins }).databasePath, TODAY + 1);

    expect(snapshot.pins).toEqual(pinsBefore(pins, TODAY));
    expect(snapshot.pins.some((pin) => pin.day === TODAY)).toBe(false);
  });

  test("starts at FIRST_TIERED_DAY", () => {
    const snapshot = snapshotOf(fixture().databasePath);

    expect(DEFAULT_PINS.some((pin) => pin.day < FIRST_TIERED_DAY)).toBe(true);
    expect(snapshot.pins[0]?.day).toBe(FIRST_TIERED_DAY);
    expect(snapshot.pins.every((pin) => pin.day >= FIRST_TIERED_DAY)).toBe(true);
  });

  test("starts wherever the policy it is handed says", () => {
    const snapshot = snapshotOf(fixture().databasePath, TODAY, FIRST_TIERED_DAY + 1);

    expect(snapshot.pins[0]?.day).toBe(FIRST_TIERED_DAY + 1);
  });

  test("hands back raw tiers, a later extreme top-up included, for the policy to judge", () => {
    const topUp = DEFAULT_PINS.find((pin) => pin.day === FIRST_TIERED_DAY + 1 && pin.tier === "extreme");
    const snapshot = snapshotOf(fixture().databasePath);

    expect(topUp).toBeDefined();
    expect(snapshot.pins).toContainEqual(topUp!);
  });

  test("reads nothing from an empty day_puzzles", () => {
    const snapshot = snapshotOf(fixture({ pins: [] }).databasePath);

    expect(snapshot.pins).toEqual([]);
    expect(snapshot.newestPinnedDay).toBeNull();
  });

  test("reports the newest pinned day", () => {
    expect(snapshotOf(fixture().databasePath).newestPinnedDay).toBe(TODAY + 1);
    expect(snapshotOf(fixture({ withoutToday: true }).databasePath).newestPinnedDay).toBe(TODAY - 1);
  });
});
