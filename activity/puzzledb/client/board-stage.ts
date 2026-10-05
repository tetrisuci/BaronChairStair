/**
 * The board on a puzzle's page: getting it onto the canvas.
 *
 * The page shows the whole twenty-row field, as the game does (the caller
 * passes `BOARD_HEIGHT`); this module only sizes and draws whatever row count
 * the view carries.
 *
 * **Its own small painter**, rather than the review page's `BoardPainter`,
 * because that one is fixed at `BOARD_HEIGHT` rows. The order problem it
 * solves is the same and so is the answer: the view hands over a `BoardView`
 * while it is still being built, before its canvas is in the document, so the
 * view is remembered, the canvas arrives afterwards, and the first draw
 * happens once both are in hand.
 */

import { BoardRenderer, type BoardView } from "../../client/src/render/board";

/** Wide enough to be a board, for the instant before the column has been laid out. */
const FALLBACK_WIDTH = 320;
/** A field still worth looking at on a short window. */
const MIN_HEIGHT = 260;
/** Room for the site's header and the puzzle's heading above the board. */
const HEIGHT_MARGIN = 220;

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
