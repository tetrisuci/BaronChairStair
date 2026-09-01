/**
 * Rules that are easy to break and expensive to get wrong.
 *
 * Each of these pins a specific defect: the engine's queue padding leaking into
 * play, and a rebound key quietly reverting on the next reload.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_KEYBINDS,
  rebind,
  sanitizeKeybinds,
} from "../shared/keybinds";
import type { BoardCell, Mino } from "../shared/puzzle";
import {
  DEFAULT_HANDLING,
  HANDLING_RANGES,
  msToFrames,
  sanitizeHandling,
  toEngineHandling,
} from "../shared/tetris/handling";
import { createPuzzleEngine } from "../shared/tetris/engine";
import { PieceLedger } from "../shared/tetris/ledger";
import { type GameKey, type InputEvent, verifyRun } from "../shared/tetris/verify";

const EMPTY_BOARD: BoardCell[][] = Array.from({ length: 40 }, () =>
  Array<BoardCell>(10).fill(null),
);

/** One key per frame pair — long enough to register, short of DAS. */
function log(keys: readonly GameKey[]): InputEvent[] {
  return keys.flatMap((key, index) => [
    { frame: index * 2, type: "keydown" as const, data: { key, subframe: 0 } },
    { frame: index * 2 + 1, type: "keyup" as const, data: { key, subframe: 0 } },
  ]);
}

describe("PieceLedger", () => {
  test("counts the queue and the held piece", () => {
    const ledger = new PieceLedger(["T", "O", "S"], "I");
    expect(ledger.remaining).toBe(4);
  });

  test("refuses a piece the puzzle never provided", () => {
    const ledger = new PieceLedger(["T", "O"], null);
    expect(ledger.spend("T")).toBe(true);
    expect(ledger.spend("O")).toBe(true);
    expect(ledger.spend("I")).toBe(false);
    expect(ledger.remaining).toBe(0);
  });

  test("allows a repeated piece exactly as often as it is offered", () => {
    const ledger = new PieceLedger(["I", "I"], null);
    expect(ledger.spend("I")).toBe(true);
    expect(ledger.spend("I")).toBe(true);
    expect(ledger.spend("I")).toBe(false);
  });
});

describe("verifyRun piece budget", () => {
  const setup = { board: EMPTY_BOARD, queue: ["T", "O", "S"] as Mino[], hold: null };

  test("stops at the puzzle's own pieces", () => {
    const result = verifyRun(setup, DEFAULT_HANDLING, log(["hardDrop", "hardDrop", "hardDrop"]));
    expect(result.placements.map((placement) => placement.piece)).toEqual(["T", "O", "S"]);
  });

  test("hold does nothing on the last piece when nothing is banked", () => {
    // Holding here would put S away and spawn the engine's padding in its
    // place, costing the player their final piece for nothing. The key is
    // ignored instead, so the last hard drop still places S.
    const result = verifyRun(
      setup,
      DEFAULT_HANDLING,
      log(["hardDrop", "hardDrop", "hold", "hardDrop"]),
    );
    expect(result.placements.map((placement) => placement.piece)).toEqual(["T", "O", "S"]);
  });

  test("hold still works while real pieces remain", () => {
    // Bank T on the first piece, place O and S, then bring T back for the last.
    const result = verifyRun(
      setup,
      DEFAULT_HANDLING,
      log(["hold", "hardDrop", "hardDrop", "hold", "hardDrop"]),
    );
    expect(result.placements.map((placement) => placement.piece)).toEqual(["O", "S", "T"]);
  });

  test("a held piece is dealt automatically once the queue is spent", () => {
    // No hold key anywhere in this log: the banked I is the only piece left, so
    // it is simply the next one rather than something to rescue from behind the
    // engine's padding.
    const withHold = { ...setup, queue: ["T", "O"] as Mino[], hold: "I" as Mino };
    const result = verifyRun(withHold, DEFAULT_HANDLING, log(["hardDrop", "hardDrop", "hardDrop"]));
    expect(result.placements.map((placement) => placement.piece)).toEqual(["T", "O", "I"]);
  });

  test("nothing beyond the puzzle's own pieces is ever playable", () => {
    const withHold = { ...setup, queue: ["T", "O"] as Mino[], hold: "I" as Mino };
    const result = verifyRun(
      withHold,
      DEFAULT_HANDLING,
      log(["hardDrop", "hardDrop", "hardDrop", "hold", "hardDrop", "hardDrop"]),
    );
    expect(result.placements).toHaveLength(3);
  });

  test("a piece already in hold can still be swapped in at the end", () => {
    const withHold = { ...setup, queue: ["T", "O"] as Mino[], hold: "I" as Mino };
    const result = verifyRun(
      withHold,
      DEFAULT_HANDLING,
      log(["hardDrop", "hardDrop", "hold", "hardDrop"]),
    );
    expect(result.placements.map((placement) => placement.piece)).toEqual(["T", "O", "I"]);
  });
});

describe("keybinds", () => {
  test("rebinding takes the key from whoever had it", () => {
    const bound = rebind(DEFAULT_KEYBINDS, "hold", "ArrowLeft");
    expect(bound.hold).toEqual(["ArrowLeft"]);
    expect(bound.moveLeft).not.toContain("ArrowLeft");
  });

  test("an action left unbound stays unbound across a reload", () => {
    const bound = rebind(DEFAULT_KEYBINDS, "hold", "ArrowLeft");
    expect(sanitizeKeybinds(bound).moveLeft).toEqual(bound.moveLeft);
  });

  test("a missing action falls back to its default", () => {
    expect(sanitizeKeybinds({ hold: ["KeyV"] }).hardDrop).toEqual(DEFAULT_KEYBINDS.hardDrop);
  });

  test("junk is discarded rather than trusted", () => {
    expect(sanitizeKeybinds({ hold: [42, "F5", "KeyV"] }).hold).toEqual(["KeyV"]);
  });
});

