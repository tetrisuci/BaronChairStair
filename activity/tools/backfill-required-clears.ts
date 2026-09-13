#!/usr/bin/env bun
/**
 * Gives every archived puzzle the clear requirement its own answer demonstrates.
 *
 *     bun run tools/backfill-required-clears.ts            # report only
 *     bun run tools/backfill-required-clears.ts --write    # and save
 *
 * Additive, and deliberately not part of `bun run puzzles`. That command
 * rebuilds `data/puzzles.json` wholesale from the club's sheet and would have to
 * be re-run with the sheet to hand; this reads the tracked file, sets one key,
 * and writes it back, so the diff is exactly the field a reviewer needs to see.
 *
 * **The answer is the source.** The requirement is read off the maker's own
 * recorded solution, replayed — never off the sentence they wrote beside it. The
 * club settled this after the engine and the puzzle makers were found to
 * disagree about naming: the engine follows the guideline rule, where a T-spin
 * with fewer than two front corners is a *mini* unless it entered on the fin/TST
 * kick, so a polymer setup (Neo, Iso) locks as `tsmini` while its author calls
 * it a double. Both are describing the same placement. The replay settles it.
 *
 * The title and the goal are left exactly as the maker wrote them. This tool
 * changes what is *enforced*, never what is displayed — and it still prints
 * every puzzle where the two disagree, because that list is what the makers
 * asked for and is the only way anybody notices a genuine miscount.
 *
 * The scheme this replaced parsed the prose and, whenever the answer disagreed,
 * froze no requirement at all. It was right that the two can disagree and wrong
 * about which one settles it: 25 puzzles ended up enforcing nothing — three
 * because their answer disagreed, twenty-two because no parser could read their
 * wording. All of them are enforceable as played.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseGoalLoosely } from "../shared/goal";
import {
  clearShortfall,
  requirementFromSolution,
  type ClearName,
  type ClearRequirement,
  type Puzzle,
} from "../shared/puzzle";

const ARCHIVE = "data/puzzles.json";
const ANSWERS = "data/solutions.json";

/** `enforced` carries a requirement; the other two carry none, for two reasons. */
type Outcome = "enforced" | "clearless" | "unanswered";

interface Verdict {
  readonly id: number;
  readonly goal: string;
  readonly outcome: Outcome;
  readonly required: ClearRequirement[];
  /** Set only when the maker's sentence and their answer name different clears. */
  readonly disagreement: string | null;
}

function say(entries: readonly ClearRequirement[]): string {
  return entries.length === 0 ? "—" : entries.map((e) => `${e.count}x ${e.clear}`).join(", ");
}

/**
 * How the stated goal differs from what the answer does — or null when it does
 * not. Reporting only: nothing here decides what is enforced.
 */
function disagreementOf(goal: string, made: readonly ClearName[]): string | null {
  const spec = parseGoalLoosely(goal);
  if (!spec || spec.clears.length === 0) return null; // unreadable prose is not a disagreement
  const short = clearShortfall(made, spec.clears);
  if (short.length === 0) return null;
  return `goal asks ${say(spec.clears)}; answer makes ${say(
    requirementFromSolution(made.map((clear) => ({ clear }))),
  )} (short ${say(short)})`;
}

function main(): void {
  const write = process.argv.includes("--write");
  const puzzles: Puzzle[] = JSON.parse(readFileSync(ARCHIVE, "utf8")).puzzles;

  if (!existsSync(ANSWERS)) {
    // The answers are now the *source* of every requirement, not merely the gate
    // on one. Without them this tool has nothing to derive from at all.
    console.error(
      `${ANSWERS} is not here, and it is what every requirement is now read from.\n` +
        "Run `bun run puzzles` against the club's sheet first.",
    );
    process.exitCode = 1;
    return;
  }
  const answers = new Map<number, ClearName[]>(
    (JSON.parse(readFileSync(ANSWERS, "utf8")).solutions as Puzzle[]).map((entry) => [
      entry.id,
      (entry.solution ?? []).flatMap((step) => (step.clear ? [step.clear] : [])),
    ]),
  );

  const verdicts: Verdict[] = puzzles.map((puzzle) => {
    const made = answers.get(puzzle.id);
    if (!made) {
      return { id: puzzle.id, goal: puzzle.goal, outcome: "unanswered", required: [], disagreement: null };
    }
    const required = requirementFromSolution(made.map((clear) => ({ clear })), puzzle.id);
    const disagreement = disagreementOf(puzzle.goal, made);
    if (required.length === 0) {
      return { id: puzzle.id, goal: puzzle.goal, outcome: "clearless", required: [], disagreement };
    }
    return { id: puzzle.id, goal: puzzle.goal, outcome: "enforced", required, disagreement };
  });

  const by = (outcome: Outcome) => verdicts.filter((v) => v.outcome === outcome);
  const disagreeing = verdicts.filter((v) => v.disagreement !== null);

  console.log(`${ARCHIVE}: ${puzzles.length} puzzles`);
  console.log(`  enforced    ${by("enforced").length}   (requirement read off the answer)`);
  console.log(`  clearless   ${by("clearless").length}   (the answer clears nothing to require)`);
  console.log(`  unanswered  ${by("unanswered").length}   (no reference solution on file)`);

  if (disagreeing.length > 0) {
    console.log(
      `\nWORDING vs PLAY (${disagreeing.length}) — enforced as played, and worth a maker's eye.`,
    );
    console.log("Usually the engine's mini naming; sometimes a genuine miscount:\n");
    for (const v of disagreeing) {
      console.log(`  #${v.id}  ${JSON.stringify(v.goal)}`);
      console.log(`        ${v.disagreement}`);
    }
  }

  if (!write) {
    console.log("\nReport only. Pass --write to save.");
    return;
  }

  const updated = puzzles.map((puzzle) => {
    const verdict = verdicts.find((v) => v.id === puzzle.id)!;
    return { ...puzzle, requiredClears: verdict.required };
  });
  writeFileSync(ARCHIVE, `${JSON.stringify({ puzzles: updated }, null, 1)}\n`);
  console.log(`\nWrote ${ARCHIVE}.`);
}

main();
