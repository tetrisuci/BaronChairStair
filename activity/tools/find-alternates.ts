#!/usr/bin/env bun
/**
 * Searches puzzles for solutions their author did not write down.
 *
 *     bun run tools/find-alternates.ts                     # the whole archive
 *     bun run tools/find-alternates.ts --only 15,37,123    # just these
 *     bun run tools/find-alternates.ts --seconds 60        # look harder
 *     bun run tools/find-alternates.ts --write             # save what it finds
 *
 * Two things a maker wants from this, and they are not the same claim.
 *
 * **"My condition is loose."** A puzzle with alternates can be finished by a
 * line its author did not intend, which is usually a condition that says less
 * than the sentence next to it. That is a *finding*, and one alternate is
 * enough to make it.
 *
 * **"My condition is tight."** That is a *proof*, and only an exhausted search
 * can offer it. Every other way of stopping means the search ran out of budget
 * with ground left unexplored, and the report says which — because the failure
 * that matters here is a maker reading a truncated search as a clean bill of
 * health. And an exhausted search that found *nothing* is a third answer again —
 * the puzzle cannot be finished at all — reported loudly rather than counted
 * among the tight ones.
 *
 * Exhausting is rarer than "short puzzles finish" suggests: measured at a
 * twenty-second budget, every puzzle of three pieces or fewer exhausts,
 * four-piece 5 times in 8, six-piece 1 in 10, and nothing of seven or more. It
 * is also scoped to the default soft drop — see
 * `RoutePlanner.restingPlacements`.
 *
 * `--write` files what it finds as `enumerated` rows, which are credited to
 * nobody: they seed the archive with what is already known so that the first
 * player to *play* one of these lines is told it is known, rather than being
 * paid for rediscovering something a machine had already listed.
 */

import { existsSync, readFileSync } from "node:fs";
import { contentHash } from "../server/archive-rows";
import { Store } from "../server/db";
import { shapeKey } from "../server/puzzles";
import { SOLUTION_KEY_VERSION, solutionFingerprint, solutionKey } from "../shared/solution-key";
import { searchSolutions, type SearchReport } from "../shared/tetris/enumerate";
import { pieceBudget, solvesPuzzle, type Puzzle, type SolutionStep } from "../shared/puzzle";

const ARCHIVE = "data/puzzles.json";
const ANSWERS = "data/solutions.json";

interface Options {
  readonly only: ReadonlySet<number> | null;
  readonly seconds: number;
  readonly maxLines: number;
  readonly write: boolean;
  readonly databasePath: string;
}

