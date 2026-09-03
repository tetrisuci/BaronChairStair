/**
 * The archive as the tests need it: prompts, plus the answers when they exist.
 *
 * `data/puzzles.json` no longer carries solutions — it is tracked, and a public
 * answer key beside the puzzles is an answer key for everybody. The build
 * writes them to `data/solutions.json`, which is not tracked, so a fresh
 * checkout has puzzles and no answers.
 *
 * Tests that only need a board or a queue are unaffected. Tests that need a
 * reference solution — the pipeline's own validation, and anything that builds
 * a solving log from one — should guard on {@link hasSolutions} and skip, so a
 * checkout without the club's archive reports "skipped" rather than "failed".
 */

import { existsSync, readFileSync } from "node:fs";
import type { Puzzle } from "../shared/puzzle";

const PUZZLES = "data/puzzles.json";
const SOLUTIONS = "data/solutions.json";

function load(): Puzzle[] {
  const puzzles: Puzzle[] = JSON.parse(readFileSync(PUZZLES, "utf8")).puzzles;
  if (!existsSync(SOLUTIONS)) return puzzles;
  const book = new Map<number, Pick<Puzzle, "solution" | "source">>(
    (JSON.parse(readFileSync(SOLUTIONS, "utf8")).solutions as Puzzle[]).map((entry) => [
      entry.id,
      { solution: entry.solution, source: entry.source },
    ]),
  );
  return puzzles.map((puzzle) => ({ ...puzzle, ...book.get(puzzle.id) }));
}

export const archive: Puzzle[] = load();

export const hasSolutions: boolean = archive.every((puzzle) => (puzzle.solution?.length ?? 0) > 0);

/** The reference solution, for a test that has already guarded on `hasSolutions`. */
export function solutionOf(puzzle: Puzzle) {
  const solution = puzzle.solution;
  if (!solution) throw new Error(`puzzle ${puzzle.id} has no solution loaded`);
  return solution;
}
