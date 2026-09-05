/**
 * Small piece glyphs for the hold bay and the queue.
 *
 * These are SVG rather than canvas: they sit in normal document flow, scale
 * with the layout, and cost nothing to redraw when the queue shifts.
 */

import { BOARD_WIDTH, decodeBoard, type Mino, type RowCode } from "@shared/puzzle";
import { MINO_INK, PAPER, PIECE_SHAPES } from "./skin";

const INK = PAPER.ink;

const SVG_NS = "http://www.w3.org/2000/svg";
const UNIT = 10;
/** Matches the playfield: each cell carries its own edge, so seams stay visible. */
const EDGE = 1.2;
/** The ruling on an empty cell, matching `.build__cell`'s single weight. */
const RULE = 1;
/** Shallow boards are padded up to this, so none of them draws as a sliver. */
const MIN_BOARD_ROWS = 4;

export interface GlyphOptions {
  /**
   * Default size of one cell in pixels; CSS can override it via `--glyph-cell`.
   *
   * Cell size rather than overall height, because pieces are not the same shape:
   * an I is four cells wide and one tall, so matching heights would draw its
   * cells at twice the size of every other piece's.
   */
  readonly cell?: number;
  readonly muted?: boolean;
}

export function pieceGlyph(piece: Mino, options: GlyphOptions = {}): SVGSVGElement {
  const cells = PIECE_SHAPES[piece];
  const width = Math.max(...cells.map(([x]) => x)) + 1;
  const height = Math.max(...cells.map(([, y]) => y)) + 1;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width * UNIT} ${height * UNIT}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${piece} piece`);
  // Sized from custom properties rather than fixed pixels, so a stylesheet can
  // shrink every glyph at a breakpoint without fighting inline styles.
  svg.classList.add("glyph");
  svg.style.setProperty("--glyph-cols", String(width));
  svg.style.setProperty("--glyph-rows", String(height));
  // Written only when a caller asks for a size. The comment above promises a
  // stylesheet can shrink every glyph at a breakpoint "without fighting inline
  // styles" — but writing the default inline is exactly that fight, and an
  // element's own declaration beats anything it would inherit. Two rules were
  // dead because of it: home.css sizing the hero's queue strip at 9px and
  // narrow.css dropping it to 8 below 560. The default now lives in CSS, where
  // a stylesheet can reach it.
  if (options.cell !== undefined) {
    svg.style.setProperty("--glyph-cell", `${options.cell}px`);
  }
  if (options.muted) svg.style.opacity = "0.35";

  for (const [x, y] of cells) {
    // SVG's y axis points down; the shape tables count up from the piece's base.
    const left = x * UNIT;
    const top = (height - 1 - y) * UNIT;

    const face = document.createElementNS(SVG_NS, "rect");
    face.setAttribute("x", String(left + EDGE / 2));
    face.setAttribute("y", String(top + EDGE / 2));
    face.setAttribute("width", String(UNIT - EDGE));
    face.setAttribute("height", String(UNIT - EDGE));
    face.setAttribute("fill", MINO_INK[piece]);
    face.setAttribute("stroke", INK);
    face.setAttribute("stroke-width", String(EDGE));
    svg.append(face);
  }
  return svg;
}

/**
 * A whole board, as a picture rather than as a field to play on.
 *
 * The alternative was pulling the builder's `.build__grid` out into a shared
 * `.minigrid` class, which reads better on paper and worse in the file: that
 * grid is a painting surface carrying per-cell cursor, ghost and hit-testing
 * arithmetic, and a read-only picture shares nothing with it but the ratio.
 * Here it borrows this file's `UNIT` and `EDGE` and the skin's colours, and
 * touches no working code.
 *
 * The ratio is the board's own — ten wide by however many rows it really has.
 * `encodeBoard` drops trailing empty rows, and the archive's boards run from
 * one row deep to fourteen with a median of six, so a fixed 10x20 field would
 * be seven-tenths empty on every puzzle in the file and read as a failed
 * render rather than as a shallow board.
 */
export function boardGlyph(board: readonly RowCode[]): SVGSVGElement {
  // A 10x1 sliver reads as something broken, so the shallowest boards are
  // padded upward. Padding is honest: empty field above the stack is exactly
  // what the player will see when they open it.
  const rows = Math.max(MIN_BOARD_ROWS, board.length);
  const cells = decodeBoard(board, rows);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${BOARD_WIDTH * UNIT} ${rows * UNIT}`);
  // The card around it carries the label. A second reading of the same board
  // is noise in a screen reader, not detail.
  svg.setAttribute("aria-hidden", "true");

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      // `board[0]` is the floor and SVG's y axis points down, so the first row
      // is drawn last. Getting this inverted is the obvious bug here, and it
      // is upside down rather than absent — `tests/render.test.ts` pins it.
      const cell = cells[y]?.[x] ?? null;
      const edge = cell === null ? RULE : EDGE;
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(x * UNIT + edge / 2));
      rect.setAttribute("y", String((rows - 1 - y) * UNIT + edge / 2));
      rect.setAttribute("width", String(UNIT - edge));
      rect.setAttribute("height", String(UNIT - edge));
      rect.setAttribute("fill", cell === null ? PAPER.field : MINO_INK[cell]);
      // The empty cells are ruled in one weight, as `.build__cell` rules them.
      rect.setAttribute("stroke", cell === null ? PAPER.grid : INK);
      rect.setAttribute("stroke-width", String(edge));
      svg.append(rect);
    }
  }
  return svg;
}
