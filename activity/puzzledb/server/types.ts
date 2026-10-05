/**
 * The shapes the puzzle database's server passes between its parts.
 *
 * Types only, and every import is `import type`, so loading this file runs
 * nothing — in particular it never loads `server/puzzle-overrides.ts`, which
 * imports `bun:sqlite`. The JSON the page reads is in `../wire.ts`; this is the
 * server side of the same contract: what one rebuild reads from the game, what
 * it decides with, and what it hands to HTTP.
 */

import type { PuzzleOverride } from "../../server/puzzle-overrides";
import type { DailyTier } from "../../shared/daily";
import type { ClearName, Puzzle, SolutionStep } from "../../shared/puzzle";
import type { SiteData, SiteDay, SitePuzzle, TierMark } from "../wire";

/**
 * One row of `day_puzzles`, as the game wrote it.
 *
 * `tier` is a string rather than a `DailyTier` because nothing has checked it:
 * the column is TEXT, and the rule that decides which tiers a day shows
 * (`tiersShownOn`) is what a raw row is filtered through.
 */
export interface DayPin {
  readonly day: number;
  readonly tier: string;
  readonly puzzleId: number;
}

/**
 * Whose row it is, as SQL let it out: both set for a shown player, both null
 * for anyone else.
 *
 * "Anyone else" is a player who chose to hide, the guest, a player the game
 * has not yet given a key, and a name holding a run of seventeen digits — all
 * decided in SQL, so neither the id nor a hidden player's name or key is ever
 * a JS value for a leak to start from. Rows of different hidden players are
 * still separate rows; they are just unlabelled.
 */
export interface SnapshotPlayer {
  readonly playerKey: string | null;
  readonly name: string | null;
}

/** One daily hand-in on a finished day. `tier` is a real tier: SQL kept `slot IN` the four. */
export interface SnapshotTierRun extends SnapshotPlayer {
  readonly day: number;
  readonly tier: DailyTier;
  /** Raw: a community id is still here, and the build's policy nulls it. */
  readonly puzzleId: number;
  readonly solved: boolean;
  /** Null when unsolved, decided in SQL so an unsolved run's clock never leaves it. */
  readonly timeMs: number | null;
  readonly attack: number;
  readonly targetAttack: number;
  /** `guilds.public_key`; null when played outside any known server. */
  readonly serverKey: string | null;
}

/**
 * One player's finished day across tiers, as `Store.dayBoard` groups it, once
 * for `ALL_SERVERS` and once per server key. Marks are raw: 0 for a tier not
 * played, whether or not the day showed it — the build knows which it did.
 */
export interface SnapshotDayBoardRow extends SnapshotPlayer {
  /** `ALL_SERVERS`, or the server key the hand-ins counted here were made in. */
  readonly scope: string;
  readonly day: number;
  /** Tiers solved. */
  readonly solved: number;
  /** Summed over solved tiers. */
  readonly timeMs: number;
  readonly marks: Readonly<Record<DailyTier, TierMark>>;
}

/** One rush on a finished day. The game keeps one per player per day. */
export interface SnapshotRushRun extends SnapshotPlayer {
  readonly day: number;
  readonly serverKey: string | null;
  readonly solved: number;
  /** `time_to_last_ms`. */
  readonly timeMs: number;
}

/** A player's best rush before the cut, as `Store.rushRecords` picks it, per scope. */
export interface SnapshotRushRecord extends SnapshotPlayer {
  /** `ALL_SERVERS`, or a server key. */
  readonly scope: string;
  readonly solved: number;
  readonly timeMs: number;
  readonly day: number;
}

/** A player's solved daily days before the cut, legacy days included, as `dailyRecords` reads them. */
export interface SnapshotDailyDays extends SnapshotPlayer {
  /** Distinct and newest-first: what `currentStreak` and `bestStreak` take. */
  readonly days: readonly number[];
  /** Daily puzzles solved, one per tier per day. */
  readonly dailies: number;
}

/** A per-player count, aggregated in SQL so the rows it counts never leave it. */
export interface SnapshotCount extends SnapshotPlayer {
  readonly count: number;
}

/**
 * A puzzle a shown player first cleared before the cut, listed or not; the
 * build drops the ones the site does not list. SQL lets no other player's
 * out, labelled or not: a whole set of clears is as good as a name.
 */
export interface SnapshotClear extends SnapshotPlayer {
  readonly puzzleId: number;
}

/**
 * A credited, live line filed on a finished day, already re-projected.
 * Nothing in it says who filed it or when; rows arrive in publication order —
 * by puzzle, then by the day it was filed, then as filed within the day.
 */
