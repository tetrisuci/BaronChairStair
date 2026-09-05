/**
 * Drag to place, driven headlessly.
 *
 * A drag is honest only if it becomes keys — so the whole contract is that a
 * placement made through `aimAt`/`placeAt` leaves a log the server replays to
 * exactly the placement the player saw. These run the real fixed-step loop on
 * the same harness as the undo suite, and check the commit against the same
 * verifier the server uses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PuzzleRun } from "../client/src/game/runner";
import { decodeBoard, ENGINE_ROWS, type PuzzlePrompt } from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { type InputEvent, parseInputLog, verifyRun } from "../shared/tetris/verify";
import { PATIENCE, pump, pumpUntil, resetHarness, SAFE_LOCK_FRAMES } from "./harness";

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
  // Never met: an O dropped on an empty field clears nothing.
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

/** A spot on the floor row, the common case: the finger names the column. */
function floorAim(column: number): { column: number; row: number } {
  return { column, row: 0 };
}

beforeEach(() => {
  resetHarness();
});

describe("drag to place", () => {
  test("an aim at open floor is legal and commits one piece", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    expect(run.isAiming).toBe(true);

    expect(run.placeAt()).toBe(true);
    expect(run.isAiming).toBe(false);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.dispose();
  });

  test("the log the drag wrote replays on the server to the same placement", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    // Invariant, same one the undo suite holds the log to: the client and the
    // server may not disagree about what a drag meant.
    expect(parseInputLog(log)).toEqual(log);
    const verified = verifyRun(SETUP, DEFAULT_HANDLING, log);
    expect(verified.placements).toHaveLength(1);
    // The piece is where the finger left it: two columns wide, centred over
    // the aimed column (2), on the floor.
    expect([...verified.placements[0]!.cells].sort((a, b) => a[0] - b[0] || a[1] - b[1])).toEqual([
      [2, 0],
      [2, 1],
      [3, 0],
      [3, 1],
    ]);
    run.dispose();
  });

  test("a drag commits a legal key log, not a teleport", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    // Every event is a key the player could have pressed; there is no other
    // kind of event to send.
    for (const event of run.log()) {
      expect(event.type === "keydown" || event.type === "keyup").toBe(true);
    }
    // A hard drop ended it, as letting go of a drag means.
    expect(run.log().some((event) => event.data.key === "hardDrop")).toBe(true);
    run.dispose();
  });

  test("an aim in mid-air is shown but never commits", () => {
    const run = newRun();
    // Row 5 is open air on an empty board: a hard drop from anywhere above
    // falls through it, so nothing can lock exactly there.
    run.aimAt({ column: 2, row: 5 });
    expect(run.isAiming).toBe(true);

    expect(run.placeAt()).toBe(false);
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]);
    pump(PATIENCE);
    expect(run.snapshot().piecesPlaced).toBe(0);
    run.dispose();
  });

  test("a second commit without a fresh aim does nothing", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    expect(run.placeAt()).toBe(true);
    // The aim was consumed by the first commit; a stale one cannot drop a
    // piece the player has not aimed anywhere.
    expect(run.placeAt()).toBe(false);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    expect(run.snapshot().piecesPlaced).toBe(1);
    run.dispose();
  });

  test("a lock takes the aim away", () => {
    const run = newRun();
    run.aimAt(floorAim(6));
    expect(run.isAiming).toBe(true);
    // The player hard drops from the keyboard instead of committing the drag:
    // a real lock, which leaves the aim pointing at a board that no longer
    // exists.
    run.input("hardDrop", true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.input("hardDrop", false);
    pump(SAFE_LOCK_FRAMES);
    expect(run.isAiming).toBe(false);
    expect(run.placeAt()).toBe(false);
    run.dispose();
  });

  test("undo clears the aim, and a drag after an undo plays on", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    expect(run.undo()).toBe(true);
    expect(run.isAiming).toBe(false);

    // A fresh drag on the undone board works, and the server agrees.
    run.aimAt(floorAim(7));
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    const log = structuredClone(run.log()) as InputEvent[];
    expect(parseInputLog(log)).toEqual(log);
    expect(verifyRun(SETUP, DEFAULT_HANDLING, log).placements).toHaveLength(1);
    run.dispose();
  });

  test("restart clears the aim", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    expect(run.isAiming).toBe(true);
    run.restart();
    expect(run.isAiming).toBe(false);
    expect(run.placeAt()).toBe(false);
    run.dispose();
  });

  test("two drags in a row place two pieces", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    run.aimAt(floorAim(8));
    run.placeAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 2);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    expect(parseInputLog(log)).toEqual(log);
    expect(verifyRun(SETUP, DEFAULT_HANDLING, log).placements).toHaveLength(2);
    run.dispose();
  });

  test("tapping rotates, and a drag after a tap places the new shape", () => {
    const run = newRun();
    // The O is rotation-symmetric, so rotate a different way: tap hold, and
    // the dragged piece is the one hold produced.
    run.tap("hold");
    pump(1);
    run.aimAt(floorAim(5));
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    expect(run.snapshot().piecesPlaced).toBe(1);
    run.dispose();
  });

  test("keyboard input voids a standing aim", () => {
    const run = newRun();
    run.aimAt(floorAim(2));
    expect(run.isAiming).toBe(true);
    // Any key moves the piece, so the target computed for where it stood is
    // a promise about a piece that no longer exists.
    run.input("moveLeft", true);
    run.input("moveLeft", false);
    expect(run.isAiming).toBe(false);
    expect(run.placeAt()).toBe(false);
    run.dispose();
  });

  test("a rotation reaches the next aim without a frame in between", () => {
    // The second-finger rotate queues its key and immediately re-aims; no
    // frame runs in between. The aim must therefore see the piece the
    // rotation produces, not the one that was falling when it was tapped.
    const run = newRun();
    run.tap("rotateCW"); // no pump: the key is still in pending
    run.aimAt(floorAim(2));
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    // The spawned T lies flat (two rows tall, three wide); rotated CW it
    // stands up (three rows, two wide). The locked piece says which one the
    // drag was aimed at.
    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(SETUP, DEFAULT_HANDLING, log);
    expect(verified.placements).toHaveLength(1);
    const cells = verified.placements[0]!.cells;
    const width = Math.max(...cells.map(([x]) => x)) - Math.min(...cells.map(([x]) => x));
    expect(width).toBe(1); // a standing T, not the spawned flat one
    run.dispose();
  });

  test("a dragged S locks covering the cell the finger named", () => {
    // Cover-the-cell contract, checked end to end: the locked cells must
    // include the pointed square, whatever the piece's shape. An S's centroid
    // sits on a half-cell boundary between its blocks, so centring put the
    // piece one over from the finger — the staircase bug.
    const run = newRun();
    run.aimAt(floorAim(6));
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);
    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(SETUP, DEFAULT_HANDLING, log);
    expect(verified.placements[0]!.cells).toContainEqual([6, 0]);
    run.dispose();
  });

  test("a floor aim covers the named cell even for a staggered S", () => {
    // Cover-after-clamp: the nearest pre-clamp shift for a flat S aimed at
    // the floor belongs to an upper block and clamps one row off the finger.
    // The hollow must name the square it will lock, so it must still contain
    // the finger — and the lock must equal the hollow, not the finger's row.
    const sPuzzle: PuzzlePrompt = { ...PUZZLE, queue: ["S", "O", "O", "O", "O", "O"] };
    const run = new PuzzleRun(sPuzzle, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.aimAt(floorAim(6));
    const aim = run.view().aim;
    expect(aim).not.toBeNull();
    expect(aim!.cells).toContainEqual([6, 0]);
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(
      { board: decodeBoard(sPuzzle.board, ENGINE_ROWS), queue: sPuzzle.queue, hold: sPuzzle.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect(verified.placements[0]!.cells).toContainEqual([6, 0]);
    expect([...verified.placements[0]!.cells].sort()).toEqual([...aim!.cells].sort());
    run.dispose();
  });

  test("a drag sliding one square keeps a covering hollow steady", () => {
    // Gesture stability: while the finger stays inside the hollow it already
    // saw, the hollow stays put instead of re-centring under the finger; once
    // the finger leaves it, the hollow follows by exactly the finger's move.
    const sPuzzle: PuzzlePrompt = { ...PUZZLE, queue: ["S", "O", "O", "O", "O", "O"] };
    const run = new PuzzleRun(sPuzzle, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.tap("rotateCW");
    run.aimAt(floorAim(4));
    const first = [...run.view().aim!.cells].sort();
    expect(first).toContainEqual([4, 0]);

    run.aimAt({ column: 4, row: 1 });
    const steadied = [...run.view().aim!.cells].sort();
    expect(steadied).toEqual(first);

    run.aimAt({ column: 4, row: 2 });
    const followed = [...run.view().aim!.cells].sort();
    const shifted = first.map(([x, y]) => [x, y + 1] as const).sort();
    expect(followed).toEqual(shifted);
    run.dispose();
  });

  test("a T dropped deep into a slot locks exactly the hollow", () => {
    // Same descent parity for a T in a deep shaft: the route must genuinely
    // drop before its final rotation reaches the seat, and the committed log
    // plays the identical batches, so preview and lock cannot diverge.
    const deep: PuzzlePrompt = {
      ...PUZZLE,
      board: ["XXX.XXXXXX", "XXX...XXXX", "XXX...XXXX"],
      queue: ["T", "O", "O", "O", "O", "O"],
      targetAttack: 1,
    };
    const run = new PuzzleRun(deep, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.tap("rotateCW");
    run.tap("rotateCW");
    pump(2);
    run.aimAt({ column: 4, row: 1 });
    const aim = run.view().aim;
    expect(aim).not.toBeNull();
    expect(aim!.legal).toBe(true);
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(
      { board: decodeBoard(deep.board, ENGINE_ROWS), queue: deep.queue, hold: deep.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect([...verified.placements[0]!.cells].sort()).toEqual([...aim!.cells].sort());
    run.dispose();
  });

  test("a flat T dragged at a TSD mouth claims no spin", () => {
    // Ask honesty: the finger names the square *and* the pre-chosen rotation.
    // A flat T over a TSD notch is not a spin ask — it is unreachable — so
    // the hollow is dashed and nothing commits, rather than a double wearing
    // the slot's shape. The spin comes from two taps first (see below).
    const tsd: PuzzlePrompt = {
      ...PUZZLE,
      board: ["XXXX.XXXXX", "XXX...XXXX"],
      queue: ["T", "O", "O", "O", "O", "O"],
      targetAttack: 1,
    };
    const run = new PuzzleRun(tsd, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.aimAt({ column: 4, row: 0 });
    expect(run.view().aim?.legal).toBe(false);
    expect(run.placeAt()).toBe(false);
    expect(run.snapshot().piecesPlaced).toBe(0);
    run.dispose();
  });

  test("a drag whose route drops before its final kick locks exactly the hollow", () => {
    // Trial/commit parity: candidates used to be replayed with `press`,
    // where a mid-route soft drop falls at once, while the commit taps it
    // through `tick`, where a same-frame tap holds nothing and falls nowhere
    // — so a kick after the drop fired from two different heights and the
    // piece locked a kick away from the preview. Trials now tick the taps the
    // log will carry, so a solid hollow is a seat the log lands on.
    const sPuzzle: PuzzlePrompt = { ...PUZZLE, queue: ["S", "O", "O", "O", "O", "O"] };
    const run = new PuzzleRun(sPuzzle, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.tap("rotateCCW");
    run.aimAt(floorAim(0));
    const aim = run.view().aim;
    expect(aim).not.toBeNull();
    expect(aim!.legal).toBe(true);
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(
      { board: decodeBoard(sPuzzle.board, ENGINE_ROWS), queue: sPuzzle.queue, hold: sPuzzle.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect([...verified.placements[0]!.cells].sort()).toEqual([...aim!.cells].sort());
    run.dispose();
  });

  test("a seat needing a mid-route descent locks exactly the hollow", () => {
    // Descent parity: the staircase seat beside the teeth needs a real drop
    // before its final kick — a same-frame tap falls nowhere, so the commit
    // holds its soft drop across a tick boundary, and the trial plays the
    // identical batches. The hollow is solid and the log lands on it.
    const stair: PuzzlePrompt = {
      ...PUZZLE,
      board: [
        "....XXXXXX",
        "...XXXXXXX",
        "..XXXXXXXX",
      ],
      queue: ["S", "O", "O", "O", "O", "O"],
      targetAttack: 1,
    };
    const run = new PuzzleRun(stair, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    run.tap("rotateCW");
    run.aimAt({ column: 1, row: 1 });
    const aim = run.view().aim;
    expect(aim).not.toBeNull();
    expect(aim!.cells).toContainEqual([1, 1]);
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(
      { board: decodeBoard(stair.board, ENGINE_ROWS), queue: stair.queue, hold: stair.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect([...verified.placements[0]!.cells].sort()).toEqual([...aim!.cells].sort());
    run.dispose();
  });

  test("pointing at a cell the piece already covers does not move it", () => {
    // The minimal-nudge invariant that discriminates cover-the-cell from
    // centring. The S spawns flat with its centroid on a half-cell boundary
    // (x̄ = 4), so centring a pointed-at block rounds to a spurious one-cell
    // shift; covering picks the zero shift. The O cannot discriminate — its
    // half-cell centroid rounds to no shift either way — hence the S queue.
    const sPuzzle: PuzzlePrompt = { ...PUZZLE, queue: ["S", "O", "O", "O", "O", "O"] };
    const run = new PuzzleRun(sPuzzle, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    // The piece's own current cells, read from the view the renderer gets:
    // the flat S occupies (3,18), (4,18), (4,19), (5,19).
    const active = [...run.view().active].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(active).toEqual([[3, 18], [4, 18], [4, 19], [5, 19]]);
    // Aim at the leftmost block the piece already sits on.
    run.aimAt({ column: 3, row: 18 });
    const aim = run.view().aim;
    expect(aim).not.toBeNull();
    // The previewed target is the piece exactly where it stands: no shift.
    expect([...aim!.cells].sort((a, b) => a[0] - b[0] || a[1] - b[1])).toEqual(active);
    run.dispose();
  });

  test("a standing S dragged into a staircase nook locks covering the pointed cell", () => {
    // The reported bug: rotate an S vertical, drag it at the staircase, and
    // it locked one up and to the left of the seat. The nook cell the finger
    // names must be part of the piece that locks.
    const stair: PuzzlePrompt = {
      ...PUZZLE,
      // A staircase descending left-to-right, open cells hugging the wall.
      board: [
        "....XXXXXX",
        "...XXXXXXX",
        "..XXXXXXXX",
      ],
      queue: ["S", "O", "O", "O", "O", "O"],
      targetAttack: 1,
    };
    const run = new PuzzleRun(stair, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    // One tap stands the S up, then the drag points at the nook: the open
    // cell one above the floor against the left wall.
    run.tap("rotateCW");
    run.aimAt({ column: 0, row: 1 });
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(
      { board: decodeBoard(stair.board, ENGINE_ROWS), queue: stair.queue, hold: stair.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect(verified.placements[0]!.cells).toContainEqual([0, 1]);
    run.dispose();
  });

  test("a kick placement earns its spin through a drag", () => {
    // A T over a classic TSD notch: a hole two rows deep at column 4 with a
    // solid roof either side. The square is unreachable by sliding — the last
    // input of any honest route into it is a rotation, and the engine has to
    // be the one to say the spin counted.
    const tsd: PuzzlePrompt = {
      ...PUZZLE,
      board: ["XXXX.XXXXX", "XXX...XXXX"],
      queue: ["T", "O", "O", "O", "O", "O"],
      targetAttack: 1,
    };
    const run = new PuzzleRun(tsd, DEFAULT_HANDLING, {
      onFrame: () => {},
      onFinish: () => {},
      onLock: () => {},
    });
    // The spawned T comes to rest flat in the notch's mouth, nub up — the
    // wrong way round. Two taps turn it over (one batch, two rotations), and
    // the drag carries it the rest of the way: the same rotate-then-place
    // flow a thumb plays on a phone.
    run.tap("rotateCW");
    run.tap("rotateCW");
    pump(2); // the taps reach the engine on their frames, like on a real board
    run.aimAt({ column: 4, row: 0 });
    expect(run.placeAt()).toBe(true);
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    pump(SAFE_LOCK_FRAMES);

    // The attack is the whole point: a TSD sends 11 and it is reachable only
    // if the replayed kick route was credited as a spin.
    const log = structuredClone(run.log()) as InputEvent[];
    const verified = verifyRun(
      { board: decodeBoard(tsd.board, ENGINE_ROWS), queue: tsd.queue, hold: tsd.hold },
      DEFAULT_HANDLING,
      log,
    );
    expect(verified.placements).toHaveLength(1);
    expect(verified.attack).toBe(11);
    // The toy board is two rows, so the TSD that fills its last two holes is
    // also a perfect clear — the engine calls the PC, which is the stronger
    // name for the same credited spin.
    expect(verified.clears).toEqual(["perfect clear"]);
    run.dispose();
  });
});
