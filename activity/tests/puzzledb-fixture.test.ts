/**
 * The fixture the puzzle database's tests stand on, tested before anything
 * leans on it.
 *
 * Every privacy test downstream scans the site's output for the values this
 * plants. A fixture that quietly stopped planting one — a renamed column, a
 * write helper that began storing a default, a row that never landed — leaves
 * those scans passing over nothing, and green then means less than it says. So
 * this asserts the plant itself: every listed value is on disk, every column
 * that must never be published holds one, and nothing unplanted sits beside
 * them.
 *
 * Since the site began publishing players, some columns are public for one row
 * and forbidden for the next: a shown player's name beside a hidden one's, a
 * named server beside one on the hide list. For those this asserts both halves
 * — that the column holds a value the site may print *and* one it may not —
 * because a privacy test with no positive control passes just as well when the
 * site prints nobody at all.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readPublishedArchive } from "../server/archive-rows";
import { trackedAnswers } from "../server/archive-solutions";
import { Store } from "../server/db";
import { CREDITED, LIVE } from "../server/discovery-sql";
import { readOverrides } from "../server/puzzle-overrides";
import { PuzzleArchive } from "../server/puzzles";
import { readAcceptedPuzzles } from "../server/submissions";
import { dayNumber, startOfDay } from "../shared/daily";
import { GUEST_ID, PUBLIC_KEY_PATTERN } from "../shared/site";
import { FIRST_EXTREME_DAY, FIRST_TIERED_DAY } from "../puzzledb/server/policy";
import type { DayPin } from "../puzzledb/server/types";
import {
  CLEARS,
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
  LINES,
  MAY_PUBLISH,
  NOW,
  PLANTED,
  PLAYERS,
  PUBLISHED_ID,
  SERVERS,
  TODAY,
  TODAY_MARKS,
  UNPUBLISHED_ID,
} from "./puzzledb-fixture";

const COMMITTED_PUZZLES = resolve(import.meta.dir, "../data/puzzles.json");
const TRACKED_ARCHIVE = resolve(import.meta.dir, "../data/archive/puzzles.sqlite");

/**
 * Column names that say they hold an id, a server, or an officer's name: never
 * public, for anybody.
 *
 * `username` used to be here. It left when the site began showing players by
 * the name the game shows, and moved to {@link SHOWN_OR_WITHHELD}.
 */
const NEVER_PUBLIC_BY_NAME = /^(by|.+_by|player_id|guild_id|avatar_url|author_name)$/;

/**
 * Never-public columns whose names do not say so.
 *
 * `puzzle_solutions.placements` is deliberately absent: a line's steps are
 * published now, re-projected to the four fields a replay needs. What stays
 * forbidden is anything riding beside those fields, which is why the visible
 * player's line carries its planted marker in an extra one — the scan for it
 * is the test of the re-projection. `found_at` is here instead: a line's day
 * and time would name its finder as surely as their name.
 */
const ALSO_NEVER_PUBLIC: Readonly<Record<string, readonly string[]>> = {
  players: ["id"],
  preferences: ["payload"],
  submissions: ["reviewer_note", "events"],
  puzzle_override_log: ["was"],
  puzzle_solutions: ["canonical_key", "events", "found_at"],
};

/**
 * Columns the site prints for some rows and must withhold for others.
 *
 * Every cell is either planted or on {@link MAY_PUBLISH}, and each column holds
 * at least one of each. The one exception is the guest's username, which is
 * the bare word `guest`: no scan can hunt for a word the site's own text may
 * use, so the guest's withholding is tested through its key, which is planted.
 */
