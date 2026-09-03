/**
 * The builder's model, checked where it touches the format.
 *
 * Two of these are the ones that matter. The round trip is
 * `blueprint-encode.test.ts`'s invariant applied to the builder's own shape: a
 * board built here, written out, and read back has to be the same board. The
 * archive check is the compatibility story — a code from bp.tali.software
 * carries an active piece that *is* the first playable piece, and if `fromPage`
 * folds it in differently from `tools/build-puzzles.ts` then loading a real
 * puzzle quietly loses or duplicates its opening piece.
 */

import { describe, expect, test } from "bun:test";
import { decodeBlueprint } from "../shared/blueprint/decode";
import { encodeBlueprint } from "../shared/blueprint/encode";
import {
  MAX_GOAL_COUNT,
  type BuilderState,
  type GoalSpec,
  cellIndex,
  CLEAR_NAMES,
  EMPTY_GOAL,
  EMPTY_STATE,
  formatGoal,
  fromCode,
  fromPage,
  GOAL_LABELS,
  goalFits,
  hiddenCellCount,
  lossFromPage,
  MAX_GOAL,
  MAX_QUEUE,
  MAX_ROWS,
  pageOf,
  paintCells,
  parseGoal,
  parsePieces,
  sanitizeGoal,
  summaryOf,
  toCode,
  unusedClears,
  warningFor,
  withGoalAttack,
  withGoalEntry,
} from "../client/src/ui/builder-state";
import { archive, hasSolutions } from "./archive";

const state = (patch: Partial<BuilderState> = {}): BuilderState => ({ ...EMPTY_STATE, ...patch });

const cells = (entries: readonly (readonly [number, number, "g" | "I" | "T"])[]) =>
  new Map(entries.map(([x, y, type]) => [cellIndex(x, y), type] as const));

const fullRow = (y: number) =>
  new Map(Array.from({ length: 10 }, (_, x) => [cellIndex(x, y), "g" as const]));

describe("a board written out and read back", () => {
  test("is the same board", () => {
    const original = state({
      cells: cells([
        [0, 0, "g"],
        [1, 0, "g"],
        [9, 0, "I"],
        [4, 3, "T"],
      ]),
      queue: ["T", "L", "J", "S"],
      hold: "O",
      goal: "Clear 2 TSDs",
    });

    const page = decodeBlueprint(toCode(original)).pages[0]!;
    const again = fromPage(page);

    expect([...again.cells].sort()).toEqual([...original.cells].sort());
    expect(again.queue).toEqual(original.queue);
    expect(again.hold).toBe("O");
    expect(again.goal).toBe("Clear 2 TSDs");
  });

  test("survives having no hold, no goal and an empty board", () => {
    const again = fromCode(toCode(state({ queue: ["I"] })));
    expect(again).toEqual(state({ queue: ["I"] }));
  });
});

