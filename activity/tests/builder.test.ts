/**
 * The builder driven the way somebody uses it: paint on the screen, type in the
 * fields, read the code out of the box at the bottom and decode it.
 *
 * `builder-state.test.ts` already pins the model's own round trip. What only a
 * DOM can show is the half between a pointer and that model, and the y-flip in
 * particular: the model counts up from the floor, the grid is built top row
 * first, and the flip is written out three separate times — `cellUnder` reading
 * a click, `nodeAt` finding a node, `render` filling the board. A builder that
 * lays every stack upside down is a broken feature that every pure test in the
 * suite would still pass.
 *
 * The one fiction: happy-dom does no layout, so the test supplies the grid's
 * box. Everything downstream of it — the hit arithmetic, the stroke, the map,
 * the encoder — is the real thing, and the assertions all end at a decode of
 * the text actually sitting in the code field.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { type BlueprintPage, decodeBlueprint } from "../shared/blueprint/decode";
import { encodeBlueprint } from "../shared/blueprint/encode";
import { COLUMNS } from "../shared/blueprint/playfield";
import type { PuzzlePrompt } from "../shared/puzzle";
import { createBuilder } from "../client/src/ui/builder";
import {
  MAX_GOAL_COUNT,
  MAX_QUEUE,
  MAX_ROWS,
  NO_TARGET,
} from "../client/src/ui/builder-state";
import { extraClears, goalReport } from "../client/src/ui/builder-test";
import type { BoardView } from "../client/src/render/board";
import type { RunSnapshot } from "../client/src/game/runner";
import { archive, hasSolutions } from "./archive";

let window: Window;
const saved = { document: globalThis.document };

beforeAll(() => {
  // Scoped to this file rather than registered as a preload, for the reason
  // render.test.ts gives: `bun test` shares one process and the server suite
  // leans on Bun's own fetch/Request.
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
});

afterAll(() => {
  globalThis.document = saved.document;
});

/** One cell's side, in the pretend layout. Any positive number would do. */
const CELL = 20;

interface Filled {
  readonly x: number;
  readonly y: number;
  readonly type: string;
}

/** In row-major order from the floor, which is what `nonEmptyCells` yields. */
function filled(page: BlueprintPage): Filled[] {
  return [...page.playfield.nonEmptyCells()].map(({ x, y, type }) => ({ x, y, type: type! }));
}

