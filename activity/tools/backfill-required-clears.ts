#!/usr/bin/env bun
/**
 * Gives every archived puzzle a machine-readable version of the goal it already
 * states in prose — but only where the shipped answer agrees.
 *
 *     bun run tools/backfill-required-clears.ts            # report only
 *     bun run tools/backfill-required-clears.ts --write    # and save
 *
 * Additive, and deliberately not part of `bun run puzzles`. That command
 * rebuilds `data/puzzles.json` wholesale from the club's sheet and would have
 * to be re-run with the sheet to hand; this reads the tracked file, adds one
 * key, and writes it back, so the diff is exactly the new field and a reviewer
 * can see every requirement that is about to become a rule.
 *
 * **The gate is the whole design.** The requirement comes from the author's own
 * sentence, never from the answer key — deriving it from the solution would
 * bake in whatever that line happens to do, including its incidental clears,
 * and would make the archive's own answers definitionally correct. But it is
 * *checked* against the answer key, and a puzzle whose shipped solution does
 * not satisfy its stated goal ships no requirement at all. Those are the ones a
 * human has to rule on, and they are printed rather than guessed at.
 *
 * A puzzle that ends with `[]` is not an oversight. It means this tool read the
 * goal and is enforcing nothing — either the sentence names something a count
 * cannot hold ("3TSD in one combo", "TST without moving left or right") or the
 * gate refused it. Absent, by contrast, means nobody has looked yet.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseGoalLoosely } from "../shared/goal";
import { clearShortfall, type ClearName, type ClearRequirement, type Puzzle } from "../shared/puzzle";

const ARCHIVE = "data/puzzles.json";
const ANSWERS = "data/solutions.json";

type Outcome = "enforced" | "uncountable" | "gated";

interface Verdict {
  readonly id: number;
  readonly goal: string;
  readonly outcome: Outcome;
  readonly required: ClearRequirement[];
  readonly note: string;
}

function say(entries: readonly ClearRequirement[]): string {
  return entries.length === 0 ? "—" : entries.map((e) => `${e.count}x ${e.clear}`).join(", ");
}

function main(): void {
  const write = process.argv.includes("--write");
  const puzzles: Puzzle[] = JSON.parse(readFileSync(ARCHIVE, "utf8")).puzzles;

  if (!existsSync(ANSWERS)) {
    // Without the answers there is no gate, and an ungated backfill is the one
    // outcome this tool exists to prevent.
    console.error(
      `${ANSWERS} is not here, so no requirement can be checked against the answer it\n` +
        "is supposed to describe. Run `bun run puzzles` against the club's sheet first.",
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
    const spec = parseGoalLoosely(puzzle.goal);
    if (!spec || spec.clears.length === 0) {
      return { id: puzzle.id, goal: puzzle.goal, outcome: "uncountable", required: [], note: "no counts in the sentence" };
    }
    const made = answers.get(puzzle.id);
    if (!made) {
      return { id: puzzle.id, goal: puzzle.goal, outcome: "gated", required: [], note: "no reference solution on file" };
    }
    const short = clearShortfall(made, spec.clears);
    if (short.length > 0) {
      return {
        id: puzzle.id,
        goal: puzzle.goal,
        outcome: "gated",
        required: [],
        note: `answer makes ${say(made.map((c) => ({ clear: c, count: 1 })))}, short ${say(short)}`,
      };
    }
    return { id: puzzle.id, goal: puzzle.goal, outcome: "enforced", required: [...spec.clears], note: "" };
  });

  const by = (outcome: Outcome) => verdicts.filter((v) => v.outcome === outcome);

  console.log(`${ARCHIVE}: ${puzzles.length} puzzles`);
  console.log(`  enforced    ${by("enforced").length}`);
  console.log(`  uncountable ${by("uncountable").length}   (goal names nothing a count can hold)`);
  console.log(`  gated       ${by("gated").length}   (the shipped answer does not satisfy the stated goal)`);

  if (by("gated").length > 0) {
    console.log("\nGATED — these ship attack-only, exactly as they are today.");
    console.log("A human has to say whether the wording or the engine's naming is wrong:\n");
    for (const v of by("gated")) {
      console.log(`  #${v.id}  ${JSON.stringify(v.goal)}`);
      console.log(`        ${v.note}`);
    }
  }

  console.log("\nUNCOUNTABLE — left as prose, enforcing nothing:\n");
  for (const v of by("uncountable")) console.log(`  #${v.id}  ${JSON.stringify(v.goal)}`);

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
