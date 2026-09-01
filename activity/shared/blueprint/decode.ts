/**
 * Decoder for Blueprint v1 (`b1@…`) codes, the format used by
 * https://bp.tali.software to share board setups.
 *
 * A code is a bit stream of 4-bit opcodes. Each opcode mutates a running
 * document state; `InsertPage` and `Lock` commit the current state as a page.
 * The puzzle archive stores one code for the prompt (a single page) and one for
 * the solution (a page per placement), so multi-page support is load-bearing.
 */

import { BitReader, bitsFromBase64 } from "./bits";
import {
  type CellType,
  type PiecePlacement,
  type PieceType,
  Playfield,
  type RotationIndex,
  ROWS,
} from "./playfield";

const CODE_PREFIX = "b1@";
const OPCODE_BITS = 4;
const END_OPCODE = 15;
const COLUMNS = 10;
/** Puzzle notes are a sentence; anything longer is a malformed stream. */
const MAX_COMMENT_LENGTH = 4096;

/** Wire order for the 3-bit piece encoding; index 0 means "empty cell". */
const PIECE_ENCODING: readonly (PieceType | null)[] = [
  null, "I", "J", "L", "O", "S", "T", "Z",
];

/**
 * Comment text is remapped to a frequency-ordered code page so that common
 * characters cost one varint nibble instead of two.
 */
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

export class BlueprintDecodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlueprintDecodeError";
  }
}

export interface QueueState {
  readonly previews: readonly PieceType[];
  readonly hold: PieceType | null;
}

export interface BlueprintPage {
  readonly playfield: Playfield;
  readonly queue: QueueState;
  readonly piece: PiecePlacement | null;
  readonly comment: string;
  /**
   * True when this page was committed by a lock, i.e. `piece` is where the
   * piece came to rest. Pages committed any other way are just snapshots of the
   * editor — often a piece still hovering at spawn — and are not placements.
   */
  readonly locked: boolean;
}

export interface BlueprintDocument {
  readonly pages: readonly BlueprintPage[];
}

const EMPTY_QUEUE: QueueState = { previews: [], hold: null };

// ── Field decoders ───────────────────────────────────────────────────────────

function readPieceType(reader: BitReader): PieceType {
  const piece = PIECE_ENCODING[reader.read(3)];
  if (piece === null || piece === undefined) {
    throw new BlueprintDecodeError("Invalid piece type encoding");
  }
  return piece;
}

function readCellType(reader: BitReader): CellType | null {
  if (reader.read() === 1) return "g";
  return PIECE_ENCODING[reader.read(3)] ?? null;
}

/**
 * Coordinates arrive as alternating on/off run lengths over the row-major cell
 * index. The first run is "on", so an empty leading run encodes a gap.
 */
function readCoordinates(reader: BitReader): { x: number; y: number }[] {
  const runCount = reader.readVarint() + 1;
  const runs = Array.from({ length: runCount }, (_, i) =>
    reader.readVarint() + (i > 0 ? 1 : 0),
  );

  const coords: { x: number; y: number }[] = [];
  let index = 0;
  let filled = true;
  for (const run of runs) {
    if (filled) {
      for (let i = 0; i < run; i++) {
        const cell = index + i;
        coords.push({ x: cell % COLUMNS, y: Math.floor(cell / COLUMNS) });
      }
    }
    index += run;
    filled = !filled;
  }
  return coords;
}

/**
 * Returns the piece's rotation, column, and *relative* drop depth.
 *
 * The depth is a varint with no upper bound on the wire, and it drives a loop,
 * so it is checked against the field here rather than trusted.
 */
function readLocation(reader: BitReader): {
  rotation: RotationIndex;
  x: number;
  depth: number;
} {
  const rotation = reader.read(2) as RotationIndex;
  const packed = reader.readVarint();
  const x = packed % COLUMNS;
  const depth = (packed - x) / COLUMNS;
  if (depth > ROWS) {
    throw new BlueprintDecodeError(`Piece depth ${depth} is off the field`);
  }
  return { rotation, x, depth };
}

function readText(reader: BitReader): string {
  const codes: number[] = [];
  for (let code = reader.readVarint(); code !== 0; code = reader.readVarint()) {
    if (codes.length >= MAX_COMMENT_LENGTH) {
      throw new BlueprintDecodeError("Comment is implausibly long");
    }
    codes.push(code < TEXT_CODE_PAGE.length ? TEXT_CODE_PAGE[code]! : code);
  }
  // Spread rather than a loop: bounded above, so it cannot blow the stack.
  return String.fromCharCode(...codes);
}

// ── Queue transitions ────────────────────────────────────────────────────────

function pushFront(queue: QueueState, type: PieceType): QueueState {
  return { previews: [type, ...queue.previews], hold: queue.hold };
}

function pushBack(queue: QueueState, type: PieceType): QueueState {
  return { previews: [...queue.previews, type], hold: queue.hold };
}

function popFront(queue: QueueState): [PieceType | null, QueueState] {
  const [front, ...rest] = queue.previews;
  if (front === undefined) return [queue.hold, EMPTY_QUEUE];
  return [front, { previews: rest, hold: queue.hold }];
}

