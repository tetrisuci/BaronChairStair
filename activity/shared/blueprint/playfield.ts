/**
 * Playfield geometry shared by the blueprint decoder.
 *
 * Blueprint's coordinate system is bottom-left origin: `y = 0` is the floor and
 * `y` grows upward. Everything here keeps that convention; converting to the
 * engine's or the renderer's convention happens at the boundary, once.
 */

export const COLUMNS = 10;
export const ROWS = 40;

export type PieceType = "I" | "J" | "L" | "O" | "S" | "T" | "Z";
/** `g` is garbage; `u` is the unbreakable wall outside the playfield. */
export type CellType = PieceType | "g" | "u";

/** Cell offsets from the piece origin, in the piece's north orientation. */
const SHAPES: Readonly<Record<PieceType, readonly (readonly [number, number])[]>> = {
  I: [[-1, 0], [0, 0], [1, 0], [2, 0]],
  J: [[-1, 1], [-1, 0], [0, 0], [1, 0]],
  L: [[1, 1], [-1, 0], [0, 0], [1, 0]],
  O: [[0, 0], [1, 0], [0, 1], [1, 1]],
  S: [[-1, 0], [0, 0], [0, 1], [1, 1]],
  T: [[0, 1], [-1, 0], [0, 0], [1, 0]],
  Z: [[1, 0], [0, 0], [0, 1], [-1, 1]],
};

/** Rotation index 0–3 is north, east, south, west. */
export type RotationIndex = 0 | 1 | 2 | 3;

/** 2x2 matrices [xx, xy, yx, yy] applied to a shape's offsets. */
const ROTATIONS: readonly (readonly [number, number, number, number])[] = [
  [1, 0, 0, 1],
  [0, 1, -1, 0],
  [-1, 0, 0, -1],
  [0, -1, 1, 0],
];

export interface Cell {
  readonly x: number;
  readonly y: number;
  readonly type: CellType | null;
}

export interface PiecePlacement {
  readonly type: PieceType;
  readonly x: number;
  readonly y: number;
  readonly rotation: RotationIndex;
}

export function pieceCells(placement: PiecePlacement): Cell[] {
  const [xx, xy, yx, yy] = ROTATIONS[placement.rotation]!;
  return SHAPES[placement.type].map(([dx, dy]) => ({
    x: placement.x + xx * dx + xy * dy,
    y: placement.y + yx * dx + yy * dy,
    type: placement.type,
  }));
}

/** An immutable playfield. Every mutator returns a new instance. */
export class Playfield {
  static readonly EMPTY = new Playfield(new Array<CellType | null>(ROWS * COLUMNS).fill(null));

  private constructor(private readonly cells: readonly (CellType | null)[]) {}

  getCell(x: number, y: number): CellType | null {
    if (x < 0 || x >= COLUMNS || y < 0) return "u";
    if (y >= ROWS) return null;
    return this.cells[x + y * COLUMNS]!;
  }

  setCells(updates: Iterable<Cell>): Playfield {
    let next: (CellType | null)[] | null = null;
    for (const { x, y, type } of updates) {
      if (x < 0 || x >= COLUMNS || y < 0 || y >= ROWS) {
        throw new RangeError(`Cell out of bounds: ${x},${y}`);
      }
      const index = x + y * COLUMNS;
      const current = next ?? this.cells;
      if (current[index] === type) continue;
      next ??= [...this.cells];
      next[index] = type;
    }
    return next === null ? this : new Playfield(next);
  }

  *nonEmptyCells(): Generator<Cell> {
    for (let index = 0; index < this.cells.length; index++) {
      const type = this.cells[index]!;
      if (type === null) continue;
      yield { x: index % COLUMNS, y: Math.floor(index / COLUMNS), type };
    }
  }

  fullRows(): number[] {
    const rows: number[] = [];
    for (let y = 0; y < ROWS; y++) {
      let full = true;
      for (let x = 0; x < COLUMNS; x++) {
        if (this.cells[x + y * COLUMNS] === null) {
          full = false;
          break;
        }
      }
      if (full) rows.push(y);
    }
    return rows;
  }

  clearFullRows(): Playfield {
    const cleared = new Set(this.fullRows());
    if (cleared.size === 0) return this;
    const kept: (CellType | null)[] = [];
    for (let y = 0; y < ROWS; y++) {
      if (cleared.has(y)) continue;
      for (let x = 0; x < COLUMNS; x++) kept.push(this.cells[x + y * COLUMNS]!);
    }
    while (kept.length < ROWS * COLUMNS) kept.push(null);
    return new Playfield(kept);
  }

  intersects(placement: PiecePlacement): boolean {
    return pieceCells(placement).some(({ x, y }) => this.getCell(x, y) !== null);
  }

  lock(placement: PiecePlacement): Playfield {
    return this.setCells(pieceCells(placement)).clearFullRows();
  }

  /**
   * The lowest row at or above `y` where the piece does not overlap.
   *
   * @throws {RangeError} if no such row exists. A piece whose cells fall
   *   outside the columns collides at every height, so a corrupt code would
   *   otherwise spin here forever.
   */
  liftOut(placement: PiecePlacement): PiecePlacement {
    let lifted = placement;
    for (let step = 0; step <= ROWS; step++) {
      if (!this.intersects(lifted)) return lifted;
      lifted = { ...lifted, y: lifted.y + 1 };
    }
    throw new RangeError(
      `Piece ${placement.type} at column ${placement.x} never clears the field`,
    );
  }

  /** Highest occupied row, exclusive. Zero for an empty field. */
  get stackHeight(): number {
    for (let y = ROWS - 1; y >= 0; y--) {
      for (let x = 0; x < COLUMNS; x++) {
        if (this.cells[x + y * COLUMNS] !== null) return y + 1;
      }
    }
    return 0;
  }

  /** Rows bottom-up, each an array of `COLUMNS` cells. */
  toRows(height: number = ROWS): (CellType | null)[][] {
    return Array.from({ length: height }, (_, y) =>
      this.cells.slice(y * COLUMNS, (y + 1) * COLUMNS),
    );
  }
}
