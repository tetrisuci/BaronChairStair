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
import {
  BOARD_HEIGHT,
  type BoardCell,
  type ClearName,
  encodeBoard,
  type PuzzlePrompt,
  type RowCode,
} from "@shared/puzzle";

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

// ── The goal, as counts rather than a sentence ───────────────────────────────

/**
 * Why the structured goal is a sentence with a parser behind it, and not fields.
 *
 * A blueprint code carries exactly one free-text comment and nothing else, and
 * that comment *is* the goal — `tools/build-puzzles.ts` reads
 * `page.comment.trim()` straight into `Puzzle.goal`. So counters have nowhere
 * to live but inside that one sentence: whatever the author dials in has to go
 * out as words a player reads on the sheet, and be recognised again coming back
 * in. There is no second field to hide a serialisation in, and inventing one
 * inside the comment ("goal:tsd=2;atk=18") would put a machine's notation on
 * the puzzle sheet.
 *
 * The wording is therefore the club's own rather than ours. "Clear 2 TSDs and 1
 * TST" is written verbatim on fifteen archived puzzles and "Clear 1 TSS, 2
 * TSDs, and 1 TST" — Oxford comma included — on two more, so that is the shape:
 * `Clear` + the counts + `and`. Attack has no settled phrasing in the archive
 * (the nearest is "Send 20."), so it is appended as `for 18 attack`, which
 * reads as English and cannot be mistaken for one more clear count. With no
 * clears at all it stands alone as `Send 18 attack`.
 *
 * Two rules keep the round trip from eating anybody's work:
 *
 * 1. **Parsing is all-or-nothing.** A comment that does not match whole comes
 *    back as `null` and stays free text. "3TSD not in one combo" is a real
 *    archived goal carrying a condition the counters have no room for, and
 *    quietly rounding it down to "3 TSDs" would be a worse tool than one with
 *    no counters at all.
 * 2. **Nothing rewrites the text on its own.** `formatGoal` runs when the
 *    author moves a control, never on load — so a goal that parses loosely
 *    ("2 TSD + TST") shows up in the counters without its own wording being
 *    rephrased behind the author's back.
 */
export interface GoalEntry {
  readonly clear: ClearName;
  readonly count: number;
}

export interface GoalSpec {
  /** In the order the author added them, which is the order the text reads in. */
  readonly clears: readonly GoalEntry[];
  /** Garbage the solve has to send. 0 when the author has not said. */
  readonly attack: number;
}

export const EMPTY_GOAL: GoalSpec = { clears: [], attack: 0 };

/**
 * What each clear is called in a goal, singular.
 *
 * A `Record<ClearName, string>` rather than a list, so a clear added to the
 * vocabulary is a type error here instead of a type the builder silently cannot
 * name. Title case and "TSD" over "T-spin double" because that is how the
 * archive's own goals are written.
 */
export const GOAL_LABELS: Readonly<Record<ClearName, string>> = {
  single: "Single",
  double: "Double",
  triple: "Triple",
  quad: "Quad",
  tss: "TSS",
  tsd: "TSD",
  tst: "TST",
  tsmini: "T Mini",
  spin: "Spin",
  "perfect clear": "Perfect Clear",
};

/** The ten clears, in the order `ClearName` declares them. */
export const CLEAR_NAMES = Object.keys(GOAL_LABELS) as readonly ClearName[];

/** Two digits in the text, so a count can never crowd out the words around it. */
export const MAX_GOAL_COUNT = 99;
/** Three. The archive's heaviest puzzle sends 81. */
export const MAX_GOAL_ATTACK = 999;

/**
 * The other spellings a real goal uses for the same clear.
 *
 * Read-only tolerance: none of these is ever written back out. "Tetris" and
 * "Mini TSD" both appear in the archive, and a goal typed by hand is as likely
 * to say "PC" as "Perfect Clear".
 */
const EXTRA_CLEAR_ALIASES: readonly (readonly [string, ClearName])[] = [
  ["tetris", "quad"],
  ["pc", "perfect clear"],
  ["tsmini", "tsmini"],
  ["mini", "tsmini"],
  ["mini tsd", "tsmini"],
  ["t-spin mini", "tsmini"],
];

