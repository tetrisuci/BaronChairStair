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
import type { Puzzle } from "../../shared/puzzle";
import type { SiteData, SiteDay, SitePuzzle } from "../wire";

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
}

/** The files a rebuild reads beside the database: the very ones the game's next boot reads. */
export interface DatasetSources {
  readonly puzzlesPath: string;
  readonly trackedArchivePath: string;
  /** The club's zone, for `PuzzleArchive.load` and for the day the cut is taken on. */
  readonly timeZone: string;
}

/** The owner's three decisions, as one value a build is handed. See `policy.ts`. */
export interface Policy {
  readonly publishCommunity: boolean;
  readonly firstTieredDay: number;
  readonly firstExtremeDay: number;
}

/**
 * One built dataset, swapped whole by the refresher and never mutated.
 *
 * Frozen by its builder. The two byte arrays are what the data routes send,
 * byte for byte; `data` is the same content parsed back out of the public
 * database, which is how the JSON, the page heads and the download share one
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
