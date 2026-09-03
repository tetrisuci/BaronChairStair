/**
 * End-to-end check on the scoring path.
 *
 * Builds a synthetic input log from each puzzle's reference solution, then
 * feeds it through the same verifier the server uses. If the engine config,
 * the spawn nudge, the input-log format, or the piece budget ever drift apart
 * between build time and play time, the reported attack stops matching the
 * recorded target and these fail.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeBoard, pieceBudget, type Puzzle } from "../shared/puzzle";
import { createPuzzleEngine, toLetter } from "../shared/tetris/engine";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { findPaths } from "../shared/tetris/pathfinder";
import type { GameKey, InputEvent } from "../shared/tetris/verify";
import { parseInputLog, verifyRun } from "../shared/tetris/verify";

const ENGINE_ROWS = 40;
/** One frame down, one frame up: long enough to register, short of DAS. */
const FRAMES_PER_INPUT = 2;

import { archive as puzzles, hasSolutions, solutionOf } from "./archive";

function setupFor(puzzle: Puzzle) {
  return {
    board: decodeBoard(puzzle.board, ENGINE_ROWS),
    queue: puzzle.queue,
    hold: puzzle.hold,
  };
}

/** Turns the solution into keystrokes a player could plausibly have made. */
function inputLogFor(puzzle: Puzzle): InputEvent[] {
  const { engine } = createPuzzleEngine(setupFor(puzzle), DEFAULT_HANDLING);
  const events: InputEvent[] = [];
  let frame = 0;

  const tap = (key: GameKey) => {
    events.push({ frame, type: "keydown", data: { key, subframe: 0 } });
    events.push({ frame: frame + 1, type: "keyup", data: { key, subframe: 0 } });
    frame += FRAMES_PER_INPUT;
  };

  for (const step of solutionOf(puzzle)) {
    if (toLetter(engine.falling.symbol) !== step.piece) {
      tap("hold");
      engine.hold(false, true);
    }
    const routes = findPaths(engine, step.cells);
    const route = routes[0];
    if (!route) throw new Error(`unreachable placement for puzzle ${puzzle.id}`);
    for (const key of route) {
      tap(key);
      engine.press(key);
    }
    tap("hardDrop");
    engine.press("hardDrop");
  }
  return events;
}

describe("puzzle archive", () => {
  test("every puzzle has a positive, reachable target", () => {
    expect(puzzles.length).toBeGreaterThan(100);
    for (const puzzle of puzzles) {
      expect(puzzle.targetAttack).toBeGreaterThan(0);
      expect(solutionOf(puzzle).length).toBeGreaterThan(0);
      expect(solutionOf(puzzle).length).toBeLessThanOrEqual(pieceBudget(puzzle));
      expect(puzzle.board.every((row) => row.length === 10)).toBe(true);
    }
  });
});

describe("verifyRun", () => {
  // A spread across queue lengths and difficulties rather than the whole
  // archive: the search is quadratic in placements and this runs on every save.
  const sample = puzzles.filter((_, index) => index % 11 === 0);

  test.each(sample.map((puzzle) => [puzzle.id, puzzle] as const))(
    "reproduces the recorded target for puzzle %i",
    (_id, puzzle) => {
      const events = parseInputLog(inputLogFor(puzzle));
      const result = verifyRun(setupFor(puzzle), DEFAULT_HANDLING, events);
      // At least, not exactly: the build picks the highest-scoring kick for
      // each placement while `inputLogFor` takes the first route found, so a
      // replay can only match the target or beat it. Falling short is the
      // drift this guards against.
      expect(result.attack).toBeGreaterThanOrEqual(puzzle.targetAttack);
      expect(result.placements.length).toBe(solutionOf(puzzle).length);
    },
  );
});

describe("input log validation", () => {
  test("rejects unknown keys", () => {
    expect(() =>
      parseInputLog([{ frame: 0, type: "keydown", data: { key: "selfDestruct", subframe: 0 } }]),
    ).toThrow(/unknown key/);
  });

  test("rejects frames that go backwards", () => {
    expect(() =>
      parseInputLog([
        { frame: 10, type: "keydown", data: { key: "hardDrop", subframe: 0 } },
        { frame: 2, type: "keyup", data: { key: "hardDrop", subframe: 0 } },
      ]),
    ).toThrow(/backwards/);
  });

  test("rejects a subframe outside one frame", () => {
    expect(() =>
      parseInputLog([{ frame: 0, type: "keydown", data: { key: "hold", subframe: 1.5 } }]),
    ).toThrow(/subframe/);
  });
});