function mount() {
  const tested: PuzzlePrompt[] = [];
  const builder = createBuilder({
    onClose: () => {},
    // The app plays the draft; the test stands in for it, so what the
    // builder hands over is inspectable on its own.
    onTest: (puzzle) => tested.push(puzzle),
    onStopTest: () => builder.endTest(),
  });
  // The builder is three siblings now — a rail, the board, a rail — and the app
  // mounts them straight into the deck. One parent here is the deck's stand-in,
  // so a query below reaches the whole screen the way it used to reach the card.
  const element = builder.board.ownerDocument.createElement("div");
  element.append(builder.left, builder.board, builder.right);
  window.document.body.append(element as never);

  const find = <T extends Element>(selector: string): T => {
    const node = element.querySelector(selector);
    if (!node) throw new Error(`the builder has no ${selector}`);
    return node as T;
  };

  const grid = find<HTMLElement>(".build__grid");
  const codeField = find<HTMLInputElement>(".build__code");

  // `cellUnder` is arithmetic on this box and happy-dom never fills one in, so
  // the size is the test's to give. Read live rather than frozen: the board
  // grows with the stack, and a stale height would slide every later click.
  grid.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: COLUMNS * CELL,
      bottom: grid.childElementCount * CELL,
      width: COLUMNS * CELL,
      height: grid.childElementCount * CELL,
      toJSON: () => ({}),
    }) as DOMRect;

  const pointer = (type: string, fromTop: number, column: number) =>
    new window.PointerEvent(type, {
      bubbles: true,
      clientX: (column + 0.5) * CELL,
      clientY: (fromTop + 0.5) * CELL,
    });

  const release = () =>
    window.document.dispatchEvent(new window.Event("pointerup", { bubbles: true }) as never);

  const type_ = (field: HTMLInputElement, text: string) => {
    // Focused first because the write-back guard in `render` is focus-based:
    // an unfocused field is overwritten from the bench mid-keystroke, which is
    // exactly what a typing user is not doing.
    field.focus();
    field.value = text;
    field.dispatchEvent(new window.Event("input", { bubbles: true }) as never);
  };

  return {
    element,
    grid,
    codeField,
    builder,
    /** Every draft the builder has handed over to be played. */
    tested,
    pieces: find<HTMLInputElement>(".build__pieces"),
    holdField: find<HTMLInputElement>(".build__letter"),
    goalField: find<HTMLInputElement>('input[aria-label="Goal"]'),
    goalRows: find<HTMLElement>(".build__goals"),
    goalNote: find<HTMLElement>(".build__goal-note"),
    attackBox: find<HTMLInputElement>('input[aria-label="Attack"]'),

    /** A clear's count box, by the word its row shows. */
    countBox: (label: string) => find<HTMLInputElement>(`input[aria-label="${label} count"]`),

    /** Whether the goal panel is offering a counter for this clear at all. */
    hasCount: (label: string) =>
      element.querySelector(`input[aria-label="${label} count"]`) !== null,

    /** A whole number typed into one of the counters and committed. */
    setNumber(field: HTMLInputElement, value: string): void {
      field.focus();
      field.value = value;
      field.dispatchEvent(new window.Event("change", { bubbles: true }) as never);
    },

    /** Choose a clear from the list and press Add, which is the only way in. */
    addClear(clear: string): void {
      const pick = find<HTMLSelectElement>(".build__goal-pick");
      pick.value = clear;
      pick.dispatchEvent(new window.Event("change", { bubbles: true }) as never);
      this.press("Add");
    },

    /** The × on a clear's row, which is the only way out. */
    removeClear(label: string): void {
      const button = find<HTMLElement>(`button[aria-label="Remove ${label}"]`);
      button.focus();
      button.click();
    },
    warning: find<HTMLElement>(".build__warning"),
    /** The screen row the floor is drawn on, which moves as the stack grows. */
    bottomRow: () => grid.childElementCount - 1,
    type: type_,

    /** Leaving a field, which is when the model's own text goes back into it. */
    leave(field: HTMLInputElement): void {
      field.dispatchEvent(new window.Event("blur") as never);
    },

    /** A key pressed with the board focused, chords included. */
    key(
      key: string,
      modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
    ): void {
      grid.dispatchEvent(
        new window.KeyboardEvent("keydown", { key, bubbles: true, ...modifiers }) as never,
      );
    },

    /** A click on a screen cell, counted from the top of the board. */
    paint(fromTop: number, column: number): void {
      grid.dispatchEvent(pointer("pointerdown", fromTop, column) as never);
      release();
    },

    /** A click at an exact pixel, for the geometry the cell helpers round away. */
    pointAt(clientX: number, clientY: number): void {
      grid.dispatchEvent(
        new window.PointerEvent("pointerdown", { bubbles: true, clientX, clientY }) as never,
      );
      release();
    },

    /** One stroke across a run of cells on the same screen row. */
    drag(fromTop: number, columns: readonly number[]): void {
      const [first, ...rest] = columns;
      grid.dispatchEvent(pointer("pointerdown", fromTop, first!) as never);
      for (const column of rest) {
        grid.dispatchEvent(pointer("pointermove", fromTop, column) as never);
      }
      release();
    },

    /**
     * A button by its label — the palette's swatches included, since a swatch
     * reads as its own letter ("T", "GARB", "ERASE").
     *
     * Focused before the click because a real mousedown moves focus and
     * happy-dom's `click()` does not; without it the code field believes it is
     * still being typed into and `render` leaves it alone.
     */
    press(label: string): void {
      const button = [...element.querySelectorAll("button")].find(
        (node) => node.textContent === label,
      );
      if (!button) throw new Error(`the builder has no "${label}" button`);
      (button as unknown as HTMLElement).focus();
      (button as unknown as HTMLElement).click();
    },

    code: () => codeField.value,
    page: () => decodeBlueprint(codeField.value).pages[0]!,
    /** Paste a code in and press Load, as somebody bringing one in would. */
    load(code: string): void {
      type_(codeField, code);
      this.press("Load");
    },
  };
}

