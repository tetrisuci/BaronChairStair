/**
 * Replays a list of placements through the real engine.
 *
 * Used at build time to derive each puzzle's target attack, and in the browser
 * to animate the reveal. Both go through the same code so the number the player
 * is chasing is a number the engine actually produced.
 */

import { Mino } from "@haelp/teto/engine";
import type { LockRes } from "@haelp/teto/engine";
import type { BoardCell, ClearName, Mino as Letter } from "../puzzle";
import type { Handling } from "./handling";
import { createPuzzleEngine, type PuzzleSetup, readBoard, toLetter } from "./engine";
import { findPaths, type MoveKey, type TargetCells } from "./pathfinder";

export interface PlacementRequest {
  readonly piece: Letter;
  /** Absolute board squares the piece must occupy, bottom-left origin. */
  readonly cells: TargetCells;
}

export interface ReplayStep {
  readonly piece: Letter;
  readonly cells: TargetCells;
  readonly clear: ClearName | null;
  readonly attack: number;
  /** Visible board after this placement, bottom-up. */
  readonly board: BoardCell[][];
}

export interface ReplayResult {
  readonly steps: readonly ReplayStep[];
  readonly totalAttack: number;
}

export class ReplayError extends Error {
  constructor(message: string, readonly stepIndex: number) {
    super(`step ${stepIndex + 1}: ${message}`);
    this.name = "ReplayError";
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Turns a lock result into the name players actually use for it. */
export function nameClear(lock: LockRes, isPerfectClear: boolean): ClearName | null {
  if (lock.lines === 0) return null;
  if (isPerfectClear) return "perfect clear";

  const isT = lock.mino === Mino.T;
  if (lock.spin === "normal" && isT) {
    if (lock.lines === 1) return "tss";
    if (lock.lines === 2) return "tsd";
    if (lock.lines === 3) return "tst";
  }
  if (lock.spin === "mini") return isT ? "tsmini" : "spin";
  if (lock.spin === "normal") return "spin";

  switch (lock.lines) {
    case 1: return "single";
    case 2: return "double";
    case 3: return "triple";
    default: return "quad";
  }
}

/**
 * Runs `placements` on a fresh engine, holding whenever the next placement asks
 * for a piece that is not the one currently falling.
 *
 * @throws {ReplayError} when a placement is unreachable or the wrong piece.
 */
export function replayPlacements(
  setup: PuzzleSetup,
  handling: Handling,
  placements: readonly PlacementRequest[],
): ReplayResult {
  const { engine } = createPuzzleEngine(setup, handling);
  const steps: ReplayStep[] = [];

  let lastLock: LockRes | null = null;
  engine.events.on("falling.lock", (lock) => { lastLock = lock; });

  placements.forEach((placement, index) => {
    if (toLetter(engine.falling.symbol) !== placement.piece) engine.hold(false, true);
    if (toLetter(engine.falling.symbol) !== placement.piece) {
      throw new ReplayError(
        `expected ${placement.piece}, engine has ${engine.falling.symbol}`,
        index,
      );
    }

    const routes = findPaths(engine, placement.cells);
    if (routes.length === 0) {
      throw new ReplayError(`no route to ${describe(placement.cells)}`, index);
    }

    // Routes differ in which kick lands the piece, and the kick decides whether
    // a spin scores full or mini. Try them all and keep the author's best line.
    const before = engine.snapshot();
    let bestRoute: { keys: MoveKey[]; lock: LockRes; attack: number } | null = null;
    for (const keys of routes) {
      engine.fromSnapshot(before);
      lastLock = null;
      for (const key of keys) engine.press(key);
      engine.press("hardDrop");
      if (!lastLock) continue;
      const attack = sum((lastLock as LockRes).garbage);
      if (!bestRoute || attack > bestRoute.attack) {
        bestRoute = { keys, lock: lastLock as LockRes, attack };
      }
    }
    if (!bestRoute) throw new ReplayError("hard drop did not lock a piece", index);

    engine.fromSnapshot(before);
    for (const key of bestRoute.keys) engine.press(key);
    engine.press("hardDrop");

    const lock = bestRoute.lock;
    steps.push({
      piece: placement.piece,
      cells: placement.cells,
      clear: nameClear(lock, engine.board.perfectClear),
      attack: sum(lock.garbage),
      board: readBoard(engine),
    });
  });

  return { steps, totalAttack: sum(steps.map((step) => step.attack)) };
}

function describe(cells: TargetCells): string {
  return cells.map(([x, y]) => `${x},${y}`).join(" ");
}
