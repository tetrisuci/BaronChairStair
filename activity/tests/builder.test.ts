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
import { createBuilder } from "../client/src/ui/builder";
import { MAX_QUEUE, MAX_ROWS } from "../client/src/ui/builder-state";
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
  const builder = createBuilder({ onClose: () => {} });
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
    pieces: find<HTMLInputElement>(".build__pieces"),
    holdField: find<HTMLInputElement>(".build__letter"),
    goalField: find<HTMLInputElement>('input[aria-label="Goal"]'),
    warning: find<HTMLElement>(".build__warning"),
    /** The screen row the floor is drawn on, which moves as the stack grows. */
    bottomRow: () => grid.childElementCount - 1,
    type: type_,

    /** Leaving a field, which is when the model's own text goes back into it. */
    leave(field: HTMLInputElement): void {
      field.dispatchEvent(new window.Event("blur") as never);
    },

    /** A key pressed with the board focused, chords included. */
    key(key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}): void {
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