describe("which way up the board is", () => {
  test("a cell painted at the bottom of the screen is row 0 in the code", () => {
    const ui = mount();
    ui.paint(ui.bottomRow(), 0);
    // And the top row of the field, which is the other end of the axis.
    ui.paint(0, 3);

    expect(filled(ui.page())).toEqual([
      { x: 0, y: 0, type: "g" },
      { x: 3, y: MAX_ROWS - 1, type: "g" },
    ]);
  });

  test("a code with a cell on the floor draws it at the bottom of the screen", () => {
    // The mirror of the test above, and the failure it catches is the same bug
    // seen from the other side: a board loaded upside down.
    const ui = mount();
    ui.load(encodeBlueprint({ cells: [{ x: 0, y: 0, type: "g" }], previews: ["T"], hold: null }));

    const rows = [...ui.grid.children];
    const cellAt = (fromTop: number, column: number) => rows[fromTop]!.children[column]!.className;
    expect(cellAt(rows.length - 1, 0)).toContain("build__cell--on");
    expect(cellAt(0, 0)).not.toContain("build__cell--on");
  });
});

describe("a board laid out with the pointer", () => {
  test("is the board the code carries, cell for cell", () => {
    const ui = mount();
    const floor = ui.bottomRow();
    ui.drag(floor, [0, 1, 2, 3]);
    ui.press("T");
    ui.paint(floor - 1, 1);

    expect(filled(ui.page())).toEqual([
      { x: 0, y: 0, type: "g" },
      { x: 1, y: 0, type: "g" },
      { x: 2, y: 0, type: "g" },
      { x: 3, y: 0, type: "g" },
      { x: 1, y: 1, type: "T" },
    ]);
  });

  test("paints the block the palette is showing, not the one beside it", () => {
    // Nine swatches share one index into `PALETTE`; an off-by-one here writes a
    // board of the wrong colour and nothing on screen contradicts it.
    const ui = mount();
    const floor = ui.bottomRow();
    ui.press("S");
    ui.paint(floor, 0);
    ui.press("Z");
    ui.paint(floor, 1);
    ui.press("GARB");
    ui.paint(floor, 2);

    expect(filled(ui.page()).map((cell) => cell.type)).toEqual(["S", "Z", "g"]);
  });
});

describe("where a click lands", () => {
  test("is measured inside the grid's border, not around it", () => {
    // `.build__grid` has a 2px border and `getBoundingClientRect` returns the
    // border box, but the rows are laid out in the content box inside it: ten
    // columns of 19.6px starting 2px in, not ten of 20px starting at the edge.
    // Dividing the wrong box puts every seam up to two pixels out.
    const ui = mount();
    const border = 2;
    const metrics = {
      clientLeft: border,
      clientTop: border,
      clientWidth: COLUMNS * CELL - border * 2,
      clientHeight: MAX_ROWS * CELL - border * 2,
    };
    for (const [name, value] of Object.entries(metrics)) {
      Object.defineProperty(ui.grid, name, { value, configurable: true });
    }

    // 2px past the second seam by the border box, still inside column 1 by the
    // content box — and column 1 is where the pointer visibly is.
    // Bottom row of the full field; this test is about the column seam.
    ui.pointAt(2 * CELL, (MAX_ROWS - 0.5) * CELL);

    expect(filled(ui.page())).toEqual([{ x: 1, y: 0, type: "g" }]);
  });
});

describe("taking a cell back", () => {
  test("erasing removes it from the code, not just from the screen", () => {
    const ui = mount();
    const floor = ui.bottomRow();
    ui.paint(floor, 0);
    ui.paint(floor, 1);
    const before = ui.code();

    ui.press("ERASE");
    ui.paint(floor, 0);

    expect(filled(ui.page())).toEqual([{ x: 1, y: 0, type: "g" }]);
    expect(ui.code()).not.toBe(before);
  });

  test("a stroke starting on its own colour rubs out instead of repainting", () => {
    // The overshoot rule: drag back over what you just laid and it comes up.
    // Silently painting over it instead would look identical on screen.
    const ui = mount();
    const floor = ui.bottomRow();
    ui.drag(floor, [0, 1, 2]);
    ui.drag(floor, [2, 1]);

    expect(filled(ui.page())).toEqual([{ x: 0, y: 0, type: "g" }]);
  });
});

