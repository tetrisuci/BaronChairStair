/**
 * The puzzle data model shared by the build pipeline, the server, and the
 * client. Everything here is plain JSON so a puzzle can be shipped as a static
 * file and re-read without a decoder on the hot path.
 */

/** Piece letters, uppercase everywhere outside the engine. */
export type Mino = "I" | "J" | "L" | "O" | "S" | "T" | "Z";

/** `G` is unclearable-looking garbage from the puzzle author, not real garbage. */
export type BoardCell = Mino | "G" | null;

export const BOARD_WIDTH = 10;
/** Visible rows. Twenty, as on every other Tetris board. */
export const BOARD_HEIGHT = 20;
/**
 * Rows a decoded board is expanded to. Comfortably above `BOARD_HEIGHT` plus
 * the engine's spawn buffer, so a board is never truncated on its way in.
 */
export const ENGINE_ROWS = 40;

/** A named line clear, matching how players talk about them. */
export type ClearName =
  | "single"
  | "double"
  | "triple"
  | "quad"
  | "tss"
  | "tsd"
  | "tst"
  | "tsmini"
  | "spin"
  | "perfect clear";

/** A board row as ten characters: piece letters, `G` for garbage, `.` for empty. */
export type RowCode = string;

const EMPTY_CELL = ".";

export function encodeRow(cells: readonly BoardCell[]): RowCode {
  return cells.map((cell) => cell ?? EMPTY_CELL).join("");
}

export function decodeRow(row: RowCode): BoardCell[] {
  return Array.from(row, (char) => (char === EMPTY_CELL ? null : (char as BoardCell)));
}

/** Trailing empty rows are dropped; `decodeBoard` pads them back. */
export function encodeBoard(board: readonly (readonly BoardCell[])[]): RowCode[] {
  const rows = board.map(encodeRow);
  while (rows.length > 0 && rows[rows.length - 1] === EMPTY_CELL.repeat(BOARD_WIDTH)) rows.pop();
  return rows;
}

export function decodeBoard(rows: readonly RowCode[], height: number): BoardCell[][] {
  return Array.from({ length: height }, (_, y) =>
    y < rows.length ? decodeRow(rows[y]!) : Array<BoardCell>(BOARD_WIDTH).fill(null),
  );
}

export interface SolutionStep {
  readonly piece: Mino;
  /** The four squares the piece occupies, `[x, y]` with `y = 0` at the floor. */
  readonly cells: readonly (readonly [number, number])[];
  readonly clear: ClearName | null;
  readonly attack: number;
}

export interface Puzzle {
  readonly id: number;
  readonly title: string;
  readonly author: string;
  /** Author-assigned 1–10+ vibe scale; 0 when the archive has no rating. */
  readonly difficulty: number;
  /** The author's own objective text, e.g. "Clear 2 TSDs". */
  readonly goal: string;
  readonly set: string | null;
  /** Rows bottom-up; `board[0]` is the floor. Trailing empty rows are omitted. */
  readonly board: readonly RowCode[];
  /** Playable pieces in order. The first one starts as the falling piece. */
  readonly queue: readonly Mino[];
  readonly hold: Mino | null;
  /** Garbage the reference solution sends — the score to match. */
  readonly targetAttack: number;
  /** The reference solution, used for the reveal and to derive the target. */
  readonly solution: readonly SolutionStep[];
  /** Original blueprint codes, so a puzzle can always be traced to the archive. */
  readonly source: {
    readonly puzzle: string;
    readonly solution: string;
  };
}

/** What the client needs to play. Withholds the answer until the run is over. */
export type PuzzlePrompt = Omit<Puzzle, "solution" | "source">;

export function toPrompt(puzzle: Puzzle): PuzzlePrompt {
  const { solution: _solution, source: _source, ...prompt } = puzzle;
  return prompt;
}

/** Total pieces a player may place — the queue, plus anything pre-held. */
export function pieceBudget(puzzle: Pick<Puzzle, "queue" | "hold">): number {
  return puzzle.queue.length + (puzzle.hold ? 1 : 0);
}
