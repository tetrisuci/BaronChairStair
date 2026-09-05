/**
 * The grammar that decides what 112 archived puzzles enforce.
 *
 * `parseGoalLoosely` turns an author's sentence into the clears a solve must
 * make. A **false positive here is worse than the bug this feature fixes**: it
 * silently makes a puzzle demand something its author never wrote, and the only
 * thing standing between that and a shipped archive is the reference-solution
 * gate in `tools/backfill-required-clears.ts`. So these lean on the refusals as
 * hard as on the successes.
 */

import { describe, expect, test } from "bun:test";
import { parseGoal, parseGoalLoosely } from "../shared/goal";
import { clearShortfall, solvesPuzzle, type ClearName } from "../shared/puzzle";

/** The clears a goal asks for, as a plain object, or null when it asks for none. */
function asked(goal: string): Record<string, number> | null {
  const spec = parseGoalLoosely(goal);
  if (!spec) return null;
  return Object.fromEntries(spec.clears.map((entry) => [entry.clear, entry.count]));
}

describe("what the loose parser reads, and the strict one does not", () => {
  // Each of these is a real shape from data/puzzles.json, and each was prose —
  // i.e. unenforced — before the normalisations went in.
  test.each([
    ["Clear a TSD", { tsd: 1 }],
    ["Clear 3 TSDs.", { tsd: 3 }],
    ["TSD + TST", { tsd: 1, tst: 1 }],
    ["Clear a TST and Quad", { tst: 1, quad: 1 }],
    ["3TSD", { tsd: 3 }],
    ["Clear 2 TSDS and a TST", { tsd: 2, tst: 1 }],
    ["Send 3 TSDs and a TST.(ZJSOLIZJISOLTSJSTTT)", { tsd: 3, tst: 1 }],
  ])("%s", (goal, want) => {
    expect(asked(goal as string)).toEqual(want as Record<string, number>);
  });

  test("the strict parser still refuses them, which is why the loose one exists", () => {
    for (const goal of ["Clear a TSD", "Clear 3 TSDs.", "TSD + TST"]) {
      expect(parseGoal(goal)?.clears?.length ?? 0).toBe(0);
    }
  });
});

describe("what it refuses, and must keep refusing", () => {
  /**
   * A parenthetical carrying a refusal is the dangerous case. "Send a TST and
   * TSD (no hold)" parses cleanly to two clears — and enforcing those two while
   * dropping "no hold" enforces a different, easier puzzle than the one written.
   */
  test.each([
    "Send a TST and TSD (no hold)",
    "Clear 2 TSDs and 1 Quad (no hold)",
    "Send 16 (no b2b table)",
    "TST without moving left or right",
    "3TSD NOT in one combo",
  ])("refuses %s", (goal) => {
    expect(parseGoalLoosely(goal)).toBeNull();
  });

  test.each([
    ["c spin", "names no clear this vocabulary has"],
    ["", "an empty goal asks for nothing"],
    ["Chain 3 attacks: TSD>S>D.", "an ordering, not a count"],
    ["Clear TSD->TSD->TSS->TSS", "an ordering, not a count"],
    ["3TSD in one combo", "a combo, which no count can hold"],
    ["Clear a Quad while keeping season 2 B2B", "a streak, which no count can hold"],
    ["Clear a TST and a DT", "DT is not a clear the engine names"],
  ])("refuses %s — %s", (goal) => {
    expect(parseGoalLoosely(goal)).toBeNull();
  });

  test("a repeated clear is refused rather than summed", () => {
    // "2 TSDs then 2 TSDs" is an order, not a total of four. The strict parser
    // already decided this; the loose one must not quietly undo it.
    expect(parseGoalLoosely("Clear 2 TSDs and 2 TSDs")).toBeNull();
  });
});

describe("the shortfall, which is what the run loop and the meter both read", () => {
  const need = [{ clear: "tsd" as ClearName, count: 3 }];

  test("counts by name, so a T-mini is not a TSD", () => {
    const made: ClearName[] = ["tsd", "tsmini", "tsd"];
    expect(clearShortfall(made, need)).toEqual([{ clear: "tsd", count: 1 }]);
  });

  test("is a floor — extra clears never fail a solve", () => {
    const made: ClearName[] = ["tsd", "tsd", "tsd", "tsd", "quad"];
    expect(clearShortfall(made, need)).toEqual([]);
  });

  test("an absent requirement asks for nothing", () => {
    expect(clearShortfall(["single"], undefined)).toEqual([]);
    expect(clearShortfall([], [])).toEqual([]);
  });
});

describe("the solve condition", () => {
  const puzzle = { targetAttack: 12, requiredClears: [{ clear: "tsd" as ClearName, count: 3 }] };

  test("the attack target alone is not enough — the bug this feature exists for", () => {
    // Three quads are also 12 attack. Under the old rule this solved the puzzle.
    expect(solvesPuzzle(12, ["quad", "quad", "quad"], puzzle)).toBe(false);
  });

  test("the named clears alone are not enough either", () => {
    expect(solvesPuzzle(11, ["tsd", "tsd", "tsd"], puzzle)).toBe(false);
  });

  test("both, and it solves", () => {
    expect(solvesPuzzle(12, ["tsd", "tsd", "tsd"], puzzle)).toBe(true);
  });

  test("a puzzle with no requirement scores exactly as it always did", () => {
    const loose = { targetAttack: 12 };
    expect(solvesPuzzle(12, ["quad", "quad", "quad"], loose)).toBe(true);
    expect(solvesPuzzle(11, ["quad", "quad"], loose)).toBe(false);
  });
});