describe("stepping back", () => {
  test("typing does not spend the board's undo steps", () => {
    // The stack holds 40 steps. A goal used to push one per keystroke, so a
    // 30-character goal evicted 30 board steps and Undo walked back through the
    // sentence a letter at a time instead of lifting the blocks.
    const ui = mount();
    const floor = ui.bottomRow();
    ui.paint(floor, 0);
    ui.paint(floor, 1);
    ui.type(ui.goalField, "Clear two T-spin doubles now!!");

    ui.press("Undo");
    ui.press("Undo");

    expect(filled(ui.page())).toEqual([]);
    // And the goal typed after the strokes did not come up with them.
    expect(ui.page().comment).toBe("Clear two T-spin doubles now!!");
  });

  test("undoing a load puts the fields back too", () => {
    // A load is the one change that replaces everything, so this is the one
    // undo that has to.
    const ui = mount();
    ui.type(ui.goalField, "mine");
    ui.load(
      encodeBlueprint({
        cells: [{ x: 0, y: 0, type: "g" }],
        previews: ["T", "S"],
        hold: "O",
        comment: "theirs",
      }),
    );
    ui.press("Undo");

    expect(ui.page().comment).toBe("mine");
    expect(ui.page().queue.previews).toEqual([]);
    expect(filled(ui.page())).toEqual([]);
  });

  test("is never spent on a step that changes nothing", () => {
    const ui = mount();
    ui.paint(ui.bottomRow(), 0);
    ui.press("Clear board");
    // Nothing left to clear: a second press must not become a step that
    // replays as an Undo the board appears to have ignored.
    ui.press("Clear board");
    ui.press("Undo");

    expect(ui.grid.querySelectorAll(".build__cell--on")).toHaveLength(1);
  });

  test("answers Ctrl+Z on the board", () => {
    // The universal gesture in a painting tool. It used to bubble past the grid
    // to the run's undo and die there, silently.
    const ui = mount();
    ui.drag(ui.bottomRow(), [0, 1, 2]);
    ui.key("z", { ctrlKey: true });

    expect(filled(ui.page())).toEqual([]);
  });
});

describe("a counter the model disagreed with", () => {
  test("shows the model's number once the caret has left it", () => {
    // `change` fires while the box is still focused, so the redraw's focus
    // guard skips it and the clamped value never reaches the screen. The
    // write-back used to be registered once at start-up, over a map of boxes
    // that was empty then and rebuilt every time the goal named a different
    // set of clears — so it was attached to nothing for the whole session.
    const ui = mount();
    ui.type(ui.goalField, "Clear 1 TSD");
    ui.leave(ui.goalField);

    const box = ui.countBox("TSD");
    ui.setNumber(box, "150");
    expect(ui.page().comment).toBe(`Clear ${MAX_GOAL_COUNT} TSDs`);
    // Still showing what was typed, because the caret is in it.
    expect(box.value).toBe("150");

    ui.leave(box);
    expect(box.value).toBe(String(MAX_GOAL_COUNT));
  });
});

describe("stepping forward again", () => {
  test("puts back the stroke that was lifted", () => {
    const ui = mount();
    ui.paint(ui.bottomRow(), 0);
    ui.press("Undo");
    ui.press("Redo");

    expect(filled(ui.page())).toEqual([{ x: 0, y: 0, type: "g" }]);
  });

  test("answers Ctrl+Shift+Z and Ctrl+Y on the board", () => {
    // Both, because the gesture is Shift+Z on a Mac and Ctrl+Y on Windows, and
    // an author who knows one of them should not have to find the button.
    const ui = mount();
    ui.paint(ui.bottomRow(), 0);
    ui.paint(ui.bottomRow(), 1);
    ui.key("z", { ctrlKey: true });
    ui.key("z", { ctrlKey: true });
    expect(filled(ui.page())).toEqual([]);

    ui.key("Z", { ctrlKey: true, shiftKey: true });
    expect(filled(ui.page())).toEqual([{ x: 0, y: 0, type: "g" }]);
    ui.key("y", { ctrlKey: true });
    expect(filled(ui.page())).toEqual([
      { x: 0, y: 0, type: "g" },
      { x: 1, y: 0, type: "g" },
    ]);
  });

  test("forgets the way forward once a new stroke branches off it", () => {
    // The board that was redone no longer follows from the one on screen, so
    // putting it back would be a Redo that lands somewhere the author has
    // never been.
    const ui = mount();
    ui.paint(ui.bottomRow(), 0);
    ui.press("Undo");
    ui.paint(ui.bottomRow(), 5);
    ui.press("Redo");

    expect(filled(ui.page())).toEqual([{ x: 5, y: 0, type: "g" }]);
  });

  test("redoes a load whole, the way undo took it", () => {
    // `restores` travels with the step in both directions: a load replaced the
    // fields as well as the board, so redoing one has to put all of it back.
    const ui = mount();
    ui.type(ui.goalField, "mine");
    ui.load(
      encodeBlueprint({
        cells: [{ x: 0, y: 0, type: "g" }],
        previews: ["T", "S"],
        hold: "O",
        comment: "theirs",
      }),
    );
    ui.press("Undo");
    ui.press("Redo");

    expect(ui.page().comment).toBe("theirs");
    expect(ui.page().queue.previews).toEqual(["T", "S"]);
    expect(filled(ui.page())).toEqual([{ x: 0, y: 0, type: "g" }]);
  });

  test("has nothing to redo until something is undone", () => {
    const ui = mount();
    const redo = () =>
      [...ui.element.querySelectorAll("button")].find((node) => node.textContent === "Redo")!;
    ui.paint(ui.bottomRow(), 0);
    expect(redo().disabled).toBe(true);
    ui.press("Undo");
    expect(redo().disabled).toBe(false);
  });
});

