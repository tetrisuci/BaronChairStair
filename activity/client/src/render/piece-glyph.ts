/**
 * Small piece glyphs for the hold bay and the queue.
 *
 * These are SVG rather than canvas: they sit in normal document flow, scale
 * with the layout, and cost nothing to redraw when the queue shifts.
 */

import type { Mino } from "@shared/puzzle";
import { MINO_INK, PAPER, PIECE_SHAPES } from "./skin";

const INK = PAPER.ink;

const SVG_NS = "http://www.w3.org/2000/svg";
const UNIT = 10;
/** Matches the playfield: each cell carries its own edge, so seams stay visible. */
const EDGE = 1.2;
/** One cell, in pixels, when a caller does not say otherwise. */
const DEFAULT_CELL = 11;

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
  svg.style.setProperty("--glyph-cell", `${options.cell ?? DEFAULT_CELL}px`);
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
