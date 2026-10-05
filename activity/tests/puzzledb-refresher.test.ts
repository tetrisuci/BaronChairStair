/**
 * Keeping the puzzle database fresh, and keeping it serving when it cannot be.
 *
 * The refresher is the site's only moving part. Every half minute it asks a
 * cheap question — has the database committed, has a file the build reads
 * changed, has the club's day turned over, is the database file the same file
 * — and only when the answer moved does it read a snapshot. It rebuilds only
 * when what it read differs from what it last built from, because most of the
 * game's commits are runs and sign-ins that change nothing public.
 *
 * And it must never take the site down. A rebuild that throws keeps the last
 * good dataset; a database that is missing, locked or older than the code is
 * explained once, in words an operator can act on, and retried — never a
 * crash, which under pm2 would be a restart loop that serves nothing at all.
 *
 * The first half drives it with fake collaborators, so each rule is seen on
 * its own. The second half drives it against the planted game database with
 * the real snapshot and build, so the rules hold over the real thing: a
 * publish committed by a second connection, a run that changes nothing, a
 * rewritten puzzle file, midnight, a database replaced on disk, a database
 * that is not there yet, and the game's checkpoint after a read.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishArchive } from "../server/archive-rows";
import { Store } from "../server/db";
import { buildDataset } from "../puzzledb/server/dataset";
import { FIRST_TIERED_DAY, POLICY } from "../puzzledb/server/policy";
import {
  createRefresher,
  explain,
  POLL_MS,
  type Refresher,
  type RefresherDependencies,
} from "../puzzledb/server/refresher";
import { dataVersion, openGameDatabase, readSnapshot } from "../puzzledb/server/snapshot";
import type { Dataset, DayPin, GameSnapshot, PlayerSnapshot } from "../puzzledb/server/types";
import { dateOfDay } from "../puzzledb/wire";
import {
  DISCORD_ID,
  type FixtureOptions,
  fixtureSources,
  gameFixture,
  type GameFixture,
  LA,
  NOW,
  TODAY,
  UNPUBLISHED_ID,
} from "./puzzledb-fixture";

const DAY_MS = 86_400_000;

const fixtures: GameFixture[] = [];
const scratch: string[] = [];
const running: Refresher[] = [];

afterEach(() => {
  // A refresher holds a database handle, and a started one a timer.
  for (const refresher of running.splice(0)) refresher.stop();
});

afterAll(() => {
  for (const fixture of fixtures) fixture.cleanup();
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function fixture(options?: FixtureOptions): GameFixture {
  const made = gameFixture(options);
  fixtures.push(made);
  return made;
}

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "puzzledb-refresher-"));
  scratch.push(directory);
  return directory;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** What the refresher said, line by line, kept off the test runner's own output. */
interface Said {
  readonly logs: string[];
  readonly warnings: string[];
  readonly log: RefresherDependencies["log"];
}

function listener(): Said {
  const logs: string[] = [];
  const warnings: string[] = [];
  return {
    logs,
    warnings,
    log: {
      log: (...parts: unknown[]) => logs.push(parts.join(" ")),
      warn: (...parts: unknown[]) => warnings.push(parts.join(" ")),
    },
  };
}

// ── Fakes ─────────────────────────────────────────────────────────────────────

/** A database handle that only knows whether it was closed: all the refresher does with one itself. */
interface FakeHandle {
  closed: boolean;
  close(): void;
}

/**
 * The world the fake collaborators report. Tests move it between checks: a
 * commit is `version += 1`, a change somebody made is a new `snapshot`.
 */
interface World {
  clock: number;
  version: number;
  snapshot: GameSnapshot;
  openFails: unknown;
  closeFails: unknown;
  versionFails: unknown;
  readFails: unknown;
  buildFails: unknown;
  readonly reads: Array<{ clockToday: number; firstTieredDay: number }>;
  readonly built: Dataset[];
  readonly opened: FakeHandle[];
}