function swapHold(queue: QueueState): QueueState {
  const [front, ...rest] = queue.previews;
  const held = queue.hold;
  if (held === null) return { previews: rest, hold: front ?? null };
  return { previews: [held, ...rest], hold: front ?? null };
}

// ── Document simulator ───────────────────────────────────────────────────────

/**
 * `piece` positions are stored relative to the resting position of the piece at
 * the top of the column, so decoding one means replaying that many one-row
 * drops, lifting the piece clear of the stack after each.
 */
function resolvePieceY(
  playfield: Playfield,
  type: PieceType,
  rotation: RotationIndex,
  x: number,
  depth: number,
): number {
  let placement = playfield.liftOut({ type, x, y: 0, rotation });
  for (let i = 0; i < depth; i++) {
    placement = playfield.liftOut({ ...placement, y: placement.y + 1 });
  }
  return placement.y;
}

class DocumentBuilder {
  private readonly committed: BlueprintPage[] = [];
  private current: BlueprintPage = {
    playfield: Playfield.EMPTY,
    queue: EMPTY_QUEUE,
    piece: null,
    comment: "",
    locked: false,
  };

  patch(changes: Partial<BlueprintPage>): void {
    this.current = { ...this.current, ...changes };
  }

  get page(): BlueprintPage {
    return this.current;
  }

  commit(locked: boolean): void {
    this.committed.push({ ...this.current, locked });
  }

  finish(): BlueprintDocument {
    return { pages: [...this.committed, this.current] };
  }
}

function applyOpcode(opcode: number, reader: BitReader, doc: DocumentBuilder): void {
  const page = doc.page;
  switch (opcode) {
    case 0:
      return doc.patch({ queue: pushBack(page.queue, readPieceType(reader)) });
    case 1:
      return doc.patch({ queue: pushFront(page.queue, readPieceType(reader)) });
    case 2:
      return doc.patch({ queue: popFront(page.queue)[1] });
    case 3:
      return doc.patch({ queue: swapHold(page.queue) });
    case 4: {
      const { rotation, x, depth } = readLocation(reader);
      let type = page.piece?.type;
      let queue = page.queue;
      if (type === undefined) {
        const [front, rest] = popFront(queue);
        if (front === null) {
          throw new BlueprintDecodeError("Piece placement with an empty queue");
        }
        type = front;
        queue = rest;
      }
      const y = resolvePieceY(page.playfield, type, rotation, x, depth);
      return doc.patch({ queue, piece: { type, x, y, rotation } });
    }
    case 5: {
      if (!page.piece) throw new BlueprintDecodeError("Lock with no active piece");
      doc.commit(true);
      return doc.patch({ playfield: page.playfield.lock(page.piece), piece: null });
    }
    case 6: {
      const type = readCellType(reader);
      const coords = readCoordinates(reader);
      return doc.patch({
        playfield: page.playfield.setCells(coords.map(({ x, y }) => ({ x, y, type }))),
      });
    }
    case 7:
      return doc.patch({ comment: readText(reader) });
    case 8:
      return doc.commit(false);
    case 9:
      return doc.patch({ piece: null });
    case 10:
      return doc.patch({ queue: { previews: page.queue.previews, hold: null } });
    case 11:
      // A seeded 7-bag randomizer that auto-fills previews. No archived puzzle
      // uses it — they all ship an explicit queue — so decoding one would be
      // guesswork about which pieces the author actually saw.
      throw new BlueprintDecodeError(
        "Blueprint uses a seeded bag randomizer, which has no fixed queue",
      );
    case 12:
      return; // UnsetRandomizer: no randomizer state is tracked.
    default:
      throw new BlueprintDecodeError(`Unknown opcode ${opcode}`);
  }
}

/**
 * Decodes a blueprint code or a full `bp.tali.software` URL.
 *
 * @throws {BlueprintDecodeError} if the code is malformed or unsupported.
 */
export function decodeBlueprint(input: string): BlueprintDocument {
  const trimmed = input.trim();
  const queryStart = trimmed.lastIndexOf("?");
  let body = queryStart >= 0 ? trimmed.slice(queryStart + 1) : trimmed;
  // A few archive rows were pasted with the prefix twice ("b1@b1@…").
  while (body.startsWith(CODE_PREFIX + CODE_PREFIX)) body = body.slice(CODE_PREFIX.length);
  if (!body.startsWith(CODE_PREFIX)) {
    throw new BlueprintDecodeError(
      `Expected a '${CODE_PREFIX}' blueprint code, got '${body.slice(0, 8)}…'`,
    );
  }

  const reader = new BitReader(bitsFromBase64(body.slice(CODE_PREFIX.length)));
  const doc = new DocumentBuilder();
  try {
    for (
      let opcode = reader.readOr(OPCODE_BITS, END_OPCODE);
      opcode !== END_OPCODE;
      opcode = reader.readOr(OPCODE_BITS, END_OPCODE)
    ) {
      applyOpcode(opcode, reader, doc);
    }
  } catch (error) {
    if (error instanceof BlueprintDecodeError) throw error;
    throw new BlueprintDecodeError(`Corrupt blueprint code: ${String(error)}`, {
      cause: error,
    });
  }
  return doc.finish();
}
