/**
 * Whether a verified run solved its puzzle — the one answer, for all four sites.
 *
 * There are exactly four places a server decides a solve: the daily run, a rush
 * segment, and the two duel rounds. They agreed with each other only because
 * they each called `meetsTarget` and there was nothing else to call. Now that
 * the answer has two halves, they call this instead, so a puzzle cannot mean
 * one thing in a duel and another in the daily.
 *
 * **The rollout flag.** Enforcing clears changes what "solved" means for
 * players who are mid-run when the server restarts, and their client is the one
 * that decides whether a log is even submitted. A player on the old bundle
 * plays to the attack target and stops; under strict scoring the server refuses
 * that log, and in rush an unsolved segment is spent against a budget of two —
 * so a stale client does not score lower, it loses the whole five minutes to a
 * 400. `log` exists so the change can be watched before it bites: the strict
 * verdict is computed, the loose one is filed, and every disagreement is
 * printed with the puzzle that caused it.
 *
 * Default is `log` rather than `on`, and the direction is deliberate. Forgetting
 * to turn enforcement on costs nothing but a quiet log; forgetting to turn it
 * off during the cutover costs somebody their rush.
 */

import { clearShortfall, meetsTarget, solvesPuzzle, type ClearName, type Puzzle } from "@shared/puzzle";
import { config } from "./config";

export type GoalEnforcement = "off" | "log" | "on";

/** Just enough of a puzzle to judge a run against it, and to name it in a log. */
type Judged = Pick<Puzzle, "id" | "goal" | "targetAttack" | "requiredClears">;

/**
 * @param where which of the four sites is asking, for the log line
 * @param mode defaults to the configured policy; passed explicitly by tests, so
 *   the rule can be exercised without reaching through module-level config
 */
export function solvedUnderPolicy(
  attack: number,
  clears: readonly ClearName[],
  puzzle: Judged,
  where: string,
  mode: GoalEnforcement = config.goalEnforcement,
): boolean {
  const loose = meetsTarget(attack, puzzle.targetAttack);
  if (mode === "off") return loose;

  const strict = solvesPuzzle(attack, clears, puzzle);
  // Only the disagreement is worth a line. A run that fails on attack is not
  // news, and a run that meets both is the ordinary case.
  if (loose && !strict) {
    const missing = clearShortfall(clears, puzzle.requiredClears)
      .map((entry) => `${entry.count} more ${entry.clear}`)
      .join(", ");
    console.warn(
      `[goal] ${where} puzzle ${puzzle.id}: reached ${attack}/${puzzle.targetAttack} attack ` +
        `but still needs ${missing} — goal is "${puzzle.goal}"` +
        (mode === "log" ? " (filed as solved; GOAL_ENFORCEMENT=log)" : " (refused)"),
    );
  }
  return mode === "on" ? strict : loose;
}
