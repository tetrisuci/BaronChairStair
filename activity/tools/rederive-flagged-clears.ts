#!/usr/bin/env bun
/**
 * Re-derives the stored answer and requirement for the puzzles in
 * `PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES`.
 *
 *     bun run rederive-clears            # report only
 *     bun run rederive-clears --write    # and save
 *
 * **This is the second half of adding an id to that set.** The flag changes how
 * a requirement is *derived*; it does not change any requirement already
 * written down, and three files have one written down. Until this runs, the
 * player still meets the old rule — which is exactly what happened to #123
 * "style": the flag shipped, every test passed, and the puzzle went on asking
 * for two spins.
 *
 * ## Why a replay, and not the backfill
 *
 * `backfill-required-clears.ts` derives from the clear *names* already stored
 * beside each answer, which is right for its job and useless for this one: the
 * names are what changed. Style's zero-line spin is recorded as `null` in every
 * file, because it was named `null` when those files were written, so deriving
 * from them reproduces the same two spins however many times it is run.
 *
 * The blueprint codes are the one thing that did not change. `source_puzzle`
 * and `source_solution` are on every archive row, so replaying them through the
 * current engine is the only way to learn what the answer does *now* — and it
 * needs no spreadsheet, which matters, because the two commands that rebuild
 * from the sheet are both decisions somebody else makes (`activity/DEPLOY.md`,
 * and CLAUDE.md's "Decisions that are not yours to make").
 *
 * ## Why all three files
 *
 * They are read by different boxes, and correcting fewer than all of them is
 * worse than correcting none:
 *
 * - **`data/puzzles.json`** is tracked and holds the requirement a player is
 *   actually shown and judged against. #123 is unpublished in the archive, so
 *   no archive row is ever served for it — this file is the whole of what the
 *   game says.
 * - **`data/archive/puzzles.sqlite`** is tracked and holds the *answer*. On a
 *   deploy box `data/solutions.json` does not exist, so `withFallbackSolutions`
 *   takes the answer from here — and then `withoutUnmeetableClears` compares
 *   the requirement against it. Leave this stale and the gate sees a
 *   three-spin requirement against a two-spin answer, blanks it, and serves the
 *   puzzle on attack alone. That is a worse outcome than the bug being fixed.
 * - **`data/solutions.json`** is untracked and is this box's own copy, merged
 *   ahead of the archive by `withSolutions`. Correcting it keeps a dev box
 *   agreeing with production instead of quietly disagreeing.
 *
 * ## What it refuses to do
 *
 * Replaying an old blueprint through a newer engine could in principle produce
 * a different *answer*, not merely different names for it. This tool will not
 * write that: every rebuilt step must match the stored one in piece, cells and
 * attack, and the puzzle's target must match too. Anything else and it reports
 * the drift and writes nothing. The only edit it is willing to make is a
 * rename.
 *
 * It also refuses to reformat. Before writing either JSON file it checks that
 * re-serialising the file's *current* contents reproduces the bytes on disk; if
 * not, the file was written by something with different formatting and a
 * rewrite here would bury one field's change in a whole-file diff.
 *
 * ## The order it writes in
 *
 * Answers first, requirements last. A crash can still land between two writes —
 * a full disk, a SIGINT, a lock this connection waited out and lost — and what
 * must never survive one is a corrected requirement beside an answer that cannot
 * meet it: `withoutUnmeetableClears` blanks that puzzle's requirement entirely
 * and serves it on attack alone, which is worse than the bug being fixed. The
 * archive, then `data/solutions.json`, then `data/puzzles.json` makes every
 * prefix of the sequence safe. Every payload is computed, and every refusal
 * raised, before the first byte lands.
 *
 * ## What makes it write
 *
 * That some store disagrees with the replay — never that a clear got renamed.
 * The two are independent: a requirement moves because an id joined the flag
 * set, not because a name did. A puzzle whose archive answer is already current
 * — which is what any re-sync of the tracked archive leaves behind — has nothing
 * to rename and everything still to correct.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { archiveEntry, upsertArchive, type ArchiveEntry } from "../server/archive-rows";
import {
  PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES,
  requirementFromSolution,
  type ClearRequirement,
  type Puzzle,
  type SolutionStep,
} from "../shared/puzzle";
import { buildPuzzle } from "./decode-archive";

const PROMPTS = "data/puzzles.json";
const ANSWERS = "data/solutions.json";
const TRACKED = "data/archive/puzzles.sqlite";

/**
 * How long to wait for another writer before giving up.
 *
 * The activity server opens this database **read-only** (`archive-solutions.ts`,
 * via `config.paths.trackedArchive`), so it is never the contention here. The
 * writers that matter are `sync-archive` and `publish-archive` pointed at
 * `--db data/archive/puzzles.sqlite`, and their writes are multi-statement
 * transactions — which is exactly what is worth waiting out rather than failing
 * against.
 */
