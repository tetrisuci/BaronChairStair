/**
 * Steps through the reference solution after a run.
 *
 * Rebuilds the board placement by placement rather than storing twenty board
 * snapshots per puzzle: the archive already ships the squares each piece
 * occupies, and locking them is four lines of work.
 */

import {
  BOARD_WIDTH,
  type BoardCell,
  decodeBoard,
  ENGINE_ROWS,
  type PuzzlePrompt,
  type SolutionStep,
} from "@shared/puzzle";
import type { BoardView } from "../render/board";
import { MINO_INK } from "../render/skin";

function lockCells(
  board: readonly (readonly BoardCell[])[],
  cells: readonly (readonly [number, number])[],
  piece: BoardCell,
): BoardCell[][] {
  const next = board.map((row) => [...row]);
  for (const [x, y] of cells) {
    const row = next[y];
    if (row) row[x] = piece;
  }
  const kept = next.filter((row) => row.some((cell) => cell === null));
  while (kept.length < next.length) kept.push(Array<BoardCell>(BOARD_WIDTH).fill(null));
  return kept;
}

export class SolutionPlayer {
  private index = 0;
  private boards: BoardCell[][][];

  constructor(
    /**
     * Only the starting board is read, and the type now says so.
     *
     * It was the whole `PuzzlePrompt` while the reveal at the end of a run was
     * the only caller and one was always to hand. The review page steps a
     * *submission*, which has no id, no rating and no archive target — and
     * inventing those to satisfy a parameter this class never looks at would
     * put a puzzle-shaped object that is not a puzzle into the one place a
     * reviewer decides whether it should become one.
     */
    prompt: Pick<PuzzlePrompt, "board">,
    private readonly steps: readonly SolutionStep[],
    readonly visibleRows: number,
  ) {
    let board = decodeBoard(prompt.board, ENGINE_ROWS);
    this.boards = [board];
    for (const step of steps) {
      board = lockCells(board, step.cells, step.piece);
      this.boards.push(board);
    }
  }

  get stepCount(): number {
    return this.steps.length;
  }

  get position(): number {
    return this.index;
  }

  get current(): SolutionStep | null {
    return this.steps[this.index] ?? null;
  }

  next(): void {
    this.index = Math.min(this.steps.length, this.index + 1);
  }

  previous(): void {
    this.index = Math.max(0, this.index - 1);
  }

  reset(): void {
    this.index = 0;
  }

  /** The board before the current step, with that step's piece drawn on top. */
  view(): BoardView {
    const step = this.steps[this.index];
    return {
      cells: this.boards[this.index] ?? this.boards[0]!,
      visibleRows: this.visibleRows,
      active: step ? step.cells : [],
      activeInk: step ? MINO_INK[step.piece] : null,
      ghost: [],
      flashRows: [],
      flashStrength: 0,
      dimmed: false,
    };
  }
}
