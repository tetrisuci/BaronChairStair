/**
 * One engine configuration, used by both the build pipeline and the browser.
 *
 * The build pipeline replays each archived solution to derive its attack value;
 * the browser runs the player's attempt. If those two ran different physics the
 * target would be a lie, so the config lives here and nowhere else.
 */

import { Engine, Mino } from "@haelp/teto/engine";
import type { EngineInitializeParams } from "@haelp/teto/engine";
import { BOARD_HEIGHT, BOARD_WIDTH, type BoardCell, type Mino as Letter } from "../puzzle";
import { DEFAULT_HANDLING, type Handling, toEngineHandling } from "./handling";
import { PieceLedger } from "./ledger";

/** Rows above the visible field where pieces spawn and rotate. */
const SPAWN_BUFFER = 20;

/**
 * Locking a piece always spawns the next one, so the engine needs pieces left
 * over after the puzzle's last placement. These are never shown or playable —
 * the run ends once the puzzle's own pieces are spent.
 */
const TRAILING_FILLER_PIECES = 2;

/**
 * The piece the padding is made of. Must stay a single fixed type: the ledger
 * is a multiset keyed by type, so a filler that could be mistaken for a piece
 * the puzzle owes is only harmless while every filler is the same type.
 */
const FILLER_PIECE = Mino.I;

const LETTER_TO_MINO: Readonly<Record<Letter, Mino>> = {
  I: Mino.I,
  J: Mino.J,
  L: Mino.L,
  O: Mino.O,
  S: Mino.S,
  T: Mino.T,
  Z: Mino.Z,
};

const MINO_TO_LETTER: ReadonlyMap<string, Letter | "G"> = new Map([
  [Mino.I, "I"], [Mino.J, "J"], [Mino.L, "L"], [Mino.O, "O"],
  [Mino.S, "S"], [Mino.T, "T"], [Mino.Z, "Z"], [Mino.GARBAGE, "G"],
]);

export function toMino(letter: Letter): Mino {
  return LETTER_TO_MINO[letter];
}

export function toLetter(mino: string | null | undefined): Letter | "G" | null {
  return mino == null ? null : (MINO_TO_LETTER.get(mino) ?? null);
}

/**
 * TETR.IO spawns pieces two rows above the field and lets gravity carry them
 * in. A puzzle has no gravity, so a spawned piece would sit forever in a place
 * the player cannot see. Nudging it down to the highest fully-visible row keeps
 * the piece on screen without moving it anywhere the player did not put it.
 */
function settleIntoView(engine: Engine): void {
  const topRow = engine.board.height - 1;
  for (let step = 0; step < SPAWN_BUFFER; step++) {
    const blocks = engine.falling.absoluteBlocks;
    if (blocks.every(([, y]) => y <= topRow)) return;
    const below = engine.falling.absoluteAt({ y: engine.falling.location[1] - 1 });
    if (below.some(([x, y]) => engine.board.occupied(x, y))) return;
    engine.falling.location[1] -= 1;
  }
}

/**
 * Keeps at least one piece behind the falling one, forever.
 *
 * A tick can contain any number of locks — every hard drop in a single frame is
 * processed in one `tick` — so a guard that only runs between ticks cannot stop
 * the queue emptying. `nextPiece` on an empty queue calls
 * `initiatePiece(undefined)` and throws, which for the server means a replayed
 * log can crash the request. The padding is always `Mino.I`, an invariant the
 * ledger depends on: a filler I and a real I are interchangeable to a multiset
 * keyed by piece type, so topping up can never hand out a piece the puzzle
 * does not owe.
 */
function restockQueue(engine: Engine): { spawnedFromPadding: boolean } {
  // Read before refilling, and returned rather than offered as its own
  // function, because refilling is exactly what destroys the evidence: a queue
  // that has been topped up always looks stocked. These were two functions
  // once, called in that order, and the padding check spent its whole life
  // reading a queue that had just been refilled — so it answered "no" every
  // time, the held piece was never dealt, and a puzzle whose last piece was in
  // hold handed the player a filler instead and could not be finished.
  const spawnedFromPadding = engine.queue.length < TRAILING_FILLER_PIECES;
  while (engine.queue.length < TRAILING_FILLER_PIECES) engine.queue.push(FILLER_PIECE);
  return { spawnedFromPadding };
}

/** Real pieces still waiting in the queue, ignoring the padding behind them. */
function queuedPieces(engine: Engine): number {
  return engine.queue.length - TRAILING_FILLER_PIECES;
}

/** The piece a hold would put in the player's hands right now. */
function pieceHoldWouldGive(engine: Engine): Letter | null {
  const source = engine.held ?? (queuedPieces(engine) > 0 ? engine.queue[0] : null);
  const letter = toLetter(source);
  return letter === "G" ? null : letter;
}

/**
 * Deals the held piece when the queue has nothing real left.
 *
 * A puzzle's pieces live in the queue and in hold; when the queue runs dry the
 * held piece is simply the next one. Left alone the engine would spawn its own
 * padding instead, and the player would have to know to press hold to rescue
 * their last piece from behind it.
 */
function dealHeldPieceIfQueueIsSpent(engine: Engine, ledger: PieceLedger): void {
  if (engine.held === null) return;
  const held = toLetter(engine.held);
  if (held === null || held === "G" || !ledger.owes(held)) return;
  engine.hold(false, true);
}

/**
 * Takes hold away when using it could not produce a piece the puzzle owes —
 * an empty hold with nothing real left to draw, or a hold holding padding.
 * Either way the key would cost the player a piece and give back a phantom.
 */