/**
 * No player data at all. The fakes are about when the refresher reads and
 * builds, not about what a build makes of players, so every fake snapshot
 * carries the same empty one and a change somebody made is always a pin.
 */
const NO_PLAYERS: PlayerSnapshot = Object.freeze({
  cut: TODAY,
  tierRuns: [],
  dayBoards: [],
  rushRuns: [],
  rushRecords: [],
  dailyDays: [],
  cleared: [],
  clearedPuzzles: [],
  discoveries: [],
  lines: [],
  servers: [],
});

function snapshotOf(pins: readonly DayPin[], newestPinnedDay: number | null = TODAY): GameSnapshot {
  return Object.freeze({
    accepted: [],
    overrides: [],
    published: [],
    pins: Object.freeze(pins.map((pin) => Object.freeze({ ...pin }))),
    newestPinnedDay,
    players: NO_PLAYERS,
  });
}

/** Finished days through `through`, one easy pin each, from the policy's first day. */
function pinsThrough(through: number): DayPin[] {
  const days = Array.from({ length: through - FIRST_TIERED_DAY + 1 }, (_, i) => FIRST_TIERED_DAY + i);
  return days.map((day) => ({ day, tier: "easy", puzzleId: 1 }));
}

/** A dataset with the counts the refresher reports and nothing else worth reading. */
function fakeDataset(snapshot: GameSnapshot, builtAt: number): Dataset {
  const days = [...new Set(snapshot.pins.map((pin) => pin.day))].map((day) => ({
    day,
    date: dateOfDay(day),
    deals: [],
  }));
  return Object.freeze({
    json: new Uint8Array(),
    sqlite: new Uint8Array(),
    data: {
      about: { schema: 1, builtAt: iso(builtAt), firstDay: FIRST_TIERED_DAY, throughDay: days.at(-1)?.day ?? null },
      puzzles: [],
      days,
      players: [],
      servers: [],
    },
    puzzleById: new Map(),
    dayByNumber: new Map(),
    bodies: new Map(),
    builtAt,
  });
}

interface Faked {
  readonly refresher: Refresher;
  readonly world: World;
  readonly said: Said;
  readonly files: { readonly puzzles: string; readonly solutions: string; readonly tracked: string };
}

/** Noon in Irvine on the fixture's day, one commit in, thirty finished days, nothing failing. */
function quietWorld(): World {
  return {
    clock: NOW,
    version: 1,
    snapshot: snapshotOf(pinsThrough(TODAY - 1)),
    openFails: null,
    closeFails: null,
    versionFails: null,
    readFails: null,
    buildFails: null,
    reads: [],
    built: [],
    opened: [],
  };
}

/** The four collaborators that touch the database, answering from `world` and counting what they did. */
function fakeCollaborators(world: World): Pick<RefresherDependencies, "open" | "version" | "read" | "build"> {
  return {
    open: () => {
      if (world.openFails !== null) throw world.openFails;
      const handle: FakeHandle = {
        closed: false,
        close() {
          handle.closed = true;
          if (world.closeFails !== null) throw world.closeFails;
        },
      };
      world.opened.push(handle);
      return handle as unknown as Database;
    },
    version: () => {
      if (world.versionFails !== null) throw world.versionFails;
      return world.version;
    },
    read: (_db, clockToday, firstTieredDay) => {
      if (world.readFails !== null) throw world.readFails;
      world.reads.push({ clockToday, firstTieredDay });
      return world.snapshot;
    },
    build: (snapshot, _sources, builtAt) => {
      if (world.buildFails !== null) throw world.buildFails;
      const dataset = fakeDataset(snapshot, builtAt);
      world.built.push(dataset);
      return dataset;
    },
  };
}

/**
 * A refresher over fake collaborators, beside real files: the database path
 * and the build's two files exist on disk because the trigger stats them, and
 * nothing ever opens them.
 */
