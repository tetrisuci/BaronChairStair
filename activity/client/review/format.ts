/**
 * The two things both screens of the review tool have to write out.
 *
 * Both are pure and both are pinned by tests, which is the reason they are
 * here rather than inline: a timestamp read wrong and a clears list read wrong
 * are the two ways this page can mislead the person using it without looking
 * broken.
 */

import type { ClearName } from "@shared/puzzle";
import { GOAL_LABELS } from "../src/ui/builder-state";

/**
 * When a submission was filed, in local time, as `2026-09-04 14:32`.
 *
 * Written out rather than `toLocaleString`, which is the obvious answer and the
 * wrong one twice over: it renders `9/4/2026, 2:32:32 PM` on one officer's
 * machine and `04.09.2026, 14:32:32` on another's, and neither of them can tell
 * from the page which of the two it is. Fixed digits, biggest first, and the
 * seconds dropped — a review queue is read in days, not in seconds.
 *
 * Local rather than UTC because the club is in one place and "yesterday
 * evening" is the question being asked of it.
 */
export function filedOn(instant: number): string {
  const when = new Date(instant);
  if (Number.isNaN(when.getTime())) return "unknown";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}

/**
 * The clears a solve made, in the order it made them.
 *
 * In the builder's `GOAL_LABELS` vocabulary and not the result card's, on
 * purpose. This list exists to be read against the goal sentence directly above
 * it — "Clear 2 TSDs" against "TSD, TSD" — and that sentence was written by an
 * author choosing from exactly this vocabulary. Two spellings of the same clear
 * would put the reviewer's one job, comparing the two, back on their eyes.
 *
 * Repeats are kept and not counted up. "TSD, Double, TSD" and "TSD, TSD,
 * Double" are different solves, and a goal that asks for a TSD *last* is a goal
 * a tally cannot answer.
 */
export function clearList(clears: readonly ClearName[]): string {
  if (clears.length === 0) return "no line clears at all";
  return clears.map((clear) => GOAL_LABELS[clear] ?? clear).join(", ");
}