function lockHoldWhenNothingToSwap(engine: Engine, ledger: PieceLedger): void {
  const candidate = pieceHoldWouldGive(engine);
  if (candidate === null || !ledger.owes(candidate)) engine.holdLocked = true;
}

export interface PuzzleSetup {
  /** Rows bottom-up, `board[0]` is the floor. */
  readonly board: readonly BoardCell[][];
  readonly queue: readonly Letter[];
  readonly hold: Letter | null;
}

/**
 * TETR.IO's modern versus ruleset with the multiplayer parts switched off.
 * Gravity is zero: a puzzle is a placement problem, not a reaction test.
 */
export function buildEngineParams(handling: Handling = DEFAULT_HANDLING): EngineInitializeParams {
  return {
    board: { width: BOARD_WIDTH, height: BOARD_HEIGHT, buffer: SPAWN_BUFFER },
    kickTable: "SRS+",
    options: {
      spinBonuses: "all-mini+",
      comboTable: "multiplier",
      garbageTargetBonus: "none",
      garbageBlocking: "combo blocking",
      clutch: true,
      stock: 0,
    },
    // The queue is overwritten with the puzzle's exact pieces. The engine spawns
    // a piece during construction, so it needs a non-empty bag to start from.
    queue: { seed: 0, type: "7-bag", minLength: 7 },
    gravity: { value: 0, increase: 0, marginTime: 0 },
    garbage: {
      cap: { value: 8, marginTime: 0, increase: 0, absolute: 0, max: 40 },
      messiness: { change: 0, within: 0, nosame: true, timeout: 0, center: false },
      garbage: { speed: 20, holeSize: 1 },
      multiplier: { value: 1, increase: 0, marginTime: 0 },
      bombs: false,
      seed: 0,
      boardWidth: BOARD_WIDTH,
      rounding: "down",
      openerPhase: 0,
      specialBonus: false,
    },
    // Converted here and nowhere else: everything outside the engine measures
    // handling in milliseconds.
    handling: toEngineHandling(handling),
    b2b: { chaining: true, charging: false },
    pc: { garbage: 10, b2b: 0 },
    misc: {
      movement: { infinite: false, lockResets: 15, lockTime: 30, may20G: true },
      allowed: { spin180: true, hardDrop: true, hold: true, undo: false, retry: false },
      /**
     * Hold as often as you like, rather than once per piece.
     *
     * A puzzle is a placement problem, not a dexterity test: the pieces are
     * fixed and known, so rationing the swap only makes the player re-derive
     * an order they could have seen by trying it. The ledger still decides
     * what may be played, so an unlimited swap cannot conjure a piece the
     * puzzle does not owe.
     */
    infiniteHold: true,
      stride: false,
      username: "puzzle",
    },
    multiplayer: { opponents: [], passthrough: "zero" },
  };
}

/**
 * Loads a puzzle position into a fresh engine: the stack, the exact queue, and
 * any pre-held piece. Returns the engine ready for its first input.
 */
export interface PuzzleEngine {
  readonly engine: Engine;
  /**
   * The pieces the puzzle still owes. Created here because the engine's own
   * rules depend on it, and handed back because the caller is what decides a
   * lock has happened — spending is the caller's job, reading is this file's.
   */
  readonly ledger: PieceLedger;
}

export function createPuzzleEngine(setup: PuzzleSetup, handling: Handling): PuzzleEngine {
  const engine = new Engine(buildEngineParams(handling));
  const ledger = new PieceLedger(setup.queue, setup.hold);

  const height = Math.min(setup.board.length, engine.board.fullHeight);
  for (let y = 0; y < height; y++) {
    const row = setup.board[y]!;
    for (let x = 0; x < Math.min(row.length, BOARD_WIDTH); x++) {
      const cell = row[x];
      if (!cell) continue;
      const mino = cell === "G" ? Mino.GARBAGE : LETTER_TO_MINO[cell];
      engine.board.state[y]![x] = { mino, connections: 0 };
    }
  }

  // `hold` below spawns a piece, which re-enters this handler; the guard stops
  // it dealing the piece it has just dealt, over and over.
  let dealing = false;
  engine.events.on("falling.new", () => {
    settleIntoView(engine);
    const { spawnedFromPadding } = restockQueue(engine);
    if (dealing) return;
    dealing = true;
    try {
      if (spawnedFromPadding) dealHeldPieceIfQueueIsSpent(engine, ledger);
      lockHoldWhenNothingToSwap(engine, ledger);
    } finally {
      dealing = false;
    }
  });

  // A puzzle queue is finite and exact, so switch off refills before replacing
  // the bag the constructor drew from.
  engine.queue.minLength = 0;
  engine.queue.clear();
  const pieces = setup.queue.map(toMino);
  engine.queue.push(...pieces, ...Array<Mino>(TRAILING_FILLER_PIECES).fill(FILLER_PIECE));
  engine.held = setup.hold ? LETTER_TO_MINO[setup.hold] : null;
  engine.nextPiece(true);

  return { engine, ledger };
}

/** Playfield as letters, bottom-up, for rendering and comparison. */
export function readBoard(engine: Engine, rows = engine.board.fullHeight): BoardCell[][] {
  return Array.from({ length: rows }, (_, y) =>
    Array.from({ length: BOARD_WIDTH }, (_, x) => toLetter(engine.board.state[y]?.[x]?.mino)),
  );
}
