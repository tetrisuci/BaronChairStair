/**
 * The Blueprint codes the club's tracked archive holds, by the shape they describe.
 *
 * A deploy box has no `data/solutions.json`, so the committed puzzles arrive
 * with no codes of their own: their answers come from the tracked archive, by
 * shape (`trackedAnswers`), and their codes can come from the same rows by the
 * same rule. Without this the site would link almost nothing to the viewer on
 * the one box it actually runs on.
 *
 * **By shape, never by id**, for the reason `shapeKey` gives: the tracked
 * archive and `data/puzzles.json` have drifted, and puzzle 8 is a different
 * puzzle in each. A code matched by id would open somebody else's puzzle.
 *
 * **The same rule and row order as `trackedAnswers`**: rows in id order, the
 * first row of a shape wins, a row without an answer is skipped — and so is a
 * row without both codes, since half a pair links a puzzle without its answer.
 * The answer is kept beside the codes because the dataset applies them only
 * where it is the answer being served, so the viewer always plays the line the
 * page steps through.
 *
 * **Optional.** Codes are a convenience. A missing or unreadable archive costs
 * the links and nothing else, is said once in the log, and never stops a build.
 */

import { Database } from "bun:sqlite";
import { shapeKey } from "../../server/puzzles";

/** One shape's codes, and the answer they play as `JSON.stringify` writes it. */
export interface TrackedCodes {
  readonly puzzle: string;
  readonly solution: string;
  readonly answer: string;
}

interface CodeRow {
  board: string;
  queue: string;
  hold: string | null;
  target_attack: number;
  solution: string | null;
  source_puzzle: string | null;
  source_solution: string | null;
}

const CODE_ROWS = `
  SELECT board, queue, hold, target_attack, solution, source_puzzle, source_solution
    FROM archive_puzzles
   ORDER BY id`;

/** Every code pair the tracked archive holds, keyed by {@link shapeKey}; empty if unreadable. */
export function trackedCodes(path: string): ReadonlyMap<string, TrackedCodes> {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return codesByShape(db.query<CodeRow, []>(CODE_ROWS).all());
  } catch (error) {
    // Empty rather than whatever was read before the fault: a map that is
    // complete or nothing is one the dataset can reason about.
    console.warn(`[puzzledb] could not read Blueprint codes from ${path}: ${String(error)}`);
    return new Map();
  } finally {
    db?.close();
  }
}

function codesByShape(rows: readonly CodeRow[]): Map<string, TrackedCodes> {
  const codes = new Map<string, TrackedCodes>();
  for (const row of rows) {
    if (!row.source_puzzle || !row.source_solution || !row.solution) continue;
    const answer: unknown = JSON.parse(row.solution);
    if (!Array.isArray(answer) || answer.length === 0) continue;
    const key = shapeKey({
      board: JSON.parse(row.board),
      queue: JSON.parse(row.queue),
      hold: row.hold,
      targetAttack: row.target_attack,
    } as Parameters<typeof shapeKey>[0]);
    if (codes.has(key)) continue;
    const { source_puzzle: puzzle, source_solution: solution } = row;
    codes.set(key, Object.freeze({ puzzle, solution, answer: JSON.stringify(answer) }));
  }
  return codes;
}
