/**
 * The only SQL the puzzle database runs against the game's own database.
 *
 * Two promises rest on that one module, and each is held here by a test rather
 * than by the code being careful.
 *
 * **It cannot write.** The handle is SQLite's read-only kind, so SQLite itself
 * refuses an INSERT, a missing file is refused rather than created, and a
 * snapshot and a whole build leave the file byte for byte as they found it.
 *
 * **It reads only the columns it lists.** Schema 1 never named a player table,
 * and this file proved it by dropping every one. Schema 2 publishes boards,
 * so it must read those tables — and the proof becomes a list of columns
 * instead: a copy with every other column and table stripped away builds the
 * very same bytes, and stripping any one listed column breaks the build, so
 * the list is neither short nor padded. `SELECT *` would adapt to a stripped
 * copy and read whatever the real one holds, so the source may not say it. A
 * future read of `avatar_url` or `preferences` fails here, loudly, long before
 * it could reach anything public. Who a row belongs to is decided inside SQL,
 * so the snapshot itself is scanned: no id, avatar, hidden name or hidden key
 * is ever a JS value.
 *
 * **It cannot show a day that is not over.** Never today, never a later day
 * even when one is pinned, and yesterday only once something has pinned today
 * — so a site clock running ahead cannot pull the game's today into history.
 * History starts at the first tiered day. The two columns that hold
 * milliseconds and no day are cut at the game's own midnight, from the zone
 * the game records, even when the site's clock is in a zone further west.
 *
 * And it must not hold on. A read transaction left open would pin the game's
 * write-ahead log, so the game's own writer checkpoints after a read, with a
 * control beside it to show the checkpoint can see a reader that did hold on.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startOfDay } from "../shared/daily";
import { buildDataset } from "../puzzledb/server/dataset";
import { FIRST_TIERED_DAY, POLICY } from "../puzzledb/server/policy";
import {
  BUSY_TIMEOUT_MS,
  dataVersion,
  openGameDatabase,
  readSnapshot,
} from "../puzzledb/server/snapshot";
import type { DayPin, GameSnapshot } from "../puzzledb/server/types";
import {
  CLEARS,
  COMMUNITY_ID,
  CORRECTED_ID,
  DEFAULT_PINS,
  type FixtureOptions,
  fixtureSources,
  gameFixture,
  type GameFixture,
  LINES,
  NOW,
  PLANTED,
  PLAYERS,
  PUBLISHED_ID,
  SERVERS,
  TODAY,
  TODAY_MARKS,
} from "./puzzledb-fixture";

/**
 * Tables read whole, through the game's own readers, as schema 1 read them.
 * They hold puzzles and who corrected or submitted them; the policy and the
 * public schema decide which of that is published.
 */
const READ_WHOLE = ["archive_puzzles", "day_puzzles", "puzzle_overrides", "submissions"];

/**
 * Every column a build may read from the tables that hold players, their play
 * and the site's facts. `players.id`, `guild_id`, `found_by` and `found_at`
 * are read inside SQL — to join, group and cut — and never selected into JS;
 * the snapshot scan below holds that half.
 */
const READ_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  players: ["id", "username", "site_hidden", "public_key"],
  runs: ["day", "player_id", "guild_id", "puzzle_id", "slot", "solved", "total_ms", "attack", "target_attack"],
  rush_runs: ["day", "player_id", "guild_id", "solved", "time_to_last_ms"],
  puzzle_clears: ["player_id", "puzzle_id", "first_at"],
  puzzle_solutions: [
    "solution_id",
    "puzzle_id",
    "placements",
    "attack",
    "target_attack",
    "clears",
    "solved_strict",
    "source",
    "found_by",
    "found_at",
    "voided_at",
  ],
  guilds: ["guild_id", "public_key", "name"],
  site_facts: ["name", "value"],
};

/** Tables a build never reads at all: preferences, the rush pools, every log. */
const NEVER_READ = ["archive_content_log", "day_rush", "preferences", "puzzle_override_log"];

/** The fixture's policy: the quiet server on the hide list, as every privacy test has it. */
const PRIVATE = { ...POLICY, hiddenServerKeys: new Set([SERVERS.quiet.key]) };

const SITE_SERVER = resolve(import.meta.dir, "../puzzledb/server");

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

