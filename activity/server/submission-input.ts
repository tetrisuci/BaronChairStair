/**
 * What a submission body — and an officer's verdict on one — is allowed to say.
 *
 * Split out of the route so that "everything the server refuses to believe"
 * reads as one short file, rather than as a hundred lines wedged into the
 * middle of `server/index.ts` — which is long enough already, and where a rule
 * this load-bearing would be found only by whoever went looking for it.
 *
 * Every function here either returns a value the rest of the route may trust,
 * or throws the 400 the player reads. Nothing repairs a body on the way past:
 * trimming to fit and folding to a code page both quietly change what somebody
 * wrote, and the builder has already applied its own limits before this sees
 * anything — so a body arriving outside them is a bug or an attacker, and
 * either is better answered than accommodated.
 */

import { HTTPException } from "hono/http-exception";
import { MAX_DIFFICULTY, MAX_PIECES, MIN_DIFFICULTY } from "../shared/archive-filter";
import { BOARD_HEIGHT, type Mino, pieceBudget, type RowCode } from "../shared/puzzle";
import { type BoardShape, boardProblem } from "./puzzles";

/** Long enough to name a puzzle, short enough to sit in a list of them. */
const MAX_TITLE_LENGTH = 60;

/**
 * The goal cap, the same 120 the builder's own `MAX_GOAL` applies.
 *
 * Written out rather than imported: that constant lives in
 * `client/src/ui/builder-state.ts`, and pulling a browser module into the
 * request path to check a body would be a far worse trade than one number
 * living in two places.
 */
const MAX_GOAL_LENGTH = 120;

/**
 * A reviewer's note.
 *
 * Longer than a goal because it is prose to a person rather than a label on a
 * puzzle — room to say which part of a board did not work — and far short of
 * somewhere to paste a log.
 */
const MAX_NOTE_LENGTH = 500;

/**
 * A line of author-written text, checked rather than repaired.
 *
 * Control characters are refused along with over-length: they cannot be typed
 * into the field they claim to have come from, and this text is bound for a
 * review page and a log line.
 */
function readText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HTTPException(400, { message: `${field} is required` });
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new HTTPException(400, { message: `${field} is longer than ${maxLength} characters` });
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new HTTPException(400, { message: `${field} holds characters that cannot be typed` });
  }
  return text;
}

export function readTitle(value: unknown): string {
  return readText(value, "A title", MAX_TITLE_LENGTH);
}

export function readGoal(value: unknown): string {
  return readText(value, "A goal", MAX_GOAL_LENGTH);
}

/**
 * A rating on the one difficulty scale this repo actually enforces.
 *
 * Not rounded to a whole number: the column is REAL, and which numbers on the
 * scale mean anything is the club's convention rather than something a request
 * should be turned away over.
 */
function readDifficulty(value: unknown): number {
  const valid =
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_DIFFICULTY &&
    value <= MAX_DIFFICULTY;
  if (!valid) {
    throw new HTTPException(400, {
      message: `Difficulty must be a number between ${MIN_DIFFICULTY} and ${MAX_DIFFICULTY}`,
    });
  }
  return value as number;
}

/**
 * The author's own rating — a hint for whoever reviews this, and nothing else.
 *
 * Stored under its own name because the rating that ends up on the puzzle is
 * the reviewer's. `dailyTierOf` and `rushBand` both read a puzzle's difficulty,
 * so a self-rated number that went straight onto one would be a routing control
 * handed to the person being routed.
 */
export function readClaimedDifficulty(value: unknown): number {
  return readDifficulty(value);
}

/**
 * The reviewer's rating: the one that goes on the puzzle.
 *
 * Same rule, its own name, because these are two different people's numbers and
 * a call site reading `readClaimedDifficulty` on an accept body would be the
 * bug rather than a synonym for it. Under the owner's choice of full rotation
 * this really does route: `dailyTierOf` reads it to pick a tier and `rushBand`
 * to place the puzzle on the ladder.
 */
export function readReviewedDifficulty(value: unknown): number {
  return readDifficulty(value);
}

/**
 * An officer's note, or null when they left the box empty.
 *
 * An empty string is "no note" rather than a refusal — it is what an untouched
 * textarea sends, and turning that into a 400 would be answering a question
 * nobody asked. That is not the "nothing repairs a body" rule bending: an
 * absent optional field and an empty one mean the same thing, and neither is
 * changed on the way past.
 */
export function readReviewerNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  return readText(value, "A note", MAX_NOTE_LENGTH);
}

/**
 * The same note, where there has to be one.
 *
 * A rejection is the only thing an author ever hears back about a puzzle they
 * wrote, and "no" with no reason is the one review outcome nobody can act on.
 * An acceptance needs none: the puzzle appearing in the archive is the message.
 */
export function readRejectionNote(value: unknown): string {
  const note = readReviewerNote(value);
  if (!note) {
    throw new HTTPException(400, {
      message: "A rejection needs a reason — it is the only thing the author hears back",
    });
  }
  return note;
}

/**
 * The board, queue and hold, held to exactly the rule an archived puzzle is.
 *
 * Through `boardProblem`, which `PuzzleArchive.load` also calls, so a puzzle
 * written into the database can never be shaped differently from one built into
 * the file. That matters most at the far end: `PuzzleArchive.load` runs at
 * module scope and throws, so a row that only fails validation on the way *out*
 * takes the whole server down at boot rather than failing one puzzle.
 *
 * Two bounds on top, neither of which the archive needs, and both about what a
 * submission costs. Rows above the twenty on screen are rows a reviewer cannot
 * see, so a board taller than the field is a puzzle nobody is judging; and the
 * archive's own ceiling on length is the bound on how much play the engine is
 * asked to replay for a caller who chose the board it replays against.
 */
export function readBoardShape(body: {
  board?: unknown;
  queue?: unknown;
  hold?: unknown;
}): BoardShape {
  const shape: BoardShape = {
    board: body.board as readonly RowCode[],
    queue: body.queue as readonly Mino[],
    hold: body.hold as Mino | null,
  };
  const fault = boardProblem(shape);
  if (fault) throw new HTTPException(400, { message: `That puzzle cannot be played: ${fault}` });
  if (shape.board.length > BOARD_HEIGHT) {
    throw new HTTPException(400, {
      message: `A puzzle is ${BOARD_HEIGHT} rows tall; that board has ${shape.board.length}`,
    });
  }
  // The queue alone, not the budget. `pieceBudget` counts the hold, and the
  // builder's own cap is 80 on the queue with a hold beside it — so a budget
  // bound refuses a draft the builder showed as legal, at the one moment the
  // author has nothing to do about it. The archive's longest queue is 74, so
  // this has never fired; it would first have appeared as an unexplained
  // refusal that cost somebody their board.
  if (shape.queue.length > MAX_PIECES) {
    throw new HTTPException(400, {
      message: `A puzzle queue holds at most ${MAX_PIECES} pieces`,
    });
  }
  // A row that is already full clears on the first lock wherever the piece
  // lands, and that attack goes into the target every later player is scored
  // against. The builder warns about it — "the game clears it the moment play
  // starts" — but a warning lives in the browser, and this is the route that
  // says it does not believe the browser. At twenty full rows it also walks
  // past the topout guard, because the rows clear on the same lock that would
  // have ended the run.
  if (shape.board.some((row) => !row.includes("."))) {
    throw new HTTPException(400, {
      message:
        "A row that is already full clears the moment play starts, " +
        "which hands out attack nobody designed",
    });
  }
  return shape;
}
