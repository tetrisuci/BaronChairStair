/**
 * Keeps the puzzle database's dataset fresh, and the site serving when it
 * cannot be.
 *
 * Every half minute it asks a cheap question, and only an answer that moved
 * costs anything. The question is wide on purpose:
 *
 * - **`PRAGMA data_version`** moves on every commit the game makes — every
 *   run, every sign-in, even a bare checkpoint — so most moves change nothing
 *   public. That is why a moved trigger only buys a *read*: the snapshot is
 *   hashed, and a build runs only when the hash differs from the one the
 *   current dataset was built from. `PuzzleArchive.load`, and the `[puzzle]`
 *   warnings it prints, then run once per real change, not once per run.
 * - **Three files** the build reads beside the database: `puzzles.json`,
 *   `solutions.json` beside it, and the tracked archive. A pull or a
 *   `bun run puzzles` changes them, and the database cannot see that.
 * - **The club's day**, because at midnight the cut moves and yesterday
 *   becomes history without anybody committing anything.
 * - **The database file's inode**, because a restore from a backup replaces
 *   the file, and a handle on the old one would read the old one forever.
 *
 * **It never takes the site down.** A build that throws, or a database that
 * goes missing, is locked or is older than the code, keeps the last good
 * dataset serving; before the first build succeeds the site answers 503. Never
 * an exit — an exit under pm2 is a restart loop that serves nothing at all and
 * logs the same line forever. Each distinct failure is explained once, in
 * words an operator can act on (see {@link explain}), and its recovery is
 * said once too.
 *
 * **`check()` is synchronous.** `bun:sqlite` is, and so is everything it
 * calls, so two checks can never overlap and the dataset is swapped in one
 * assignment between requests. Every collaborator is handed in, so the tests
 * can drive each rule with fakes; `main.ts` hands in the real ones.
 */

import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { dayNumber } from "../../shared/daily";
import type { SiteData } from "../wire";
import type { Dataset, DatasetSources, GameSnapshot, Policy, RefreshStatus } from "./types";

/** How often the cheap question is asked. */
export const POLL_MS = 30_000;

/**
 * How many days the newest pinned day may trail the club's today before the
 * site asks whether it is reading the live database.
 *
 * Something pins every day somebody plays, and the bot's recap pins one every
 * five minutes when it is on, so a gap of a day or two is a quiet weekend. A
 * longer one is a site pointed at a copy, or at a game that has stopped.
 */
const STALE_AFTER_DAYS = 2;

/** Everything the refresher works with. `main.ts` passes the real collaborators. */
export interface RefresherDependencies {
  readonly databasePath: string;
  readonly sources: DatasetSources;
  readonly policy: Policy;
  readonly now: () => number;
  readonly log: Pick<Console, "log" | "warn">;
  /** `openGameDatabase`. */
  readonly open: (path: string) => Database;
  /** `dataVersion`. */
  readonly version: (db: Database) => number;
  /** `readSnapshot`. */
  readonly read: (db: Database, clockToday: number, firstTieredDay: number) => GameSnapshot;
  /** `buildDataset`. */
  readonly build: (snapshot: GameSnapshot, sources: DatasetSources, builtAt: number, policy: Policy) => Dataset;
}

export interface Refresher {
  /** One look, and a rebuild if anything public moved. Never throws. */
  check(): void;
  /** The dataset to serve, or null while none has ever been built. */
  current(): Dataset | null;
  status(): RefreshStatus;
  /** Checks every `intervalMs` until stopped. */
  start(intervalMs?: number): void;
  /** Stops checking and lets go of the database. */
  stop(): void;
}

export function createRefresher(deps: RefresherDependencies): Refresher {
  return new PollingRefresher(deps);
}

/**
 * What one refresher keeps between checks.
 *
 * Only the dataset matters to anybody else, and it is swapped whole and never
 * edited. Everything else here is what the next check compares against: the
 * last trigger and inputs hash, the handle and the inode it was opened on,
 * and the failure last explained, so each is explained once.
 */
