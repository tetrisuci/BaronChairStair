/**
 * Undo has to hand back a position the player can go on playing from.
 *
 * A placement locks in the middle of a frame, so the log at that instant can
 * hold the press of a key whose release is still to come. Cutting the log there
 * and replaying it used to leave that key down for good: the engine kept acting
 * on it, and the player's real release arrived to a run that already believed
 * the key was up, so nothing could ever close it. These drive the whole thing
 * headlessly — a hand-turned clock and frame loop, the same keys in the same
 * order — and check the three things that have to stay true: the log undo
 * leaves behind replays to the position it claims, the server agrees with the
 * client about what that log means, and redo gives the player back the log they
 * actually typed.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PuzzleRun } from "../client/src/game/runner";
import { decodeBoard, ENGINE_ROWS, type PuzzlePrompt } from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { type InputEvent, parseInputLog, verifyRun } from "../shared/tetris/verify";

const FRAME_MS = 1000 / 60;
/** Enough frames for anything grounded to lock, and then some. */
const PATIENCE = 300;
/**
 * The engine swallows a hard drop for a few frames after a piece locks, so that
 * a key still down at the lock cannot slam the next piece. A real player's next
 * press lands after that window, so the keys here do too.
 */
const SAFE_LOCK_FRAMES = 8;

// ── A clock and a frame loop, turned by hand ─────────────────────────────────

let clock = 0;
let scheduled: FrameRequestCallback | null = null;

const realPerformance = globalThis.performance;
globalThis.performance = { now: () => clock } as unknown as Performance;
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
  scheduled = callback;
  return 1;
};
globalThis.cancelAnimationFrame = () => {
  scheduled = null;
};
afterAll(() => {
  globalThis.performance = realPerformance;
});

/** Runs the run's own loop for `count` frames, one engine tick each. */
function pump(count: number): void {
  for (let index = 0; index < count; index++) {
    const step = scheduled;
    if (!step) return;
    clock += FRAME_MS;
    step(clock);
  }
}

/** Runs the loop until `done`, so a test never has to guess a lock delay. */
function pumpUntil(done: () => boolean): void {
  for (let index = 0; index < PATIENCE && !done(); index++) pump(1);
}

// ── One puzzle, six O pieces, nothing to clear ───────────────────────────────

const PUZZLE: PuzzlePrompt = {
  id: 1,
  title: "stack",
  author: "test",
  difficulty: 1,
  goal: "place pieces",
  set: null,
  board: [],
  queue: ["O", "O", "O", "O", "O", "O"],
  hold: null,
  // Never met: the run has to still be in play when undo is pressed, and an O
  // dropped on an empty field clears nothing.
  targetAttack: 4,
};

const SETUP = {
  board: decodeBoard(PUZZLE.board, ENGINE_ROWS),
  queue: PUZZLE.queue,
  hold: PUZZLE.hold,
};

function newRun(): PuzzleRun {
  return new PuzzleRun(PUZZLE, DEFAULT_HANDLING, {
    onFrame: () => {},
    onFinish: () => {},
    onLock: () => {},
  });
}

/**
 * Hard drop, then a piece seated with soft drop and dropped under it, then
 * hard drop again.
 *
 * The middle piece is the one that matters: soft drop is still held when it
 * locks, so the checkpoint that placement writes is a log with a key down. It
 * used to lock on its lock delay instead, which was the ordinary way to place
 * a piece until issue #8 removed the lock timer — nothing places a piece now
 * but a hard drop, so the held key has to be arranged rather than waited for.
 */
function playThreePieces(run: PuzzleRun): void {
  run.input("hardDrop", true);
  pumpUntil(() => run.snapshot().piecesPlaced === 1);
  run.input("hardDrop", false);
  pump(1);

  run.input("softDrop", true);
  pump(2);
  run.input("hardDrop", true);
  pumpUntil(() => run.snapshot().piecesPlaced === 2);
  run.input("hardDrop", false);
  run.input("softDrop", false);
  pump(SAFE_LOCK_FRAMES);

  run.input("hardDrop", true);
  pumpUntil(() => run.snapshot().piecesPlaced === 3);
  run.input("hardDrop", false);
  pump(1);
}

beforeEach(() => {
  clock = 0;
  scheduled = null;
});