const SHOWN_OR_WITHHELD: Readonly<Record<string, readonly string[]>> = {
  players: ["username", "public_key"],
  guilds: ["name"],
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

  test("puts a planted value in every column that is never public, and nothing else there", () => {
    const allowed = [...PLANTED, COMMUNITY_AUTHOR];
    const empty: string[] = [];
    const unplanted: string[] = [];

    readOnly(fixture.databasePath, (db) => {
      for (const table of tablesOf(db)) {
        const watched = columnsOf(db, table).filter(
          (column) => NEVER_PUBLIC_BY_NAME.test(column) || ALSO_NEVER_PUBLIC[table]?.includes(column),
        );
        for (const column of watched) {
          const values = cells(db, table, column);
          if (values.length === 0) empty.push(`${table}.${column}`);
          for (const value of values) {
            // The guest's id is the shared word `guest`, which names nobody.
            if (value === GUEST_ID) continue;
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

  test("holds a printable and a withheld value in every column the site prints for some rows only", () => {
    const missing: string[] = [];
    const unknown: string[] = [];

    readOnly(fixture.databasePath, (db) => {
      for (const [table, columns] of Object.entries(SHOWN_OR_WITHHELD)) {
        for (const column of columns) {
          const values = cells(db, table, column).filter((value) => value !== PLAYERS.guest.name);
          const withheld = values.filter((value) => PLANTED.some((planted) => value.includes(planted)));
          const printable = values.filter((value) => MAY_PUBLISH.includes(value));
          if (withheld.length === 0) missing.push(`${table}.${column}: nothing withheld`);
          if (printable.length === 0) missing.push(`${table}.${column}: nothing printable`);
          unknown.push(
            ...values.filter((v) => !withheld.includes(v) && !printable.includes(v)).map((v) => `${table}.${column} = ${v}`),
          );
        }
      }
    });

    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);
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

describe("who it plants, for the site's player pages", () => {
  let fixture: GameFixture;

  beforeAll(() => {
    fixture = build();
  });

  test("keys every player and server with the key it exports, each one a well-formed key", () => {
    const [players, guilds] = readOnly(fixture.databasePath, (db) => [
      db.query<{ id: string; key: string }, []>("SELECT id, public_key AS key FROM players").all(),
      db.query<{ id: string; key: string }, []>("SELECT guild_id AS id, public_key AS key FROM guilds").all(),
    ]);
    const byId = (rows: readonly { id: string; key: string }[]) =>
      Object.fromEntries(rows.map((row) => [row.id, row.key]));

    expect(byId(players)).toEqual(byId(Object.values(PLAYERS)));
    expect(byId(guilds)).toEqual(byId(Object.values(SERVERS)));
    expect([...players, ...guilds].filter((row) => !PUBLIC_KEY_PATTERN.test(row.key))).toEqual([]);
  });

  test("holds every opt-out state: never chose, chose to be shown, chose to hide", () => {
    const states = readOnly(fixture.databasePath, (db) =>
      db.query<{ id: string; hidden: number | null }, []>("SELECT id, site_hidden AS hidden FROM players").all(),
    );

    expect(Object.fromEntries(states.map((row) => [row.id, row.hidden]))).toEqual(
      Object.fromEntries(Object.values(PLAYERS).map((player) => [player.id, player.siteHidden])),
    );
    expect(new Set(states.map((row) => row.hidden))).toEqual(new Set([null, 0, 1]));
    expect(PLAYERS.guest.id).toBe(GUEST_ID);
  });

  test("names servers as a sign-in does, and leaves one nobody signed in from unnamed", () => {
    const names = readOnly(fixture.databasePath, (db) =>
      db.query<{ id: string; name: string | null }, []>("SELECT guild_id AS id, name FROM guilds").all(),
    );

    expect(Object.fromEntries(names.map((row) => [row.id, row.name]))).toEqual(
      Object.fromEntries(Object.values(SERVERS).map((server) => [server.id, server.name])),
    );
    expect(SERVERS.unnamed.name).toBeNull();
    expect(SERVERS.digitRun.name).toMatch(/[0-9]{17}/);
  });

  test("records the game's zone, which the site cuts its millisecond columns by", () => {
    const facts = readOnly(fixture.databasePath, (db) =>
      db.query<{ name: string; value: string }, []>("SELECT name, value FROM site_facts").all(),
    );

    expect(facts).toEqual([{ name: "time_zone", value: LA }]);
  });

  test("lists every trace a hidden player or a withheld server leaves, and nothing the site may print", () => {
    const { visible, unchosen, hidden, digitRun, guest } = PLAYERS;
    const withheld = [hidden.name, hidden.key, guest.key, digitRun.name, digitRun.key, SERVERS.quiet.name!];
    const ids = [...Object.values(PLAYERS), ...Object.values(SERVERS)].map((who) => who.id);
    const printable = [visible.name, visible.key, unchosen.name, unchosen.key, SERVERS.club.name!];

    expect(withheld.filter((value) => !PLANTED.includes(value))).toEqual([]);
    expect(ids.filter((id) => id !== GUEST_ID && !PLANTED.includes(id))).toEqual([]);
    expect(Object.values(LINES).filter((line) => !PLANTED.includes(String(line.foundAt)))).toEqual([]);
    expect(Object.values(TODAY_MARKS).filter((mark) => !PLANTED.includes(String(mark)))).toEqual([]);
    expect(printable.filter((value) => !MAY_PUBLISH.includes(value))).toEqual([]);
    expect(Object.values(SERVERS).filter((server) => !MAY_PUBLISH.includes(server.key))).toEqual([]);
    // Neither list may hide inside the other, or a scan for one would trip on the other.
    expect(MAY_PUBLISH.filter((value) => PLANTED.some((p) => value.includes(p) || p.includes(value)))).toEqual([]);
  });
});

describe("what it files, on either side of the cut", () => {
  let fixture: GameFixture;

  beforeAll(() => {
    fixture = build();
  });

  interface RunRow {
    day: number;
    puzzleId: number;
    player: string;
    guild: string | null;
    solved: number;
    attack: number;
    target: number;
    totalMs: number;
  }

  const runs = () =>
    readOnly(fixture.databasePath, (db) =>
      db
        .query<RunRow, []>(
          `SELECT day, puzzle_id AS puzzleId, player_id AS player, guild_id AS guild, solved,
                  attack, target_attack AS target, total_ms AS totalMs FROM runs`,
        )
        .all(),
    );

  test("files dailies before today and on it, outside any server, on a player's puzzle and across servers", () => {
    const all = runs();
    const finished = all.filter((run) => run.day < TODAY);
    const yesterday = finished.filter((run) => run.day === TODAY - 1);
    const serversOf = (id: string) => new Set(yesterday.filter((run) => run.player === id).map((run) => run.guild));

    expect(all.filter((run) => run.day === TODAY)).toContainEqual(
      expect.objectContaining({ attack: TODAY_MARKS.runAttack, totalMs: TODAY_MARKS.runTotalMs }),
    );
    expect(yesterday.some((run) => run.guild === null && run.player !== GUEST_ID)).toBe(true);
    expect(finished.some((run) => run.puzzleId === COMMUNITY_ID)).toBe(true);
    expect(serversOf(PLAYERS.visible.id).size).toBeGreaterThan(1);
    expect(yesterday.some((run) => run.solved === 0 && run.attack >= run.target)).toBe(true);
    // Everybody planted has a finished day, so the site has a row to show or withhold for each.
    expect(Object.values(PLAYERS).filter((p) => !finished.some((run) => run.player === p.id))).toEqual([]);
    expect(Object.values(SERVERS).filter((s) => !finished.some((run) => run.guild === s.id))).toEqual([]);
  });

  test("files a rush on the last finished day and one today", () => {
    const rushes = readOnly(fixture.databasePath, (db) =>
      db.query<{ day: number; ms: number }, []>("SELECT day, time_to_last_ms AS ms FROM rush_runs").all(),
    );

    expect(rushes.filter((rush) => rush.day === TODAY)).toEqual([{ day: TODAY, ms: TODAY_MARKS.rushMs }]);
    expect(rushes.filter((rush) => rush.day === TODAY - 1).length).toBeGreaterThan(1);
  });

  test("files every kind of line on the day it claims, in the game's zone", () => {
    const stored = readOnly(fixture.databasePath, (db) =>
      db
        .query<{ puzzleId: number; attack: number; foundAt: number; finder: string | null; credited: number; live: number }, []>(
          `SELECT puzzle_id AS puzzleId, attack, found_at AS foundAt, found_by AS finder,
                  (${CREDITED}) AS credited, (s.${LIVE}) AS live
           FROM puzzle_solutions s ORDER BY found_at`,
        )
        .all(),
    );
    const planned = Object.values(LINES)
      .map((line) => ({
        puzzleId: line.puzzleId,
        attack: line.attack,
        foundAt: line.foundAt,
        finder: line.finder === null ? null : PLAYERS[line.finder].id,
        credited: line.credited ? 1 : 0,
        live: line.live ? 1 : 0,
      }))
      .sort((a, b) => a.foundAt - b.foundAt);

    expect(stored).toEqual(planned);
    expect(Object.values(LINES).filter((line) => dayNumber(line.foundAt, { timeZone: LA }) !== line.day)).toEqual([]);
    expect(LINES.today.day).toBe(TODAY);
    expect(LINES.hidden.finder).toBe("hidden");
  });

  test("files clears on both sides of today's midnight, one only just after it", () => {
    const midnight = startOfDay(TODAY, { timeZone: LA });
    const stored = readOnly(fixture.databasePath, (db) =>
      db
        .query<{ player: string; puzzleId: number; firstAt: number }, []>(
          "SELECT player_id AS player, puzzle_id AS puzzleId, first_at AS firstAt FROM puzzle_clears ORDER BY first_at",
        )
        .all(),
    );
    const planned = CLEARS.map((clear) => ({ ...clear, player: PLAYERS[clear.player].id })).sort(
      (a, b) => a.firstAt - b.firstAt,
    );

    expect(stored).toEqual(planned);
    expect(stored.some((clear) => clear.firstAt < midnight)).toBe(true);
    // Within a minute or two of the game's midnight: a site cutting at its own,
    // later midnight would take it as yesterday's.
    expect(stored.filter((clear) => clear.firstAt >= midnight && clear.firstAt < midnight + 120_000)).toHaveLength(1);
  });
});

describe("the ids it can be asked to swap", () => {
  test("gives every player the same name, key and rows under reversed ids, so only the ids' order differs", () => {
    const rowsOf = (fixture: GameFixture) =>
      readOnly(fixture.databasePath, (db) => ({
        players: db
          .query<{ id: string; name: string; key: string }, []>(
            "SELECT id, username AS name, public_key AS key FROM players ORDER BY public_key",
          )
          .all(),
        runs: db
          .query<Record<string, unknown>, []>(
            `SELECT p.public_key AS key, r.day, r.slot, r.attack, r.total_ms, r.guild_id
             FROM runs r JOIN players p ON p.id = r.player_id ORDER BY p.public_key, r.day, r.slot`,
          )
          .all(),
      }));
    const plain = rowsOf(build());
    const reversed = rowsOf(build({ reversedIds: true }));
    const strip = (rows: typeof plain.players) => rows.map(({ name, key }) => ({ name, key }));
    const idOf = (rows: typeof plain.players, key: string) => rows.find((row) => row.key === key)?.id;

    expect(strip(reversed.players)).toEqual(strip(plain.players));
    expect(reversed.runs).toEqual(plain.runs);
    expect(new Set(reversed.players.map((row) => row.id))).toEqual(new Set(plain.players.map((row) => row.id)));
    expect(idOf(reversed.players, PLAYERS.visible.key)).toBe(PLAYERS.digitRun.id);
    expect(idOf(reversed.players, PLAYERS.digitRun.key)).toBe(PLAYERS.visible.id);
    expect(idOf(reversed.players, PLAYERS.guest.key)).toBe(GUEST_ID);
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
