/**
 * The puzzle builder's model: a board, a queue, a hold and a goal, and the two
 * conversions to and from a `b1@…` blueprint code.
 *
 * Two facts a reader will otherwise hunt for:
 *
 * 1. **Coordinates are blueprint's, not the renderer's.** `y` grows upward and
 *    row 0 is the floor. Cells are keyed by the row-major index `y * COLUMNS +
 *    x`, which is the same index `encode.ts`'s `writeCoordinates` sorts on — so
 *    there is exactly one coordinate convention in here and no boundary to get
 *    wrong. The view flips it once, when it draws.
 * 2. **A code written here cannot be fed to `bun run puzzles`.** The encoder
 *    writes no SetPiece opcode, so every builder code decodes with `piece:
 *    null`, and `tools/build-puzzles.ts` requires an active piece. The output is
 *    a code to paste into blueprint or the club's sheet, not a pipeline input.
 */

import type { BlueprintPage } from "@shared/blueprint/decode";
import { BlueprintDecodeError, decodeBlueprint } from "@shared/blueprint/decode";
import { type BlueprintCell, encodeBlueprint } from "@shared/blueprint/encode";
import { COLUMNS, ROWS, type PieceType } from "@shared/blueprint/playfield";
import { BOARD_HEIGHT } from "@shared/puzzle";

/** What a cell can hold. `u` is the wall outside the field and is never painted. */
export type PaintedCell = PieceType | "g";
export type Paint = PaintedCell | "erase";

export interface BuilderState {
  /** Keyed by `y * COLUMNS + x`. y grows upward; row 0 is the floor. */
  readonly cells: ReadonlyMap<number, PaintedCell>;
  readonly queue: readonly PieceType[];
  readonly hold: PieceType | null;
  readonly goal: string;
}

/** Twenty. The app cannot draw a taller board than it plays on. */
export const MAX_ROWS = BOARD_HEIGHT;
/** The archive's longest real queue is 74, so the cap sits above every existing code. */
export const MAX_QUEUE = 80;
/** The archive's longest goal is 115 characters. */
export const MAX_GOAL = 120;
export const HISTORY_LIMIT = 40;

/**
 * Garbage leads because it is what the club draws: 4,115 of the 4,366 filled
 * cells across the 138 archived puzzles are garbage.
 */
export const PALETTE: readonly Paint[] = ["g", "I", "J", "L", "O", "S", "T", "Z", "erase"];

export const EMPTY_STATE: BuilderState = { cells: new Map(), queue: [], hold: null, goal: "" };

const PIECE_LETTERS: ReadonlySet<string> = new Set(["I", "J", "L", "O", "S", "T", "Z"]);

/** The highest character the comment code page can carry without mangling it. */
const MAX_TEXT_CODE = 127;

/**
 * The typographic characters a goal pasted out of a chat window actually
 * carries, and the ASCII the code page has for them.
 *
 * Substituting rather than dropping, because the code page *has* `'` and `-`:
 * deleting them turns "Don't" into "Dont" and an em dash into a missing word,
 * which is a worse lie than the character not looking quite the same.
 */
const TEXT_SUBSTITUTES: ReadonlyMap<string, string> = new Map([
  ["‘", "'"],
  ["’", "'"],
  ["‚", "'"],
  ["‛", "'"],
  ["“", '"'],
  ["”", '"'],
  ["–", "-"],
  ["—", "-"],
  ["−", "-"],
  // Escaped, because a literal one is a space that is not a space.
  ["\u00A0", " "],
  ["…", "..."],
]);

