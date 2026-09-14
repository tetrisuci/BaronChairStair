/**
 * What a player is actually served for a puzzle whose goal asks for a spin that
 * clears no lines.
 *
 * This exists because the suite was green while the bug was live. The engine
 * was fixed to name a spin that clears nothing, the flag was added, seven tests
 * covered the derivation — and #123 "style" went on asking players for two
 * spins, because every requirement a player meets is *stored*, and no test
 * looked at what was stored. The derivation and the data can disagree, and only
 * the data is served.
 *
 * So these read the committed files rather than a fixture, and one of them
 * loads the archive the way a deploy box does: `data/solutions.json` is
 * untracked and absent there, so the answer arrives from the tracked archive
 * and `withoutUnmeetableClears` judges the requirement against it. That is the
 * combination that fails loudest if only half of a correction is applied — a
 * requirement corrected without its answer is not merely wrong, it is *blanked*,
 * and the puzzle is served on attack alone.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { trackedAnswers } from "../server/archive-solutions";
import { PuzzleArchive } from "../server/puzzles";
import {
  PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES,
  requirementFromSolution,
  type ClearRequirement,
  type Puzzle,
  type SolutionStep,
} from "../shared/puzzle";

const PROMPTS = resolve(import.meta.dir, "../data/puzzles.json");
const ARCHIVE = resolve(import.meta.dir, "../data/archive/puzzles.sqlite");

const SPINS = new Set(["spin", "spin (no lines)"]);

function served(): Puzzle[] {
  return JSON.parse(readFileSync(PROMPTS, "utf8")).puzzles as Puzzle[];
}

/** The answer as the tracked archive holds it — what a deploy box reveals and judges against. */
function storedAnswer(id: number): SolutionStep[] {
  const db = new Database(ARCHIVE, { readonly: true });
  try {
    const row = db
      .query<{ solution: string }, [number]>("SELECT solution FROM archive_puzzles WHERE id = ?")
      .get(id);
    expect(row).not.toBeNull();
    return JSON.parse(row!.solution) as SolutionStep[];
  } finally {
    db.close();
  }
}

const sorted = (entries: readonly ClearRequirement[]) =>
  [...entries].sort((a, b) => a.clear.localeCompare(b.clear));

describe("the stored requirement for a flagged puzzle", () => {
  for (const id of PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES) {
    test(`#${id} is served the requirement its own answer derives`, () => {
      // The check that was missing. `bun run rederive-clears --write` is what
      // makes this true; if somebody adds an id to the flag and stops there,
      // this is what tells them the job is half done.
      const puzzle = served().find((entry) => entry.id === id);
      expect(puzzle).toBeDefined();

      const derived = requirementFromSolution(storedAnswer(id), id);

      expect(sorted(puzzle!.requiredClears ?? [])).toEqual(sorted(derived));
    });

    test(`#${id}'s stored answer actually contains the spin that clears nothing`, () => {
      // Correcting the requirement without the answer is the harmful half: the
      // gate would see a shortfall and serve the puzzle with no requirement.
      expect(storedAnswer(id).some((step) => step.clear === "spin (no lines)")).toBe(true);
    });
  }

  test('#123 "style" asks for three spins, exactly one of which clears no lines', () => {
    // The creator's intent, stated as the club reads it: "Perform 3 Spins".
    const required = served().find((entry) => entry.id === 123)?.requiredClears ?? [];
    const total = required
      .filter((entry) => SPINS.has(entry.clear))
      .reduce((sum, entry) => sum + entry.count, 0);

    expect(total).toBe(3);
    expect(required.find((entry) => entry.clear === "spin (no lines)")?.count).toBe(1);
  });

  test("no puzzle outside the set requires one", () => {
    // 43 of the archive's answers happen to contain a spin that clears nothing.
    // Requiring them would have made every one of those puzzles stricter for a
    // spin its maker never asked for.
    const strays = served()
      .filter((puzzle) => !PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES.has(puzzle.id))
      .filter((puzzle) =>
        (puzzle.requiredClears ?? []).some((entry) => entry.clear === "spin (no lines)"),
      )
      .map((puzzle) => puzzle.id);

    expect(strays).toEqual([]);
  });
});

describe("as a deploy box loads it", () => {
  /** No `data/solutions.json` beside the puzzles, which is every production box. */
  function deployBox(): PuzzleArchive {
    const directory = mkdtempSync(join(tmpdir(), "flagged-spins-"));
    const path = join(directory, "puzzles.json");
    copyFileSync(PROMPTS, path);
    return PuzzleArchive.load(path, {}, [], [], trackedAnswers(ARCHIVE));
  }

  test("takes the flagged puzzle's answer from the tracked archive", () => {
    const puzzle = deployBox().get(123);

    expect(puzzle?.solution?.map((step) => step.clear)).toContain("spin (no lines)");
  });

  test("serves the three-spin requirement rather than blanking it", () => {
    // `withoutUnmeetableClears` runs after the archive's answers are merged, so
    // a requirement the stored answer cannot meet is dropped here — silently,
    // and the puzzle is then scored on attack alone. An empty list is the
    // failure this test exists to catch.
    const required = deployBox().get(123)?.requiredClears ?? [];

    expect(required).not.toEqual([]);
    expect(required.find((entry) => entry.clear === "spin (no lines)")?.count).toBe(1);
  });

  test("leaves every other puzzle's requirement exactly as the file states it", () => {
    const archive = deployBox();
    const changed = served().filter((puzzle) => {
      if (puzzle.id === 123) return false;
      const loaded = archive.get(puzzle.id);
      return (
        JSON.stringify(sorted(loaded?.requiredClears ?? [])) !==
        JSON.stringify(sorted(puzzle.requiredClears ?? []))
      );
    });

    expect(changed.map((puzzle) => puzzle.id)).toEqual([]);
  });
});
