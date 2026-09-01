/**
 * Playfield renderer.
 *
 * The board is a sheet of cream paper with the stack printed on it in the
 * club's piece colours, every block outlined in plum. Everything is redrawn
 * each frame — at this size that costs nothing and removes a whole class of
 * stale-state bugs.
 */

import { BOARD_WIDTH, type BoardCell } from "@shared/puzzle";
import { inkFor, PAPER } from "./skin";

export interface BoardView {
  /** Rows bottom-up, at least `visibleRows` long. */
  readonly cells: readonly (readonly BoardCell[])[];
  readonly visibleRows: number;
  /** Squares of the piece under the player's control. */
  readonly active: readonly (readonly [number, number])[];
  readonly activeInk: string | null;
  /** Where the active piece would land. */
  readonly ghost: readonly (readonly [number, number])[];
  /** Rows clearing this instant, drawn as a flash. */
  readonly flashRows: readonly number[];
  readonly flashStrength: number;
  readonly dimmed: boolean;
}

const EDGE = 2;
/** Matches the hard offset shadow every card on the page casts. */
const SHADOW = 5;
/** Corner radius of the board card. Blocks themselves are square. */
const CARD_RADIUS_RATIO = 0.16;
const MIN_CELL = 9;

/**
 * Ghost proportions: a wash of the piece's colour inside a solid outline.
 *
 * The club's board outlines its ghost in neutral grey, which is handsome and
 * very easy to lose on a light field. Keeping the piece's own colour says both
 * where it lands and which piece is landing. Tuned against the O, the palest
 * piece and the first to disappear if the wash goes lighter.
 */
const GHOST_FILL_ALPHA = 0.26;
const GHOST_EDGE_ALPHA = 0.85;
const GHOST_BORDER = 0.09;

/**
 * Block edge, in pixels, matching the club's own board at tetrisatuci.org/play.
 *
 * A block there is a flat square of colour inside a plum outline — no bevel, no
 * gloss, no corner glint. On a cream field every one of those lightens the fill
 * toward the background, and the piece loses the colour that identifies it.
 */
const BLOCK_EDGE = 2;
/**
 * Past this the board stops feeling like a Tetris board and starts feeling like
 * a wall. Short puzzles get plenty of space around them instead.
 */
const MAX_CELL = 34;

interface PlacedBlock {
  readonly x: number;
  readonly y: number;
  readonly ink: string;
}

/** The stack plus the piece under the player's control, as one list to draw. */
function collectBlocks(view: BoardView, rows: number): PlacedBlock[] {
  const blocks: PlacedBlock[] = [];
  for (let y = 0; y < rows; y++) {
    const row = view.cells[y];
    if (!row) continue;
    for (let x = 0; x < BOARD_WIDTH; x++) {
      const ink = inkFor(row[x] ?? null);
      if (ink) blocks.push({ x, y, ink });
    }
  }
  if (view.activeInk) {
    for (const [x, y] of view.active) {
      if (y >= 0 && y < rows) blocks.push({ x, y, ink: view.activeInk });
    }
  }
  return blocks;
}

