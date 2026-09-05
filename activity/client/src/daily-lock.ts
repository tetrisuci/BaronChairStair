/**
 * Which of the day's puzzles practice will not open.
 *
 * Its own module for the reason `active-run.ts` gives: this is a rule rather
 * than a rendering, and a rule that guards fairness should be checkable without
 * a browser. It was three lines inside `App`, where nothing could reach it.
 *
 * The rule is **solved**, not merely filed. A run that was filed and did not
 * solve can still be improved into one that does — `recordRun`'s upsert says so
 * outright, `WHERE runs.solved = 0 AND excluded.solved = 1` — so a player who
 * filed a miss could open the same puzzle in the explorer, practise it with the
 * answer in front of them, and come back to file the solve. That is the free
 * rehearsal the lock exists to prevent, and keying on the row's existence
 * handed it back.
 *
 * Each puzzle is locked on its own run: solving the easy one does not open the
 * hard one, because they are three separate puzzles and three separate places
 * on the board.
 *
 * Generic over the entry so a test needs neither the API types nor a DOM.
 */
export function lockedPuzzleIds(
  entries: readonly {
    readonly puzzle: { readonly id: number };
    readonly run: { readonly solved: boolean } | null;
  }[],
): ReadonlySet<number> {
  return new Set(entries.filter((entry) => !entry.run?.solved).map((entry) => entry.puzzle.id));
}
