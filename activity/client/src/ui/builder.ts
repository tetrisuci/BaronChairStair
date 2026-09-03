/**
 * The puzzle builder: lay out a board, say which pieces the solver gets, and
 * take a `b1@…` code away with you.
 *
 * The club authors every puzzle on bp.tali.software, so the only output that is
 * worth anything is a code that site and our own decoder both read. That is why
 * this screen ends at a text field with Copy and Load beside it rather than at a
 * save button: the code *is* the artefact, and it is one ⌘C from wherever it is
 * going next.
 *
 * Known limits, so they are not discovered later:
 *
 * - **A code written here cannot be fed to `bun run puzzles`.** The encoder
 *   writes no SetPiece opcode, so a builder code decodes with `piece: null` and
 *   `tools/build-puzzles.ts` refuses it. Paste it into blueprint or the club's
 *   sheet instead.
 * - **The trip out to bp.tali.software is unproven.** The encoder's tests show
 *   decode → encode → decode is stable across all 138 archived codes under *our*
 *   decoder; nothing local can show tali's site reads what we write. Because we
 *   write no active piece, a reader opens our code with the first preview in
 *   hand rather than on the board — which is why the first glyph in the queue
 *   strip is boxed and says so.
 * - **`touch-action: none` on the grid** means a touch user cannot scroll the
 *   screen by dragging on the board, the largest target on it. They scroll from
 *   the rails or the margins. That is the price of painting.
 * - **The painted board carries colour only.** The swatches are labelled, so
 *   choosing a paint is colour-safe; telling S from Z from garbage on the board
 *   is not. Letters in 24px cells were tried and read as noise.
 * - **Nothing here checks that a puzzle is solvable.** It writes a position;
 *   whether the position has an answer is the author's problem.
 */

import { COLUMNS } from "@shared/blueprint/playfield";
import { BlueprintDecodeError } from "@shared/blueprint/decode";
import { MINO_INK } from "../render/skin";
import { pieceGlyph } from "../render/piece-glyph";
import { el, panel, replaceChildren } from "./dom";
import { copyText } from "./share";
import {
  type BuilderState,
  type Paint,
  type PaintedCell,
  cellIndex,
  EMPTY_STATE,
  formatPieces,
  fromPage,
  HISTORY_LIMIT,
  lossFromPage,
  MAX_GOAL,
  MAX_QUEUE,
  MAX_ROWS,
  PALETTE,
  pageOf,
  paintCells,
  parseHold,
  parsePieces,
  sanitizeGoal,
  summaryOf,
  toCode,
  warningFor,
} from "./builder-state";

/** How long a copy button wears its own result before going back to its label. */
const COPIED_MESSAGE_MS = 1600;
const HOLD_GLYPH_CELL = 13;
const QUEUE_GLYPH_CELL = 9;
const RIGHT_BUTTON = 2;

export interface BuilderCallbacks {
  readonly onClose: () => void;
}

/**
 * The three parts of the deck, not one card.
 *
 * The board is the thing being made here, so it is mounted where the game's
 * board goes — the centre stage, with the controls in the rails either side.
 * As a column inside a single panel it drew about 260px wide in a Discord
 * window and still ran off the bottom of the card, which is not a surface
 * anybody can paint a stack on.
 */
export interface Builder {
  readonly board: HTMLElement;
  readonly left: HTMLElement;
  readonly right: HTMLElement;
}

function swatchLabel(paint: Paint): string {
  if (paint === "erase") return "ERASE";
  return paint === "g" ? "GARB" : paint;
}

function inkFor(paint: PaintedCell): string {
  return MINO_INK[paint === "g" ? "G" : paint];
}