function numberAfter(flag: string, fallback: number): number {
  const at = process.argv.indexOf(flag);
  if (at < 0) return fallback;
  const value = Number(process.argv[at + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readOptions(): Options {
  const at = process.argv.indexOf("--only");
  const only =
    at < 0
      ? null
      : new Set(
          (process.argv[at + 1] ?? "")
            .split(",")
            .map((piece) => Number(piece.trim()))
            .filter((id) => Number.isFinite(id)),
        );
  return {
    only: only && only.size > 0 ? only : null,
    seconds: numberAfter("--seconds", 20),
    maxLines: numberAfter("--max", 25),
    write: process.argv.includes("--write"),
    databasePath: process.env.DATABASE_PATH ?? "data/puzzles.sqlite",
  };
}

/** The archive, with the untracked answer key folded in where it exists. */
function loadPuzzles(): Puzzle[] {
  const puzzles: Puzzle[] = JSON.parse(readFileSync(ARCHIVE, "utf8")).puzzles;
  if (!existsSync(ANSWERS)) return puzzles;

  const answers = new Map<number, readonly SolutionStep[]>(
    (JSON.parse(readFileSync(ANSWERS, "utf8")).solutions as Puzzle[]).map((entry) => [
      entry.id,
      entry.solution ?? [],
    ]),
  );
  return puzzles.map((puzzle) => ({ ...puzzle, solution: answers.get(puzzle.id) }));
}

export interface Verdict {
  readonly puzzle: Puzzle;
  readonly report: SearchReport;
  /** Lines that are not the author's own. */
  readonly alternates: SearchReport["lines"];
  /** Whether the search re-found the answer on file, when there is one. */
  readonly refFound: boolean | null;
}

/**
 * Splits a search's lines into the author's own and everything else.
 *
 * The one decision in this tool that can be wrong in a way nobody would notice:
 * mistake the reference for an alternate and every puzzle looks broken;
 * mistake an alternate for the reference and a real finding disappears.
 * Exported so it can be tested without running a search.
 */
export function judge(puzzle: Puzzle, report: SearchReport): Verdict {
  const reference = puzzle.solution && puzzle.solution.length > 0 ? solutionKey(puzzle.solution) : null;
  const alternates = report.lines.filter((line) => solutionKey(line.placements) !== reference);
  return {
    puzzle,
    report,
    alternates,
    refFound: reference === null ? null : alternates.length !== report.lines.length,
  };
}

/**
 * What a search actually established about a puzzle.
 *
 * `unsolvable` is its own answer and not a flavour of `tight`. A search that
 * exhausted the position and found **no** line has proved the puzzle cannot be
 * finished at all — and counting that as "provably tight, nothing else exists"
 * hands a maker a clean bill of health for a puzzle nobody can solve, which is
 * the worst thing this tool can say. It is reachable: a goal naming a clear the
 * board cannot make produces exactly this, and `requiredClears` now ships on
 * 112 of 138 puzzles.
 */
export type Verdict_ =
  | "unsolvable"
  | "tight"
  | "loose"
  | "incomplete";

export function verdictOf(verdict: Verdict): Verdict_ {
  if (verdict.report.stoppedBy !== "exhausted") return "incomplete";
  if (verdict.report.lines.length === 0) return "unsolvable";
  return verdict.alternates.length > 0 ? "loose" : "tight";
}

/**
 * The one line that matters per puzzle.
 *
 * `exhausted` with nothing else found is the only row that says a puzzle is
 * sound; everything else is either a finding or an admission that the search
 * stopped early, and both are spelled out rather than left to be inferred from
 * a count of zero.
 */
/**
 * A goal on one line.
 *
 * Three of the archive's goals carry a line break — an author's parenthetical
 * about the setup, and in one case a 74-piece queue pasted underneath — and
 * this report is a line per puzzle that people scan and grep. Printed raw they
 * split a row in two, and the half carrying the warning marker arrives with no
 * puzzle number in front of it.
 */
function oneLine(goal: string): string {
  return goal.replace(/\s+/g, " ").trim();
}

function describe(verdict: Verdict): string {
  const { puzzle, report, alternates, refFound } = verdict;
  const complete = report.stoppedBy === "exhausted";
  const headline = {
    unsolvable: "NOBODY CAN SOLVE",
    tight: "only the line   ",
    loose: `${String(alternates.length).padStart(3)} alternate${alternates.length === 1 ? "" : "s"}`.padEnd(16),
    incomplete: "none (partial)  ",
  }[verdictOf(verdict)];
  const note = complete ? "exhausted" : `stopped: ${report.stoppedBy}`;
  const missing = refFound === false ? "  [!] did not re-find the answer on file" : "";
  return (
    `#${String(puzzle.id).padStart(3)} ${String(pieceBudget(puzzle)).padStart(2)}p  ` +
    `${headline}  ${note.padEnd(16)} ` +
    `${String(report.nodes).padStart(7)} nodes ${String(Math.round(report.millis)).padStart(6)}ms` +
    `  ${oneLine(puzzle.goal)}${missing}`
  );
}

function fileLines(store: Store, verdict: Verdict): number {
  let filed = 0;
  for (const line of verdict.report.lines) {
    const { discovered } = store.recordSolution({
      puzzleId: verdict.puzzle.id,
      canonicalKey: solutionFingerprint(line.placements, { attack: line.attack, clears: line.clears }),
      keyVersion: SOLUTION_KEY_VERSION,
      placements: line.placements,
      // An enumerated line has no keystrokes behind it — it was found by
      // searching, not by playing — so there is nothing to re-verify it from.
      events: null,
      handling: null,
      attack: line.attack,
      targetAttack: verdict.puzzle.targetAttack,
      clears: line.clears,
      solvedStrict: solvesPuzzle(line.attack, line.clears, verdict.puzzle),
      source: "enumerated",
      foundBy: null,
      guildId: null,
      contentHash: contentHash(verdict.puzzle),
      puzzleShape: shapeKey(verdict.puzzle),
    });
    if (discovered) filed++;
  }
  return filed;
}

function main(): void {
  const options = readOptions();
  const puzzles = loadPuzzles()
    .filter((puzzle) => !options.only || options.only.has(puzzle.id))
    .sort((a, b) => pieceBudget(a) - pieceBudget(b));

  if (puzzles.length === 0) {
    console.error("No puzzles matched.");
    process.exitCode = 1;
    return;
  }
  if (!existsSync(ANSWERS)) {
    console.warn(
      `${ANSWERS} is not here, so every line found is reported as an alternate —\n` +
        "there is no answer on file to tell the author's own line apart from the rest.\n",
    );
  }

  const store = options.write ? new Store(options.databasePath) : null;
  const verdicts: Verdict[] = [];
  let filed = 0;

  try {
    for (const puzzle of puzzles) {
      const report = searchSolutions(puzzle, {
        maxLines: options.maxLines,
        maxMillis: options.seconds * 1000,
        maxNodes: Number.MAX_SAFE_INTEGER,
      });
      const verdict = judge(puzzle, report);
      verdicts.push(verdict);
      console.log(describe(verdict));
      if (store) filed += fileLines(store, verdict);
    }
  } finally {
    store?.close();
  }

  const exhausted = verdicts.filter((v) => v.report.stoppedBy === "exhausted");
  const loose = verdicts.filter((v) => verdictOf(v) === "loose");
  const tight = verdicts.filter((v) => verdictOf(v) === "tight");
  const unsolvable = verdicts.filter((v) => verdictOf(v) === "unsolvable");
  const lost = verdicts.filter((v) => v.refFound === false);

  const many = (count: number, one: string, more: string): string =>
    `${count} ${count === 1 ? one : more}`;

  console.log(`\n${many(verdicts.length, "puzzle", "puzzles")} searched.`);
  console.log(`  ${many(loose.length, "has", "have")} a line the author did not write down`);
  console.log(
    `  ${many(tight.length, "is", "are")} provably tight — searched to exhaustion, ` +
      "nothing else solves it",
  );
  if (unsolvable.length > 0) {
    // Louder than a finding, because it is not a fact about the condition — it
    // is a puzzle nobody can finish, and it was sitting in the "tight" count.
    console.log(
      `\n  [!!] ${many(unsolvable.length, "puzzle", "puzzles")} CANNOT BE SOLVED AT ALL: ` +
        `${unsolvable.map((v) => `#${v.puzzle.id}`).join(", ")}`,
    );
    console.log("       Searched to exhaustion and no line meets the goal.");
  }
  console.log(
    `  ${many(verdicts.length - exhausted.length, "ran", "ran")} out of budget, ` +
      "and proves nothing either way",
  );
  if (lost.length > 0) {
    // The search could not re-find an answer the archive says is real. That is
    // a bug in the search, not a fact about the puzzle, and it is louder than
    // any finding here because every other number depends on it.
    console.log(
      `\n  [!] ${lost.length} searches never re-found the shipped answer: ` +
        `${lost.map((v) => `#${v.puzzle.id}`).join(", ")}`,
    );
    console.log("      Every one of those was budget-limited, or the search is wrong.");
  }
  if (loose.length > 0) {
    console.log("\nPuzzles with alternate solutions, most first:");
    for (const verdict of [...loose].sort((a, b) => b.alternates.length - a.alternates.length)) {
      console.log(
        `  #${String(verdict.puzzle.id).padStart(3)}  ${String(verdict.alternates.length).padStart(3)} ` +
          `alternate${verdict.alternates.length === 1 ? "" : "s"}  ${oneLine(verdict.puzzle.goal)}`,
      );
    }
  }
  if (store) console.log(`\n${filed} new solutions filed.`);
  else console.log("\nNothing written. Re-run with --write to file these.");
}

// Only when this file is what was run. Every other tool here calls `main()`
// outright, which is fine while nothing imports them — but `judge` is the one
// decision in this tool that can be wrong without anybody noticing, and a test
// that imports it to check that would otherwise start a full archive search on
// the import.
if (import.meta.main) main();