export interface SnapshotLine {
  readonly puzzleId: number;
  readonly attack: number;
  /** Filtered to names the game knows. */
  readonly clears: readonly ClearName[];
  /** Each step only `{piece, cells, clear, attack}`, whatever else the stored JSON held. */
  readonly steps: readonly SolutionStep[];
}

/** A server the game has seen, by its public key; `name` null when unknown or a long number. */
export interface SnapshotServer {
  readonly key: string;
  readonly name: string | null;
}

/**
 * Everything one rebuild reads about players, in the same transaction as the
 * rest of {@link GameSnapshot}. Every row is before {@link cut}: today, and
 * anything later, never reaches JS.
 */
export interface PlayerSnapshot {
  /**
   * The first day not shown: the earlier of the site's today and the newest
   * day the game has pinned. Streaks are asked "as of" this day.
   */
  readonly cut: number;
  readonly tierRuns: readonly SnapshotTierRun[];
  readonly dayBoards: readonly SnapshotDayBoardRow[];
  readonly rushRuns: readonly SnapshotRushRun[];
  readonly rushRecords: readonly SnapshotRushRecord[];
  readonly dailyDays: readonly SnapshotDailyDays[];
  /** Distinct puzzles first cleared before the game-zone midnight that starts the cut. */
  readonly cleared: readonly SnapshotCount[];
  /** Shown players' first clears before that same midnight, by key then puzzle. */
  readonly clearedPuzzles: readonly SnapshotClear[];
  /** Credited lines per finder, voided included and any puzzle, as the game counts them. */
  readonly discoveries: readonly SnapshotCount[];
  readonly lines: readonly SnapshotLine[];
  /** Every server row, named or not. Which of them a build lists is its own call. */
  readonly servers: readonly SnapshotServer[];
}

/** Everything one rebuild reads from the game's database, in one short transaction. */
export interface GameSnapshot {
  /**
   * `readAcceptedPuzzles`: every accepted player puzzle, withheld or not.
   *
   * The whole list goes into `PuzzleArchive.load`, because its duplicate-id,
   * empty-tier and correction checks have to see what the game will see. Which
   * of them are listed is decided afterwards, by the policy.
   */
  readonly accepted: readonly Puzzle[];
  /** `readOverrides`. Each row's `updatedBy` stays in memory and is never output. */
  readonly overrides: readonly PuzzleOverride[];
  /** `readPublishedArchive`: published synced rows only, filtered in SQL. */
  readonly published: readonly Puzzle[];
  /** Finished days from the first tiered day on, raw tiers. */
  readonly pins: readonly DayPin[];
  /** `MAX(day)` over `day_puzzles`, or null when it is empty. */
  readonly newestPinnedDay: number | null;
  /** How finished days went, by allowlisted column: see {@link PlayerSnapshot}. */
  readonly players: PlayerSnapshot;
}

/** The files a rebuild reads beside the database: the very ones the game's next boot reads. */
export interface DatasetSources {
  readonly puzzlesPath: string;
  readonly trackedArchivePath: string;
  /** The club's zone, for `PuzzleArchive.load` and for the day the cut is taken on. */
  readonly timeZone: string;
}

/** The owner's decisions, as one value a build is handed. See `policy.ts`. */
export interface Policy {
  readonly publishCommunity: boolean;
  readonly firstTieredDay: number;
  readonly firstExtremeDay: number;
  /** Server keys whose name the site never prints: each renders "Unnamed server". */
  readonly hiddenServerKeys: ReadonlySet<string>;
}

/**
 * One built dataset, swapped whole by the refresher and never mutated.
 *
 * Frozen by its builder. The byte arrays are what the data routes send, byte
 * for byte; `data` is the same content parsed back out of the public database,
 * which is how the JSON, the page heads, the bodies and the download share one
 * allowlist.
 */
export interface Dataset {
  /** `GET /puzzles.json`. */
  readonly json: Uint8Array;
  /** `GET /puzzles.sqlite`. */
  readonly sqlite: Uint8Array;
  readonly data: SiteData;
  readonly puzzleById: ReadonlyMap<number, SitePuzzle>;
  readonly dayByNumber: ReadonlyMap<number, SiteDay>;
  /**
   * Every `/data/…` body, keyed by the path `bodyPathFor` gives its page, so the
   * route serves `bodies.get(path)` and anything else is the shared 404. Built
   * from the read-back data, like `json`.
   */
  readonly bodies: ReadonlyMap<string, Uint8Array>;
  /** Epoch milliseconds. */
  readonly builtAt: number;
}

/** How the refresher is doing, for `/health`, the log and the start-up banner. */
export interface RefreshStatus {
  readonly ready: boolean;
  readonly builtAt: number | null;
  readonly checkedAt: number | null;
  /** Why the last attempt failed, for the log and the banner only. Never sent over HTTP. */
  readonly failing: string | null;
}
