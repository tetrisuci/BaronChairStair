/**
 * Keystrokes that play a puzzle's archived answer, for a test that has to send
 * a solve to the server the way a player's client would.
 *
 * Shared by `server.test.ts` (the daily and rush routes) and
 * `new-routes.test.ts` (the Explore clear route). Both need `data/solutions.json`
 * and must guard on `hasSolutions` (`tests/archive.ts`).
 */

import { solutionOf } from "./archive";
import { decodeBoard, ENGINE_ROWS, pieceBudget, type Puzzle } from "../shared/puzzle";
import { createPuzzleEngine, toLetter } from "../shared/tetris/engine";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { findPaths } from "../shared/tetris/pathfinder";
import type { GameKey, InputEvent } from "../shared/tetris/verify";

/** The board, queue and hold a puzzle starts from. */
export function setupFor(puzzle: Puzzle) {
  return { board: decodeBoard(puzzle.board, ENGINE_ROWS), queue: puzzle.queue, hold: puzzle.hold };
}

/**
 * Keystrokes that play a puzzle's archived solution.
 *
 * The archive records where each piece came to rest, not how it got there, so
 * the route back has to be searched for — a spin only counts if the last input
 * before the drop was a rotation.
 */
export function solvingLog(puzzle: Puzzle): InputEvent[] {
  const { engine } = createPuzzleEngine(setupFor(puzzle), DEFAULT_HANDLING);
  const events: InputEvent[] = [];
  let frame = 0;
  const tap = (key: GameKey) => {
    events.push({ frame, type: "keydown", data: { key, subframe: 0 } });
    events.push({ frame: frame + 1, type: "keyup", data: { key, subframe: 0 } });
    frame += 2;
  };

  for (const step of solutionOf(puzzle).slice(0, pieceBudget(puzzle))) {
    if (toLetter(engine.falling.symbol) !== step.piece) {
      tap("hold");
      engine.hold(false, true);
    }
    const route = findPaths(engine, step.cells)[0];
    if (!route) throw new Error(`No route to the archived placement for puzzle ${puzzle.id}`);
    for (const key of route) {
      tap(key);
      engine.press(key);
    }
    tap("hardDrop");
    engine.press("hardDrop");
  }
  return events;
}