const GOAL_ALIASES: ReadonlyMap<string, ClearName> = new Map([
  ...CLEAR_NAMES.map((clear) => [GOAL_LABELS[clear].toLowerCase(), clear] as const),
  ...EXTRA_CLEAR_ALIASES,
]);

/** "2 TSDs", "1 TSD" — the plural is what makes the sentence read as written. */
function nameCount(entry: GoalEntry): string {
  const label = GOAL_LABELS[entry.clear];
  return `${entry.count} ${entry.count === 1 ? label : `${label}s`}`;
}

/** "a", "a and b", "a, b, and c" — the archive uses the Oxford comma. */
function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? "";
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
}

/**
 * The spec as the sentence a player reads. Empty when there is nothing to say.
 *
 * Counts of zero are dropped rather than printed: "0 Quad" is not a goal, it is
 * a control someone turned back down.
 */
export function formatGoal(spec: GoalSpec): string {
  const phrases = spec.clears.filter((entry) => entry.count > 0).map(nameCount);
  const attack = spec.attack > 0 ? `${spec.attack} attack` : "";
  if (phrases.length === 0) return attack === "" ? "" : `Send ${attack}`;
  return `Clear ${joinPhrases(phrases)}${attack === "" ? "" : ` for ${attack}`}`;
}

const GOAL_VERB = /^(?:clear|send|complete|perform)\s+/i;
const ATTACK_TAIL = /\s+for\s+(\d{1,3})\s+attack$/i;
const ATTACK_ALONE = /^(\d{1,3})\s+attack$/i;
/** ", and " before ", ", or the Oxford comma splits into an empty phrase. */
const GOAL_SEPARATOR = /,\s*and\s+|,\s*|\s+and\s+|\s*\+\s*/i;
const GOAL_PHRASE = /^(\d{1,2})\s*(.+)$/;

function readClear(text: string): ClearName | null {
  const label = text.trim().toLowerCase();
  // Exact first: "Spin" would otherwise be read as a plural and lose its "n".
  return GOAL_ALIASES.get(label) ?? GOAL_ALIASES.get(label.replace(/s$/, "")) ?? null;
}

/**
 * The counts behind a goal sentence, or null when it is prose.
 *
 * Null is the common answer and not a failure: most goals ever written are
 * prose, and the caller's job on null is to leave the text alone.
 */
export function parseGoal(text: string): GoalSpec | null {
  const trimmed = text.trim();
  if (trimmed === "") return EMPTY_GOAL;

  let rest = trimmed.replace(GOAL_VERB, "").trim();
  let attack = 0;
  const tail = ATTACK_TAIL.exec(rest);
  if (tail) {
    attack = Number(tail[1]);
    rest = rest.slice(0, tail.index).trim();
  }

  const alone = ATTACK_ALONE.exec(rest);
  // "Send 18 attack for 18 attack" is not a sentence anybody meant.
  if (alone) return tail ? null : { clears: [], attack: Number(alone[1]) };

  const clears: GoalEntry[] = [];
  for (const part of rest.split(GOAL_SEPARATOR)) {
    const phrase = GOAL_PHRASE.exec(part.trim());
    if (!phrase) return null;
    const count = Number(phrase[1]);
    const clear = readClear(phrase[2]!);
    // A repeat means the sentence says something the counters cannot hold —
    // "2 TSDs then 2 TSDs" is an order, not a total. Left as text.
    if (clear === null || count < 1 || clears.some((entry) => entry.clear === clear)) return null;
    clears.push({ clear, count });
  }
  if (clears.length === 0) return null;
  return { clears, attack };
}

/** Whether the sentence this spec makes still fits the comment's budget. */
export function goalFits(spec: GoalSpec): boolean {
  return formatGoal(spec).length <= MAX_GOAL;
}

