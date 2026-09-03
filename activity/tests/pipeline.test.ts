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
import {
  decodeBoard,
  meetsTarget,
  pieceBudget,
  type Puzzle,
  type SolutionStep,
} from "../shared/puzzle";
import { cellIndex, EMPTY_STATE, NO_TARGET, toPuzzle } from "../client/src/ui/builder-state";
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

/** Turns a list of placements into keystrokes a player could plausibly have made. */
function logFor(
  setup: ReturnType<typeof setupFor>,
  steps: readonly Pick<SolutionStep, "piece" | "cells">[],
): InputEvent[] {
  const { engine } = createPuzzleEngine(setup, DEFAULT_HANDLING);
  const events: InputEvent[] = [];
  let frame = 0;

  const tap = (key: GameKey) => {
    events.push({ frame, type: "keydown", data: { key, subframe: 0 } });
    events.push({ frame: frame + 1, type: "keyup", data: { key, subframe: 0 } });
    frame += FRAMES_PER_INPUT;
  };

  for (const step of steps) {
    if (toLetter(engine.falling.symbol) !== step.piece) {
      tap("hold");
      engine.hold(false, true);
    }
    const routes = findPaths(engine, step.cells);
    const route = routes[0];
    if (!route) throw new Error(`unreachable placement: ${step.piece} at ${JSON.stringify(step.cells)}`);
    for (const key of route) {
      tap(key);
      engine.press(key);
    }
    tap("hardDrop");
    engine.press("hardDrop");
  }
  return events;
}

/** Turns the solution into keystrokes a player could plausibly have made. */
function inputLogFor(puzzle: Puzzle): InputEvent[] {
  return logFor(setupFor(puzzle), solutionOf(puzzle));
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

/**
 * The builder's own end of the same path.
 *
 * `toPuzzle` is the only conversion between a board somebody painted and a
 * board the engine plays, and everything below it here is the shipping path —
 * the setup the daily builds, and the verifier the server scores with. A flip,
 * an off-by-one row or the wrong letter for garbage would all still round-trip
 * through the blueprint encoder and still fail here.
 */
describe("a draft the builder compiles", () => {
  test("is a puzzle the engine plays and the verifier scores", () => {
    // A T-slot: row 1 open at 3, 4 and 5, row 0 open at 4, and an overhang on
    // row 2 that leaves only columns 3 and 4 to drop through — so the T has to
    // be rotated into place rather than dropped there, which is what makes it a
    // spin. Row 2 survives the clear, or emptying the board would make this a
    // perfect clear and hide the TSD behind it.
    const cells = new Map<number, "g">();
    for (let x = 0; x < 10; x++) if (x !== 4) cells.set(cellIndex(x, 0), "g");
    for (const x of [0, 1, 2, 6, 7, 8, 9]) cells.set(cellIndex(x, 1), "g");
    for (const x of [0, 1, 2, 5, 6, 7, 8, 9]) cells.set(cellIndex(x, 2), "g");
    const puzzle = toPuzzle({ ...EMPTY_STATE, cells, queue: ["T"], goal: "Clear 1 TSD" });

    const setup = {
      board: decodeBoard(puzzle.board, ENGINE_ROWS),
      queue: puzzle.queue,
      hold: puzzle.hold,
    };
    const events = parseInputLog(
      logFor(setup, [
        {
          piece: "T",
          cells: [
            [3, 1],
            [4, 1],
            [5, 1],
            [4, 0],
          ],
        },
      ]),
    );
    const result = verifyRun(setup, DEFAULT_HANDLING, events);

    expect(result.clears).toEqual(["tsd"]);
    expect(result.attack).toBe(4);
  });

  test("plays its queue out when the goal names no attack", () => {
    // At a target of zero `meetsTarget` is true before the first piece lands,
    // and the test would end having proved nothing. `NO_TARGET` is what makes
    // the run play on, so the builder can report what the author managed.
    const draft = { ...EMPTY_STATE, queue: ["T"] as const, goal: "Clear 1 TSD" };
    expect(toPuzzle(draft).targetAttack).toBe(NO_TARGET);
    expect(meetsTarget(4, NO_TARGET)).toBe(false);
    expect(meetsTarget(0, 0)).toBe(true);
  });
});
