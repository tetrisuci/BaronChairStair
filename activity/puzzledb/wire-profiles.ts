/**
 * The profile browser's two bodies: the players table and the solves feed's
 * steering, in the shapes the build writes and the page reads.
 *
 * Beside `wire.ts` rather than in it only to keep that file readable; the rule
 * is the same one — a field renamed on one side alone is a column that
 * renders nothing and fails nothing — and `tests/puzzledb-wire-profiles.test.ts`
 * pins every key for both halves. The player body's own new fields, its tier
 * summaries and cleared list, stay in `wire.ts` with the rest of that body.
 *
 * **Types only, importing types only.** Nothing here runs, so it cannot start
 * an import cycle with `wire.ts`, and Vite drops it from the bundle whole.
 */

import type { DailyTier } from "../shared/daily";
import type { SiteBody } from "./wire";

/**
 * A row of the players table: the numbers the index does not carry.
 *
 * **A key, never a name.** The name, days solved and best streak are the
 * index's (`SitePlayerEntry`), joined by key, so one page can never show one
 * person under two names from two builds. The numbers are totals across every
 * server, as the game keeps them; `servers` only says where to list the row.
 */
export interface SitePlayerListRow {
  readonly key: string;
  /** Distinct puzzles ever solved, any mode: `SitePlayerTotals.puzzlesCleared`. */
  readonly puzzlesCleared: number;
  readonly linesFound: number;
  /** Most puzzles solved in one rush, and its time; both null with no rush. */
  readonly rushBest: number | null;
  readonly rushBestMs: number | null;
  /** Keys of the servers they handed in or rushed in on a finished day, sorted; a play outside any server adds none. */
  readonly servers: readonly string[];
}

/** `GET /data/players.json`. */
export interface SitePlayersBody extends SiteBody {
  /** One per listed player, in the index's order. A player who hid has none. */
  readonly rows: readonly SitePlayerListRow[];
}

/**
 * What the feed needs to know of a finished day before it fetches the day.
 *
 * **Counts and keys, and nothing about anybody.** A hidden player's solves
 * count here as anyone's do, so the body reads the same byte for byte whether
 * they hid or not; their rows are the day body's, already "a player".
 */
export interface SiteSolvesDay {
  readonly day: number;
  /** Solves per tier, "a player"'s included; 0 for a tier nobody solved or the day did not deal. */
  readonly tiers: Readonly<Record<DailyTier, number>>;
  /** Keys of the servers with at least one solve that day, sorted. A solve outside any server adds none. */
  readonly servers: readonly string[];
}

/**
 * `GET /data/solves.json`: every finished day with a daily solve, newest first.
 *
 * **It steers; it does not carry.** The rows are in each day's own body, which
 * stays the same size however long history grows, and a tier, server or
 * puzzle filter skips the days this says cannot match without fetching them.
 * This body grows by one short line a day. Rush is not here: it has its own board.
 */
export interface SiteSolvesBody extends SiteBody {
  readonly days: readonly SiteSolvesDay[];
}
