/**
 * Drawing constants for the playfield.
 *
 * Canvas cannot read custom properties per frame, so the palette is resolved
 * once at startup from `styles/tokens.css` — that stylesheet stays the single
 * place the colours are defined, and the literals here are only a fallback for
 * contexts with no document (tests, server-side use).
 */

import type { BoardCell, Mino } from "@shared/puzzle";

function resolvePalette(): (name: string, fallback: string) => string {
  if (typeof document === "undefined") return (_name, fallback) => fallback;
  const root = getComputedStyle(document.documentElement);
  return (name, fallback) => root.getPropertyValue(name).trim() || fallback;
}

const token = resolvePalette();

export const MINO_INK: Readonly<Record<Mino | "G", string>> = {
  I: token("--mino-i", "#2fa8b8"),
  J: token("--mino-j", "#3669b8"),
  L: token("--mino-l", "#da7c38"),
  O: token("--mino-o", "#f6b642"),
  S: token("--mino-s", "#7db441"),
  T: token("--mino-t", "#b93ecc"),
  Z: token("--mino-z", "#c8402f"),
  G: token("--mino-g", "#8a8290"),
};

export const PAPER = {
  ink: token("--ink", "#2e1533"),
  field: token("--cream", "#fff6de"),
  /** The club's board rules its field in one weight; so does this one. */
  grid: token("--board-grid", "#eadfcc"),
  flash: token("--sun", "#fcd750"),
} as const;

/** Spawn-orientation cells for each piece, used by the small preview glyphs. */
export const PIECE_SHAPES: Readonly<Record<Mino, readonly (readonly [number, number])[]>> = {
  I: [[0, 0], [1, 0], [2, 0], [3, 0]],
  J: [[0, 1], [0, 0], [1, 0], [2, 0]],
  L: [[2, 1], [0, 0], [1, 0], [2, 0]],
  O: [[0, 0], [1, 0], [0, 1], [1, 1]],
  S: [[0, 0], [1, 0], [1, 1], [2, 1]],
  T: [[1, 1], [0, 0], [1, 0], [2, 0]],
  Z: [[1, 0], [2, 0], [0, 1], [1, 1]],
};

export function inkFor(cell: BoardCell): string | null {
  return cell === null ? null : MINO_INK[cell];
}
