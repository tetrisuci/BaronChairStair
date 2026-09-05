/**
 * The puzzle builder's model: a board, a queue, a hold, a goal, a title and a
 * rating, and the conversions out of it — to a `b1@…` blueprint code and back,
 * to a puzzle the engine plays, and to the body a submission is filed as.
 *
 * Three facts a reader will otherwise hunt for:
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
 * 3. **The title and the rating are not in the code.** A blueprint page carries
 *    a board, a queue, a hold and one free-text comment, and that comment *is*
 *    the goal — so those two fields exist for a submission and nothing else,
 *    and `fromPage` has nowhere to read them back from.
 */

import type { BlueprintPage } from "@shared/blueprint/decode";
import { BlueprintDecodeError, decodeBlueprint } from "@shared/blueprint/decode";
import { type BlueprintCell, encodeBlueprint } from "@shared/blueprint/encode";
import { COLUMNS, ROWS, type PieceType } from "@shared/blueprint/playfield";
import { MAX_DIFFICULTY, MIN_DIFFICULTY } from "@shared/archive-filter";
import {
  BOARD_HEIGHT,
  type BoardCell,
  type ClearName,
  encodeBoard,
  type PuzzlePrompt,
  type RowCode,
} from "@shared/puzzle";
import type { Handling } from "@shared/tetris/handling";
import type { InputEvent } from "@shared/tetris/verify";
import type { RunSnapshot } from "../game/runner";

/** What a cell can hold. `u` is the wall outside the field and is never painted. */
export type PaintedCell = PieceType | "g";
export type Paint = PaintedCell | "erase";

export interface BuilderState {
  /** Keyed by `y * COLUMNS + x`. y grows upward; row 0 is the floor. */
  readonly cells: ReadonlyMap<number, PaintedCell>;
  readonly queue: readonly PieceType[];
  readonly hold: PieceType | null;
  readonly goal: string;
  /** What the puzzle is called. Required by a submission, absent from the code. */
  readonly title: string;
  /**
   * The author's own 1–20 estimate of how hard this is.
   *
   * A hint for whoever reviews it and nothing more: `dailyTierOf` and `rushBand`
   * both route a puzzle by its difficulty, so the rating that ends up on the
   * archived puzzle is the reviewer's. The server files this one under
   * `claimed_difficulty` for exactly that reason.
   */
  readonly difficulty: number;
}

/** Twenty. The app cannot draw a taller board than it plays on. */
export const MAX_ROWS = BOARD_HEIGHT;
/** The archive's longest real queue is 74, so the cap sits above every existing code. */
export const MAX_QUEUE = 80;
/** The archive's longest goal is 115 characters. */
export const MAX_GOAL = 120;
/**
 * Sixty, which is the cap `server/submission-input.ts` refuses a title past.
 *
 * Written out here rather than imported from the server, the same trade that
 * file makes in the other direction over `MAX_GOAL`: one number in two places
 * costs less than a browser module in the request path or a server module in
 * the bundle. The two are pinned together by the route's own tests.
 */
export const MAX_TITLE = 60;
/**
 * Where the difficulty control starts.
 *
 * Six, the median rating across the archive's 131 rated puzzles — so a control
 * nobody moves lands where most puzzles actually sit. The alternatives were both
 * worse: starting at 1 files every unconsidered draft as the easiest thing in
 * the list, and starting blank makes a required field out of a number the
 * reviewer is going to overrule anyway.
 */
export const DEFAULT_DIFFICULTY = 6;
export const HISTORY_LIMIT = 40;

/**
 * Garbage leads because it is what the club draws: 4,115 of the 4,366 filled
 * cells across the 138 archived puzzles are garbage.
 */
export const PALETTE: readonly Paint[] = ["g", "I", "J", "L", "O", "S", "T", "Z", "erase"];