describe("undo", () => {
  test("plays three pieces, the middle one under a held soft drop", () => {
    const run = newRun();
    playThreePieces(run);

    expect(run.snapshot().piecesPlaced).toBe(3);
    expect(run.log().map((event) => `${event.type}:${event.data.key}`)).toEqual([
      "keydown:hardDrop",
      "keyup:hardDrop",
      "keydown:softDrop",
      "keydown:hardDrop",
      "keyup:hardDrop",
      "keyup:softDrop",
      "keydown:hardDrop",
      "keyup:hardDrop",
    ]);
    run.dispose();
  });

  test("leaves a log that holds no key, and a run that stays where it was put", () => {
    const run = newRun();
    playThreePieces(run);

    expect(run.undo()).toBe(true);
    expect(run.snapshot().piecesPlaced).toBe(2);

    const retained = structuredClone(run.log()) as InputEvent[];
    // The two closers are undo's own: soft drop and hard drop were both down at
    // the instant the second piece locked, so the prefix it kept ends mid-press
    // and has to be closed before it is a log the server would accept.
    expect(retained.map((event) => `${event.type}:${event.data.key}`)).toEqual([
      "keydown:hardDrop",
      "keyup:hardDrop",
      "keydown:softDrop",
      "keydown:hardDrop",
      "keyup:hardDrop",
      "keyup:softDrop",
    ]);

    // Nothing held means nothing falls: gravity is zero, so the piece undo
    // handed back sits there until the player touches a key.
    pump(PATIENCE);
    expect(run.log()).toEqual(retained);
    expect(run.snapshot().piecesPlaced).toBe(2);
    expect(run.snapshot().phase).toBe("playing");
    run.dispose();
  });

  test("hands the server a log it parses and scores the same way", () => {
    const run = newRun();
    playThreePieces(run);
    run.undo();
    pump(PATIENCE);

    const retained = structuredClone(run.log()) as InputEvent[];
    // Invariant: the client and the server may not disagree about what a log
    // means, and the closing keyup is an event the client wrote by itself.
    expect(parseInputLog(retained)).toEqual(retained);
    expect(verifyRun(SETUP, DEFAULT_HANDLING, retained).placements).toHaveLength(
      run.snapshot().piecesPlaced,
    );
    run.dispose();
  });

  test("takes back the last of two placements and leaves the first", () => {
    const run = newRun();
    run.input("hardDrop", true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.input("hardDrop", false);
    pump(SAFE_LOCK_FRAMES);
    run.input("hardDrop", true);
    pumpUntil(() => run.snapshot().piecesPlaced === 2);
    run.input("hardDrop", false);
    pump(1);

    expect(run.undo()).toBe(true);
    expect(run.snapshot().piecesPlaced).toBe(1);
    pump(PATIENCE);
    expect(run.snapshot().piecesPlaced).toBe(1);
    expect(run.snapshot().phase).toBe("playing");
    run.dispose();
  });

  test("gives the key back to the player", () => {
    const run = newRun();
    playThreePieces(run);
    run.undo();

    // The release the player is about to make was written into the log for
    // them, so pressing the key again is what has to work.
    const before = run.log().length;
    run.input("softDrop", true);
    expect(run.log()).toHaveLength(before + 1);
    run.input("hardDrop", true);
    pumpUntil(() => run.snapshot().piecesPlaced === 3);
    run.input("hardDrop", false);
    run.input("softDrop", false);

    pump(PATIENCE);
    expect(run.snapshot().piecesPlaced).toBe(3);
    run.dispose();
  });
});

describe("redo", () => {
  test("restores the log the player typed, byte for byte", () => {
    const run = newRun();
    playThreePieces(run);
    const original = structuredClone(run.log()) as InputEvent[];

    expect(run.undo()).toBe(true);
    expect(run.log()).not.toEqual(original);
    expect(run.redo()).toBe(true);

    expect(run.log()).toEqual(original);
    expect(run.snapshot().piecesPlaced).toBe(3);
    run.dispose();
  });

  test("still expects the release of a key the log ends mid-press on", () => {
    const run = newRun();
    playThreePieces(run);
    // Undone and redone without ever letting go: the restored log ends on a
    // press, so the run has to be waiting for the release that finishes it.
    run.input("softDrop", true);
    pumpUntil(() => run.snapshot().piecesPlaced === 4);
    expect(run.undo()).toBe(true);
    expect(run.redo()).toBe(true);

    const before = run.log().length;
    run.input("softDrop", false);
    expect(run.log()).toHaveLength(before + 1);

    // The run stops where the player stopped it. A release it swallows instead
    // leaves soft drop down in the engine, and the puzzle places itself.
    pump(PATIENCE);
    expect(run.snapshot().piecesPlaced).toBe(3);
    expect(run.snapshot().phase).toBe("playing");
    run.dispose();
  });

  test("survives two undos, closers and all", () => {
    const run = newRun();
    playThreePieces(run);
    const original = structuredClone(run.log()) as InputEvent[];

    expect(run.undo()).toBe(true);
    expect(run.undo()).toBe(true);
    expect(run.snapshot().piecesPlaced).toBe(1);
    pump(PATIENCE);
    expect(run.snapshot().piecesPlaced).toBe(1);

    expect(run.redo()).toBe(true);
    expect(run.snapshot().piecesPlaced).toBe(2);
    expect(run.redo()).toBe(true);

    expect(run.log()).toEqual(original);
    expect(run.snapshot().piecesPlaced).toBe(3);
    run.dispose();
  });
});

