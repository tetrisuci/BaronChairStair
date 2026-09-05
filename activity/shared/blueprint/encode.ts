/**
 * Encoder for Blueprint v1 (`b1@…`) codes — the inverse of `decode.ts`.
 *
 * It writes what a builder produces: one page, holding a board, a queue, a
 * hold piece and an optional note. It does not write placements or multi-page
 * documents, because nothing here makes those — the archive's solution codes
 * are read, never written.
 *
 * "Cross-compatible" is a claim that has to be checked rather than asserted, so
 * the tests round-trip every real code in the club's archive through decode →
 * encode → decode and compare the documents. That proves this writes something
 * our decoder reads identically; it cannot prove bp.tali.software agrees, which
 * is why the opcode choices below stay boring and use only the four the archive
 * itself already exercises.
 */

import { BitWriter } from "./bits";
import type { CellType, PieceType } from "./playfield";

const CODE_PREFIX = "b1@";
const OPCODE_BITS = 4;
const COLUMNS = 10;

/** Opcodes this writes. Names match the decoder's switch. */
const PUSH_BACK = 0;
const SWAP_HOLD = 3;
const SET_CELLS = 6;
const COMMENT = 7;
const END = 15;

/** Wire order for the 3-bit piece encoding; index 0 means "empty cell". */
const PIECE_ENCODING: readonly (PieceType | null)[] = [
  null, "I", "J", "L", "O", "S", "T", "Z",
];

const TEXT_CODE_PAGE = [
  0, 32, 101, 116, 97, 111, 105, 110, 115, 114, 104, 100, 108, 117, 99, 109,
  102, 121, 119, 103, 112, 98, 118, 107, 120, 113, 106, 122, 46, 44, 69, 84,
  65, 79, 73, 78, 83, 82, 72, 68, 76, 85, 67, 77, 70, 89, 87, 71, 80, 66,
  86, 75, 88, 81, 74, 90, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 33, 63,
  39, 34, 40, 41, 91, 93, 123, 125, 64, 35, 36, 37, 94, 38, 42, 95, 43, 45,
  61, 124, 59, 58, 60, 62, 47, 92, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 96, 126, 127,
] as const;

const TEXT_BY_CHAR: ReadonlyMap<number, number> = new Map(
  TEXT_CODE_PAGE.map((code, index) => [code as number, index]),
);

export class BlueprintEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintEncodeError";
  }
}

/** A filled cell. Row 0 is the bottom, matching the decoder's coordinates. */
export interface BlueprintCell {
  readonly x: number;
  readonly y: number;
  readonly type: CellType;
}

export interface BlueprintPageInput {
  readonly cells: readonly BlueprintCell[];
  readonly previews: readonly PieceType[];
  readonly hold: PieceType | null;
  readonly comment?: string;
}

function writePiece(writer: BitWriter, piece: PieceType): void {
  const index = PIECE_ENCODING.indexOf(piece);
  if (index < 1) throw new BlueprintEncodeError(`Unknown piece ${piece}`);
  writer.write(index, 3);
}

function writeCellType(writer: BitWriter, type: CellType): void {
  if (type === "g") {
    writer.write(1);
    return;
  }
  const index = PIECE_ENCODING.indexOf(type as PieceType);
  if (index < 1) throw new BlueprintEncodeError(`Cell type ${type} has no encoding`);
  writer.write(0);
  writer.write(index, 3);
}

/**
 * Cells of one type, as alternating on/off runs over the row-major index.
 *
 * The first run is "on" and may be empty — that is how a leading gap is said.
 * Every later run is written one less than its length, because a run between
 * two others can never be empty. The trailing off-run is simply not written.
 */
function writeCoordinates(writer: BitWriter, cells: readonly BlueprintCell[]): void {
  const indices = [...new Set(cells.map((cell) => cell.y * COLUMNS + cell.x))].sort(
    (a, b) => a - b,
  );
  if (indices.length === 0) throw new BlueprintEncodeError("A SetCells run needs a cell");

  const runs: number[] = [];
  let cursor = 0;
  let filled = true;
  let read = 0;
  while (read < indices.length) {
    if (filled) {
      let run = 0;
      while (read < indices.length && indices[read] === cursor + run) {
        run++;
        read++;
      }
      runs.push(run);
      cursor += run;
    } else {
      const gap = indices[read]! - cursor;
      runs.push(gap);
      cursor += gap;
    }
    filled = !filled;
  }

  writer.writeVarint(runs.length - 1);
  runs.forEach((run, index) => writer.writeVarint(index === 0 ? run : run - 1));
}

function writeText(writer: BitWriter, text: string): void {
  for (const char of text) {
    const code = char.charCodeAt(0);
    writer.writeVarint(TEXT_BY_CHAR.get(code) ?? code);
  }
  writer.writeVarint(0);
}

/**
 * Writes one page as a blueprint code.
 *
 * Order matters and is the decoder's, not a preference: cells first, then the
 * hold, then the previews. Hold is set by pushing that piece and swapping it —
 * `SwapHold` on an empty hold takes the front preview — which is why it has to
 * happen before the real previews are pushed, or it would swallow one of them.
 */
export function encodeBlueprint(page: BlueprintPageInput): string {
  const writer = new BitWriter();

  const byType = new Map<CellType, BlueprintCell[]>();
  for (const cell of page.cells) {
    const group = byType.get(cell.type) ?? [];
    group.push(cell);
    byType.set(cell.type, group);
  }
  for (const [type, cells] of byType) {
    writer.write(SET_CELLS, OPCODE_BITS);
    writeCellType(writer, type);
    writeCoordinates(writer, cells);
  }

  if (page.hold) {
    writer.write(PUSH_BACK, OPCODE_BITS);
    writePiece(writer, page.hold);
    writer.write(SWAP_HOLD, OPCODE_BITS);
  }
  for (const piece of page.previews) {
    writer.write(PUSH_BACK, OPCODE_BITS);
    writePiece(writer, piece);
  }

  if (page.comment) {
    writer.write(COMMENT, OPCODE_BITS);
    writeText(writer, page.comment);
  }

  writer.write(END, OPCODE_BITS);
  return CODE_PREFIX + writer.toBase64();
}