export class BoardRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private cell = 24;
  private radius = 3;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot provide a 2D canvas");
    this.ctx = ctx;
  }

  /** Fits the field to the available box. Returns the pixel size it now takes. */
  layout(maxWidth: number, maxHeight: number, visibleRows: number): { width: number; height: number } {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fitted = Math.floor(
      Math.min(
        (maxWidth - EDGE * 2 - SHADOW) / BOARD_WIDTH,
        (maxHeight - EDGE * 2 - SHADOW) / visibleRows,
      ),
    );
    const cell = Math.min(MAX_CELL, Math.max(MIN_CELL, fitted));
    const width = cell * BOARD_WIDTH + EDGE * 2 + SHADOW;
    const height = cell * visibleRows + EDGE * 2 + SHADOW;

    this.cell = cell;
    this.radius = Math.max(1, Math.round(cell * CARD_RADIUS_RATIO));
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width, height };
  }

  /** Canvas y for the top edge of board row `y`, which counts up from the floor. */
  private rowTop(y: number, visibleRows: number): number {
    return EDGE + (visibleRows - 1 - y) * this.cell;
  }

  private columnLeft(x: number): number {
    return EDGE + x * this.cell;
  }

  draw(view: BoardView): void {
    const { ctx, cell } = this;
    const rows = view.visibleRows;
    const fieldWidth = cell * BOARD_WIDTH;
    const fieldHeight = cell * rows;

    // The context is dpr-scaled, so this takes CSS pixels; the canvas's own
    // width/height are device pixels and would over-clear by dpr squared.
    ctx.clearRect(0, 0, fieldWidth + EDGE * 2 + SHADOW, fieldHeight + EDGE * 2 + SHADOW);
    ctx.globalAlpha = view.dimmed ? 0.45 : 1;

    this.drawCard(fieldWidth, fieldHeight);
    this.drawGrid(rows, fieldWidth, fieldHeight);
    this.drawGhost(view.ghost, rows, view.activeInk);
    this.drawBlocks(collectBlocks(view, rows), rows);
    this.drawFlash(view.flashRows, rows, fieldWidth, view.flashStrength);
    ctx.globalAlpha = 1;
  }

  /**
   * The board is a card like every other panel: hard offset shadow, plum edge,
   * cream face. The shadow is drawn here rather than in CSS so it follows the
   * rounded corners exactly.
   */
  private drawCard(fieldWidth: number, fieldHeight: number): void {
    const { ctx } = this;
    const outline = (dx: number, dy: number) => {
      ctx.beginPath();
      const box = [dx + EDGE / 2, dy + EDGE / 2, fieldWidth + EDGE, fieldHeight + EDGE] as const;
      if (typeof ctx.roundRect === "function") ctx.roundRect(...box, this.radius + 2);
      else ctx.rect(...box);
    };

    outline(SHADOW, SHADOW);
    ctx.fillStyle = PAPER.ink;
    ctx.fill();

    outline(0, 0);
    ctx.fillStyle = PAPER.field;
    ctx.fill();
    ctx.strokeStyle = PAPER.ink;
    ctx.lineWidth = EDGE;
    ctx.stroke();
  }

  /**
   * Every block on the field, in two passes: all the fills, then all the
   * outlines.
   *
   * One pass would give uneven edges twice over. A later cell's fill paints
   * over its neighbour's outline, and two neighbours each stroking their own
   * boundary lay down twice the ink there as at the edge of a piece. Filling
   * first and stroking on the shared boundary — rather than inside it — puts
   * exactly one line of the same weight everywhere.
   */
  private drawBlocks(blocks: readonly PlacedBlock[], rows: number): void {
    const { ctx, cell } = this;

    for (const block of blocks) {
      ctx.fillStyle = block.ink;
      ctx.fillRect(this.columnLeft(block.x), this.rowTop(block.y, rows), cell, cell);
    }

    ctx.strokeStyle = PAPER.ink;
    ctx.lineWidth = BLOCK_EDGE;
    for (const block of blocks) {
      ctx.strokeRect(this.columnLeft(block.x), this.rowTop(block.y, rows), cell, cell);
    }
  }

  private drawGrid(rows: number, fieldWidth: number, fieldHeight: number): void {
    const { ctx } = this;
    ctx.lineWidth = 1;

    for (let x = 1; x < BOARD_WIDTH; x++) {
      ctx.strokeStyle = PAPER.grid;
      ctx.beginPath();
      ctx.moveTo(this.columnLeft(x) + 0.5, EDGE);
      ctx.lineTo(this.columnLeft(x) + 0.5, EDGE + fieldHeight);
      ctx.stroke();
    }

    ctx.strokeStyle = PAPER.grid;
    for (let y = 1; y < rows; y++) {
      const top = this.rowTop(y, rows) + 0.5;
      ctx.beginPath();
      ctx.moveTo(EDGE, top);
      ctx.lineTo(EDGE + fieldWidth, top);
      ctx.stroke();
    }
  }

  /** One printed block: solid colour, plum outline, a highlight along the top. */
  /**
   * The landing spot, drawn in the falling piece's own colour: a wash inside a
   * solid outline. A neutral dotted box was too easy to lose against the grid,
   * and colouring it says which piece is about to land, not just where.
   */
  private drawGhost(cells: BoardView["ghost"], rows: number, ink: string | null): void {
    if (cells.length === 0 || !ink) return;
    const { ctx, cell } = this;
    const border = Math.max(2, Math.round(cell * GHOST_BORDER));

    ctx.save();
    ctx.globalAlpha = GHOST_FILL_ALPHA;
    ctx.fillStyle = ink;
    for (const [x, y] of cells) {
      if (y >= rows || y < 0) continue;
      ctx.fillRect(this.columnLeft(x), this.rowTop(y, rows), cell, cell);
    }
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = GHOST_EDGE_ALPHA;
    ctx.strokeStyle = ink;
    ctx.lineWidth = border;
    for (const [x, y] of cells) {
      if (y >= rows || y < 0) continue;
      ctx.strokeRect(
        this.columnLeft(x) + border / 2,
        this.rowTop(y, rows) + border / 2,
        cell - border,
        cell - border,
      );
    }
    ctx.restore();
  }

  private drawFlash(
    flashRows: readonly number[],
    rows: number,
    fieldWidth: number,
    strength: number,
  ): void {
    if (flashRows.length === 0 || strength <= 0) return;
    const { ctx, cell } = this;
    ctx.save();
    ctx.globalAlpha = Math.min(1, strength);
    ctx.fillStyle = PAPER.flash;
    for (const y of flashRows) {
      if (y >= rows) continue;
      ctx.fillRect(EDGE, this.rowTop(y, rows), fieldWidth, cell);
    }
    ctx.restore();
  }
}