describe("what was typed into the fields", () => {
  test("is what the field shows, once the caret has left it", () => {
    // While the field is focused the caret is not ours to move, so the field
    // keeps the keystrokes. On the way out it has to become the truth, or Copy
    // ships a goal nobody can see on screen.
    const ui = mount();
    ui.type(ui.goalField, "Don’t waste the I 🚀");
    ui.type(ui.pieces, "hello");

    ui.leave(ui.goalField);
    ui.leave(ui.pieces);

    expect(ui.goalField.value).toBe("Don't waste the I ");
    expect(ui.pieces.value).toBe("LLO");
    expect(ui.page().comment).toBe(ui.goalField.value);
    expect(ui.page().queue.previews.join("")).toBe(ui.pieces.value);
  });

  test("comes back out of the code in order", () => {
    const ui = mount();
    ui.type(ui.pieces, "TLJSZO");
    ui.type(ui.holdField, "I");
    ui.type(ui.goalField, "Clear 2 TSDs");

    const page = ui.page();
    // Not reversed, not sorted, and the hold has not eaten the first preview.
    expect(page.queue.previews).toEqual(["T", "L", "J", "S", "Z", "O"]);
    expect(page.queue.hold).toBe("I");
    expect(page.comment).toBe("Clear 2 TSDs");
  });
});

describe("a code brought in from somewhere else", () => {
  const sample = encodeBlueprint({
    cells: [
      { x: 0, y: 0, type: "g" },
      { x: 1, y: 0, type: "g" },
      { x: 9, y: 2, type: "L" },
    ],
    previews: ["T", "S", "Z", "I"],
    hold: "O",
    comment: "Clear 1 TSD",
  });

  test("loads and goes straight back out unchanged", () => {
    // The authoring loop the screen exists for: open somebody's puzzle, change
    // nothing, copy it on. Anything lost in the fold shows up here as a
    // different code.
    const ui = mount();
    ui.load(sample);
    expect(ui.code()).toBe(sample);
  });

  test("puts the board, the queue, the hold and the goal on the screen", () => {
    const ui = mount();
    ui.load(sample);
    expect(ui.pieces.value).toBe("TSZI");
    expect(ui.holdField.value).toBe("O");
    expect(ui.goalField.value).toBe("Clear 1 TSD");
    expect([...ui.grid.querySelectorAll(".build__cell--on")]).toHaveLength(3);
  });

  test("says what it could not keep, rather than quietly dropping it", () => {
    // The code box is refilled from the trimmed board the moment a load lands,
    // so Copy hands back a shorter puzzle than the one that was pasted in.
    const ui = mount();
    const long = encodeBlueprint({
      cells: [{ x: 0, y: 0, type: "g" }],
      previews: Array.from({ length: MAX_QUEUE + 20 }, () => "T" as const),
      hold: null,
      comment: "Clear it",
    });
    ui.load(long);

    expect(ui.warning.hidden).toBe(false);
    expect(ui.warning.textContent).toContain("20 pieces");
    expect(ui.page().queue.previews).toHaveLength(MAX_QUEUE);
    expect(ui.code()).not.toBe(long);
  });

  test("names the cells it cannot draw, and carries them out anyway", () => {
    // Blueprint's field is 40 rows and this screen draws 20. Dropping the rest
    // would lose somebody's puzzle; saying nothing would hide it.
    const ui = mount();
    ui.load(
      encodeBlueprint({
        cells: [
          { x: 0, y: 0, type: "g" },
          { x: 3, y: 25, type: "g" },
        ],
        previews: ["T"],
        hold: null,
        comment: "Clear it",
      }),
    );

    expect(ui.warning.hidden).toBe(false);
    expect(ui.warning.textContent).toContain(`above row ${MAX_ROWS}`);
    expect(ui.grid.querySelectorAll(".build__cell--on")).toHaveLength(1);
    expect(filled(ui.page())).toHaveLength(2);
  });

  test("a bad paste costs nothing", () => {
    const ui = mount();
    ui.drag(ui.bottomRow(), [0, 1]);
    const built = ui.code();

    ui.load("b1@not-a-real-code");
    expect(filled(decodeBlueprint(built).pages[0]!)).toHaveLength(2);
    expect(ui.grid.querySelectorAll(".build__cell--on")).toHaveLength(2);
  });
});

