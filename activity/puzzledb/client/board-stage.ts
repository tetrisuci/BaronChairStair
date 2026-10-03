/**
 * The board on a puzzle's page: how many rows it shows, and getting it onto
 * the canvas.
 *
 * **Cropped, not twenty rows.** The game draws a full twenty-row field because
 * a player is about to stack into it. Here nobody is: the archive's boards run
 * one to fourteen rows deep with a median of six, and drawn at full height
 * almost every one is a strip of stack under a tall cream wall, with the cells
 * shrunk to fit a wall nobody needed. So the field is cut to the puzzle — its
 * stack or the highest square its answer reaches, whichever is taller — plus a
 * little headroom, never below a height that still reads as a Tetris board,
 * and never past the game's own twenty.
 *
 * **Its own small painter**, rather than the review page's `BoardPainter`,
 * because that one is fixed at `BOARD_HEIGHT` rows. The order problem it
 * solves is the same and so is the answer: the view hands over a `BoardView`
 * while it is still being built, before its canvas is in the document, so the
 * view is remembered, the canvas arrives afterwards, and the first draw
 * happens once both are in hand.
 */

import { BOARD_HEIGHT } from "@shared/puzzle";
import { BoardRenderer, type BoardView } from "../../client/src/render/board";
import type { SitePuzzle } from "../wire";

/** Fewer rows than this and the field stops reading as a board, however shallow the puzzle. */
export const MIN_VIEW_ROWS = 8;
/** Empty rows above the highest thing on the field, so a stack is never drawn touching the lid. */
export const HEADROOM_ROWS = 3;

/** Wide enough to be a board, for the instant before the column has been laid out. */
const FALLBACK_WIDTH = 320;
/** A field still worth looking at on a short window. */
const MIN_HEIGHT = 260;
/** Room for the site's header and the puzzle's heading above the board. */
const HEIGHT_MARGIN = 220;

/**
 * The rows to show for a puzzle: its stack or the highest answer square,
 * whichever is taller, plus headroom — at least {@link MIN_VIEW_ROWS}, at most
 * `BOARD_HEIGHT`.
 *
 * The answer counts because it can build above the starting stack, and a row
 * the reader is about to watch a piece land in has to be on the field.
 * Placements only ever stack up or clear down, so the highest square any step
 * occupies bounds every frame of the answer.
 */
export function viewRows(puzzle: Pick<SitePuzzle, "board" | "solution">): number {
  const squares = (puzzle.solution ?? []).flatMap((step) => step.cells);
  const answerTop = Math.max(0, ...squares.map(([, y]) => y + 1));
  const tallest = Math.max(puzzle.board.length, answerTop);
  return Math.min(BOARD_HEIGHT, Math.max(MIN_VIEW_ROWS, tallest + HEADROOM_ROWS));
}

/**
 * The renderer for a canvas, or null when this browser has no 2D canvas.
 *
 * Null rather than a throw: a page that cannot draw the board can still show
 * the goal, the facts, the days and the links, and a throw here would take the
 * whole navigation down with it. Said once, in the console, so it is not a
 * mystery to whoever opens it.
 */
function rendererFor(canvas: HTMLCanvasElement): BoardRenderer | null {
  try {
    return new BoardRenderer(canvas);
  } catch (error) {
    console.warn("[puzzledb] this browser cannot draw the board; the rest of the page still works.", error);
    return null;
  }
}

export class BoardStage {
  private renderer: BoardRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private showing: BoardView | null = null;

  /** @param viewport whose height bounds the board's — the page's window. */
  constructor(private readonly viewport: Pick<Window, "innerHeight"> = window) {}

  /** The frame to show. Called before there is a canvas to show it on, and after. */
  show(view: BoardView): void {
    this.showing = view;
    this.draw();
  }

  /** Takes the canvas once it is in the document, and paints whatever is waiting. */
  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.renderer = rendererFor(canvas);
    this.draw();
  }

  /** Fits the field to its column and the window, at the frame's own rows, and paints. Resizes call it. */
  draw(): void {
    const { renderer, canvas, showing } = this;
    if (!renderer || !canvas || !showing) return;
    renderer.layout(
      canvas.parentElement?.clientWidth || FALLBACK_WIDTH,
      Math.max(MIN_HEIGHT, this.viewport.innerHeight - HEIGHT_MARGIN),
      showing.visibleRows,
    );
    renderer.draw(showing);
  }
}