class PollingRefresher implements Refresher {
  private readonly deps: RefresherDependencies;
  private handle: Database | null = null;
  private handleInode: number | null = null;
  private lastTrigger: string | null = null;
  private lastInputs: number | bigint | null = null;
  private serving: Dataset | null = null;
  private checkedAt: number | null = null;
  private failing: string | null = null;
  private failures = 0;
  private askedIfStale = false;
  private intervalMs = POLL_MS;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: RefresherDependencies) {
    this.deps = deps;
  }

  check(): void {
    try {
      this.refresh();
    } catch (error) {
      this.fail(error);
    }
  }

  current(): Dataset | null {
    return this.serving;
  }

  status(): RefreshStatus {
    return Object.freeze({
      ready: this.serving !== null,
      builtAt: this.serving?.builtAt ?? null,
      checkedAt: this.checkedAt,
      failing: this.failing,
    });
  }

  start(intervalMs = POLL_MS): void {
    this.stopTimer();
    this.intervalMs = intervalMs;
    this.timer = setInterval(() => this.check(), intervalMs);
  }

  stop(): void {
    this.stopTimer();
    this.release();
  }

  private refresh(): void {
    const { deps } = this;
    const now = deps.now();
    const today = dayNumber(now, { timeZone: deps.sources.timeZone });
    const db = this.connection();
    const stamps = fileStamps(deps.sources);
    const trigger = JSON.stringify([this.handleInode, deps.version(db), today, stamps]);
    if (trigger === this.lastTrigger && this.failing === null) {
      this.checkedAt = now;
      return;
    }
    // One short deferred transaction, over before anything is built from it.
    const snapshot = deps.read(db, today, deps.policy.firstTieredDay);
    const inputs = Bun.hash(JSON.stringify([snapshot, stamps]));
    if (this.serving === null || inputs !== this.lastInputs) {
      this.serve(deps.build(snapshot, deps.sources, now, deps.policy));
      this.lastInputs = inputs;
    }
    this.askIfStale(snapshot.newestPinnedDay, today);
    this.lastTrigger = trigger;
    this.checkedAt = now;
    this.recovered();
  }

  /** The open handle, reopened when the file at the path is no longer the file it was opened on. */
  private connection(): Database {
    const inode = statSync(this.deps.databasePath).ino;
    if (this.handle !== null && inode !== this.handleInode) this.release();
    if (this.handle === null) {
      this.handle = this.deps.open(this.deps.databasePath);
      this.handleInode = inode;
      // `data_version` counts from wherever a new connection starts, so the
      // last trigger says nothing about this one: read at least once.
      this.lastTrigger = null;
    }
    return this.handle;
  }

  /**
   * Lets go of the handle. Called from the failure path too, so a close that
   * throws is said and swallowed here: `check()` must never throw, and the
   * handle is forgotten either way.
   */
  private release(): void {
    const open = this.handle;
    this.handle = null;
    this.handleInode = null;
    try {
      open?.close();
    } catch (error) {
      this.deps.log.warn(`[puzzledb] could not close the database handle (${describe(error)})`);
    }
  }

  /** Swaps the dataset whole, saying so when what it serves looks different. */
  private serve(next: Dataset): void {
    const serving = describeServing(next.data);
    if (this.serving === null || describeServing(this.serving.data) !== serving) {
      this.deps.log.log(`[puzzledb] now serving ${serving}.`);
    }
    this.serving = next;
  }

  private recovered(): void {
    if (this.failing === null) return;
    const attempts = counted(this.failures, "failed attempt");
    this.deps.log.log(`[puzzledb] recovered after ${attempts}.`);
    this.failing = null;
    this.failures = 0;
  }

  private askIfStale(newestPinnedDay: number | null, today: number): void {
    if (this.askedIfStale) return;
    if (newestPinnedDay !== null && today - newestPinnedDay <= STALE_AFTER_DAYS) return;
    this.askedIfStale = true;
    const newest =
      newestPinnedDay === null
        ? "the game's database has no pinned day"
        : `the newest pinned day is ${newestPinnedDay}`;
    this.deps.log.warn(
      `[puzzledb] ${newest} and today is ${today}: is DATABASE_PATH the game's live database?`,
    );
  }

  private fail(error: unknown): void {
    this.failures += 1;
    const message = explain(error, this.deps.databasePath);
    if (message !== this.failing) {
      const serving = this.serving
        ? `still serving what was built at ${new Date(this.serving.builtAt).toISOString()}`
        : "nothing to serve yet";
      this.deps.log.warn(`[puzzledb] ${message} (${serving}; retrying every ${this.intervalMs / 1000} s)`);
      this.failing = message;
    }
    if (isConnectionFault(error, this.deps.databasePath)) this.release();
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** `139 puzzles and 5 finished days through day 274`: the log's and the banner's summary. */
export function describeServing(data: SiteData): string {
  const puzzles = counted(data.puzzles.length, "puzzle");
  const { throughDay } = data.about;
  if (data.days.length === 0 || throughDay === null) return `${puzzles} and no finished days`;
  return `${puzzles} and ${counted(data.days.length, "finished day")} through day ${throughDay}`;
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * When each file the build reads last changed, so a pull that rewrites one
 * is noticed though the database never moved. `solutions.json` is looked for
 * where `PuzzleArchive.load` looks: beside the puzzles.
 */
function fileStamps(sources: DatasetSources): readonly string[] {
  const solutions = join(dirname(sources.puzzlesPath), "solutions.json");
  return [sources.puzzlesPath, solutions, sources.trackedArchivePath].map(stamp);
}

function stamp(path: string): string {
  try {
    const { mtimeMs, size } = statSync(path);
    return `${mtimeMs}:${size}`;
  } catch (error) {
    if (isMissing(error)) return "absent";
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** SQLite's own words for a file it cannot use as a database at all. */
const UNOPENABLE = /unable to open|not a database/i;
const OLD_SCHEMA = /no such (table|column)/i;
const BUSY = /busy|locked/i;
/** Faults of the connection itself, after which the handle is worth nothing. */
const BROKEN = /disk I\/O|malformed/i;

/**
 * An operator's explanation of why a check failed.
 *
 * The database's own faults are named as what they usually mean on this box:
 * a file that will not open is a wrong `DATABASE_PATH` or a game that has
 * never run there; a missing table is a game not yet deployed on this
 * checkout, which migrates its database when it starts; a lock is a moment.
 * Anything else — a puzzle file that will not parse, two puzzles claiming one
 * id — is the build's, said as such with the loader's own words.
 */
export function explain(error: unknown, databasePath: string): string {
  const message = describe(error);
  if (cannotOpen(error, message, databasePath)) {
    return (
      `cannot open ${databasePath} read-only (${message}) — ` +
      "is the game running, and is DATABASE_PATH the game's own?"
    );
  }
  if (OLD_SCHEMA.test(message)) {
    return (
      `the database is older than this checkout (${message}). The game migrates it when it ` +
      "starts on this code: deploy the game first (activity/DEPLOY.md)"
    );
  }
  if (BUSY.test(message)) return `the database was busy (${message})`;
  return `could not rebuild the public data (${message})`;
}

/**
 * Whether the database file itself could not be used.
 *
 * A filesystem error counts only when it is about the database's own path:
 * a missing `puzzles.json` is also an ENOENT, and telling an operator to
 * check `DATABASE_PATH` over it would send them to the wrong file.
 */
function cannotOpen(error: unknown, message: string, databasePath: string): boolean {
  if (UNOPENABLE.test(message)) return true;
  const { code, path } = (error ?? {}) as { code?: unknown; path?: unknown };
  return typeof code === "string" && path === databasePath;
}

function isConnectionFault(error: unknown, databasePath: string): boolean {
  const message = describe(error);
  return cannotOpen(error, message, databasePath) || BROKEN.test(message);
}

/** What went wrong, as one line of text, whatever was thrown. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return "an error that cannot be printed";
  }
}