function fakeRefresher(): Faked {
  const directory = scratchDirectory();
  const files = {
    puzzles: join(directory, "puzzles.json"),
    solutions: join(directory, "solutions.json"),
    tracked: join(directory, "tracked.sqlite"),
  };
  const databasePath = join(directory, "daily.sqlite");
  for (const path of [databasePath, files.puzzles, files.tracked]) writeFileSync(path, "{}");

  const world = quietWorld();
  const said = listener();
  const refresher = createRefresher({
    databasePath,
    sources: { puzzlesPath: files.puzzles, trackedArchivePath: files.tracked, timeZone: LA },
    policy: POLICY,
    now: () => world.clock,
    log: said.log,
    ...fakeCollaborators(world),
  });
  running.push(refresher);
  return { refresher, world, said, files };
}

/** A real error from the filesystem about `path`, as a stat of a missing database throws one. */
function missingFileError(path: string): unknown {
  try {
    statSync(path);
  } catch (error) {
    return error;
  }
  throw new Error(`${path} exists`);
}

describe("with fake collaborators", () => {
  test("builds once on the first check and serves it", () => {
    const { refresher, world, said } = fakeRefresher();
    expect(refresher.current()).toBeNull();
    expect(refresher.status()).toEqual({ ready: false, builtAt: null, checkedAt: null, failing: null });

    refresher.check();

    expect(world.built).toHaveLength(1);
    expect(refresher.current()).toBe(world.built[0]!);
    expect(refresher.status()).toEqual({ ready: true, builtAt: NOW, checkedAt: NOW, failing: null });
    // On the club's day, from where the policy starts history.
    expect(world.reads).toEqual([{ clockToday: TODAY, firstTieredDay: FIRST_TIERED_DAY }]);
    const days = TODAY - FIRST_TIERED_DAY;
    expect(said.logs).toEqual([
      `[puzzledb] now serving 0 puzzles and ${days} finished days through day ${TODAY - 1}.`,
    ]);
    expect(said.warnings).toEqual([]);
  });

  test("does no work when nothing moved", () => {
    const { refresher, world } = fakeRefresher();
    refresher.check();
    world.clock += POLL_MS;

    refresher.check();

    expect(world.reads).toHaveLength(1);
    expect(world.built).toHaveLength(1);
    expect(world.opened).toHaveLength(1);
    expect(refresher.status().checkedAt).toBe(NOW + POLL_MS);
  });

  test("reads but does not rebuild when what it read is unchanged", () => {
    const { refresher, world, said } = fakeRefresher();
    refresher.check();
    const first = refresher.current();

    // A commit: somebody's run, as far as anything public is concerned.
    world.version += 1;
    refresher.check();

    expect(world.reads).toHaveLength(2);
    expect(world.built).toHaveLength(1);
    expect(refresher.current()).toBe(first);

    // A commit that did change something is built, and said once.
    world.version += 1;
    world.snapshot = snapshotOf(pinsThrough(TODAY - 1).slice(1));
    refresher.check();

    expect(world.built).toHaveLength(2);
    expect(refresher.current()).not.toBe(first);
    expect(said.logs).toHaveLength(2);
  });

  test("rebuilds when a file the build reads changes, though the database has not", () => {
    const { refresher, world, files } = fakeRefresher();
    refresher.check();

    writeFileSync(files.tracked, "a tracked archive, re-pulled and longer");
    refresher.check();
    expect(world.built).toHaveLength(2);

    // solutions.json beside the puzzles is read too, appearing or going.
    writeFileSync(files.solutions, '{"solutions": []}');
    refresher.check();
    expect(world.built).toHaveLength(3);
    rmSync(files.solutions);
    refresher.check();
    expect(world.built).toHaveLength(4);
  });

  test("reads again when the club's day turns over, with no commit", () => {
    const { refresher, world } = fakeRefresher();
    // A minute before midnight in Irvine, then a minute after.
    world.clock = Date.UTC(2026, 9, 3, 6, 59);
    refresher.check();
    world.clock += 2 * 60_000;

    refresher.check();

    expect(world.reads.map((read) => read.clockToday)).toEqual([TODAY, TODAY + 1]);
  });

  test("keeps serving the last good dataset when a rebuild throws, logs once per distinct failure, and logs the recovery", () => {
    const { refresher, world, said } = fakeRefresher();
    refresher.check();
    const good = refresher.current();
    world.clock += POLL_MS;
    world.version += 1;
    world.snapshot = snapshotOf(pinsThrough(TODAY - 1).slice(2));

    world.buildFails = new Error("data/puzzles.json contains no puzzles");
    refresher.check();
    refresher.check();

    expect(refresher.current()).toBe(good);
    expect(said.warnings).toEqual([
      "[puzzledb] could not rebuild the public data (data/puzzles.json contains no puzzles) " +
        `(still serving what was built at ${iso(NOW)}; retrying every 30 s)`,
    ]);
    expect(refresher.status()).toEqual({
      ready: true,
      builtAt: NOW,
      checkedAt: NOW,
      failing: "could not rebuild the public data (data/puzzles.json contains no puzzles)",
    });

    world.buildFails = new Error("Two puzzles claim id 7");
    refresher.check();
    expect(said.warnings).toHaveLength(2);
    expect(said.warnings[1]).toContain("Two puzzles claim id 7");

    world.buildFails = null;
    world.clock += POLL_MS;
    refresher.check();

    expect(refresher.current()).not.toBe(good);
    expect(refresher.status()).toEqual({
      ready: true,
      builtAt: NOW + 2 * POLL_MS,
      checkedAt: NOW + 2 * POLL_MS,
      failing: null,
    });
    expect(said.logs.at(-1)).toBe("[puzzledb] recovered after 3 failed attempts.");
    expect(said.warnings).toHaveLength(2);
  });

  test("never throws, whatever a collaborator throws", () => {
    const { refresher, world, said } = fakeRefresher();

    world.openFails = "a bare string, not an Error";
    expect(() => refresher.check()).not.toThrow();
    world.openFails = null;
    world.buildFails = { neither: "an Error nor a string" };
    expect(() => refresher.check()).not.toThrow();

    expect(refresher.current()).toBeNull();
    expect(said.warnings[0]).toBe(
      "[puzzledb] could not rebuild the public data (a bare string, not an Error) " +
        "(nothing to serve yet; retrying every 30 s)",
    );
    expect(said.warnings).toHaveLength(2);
  });

  test("lets go of a handle that will not close, and says so rather than throwing", () => {
    const { refresher, world, said } = fakeRefresher();
    refresher.check();

    world.closeFails = new Error("unfinalized statements");
    world.versionFails = new Error("disk I/O error");
    expect(() => refresher.check()).not.toThrow();

    expect(said.warnings).toContain("[puzzledb] could not close the database handle (unfinalized statements)");
    world.closeFails = null;
    world.versionFails = null;
    refresher.check();
    expect(world.opened).toHaveLength(2);
    expect(refresher.status().failing).toBeNull();
  });

  test("explains an unopenable file, an old schema and a busy database in words an operator can act on", () => {
    const path = join(scratchDirectory(), "daily.sqlite");

    expect(explain(new Error("unable to open database file"), path)).toBe(
      `cannot open ${path} read-only (unable to open database file) — ` +
        "is the game running, and is DATABASE_PATH the game's own?",
    );
    expect(explain(missingFileError(path), path)).toStartWith(`cannot open ${path} read-only (ENOENT`);
    expect(explain(new Error("file is not a database"), path)).toStartWith(`cannot open ${path} read-only`);

    expect(explain(new Error("no such table: puzzle_overrides"), path)).toBe(
      "the database is older than this checkout (no such table: puzzle_overrides). The game " +
        "migrates it when it starts on this code: deploy the game first (activity/DEPLOY.md)",
    );
    expect(explain(new Error("no such column: published_at"), path)).toStartWith(
      "the database is older than this checkout",
    );

    expect(explain(new Error("database is locked"), path)).toBe("the database was busy (database is locked)");

    // A missing puzzle file is a missing file, but it is not the database.
    const puzzles = join(scratchDirectory(), "puzzles.json");
    const unreadable = new Error(`Could not read ${puzzles}.`, { cause: missingFileError(puzzles) });
    expect(explain(missingFileError(puzzles), path)).toStartWith("could not rebuild the public data (ENOENT");
    expect(explain(unreadable, path)).toBe(`could not rebuild the public data (Could not read ${puzzles}.)`);
  });

  test("closes and reopens its handle after a connection fault", () => {
    const { refresher, world } = fakeRefresher();
    refresher.check();

    world.versionFails = new Error("disk I/O error");
    refresher.check();
    expect(world.opened[0]!.closed).toBe(true);

    world.versionFails = null;
    refresher.check();
    expect(world.opened).toHaveLength(2);
    expect(world.opened[1]!.closed).toBe(false);
    expect(refresher.status().failing).toBeNull();

    // A busy database is not a broken connection: the handle stays.
    world.version += 1;
    world.readFails = new Error("database is locked");
    refresher.check();
    expect(world.opened[1]!.closed).toBe(false);
    expect(world.opened).toHaveLength(2);
  });

  test("asks whether it has the live database when the newest pinned day is days behind", () => {
    const { refresher, world, said } = fakeRefresher();
    // Two days behind is a quiet weekend nobody played. Three is not.
    world.snapshot = snapshotOf(pinsThrough(TODAY - 3), TODAY - 2);
    refresher.check();
    expect(said.warnings).toEqual([]);

    world.version += 1;
    world.snapshot = snapshotOf(pinsThrough(TODAY - 4), TODAY - 3);
    refresher.check();
    world.version += 1;
    world.snapshot = snapshotOf(pinsThrough(TODAY - 5), TODAY - 4);
    refresher.check();

    expect(said.warnings).toEqual([
      `[puzzledb] the newest pinned day is ${TODAY - 3} and today is ${TODAY}: ` +
        "is DATABASE_PATH the game's live database?",
    ]);
  });

  test("asks the same of a database that has never pinned a day", () => {
    const { refresher, world, said } = fakeRefresher();
    world.snapshot = snapshotOf([], null);

    refresher.check();

    expect(said.warnings).toEqual([
      `[puzzledb] the game's database has no pinned day and today is ${TODAY}: ` +
        "is DATABASE_PATH the game's live database?",
    ]);
    expect(said.logs).toEqual(["[puzzledb] now serving 0 puzzles and no finished days."]);
  });

  test("polls on its own once started, and lets go of the database when stopped", async () => {
    const { refresher, world } = fakeRefresher();
    const commits = setInterval(() => {
      world.version += 1;
    }, 2);

    refresher.start(5);
    // Waited for, not slept for: a busy machine runs timers late, never early.
    const deadline = Date.now() + 5_000;
    while (world.reads.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    refresher.stop();
    clearInterval(commits);
    const reads = world.reads.length;
    await Bun.sleep(30);

    expect(reads).toBeGreaterThanOrEqual(3);
    expect(world.reads).toHaveLength(reads);
    expect(world.opened.every((handle) => handle.closed)).toBe(true);
  });
});

// ── The real thing ────────────────────────────────────────────────────────────

interface Real {
  readonly refresher: Refresher;
  readonly said: Said;
  readonly clock: { now: number };
  readonly builds: () => number;
  readonly reads: () => number;
}

/** A refresher over the fixture with the real snapshot and build, counting both. */
function realRefresher(
  game: Pick<GameFixture, "databasePath" | "puzzlesPath" | "trackedArchivePath">,
  overrides: Partial<RefresherDependencies> = {},
): Real {
  const said = listener();
  const clock = { now: NOW };
  let builds = 0;
  let reads = 0;
  const refresher = createRefresher({
    databasePath: game.databasePath,
    sources: fixtureSources(game),
    policy: POLICY,
    now: () => clock.now,
    log: said.log,
    open: openGameDatabase,
    version: dataVersion,
    read: (db, clockToday, firstTieredDay) => {
      reads += 1;
      return readSnapshot(db, clockToday, firstTieredDay);
    },
    build: (snapshot, sources, builtAt, policy) => {
      builds += 1;
      return buildDataset(snapshot, sources, builtAt, policy);
    },
    ...overrides,
  });
  running.push(refresher);
  return { refresher, said, clock, builds: () => builds, reads: () => reads };
}

function servedThrough(refresher: Refresher): number | null | undefined {
  return refresher.current()?.data.about.throughDay;
}

/** What the game's own writer gets when it tries to fold the log back into the file. */
function checkpointBusy(writer: Database): number {
  const result = writer.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (!result) throw new Error("wal_checkpoint answered nothing");
  return result.busy;
}

/** The game filing one solved easy run for today, as a player finishing it would. */
function fileTodaysRun(game: GameFixture, player: { id: string; username: string; avatarUrl: null }): void {
  const store = new Store(game.databasePath);
  try {
    store.recordRun(TODAY, "easy", 51, player, null, {
      solved: true,
      attack: 4,
      targetAttack: 4,
      durationMs: 30_000,
      totalMs: 60_000,
      resets: 0,
      piecesPlaced: 5,
      clears: ["tsd"],
    });
  } finally {
    store.close();
  }
}

describe("against the game's database", () => {
  test("picks up a publish the game commits", () => {
    const game = fixture();
    const { refresher } = realRefresher(game);
    refresher.check();
    expect(refresher.current()?.puzzleById.has(UNPUBLISHED_ID)).toBe(false);

    // The game's side: a second connection, as `bun run publish-archive` opens one.
    const writer = new Database(game.databasePath, { readwrite: true });
    try {
      publishArchive(writer, [UNPUBLISHED_ID], "discord:planted-officer-publisher", NOW);
    } finally {
      writer.close();
    }
    refresher.check();

    expect(refresher.current()?.puzzleById.has(UNPUBLISHED_ID)).toBe(true);
  });

  test("reads afresh on a new connection, because data_version starts again with it", () => {
    const game = fixture();
    const { refresher } = realRefresher(game);
    refresher.check();
    refresher.stop();

    // Committed while nothing held the database open: no connection of the
    // refresher's ever saw data_version move.
    const writer = new Database(game.databasePath, { readwrite: true });
    try {
      publishArchive(writer, [UNPUBLISHED_ID], "discord:planted-officer-publisher", NOW);
    } finally {
      writer.close();
    }
    refresher.check();

    expect(refresher.current()?.puzzleById.has(UNPUBLISHED_ID)).toBe(true);
  });

  /**
   * A run filed today, by a player with no finished day and so nothing on the
   * site: the commonest commit the game makes. Today's row is outside every
   * finished-day read, and a player who has never finished a day is on no
   * board, so the snapshot comes back exactly as it was.
   */
  test("ignores a commit nothing public depends on", () => {
    const game = fixture();
    const real = realRefresher(game);
    real.refresher.check();
    const first = real.refresher.current();

    fileTodaysRun(game, { id: "refresher-new-player", username: "refresher-new-player", avatarUrl: null });
    real.refresher.check();

    // It looked, because the database moved, and built nothing, because nothing public did.
    expect(real.reads()).toBe(2);
    expect(real.builds()).toBe(1);
    expect(real.refresher.current()).toBe(first);
  });

  /**
   * The same commit by a shown player under a new name is public: signing in
   * renames the player, and every finished-day board that names them has to
   * say the new name. The run itself is today's and changes nothing; the name
   * is what moved.
   */
  test("rebuilds when a commit renames a shown player", () => {
    const game = fixture();
    const real = realRefresher(game);
    real.refresher.check();
    const before = real.refresher.current();
    expect(before?.json && new TextDecoder().decode(before.json)).toContain("fixture-visible-player");

    fileTodaysRun(game, { id: DISCORD_ID, username: "refresher-renamed-player", avatarUrl: null });
    real.refresher.check();

    expect(real.builds()).toBe(2);
    const served = new TextDecoder().decode(real.refresher.current()?.json);
    expect(served).toContain("refresher-renamed-player");
    expect(served).not.toContain("fixture-visible-player");
  });

  test("picks up a rewritten puzzles.json with no database write", () => {
    const game = fixture();
    const { refresher } = realRefresher(game);
    refresher.check();
    const file = JSON.parse(readFileSync(game.puzzlesPath, "utf8")) as { puzzles: Array<{ id: number; title: string }> };
    const edited = file.puzzles[0]!;
    expect(refresher.current()?.puzzleById.get(edited.id)?.title).toBe(edited.title);

    edited.title = "A title somebody just wrote";
    writeFileSync(game.puzzlesPath, JSON.stringify(file));
    refresher.check();

    expect(refresher.current()?.puzzleById.get(edited.id)?.title).toBe("A title somebody just wrote");
  });

  test("moves the cut at the day's rollover with no database write", () => {
    const game = fixture();
    const real = realRefresher(game);
    real.refresher.check();
    expect(servedThrough(real.refresher)).toBe(TODAY - 1);

    // Midnight in Irvine. The fixture has today and tomorrow pinned already,
    // so the newest pin is not what holds today back: the clock was.
    real.clock.now = NOW + DAY_MS;
    real.refresher.check();

    expect(servedThrough(real.refresher)).toBe(TODAY);
  });

  test("reopens a database replaced on disk", () => {
    // Rollback journals, so each database is exactly one file to move.
    const game = fixture({ journal: "delete" });
    const replacement = fixture({ journal: "delete", withoutToday: true });
    const opened: Database[] = [];
    const { refresher } = realRefresher(game, {
      open: (path) => {
        const db = openGameDatabase(path);
        opened.push(db);
        return db;
      },
    });
    refresher.check();
    expect(servedThrough(refresher)).toBe(TODAY - 1);

    // A restore from a backup: a new file renamed over the old one.
    renameSync(replacement.databasePath, game.databasePath);
    refresher.check();

    expect(servedThrough(refresher)).toBe(TODAY - 2);
    expect(opened).toHaveLength(2);
    expect(() => opened[0]!.query("SELECT 1").get()).toThrow();
  });

  test("serves nothing and says why while the database is missing, then serves once it appears", () => {
    const game = fixture({ journal: "delete" });
    const path = join(scratchDirectory(), "daily.sqlite");
    const { refresher, said } = realRefresher({ ...game, databasePath: path });

    refresher.check();
    refresher.check();

    expect(refresher.current()).toBeNull();
    expect(refresher.status().ready).toBe(false);
    expect(refresher.status().failing).toStartWith(`cannot open ${path} read-only (ENOENT`);
    expect(said.warnings).toHaveLength(1);
    expect(said.warnings[0]).toEndWith(
      "is DATABASE_PATH the game's own? (nothing to serve yet; retrying every 30 s)",
    );
    // Refused, never created.
    expect(existsSync(path)).toBe(false);

    renameSync(game.databasePath, path);
    refresher.check();

    expect(servedThrough(refresher)).toBe(TODAY - 1);
    expect(refresher.status().failing).toBeNull();
    expect(said.logs.at(-1)).toBe("[puzzledb] recovered after 2 failed attempts.");
  });

  test("holds no read transaction between checks", () => {
    const game = fixture();
    const real = realRefresher(game);
    const writer = new Database(game.databasePath, { readwrite: true });
    try {
      // A commit from the game's side before each check, so the log holds
      // frames a lingering reader would pin.
      writer.exec("PRAGMA user_version = 1");
      real.refresher.check();
      expect(checkpointBusy(writer)).toBe(0);

      writer.exec("PRAGMA user_version = 2");
      real.refresher.check();
      expect(real.reads()).toBe(2);
      expect(checkpointBusy(writer)).toBe(0);
    } finally {
      writer.close();
    }
  });
});
