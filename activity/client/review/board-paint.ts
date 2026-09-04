/**
 * Getting the step a reviewer is looking at onto the canvas.
 *
 * A module rather than four lines inside the page, because the order is
 * awkward and getting it wrong shows an empty board with no error: the
 * renderer needs a canvas, the canvas belongs to the detail view, and the
 * detail view paints its first step while it is still being built. So the step
 * is remembered whenever it changes, the renderer arrives afterwards, and the
 * first draw happens once both are in hand.
 */

import { BOARD_HEIGHT } from "@shared/puzzle";
import { BoardRenderer, type BoardView } from "../src/render/board";

/** Wide enough to be a board, for the instant before the card has been laid out. */
const FALLBACK_WIDTH = 320;
/** A field still worth looking at on a short window. */
const MIN_HEIGHT = 260;
/** Room for the page header, the card's own padding, and the piece strip under it. */
const HEIGHT_MARGIN = 260;

export class BoardPainter {
  private renderer: BoardRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private showing: BoardView | null = null;

  /** The step to show. Called before there is anything to show it on, and after. */
  show(view: BoardView): void {
    this.showing = view;
    this.draw();
  }

  /** Takes the canvas once it is in the document, and paints whatever is pending. */
  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.renderer = new BoardRenderer(canvas);
    this.draw();
  }

  /** Fits the field to the window and repaints. Also what a resize calls. */
  draw(): void {
    const { renderer, canvas, showing } = this;
    if (!renderer || !canvas || !showing) return;
    renderer.layout(
      canvas.parentElement?.clientWidth || FALLBACK_WIDTH,
      Math.max(MIN_HEIGHT, window.innerHeight - HEIGHT_MARGIN),
      BOARD_HEIGHT,
    );
    renderer.draw(showing);
  }
}