describe.skipIf(!hasSolutions)("a code the club actually wrote", () => {
  test("keeps its falling piece at the front of the queue", () => {
    const sourced = archive.filter((puzzle) => Boolean(puzzle.source?.puzzle));
    expect(sourced.length).toBeGreaterThan(100);
    const wrong: number[] = [];
    for (const puzzle of sourced) {
      const loaded = fromCode(puzzle.source!.puzzle!);
      const expected = puzzle.queue.slice(0, MAX_QUEUE);
      if (loaded.queue.join("") !== expected.join("") || loaded.hold !== puzzle.hold) {
        wrong.push(puzzle.id);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("painting", () => {
  test("sets, overwrites and erases without touching what it was given", () => {
    const before = state({ cells: cells([[0, 0, "g"]]) });

    const set = paintCells(before, [cellIndex(3, 1)], "T");
    expect(set.cells.get(cellIndex(3, 1))).toBe("T");
    expect(before.cells.size).toBe(1);

    expect(paintCells(set, [cellIndex(3, 1)], "I").cells.get(cellIndex(3, 1))).toBe("I");
    expect(paintCells(set, [cellIndex(3, 1)], "erase").cells.has(cellIndex(3, 1))).toBe(false);
  });

  test("hands back the same state when nothing moved", () => {
    const before = state({ cells: cells([[0, 0, "g"]]) });
    expect(paintCells(before, [cellIndex(0, 0)], "g")).toBe(before);
    expect(paintCells(before, [cellIndex(5, 5)], "erase")).toBe(before);
  });
});


describe("reading a queue somebody typed", () => {
  test("keeps the piece letters and ignores everything else", () => {
    expect(parsePieces("t, l j sZ x9").join("")).toBe("TLJSZ");
    expect(parsePieces("")).toEqual([]);
  });

  test("stops at the cap", () => {
    expect(parsePieces("T".repeat(100))).toHaveLength(MAX_QUEUE);
  });
});

describe("the goal field", () => {
  test("drops what the comment code page would mangle", () => {
    // `writeText` reads `charCodeAt(0)` of each code point, so an astral
    // character goes out as its lone high surrogate and comes back wrong.
    expect(sanitizeGoal("🚀 spin")).toBe(" spin");
    expect(sanitizeGoal("café")).toBe("caf");
    expect(sanitizeGoal("→ left")).toBe(" left");
  });

  test("substitutes the punctuation a pasted goal actually carries", () => {
    // Chat windows hand out curly quotes and em dashes, and the code page has
    // ASCII for all of them. Dropping "’" turns "Don't" into "Dont".
    expect(sanitizeGoal("Don’t waste the I")).toBe("Don't waste the I");
    expect(sanitizeGoal("Set up a TSD — then PC")).toBe("Set up a TSD - then PC");
    expect(sanitizeGoal("“stack flat”")).toBe('"stack flat"');
    expect(sanitizeGoal("wait for it…")).toBe("wait for it...");
  });

  test("stops at the cap even when a substitution grew the text", () => {
    // "…" costs three characters, so the cap has to be applied to the result
    // rather than counted as it goes.
    expect(sanitizeGoal("…".repeat(MAX_GOAL))).toHaveLength(MAX_GOAL);
  });

  test("leaves the encoder nothing it could mangle", () => {
    const goal = sanitizeGoal("Clear 2 TSDs — fast! 🚀");
    const page = decodeBlueprint(toCode(state({ queue: ["T"], goal }))).pages[0]!;
    expect(page.comment).toBe(goal);
  });
});

/**
 * The goal's structured half.
 *
 * The whole design problem is that a blueprint code has one free-text comment
 * and nothing else, so the counts have to survive as a sentence and be found
 * again inside one. Two things are therefore load-bearing and both are pinned
 * here: the sentence has to be one the club would have written by hand, and a
 * sentence that is *not* one of ours has to come back untouched rather than be
 * rounded into the nearest spec.
 */
describe("a goal written as counts", () => {
  const spec = (clears: GoalSpec["clears"], attack = 0): GoalSpec => ({ clears, attack });

  test("reads as a goal the archive would have written by hand", () => {
    // Every one of these is a string that appears verbatim in data/puzzles.json,
    // which is the bar: the player reads this on the sheet, not a format.
    expect(formatGoal(spec([{ clear: "tsd", count: 1 }]))).toBe("Clear 1 TSD");
    expect(
      formatGoal(
        spec([
          { clear: "tsd", count: 2 },
          { clear: "tst", count: 1 },
        ]),
      ),
    ).toBe("Clear 2 TSDs and 1 TST");
    // Three or more take the Oxford comma, as the archive's own do.
    expect(
      formatGoal(
        spec([
          { clear: "tss", count: 1 },
          { clear: "tsd", count: 2 },
          { clear: "tst", count: 1 },
        ]),
      ),
    ).toBe("Clear 1 TSS, 2 TSDs, and 1 TST");
    expect(formatGoal(EMPTY_GOAL)).toBe("");
  });

  test("comes back out of its own sentence as the same counts", () => {
    const original = spec(
      [
        { clear: "tss", count: 1 },
        { clear: "tsd", count: 2 },
        { clear: "quad", count: 3 },
      ],
      18,
    );
    expect(parseGoal(formatGoal(original))).toEqual(original);
  });

  test("round trips every clear the vocabulary has", () => {
    // A clear added to `ClearName` and forgotten here would serialise to a word
    // the parser cannot read, and the counters would eat it on the way back.
    for (const clear of CLEAR_NAMES) {
      const one = spec([{ clear, count: 1 }]);
      const many = spec([{ clear, count: 4 }], 7);
      expect(parseGoal(formatGoal(one))).toEqual(one);
      expect(parseGoal(formatGoal(many))).toEqual(many);
    }
  });

  test("carries the attack, which is the number nothing else can derive", () => {
    // A builder puzzle has no reference solution, so `targetAttack` cannot be
    // computed the way the pipeline computes it. The author's own figure has to
    // survive the only channel a code has.
    const withAttack = spec([{ clear: "tsd", count: 3 }], 18);
    const text = formatGoal(withAttack);
    expect(text).toBe("Clear 3 TSDs for 18 attack");
    expect(parseGoal(text)?.attack).toBe(18);

    // And on its own, with nothing to clear.
    expect(formatGoal(spec([], 20))).toBe("Send 20 attack");
    expect(parseGoal("Send 20 attack")).toEqual(spec([], 20));

    // Through the code itself, which is where it actually has to survive.
    const again = fromCode(toCode(state({ queue: ["T"], goal: text })));
    expect(again.goal).toBe(text);
    expect(parseGoal(again.goal)).toEqual(withAttack);
  });

  test("never prints a count of zero", () => {
    // "0 Quad" is not a goal, it is a control somebody turned back down.
    const zeroed = withGoalEntry(
      spec([
        { clear: "tsd", count: 2 },
        { clear: "quad", count: 3 },
      ]),
      "quad",
      0,
    );
    expect(formatGoal(zeroed)).toBe("Clear 2 TSDs");
    expect(zeroed.clears).toEqual([{ clear: "tsd", count: 2 }]);
    // Even handed a spec that was built with one in it by some other route.
    expect(
      formatGoal(
        spec([
          { clear: "tsd", count: 2 },
          { clear: "quad", count: 0 },
        ]),
      ),
    ).toBe("Clear 2 TSDs");
    // And an attack of zero is silence, not "for 0 attack".
    expect(formatGoal(spec([{ clear: "tsd", count: 1 }], 0))).toBe("Clear 1 TSD");
    expect(formatGoal(withGoalAttack(spec([], 12), 0))).toBe("");
  });

  test("reads the archive's own looser wording without rewriting it", () => {
    // Tolerance is one-way: these parse, so the counters fill in, but nothing
    // writes the text back unless the author moves a control.
    expect(parseGoal("2 TSD + 1 TST")).toEqual(
      spec([
        { clear: "tsd", count: 2 },
        { clear: "tst", count: 1 },
      ]),
    );
    expect(parseGoal("3TSD")).toEqual(spec([{ clear: "tsd", count: 3 }]));
    expect(parseGoal("2 TSS, 3 TSD")).toEqual(
      spec([
        { clear: "tss", count: 2 },
        { clear: "tsd", count: 3 },
      ]),
    );
    expect(parseGoal("Clear 1 TSD and 1 Tetris")).toEqual(
      spec([
        { clear: "tsd", count: 1 },
        { clear: "quad", count: 1 },
      ]),
    );
    expect(parseGoal("Perform 3 Spins")).toEqual(spec([{ clear: "spin", count: 3 }]));
  });

  test("refuses anything it cannot account for, whole", () => {
    // Each of these is a real archived goal carrying something the counters
    // have no room for. Half-reading them would drop the half that matters.
    for (const prose of [
      "3TSD not in one combo",
      "3 B2B in one combo",
      "Clear a TSD",
      "Send 16 (no b2b table)",
      "Clear 2 TSDs and 1 Quad (no hold)",
      "TSD + TST",
      "Clear a Quad while keeping season 2 B2B",
      "Clear 4 TSDs and 2 Quads | Chain 5 attacks together",
      // Not a total but an order, so the counters would say the wrong thing.
      "2 TSDs and 2 TSDs",
    ]) {
      expect(parseGoal(prose)).toBeNull();
    }
    // Empty is not prose: it is a goal nobody has written yet.
    expect(parseGoal("   ")).toEqual(EMPTY_GOAL);
  });

  test("leaves a prose comment exactly as it was written, through the code", () => {
    // The rule the whole design turns on. Most codes in existence carry a goal
    // that will never parse, and a builder that eats one on load is worse than
    // one with no counters at all.
    const prose = "3TSD not in one combo";
    const again = fromCode(toCode(state({ queue: ["T"], goal: prose })));
    expect(again.goal).toBe(prose);
    expect(parseGoal(again.goal)).toBeNull();
  });

  test("offers only the clears the goal does not already name", () => {
    expect(unusedClears(EMPTY_GOAL)).toEqual([...CLEAR_NAMES]);
    expect(unusedClears(spec([{ clear: "tsd", count: 1 }]))).not.toContain("tsd");
  });

  test("knows when a sentence has run past what a comment can carry", () => {
    const every = CLEAR_NAMES.reduce(
      (built, clear) => withGoalEntry(built, clear, 99),
      EMPTY_GOAL,
    );
    // Ten clears at two digits each is a sentence longer than the field holds,
    // and the builder disables Add rather than truncating into unparseable text.
    expect(formatGoal(every).length).toBeGreaterThan(MAX_GOAL);
    expect(goalFits(every)).toBe(false);
    expect(goalFits(spec([{ clear: "tsd", count: 2 }], 18))).toBe(true);
  });

  test("names every clear, so a new one cannot go unlabelled", () => {
    for (const clear of CLEAR_NAMES) expect(GOAL_LABELS[clear]).not.toBe("");
    expect(CLEAR_NAMES).toHaveLength(10);
  });
});

describe("what a load cannot keep", () => {
  const oversized = encodeBlueprint({
    cells: [{ x: 0, y: 0, type: "g" }],
    previews: Array.from({ length: MAX_QUEUE + 20 }, () => "T" as const),
    hold: null,
    comment: "x".repeat(MAX_GOAL + 80),
  });

  test("is counted and said, not swallowed", () => {
    // The code box is refilled from the trimmed board, so Copy would hand back
    // a shorter puzzle than the one pasted in. Silence there loses somebody's
    // queue between two presses.
    const page = pageOf(oversized);
    expect(fromPage(page).queue).toHaveLength(MAX_QUEUE);
    expect(fromPage(page).goal).toHaveLength(MAX_GOAL);

    const loss = lossFromPage(page);
    expect(loss).toContain("20 pieces");
    expect(loss).toContain("80 characters");
  });

  test("says nothing about a code that fits", () => {
    expect(lossFromPage(pageOf(toCode(state({ queue: ["T"], goal: "Clear 1 TSD" }))))).toBeNull();
  });

  test("does not count characters the code page was never going to carry", () => {
    // 130 arrows are over the cap by raw length and under it by what the field
    // can hold, because none of them survive the fold. Measuring the raw string
    // would raise an alarm about a cap that never bit.
    const arrows = encodeBlueprint({
      cells: [],
      previews: ["T"],
      hold: null,
      comment: "→".repeat(MAX_GOAL + 10),
    });
    expect(lossFromPage(pageOf(arrows))).toBeNull();
  });
});

describe("cells above the drawn board", () => {
  const tall = state({
    queue: ["T"],
    cells: cells([
      [0, 0, "g"],
      [3, 25, "g"],
    ]),
  });
  const taller = state({
    queue: ["T"],
    cells: cells([
      [0, 25, "g"],
      [3, 25, "g"],
    ]),
  });

  test("are counted", () => {
    expect(hiddenCellCount(tall)).toBe(1);
    expect(hiddenCellCount(state({ cells: cells([[0, 19, "g"]]) }))).toBe(0);
  });

  test("are named before anything else, because the board is not showing itself", () => {
    const note = warningFor(tall);
    expect(note).toContain("1 cell");
    expect(note).toContain(`above row ${MAX_ROWS}`);
    expect(note).toContain("Clear board");
    expect(warningFor(taller)).toContain("2 cells");
  });

  test("survive the trip back out to a code", () => {
    // Naming them is the fix, not dropping them: a code loaded and copied back
    // still has to be the same puzzle.
    const again = fromCode(toCode(tall));
    expect([...again.cells].sort()).toEqual([...tall.cells].sort());
  });
});

describe("the one warning", () => {
  test("names the queue first, then a full row, then the board, then the goal", () => {
    expect(warningFor(EMPTY_STATE)).toContain("queue");
    expect(warningFor(state({ queue: ["T"], cells: fullRow(0) }))).toContain("Row 1");
    expect(warningFor(state({ queue: ["T"] }))).toContain("empty board");
    expect(warningFor(state({ queue: ["T"], cells: cells([[0, 0, "g"]]) }))).toContain("goal");
  });

  test("says nothing about a finished puzzle", () => {
    expect(
      warningFor(state({ queue: ["T"], cells: cells([[0, 0, "g"]]), goal: "Clear 1 TSD" })),
    ).toBeNull();
  });
});

describe("the summary line", () => {
  test("counts what is there and says whether a hold is", () => {
    expect(summaryOf(state({ cells: cells([[0, 0, "g"]]), queue: ["T", "L"] }))).toBe(
      "1 cells · 2 pieces · no hold",
    );
    expect(summaryOf(state({ hold: "O" }))).toBe("0 cells · 0 pieces · hold O");
  });
});

describe("a count typed wrong", () => {
  test("a stray minus keeps the clear instead of deleting it", () => {
    // Zero means "take this clear out"; a negative means a typo. Folding them
    // together deleted the row on `-4` while `150` was politely clamped — the
    // same control behaving two different ways at its two ends.
    const spec = withGoalEntry(withGoalEntry(EMPTY_GOAL, "tsd", 2), "tst", 1);
    expect(withGoalEntry(spec, "tsd", -4).clears.map((entry) => entry.clear)).toEqual([
      "tsd",
      "tst",
    ]);
    expect(withGoalEntry(spec, "tsd", -4).clears[0]!.count).toBe(1);
    // Zero still means what it meant.
    expect(withGoalEntry(spec, "tsd", 0).clears.map((entry) => entry.clear)).toEqual(["tst"]);
    // And an overshoot is still clamped, not refused.
    expect(withGoalEntry(spec, "tsd", 150).clears[0]!.count).toBe(MAX_GOAL_COUNT);
  });
});