function clamp(low: number, value: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** One entry on the undo stack: the state to go back to, and how much of it. */
interface Step {
  readonly state: BuilderState;
  readonly restores: "board" | "everything";
}

/** Unique per builder, so two of them could share a document without colliding. */
let builderSerial = 0;

export function createBuilder(callbacks: BuilderCallbacks): Builder {
  const idPrefix = `build${(builderSerial += 1)}`;
  let bench: BuilderState = EMPTY_STATE;
  let paint: Paint = "g";
  let history: Step[] = [];
  /** A cell index, for the keyboard. Not a selection — nothing else reads it. */
  let cursor = 0;
  /** Non-null only between a pointerdown and the pointerup that ends the stroke. */
  let stroke: {
    /** What the whole drag lays down; null erases. Fixed at pointerdown. */
    fill: PaintedCell | null;
    live: Map<number, PaintedCell>;
    seen: Set<number>;
    changed: boolean;
  } | null = null;
  /** Grid children, top-left first. Rebuilt only when the board changes height. */
  let cellNodes: HTMLElement[] = [];

  // ── Controls ───────────────────────────────────────────────────────────────

  const swatches = PALETTE.map((option) => {
    const chip = el("span", { class: "build__chip" });
    if (option !== "erase") chip.style.background = inkFor(option);
    const button = el(
      "button",
      {
        class: `build__swatch${option === "erase" ? " build__swatch--erase" : ""}`,
        attrs: { type: "button", role: "radio", "aria-checked": "false" },
      },
      chip,
      el("span", { class: "build__key", text: swatchLabel(option) }),
    );
    button.addEventListener("click", () => {
      paint = option;
      render();
    });
    return button;
  });
  const palette = el(
    "div",
    { class: "build__palette", attrs: { role: "radiogroup", "aria-label": "Paint" } },
    ...swatches,
  );

  const grid = el("div", {
    class: "build__grid",
    attrs: {
      role: "grid",
      "aria-label": "Puzzle board",
      tabindex: 0,
      "aria-colcount": COLUMNS,
      "aria-rowcount": MAX_ROWS,
    },
  });

  const holdBay = el("div", { class: "bay build__hold" });

  const pieces = el("input", {
    class: "build__field build__pieces",
    attrs: {
      type: "text",
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
      maxlength: MAX_QUEUE,
      placeholder: "TLJSZOI",
      "aria-label": "Piece queue",
    },
  });
  const strip = el("div", { class: "build__strip" });

  const holdField = el("input", {
    class: "build__field build__letter",
    attrs: {
      type: "text",
      maxlength: 1,
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
      placeholder: "—",
      "aria-label": "Hold piece",
    },
  });

  const goalField = el("input", {
    class: "build__field",
    attrs: {
      type: "text",
      maxlength: MAX_GOAL,
      placeholder: "Clear 2 TSDs",
      "aria-label": "Goal",
    },
  });

  const codeField = el("input", {
    class: "build__field build__code",
    attrs: {
      type: "text",
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
      placeholder: "b1@… or a bp.tali.software link",
      "aria-label": "Blueprint code",
    },
  });

  const count = el("p", { class: "explore__count" });
  const warning = el("p", { class: "note build__warning" });

  const copy = el("button", { class: "btn btn--small", text: "Copy" });
  const load = el("button", { class: "btn btn--small", text: "Load" });
  const undoButton = el("button", { class: "btn btn--small", text: "Undo" });
  const clear = el("button", { class: "btn btn--small", text: "Clear board" });
  const close = el("button", { class: "btn", text: "Back to the menu" });

  // ── The screen ─────────────────────────────────────────────────────────────

  /*
   * Each panel's caption is the label for the one control under it, which is
   * why nothing here is wrapped in an `explore__row`: a 72px label column
   * beside a field is most of a rail's width spent saying what the caption
   * already said. The fields keep their own `aria-label`s regardless.
   */
  const board = el("div", { class: "build__board" }, grid);

  const left = el(
    "div",
    { class: "rail rail--left" },
    panel(
      "Paint",
      {},
      el("p", { class: "rush__blurb", text: "Pick a block and drag on the board." }),
      palette,
      el("p", {
        class: "note build__legend",
        text: "arrows move · space fills · backspace clears",
      }),
    ),
    panel("Edit", {}, el("div", { class: "btnrow" }, undoButton, clear)),
    close,
  );

  const right = el(
    "div",
    { class: "rail" },
    panel("Hold", {}, holdBay, holdField),
    panel("Queue", {}, pieces, strip),
    panel("Goal", {}, goalField, count, warning),
    panel(
      "Code",
      {},
      codeField,
      el("div", { class: "btnrow" }, copy, load),
      el("p", { class: "note", text: "Copy it out when the board looks right." }),
    ),
  );

  // ── The one funnel ─────────────────────────────────────────────────────────

  /** Nothing else assigns `bench`, so nothing else can skip the redraw. */
  function setBench(next: BuilderState): void {
    bench = next;
    render();
  }

  /**
   * A change worth an undo step, which in a painting tool means the board.
   *
   * `"everything"` is for Load, the one action that replaces the fields as well:
   * undoing it has to put those back, where undoing a stroke must not, or a goal
   * typed after a stroke would vanish along with the stroke.
   */
  function commit(next: BuilderState, restores: "board" | "everything" = "board"): void {
    // Reference equality is enough: `paintCells` hands the same state back when
    // nothing moved, and an undo step that replays as nothing is worse than no
    // step at all — it is a press of Undo that appears to have been ignored.
    if (next === bench) return;
    history = [...history, { state: bench, restores }].slice(-HISTORY_LIMIT);
    setBench(next);
  }

  /**
   * A change to a text field: applied, but never pushed.
   *
   * The board is what Undo is for. Every keystroke used to push a step, so a
   * 40-character goal evicted the whole stack and took the board's history with
   * it — and the fields already have the browser's own undo inside them.
   */
  function edit(next: BuilderState): void {
    setBench(next);
  }

  function undo(): void {
    const step = history[history.length - 1];
    if (!step) return;
    history = history.slice(0, -1);
    setBench(
      step.restores === "everything" ? step.state : { ...bench, cells: step.state.cells },
    );
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  const cellId = (index: number): string => `${idPrefix}-cell-${index}`;

  /** The grid node holding a cell index, or null when that row is off the board. */
  function nodeAt(index: number): HTMLElement | null {
    const row = Math.floor(index / COLUMNS);
    if (row < 0 || row >= MAX_ROWS) return null;
    return cellNodes[(MAX_ROWS - 1 - row) * COLUMNS + (index % COLUMNS)] ?? null;
  }

  function applyCell(node: HTMLElement, index: number, type: PaintedCell | undefined): void {
    const isCursor = index === cursor;
    node.className = `build__cell${type ? " build__cell--on" : ""}${
      isCursor ? " build__cell--cursor" : ""
    }`;
    node.style.background = type ? inkFor(type) : "";
    const column = (index % COLUMNS) + 1;
    const row = Math.floor(index / COLUMNS) + 1;
    // "from the floor" is load-bearing: the row this cell is announced as
    // sitting in — `aria-rowindex`, counted down the document like every other
    // grid — is the opposite number, and the two contradicting each other
    // silently is what this says out loud.
    node.setAttribute(
      "aria-label",
      `column ${column}, row ${row} from the floor, ${type ?? "empty"}`,
    );
  }

  function rebuildGrid(): void {
    cellNodes = [];
    const rows: HTMLElement[] = [];
    // Top row first, because that is document order; the model counts up from
    // the floor, so the two are read in opposite directions on purpose.
    for (let fromTop = 0; fromTop < MAX_ROWS; fromTop++) {
      const cells: HTMLElement[] = [];
      for (let column = 0; column < COLUMNS; column++) {
        const index = cellIndex(column, MAX_ROWS - 1 - fromTop);
        const node = el("div", {
          class: "build__cell",
          attrs: {
            role: "gridcell",
            id: cellId(index),
            "aria-colindex": column + 1,
          },
        });
        cells.push(node);
        cellNodes.push(node);
      }
      rows.push(
        el(
          "div",
          { class: "build__row", attrs: { role: "row", "aria-rowindex": fromTop + 1 } },
          ...cells,
        ),
      );
    }
    grid.setAttribute("aria-rowcount", String(MAX_ROWS));
    replaceChildren(grid, ...rows);
  }

  function render(): void {
    cursor = clamp(0, cursor, MAX_ROWS * COLUMNS - 1);
    const code = toCode(bench);

    swatches.forEach((button, index) => {
      const on = PALETTE[index] === paint;
      button.classList.toggle("build__swatch--on", on);
      button.setAttribute("aria-checked", String(on));
    });

    if (grid.childElementCount !== MAX_ROWS) rebuildGrid();
    for (let fromTop = 0; fromTop < MAX_ROWS; fromTop++) {
      for (let column = 0; column < COLUMNS; column++) {
        const index = cellIndex(column, MAX_ROWS - 1 - fromTop);
        const node = cellNodes[fromTop * COLUMNS + column];
        if (node) applyCell(node, index, bench.cells.get(index));
      }
    }
    // Without this the keyboard cursor is a dashed outline and nothing else:
    // focus never leaves the grid, so a screen reader is never told it moved.
    grid.setAttribute("aria-activedescendant", cellId(cursor));

    replaceChildren(
      holdBay,
      bench.hold
        ? pieceGlyph(bench.hold, { cell: HOLD_GLYPH_CELL })
        : el("span", { class: "label", text: "empty" }),
    );

    replaceChildren(
      strip,
      ...bench.queue.map((piece, index) => {
        const glyph = pieceGlyph(piece, { cell: QUEUE_GLYPH_CELL });
        return index === 0
          ? el(
              "span",
              { class: "build__strip-first", title: "Starts as the falling piece" },
              glyph,
            )
          : glyph;
      }),
    );

    // Written back only when the field is not the one being typed into — the
    // same guard the explorer's search box uses, and for the same reason: the
    // caret is not ours to move.
    if (document.activeElement !== pieces) pieces.value = formatPieces(bench.queue);
    if (document.activeElement !== holdField) holdField.value = bench.hold ?? "";
    if (document.activeElement !== goalField) goalField.value = bench.goal;
    if (document.activeElement !== codeField) codeField.value = code;

    count.textContent = summaryOf(bench);
    const note = warningFor(bench);
    warning.textContent = note ?? "";
    warning.hidden = note === null;

    undoButton.disabled = history.length === 0;
    // The button lighting up *is* the "you pasted something" signal.
    const typed = codeField.value.trim();
    load.disabled = typed === "" || typed === code;
  }

  // ── Painting ───────────────────────────────────────────────────────────────

  /**
   * Which cell a pointer is over, by arithmetic rather than `elementFromPoint`.
   *
   * Exact because neither `.build__grid` nor `.build__row` carries a gap — the
   * ruling is an inset shadow on each cell, not a gutter. It also means touch
   * drags work and no DOM query runs per move.
   *
   * The measurement is the *content* box. `getBoundingClientRect` gives the
   * border box, and `.build__grid` has a 2px border the rows are laid out
   * inside: dividing the border box by ten puts every seam up to two pixels
   * out, which lands a click near a column edge one column over.
   */
  function cellUnder(event: PointerEvent): number {
    const box = grid.getBoundingClientRect();
    // `clientWidth`/`clientLeft` are the content box, and read 0 where nothing
    // is laid out at all (happy-dom) — there the border box is the best there
    // is, and it is what the test supplies.
    const width = grid.clientWidth || box.width;
    const height = grid.clientHeight || box.height;
    const column = clamp(
      0,
      Math.floor((event.clientX - box.left - grid.clientLeft) / (width / COLUMNS)),
      COLUMNS - 1,
    );
    const fromTop = clamp(
      0,
      Math.floor((event.clientY - box.top - grid.clientTop) / (height / MAX_ROWS)),
      MAX_ROWS - 1,
    );
    return cellIndex(column, MAX_ROWS - 1 - fromTop);
  }

  /**
   * One cell of a stroke: written into a live copy of the map and straight onto
   * the node.
   *
   * Deliberately not `commit`. The board grows at the top and the page flows
   * downward, so recomputing its height mid-drag would slide the cells out from
   * under the pointer, and a stroke would land somewhere other than where it was
   * drawn.
   */
  function strokeTo(index: number): void {
    if (!stroke || stroke.seen.has(index)) return;
    stroke.seen.add(index);
    if (stroke.fill === null) stroke.changed = stroke.live.delete(index) || stroke.changed;
    else if (stroke.live.get(index) !== stroke.fill) {
      stroke.live.set(index, stroke.fill);
      stroke.changed = true;
    }
    const node = nodeAt(index);
    if (node) applyCell(node, index, stroke.live.get(index));
  }

  function endStroke(): void {
    if (!stroke) return;
    const { live, changed } = stroke;
    stroke = null;
    // A click that painted nothing — erasing empty space — is not a step worth
    // undoing, and a stack full of them makes Undo useless.
    if (changed) commit({ ...bench, cells: live });
  }

  grid.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    endStroke();
    try {
      grid.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a convenience: the document-level pointerup below is what
      // guarantees the stroke closes.
    }
    grid.focus();

    const index = cellUnder(event);
    // Starting on a cell that already holds the current paint makes the whole
    // drag an eraser, so overshooting a stroke is undone by dragging back.
    const fill =
      paint === "erase" || event.button === RIGHT_BUTTON || bench.cells.get(index) === paint
        ? null
        : paint;
    stroke = { fill, live: new Map(bench.cells), seen: new Set(), changed: false };

    // The keyboard cursor follows the pointer, and its old cell is repainted by
    // hand: a stroke that changes nothing never reaches `render`, and two dashed
    // outlines on one board is a puzzle nobody asked for.
    const vacated = cursor;
    cursor = index;
    const left = nodeAt(vacated);
    if (left) applyCell(left, vacated, stroke.live.get(vacated));
    strokeTo(index);
  });

  grid.addEventListener("pointermove", (event) => {
    if (stroke) strokeTo(cellUnder(event));
  });

  // On the document rather than the grid: a pointer released outside the board
  // still ends the stroke, with or without capture.
  grid.ownerDocument.addEventListener("pointerup", endStroke);
  grid.ownerDocument.addEventListener("pointercancel", endStroke);

  grid.addEventListener("contextmenu", (event) => event.preventDefault());

  // ── Keyboard on the board ──────────────────────────────────────────────────

  /** Returns true when the builder consumed the key. */
  function handleGridKey(event: KeyboardEvent): boolean {
    const key = event.key;
    // The universal undo gesture, in a painting tool. Claimed here because the
    // game's input router does not treat a focused div as typing, so this used
    // to bubble out to the run's undo and die there without a word.
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key.toLowerCase() === "z") {
      undo();
      return true;
    }

    const row = Math.floor(cursor / COLUMNS);
    const column = cursor % COLUMNS;
    const move = (nextColumn: number, nextRow: number): boolean => {
      cursor = cellIndex(clamp(0, nextColumn, COLUMNS - 1), clamp(0, nextRow, MAX_ROWS - 1));
      render();
      return true;
    };

    switch (key) {
      case "ArrowLeft":
        return move(column - 1, row);
      case "ArrowRight":
        return move(column + 1, row);
      case "ArrowUp":
        return move(column, row + 1);
      case "ArrowDown":
        return move(column, row - 1);
      case "Home":
        return move(0, row);
      case "End":
        return move(COLUMNS - 1, row);
      case " ":
      case "Enter": {
        const erasing = paint === "erase" || bench.cells.get(cursor) === paint;
        commit(paintCells(bench, [cursor], erasing ? "erase" : paint));
        return true;
      }
      case "Backspace":
      case "Delete":
        commit(paintCells(bench, [cursor], "erase"));
        return true;
      default:
        return false;
    }
  }

  grid.addEventListener("keydown", (event) => {
    if (!handleGridKey(event)) return;
    event.preventDefault();
    // Load-bearing, and it belongs here rather than in each branch: the game's
    // input router listens on the window in the bubble phase, and the grid is a
    // plain div its "is the player typing" guard does not cover. Every arrow and
    // Space is bound to a game action.
    event.stopPropagation();
  });

  // ── The rest ───────────────────────────────────────────────────────────────

  pieces.addEventListener("input", () => edit({ ...bench, queue: parsePieces(pieces.value) }));
  holdField.addEventListener("input", () => edit({ ...bench, hold: parseHold(holdField.value) }));
  goalField.addEventListener("input", () =>
    edit({ ...bench, goal: sanitizeGoal(goalField.value) }),
  );
  codeField.addEventListener("input", render);

  /**
   * Puts the model's own text back on screen once the caret has left.
   *
   * `render` cannot: it refuses to write into the focused field, which is the
   * only reason the caret survives typing. So a dropped emoji or a letter the
   * queue does not take stays visible in the field while the code carries
   * something else, right up until Copy ships the difference. On blur there is
   * no caret to protect, and what is on screen becomes what gets encoded.
   */
  function writeBackOnBlur(field: HTMLInputElement, read: () => string): void {
    field.addEventListener("blur", () => {
      field.value = read();
    });
  }

  writeBackOnBlur(pieces, () => formatPieces(bench.queue));
  writeBackOnBlur(holdField, () => bench.hold ?? "");
  writeBackOnBlur(goalField, () => bench.goal);

  copy.addEventListener("click", async () => {
    // The field's literal text, so Copy can never disagree with what is on
    // screen — even just after somebody pasted nonsense into it.
    copy.textContent = (await copyText(codeField.value)) ? "Copied!" : "Copy failed";
    setTimeout(() => {
      copy.textContent = "Copy";
    }, COPIED_MESSAGE_MS);
  });

  /** A line for the warning slot that outlasts the render that just ran. */
  function say(message: string): void {
    warning.textContent = message;
    warning.hidden = false;
  }

  load.addEventListener("click", () => {
    try {
      const page = pageOf(codeField.value);
      commit(fromPage(page), "everything");
      // After the commit, because `render` has just refilled the warning slot
      // from the board — and a load that dropped something is the more urgent
      // of the two things that could be said about it.
      const loss = lossFromPage(page);
      if (loss) say(loss);
    } catch (error) {
      // The bench is left exactly as it was: a bad paste costs nothing.
      say(error instanceof BlueprintDecodeError ? error.message : "That is not a blueprint code.");
    }
  });

  undoButton.addEventListener("click", undo);
  // Cells only. Repainting a board is the expensive thing to lose; a queue is
  // cleared by selecting the field and typing.
  // The `bench` on an already-empty board is handed back unchanged so `commit`
  // drops it: clearing nothing is not a step.
  clear.addEventListener("click", () =>
    commit(bench.cells.size === 0 ? bench : { ...bench, cells: new Map() }),
  );
  close.addEventListener("click", () => callbacks.onClose());

  render();
  return { board, left, right };
}
