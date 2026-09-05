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
import type { SubmissionVerdict } from "../client/src/ui/builder-submit";
import {
  type BuilderSolve,
  type SubmissionBody,
  DEFAULT_DIFFICULTY,
  MAX_GOAL_COUNT,
  MAX_QUEUE,
  MAX_ROWS,
  NO_TARGET,
} from "../client/src/ui/builder-state";
import { extraClears, goalReport } from "../client/src/ui/builder-test";
import type { BoardView } from "../client/src/render/board";
import { PuzzleRun, type RunSnapshot } from "../client/src/game/runner";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
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

/** What the pretend server reads out of a solve. Any number nobody else picks. */
const VERDICT_ATTACK = 7;

function mount(options: { guest?: boolean } = {}) {
  const tested: PuzzlePrompt[] = [];
  const submitted: SubmissionBody[] = [];
  /**
   * The app's half of a submission, and what it answers with.
   *
   * Swappable per test because the two outcomes are two different features: a
   * success spends the solve and reports the server's own number, a rejection
   * has to put the server's own sentence on screen with the draft left intact.
   */
  let answer: () => Promise<SubmissionVerdict> = async () => ({ attack: VERDICT_ATTACK });
  let inFlight: Promise<unknown> = Promise.resolve();
  const builder = createBuilder(
    {
      onClose: () => {},
      // The app plays the draft; the test stands in for it, so what the
      // builder hands over is inspectable on its own.
      onTest: (puzzle) => tested.push(puzzle),
      onStopTest: () => builder.endTest(),
      // The same stand-in on the same wall: the builder never sees an Api, so
      // the body it compiled arrives here whole and is inspectable as itself.
      onSubmit: (draft) => {
        submitted.push(draft);
        const pending = answer();
        inFlight = pending;
        return pending;
      },
    },
    options.guest ?? false,
  );
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
    /** Every body it has handed over to be filed, in order. */
    submitted,
    /** The Submit button by class, because a success renames it for a moment. */
    submitButton: () => find<HTMLButtonElement>(".build__submit"),
    submitNote: find<HTMLElement>(".build__submit-note"),
    /** Answer the next submission with a refusal, the way the route would. */
    refuseWith(message: string): void {
      answer = () => Promise.reject(new Error(message));
    },
    /**
     * Wait for the submission in flight to have been reported on.
     *
     * The rejection is swallowed here and only here: the builder is the side
     * that reports it, and a test awaiting the same promise must not fail for
     * having been told what it asked to be told.
     */
    async settled(): Promise<void> {
      try {
        await inFlight;
      } catch {
        // Reported on the screen; asserted there.
      }
    },
    pieces: find<HTMLInputElement>(".build__pieces"),
    holdField: find<HTMLInputElement>(".build__letter"),
    goalField: find<HTMLInputElement>('input[aria-label="Goal"]'),
    titleField: find<HTMLInputElement>('input[aria-label="Title"]'),
    difficultyField: find<HTMLInputElement>('input[aria-label="Difficulty"]'),
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
    aim: null,
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

/**
 * A draft has no reference solution and no honest target until its author plays
 * it, so the run they make is the only thing a submission can be built from.
 * These pin the half of that the builder owns: what it is given, how long it
 * keeps it, and the one edit that must throw it away.
 */
describe("the solve a test leaves behind", () => {
  const FRAME_MS = 1000 / 60;
  /** Frames to wait for a hard-dropped piece to lock. Anything grounded locks well inside it. */
  const PATIENCE = 300;

  /**
   * A hand-turned clock and frame loop, so a draft can actually be played here.
   *
   * `runner-undo.test.ts` builds the same rig for the same reason, and this is
   * a copy of it: sharing it means editing that suite, which this change has no
   * business touching. The run below is the real one — the real engine, the
   * real log — because the whole point of the first assertion is that what the
   * builder ends up holding came out of a run rather than out of the test.
   */
  let clock = 0;
  let scheduled: FrameRequestCallback | null = null;
  const savedTiming = {
    performance: globalThis.performance,
    request: globalThis.requestAnimationFrame,
    cancel: globalThis.cancelAnimationFrame,
  };

  beforeAll(() => {
    globalThis.performance = { now: () => clock } as unknown as Performance;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      scheduled = callback;
      return 1;
    };
    globalThis.cancelAnimationFrame = () => {
      scheduled = null;
    };
  });

  // Restored for the rest of the file, which wants Bun's own clock back.
  afterAll(() => {
    globalThis.performance = savedTiming.performance;
    globalThis.requestAnimationFrame = savedTiming.request;
    globalThis.cancelAnimationFrame = savedTiming.cancel;
  });

  /**
   * The app's half of a test run, written out here.
   *
   * `App` owns the run and needs a Discord connection and a canvas to exist at
   * all, so what stands in for it is the three callbacks `startBuilderTest`
   * hands a `PuzzleRun`: the frames back to `showTest`, the log to `keepSolve`.
   * That means these prove the builder's side of the contract and not app.ts's
   * own wiring, which nothing in this suite reaches.
   */
  function playDraft(ui: ReturnType<typeof mount>): PuzzleRun {
    const puzzle = ui.tested[ui.tested.length - 1];
    if (!puzzle) throw new Error("the builder handed over nothing to play");
    clock = 0;
    scheduled = null;
    const run = new PuzzleRun(puzzle, DEFAULT_HANDLING, {
      onFrame: (view, snapshot) => ui.builder.showTest(view, snapshot),
      onFinish: (snapshot, events) =>
        ui.builder.keepSolve({ snapshot, events: [...events], handling: DEFAULT_HANDLING }),
      onLock: () => {},
    });
    run.renderOnce();
    return run;
  }

  /**
   * A builder holding one O over an empty board, tested and played to the end.
   *
   * One piece and nothing under it, so the run ends on the first lock: the goal
   * is empty, which means the draft carries `NO_TARGET` and plays its queue out
   * rather than stopping at a figure.
   */
  function solved(): ReturnType<typeof mount> {
    const ui = mount();
    ui.type(ui.pieces, "O");
    ui.press("Test");

    const run = playDraft(ui);
    run.input("hardDrop", true);
    for (let frame = 0; frame < PATIENCE && run.snapshot().piecesPlaced === 0; frame++) {
      const step = scheduled;
      if (!step) break;
      clock += FRAME_MS;
      step(clock);
    }
    run.dispose();
    ui.builder.endTest();
    return ui;
  }

  test("a run played to the end leaves a log to submit", () => {
    // The bug: the app answered `onFinish` with `() => undefined` on the
    // grounds that a test files nothing. Nothing is filed — but the server
    // derives a submission's target and its reference solution by replaying
    // this log, so throwing it away left an author who had just solved their
    // own puzzle with nothing whatsoever to send.
    const ui = solved();

    const solve = ui.builder.keptSolve();
    expect(solve).not.toBeNull();
    expect(solve!.events.length).toBeGreaterThan(0);
    expect(solve!.snapshot.piecesPlaced).toBe(1);
    // The controls it was typed under travel with it, because one log read
    // under two handlings is two different games.
    expect(solve!.handling).toEqual(DEFAULT_HANDLING);
  });

  test("painting one cell afterwards throws it away", () => {
    // The one nothing else in the stack can catch. A log only means anything
    // against the board it was played on, and `server/puzzles.ts` says outright
    // that validating a puzzle checks its shape and never its solution — so a
    // solve kept across a repaint ships as a reference solution that does not
    // solve, behind a target nobody can reach.
    const ui = solved();
    expect(ui.builder.keptSolve()).not.toBeNull();

    ui.paint(ui.bottomRow(), 0);

    expect(ui.builder.keptSolve()).toBeNull();
  });

  test("rewording the goal afterwards keeps it", () => {
    // The goal says what the puzzle asks for; the log says what was played, and
    // the board, the queue and the hold are the whole of what the solver was
    // handed. Clearing here would also break the builder's own headline move:
    // "Set the goal to N attack" ends the test and then writes the run's attack
    // into the sentence, destroying the run it was offering to describe.
    const ui = solved();

    ui.type(ui.goalField, "Clear the board");

    expect(ui.builder.keptSolve()).not.toBeNull();
  });

  test("a change to the queue or the hold throws it away too", () => {
    // Both are dealt to the solver, so both change what a log means: a piece
    // added to the queue makes the recorded run one that stopped early, and a
    // hold added is a piece that run was never offered.
    const queued = solved();
    queued.type(queued.pieces, "OT");
    expect(queued.builder.keptSolve()).toBeNull();

    const held = solved();
    held.type(held.holdField, "T");
    expect(held.builder.keptSolve()).toBeNull();
  });

  test("a test nobody played does not displace the one they did", () => {
    // Every way out of a test hands the log over, Stop on a run with no
    // keystrokes in it included — the app cannot tell that from a real attempt
    // without reading the log, so the builder does. Without it, pressing Test
    // and changing your mind wipes the solve you already had.
    const ui = solved();
    const kept = ui.builder.keptSolve();

    ui.press("Test");
    const run = playDraft(ui);
    ui.builder.keepSolve({
      snapshot: run.snapshot(),
      events: [...run.log()],
      handling: DEFAULT_HANDLING,
    });
    run.dispose();
    ui.builder.endTest();

    expect(ui.builder.keptSolve()).toBe(kept);
  });

  test("a draft edited while the run is on it does not keep that run", () => {
    // The stash's whole guarantee is maintained in one place — `setBench` drops
    // a solve the moment the draft stops matching it — and that only holds
    // *forward* from a base case nothing establishes. `keepSolve` records no
    // draft and checks none, so it will pin a log to whatever is on the bench
    // when it arrives, and a draft that moved while the run was playing is
    // never noticed.
    //
    // One live way in: a stroke opened before the test and released during it.
    // `endStroke` sits on the document and has no `testing` guard, so the
    // commit lands mid-run — a second finger on a touch screen, or Tab and
    // Enter onto Test with the mouse button still down. What ships is a
    // reference solution and a target computed on a board nobody submitted:
    // the same log replayed against the draft on screen puts the O one row
    // higher, and `POST /api/submissions` derives from the board it is sent,
    // so nothing downstream can see the difference.
    //
    // The fix is to make the base case a recorded fact rather than an
    // assumption: have `startTest` stash `bench` alongside the puzzle it hands
    // over, and have `keepSolve` refuse a solve whose draft is not `samePlay`
    // with the bench it is landing on.
    const ui = mount();
    ui.type(ui.pieces, "O");

    // The finger goes down and stays down. Nothing is committed: `endStroke` is
    // what commits, and it has not run yet.
    ui.grid.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        clientX: 0.5 * CELL,
        clientY: (ui.bottomRow() + 0.5) * CELL,
      }) as never,
    );
    const playedOn = ui.code();

    ui.press("Test");
    const run = playDraft(ui);

    // The finger lifts. The cell that was drawn is committed under the run.
    window.document.dispatchEvent(new window.Event("pointerup", { bubbles: true }) as never);
    expect(ui.code()).not.toBe(playedOn);

    run.input("hardDrop", true);
    for (let frame = 0; frame < PATIENCE && run.snapshot().piecesPlaced === 0; frame++) {
      const step = scheduled;
      if (!step) break;
      clock += FRAME_MS;
      step(clock);
    }
    run.dispose();
    ui.builder.endTest();

    // A log played on the empty board, held against a board with a cell in it.
    expect(ui.builder.keptSolve()).toBeNull();
  });

  test("a retest abandoned after one keystroke keeps the solve it displaced", () => {
    // "An attempt with no inputs in it is not a solve" is the right idea drawn
    // one keystroke short. A run that placed nothing sends nothing, and
    // `POST /api/submissions` refuses a zero-attack solve outright — so the log
    // this keeps can never become a submission, while the one it just threw
    // away could have. Press Play again, tap a key, change your mind, and the
    // solve you already had is gone with the board never having moved.
    //
    // The fix is one word in `keepSolve`: refuse on `snapshot.piecesPlaced ===
    // 0` rather than on `events.length === 0`.
    const ui = solved();
    const good = ui.builder.keptSolve();
    expect(good?.snapshot.piecesPlaced).toBe(1);

    ui.press("Play again");
    const run = playDraft(ui);
    run.input("moveLeft", true);
    // The app's `endBuilderRun`: every abandoned run is handed over too.
    ui.builder.keepSolve({
      snapshot: run.snapshot(),
      events: [...run.log()],
      handling: run.handling,
    });
    run.dispose();
    ui.builder.endTest();

    expect(ui.builder.keptSolve()).toBe(good);
  });
});