export const EMPTY_STATE: BuilderState = {
  cells: new Map(),
  queue: [],
  hold: null,
  goal: "",
  title: "",
  difficulty: DEFAULT_DIFFICULTY,
};

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
 *
 * Control characters go the way the title's do, and for the reason
 * `sanitizeTitle` already gives: the submission route refuses them, so folding
 * here turns a paste into a shrug instead of turning the author away at the end
 * with a 400 they cannot see the cause of. It is not a browser-paste worry
 * either — `TEXT_CODE_PAGE` covers 1–31 and 127, so a blueprint code round-trips
 * a tab straight into this field through Load.
 */
export function sanitizeGoal(text: string): string {
  return foldGoalText(text).replace(CONTROL_CHARACTERS, "").slice(0, MAX_GOAL);
}

/** C0 and DEL: typeable by nobody, pasteable by anybody. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * What the title field is allowed to hold.
 *
 * The same code-page fold the goal gets, for a different reason. A title never
 * enters a blueprint code, so nothing here is about the format — it is about
 * `POST /api/submissions`, which *refuses* a title that is too long or holds
 * control characters rather than repairing one, on the stated grounds that the
 * builder has already applied its limits. Folding at the field is what makes
 * that true: the author sees what will be filed, instead of being turned away
 * at the end over a character they cannot see.
 *
 * Control characters are dropped here and not in `foldGoalText`, which keeps
 * everything under 128 — widening that fold would quietly change what a goal
 * encodes into a blueprint comment, and the two fields have different readers.
 */
export function sanitizeTitle(text: string): string {
  return foldGoalText(text).replace(CONTROL_CHARACTERS, "").slice(0, MAX_TITLE);
}

/**
 * The author's estimate, held to the one difficulty scale this repo enforces.
 *
 * Clamped rather than refused, the way `withGoalAttack` clamps: the control is a
 * number box carrying its own min and max, so a value outside the scale is a
 * paste or a typo, and answering a typo by disabling Submit would put a refusal
 * on the one field that cannot stay wrong. Rounded because every rating in the
 * archive is a whole number, though the column is REAL and the route does not
 * insist.
 *
 * The scale is `archive-filter`'s 1–20 and not the 1–10 the sheets talk in:
 * the archive really does contain a 20, and a control that stopped at 10 could
 * not describe a puzzle already on the list.
 */
