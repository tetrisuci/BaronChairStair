/**
 * The clear requirement now comes from the answer, not from the sentence.
 *
 * The club's rule, decided after the engine and the puzzle makers were found to
 * disagree about naming: a maker titles and describes their puzzle however they
 * like, and what the server *enforces* is whatever their own solution actually
 * does when replayed. A goal reading "Clear 2 TSDs" whose answer makes a TSD and
 * a mini is enforced as a TSD and a mini, because that is the puzzle.
 *
 * This replaces a gate that read the prose and refused the requirement whenever
 * the answer disagreed. That gate was right that the two can disagree and wrong
 * about which one wins: it left 25 puzzles enforcing nothing rather than
 * enforcing what they demonstrably are.
 *
 * Counting is by engine name, so a `tsmini` is counted as a `tsmini` &mdash; see
 * `clearShortfall`, which this feeds and which makes the same distinction.
 */

import { describe, expect, test } from "bun:test";
import { PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES, requirementFromSolution } from "../shared/puzzle";
import { nameClear } from "../shared/tetris/replay";
import type { ClearName } from "../shared/puzzle";

const clears = (...names: (ClearName | null)[]) => names.map((clear) => ({ clear }));

describe("requirementFromSolution", () => {
  test("counts each clear the answer makes, by engine name", () => {
    const got = requirementFromSolution(clears("tsd", "tsd", "tst"));

    expect(got).toEqual([
      { clear: "tsd", count: 2 },
      { clear: "tst", count: 1 },
    ]);
  });

  test("keeps a mini distinct from the full spin it resembles", () => {
    const got = requirementFromSolution(clears("tsd", "tsmini"));

    expect(got).toEqual([
      { clear: "tsd", count: 1 },
      { clear: "tsmini", count: 1 },
    ]);
  });

  test("ignores placements that clear nothing", () => {
    const got = requirementFromSolution(clears("tsd", null, null, "tsd"));

    expect(got).toEqual([{ clear: "tsd", count: 2 }]);
  });

  test("an answer that clears nothing requires nothing", () => {
    expect(requirementFromSolution(clears(null, null))).toEqual([]);
    expect(requirementFromSolution([])).toEqual([]);
  });

  test("orders by first appearance, so the same answer always reads the same", () => {
    const once = requirementFromSolution(clears("tst", "tsd", "tsd"));
    const twice = requirementFromSolution(clears("tst", "tsd", "tsd"));

    expect(once).toEqual(twice);
    expect(once.map((e) => e.clear)).toEqual(["tst", "tsd"]);
  });

  test("ignores a spin that cleared nothing, unless the puzzle asks", () => {
    // The whole reason the flag exists. Once `nameClear` started naming these,
    // deriving them everywhere would have made 43 of the archive's 138 puzzles
    // stricter overnight — each demanding an incidental spin its maker never
    // asked for. Measured before the flag went in; 1 puzzle changes with it.
    const made = clears("tsd", "spin (no lines)", "tsd");

    expect(requirementFromSolution(made)).toEqual([{ clear: "tsd", count: 2 }]);
    expect(requirementFromSolution(made, 999_999)).toEqual([{ clear: "tsd", count: 2 }]);
  });

  test("counts one for a puzzle whose goal asks for it", () => {
    const [asked] = [...PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES];
    const made = clears("spin", "spin (no lines)", "spin");

    expect(requirementFromSolution(made, asked)).toEqual([
      { clear: "spin", count: 2 },
      { clear: "spin (no lines)", count: 1 },
    ]);
  });

  test("#123 style is the puzzle that asks", () => {
    // Its goal reads "Perform 3 Spins" and its own answer spins three times,
    // one of them clearing nothing. Before this it could only require two.
    expect(PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES.has(123)).toBe(true);
  });

  test("the answer it was built from always satisfies it", () => {
    const made: ClearName[] = ["tsd", "tsmini", "tst", "quad"];
    const { clearShortfall } = require("../shared/puzzle");

    expect(clearShortfall(made, requirementFromSolution(clears(...made)))).toEqual([]);
  });
});

describe("nameClear, on a lock that cleared no lines", () => {
  const lock = (spin: string) =>
    ({ lines: 0, spin, mino: 0, garbage: [] }) as unknown as Parameters<typeof nameClear>[0];

  test("names a spin that cleared nothing", () => {
    // It used to answer null before it looked at the spin at all, which is why
    // a goal could never ask for one.
    expect(nameClear(lock("mini"), false)).toBe("spin (no lines)");
    expect(nameClear(lock("normal"), false)).toBe("spin (no lines)");
  });

  test("still says nothing for a placement that was not a spin", () => {
    expect(nameClear(lock("none"), false)).toBeNull();
  });
});