describe("handling units", () => {
  test("one frame is one sixtieth of a second", () => {
    expect(msToFrames(1000 / 60)).toBeCloseTo(1, 10);
    expect(msToFrames(100)).toBeCloseTo(6, 10);
  });

  test("only the durations are converted for the engine", () => {
    const engine = toEngineHandling({ ...DEFAULT_HANDLING, das: 100, arr: 50, dcd: 200, sdf: 20 });
    expect(engine.das).toBeCloseTo(6, 10);
    expect(engine.arr).toBeCloseTo(3, 10);
    expect(engine.dcd).toBeCloseTo(12, 10);
    // A multiplier and the modes are not times and must pass through untouched.
    expect(engine.sdf).toBe(20);
    expect(engine.irs).toBe(DEFAULT_HANDLING.irs);
  });

  test("values out of range are clamped, not rejected", () => {
    expect(sanitizeHandling({ das: 5 }).das).toBe(HANDLING_RANGES.das.min);
    expect(sanitizeHandling({ arr: 9999 }).arr).toBe(HANDLING_RANGES.arr.max);
    expect(sanitizeHandling({ das: "fast" }).das).toBe(DEFAULT_HANDLING.das);
  });

  /**
   * The conversion is only worth anything if the engine actually waits that
   * long, so this counts ticks rather than trusting the arithmetic: with ARR at
   * zero the piece slams to the wall on the frame DAS expires.
   *
   * A duration that is not a whole number of frames engages on the next tick
   * after it elapses — 17ms is 1.02 frames, so it takes two.
   */
  test.each([
    [17, 2],
    [100, 6],
    [200, 12],
  ])("DAS of %ims engages after %i frames", (dasMs, frames) => {
    const { engine } = createPuzzleEngine(
      { board: EMPTY_BOARD, queue: ["I"], hold: null },
      { ...DEFAULT_HANDLING, das: dasMs, arr: 0 },
    );
    engine.tick([{ frame: 0, type: "keydown", data: { key: "moveLeft", subframe: 0 } }] as never);

    let ticks = 1;
    while (engine.falling.x > 0 && ticks < 60) {
      engine.tick([] as never);
      ticks++;
    }
    expect(engine.falling.x).toBe(0);
    expect(ticks).toBe(frames);
  });
});

describe("verifyRun timing", () => {
  /**
   * Pieces do not only lock on hard drop. Seated with soft drop they lock when
   * the lock delay expires, which is after the last key the player pressed — so
   * a replay that stops at the final input scores a real solve as a failure.
   */
  test("counts pieces that lock after the last input", () => {
    const setup = { board: EMPTY_BOARD, queue: ["T", "O", "S"] as Mino[], hold: null };
    // One key, never released: soft drop seats each piece, the lock delay does
    // the rest, and nothing else is ever pressed.
    const held: InputEvent[] = [
      { frame: 0, type: "keydown", data: { key: "softDrop", subframe: 0 } },
    ];
    const result = verifyRun(setup, DEFAULT_HANDLING, held);
    expect(result.placements.map((placement) => placement.piece)).toEqual(["T", "O", "S"]);
  });
});

describe("verifyRun against a hostile log", () => {
  const setup = { board: EMPTY_BOARD, queue: ["T", "O", "S", "I"] as Mino[], hold: null };

  /**
   * Every drop in one frame means many locks inside a single tick, so a guard
   * that only runs between ticks cannot stop the queue emptying — and spawning
   * from an empty queue throws inside the engine, turning a crafted log into a
   * server error.
   */
  test("survives more drops in one frame than the puzzle has pieces", () => {
    const events: InputEvent[] = [];
    for (let i = 0; i < 60; i++) {
      events.push({ frame: 0, type: "keydown", data: { key: "hardDrop", subframe: 0 } });
      events.push({ frame: 0, type: "keyup", data: { key: "hardDrop", subframe: 0 } });
    }
    const result = verifyRun(setup, DEFAULT_HANDLING, events);
    expect(result.placements).toHaveLength(setup.queue.length);
  });

  test("no random log crashes the replay", () => {
    const keys = [
      "moveLeft", "moveRight", "rotateCW", "rotateCCW",
      "rotate180", "softDrop", "hardDrop", "hold",
    ] as const;
    // Deterministic pseudo-randomness: a fuzz test that cannot be reproduced is
    // a fuzz test that reports a failure nobody can chase.
    let seed = 0x9e3779b9;
    const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

    for (let trial = 0; trial < 400; trial++) {
      const events: InputEvent[] = [];
      let frame = 0;
      for (let i = 0; i < 24; i++) {
        if (next() < 0.4) frame += Math.floor(next() * 3);
        const key = keys[Math.floor(next() * keys.length)]!;
        events.push({ frame, type: "keydown", data: { key, subframe: 0 } });
        events.push({ frame, type: "keyup", data: { key, subframe: 0 } });
      }
      expect(() => verifyRun(setup, DEFAULT_HANDLING, events)).not.toThrow();
    }
  });
});
