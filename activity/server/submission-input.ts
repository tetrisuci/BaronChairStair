/**
 * What a submission body is allowed to say.
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
 * The author's own rating — a hint for whoever reviews this, and nothing else.
 *
 * Stored under its own name because the rating that ends up on the puzzle is
 * the reviewer's. `dailyTierOf` and `rushBand` both read a puzzle's difficulty,
 * so a self-rated number that went straight onto one would be a routing control
 * handed to the person being routed. Bounded to the one difficulty scale this
 * repo actually enforces, and not rounded to a whole number: the column is
 * REAL, and which numbers on that scale mean anything is the club's convention
 * rather than something a request should be turned away over.
 */
export function readClaimedDifficulty(value: unknown): number {
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
