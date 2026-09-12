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

// ── The carry's endings: place, park, reset ────────────────────────────────

const STACKED: PuzzlePrompt = {
  id: 2,
  title: "stacked",
  author: "test",
  difficulty: 1,
  goal: "place beside a stack",
  set: null,
  // One row of stack on the left; the right half is open floor.
  board: ["GGGG......"],
  queue: ["O", "O", "O", "O", "O", "O"],
  hold: null,
  targetAttack: 4,
};

function newStackedRun(): PuzzleRun {
  return new PuzzleRun(STACKED, DEFAULT_HANDLING, {
    onFrame: () => {},
    onFinish: () => {},
    onLock: () => {},
  });
}

/** The run's on-board preview — the live aim, or the seat a release parked. */
function previewOf(run: PuzzleRun) {
  return run.view().aim;
}

/** The preview's bottom-leftmost corner, for shifts named by corner seat. */
function cornerOf(cells: readonly (readonly [number, number])[]): { column: number; row: number } {
  // Board rows grow upward from the floor at row 0, so the corner that
  // "sits" on a named row is the piece's minimum row — its bottom.
  let column = Infinity;
  let row = Infinity;
  for (const [x, y] of cells) {
    if (x < column) column = x;
    if (y < row) row = y;
  }
  return { column, row };
}

/** The carry shift that moves the current preview's corner to the given seat. */
function shiftTo(run: PuzzleRun, column: number, row: number): { column: number; row: number } {
  const preview = previewOf(run);
  if (!preview) throw new Error("no preview to shift from");
  const from = cornerOf(preview.cells);
  return { column: column - from.column, row: row - from.row };
}

const sorted = (cells: readonly (readonly [number, number])[]) =>
  [...cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

describe("the carry's endings", () => {
  test("a grab previews the piece where it is and moves nothing", () => {
    const run = newStackedRun();
    run.grabBase();
    // The grab itself shows nothing — the piece is where it was.
    expect(previewOf(run)).toBeNull();
    // The first carry of zero names the piece's own position: legal, at spawn.
    run.carryAt({ column: 0, row: 0 });
    // Shown where the piece is — floating at spawn, which no route can place,
    // so the preview is the dashed illegal one: visible, and not a lie.
    expect(previewOf(run)?.legal).toBe(false);
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]);
    run.dispose();
  });

  test("a release on a placeable seat commits exactly what was previewed", () => {
    const run = newStackedRun();
    run.grabBase();
    // The first carry of zero names the piece's own position.
    run.carryAt({ column: 0, row: 0 }); // the grab: preview at the piece
    const shown = sorted(previewOf(run)!.cells);
    run.carryAt(shiftTo(run, 8, 0)); // corner to open floor right of the stack
    expect(previewOf(run)?.legal).toBe(true);
    run.settleAt();
    expect(previewOf(run)).toBeNull(); // committed: no preview left
    pumpUntil(() => run.snapshot().piecesPlaced === 1);

    // What locked is what was shown, shifted to the seat the finger named.
    const committed = run.view().cells;
    for (const [x, y] of shown) {
      const dx = 8 - cornerOf(shown).column;
      const dy = 0 - cornerOf(shown).row;
      expect(committed[y + dy]![x + dx]).not.toBeNull();
    }
    run.dispose();
  });

  test("a release on an obstructed seat parks the piece exactly as previewed", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 0, 0)); // corner onto the stack: shown, not placeable
    const preview = previewOf(run)!;
    expect(preview.legal).toBe(false);
    const shown = sorted(preview.cells);
    run.settleAt();
    // The park is the preview, kept — the dashed ghost stays on the stack.
    const parked = previewOf(run)!;
    expect(parked.legal).toBe(false);
    expect(sorted(parked.cells)).toEqual(shown);
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]); // nothing was spent parking
    run.dispose();
  });

  test("a release off the board resets, and the piece can still be placed after", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0)); // a legal seat first...
    expect(previewOf(run)).not.toBeNull();
    run.carryAt({ column: -9, row: 0 }); // ...then carried past the left edge
    // Off the board the preview drops — that is the reset — but the drag
    // stays live, and the finger can come back before releasing.
    expect(previewOf(run)).toBeNull();
    run.settleAt(); // the finger let go while off-board
    expect(previewOf(run)).toBeNull();
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]);

    // The piece is alive: a fresh drag places it as if nothing happened.
    // (The zero carry shows the piece floating where it is — dashed, as
    // always for a seat no route can reach — and the floor shift commits.)
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    expect(previewOf(run)).not.toBeNull();
    run.carryAt(shiftTo(run, 8, 0));
    expect(previewOf(run)?.legal).toBe(true);
    run.settleAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.dispose();
  });

  test("a re-drag after parking starts from the parked seat", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 0, 0)); // park on the stack
    run.settleAt();
    const parked = sorted(previewOf(run)!.cells);

    // The next drag anchors at the park: a zero carry shows the same seat.
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    expect(sorted(previewOf(run)!.cells)).toEqual(parked);
    // Carried off the stack to open floor, it commits from there.
    run.carryAt(shiftTo(run, 8, 0));
    expect(previewOf(run)?.legal).toBe(true);
    run.settleAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.dispose();
  });

  test("releasing off-board from a park resets the park, and the piece falls on", () => {
    const run = newStackedRun();
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 0, 0)); // park on the stack
    run.settleAt();
    expect(previewOf(run)).not.toBeNull(); // the dashed ghost stands

    // The finger comes back, drags the parked ghost past the top edge and
    // lets go there: the park must go with it — the reset is the same reset
    // a falling piece gets, not a park that survives its own drag.
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt({ column: 0, row: 60 }); // every cell above the ceiling
    expect(previewOf(run)).toBeNull(); // preview dropped, drag still live
    run.settleAt();
    expect(previewOf(run)).toBeNull(); // the park did not survive
    expect(run.snapshot().piecesPlaced).toBe(0);
    expect(run.log()).toEqual([]); // and nothing was spent by any of it

    // The piece is untouched and placeable, as after any reset.
    run.grabBase();
    run.carryAt({ column: 0, row: 0 });
    run.carryAt(shiftTo(run, 8, 0));
    expect(previewOf(run)?.legal).toBe(true);
    run.settleAt();
    pumpUntil(() => run.snapshot().piecesPlaced === 1);
    run.dispose();
  });
});