/**
 * Strips a database to `whole` tables and `columns` of the rest, as a writer
 * the site never is: every other table dropped, every other column gone.
 * Rebuilt rather than `DROP COLUMN`, which refuses a column in a key or an
 * index. Returns the tables that went entirely.
 */
function stripTo(path: string, whole: readonly string[], columns: Readonly<Record<string, readonly string[]>>): string[] {
  const dropped: string[] = [];
  const db = new Database(path, { readwrite: true });
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    for (const table of tablesIn(path)) {
      if (whole.includes(table)) continue;
      const keep = columns[table];
      if (keep) {
        const list = keep.map((column) => `"${column}"`).join(", ");
        db.exec(`CREATE TABLE "${table}__kept" AS SELECT ${list} FROM "${table}"`);
      } else {
        dropped.push(table);
      }
      db.exec(`DROP TABLE "${table}"`);
      if (keep) db.exec(`ALTER TABLE "${table}__kept" RENAME TO "${table}"`);
    }
  } finally {
    db.close();
  }
  return dropped;
}

/** A one-file copy of a fixture's database, to strip or edit without touching the fixture. */
function copyOf(game: GameFixture): string {
  const copy = join(scratchDirectory(), "daily.sqlite");
  copyFileSync(game.databasePath, copy);
  return copy;
}

