/**
 * Rules that are easy to break and expensive to get wrong.
 *
 * Each of these pins a specific defect: the engine's queue padding leaking into
 * play, a rebound key quietly reverting on the next reload, and a held modifier
 * silencing every other key.
 */

import { describe, expect, test } from "bun:test";
import { InputRouter } from "../client/src/game/input";
import {
  DEFAULT_KEYBINDS,
  type Keybinds,
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

  /**
   * The banked piece is deliberately NOT an I.
   *
   * The engine pads the queue with I so that locking the final piece has
   * something to spawn, and the ledger is a multiset keyed by piece type — so
   * an I in hold and the padding behind it are the same piece as far as
   * scoring is concerned. These tests were written with `hold: "I"` and passed
   * for a whole release while the piece was never dealt at all: the padding
   * spawned, the ledger accepted it as the banked I, and the placements read
   * exactly as they should. Any piece but I makes the difference visible.
   */
  const banked = { ...setup, queue: ["T", "O"] as Mino[], hold: "Z" as Mino };

  test("a held piece is dealt automatically once the queue is spent", () => {
    // No hold key anywhere in this log: the banked Z is the only piece left, so
    // it is simply the next one rather than something to rescue from behind the
    // engine's padding.
    const result = verifyRun(banked, DEFAULT_HANDLING, log(["hardDrop", "hardDrop", "hardDrop"]));
    expect(result.placements.map((placement) => placement.piece)).toEqual(["T", "O", "Z"]);
  });

  test("the piece dealt at the end is the banked one, never the padding", () => {
    const result = verifyRun(banked, DEFAULT_HANDLING, log(["hardDrop", "hardDrop", "hardDrop"]));
    const last = result.placements[result.placements.length - 1];
    expect(last?.piece).toBe("Z");
    expect(result.placements.map((placement) => placement.piece)).not.toContain("I");
  });

  test("a puzzle holding its last piece can still be finished", () => {
    // The run ends when the ledger is empty. Handing the player padding instead
    // of their banked piece leaves it owing one forever, so the puzzle becomes
    // unfinishable however well it is played.
    const result = verifyRun(banked, DEFAULT_HANDLING, log(["hardDrop", "hardDrop", "hardDrop"]));
    expect(result.placements).toHaveLength(3);
  });

  test("nothing beyond the puzzle's own pieces is ever playable", () => {
    const result = verifyRun(
      banked,
      DEFAULT_HANDLING,
      log(["hardDrop", "hardDrop", "hardDrop", "hold", "hardDrop", "hardDrop"]),
    );
    expect(result.placements).toHaveLength(3);
    expect(result.placements.map((placement) => placement.piece)).toEqual(["T", "O", "Z"]);
  });

  test("pressing hold on the dealt last piece cannot swap the padding back in", () => {
    // Once the banked piece has been dealt, hold contains the padding. Holding
    // would trade a real piece for a phantom, so the key is taken away.
    const result = verifyRun(
      banked,
      DEFAULT_HANDLING,
      log(["hardDrop", "hardDrop", "hold", "hardDrop"]),
    );
    expect(result.placements.map((placement) => placement.piece)).toEqual(["T", "O", "Z"]);
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

/** Which flag a browser raises while a given physical modifier is down. */
const MODIFIER_FLAGS: Readonly<Record<string, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">> = {
  ControlLeft: "ctrlKey",
  AltLeft: "altKey",
  ShiftLeft: "shiftKey",
  MetaLeft: "metaKey",
};

/**
 * Drives the real router with no DOM: `attach` only wants somewhere to register
 * its listeners, and those listeners only want objects shaped like key events.
 *
 * The modifier flags are derived from what is physically down, the way a
 * browser reports them — a modifier's own keydown already carries its flag, and
 * its keyup no longer does. Getting that wrong would test a keyboard nobody has.
 */
function keyboard(keybinds: Keybinds) {
  const listeners = new Map<string, (event: KeyboardEvent) => void>();
  const globals = globalThis as unknown as { window: unknown };
  const outside = globals.window;
  globals.window = {
    addEventListener: (type: string, handler: (event: KeyboardEvent) => void) => {
      listeners.set(type, handler);
    },
    removeEventListener: () => {},
  };
  const routed: string[] = [];
  const router = new InputRouter(keybinds, {
    onGameKey: (key, down) => routed.push(`${key}:${down ? "down" : "up"}`),
    onLocalAction: (action) => routed.push(action),
  });
  router.attach();
  globals.window = outside;

  const down = new Set<string>();
  const send = (type: "keydown" | "keyup", code: string): void => {
    if (type === "keydown") down.add(code);
    else down.delete(code);
    const flags = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    for (const held of down) {
      const flag = MODIFIER_FLAGS[held];
      if (flag) flags[flag] = true;
    }
    listeners.get(type)?.({
      ...flags,
      code,
      repeat: false,
      target: null,
      preventDefault: () => {},
    } as unknown as KeyboardEvent);
  };

  return {
    router,
    routed,
    press: (...codes: readonly string[]): void => {
      for (const code of codes) send("keydown", code);
    },
    release: (...codes: readonly string[]): void => {
      for (const code of codes) send("keyup", code);
    },
  };
}

describe("input router", () => {
  test("a bare binding still fires while a modifier is held", () => {
    // Hold is on shift by default, and a hold is followed by moves — so this is
    // the stock configuration, not an exotic rebind.
    const keys = keyboard(DEFAULT_KEYBINDS);
    keys.press("ShiftLeft", "ArrowDown");
    keys.release("ArrowDown", "ShiftLeft");
    expect(keys.routed).toEqual(["hold:down", "softDrop:down", "softDrop:up", "hold:up"]);
  });

  test("a chord still beats the bare key underneath it", () => {
    const keys = keyboard(DEFAULT_KEYBINDS);
    keys.press("ControlLeft", "KeyZ");
    keys.release("KeyZ", "ControlLeft");
    expect(keys.routed).toEqual(["undo"]);
  });

  test("a chorded game key is released when the modifier goes first", () => {
    const keys = keyboard(rebind(DEFAULT_KEYBINDS, "hardDrop", "Ctrl+Space"));
    keys.press("ControlLeft", "Space");
    keys.release("ControlLeft", "Space");
    expect(keys.routed).toEqual(["hardDrop:down", "hardDrop:up"]);
  });

  test("a chorded game key is released when the key goes first", () => {
    const keys = keyboard(rebind(DEFAULT_KEYBINDS, "hardDrop", "Ctrl+Space"));
    keys.press("ControlLeft", "Space");
    keys.release("Space", "ControlLeft");
    expect(keys.routed).toEqual(["hardDrop:down", "hardDrop:up"]);
  });

  test("a chord over a key bound elsewhere releases the action it pressed", () => {
    // Ctrl+Z hard drops while bare Z still rotates: resolving the binding again
    // on the way up would find rotate-left and leave hard drop held down.
    const keys = keyboard(rebind(DEFAULT_KEYBINDS, "hardDrop", "Ctrl+KeyZ"));
    keys.press("ControlLeft", "KeyZ");
    keys.release("KeyZ", "ControlLeft");
    expect(keys.routed).toEqual(["hardDrop:down", "hardDrop:up"]);
  });

  test("a modifier tapped mid-press does not strand the key", () => {
    const keys = keyboard(DEFAULT_KEYBINDS);
    keys.press("KeyZ");
    keys.press("ControlLeft");
    keys.release("ControlLeft");
    keys.release("KeyZ");
    expect(keys.routed).toEqual(["rotateCCW:down", "rotateCCW:up"]);
  });

  test("suspending game input releases what is down exactly once", () => {
    const keys = keyboard(DEFAULT_KEYBINDS);
    keys.press("ArrowDown");
    keys.router.setGameInputEnabled(false);
    keys.release("ArrowDown");
    keys.router.setGameInputEnabled(true);
    keys.press("ArrowDown");
    expect(keys.routed).toEqual(["softDrop:down", "softDrop:up", "softDrop:down"]);
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

describe("nothing places a piece but the player", () => {
  const setup = { board: EMPTY_BOARD, queue: ["T", "O", "S"] as Mino[], hold: null };
  const at = (frame: number, key: string, type: "keydown" | "keyup"): InputEvent =>
    ({ frame, type, data: { key, subframe: 0 } }) as InputEvent;

  /**
   * The inverse of what this file used to assert.
   *
   * Pieces used to lock on a timer once they were resting, so a soft drop held
   * and never released placed the whole queue on its own. Issue #8 took the
   * timer away: a piece rests where it is put, for as long as the player leaves
   * it there, and only a hard drop commits it.
   */
  test("a piece seated with soft drop and left there is never placed", () => {
    const seated = [at(0, "softDrop", "keydown")];
    expect(verifyRun(setup, DEFAULT_HANDLING, seated).placements).toEqual([]);
  });

  test("a piece rests through a long log that never asks it to drop", () => {
    // Two minutes of holding left, well past any lock delay that ever existed.
    const shuffling = [at(0, "moveLeft", "keydown"), at(7200, "moveLeft", "keyup")];
    expect(verifyRun(setup, DEFAULT_HANDLING, shuffling).placements).toEqual([]);
  });

  test("rotating past the old reset limit still does not place it", () => {
    // The engine used to place a piece once it had spent its lock resets, which
    // was fifteen. This spins it forty times.
    const spinning: InputEvent[] = [];
    for (let i = 0; i < 40; i++) {
      spinning.push(at(i * 4, "rotateCW", "keydown"), at(i * 4 + 2, "rotateCW", "keyup"));
    }
    expect(verifyRun(setup, DEFAULT_HANDLING, spinning).placements).toEqual([]);
  });

  test("hard drop is what places it, and places exactly one", () => {
    const dropped = [
      at(0, "softDrop", "keydown"),
      at(4, "hardDrop", "keydown"),
      at(6, "hardDrop", "keyup"),
      at(8, "softDrop", "keyup"),
    ];
    expect(verifyRun(setup, DEFAULT_HANDLING, dropped).placements.map((p) => p.piece)).toEqual([
      "T",
    ]);
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