/**
 * The last thing the builder does, and every reason it refuses to do it.
 *
 * `POST /api/submissions` refuses a body outside its bounds rather than
 * repairing one, on the stated grounds that the builder has applied its limits
 * already. These are that claim, held to: a draft the screen would send is a
 * draft the route would take, and a draft it would not send is one the author
 * is told about while the board is still in front of them.
 *
 * The solve here is handed over rather than played. `describe("the solve a test
 * leaves behind")` above already proves a real run reaches `keepSolve` intact,
 * and what these are about is what happens *after* one has — so they take the
 * shorter road through the same door the app uses.
 */
describe("sending a draft for review", () => {
  const solve = (): BuilderSolve => ({
    snapshot: {
      phase: "solved",
      attack: 4,
      targetAttack: NO_TARGET,
      // Above zero, or `keepSolve` drops it: a run that placed nothing is
      // somebody who pressed Test and changed their mind.
      piecesPlaced: 1,
      pieceBudget: 1,
      clears: ["single"],
      elapsedMs: 900,
      resets: 0,
      hold: null,
      upcoming: [],
      holdLocked: false,
    },
    events: [{ frame: 0, type: "keydown", data: { key: "hardDrop", subframe: 0 } }],
    handling: DEFAULT_HANDLING,
  });

  /** A draft with nothing left wrong with it: board, queue, goal, title, run. */
  function ready(options: { guest?: boolean } = {}): ReturnType<typeof mount> {
    const ui = mount(options);
    ui.type(ui.pieces, "O");
    ui.paint(ui.bottomRow(), 0);
    ui.paint(ui.bottomRow() - 1, 3);
    ui.type(ui.goalField, "Clear 1 Single");
    ui.type(ui.titleField, "Well Named");
    // Through Test, because that is what tells the builder which draft the run
    // it is about to be handed was dealt from.
    ui.press("Test");
    ui.builder.keepSolve(solve());
    ui.builder.endTest();
    return ui;
  }

  test("is offered once the draft has a name, a goal and a run behind it", () => {
    const ui = ready();

    expect(ui.submitButton().disabled).toBe(false);
    // Nothing to say when nothing is wrong: the line under the button is for
    // the one refusal that stands, and an empty one is not a refusal.
    expect(ui.submitNote.textContent).toBe("");
  });

  test("will not send a puzzle with no name on it", () => {
    // `readTitle` answers an empty title with a 400 after the whole body has
    // crossed the wire. The field is one line away from the button, so the
    // author is told here instead.
    const ui = ready();
    ui.type(ui.titleField, "");

    expect(ui.submitButton().disabled).toBe(true);
    expect(ui.submitNote.textContent).toContain("title");
  });

  test("will not send a puzzle nobody has played", () => {
    // The rule the route exists to hold. There is nothing honest to put in
    // `targetAttack` for a board nobody has solved, and a target nobody earned
    // is a bar every other player is then scored against.
    const ui = mount();
    ui.type(ui.pieces, "O");
    ui.paint(ui.bottomRow(), 0);
    ui.type(ui.goalField, "Clear 1 Single");
    ui.type(ui.titleField, "Well Named");

    expect(ui.submitButton().disabled).toBe(true);
    expect(ui.submitNote.textContent).toContain("Play it yourself");
  });

  test("tells a guest before the click rather than after it", () => {
    // The route answers a guest with a 403: every guest is the same player, so
    // there is no name to credit and no quota that tells two of them apart.
    // Finding that out at the end of an evening's work is the wrong place.
    const ui = ready({ guest: true });

    expect(ui.submitButton().disabled).toBe(true);
    expect(ui.submitNote.textContent).toContain("Sign in");
    // And the refusal outranks every other one: no amount of editing lifts it,
    // so a guest is never sent off to write a title that changes nothing.
    ui.type(ui.titleField, "");
    expect(ui.submitNote.textContent).toContain("Sign in");
    // Nothing leaves, even if a click gets past a disabled button.
    ui.press("Submit");
    expect(ui.submitted).toEqual([]);
  });

  test("sends the board the solve was played on, and nothing the server derives", () => {
    // The whole contract in one assertion. The server replays the log against
    // the board sent beside it, so a body carrying anything but the draft that
    // run was made on is a target and a reference solution that are
    // self-consistent and wrong — which nothing downstream can catch, because
    // validating a puzzle checks its shape and never its solution.
    const ui = ready();
    const played = solve();

    ui.press("Submit");

    expect(ui.submitted).toHaveLength(1);
    const body = ui.submitted[0]!;
    expect(body.board).toEqual(["G.........", "...G......"]);
    expect(body.queue).toEqual(["O"]);
    expect(body.hold).toBeNull();
    expect(body.title).toBe("Well Named");
    expect(body.goal).toBe("Clear 1 Single");
    expect(body.claimedDifficulty).toBe(DEFAULT_DIFFICULTY);
    expect(body.events).toEqual(played.events);
    // The controls the log was typed under travel with it, or the server
    // replays a run nobody played.
    expect(body.handling).toEqual(DEFAULT_HANDLING);
    // None of these is the author's to name. `toPuzzle` would have supplied a
    // `targetAttack` of `NO_TARGET` — `MAX_SAFE_INTEGER`, which `assertValid`
    // waves through as a puzzle nobody can ever solve.
    expect(body).not.toHaveProperty("targetAttack");
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("author");
    expect(body).not.toHaveProperty("solution");
  });

  test("carries the author's rating on the scale the archive actually uses", () => {
    // Twenty, because the archive really contains one — a control that stopped
    // at ten could not describe a puzzle already on the list.
    const ui = ready();
    ui.setNumber(ui.difficultyField, "20");
    ui.press("Submit");
    expect(ui.submitted[0]!.claimedDifficulty).toBe(20);

    // And past the end of the scale is a typo, answered by clamping rather
    // than by a refusal on a field that cannot stay wrong.
    const over = ready();
    over.setNumber(over.difficultyField, "40");
    over.press("Submit");
    expect(over.submitted[0]!.claimedDifficulty).toBe(20);
  });

  test("keeps the board after a success and spends the solve", async () => {
    const ui = ready();
    const code = ui.code();

    ui.press("Submit");
    await ui.settled();

    // The board stays: it is the author's work, and the code in the box is
    // still the artefact they came for.
    expect(ui.code()).toBe(code);
    // The solve does not. Left in place, a second press files the same puzzle
    // again under the same title — and the only thing in the way is the
    // route's three-pending quota, so one impatient click costs an author two
    // of their three slots.
    expect(ui.builder.keptSolve()).toBeNull();
    expect(ui.submitButton().disabled).toBe(true);
    // The server's own number, not the run's: it is the target every later
    // player is set, and the two disagreeing is what an author cannot debug.
    expect(ui.submitNote.textContent).toContain(`${VERDICT_ATTACK} attack`);
  });

  test("says what the server said when it refuses, and keeps the draft", async () => {
    // `ApiError` carries the server's own sentence — the entire reason the API
    // renders JSON errors rather than Hono's plain text. Swallowing it would
    // leave an author with a button that did nothing.
    const ui = ready();
    ui.refuseWith("Your solve sends no attack — there is nothing to score");

    ui.press("Submit");
    await ui.settled();

    expect(ui.submitNote.textContent).toContain("sends no attack");
    // A failure spends nothing: the run is still theirs and the button works,
    // or a refusal an author could fix would be one they cannot act on.
    expect(ui.builder.keptSolve()).not.toBeNull();
    expect(ui.submitButton().disabled).toBe(false);
  });

  test("stops saying it was sent the moment the draft moves", async () => {
    // "Sent for review" is true about a puzzle, not about a screen. Once the
    // board changes it is describing something that was never filed, and the
    // line goes back to saying what would stop this one going out.
    const ui = ready();
    ui.press("Submit");
    await ui.settled();
    expect(ui.submitNote.textContent).toContain("Sent for review");

    ui.paint(ui.bottomRow(), 5);

    expect(ui.submitNote.textContent).toContain("Play it yourself");
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

describe("the solve that gets submitted was played on the board being submitted", () => {
  test("a run displaced by Play again is not pinned to the new draft", () => {
    // The bypass the first guard left open. `startTest` stamped the draft it
    // was about to hand over *before* calling `onTest` — and the app's
    // `startBuilderTest` opens by draining the outgoing run into `keepSolve`.
    // So on a second Test, the previous run's log was measured against a stamp
    // that already named the board now on screen, and a draft that moved
    // between the two runs was never noticed. Reachable with a stroke still
    // open when Test is activated: a second finger, or Tab-and-Enter with the
    // mouse button down.
    const ui = mount();
    ui.type(ui.pieces, "T");
    ui.paint(ui.bottomRow(), 0);

    // A run on the board as it stands, handed back the way the app hands it.
    ui.press("Test");
    const played = ui.tested[ui.tested.length - 1]!;
    ui.builder.keepSolve({
      snapshot: { piecesPlaced: 1 } as never,
      events: [{ frame: 0, type: "keydown", data: { key: "hardDrop", subframe: 0 } }],
      handling: {} as never,
    });
    expect(ui.builder.keptSolve()).not.toBeNull();

    // The board moves, then Test is pressed again. The stash must not survive
    // onto a board its log was never played on.
    ui.builder.endTest();
    ui.paint(ui.bottomRow(), 5);
    expect(ui.builder.keptSolve()).toBeNull();
    ui.press("Test");
    expect(ui.tested[ui.tested.length - 1]!.board).not.toEqual(played.board);
    expect(ui.builder.keptSolve()).toBeNull();
  });
});