function edit(path: string, sql: string, ...values: (string | number)[]): void {
  const db = new Database(path, { readwrite: true });
  try {
    db.run(sql, values);
  } finally {
    db.close();
  }
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

  test("reads only the columns it lists: a copy stripped to them builds the very same bytes", () => {
    const game = fixture({ journal: "delete" });
    const stripped = copyOf(game);
    const dropped = stripTo(stripped, READ_WHOLE, READ_COLUMNS);

    const full = buildDataset(snapshotOf(game.databasePath), fixtureSources(game), NOW, PRIVATE);
    const snapshot = snapshotOf(stripped);
    const lean = buildDataset(snapshot, fixtureSources(game), NOW, PRIVATE);

    expect(NEVER_READ.filter((table) => !dropped.includes(table))).toEqual([]);
    expect(tablesIn(stripped)).toEqual([...READ_WHOLE, ...Object.keys(READ_COLUMNS)].sort());
    // Each whole table was read, not merely survived.
    expect(snapshot.accepted.map((puzzle) => puzzle.id)).toEqual([COMMUNITY_ID]);
    expect(snapshot.overrides.map((override) => override.puzzleId)).toEqual([CORRECTED_ID]);
    expect(snapshot.published.map((puzzle) => puzzle.id)).toEqual([PUBLISHED_ID]);
    expect(snapshot.players.tierRuns.length).toBeGreaterThan(0);
    // And the stripped columns changed nothing anybody is served.
    expect(Buffer.from(lean.sqlite).equals(Buffer.from(full.sqlite))).toBe(true);
    expect(Buffer.from(lean.json).equals(Buffer.from(full.json))).toBe(true);
    expect(lean.bodies).toEqual(full.bodies);
  });

  test("needs every column it lists, so the list is not padded", () => {
    const game = fixture({ journal: "delete" });
    for (const [table, columns] of Object.entries(READ_COLUMNS)) {
      for (const column of columns) {
        const copy = copyOf(game);
        const others = Object.keys(READ_COLUMNS).filter((other) => other !== table);
        stripTo(copy, [...READ_WHOLE, ...others], { [table]: columns.filter((kept) => kept !== column) });
        expect(() => snapshotOf(copy), `${table}.${column}`).toThrow(/no such column/);
      }
    }
  });

  test("never says SELECT *, which would read whatever a table holds", () => {
    const sources = readdirSync(SITE_SERVER).filter((file) => /^snapshot.*\.ts$/.test(file));

    expect(sources.sort()).toEqual(["snapshot-players.ts", "snapshot.ts"]);
    for (const file of sources) {
      expect(readFileSync(join(SITE_SERVER, file), "utf8")).not.toMatch(/SELECT\s+(?:DISTINCT\s+)?(?:\w+\.)?\*/i);
    }
  });

  test("fails in SQLite's own words on a game not yet on this code, which the refresher reads as 'deploy the game first'", () => {
    const game = fixture({ journal: "delete" });
    const changes = ["DROP TABLE guilds", "DROP TABLE site_facts", "ALTER TABLE players DROP COLUMN site_hidden"];
    for (const change of changes) {
      const copy = copyOf(game);
      edit(copy, change);
      expect(() => snapshotOf(copy), change).toThrow(/no such (table|column)/i);
    }
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

describe("what it lets out about people", () => {
  test("lets no id, avatar, hidden name, hidden key, filing time or mark of today into what it read about players", () => {
    // The player half only: the puzzle half carries each correction's officer
    // in memory, as schema 1 always has, and the public schema has no column
    // for it — `puzzledb-public-db.test.ts` scans what is served for that.
    const text = JSON.stringify(snapshotOf(fixture().databasePath).players);
    // The quiet server's name is withheld by the build's hide list, not by SQL:
    // it may sit in memory for a build, and the public-db test holds that it
    // reaches no byte. Here, and only here, it is exempt.
    const forbidden = PLANTED.filter((value) => value !== SERVERS.quiet.name);

    expect(forbidden.filter((value) => text.includes(value))).toEqual([]);
    expect(text).not.toMatch(/[0-9]{17}/);
    // The positive control: the snapshot does carry the people it may name.
    expect(text).toContain(PLAYERS.visible.name);
    expect(text).toContain(PLAYERS.unchosen.key);
  });

  test("reads nothing filed today: no run, rush, line, clear or discovery", () => {
    const { players } = snapshotOf(fixture().databasePath);
    const text = JSON.stringify(players);

    expect(players.cut).toBe(TODAY);
    for (const mark of Object.values(TODAY_MARKS)) expect(text).not.toContain(String(mark));
    expect([...players.tierRuns, ...players.rushRuns, ...players.rushRecords].filter((row) => row.day >= TODAY)).toEqual([]);
    expect(players.lines.map((line) => line.puzzleId)).not.toContain(LINES.today.puzzleId);
    // The visible player's first clear of #51 came 61 seconds into today; #12 and their withheld one did not.
    expect(players.cleared.find((row) => row.playerKey === PLAYERS.visible.key)?.count).toBe(2);
    expect(players.clearedPuzzles.map((row) => row.puzzleId)).not.toContain(51);
  });
});

describe("the game's zone", () => {
  /**
   * The fixture with its zone fact set to `zone`, and the visible player's
   * line and yesterday's first clears moved to just after the midnight that
   * starts today in New York — which is still yesterday evening in Los Angeles.
   */
  function filedJustAfterNewYorkMidnight(zone: string): string {
    const copy = copyOf(fixture({ journal: "delete" }));
    const justAfter = startOfDay(TODAY, { timeZone: "America/New_York" }) + 61_000;
    edit(copy, "UPDATE site_facts SET value = ?1 WHERE name = 'time_zone'", zone);
    edit(copy, "UPDATE puzzle_solutions SET found_at = ?1 WHERE found_at = ?2", justAfter, LINES.visible.foundAt);
    for (const clear of CLEARS.filter((one) => one.player === "visible" && one.firstAt < justAfter)) {
      edit(copy, "UPDATE puzzle_clears SET first_at = ?1 WHERE first_at = ?2", justAfter, clear.firstAt);
    }
    return copy;
  }

  test("cuts at the game's midnight, not the site's, when the site's clock is further west", () => {
    // The game runs on New York time and has dealt today; the site's clock
    // reads Los Angeles. What was filed after New York's midnight is today's
    // for the game, whatever the hour is in Los Angeles.
    const { players } = snapshotOf(filedJustAfterNewYorkMidnight("America/New_York"), TODAY);
    const visible = (rows: readonly { playerKey: string | null }[]) =>
      rows.filter((row) => row.playerKey === PLAYERS.visible.key);

    expect(players.lines.map((line) => line.puzzleId)).not.toContain(LINES.visible.puzzleId);
    expect(visible(players.discoveries)).toEqual([]);
    expect(visible(players.cleared)).toEqual([]);
    expect(visible(players.clearedPuzzles)).toEqual([]);
  });

  test("would have shown them by Los Angeles's midnight, which is what makes the test above mean anything", () => {
    const { players } = snapshotOf(filedJustAfterNewYorkMidnight("America/Los_Angeles"), TODAY);

    expect(players.lines.map((line) => line.puzzleId)).toContain(LINES.visible.puzzleId);
    expect(players.cleared.some((row) => row.playerKey === PLAYERS.visible.key)).toBe(true);
    expect(players.clearedPuzzles.some((row) => row.playerKey === PLAYERS.visible.key)).toBe(true);
  });
});