/**
 * The goal's counters, driven through the DOM.
 *
 * `builder-state.test.ts` pins the sentence and its parser. What only a DOM can
 * show is that the two halves are wired the one way round that makes the design
 * safe: the counters write the text, and nothing writes it back at them. A load
 * that reworded somebody's goal would pass every pure test in the suite.
 */
describe("saying the goal in counts", () => {
  test("writes the sentence the club would have written, into the code", () => {
    const ui = mount();
    ui.addClear("tsd");
    ui.addClear("tst");
    ui.setNumber(ui.countBox("TSD"), "2");

    expect(ui.goalField.value).toBe("Clear 2 TSDs and 1 TST");
    expect(ui.page().comment).toBe("Clear 2 TSDs and 1 TST");
  });

  test("carries the attack out, which is the number nothing else can supply", () => {
    // A builder puzzle has no reference solution, so this figure exists only
    // because the author said it — and the comment is the only place to put it.
    const ui = mount();
    ui.addClear("tsd");
    ui.setNumber(ui.countBox("TSD"), "3");
    ui.setNumber(ui.attackBox, "18");

    expect(ui.page().comment).toBe("Clear 3 TSDs for 18 attack");
  });

  test("takes a clear back out rather than leaving it at zero", () => {
    const ui = mount();
    ui.addClear("tsd");
    ui.addClear("quad");
    ui.setNumber(ui.countBox("TSD"), "2");
    ui.removeClear("Quad");

    expect(ui.goalField.value).toBe("Clear 2 TSDs");
    expect(ui.goalField.value).not.toContain("0 Quad");
    expect(ui.hasCount("Quad")).toBe(false);
    // And a count typed down to zero goes the same way, row and all.
    ui.setNumber(ui.countBox("TSD"), "0");
    expect(ui.goalField.value).toBe("");
    expect(ui.hasCount("TSD")).toBe(false);
  });

  test("a goal written out by hand survives a load exactly as it was", () => {
    // The rule the design turns on. Most codes in existence carry prose, and a
    // builder that rounds one into the nearest spec has eaten somebody's work
    // between two button presses.
    const ui = mount();
    const prose = encodeBlueprint({
      cells: [{ x: 0, y: 0, type: "g" }],
      previews: ["T"],
      hold: null,
      comment: "3TSD not in one combo",
    });
    ui.load(prose);

    expect(ui.goalField.value).toBe("3TSD not in one combo");
    expect(ui.code()).toBe(prose);
    // The counters stand aside and say so rather than showing a wrong total.
    expect(ui.goalRows.hidden).toBe(true);
    expect(ui.goalNote.hidden).toBe(false);
  });

  test("fills the counters from a loose goal without rewording it", () => {
    // "2 TSD + 1 TST" is how the archive writes this one. It reads, so the
    // counters fill in — but the text is the author's until they move a
    // control, and the code that goes back out is the code that came in.
    const ui = mount();
    const loose = encodeBlueprint({
      cells: [{ x: 0, y: 0, type: "g" }],
      previews: ["T"],
      hold: null,
      comment: "2 TSD + 1 TST",
    });
    ui.load(loose);

    expect(ui.countBox("TSD").value).toBe("2");
    expect(ui.countBox("TST").value).toBe("1");
    expect(ui.goalField.value).toBe("2 TSD + 1 TST");
    expect(ui.code()).toBe(loose);

    // Touching a counter is the author asking for the sentence to be rewritten.
    ui.setNumber(ui.countBox("TST"), "2");
    expect(ui.goalField.value).toBe("Clear 2 TSDs and 2 TSTs");
  });
});

