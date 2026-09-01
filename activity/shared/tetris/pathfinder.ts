/**
 * Finds a sequence of inputs that puts the falling piece on a target square.
 *
 * The archive stores solutions as final resting positions, but a spin only
 * counts if the *last* input before the drop was a rotation — so replaying a
 * solution means reconstructing plausible inputs, not teleporting the piece.
 * Paths found here are always replayed through the real engine afterwards, so
 * a wrong guess shows up as a mismatch rather than a silently bogus score.
 */

import { Engine, Tetromino } from "@haelp/teto/engine";
import type { Rotation } from "@haelp/teto/engine";

export type MoveKey =
  | "moveLeft"
  | "moveRight"
  | "rotateCW"
  | "rotateCCW"
  | "rotate180"
  | "softDrop";

const ROTATION_MOVES = ["rotateCW", "rotateCCW", "rotate180"] as const;
const ALL_MOVES: readonly MoveKey[] = ["moveLeft", "moveRight", ...ROTATION_MOVES, "softDrop"];

/**
 * Enough distinct rotation entries to find the strongest kick without replaying
 * every route on the board.
 */
const MAX_ROTATION_CANDIDATES = 12;

/** How many quarter-turns clockwise each rotation key applies. */
const ROTATION_AMOUNT: Readonly<Record<(typeof ROTATION_MOVES)[number], number>> = {
  rotateCW: 1,
  rotate180: 2,
  rotateCCW: 3,
};

/** Board squares the piece must end up occupying, in any order. */
export type TargetCells = readonly (readonly [number, number])[];

interface PieceState {
  readonly location: readonly [number, number];
  readonly rotation: number;
}

function stateOf(piece: Tetromino): PieceState {
  return { location: [piece.location[0]!, piece.location[1]!], rotation: piece.rotation };
}

function keyOf(state: PieceState): string {
  return `${state.location[0]},${Math.floor(state.location[1])},${state.rotation}`;
}

/**
 * Placements are matched on occupied squares rather than on (x, y, rotation):
 * the archive's piece origins and rotation states are its own, and only the
 * squares are unambiguous across both coordinate systems.
 */
function cellsKey(cells: TargetCells): string {
  return cells
    .map(([x, y]) => `${x}:${y}`)
    .sort()
    .join("|");
}

/**
 * A scratch piece sharing the real piece's shape. The board never changes while
 * a piece is in flight, so the search only has to restore these three numbers.
 */
function scratchPiece(engine: Engine): Tetromino {
  return new Tetromino({
    symbol: engine.falling.symbol,
    initialRotation: engine.falling.rotation,
    boardHeight: engine.board.height,
    boardWidth: engine.board.width,
  });
}

function restore(piece: Tetromino, state: PieceState): void {
  piece.location = [state.location[0], state.location[1]];
  piece.rotation = state.rotation;
}

function applyMove(
  piece: Tetromino,
  move: MoveKey,
  board: Engine["board"]["state"],
  kickTable: Engine["kickTableName"],
): boolean {
  switch (move) {
    case "moveLeft":
      return piece.moveLeft(board);
    case "moveRight":
      return piece.moveRight(board);
    case "softDrop":
      return piece.softDrop(board);
    default:
      return Boolean(piece.rotate(board, kickTable, ROTATION_AMOUNT[move] as Rotation, false));
  }
}

/** Breadth-first map of every square the piece can reach, with a path to each. */
function reachableStates(engine: Engine): Map<string, { state: PieceState; path: MoveKey[] }> {
  const board = engine.board.state;
  const kickTable = engine.kickTableName;
  const piece = scratchPiece(engine);

  const start = stateOf(engine.falling);
  const seen = new Map([[keyOf(start), { state: start, path: [] as MoveKey[] }]]);
  const frontier = [start];

  while (frontier.length > 0) {
    const current = frontier.shift()!;
    const path = seen.get(keyOf(current))!.path;
    for (const move of ALL_MOVES) {
      restore(piece, current);
      if (!applyMove(piece, move, board, kickTable)) continue;
      const next = stateOf(piece);
      const key = keyOf(next);
      if (seen.has(key)) continue;
      seen.set(key, { state: next, path: [...path, move] });
      frontier.push(next);
    }
  }
  return seen;
}

/**
 * Every distinct route that lands the piece on `target`, best first.
 *
 * Routes ending in a rotation come first, because the engine only credits a
 * spin when the last input was one — and among those, different kicks earn
 * different spin bonuses, so callers replay the candidates and keep the
 * strongest. A route that simply arrives on the square comes last.
 */
export function findPaths(engine: Engine, target: TargetCells): MoveKey[][] {
  const board = engine.board.state;
  const kickTable = engine.kickTableName;
  const piece = scratchPiece(engine);
  const reachable = reachableStates(engine);
  const wanted = cellsKey(target);

  const occupies = (state: PieceState): boolean =>
    cellsKey(
      piece.absoluteAt({ x: state.location[0], y: state.location[1], rotation: state.rotation }),
    ) === wanted;

  const rotatedInto: MoveKey[][] = [];
  const arrivedFlat: MoveKey[][] = [];

  for (const { state, path } of reachable.values()) {
    if (occupies(state)) arrivedFlat.push(path);
    for (const move of ROTATION_MOVES) {
      restore(piece, state);
      if (!applyMove(piece, move, board, kickTable)) continue;
      if (occupies(stateOf(piece))) rotatedInto.push([...path, move]);
    }
  }

  const byLength = (a: MoveKey[], b: MoveKey[]) => a.length - b.length;
  return [
    ...rotatedInto.sort(byLength).slice(0, MAX_ROTATION_CANDIDATES),
    ...arrivedFlat.sort(byLength).slice(0, 1),
  ];
}