function clamp(low: number, value: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function cellIndex(x: number, y: number): number {
  return y * COLUMNS + x;
}

/** A new state with `paint` applied at every index. "erase" deletes. */
export function paintCells(
  state: BuilderState,
  indices: Iterable<number>,
  paint: Paint,
): BuilderState {
  const next = new Map(state.cells);
  let changed = false;
  for (const index of indices) {
    if (paint === "erase") {
      if (next.delete(index)) changed = true;
      continue;
    }
    if (next.get(index) === paint) continue;
    next.set(index, paint);
    changed = true;
  }
  return changed ? { ...state, cells: next } : state;
}


/** Tolerant on purpose: "t, l j sZ" is how somebody reads a queue out loud. */
export function parsePieces(text: string): PieceType[] {
  const pieces: PieceType[] = [];
  for (const char of text.toUpperCase()) {
    if (!PIECE_LETTERS.has(char)) continue;
    pieces.push(char as PieceType);
    if (pieces.length === MAX_QUEUE) break;
  }
  return pieces;
}

export function formatPieces(queue: readonly PieceType[]): string {
  return queue.join("");
}

export function parseHold(text: string): PieceType | null {
  return parsePieces(text)[0] ?? null;
}

/**
 * Everything the comment code page can carry, at whatever length that comes to.
 *
 * Not cosmetic. `encode.ts`'s `writeText` iterates code points but reads
 * `char.charCodeAt(0)`, so "🚀 spin" goes out as "\ud83d spin" and comes back
 * mangled; a NUL would terminate the string early.
 *
 * Split from the length cap so a caller can tell "this was too long" from "this
 * had characters the format cannot hold" — `lossFromPage` reports only the
 * first, and 130 emoji are not a goal that overflowed.
 */
function foldGoalText(text: string): string {
  let kept = "";
  for (const char of text) {
    const substitute = TEXT_SUBSTITUTES.get(char);
    const code = char.charCodeAt(0);
    if (substitute === undefined && (code === 0 || code > MAX_TEXT_CODE)) continue;
    kept += substitute ?? char;
  }
  return kept;
}

/**
 * What the goal field is allowed to hold: carryable characters, capped.
 *
 * Filtering at the input means the code always says what is on screen — but
 * only because the view writes the result back into the field on blur.
 */
export function sanitizeGoal(text: string): string {
  return foldGoalText(text).slice(0, MAX_GOAL);
}

export function toBlueprintCells(state: BuilderState): BlueprintCell[] {
  return [...state.cells].map(([index, type]) => ({
    x: index % COLUMNS,
    y: Math.floor(index / COLUMNS),
    type,
  }));
}

export function toCode(state: BuilderState): string {
  return encodeBlueprint({
    cells: toBlueprintCells(state),
    previews: state.queue,
    hold: state.hold,
    // `build-puzzles.ts` reads `page.comment.trim()` as the puzzle's goal, so
    // this is the archive's own field, not a note beside it.
    comment: state.goal,
  });
}

export function fromPage(page: BlueprintPage): BuilderState {
  const cells = new Map<number, PaintedCell>();
  for (const cell of page.playfield.nonEmptyCells()) {
    // Cells above the drawn board are kept, not dropped: they are invisible in
    // the grid but survive re-encoding, so loading a code and copying it back
    // never silently loses somebody's work. They are not silent either —
    // `warningFor` names them, and `Clear board` is what removes them.
    if (cell.type === "u" || cell.type === null) continue;
    if (cell.y < 0 || cell.y >= ROWS) continue;
    cells.set(cellIndex(cell.x, cell.y), cell.type);
  }

  return {
    cells,
    queue: previewsOf(page).slice(0, MAX_QUEUE),
    hold: page.queue.hold,
    goal: sanitizeGoal(page.comment.trim()),
  };
}

/**
 * The fold that makes this cross-compatible, and it mirrors `decodePosition`: a
 * code from bp.tali.software carries an active piece that *is* the first
 * playable piece, and a code written here does not.
 */
function previewsOf(page: BlueprintPage): PieceType[] {
  return page.piece ? [page.piece.type, ...page.queue.previews] : [...page.queue.previews];
}

/**
 * What loading this page will not keep, said in one line, or null.
 *
 * The caps exist to bound the fields, but the code box is refilled from the
 * trimmed board the moment a load lands — so without this, Copy hands back a
 * shorter puzzle than the one that was pasted in and nothing says so.
 */
export function lossFromPage(page: BlueprintPage): string | null {
  const dropped: string[] = [];

  const previews = previewsOf(page).length;
  if (previews > MAX_QUEUE) {
    dropped.push(`${previews - MAX_QUEUE} pieces past the ${MAX_QUEUE} this screen holds`);
  }

  const goal = foldGoalText(page.comment.trim()).length;
  if (goal > MAX_GOAL) {
    dropped.push(`${goal - MAX_GOAL} characters past the ${MAX_GOAL}-character goal`);
  }

  if (dropped.length === 0) return null;
  return `Loaded without ${dropped.join(" and ")}. The code you copy out will not have them.`;
}

/** @throws {BlueprintDecodeError} if the text is not a readable blueprint code. */
export function pageOf(text: string): BlueprintPage {
  // No URL stripping here: `decodeBlueprint` already takes a full
  // bp.tali.software link and tolerates a doubled `b1@b1@` prefix.
  const page = decodeBlueprint(text).pages[0];
  if (!page) throw new BlueprintDecodeError("That code has no pages");
  return page;
}

/** @throws {BlueprintDecodeError} if the text is not a readable blueprint code. */
export function fromCode(text: string): BuilderState {
  return fromPage(pageOf(text));
}

/**
 * The one thing worth saying about this board, or nothing.
 *
 * One at a time by choice: a wall of validation on a creative tool is read once
 * and ignored after that.
 */
export function warningFor(state: BuilderState): string | null {
  const hidden = hiddenCellCount(state);
  if (hidden > 0) {
    // First, because everything else on the screen is a smaller lie than a
    // board that is not showing all of itself. Blueprint's field is 40 rows and
    // this app plays on 20, so a code from anywhere else can carry these.
    const cells = hidden === 1 ? "1 cell" : `${hidden} cells`;
    return (
      `${cells} above row ${MAX_ROWS} cannot be drawn or edited here. ` +
      "They stay in every code you copy out; Clear board is what removes them."
    );
  }

  if (state.queue.length === 0) {
    return "Add pieces to the queue — those are what the solver gets to place.";
  }

  const fullRow = lowestFullRow(state);
  if (fullRow !== null) {
    // Exactly true and worth saying: `createPuzzleEngine` writes these cells in
    // without clearing, so a pre-full row survives into play and hands out
    // attack nobody designed. No archived puzzle has one.
    return `Row ${fullRow + 1} is already full. The game clears it the moment play starts.`;
  }

  if (state.cells.size === 0) {
    return "An empty board is legal, but most puzzles start from a stack.";
  }
  if (state.goal.trim() === "") {
    return "Say what the goal is, so the player knows what they are aiming for.";
  }
  return null;
}

/** Cells the grid cannot reach: the field is 40 rows tall, the screen draws 20. */
export function hiddenCellCount(state: BuilderState): number {
  let hidden = 0;
  for (const index of state.cells.keys()) {
    if (Math.floor(index / COLUMNS) >= MAX_ROWS) hidden += 1;
  }
  return hidden;
}

function lowestFullRow(state: BuilderState): number | null {
  const widths = new Map<number, number>();
  for (const index of state.cells.keys()) {
    // Rows above the drawn board count: the game clears a full one wherever it
    // sits, and `warningFor` has already said those rows are up there.
    const row = Math.floor(index / COLUMNS);
    widths.set(row, (widths.get(row) ?? 0) + 1);
  }
  let lowest: number | null = null;
  for (const [row, width] of widths) {
    if (width < COLUMNS) continue;
    if (lowest === null || row < lowest) lowest = row;
  }
  return lowest;
}

export function summaryOf(state: BuilderState): string {
  const hold = state.hold ? `hold ${state.hold}` : "no hold";
  return `${state.cells.size} cells · ${state.queue.length} pieces · ${hold}`;
}