describe.skipIf(!hasSolutions)("a puzzle the club actually wrote", () => {
  test("loads into the builder and re-exports the same board", () => {
    // The club authors on bp.tali.software, so "open a real one and edit it" is
    // the first thing anybody will try. The code will not come back byte for
    // byte — a real code carries an active piece and the builder folds it into
    // the queue — but the position has to survive.
    const sourced = archive.filter((puzzle) => Boolean(puzzle.source?.puzzle)).slice(0, 20);
    expect(sourced.length).toBeGreaterThan(10);

    for (const puzzle of sourced) {
      const ui = mount();
      const original = decodeBlueprint(puzzle.source!.puzzle!).pages[0]!;
      ui.load(puzzle.source!.puzzle!);

      const again = ui.page();
      expect(filled(again)).toEqual(filled(original));
      expect(again.queue.previews).toEqual([
        ...(original.piece ? [original.piece.type] : []),
        ...original.queue.previews,
      ]);
      expect(again.queue.hold).toBe(original.queue.hold);
    }
  });
});

/**
 * The draft, played.
 *
 * The run itself belongs to the app — the builder is handed a puzzle to give
 * away and frames to draw — so what is checkable here is exactly the seam: what
 * the draft compiles to, that the board becomes the run's while one is on it,
 * and that the goal the author typed is read back against what the run managed.
 */
describe("testing the draft", () => {
  const frame = (patch: Partial<BoardView> = {}): BoardView => ({
    cells: Array.from({ length: MAX_ROWS }, () => Array.from({ length: COLUMNS }, () => null)),
    visibleRows: MAX_ROWS,
    active: [],
    activeInk: null,
    ghost: [],
    flashRows: [],
    flashStrength: 0,
    dimmed: false,
    ...patch,
  });

  const played = (patch: Partial<RunSnapshot> = {}): RunSnapshot => ({
    phase: "playing",
    attack: 0,
    targetAttack: NO_TARGET,
    piecesPlaced: 0,
    pieceBudget: 2,
    clears: [],
    elapsedMs: 0,
    resets: 0,
    hold: null,
    upcoming: ["T"],
    holdLocked: false,
    ...patch,
  });

  const classAt = (ui: ReturnType<typeof mount>, fromTop: number, column: number) =>
    (ui.grid.children[fromTop]!.children[column]! as unknown as HTMLElement).className;

  const checkLines = (ui: ReturnType<typeof mount>) => [
    ...ui.element.querySelectorAll(".build__check-line"),
  ];

  test("hands over a puzzle to play, not a code to read", () => {
    const ui = mount();
    ui.type(ui.pieces, "TL");
    ui.paint(ui.bottomRow(), 0);
    ui.press("Test");

    expect(ui.tested).toHaveLength(1);
    expect(ui.tested[0]!.queue).toEqual(["T", "L"]);
    expect(ui.tested[0]!.board).toEqual(["G........."]);
  });

  test("refuses a draft with nothing to place, and says why", () => {
    const ui = mount();
    ui.paint(ui.bottomRow(), 0);
    ui.press("Test");

    expect(ui.tested).toEqual([]);
    expect(ui.warning.textContent).toContain("queue");
  });

  test("the board is the run's while one is on it", () => {
    // The failure this catches is the builder repainting its own stack over a
    // falling piece — the draft and the run both want these two hundred cells,
    // and a redraw from either side while the other holds them is a board
    // showing a position that does not exist.
    const ui = mount();
    ui.type(ui.pieces, "T");
    ui.paint(ui.bottomRow(), 0);
    const floor = ui.bottomRow();

    ui.builder.showTest(frame({ active: [[4, 0]], activeInk: "#b93ecc" }), played());

    expect(classAt(ui, floor, 4)).toContain("build__cell--on");
    expect(classAt(ui, floor, 0)).not.toContain("build__cell--on");
    // And the fields that would edit what is being played are away.
    expect(ui.pieces.hidden).toBe(true);
  });

  test("a click or a keypress on it belongs to the game, not the palette", () => {
    const ui = mount();
    ui.type(ui.pieces, "T");
    ui.paint(ui.bottomRow(), 0);

    ui.builder.showTest(frame(), played());
    ui.paint(ui.bottomRow(), 7);
    ui.key(" ");
    ui.key("z", { ctrlKey: true });
    ui.builder.endTest();

    // Nothing painted, nothing erased, and the undo the run wanted did not
    // lift the stroke out from under it.
    expect(filled(ui.page())).toEqual([{ x: 0, y: 0, type: "g" }]);
  });

  test("gives the board back when the run is put away", () => {
    const ui = mount();
    ui.type(ui.pieces, "T");
    ui.paint(ui.bottomRow(), 0);
    const floor = ui.bottomRow();

    ui.builder.showTest(frame({ active: [[4, 0]], activeInk: "#b93ecc" }), played());
    ui.builder.endTest();

    expect(classAt(ui, floor, 0)).toContain("build__cell--on");
    expect(classAt(ui, floor, 4)).not.toContain("build__cell--on");
    expect(ui.pieces.hidden).toBe(false);
  });

  test("reads the goal back clear by clear, not as one number", () => {
    // The point of the whole feature: "Clear 2 TSDs" is checked as two TSDs.
    // An attack total cannot tell those from a quad and a single.
    const ui = mount();
    ui.type(ui.pieces, "TT");
    ui.type(ui.goalField, "Clear 2 TSDs");

    ui.builder.showTest(frame(), played({ phase: "failed", clears: ["tsd"], attack: 4 }));
    expect(checkLines(ui)).toHaveLength(1);
    expect(checkLines(ui)[0]!.textContent).toContain("2 TSD");
    expect(checkLines(ui)[0]!.className).not.toContain("--met");

    ui.builder.showTest(frame(), played({ phase: "failed", clears: ["tsd", "tsd"], attack: 9 }));
    expect(checkLines(ui)[0]!.className).toContain("--met");
  });

  test("offers the attack the run sent as the goal's missing figure", () => {
    // A shipped puzzle's target comes from its reference solution. This run is
    // the first solution the draft has ever had, so it is the only place the
    // number can come from.
    const ui = mount();
    ui.type(ui.pieces, "T");
    ui.type(ui.goalField, "Clear 1 TSD");
    ui.leave(ui.goalField);

    ui.builder.showTest(frame(), played({ phase: "failed", clears: ["tsd"], attack: 4 }));
    ui.press("Set the goal to 4 attack");

    expect(ui.page().comment).toBe("Clear 1 TSD for 4 attack");
    // Adopting it ends the test, so the sentence it changed is on screen.
    expect(ui.pieces.hidden).toBe(false);
  });

  test("says a prose goal cannot be checked rather than passing it", () => {
    const ui = mount();
    ui.type(ui.pieces, "T");
    ui.type(ui.goalField, "3TSD not in one combo");

    ui.builder.showTest(frame(), played({ phase: "failed", clears: ["tsd"], attack: 12 }));

    expect(checkLines(ui)).toHaveLength(0);
    // And nothing offers to write a figure into somebody's sentence.
    const offers = [...ui.element.querySelectorAll("button")].filter((node) =>
      node.textContent?.startsWith("Set the goal"),
    );
    expect(offers).toEqual([]);
  });
});

