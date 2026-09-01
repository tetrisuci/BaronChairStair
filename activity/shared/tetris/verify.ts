/**
 * Replays a recorded input log and reports what it achieved.
 *
 * The client sends the keys it pressed, not the score it thinks it earned, and
 * the server re-runs them here. Same engine, same puzzle, same handling — so
 * the number on the leaderboard is one the engine produced from inputs someone
 * actually made, and the client can show the identical result without asking.
 */

import type { LockRes } from "@haelp/teto/engine";
import type { ClearName, Mino } from "../puzzle";
import { createPuzzleEngine, type PuzzleSetup, toLetter } from "./engine";
import { type Handling, sanitizeHandling } from "./handling";
import { nameClear } from "./replay";

const FRAMES_PER_SECOND = 60;

/** Half an hour of frames — well past any real attempt, short of a denial of service. */
export const MAX_FRAMES = FRAMES_PER_SECOND * 60 * 30;
export const MAX_EVENTS = 20_000;

/**
 * Frame numbers come from the client and nothing ties them to a real clock, so
 * a submitted time is a claim, not a measurement. This is the floor under that
 * claim: the fastest human play tops out around six pieces a second, so a tenth
 * of a second per piece is far below anybody real and far above a log renumbered
 * to zero. See the note on timing in the README.
 */
const MIN_MS_PER_PIECE = 100;

/**
 * The engine's key names. Declared here rather than imported from the package
 * root so the browser bundle never pulls in the TETR.IO network client.
 */
export type GameKey =
  | "moveLeft"
  | "moveRight"
  | "rotateCW"
  | "rotateCCW"
  | "rotate180"
  | "softDrop"
  | "hardDrop"
  | "hold";

const PLAYABLE_KEYS = new Set<GameKey>([
  "moveLeft",
  "moveRight",
  "rotateCW",
  "rotateCCW",
  "rotate180",
  "softDrop",
  "hardDrop",
  "hold",
]);

export type InputEvent = {
  readonly frame: number;
  readonly type: "keydown" | "keyup";
  readonly data: { readonly key: GameKey; readonly subframe: number };
};

export interface VerifiedPlacement {
  readonly piece: Mino;
  readonly cells: readonly (readonly [number, number])[];
  readonly clear: ClearName | null;
  readonly attack: number;
  readonly frame: number;
}

export interface VerifiedRun {
  readonly attack: number;
  readonly placements: readonly VerifiedPlacement[];
  readonly clears: readonly ClearName[];
  /** Wall-clock from the first input to the last lock. */
  readonly durationMs: number;
  readonly toppedOut: boolean;
}

export class InvalidRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRunError";
  }
}

/**
 * Checks an untrusted input log into something safe to replay: bounded length,
 * sane frame numbers, known keys, and non-decreasing frame order.
 */
export function parseInputLog(input: unknown): InputEvent[] {
  if (!Array.isArray(input)) throw new InvalidRunError("Input log must be an array");
  if (input.length > MAX_EVENTS) {
    throw new InvalidRunError(`Input log too long (${input.length} > ${MAX_EVENTS})`);
  }

  const events: InputEvent[] = [];
  let previousFrame = -1;
  for (const [index, raw] of input.entries()) {
    const event = raw as InputEvent;
    const frame = event?.frame;
    const key = event?.data?.key;
    const subframe = event?.data?.subframe;

    if (!Number.isInteger(frame) || frame < 0 || frame > MAX_FRAMES) {
      throw new InvalidRunError(`Event ${index}: frame out of range`);
    }
    if (frame < previousFrame) throw new InvalidRunError(`Event ${index}: frames go backwards`);
    if (event.type !== "keydown" && event.type !== "keyup") {
      throw new InvalidRunError(`Event ${index}: unknown type`);
    }
    if (!PLAYABLE_KEYS.has(key)) throw new InvalidRunError(`Event ${index}: unknown key`);
    if (typeof subframe !== "number" || !(subframe >= 0 && subframe < 1)) {
      throw new InvalidRunError(`Event ${index}: subframe must be in [0, 1)`);
    }

    previousFrame = frame;
    events.push({ frame, type: event.type, data: { key, subframe } });
  }
  return events;
}

/**
 * Replays `events` against `setup`.
 *
 * Stops as soon as the puzzle's own pieces are spent, so nothing the player
 * does can reach the filler the engine keeps behind them.
 */
export function verifyRun(
  setup: PuzzleSetup,
  handling: Handling,
  events: readonly InputEvent[],
): VerifiedRun {
  const { engine, ledger } = createPuzzleEngine(setup, sanitizeHandling(handling));
  const placements: VerifiedPlacement[] = [];
  let toppedOut = false;
  let spentBeyondThePuzzle = false;

  // The falling piece is replaced before `falling.lock` fires, so its squares
  // are captured on the way in.
  let cellsBeforeLock: (readonly [number, number])[] = [];
  engine.events.on("falling.lock.pre", () => {
    cellsBeforeLock = engine.falling.absoluteBlocks.map(([x, y]) => [x, y] as const);
  });

  engine.events.on("falling.lock", (lock: LockRes) => {
    const piece = toLetter(lock.mino);
    if (piece === null || piece === "G") return;
    // A lock the ledger cannot account for means the log has run past the
    // puzzle's own pieces. The client ends the run there; so must this, or the
    // replay keeps going through pieces that were never on offer.
    if (!ledger.spend(piece)) {
      spentBeyondThePuzzle = true;
      return;
    }
    placements.push({
      piece,
      cells: cellsBeforeLock,
      clear: nameClear(lock, engine.board.perfectClear),
      attack: lock.garbage.reduce((total, value) => total + value, 0),
      frame: engine.frame,
    });
    if (lock.topout) toppedOut = true;
  });

  const firstInputFrame = events[0]?.frame ?? 0;
  let cursor = 0;

  // Run until the puzzle's pieces are spent, not until the last key. A piece
  // seated with soft drop locks when its lock delay expires, which is after the
  // final input — stopping at the last event would score those runs as if the
  // player had never placed anything. The frame ceiling is only the bound that
  // keeps a hostile log from spinning; an empty one costs about 18ms.
  while (engine.frame <= MAX_FRAMES && ledger.remaining > 0 && !spentBeyondThePuzzle) {
    const batch: InputEvent[] = [];
    while (cursor < events.length && events[cursor]!.frame === engine.frame) {
      batch.push(events[cursor]!);
      cursor++;
    }
    engine.tick(batch as never);
  }

  const lastPlacementFrame = placements[placements.length - 1]?.frame ?? firstInputFrame;
  const claimed = ((lastPlacementFrame - firstInputFrame) / FRAMES_PER_SECOND) * 1000;
  return {
    attack: placements.reduce((total, placement) => total + placement.attack, 0),
    placements,
    clears: placements.flatMap((placement) => (placement.clear ? [placement.clear] : [])),
    durationMs: Math.round(Math.max(claimed, placements.length * MIN_MS_PER_PIECE)),
    toppedOut,
  };
}
