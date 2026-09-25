/**
 * Serving a new puzzle pool without a restart.
 *
 * A restart is what this replaces, and a restart is not free: it drops every
 * duel's socket and fails whatever requests are in flight. So the new pool is
 * swapped into the running process instead, and every step is ordered so that
 * nobody mid-game can tell:
 *
 * 1. **Build first.** A source that does not load throws here, before anything
 *    has been written or swapped, and the running archive carries on.
 * 2. **Pin with the old pool.** Today's tiers and rush pool, and any quiet day
 *    since the last pinned one, are written down from the pool they were live
 *    under. See `DaySchedule.freezeThrough`.
 * 3. **Reconcile.** New ids join; a puzzle whose board moved is held as it was
 *    until the next start. See `PuzzleArchive.reconcile`.
 * 4. **Swap in place**, in one synchronous stretch — nothing in here awaits —
 *    so no request sees half of it.
 *
 * Duels need nothing from this: a round carries its own puzzle, and `onPool`
 * only changes what the next round is drawn from.
 *
 * A module of its own, taking everything it touches as arguments, so it can be
 * tested against a database of its own. The route that calls it lives in
 * `server/index.ts`, whose store every server test file shares — and a test
 * that grew that store's pool would change what every file after it is dealt.
 */

import { seedReferenceSolutions } from "./discoveries";
import type { Store } from "./db";
import { type ArchiveChange, PuzzleArchive } from "./puzzles";
import type { DaySchedule } from "./schedule";
import type { Puzzle } from "../shared/puzzle";

export interface Reloadable {
  /** The archive every route already holds. Updated in place. */
  readonly archive: PuzzleArchive;
  readonly schedule: DaySchedule;
  readonly store: Store;
  /** The archive the sources describe right now, loaded exactly as at boot. */
  readonly load: () => PuzzleArchive;
  /** Told the new pool once it is being served. The duel module's `useArchive`. */
  readonly onPool?: (puzzles: readonly Puzzle[]) => void;
}

export type ReloadResult = ArchiveChange & { readonly puzzles: number };

export function reloadInPlace(target: Reloadable): ReloadResult {
  const { archive, schedule, store } = target;
  const next = target.load();
  schedule.freezeThrough(archive.currentDay());
  const { archive: merged, change } = PuzzleArchive.reconcile(archive, next);
  archive.adopt(merged);
  schedule.forget();
  target.onPool?.(archive.puzzles);
  // Idempotent, and it has to run: a new puzzle's own answer would otherwise
  // be the first player's "discovery".
  seedReferenceSolutions(store, archive.all);
  console.log(
    `[puzzle] archive reloaded: ${archive.puzzles.length} puzzles` +
      (change.added.length ? `, added ${change.added.join(", ")}` : "") +
      (change.held.length
        ? `, holding ${change.held.join(", ")} as they were until restart (their board changed)`
        : ""),
  );
  return { ...change, puzzles: archive.puzzles.length };
}