const BUSY_TIMEOUT_MS = 10_000;

/** An answer entry as `build-puzzles.ts` writes it into `data/solutions.json`. */
interface AnswerEntry {
  readonly id: number;
  readonly solution?: readonly SolutionStep[];
  readonly source?: Puzzle["source"];
}

export interface Rederived {
  readonly id: number;
  readonly title: string;
  readonly solution: readonly SolutionStep[];
  readonly required: readonly ClearRequirement[];
  /** One line per step whose clear changed name. */
  readonly renames: readonly string[];
}

/**
 * Which stores disagree with the replay.
 *
 * Checked one by one because they go stale one by one: a re-sync can modernise
 * the archive's *answer* while both requirement columns keep the value they were
 * frozen with, and adding an id to the flag set moves every requirement while no
 * answer changes at all.
 */
export interface Staleness {
  readonly archiveAnswer: boolean;
  readonly archiveClears: boolean;
  readonly promptClears: boolean;
  /** Always false where `data/solutions.json` is absent, which is every deploy box. */
  readonly localAnswer: boolean;
}

export function isStale(stale: Staleness): boolean {
  return stale.archiveAnswer || stale.archiveClears || stale.promptClears || stale.localAnswer;
}

interface Plan {
  readonly result: Rederived;
  readonly stale: Staleness;
}

/**
 * Everything about a placement except what its clear is called.
 *
 * The comparison that makes a rewrite safe: if this is equal for every step
 * then the answer is the same answer and only its vocabulary moved.
 */
function placementOf(step: SolutionStep): string {
  return JSON.stringify([step.piece, step.cells, step.attack]);
}

/**
 * How a replayed answer differs from the stored one in substance — or null when
 * it does not. Names are deliberately not compared; renaming is the point.
 */
export function driftBetween(
  stored: readonly SolutionStep[],
  rebuilt: readonly SolutionStep[],
): string | null {
  if (stored.length !== rebuilt.length) {
    return `${stored.length} steps on file, ${rebuilt.length} when replayed`;
  }
  for (const [index, step] of stored.entries()) {
    const against = rebuilt[index]!;
    if (placementOf(step) !== placementOf(against)) {
      return (
        `step ${index + 1} is not the same placement — ` +
        `${placementOf(step)} on file, ${placementOf(against)} when replayed`
      );
    }
  }
  return null;
}

/** One line per step whose clear changed name, for the report and the decision. */
export function renamesBetween(
  stored: readonly SolutionStep[],
  rebuilt: readonly SolutionStep[],
): string[] {
  const lines: string[] = [];
  for (const [index, step] of stored.entries()) {
    const now = rebuilt[index]?.clear ?? null;
    if (step.clear !== now) {
      lines.push(
        `step ${index + 1} ${step.piece}: ${JSON.stringify(step.clear ?? null)} -> ${JSON.stringify(now)}`,
      );
    }
  }
  return lines;
}

/**
 * Replays one archived puzzle's own blueprint and reports what its answer is
 * called now. Throws on drift rather than returning it: a puzzle whose answer
 * moved is not a rename, and the caller has nothing useful to do with it.
 */
export function rederive(entry: ArchiveEntry): Rederived {
  const { id, title, source, solution: stored, targetAttack } = entry.puzzle;
  if (!source?.puzzle || !source.solution) {
    throw new Error(`#${id} has no blueprint codes on its archive row, so it cannot be replayed`);
  }

  const built = buildPuzzle(id, [String(id), source.puzzle, source.solution], undefined);
  const rebuilt = built.solution ?? [];
  const before = stored ?? [];

  const drift = driftBetween(before, rebuilt);
  if (drift) throw new Error(`#${id} replays to a different answer — ${drift}`);
  if (built.targetAttack !== targetAttack) {
    throw new Error(
      `#${id} replays to ${built.targetAttack} attack, and its row says ${targetAttack}`,
    );
  }

  return {
    id,
    title,
    solution: rebuilt,
    required: requirementFromSolution(rebuilt, id),
    renames: renamesBetween(before, rebuilt),
  };
}

function say(entries: readonly ClearRequirement[]): string {
  return entries.length === 0 ? "—" : entries.map((e) => `${e.count}x ${e.clear}`).join(", ");
}