describe("the goal, against what a run managed", () => {
  test("counts each clear by name and takes more than asked as met", () => {
    // A goal is a floor. Somebody who asked for two TSDs and found a line with
    // three has met it, and saying otherwise is the tool arguing with the
    // puzzle.
    const spec = { clears: [{ clear: "tsd" as const, count: 2 }], attack: 0 };
    expect(goalReport(spec, { clears: ["tsd", "tsd", "tsd"], attack: 12 })[0]!.met).toBe(true);
    expect(goalReport(spec, { clears: ["tsd", "quad"], attack: 8 })[0]).toEqual({
      label: "TSD",
      want: 2,
      got: 1,
      met: false,
    });
  });

  test("checks attack only when the goal names it", () => {
    expect(goalReport({ clears: [], attack: 0 }, { clears: [], attack: 40 })).toEqual([]);
    expect(goalReport({ clears: [], attack: 18 }, { clears: [], attack: 18 })).toEqual([
      { label: "Attack", want: 18, got: 18, met: true },
    ]);
  });

  test("has nothing to say about a goal it could not parse", () => {
    expect(goalReport(null, { clears: ["tsd", "tsd"], attack: 9 })).toEqual([]);
  });

  test("names the clears the goal never asked for", () => {
    // The commonest confusing result: a quad that empties the board is reported
    // by the engine as a perfect clear and by nothing else, so a goal asking
    // for a quad reads as unmet beside a run that plainly cleared four lines.
    const quad = { clears: [{ clear: "quad" as const, count: 1 }], attack: 0 };
    expect(goalReport(quad, { clears: ["perfect clear"], attack: 14 })[0]!.met).toBe(false);
    expect(extraClears(quad, { clears: ["perfect clear"], attack: 14 })).toBe(
      "Also made 1 Perfect Clear.",
    );
    // Nothing to add when the run did only what was asked.
    expect(extraClears(quad, { clears: ["quad"], attack: 4 })).toBe("");
  });
});
