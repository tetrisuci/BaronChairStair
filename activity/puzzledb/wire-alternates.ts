/**
 * The alternates page's body: every line players found, across every listed
 * puzzle, in the shape the build writes and the page reads.
 *
 * Beside `wire.ts` rather than in it only to keep that file readable; the rule
 * is the same one — a field renamed on one side alone is a column that renders
 * nothing and fails nothing — and `tests/puzzledb-wire-alternates.test.ts`
 * pins every key.
 *
 * **One row per published line, and no steps.** A sort needs every row at
 * once, so this body cannot be cut by page the way the solves feed is, and it
 * grows by one row per line found. The steps are what would make it heavy and
 * are on each puzzle's own body already, where a row's link goes. A row says
 * what the public `lines` table says of a line — its puzzle, its position, the
 * day it was found, what it sent and made — and its length, which is that
 * row's steps counted. Never who found it, and never when within the day.
 *
 * **Types only, importing types only**, for the reason `wire-profiles.ts`
 * gives: Vite drops it from the bundle whole.
 */

import type { ClearName } from "../shared/puzzle";
import type { SiteBody } from "./wire";

/** One published line, as the alternates table lists it. */
export interface SiteAlternateRow {
  readonly puzzleId: number;
  /** The line's `position` on its puzzle: `/puzzle/:id#line-<position>` opens it. */
  readonly position: number;
  /** The game's day it was found on, as `SiteLine.day`. */
  readonly day: number;
  readonly attack: number;
  /** How many pieces it placed: its steps, counted. */
  readonly pieces: number;
  readonly clears: readonly ClearName[];
}

/** `GET /data/alternates.json`: every published line, by puzzle then position. The page sorts. */
export interface SiteAlternatesBody extends SiteBody {
  readonly lines: readonly SiteAlternateRow[];
}
