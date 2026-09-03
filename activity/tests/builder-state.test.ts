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
  type BuilderState,
  cellIndex,
  EMPTY_STATE,
  fromCode,
  fromPage,
  hiddenCellCount,
  lossFromPage,
  MAX_GOAL,
  MAX_QUEUE,
  MAX_ROWS,
  MIN_ROWS,
  pageOf,
  paintCells,
  parsePieces,
  sanitizeGoal,
  summaryOf,
  toCode,
  visibleRowsFor,
  warningFor,
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

describe("how tall the board is drawn", () => {
  test("is the stack plus headroom, floored and capped", () => {
    expect(visibleRowsFor(EMPTY_STATE)).toBe(MIN_ROWS);
    expect(visibleRowsFor(state({ cells: cells([[0, 14, "g"]]) }))).toBe(17);
    // Cells can sit above the drawn board — they are kept, not dropped — so the
    // height has to stop at what the app can draw.
    expect(visibleRowsFor(state({ cells: cells([[0, 19, "g"]]) }))).toBe(MAX_ROWS);
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