/**
 * The bytes one JSON file should end up holding — computed and checked, but
 * deliberately *not* written.
 *
 * Split from the writing so that every refusal happens before the first byte
 * lands anywhere. The order the writes go out in is the safety argument (see the
 * header), and it is worth nothing if the second file can still refuse half way
 * through the sequence.
 */
export function plannedRewrite<T>(
  path: string,
  wrap: (rows: T[]) => unknown,
  rows: T[],
  updated: T[],
): string {
  const serialize = (list: T[]) => `${JSON.stringify(wrap(list), null, 1)}\n`;
  if (serialize(rows) !== readFileSync(path, "utf8")) {
    throw new Error(
      `${path} is not formatted the way this tool writes it, so a rewrite would reformat the ` +
        "whole file and hide the one field that changed. Left untouched.",
    );
  }
  return serialize(updated);
}

/**
 * Whether two requirements say the same thing, whatever order they say it in.
 *
 * `requirementFromSolution` emits first-appearance order, and a value stored
 * before this tool existed need not match it. Comparing serialised arrays
 * directly would call an identical requirement stale and rewrite three files to
 * no effect, on every run.
 */
function sameRequirement(
  a: readonly ClearRequirement[] = [],
  b: readonly ClearRequirement[] = [],
): boolean {
  const key = (list: readonly ClearRequirement[]) =>
    JSON.stringify([...list].map((entry) => [entry.clear, entry.count]).sort());
  return key(a) === key(b);
}

/** Just the clear names: the only half of a stored answer this tool may change. */
function clearNames(steps: readonly SolutionStep[] = []): (string | null)[] {
  return steps.map((step) => step.clear ?? null);
}