export function clampDifficulty(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DIFFICULTY;
  return clamp(MIN_DIFFICULTY, Math.round(value), MAX_DIFFICULTY);
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
/**
 * The goal vocabulary now lives in `@shared/goal`, because the server reads it
 * too — a puzzle's enforced clears are derived from exactly this grammar, and a
 * parser the builder did not share would hold authors to a rule their own tool
 * never showed them.
 *
 * Re-exported rather than re-imported at each call site: this module is the
 * builder's façade and nine files already ask it for these.
 */
// A real import as well as the re-export below: `export … from` forwards a
// name without binding it here, and this module uses these three itself.
import { formatGoal as renderGoal, parseGoal, type GoalSpec } from "@shared/goal";

export {
  CLEAR_NAMES,
  EMPTY_GOAL,
  GOAL_LABELS,
  MAX_GOAL_ATTACK,
  MAX_GOAL_COUNT,
  formatGoal,
  parseGoal,
  parseGoalLoosely,
  unusedClears,
  withGoalAttack,
  withGoalEntry,
} from "@shared/goal";
export type { GoalEntry, GoalSpec } from "@shared/goal";

/** Whether the sentence this spec makes still fits the comment's budget. */
export function goalFits(spec: GoalSpec): boolean {
  return renderGoal(spec).length <= MAX_GOAL;
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
    // A page has no title and no rating to give back, and carrying over the
    // ones on screen would put the last puzzle's name on a board that has just
    // arrived from somewhere else. A load is a different puzzle, so it starts
    // unnamed and unrated — and `commit(…, "everything")` means undoing the
    // load brings the author's own two fields back with it.
    title: "",
    difficulty: DEFAULT_DIFFICULTY,
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
 * Whether two drafts hand a solver the same thing.
 *
 * The board, the queue and the hold are the whole of what `toPuzzle` gives the
 * engine, so a run recorded against one of two states this calls the same is a
 * run of the other as well. Everything else a draft carries is deliberately not
 * read: the goal, the title and the rating say what the puzzle asks for and
 * what it is called, never what was played, and rewording a sentence must not
 * throw away the run made under it — the builder offers to write a run's own
 * attack into that sentence the moment the test ends, which would otherwise
 * destroy the run it is describing. Naming a puzzle after solving it is the
 * same move and has to survive the same way.
 *
 * Written out rather than left to a comparison of two `toPuzzle` outputs:
 * `toPuzzle` reads the goal for its target, so two drafts that play identically
 * can compile to prompts that differ.
 */
export function samePlay(a: BuilderState, b: BuilderState): boolean {
  if (a === b) return true;
  if (a.hold !== b.hold) return false;
  if (a.queue.length !== b.queue.length) return false;
  if (a.queue.some((piece, index) => piece !== b.queue[index])) return false;
  if (a.cells.size !== b.cells.size) return false;
  for (const [index, cell] of a.cells) {
    if (b.cells.get(index) !== cell) return false;
  }
  return true;
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

// ── The draft as something to send ──────────────────────────────────────────

/**
 * A run of the draft, kept for as long as it is still a run of *this* draft.
 *
 * A puzzle written here has no reference solution and no honest target until
 * somebody plays it, so the run the author made is the whole of what a
 * submission is built from: the server replays this log and derives both from
 * what it sees, rather than believing anything the browser says about them.
 * Nothing in here is trusted at the far end — but without it there is nothing
 * to send, which is why the end of a test run is no longer just its last frame.
 *
 * It lives in the model rather than in `builder.ts` because `submitBlocker` and
 * `toSubmission` both read it, and a type that a pure function takes has no
 * business being defined in the file that draws the screen.
 */
export interface BuilderSolve {
  /** What the author was shown for the run: attack, clears, pieces placed. */
  readonly snapshot: RunSnapshot;
  readonly events: readonly InputEvent[];
  /**
   * The controls the log was typed under, frozen with it.
   *
   * One log read under two handlings is two different games, so the pair
   * travels together or the server replays a run nobody played.
   */
  readonly handling: Handling;
}

/**
 * The one thing standing between this draft and the review queue, or nothing.
 *
 * One at a time and in this order, the same convention `warningFor` states: a
 * list of everything wrong with a half-finished puzzle is read once and ignored
 * after that, and the order is what makes the single line the next thing to do.
 * Cheap fixes come before the expensive one, so the last refusal an author ever
 * sees is "play it yourself" — which is the bar this whole feature exists to
 * set, and not something to be told while three text fields are still empty.
 *
 * Every one of these mirrors a rule `POST /api/submissions` enforces too — a
 * tall board and a full row in `readBoardShape`, an empty queue in
 * `boardProblem` beneath it, the goal and the title in `readText`, an empty log
 * in the route itself — and that is deliberate rather than duplicated by
 * accident. The route refuses a body outside its bounds instead of repairing
 * it, on the stated grounds that the builder has applied its limits already; so
 * saying it here first is what keeps a refusal in front of the author while the
 * draft is still on the screen and still theirs to fix, rather than at the end
 * of a round trip that has already spent their run. `pipeline.test.ts` holds
 * the two halves against each other so neither can drift alone.
 *
 * What is *not* in here: whether the puzzle is any good, and whether the author
 * is signed in. The first is the reviewer's job and nothing static can guess at
 * it. The second is a fact about the session rather than about the draft, so it
 * belongs to the screen — see `builder.ts`.
 */
export function submitBlocker(state: BuilderState, solve: BuilderSolve | null): string | null {
  const hidden = hiddenCellCount(state);
  if (hidden > 0) {
    // First, as in `warningFor`, and a block rather than a warning here: a
    // reviewer judges the twenty rows this app draws, so cells above them make
    // the puzzle on the review page a different puzzle from the one that ships.
    // `readBoardShape` refuses a board taller than twenty for the same reason.
    const cells = hidden === 1 ? "1 cell" : `${hidden} cells`;
    return (
      `${cells} above the ${MAX_ROWS} rows on screen would not be part of what a ` +
      "reviewer judges. Clear board is what removes them."
    );
  }

  // Delegated rather than restated: a draft the engine cannot deal is a draft
  // nobody can have solved, and "there is nothing to place" is still the next
  // thing to do about it. Two copies of one rule is two chances to drift.
  const unplayable = testBlocker(state);
  if (unplayable) return unplayable;

  const fullRow = lowestFullRow(state);
  if (fullRow !== null) {
    // `readBoardShape` refuses this outright, so saying it here is a kindness
    // rather than a second rule: the same draft would come back a 400 with the
    // author's run already spent on it. `warningFor` only mentions it, which is
    // right for a code somebody is going to paste elsewhere and wrong for one
    // about to be scored — the row clears on the first lock wherever the piece
    // lands, and that attack lands in the target nobody designed.
    return (
      `Row ${fullRow + 1} is already full. It clears on the first lock, and that ` +
      "attack would go into the target every other player is set."
    );
  }

  if (state.goal.trim() === "") {
    return "Say what the goal is — it is all a player is told about your puzzle.";
  }
  if (state.title.trim() === "") {
    return "Give it a title, so it can be told from every other puzzle in the archive.";
  }
  if (!solve) {
    // Last, and the only one that costs more than a sentence to fix. The words
    // are the route's own, because this is the rule the route exists to hold:
    // there is nothing honest to put in `targetAttack` for a board nobody has
    // played, and a target nobody earned is a bar everyone else is scored on.
    return "Play it yourself first — a submission ships with the solve you made.";
  }
  return null;
}

/**
 * What the browser sends to `POST /api/submissions`.
 *
 * A sibling of `toPuzzle` and not a widening of it, for two separate reasons.
 * `toPuzzle`'s output is pinned by `pipeline.test.ts` and read by `app.ts` for
 * its `NO_TARGET`, so it is not free to change shape; and what a submission
 * must *not* carry is the whole point of the route. There is no `targetAttack`
 * here, no `id`, no `author` and no `solution` — every one of those is the
 * server's to derive from the log, and the specific number `toPuzzle` would
 * have handed over is poison: `NO_TARGET` is `MAX_SAFE_INTEGER`, which
 * `assertValid` waves through as a puzzle nobody can ever solve.
 */
export interface SubmissionBody {
  readonly title: string;
  readonly goal: string;
  /** The author's estimate. `claimed_difficulty` at the far end, and advisory. */
  readonly claimedDifficulty: number;
  readonly board: readonly RowCode[];
  readonly queue: readonly PieceType[];
  readonly hold: PieceType | null;
  readonly handling: Handling;
  readonly events: readonly InputEvent[];
}

/**
 * The draft and the run made on it, as one body.
 *
 * The board comes through `draftBoard`, the same conversion a test plays, so
 * the log being sent alongside it was recorded against exactly these rows —
 * which is what makes the server's replay mean anything. The handling travels
 * from the solve rather than from the current settings for the same reason: an
 * author who opens the settings between the last piece and Submit would
 * otherwise have their run replayed under controls they never played it with.
 */
export function toSubmission(state: BuilderState, solve: BuilderSolve): SubmissionBody {
  return {
    title: state.title.trim(),
    goal: state.goal.trim(),
    claimedDifficulty: clampDifficulty(state.difficulty),
    board: draftBoard(state),
    queue: [...state.queue],
    hold: state.hold,
    handling: solve.handling,
    events: solve.events,
  };
}