/** A count set, changed or — at zero — taken out. New clears go on the end. */
export function withGoalEntry(spec: GoalSpec, clear: ClearName, count: number): GoalSpec {
  // Zero means "take this clear out"; a negative means somebody typed a stray
  // minus. Folding the two together deleted the row on a typo while an
  // overshoot like 150 was politely clamped — the same control behaving two
  // different ways at its two ends.
  const asked = Math.floor(count);
  const capped = asked < 0 ? 1 : clamp(0, asked, MAX_GOAL_COUNT);
  if (capped === 0) {
    return { ...spec, clears: spec.clears.filter((entry) => entry.clear !== clear) };
  }
  const known = spec.clears.some((entry) => entry.clear === clear);
  return {
    ...spec,
    clears: known
      ? spec.clears.map((entry) => (entry.clear === clear ? { clear, count: capped } : entry))
      : [...spec.clears, { clear, count: capped }],
  };
}

export function withGoalAttack(spec: GoalSpec, attack: number): GoalSpec {
  return { ...spec, attack: clamp(0, Math.floor(attack) || 0, MAX_GOAL_ATTACK) };
}

/** The clears not yet in the goal — what the "add" control is allowed to offer. */
export function unusedClears(spec: GoalSpec): ClearName[] {
  const used = new Set(spec.clears.map((entry) => entry.clear));
  return CLEAR_NAMES.filter((clear) => !used.has(clear));
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

// ── The draft as something playable ─────────────────────────────────────────

/**
 * Why a draft can be played at all, and what it is missing when it cannot.
 *
 * The queue is the whole of it. `createPuzzleEngine` takes the first preview as
 * the falling piece, so a draft with an empty queue opens on a board with
 * nothing on it to move — which is not a puzzle failing its test, it is a
 * puzzle that has not been written yet.
 */
export function testBlocker(state: BuilderState): string | null {
  if (state.queue.length === 0) {
    return "Add pieces to the queue — a test has nothing to place without them.";
  }
  return null;
}

/**
 * The id every draft plays under.
 *
 * Zero, because no archived puzzle has it: a test never touches a leaderboard,
 * a sitting or a submission, so the only thing this number has to do is fail to
 * collide with a real sheet if one is ever put beside it.
 */
export const DRAFT_ID = 0;

/**
 * The attack target for a draft whose goal names no figure.
 *
 * A real puzzle's target comes from its reference solution, and a draft has no
 * solution — so there is nothing honest to put here. Past anything a queue can
 * send is the useful answer rather than zero: at zero `meetsTarget` is true
 * before the first piece lands and the test ends having proved nothing, where
 * up here the run plays every piece out and the builder reports what the author
 * actually managed. That number is then one button from becoming the goal.
 */
export const NO_TARGET = Number.MAX_SAFE_INTEGER;

/**
 * The board as the engine takes it: rows bottom-up, `board[0]` the floor.
 *
 * The same direction the cell map already counts in, so there is no flip here —
 * the only conversion is the author's lowercase `g` becoming the model's `G`.
 * Rows above the twenty on screen are kept: they are part of the code and the
 * engine's field is forty tall, so a test plays the puzzle that would ship.
 */
function draftBoard(state: BuilderState): RowCode[] {
  let height = 0;
  for (const index of state.cells.keys()) {
    height = Math.max(height, Math.floor(index / COLUMNS) + 1);
  }
  const rows = Array.from({ length: height }, (_, y) =>
    Array.from({ length: COLUMNS }, (_, x): BoardCell => {
      const cell = state.cells.get(cellIndex(x, y));
      if (cell === undefined) return null;
      return cell === "g" ? "G" : cell;
    }),
  );
  return encodeBoard(rows);
}

/**
 * The draft as a puzzle to play — everything the engine reads, nothing else.
 *
 * The title, author and difficulty are placeholders because a test has no
 * audience: the only surfaces that would show them are the credits strip and
 * the archive, and a draft reaches neither.
 */
export function toPuzzle(state: BuilderState): PuzzlePrompt {
  const attack = parseGoal(state.goal)?.attack ?? 0;
  return {
    id: DRAFT_ID,
    title: "Draft",
    author: "",
    difficulty: 0,
    goal: state.goal,
    set: null,
    board: draftBoard(state),
    queue: [...state.queue],
    hold: state.hold,
    targetAttack: attack > 0 ? attack : NO_TARGET,
  };
}