function main(): void {
  const write = process.argv.includes("--write");
  const flagged = [...PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES].sort((a, b) => a - b);

  console.log(
    `${flagged.length} puzzle${flagged.length === 1 ? "" : "s"} may require a spin that clears ` +
      `no lines: ${flagged.map((id) => `#${id}`).join(", ")}`,
  );

  if (!existsSync(TRACKED)) {
    console.error(`\n${TRACKED} is not here, and it is where the blueprint codes live.`);
    process.exitCode = 1;
    return;
  }

  // Both JSON stores are read up front, because how stale each one is forms part
  // of the decision to write at all — not merely part of the writing.
  const prompts = JSON.parse(readFileSync(PROMPTS, "utf8")).puzzles as Puzzle[];
  const hasAnswers = existsSync(ANSWERS);
  const answers = hasAnswers
    ? (JSON.parse(readFileSync(ANSWERS, "utf8")).solutions as AnswerEntry[])
    : [];

  // Read with no transaction open and nothing written: the replay is the slow
  // part, and `sync-archive.ts` keeps it outside the write lock for the same
  // reason — the server's next `recordRun` should not be waiting on us.
  // `readwrite` is named explicitly and `create` refused: bun:sqlite takes no
  // flags at all from `{ create: false }` on its own and throws SQLITE_MISUSE,
  // and a bare `new Database(path)` would happily conjure an empty archive if
  // the real one were ever missing.
  const db = new Database(TRACKED, { readwrite: true, create: false });
  const plans: Plan[] = [];
  const problems: string[] = [];
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    for (const id of flagged) {
      const entry = archiveEntry(db, id);
      if (!entry) {
        problems.push(`#${id} is in the set but not in the archive`);
        continue;
      }
      let result: Rederived;
      try {
        result = rederive(entry);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      const prompt = prompts.find((puzzle) => puzzle.id === id);
      const local = answers.find((answer) => answer.id === id);
      plans.push({
        result,
        stale: {
          archiveAnswer: result.renames.length > 0,
          archiveClears: !sameRequirement(entry.puzzle.requiredClears, result.required),
          promptClears:
            prompt !== undefined && !sameRequirement(prompt.requiredClears, result.required),
          localAnswer:
            local !== undefined &&
            JSON.stringify(clearNames(local.solution)) !==
              JSON.stringify(clearNames(result.solution)),
        },
      });
    }

    for (const { result, stale } of plans) {
      console.log(`\n#${result.id} ${JSON.stringify(result.title)}`);
      if (result.renames.length === 0) {
        console.log("  answer already names every clear as the engine does now");
      }
      for (const line of result.renames) console.log(`  ${line}`);
      console.log(`  requirement: ${say(result.required)}`);
      const behind = [
        stale.archiveAnswer ? "the archive's answer" : null,
        stale.archiveClears ? "the archive's requirement" : null,
        stale.promptClears ? PROMPTS : null,
        stale.localAnswer ? ANSWERS : null,
      ].filter((entry): entry is string => entry !== null);
      console.log(behind.length ? `  behind: ${behind.join(", ")}` : "  every store agrees");
    }

    for (const problem of problems) console.error(`\n${problem}`);

    // Gated on a store disagreeing with the replay, never on a clear having been
    // renamed. Gating on the rename meant a flagged puzzle whose answer was
    // already current — the state any re-sync of the tracked archive leaves
    // behind — was skipped with "Nothing to re-derive", one line after this loop
    // printed the very requirement it was declining to write.
    const changed = plans.filter((plan) => isStale(plan.stale)).map((plan) => plan.result);
    if (changed.length === 0) {
      console.log(`\nNothing to re-derive.${problems.length > 0 ? " (See above.)" : ""}`);
      if (problems.length > 0) process.exitCode = 1;
      return;
    }

    if (!write) {
      console.log("\nReport only. Pass --write to save.");
      if (problems.length > 0) process.exitCode = 1;
      return;
    }

    // Refuse to half-apply. A corrected requirement beside an uncorrected answer
    // is the state `withoutUnmeetableClears` blanks, so a partial write would
    // turn a wrong requirement into no requirement.
    if (problems.length > 0) {
      console.error("\nWrote nothing: one of the flagged puzzles could not be re-derived.");
      process.exitCode = 1;
      return;
    }

    const byId = new Map(changed.map((result) => [result.id, result]));

    const missing = [...byId.keys()].filter((id) => !prompts.some((p) => p.id === id));
    if (missing.length > 0) {
      console.error(`\nWrote nothing: ${PROMPTS} has no entry for ${missing.join(", ")}.`);
      process.exitCode = 1;
      return;
    }

    // Both payloads computed, and both able to refuse, before anything is
    // written. `plannedRewrite` throws on a file it would reformat; a throw here
    // costs nothing, while the same throw between two writes would strand the
    // stores in the one state this tool exists to prevent.
    const promptBytes = plannedRewrite(
      PROMPTS,
      (list: Puzzle[]) => ({ puzzles: list }),
      prompts,
      prompts.map((puzzle) => {
        const result = byId.get(puzzle.id);
        return result ? { ...puzzle, requiredClears: [...result.required] } : puzzle;
      }),
    );
    const answerBytes = hasAnswers
      ? plannedRewrite(
          ANSWERS,
          (list: AnswerEntry[]) => ({ solutions: list }),
          answers,
          answers.map((entry) => {
            const result = byId.get(entry.id);
            return result ? { ...entry, solution: [...result.solution] } : entry;
          }),
        )
      : null;

    /*
     * ANSWERS BEFORE REQUIREMENTS. This order is the whole safety argument, and
     * it is the opposite of the order this tool shipped with.
     *
     * A crash can still land between two writes. What must not survive one is a
     * corrected requirement beside an answer that cannot meet it: the gate blanks
     * that puzzle's requirement entirely and serves it on attack alone — worse
     * than the bug. So every prefix here is safe. Nothing written: the status
     * quo. Archive only: a better answer under a stale requirement that answer
     * still satisfies. Archive and solutions.json: the same, on a dev box too.
     * The requirement — the only write that can make a store demand *more* —
     * goes last, when both answers can already meet it.
     *
     * The archive leads because `upsertArchive` re-derives `required_clears` from
     * the answer it writes, refreshes the content hash and records the change in
     * `archive_content_log`: it is the one store that cannot be left internally
     * inconsistent. Metadata comes off the row rather than the replay —
     * `buildPuzzle` with no sheet row would rename the puzzle "Puzzle 123" by
     * "unknown".
     */
    const now = Date.now();
    db.transaction(() => {
      for (const result of changed) {
        const entry = archiveEntry(db, result.id)!;
        upsertArchive(
          db,
          { ...entry.puzzle, solution: [...result.solution] },
          now,
          "rederive-clears",
        );
      }
    })();
    console.log(`\nWrote ${TRACKED}.`);

    if (answerBytes === null) {
      // Untracked and absent on every deploy box, so its absence is not a failure.
      console.log(`${ANSWERS} is not on this box, so there was none to correct.`);
    } else {
      writeFileSync(ANSWERS, answerBytes);
      console.log(`Wrote ${ANSWERS}.`);
    }

    writeFileSync(PROMPTS, promptBytes);
    console.log(`Wrote ${PROMPTS}.`);
  } finally {
    db.close();
  }
}

// Guarded, unlike its siblings, because this one's guards are worth testing and
// a test that imports it must not run it: importing `main()` unguarded would
// replay the archive and, with the right argv, write to it.
if (import.meta.main) main();
