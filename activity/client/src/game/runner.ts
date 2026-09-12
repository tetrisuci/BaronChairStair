/**
 * The run: one attempt at one puzzle.
 *
 * Owns an engine, a fixed-timestep clock, and the log of every key the player
 * pressed. The log is the only thing sent to the server — the score is whatever
 * the server gets when it replays those keys, so this class never has to be
 * trusted, only correct.
 */

import type { Engine } from "@haelp/teto/engine";
import type { PieceLedger } from "@shared/tetris/ledger";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  ENGINE_ROWS,
  type BoardCell,
  type ClearName,
  decodeBoard,
  solvesPuzzle,
  type Mino,
  pieceBudget,
  type PuzzlePrompt,
} from "@shared/puzzle";
import { createPuzzleEngine, readBoard, toLetter } from "@shared/tetris/engine";
import type { Handling } from "@shared/tetris/handling";
import { RoutePlanner, releaseTicks, ticksForRoute, type TargetCells } from "@shared/tetris/pathfinder";
import {
  clearsOf,
  creditPlacements,
  type ScoredPlacement,
  total,
} from "@shared/tetris/credit";
import { nameClear } from "@shared/tetris/replay";
import type { GameKey, InputEvent } from "@shared/tetris/verify";
import { MAX_EVENTS, MAX_FRAMES } from "@shared/tetris/verify";
import type { BoardView } from "../render/board";
import { MINO_INK } from "../render/skin";

const FRAME_MS = 1000 / 60;
/** After a tab-away, catch up at most this much rather than freezing. */
const MAX_CATCHUP_MS = 250;
const FLASH_MS = 220;

export type RunPhase = "ready" | "playing" | "solved" | "failed";

export interface RunSnapshot {
  readonly phase: RunPhase;
  readonly attack: number;
  readonly targetAttack: number;
  readonly piecesPlaced: number;
  readonly pieceBudget: number;
  readonly clears: readonly ClearName[];
  /** Wall clock since the puzzle was opened, across every attempt. */
  readonly elapsedMs: number;
  readonly resets: number;
  readonly hold: Mino | null;
  readonly upcoming: readonly Mino[];
  readonly holdLocked: boolean;
}

export interface RunCallbacks {
  /** Called every rendered frame with the state to draw. */
  readonly onFrame: (view: BoardView, snapshot: RunSnapshot) => void;
  /** Called once when the attempt ends, with the log to submit. */
  readonly onFinish: (snapshot: RunSnapshot, events: readonly InputEvent[]) => void;
  readonly onLock: (clear: ClearName | null, attack: number) => void;
}

/**
 * Where a placement left the log: how long it was, and the frame it locked on.
 *
 * The frame is the half undo cannot do without. A key held through the lock has
 * to be let go of after that lock, not at the keypress that started it.
 */
interface Checkpoint {
  readonly length: number;
  readonly frame: number;
}

/** A square on the board a gesture is pointing at. */
export interface BoardSpot {
  readonly column: number;
  readonly row: number;
}

/** What undo took out of the log, and what it put back in to close the rest. */
interface UndoneSegment {
  readonly events: readonly InputEvent[];
  /** Keyups undo appended, dropped again so redo restores the log verbatim. */
  readonly closers: number;
  readonly checkpoint: Checkpoint;
}

/** The keys a log leaves down, in the order they were first touched. */
function keysHeldAfter(events: readonly InputEvent[]): GameKey[] {
  const state = new Map<GameKey, boolean>();
  for (const event of events) state.set(event.data.key, event.type === "keydown");
  return [...state].flatMap(([key, down]) => (down ? [key] : []));
}

/**
 * Keyups that release everything `events` leaves held, as of `frame`.
 *
 * The frame is the one the placement locked on rather than the last event's: a
 * piece seated with soft drop locks well after the key that seated it, so
 * releasing at the keypress would replay a piece that never lands. Subframe
 * zero puts the release before that frame's gravity, leaving the piece the lock
 * spawned exactly where the engine put it.
 */
function closingKeyups(events: readonly InputEvent[], frame: number): InputEvent[] {
  return keysHeldAfter(events).map((key) => ({
    // Clamped because the server parses this log under its own bounds, and a
    // synthetic event has to sit inside them like every typed one.
    frame: Math.min(frame, MAX_FRAMES),
    type: "keyup" as const,
    data: { key, subframe: 0 },
  }));
}

export class PuzzleRun {
  private engine!: Engine;
  private ledger!: PieceLedger;
  /** The full log, submitted at the end. */
  private events: InputEvent[] = [];
  /** Events not yet handed to the engine, drained on the next tick. */
  private pending: InputEvent[] = [];
  private readonly held = new Set<GameKey>();

  private phase: RunPhase = "ready";
  private accumulator = 0;
  private lastTimestamp = 0;
  private rafHandle = 0;

  private attack = 0;
  private piecesPlaced = 0;
  private clears: ClearName[] = [];
  /**
   * Every placement the puzzle's own pieces have made, with what the engine
   * gave it at the time.
   *
   * The verdict is taken on these rather than on the running totals, because
   * the same squares can score two ways depending on the kick that reached
   * them and the puzzle's target was set by the better one. See `credit.ts`.
   */
  private placed: ScoredPlacement[] = [];
  /** Squares the falling piece is about to lock on, read on the way in. */
  private cellsBeforeLock: TargetCells = [];
  /** Whether {@link solved} has already re-scored the list as it now stands. */
  private credited = false;
  private resets = 0;
  private firstInputFrame: number | null = null;
  /**
   * Where each placement left the log.
   *
   * Undo cuts the log back to a placement boundary and replays what is left,
   * which is why undo needs no server support at all: a shortened log is still
   * an ordinary log, and the server verifies it the way it verifies every
   * other one. There is nothing to tell it about.
   */
  private checkpoints: Checkpoint[] = [];
  /** Segments undo removed, newest last, so redo can put them back. */
  private undone: UndoneSegment[] = [];
  /** True while the log is being fed back in, to keep the replay silent. */
  private replaying = false;
  private finishedAt: number | null = null;

  private flashRows: number[] = [];
  private pendingFlash: number[] = [];
  private flashUntil = 0;

  /**
   * Route search for the piece in flight, thrown away on the lock — the board
   * the search walked no longer exists once a piece lands in it.
   */
  private planner: RoutePlanner | null = null;
  /** Where a finger or pointer is aiming the piece, and whether it can go. */
  private aim: { cells: TargetCells; legal: boolean } | null = null;
  /**
   * Where the last on-board release parked the piece: an aim it could not
   * place. The preview keeps showing it — drawn dashed, on top of whatever
   * it overlaps — so the player can see and correct the obstruction, and the
   * next drag starts from this seat (the spec's "start from the current
   * preview position"). Nothing was spent: the falling piece keeps falling
   * underneath from its natural seat, and a lock clears the park with it.
   * Cleared by keys, undo, redo, restart and lock alike.
   */
  private parked: { cells: TargetCells } | null = null;
  /**
   * The cells a live drag carries, captured at the grab.
   *
   * The drag's shift is applied to these — the piece's position when the
   * drag took hold, a parked preview seat included — never to the falling
   * piece as it stands now: the preview is exactly where the finger says,
   * relative to where the drag started, and gravity keeps doing what it was
   * doing underneath. Any invalidation (a key, a lock, an undo, a restart)
   * nulls this, which turns the drag inert until its release: the finger's
   * correspondence was with a piece that no longer exists.
   */
  private carryBase: { cells: TargetCells } | null = null;
  /**
   * True while the planner is trying routes against the real engine.
   *
   * A trial replay locks pieces, and every lock fires this run's listeners —
   * which would count the trial's piece against the puzzle, move the undo
   * boundary and maybe even end the attempt. Trials are invisible fictions:
   * the snapshot is restored afterwards and nothing they did happened.
   */
  private trialing = false;

  readonly visibleRows: number;
  private readonly budget: number;

  constructor(
    private readonly puzzle: PuzzlePrompt,
    /**
     * Frozen for the life of the attempt. The server replays the whole input
     * log under one handling, so an attempt played under two would be scored
     * as a game the player never played.
     */
    readonly handling: Handling,
    private readonly callbacks: RunCallbacks,
    /** Restarts carried over from earlier attempts at the same puzzle. */
    startingResets = 0,
    /**
     * When the player first saw this puzzle. Carried across restarts, because
     * the time that matters is time spent on the puzzle, not on one attempt.
     */
    private readonly startedAt = Date.now(),
  ) {
    this.resets = startingResets;
    this.budget = pieceBudget(puzzle);
    this.visibleRows = BOARD_HEIGHT;
    this.build();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private get setup() {
    return {
      board: decodeBoard(this.puzzle.board, ENGINE_ROWS),
      queue: this.puzzle.queue,
      hold: this.puzzle.hold,
    };
  }

  private build(): void {
    ({ engine: this.engine, ledger: this.ledger } = createPuzzleEngine(this.setup, this.handling));
    this.planner = null;
    this.aim = null;
    this.parked = null;
    this.carryBase = null;
    this.trialing = false;
    this.engine.events.on("falling.lock.pre", () => {
      if (this.trialing) return;
      this.pendingFlash = this.rowsAboutToClear();
      // The falling piece is replaced before `falling.lock` fires, so its
      // squares are read on the way in. They are what the run is credited on —
      // see `credit.ts`.
      this.cellsBeforeLock = this.engine.falling.absoluteBlocks.map(([x, y]) => [x, y] as const);
    });
    this.engine.events.on("falling.lock", (lock) => {
      if (this.trialing) return;
      // The board the planner walked is gone the moment a piece lands in it.
      this.planner = null;
      this.aim = null;
      this.parked = null;
      this.carryBase = null;
      const piece = toLetter(lock.mino);
      // A piece the ledger cannot account for is the engine's padding, not the
      // puzzle's. It never counts and it always ends the run.
      if (piece === null || piece === "G" || !this.ledger.spend(piece)) {
        this.finish(this.solved() ? "solved" : "failed");
        return;
      }
      this.piecesPlaced++;
      const attack = lock.garbage.reduce((total, value) => total + value, 0);
      this.attack += attack;
      const clear = nameClear(lock, this.engine.board.perfectClear);
      if (clear) this.clears.push(clear);
      // Kept so the verdict can be taken on the placements rather than on the
      // route that reached them. Appended here, inside the ledger's own guard,
      // so the engine's padding never joins the list.
      this.placed.push({ piece, cells: this.cellsBeforeLock, clear, attack });
      // A re-score is only ever as good as the list it reads, and the list has
      // just grown.
      this.credited = false;
      // Only a live placement moves the boundary. During a replay the log is
      // already whole, so `events.length` is its total rather than the
      // position reached — recording it would collapse every checkpoint onto
      // the same value and the second undo would truncate nothing.
      //
      // The lock frame is recorded alongside the length because a boundary is
      // only worth returning to if the player can play on from it, and a prefix
      // that ends mid-keypress cannot: undo needs a frame after the lock at
      // which to release whatever was still being held when it happened.
      if (!this.replaying) {
        this.checkpoints.push({ length: this.events.length, frame: this.engine.frame });
      }
      // A replay is re-reaching a position the player already saw. Flashing
      // every line it clears again, and calling back for each, would replay
      // the noise as well as the placements.
      if (!this.replaying) {
        if (clear) {
          this.flashRows = this.pendingFlash;
          this.flashUntil = performance.now() + FLASH_MS;
        }
        this.callbacks.onLock(clear, this.attack);
      }
      this.checkForEnd();
    });
  }

  /**
   * Rows that the piece about to lock will complete. Read before the lock,
   * because the engine removes cleared rows before reporting them.
   */
  private rowsAboutToClear(): number[] {
    const { falling, board } = this.engine;
    const cells = falling.absoluteBlocks;
    const occupied = new Set(cells.map(([x, y]) => `${x},${y}`));
    const candidates = new Set(cells.map(([, y]) => y));
    return [...candidates].filter((y) =>
      Array.from({ length: BOARD_WIDTH }, (_, x) => x).every(
        (x) => occupied.has(`${x},${y}`) || board.occupied(x, y),
      ),
    );
  }

  /** Discards the attempt and starts over. Counts against the shared reset tally. */
  restart(): void {
    if (this.phase === "solved") return;
    this.stopLoop();
    this.resets++;
    this.events = [];
    this.pending = [];
    this.held.clear();
    this.aim = null;
    this.attack = 0;
    this.piecesPlaced = 0;
    this.clears = [];
    this.placed = [];
    this.credited = false;
    this.checkpoints = [];
    this.undone = [];
    this.firstInputFrame = null;
    this.phase = "ready";
    this.flashRows = [];
    this.build();
    this.renderOnce();
  }

  // ── Undo and redo ──────────────────────────────────────────────────────────

  get canUndo(): boolean {
    return this.checkpoints.length > 0 && this.phase !== "solved" && this.phase !== "failed";
  }

  get canRedo(): boolean {
    return this.undone.length > 0 && this.phase !== "solved" && this.phase !== "failed";
  }

  /** Takes back the last placement. Returns false when there is none. */
  undo(): boolean {
    if (!this.canUndo) return false;
    this.parked = null;
    const boundary = this.checkpoints[this.checkpoints.length - 2];
    const target = boundary?.length ?? 0;
    // A checkpoint is a prefix of the log, not a closed one: the lock that
    // recorded it happened mid-frame, so a key that was down at that instant
    // has its press inside the prefix and its release in the part being thrown
    // away. Replayed as it stands, the prefix leaves that key down for good —
    // the engine goes on acting on it, and `input` reads the player's real
    // release as a repeat and drops it.
    const closers = boundary ? closingKeyups(this.events.slice(0, target), boundary.frame) : [];
    // Refusing to undo beats returning to a position whose log the server would
    // reject as too long.
    if (target + closers.length > MAX_EVENTS) return false;

    const checkpoint = this.checkpoints.pop()!;
    const removed = this.events.splice(target);
    this.events.push(...closers);
    // The boundary ends after the closers now, so a later undo back to it lands
    // on a log that is already closed and needs no second set.
    if (boundary) {
      this.checkpoints[this.checkpoints.length - 1] = { ...boundary, length: this.events.length };
    }
    this.undone.push({ events: removed, closers: closers.length, checkpoint });
    this.rebuildFromLog();
    return true;
  }

  /** Puts back the placement undo took, if nothing has been played since. */
  redo(): boolean {
    if (!this.canRedo) return false;
    this.parked = null;
    const segment = this.undone.pop()!;
    // Undo's closers were never typed. Taking them back out before the player's
    // own events go back makes a redone log the one they played, byte for byte.
    this.events.splice(this.events.length - segment.closers, segment.closers);
    const boundary = this.checkpoints[this.checkpoints.length - 1];
    if (boundary) {
      this.checkpoints[this.checkpoints.length - 1] = { ...boundary, length: this.events.length };
    }
    // One undone segment is exactly one placement, and it restores the boundary
    // it was taken from rather than the end of the log: keys pressed after that
    // lock belong to the next placement, not to this one.
    this.checkpoints.push(segment.checkpoint);
    this.events.push(...segment.events);
    this.rebuildFromLog();
    return true;
  }

  /**
   * Rebuilds the position from the log, the way the server would.
   *
   * A fresh engine fed the whole log is the only rewind that cannot drift:
   * unwinding the board in place would mean undoing a line clear, a spin
   * bonus and a hold swap by hand, and any one of those getting it slightly
   * wrong would put the player on a board the server does not agree exists.
   * Replaying costs well under a millisecond at this length.
   */
  private rebuildFromLog(): void {
    this.stopLoop();
    this.attack = 0;
    this.piecesPlaced = 0;
    this.clears = [];
    this.placed = [];
    this.credited = false;
    this.pending = [];
    // Folded from the log rather than emptied: `input` treats `held` as the
    // truth about what is down, so a set that disagrees with the log turns the
    // player's next release of that key into a repeat and swallows it.
    this.held.clear();
    for (const key of keysHeldAfter(this.events)) this.held.add(key);
    this.flashRows = [];
    this.phase = "ready";
    this.build();

    this.replaying = true;
    try {
      let cursor = 0;
      while (cursor < this.events.length && this.engine.frame <= MAX_FRAMES) {
        const batch: InputEvent[] = [];
        while (cursor < this.events.length && this.events[cursor]!.frame === this.engine.frame) {
          batch.push(this.events[cursor]!);
          cursor++;
        }
        this.engine.tick(batch as never);
      }
    } finally {
      this.replaying = false;
    }

    if (this.phase === "ready" && this.events.length > 0) {
      this.phase = "playing";
      this.lastTimestamp = performance.now();
      this.accumulator = 0;
      this.startLoop();
    }
    this.renderOnce();
  }

  dispose(): void {
    this.stopLoop();
    this.planner = null;
    this.aim = null;
    this.parked = null;
    this.carryBase = null;
    this.engine.events.removeAllListeners();
  }

  /** Whether the attempt is driving its own frame loop. */
  get isRunning(): boolean {
    return this.phase === "playing";
  }

  /**
   * The log so far, mid-attempt.
   *
   * A rush needs this: a puzzle left behind by the buzzer or by a skip never
   * reaches `onFinish`, but its inputs are still part of the submission.
   */
  log(): readonly InputEvent[] {
    return this.events;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /**
   * Records a key transition. Repeats from the operating system are ignored —
   * the engine runs its own auto-repeat from the player's DAS and ARR.
   */
  input(key: GameKey, down: boolean): void {
    // Before anything reads the ledger, and before the phase guard, because
    // flushing can end the attempt and the guard below is what should notice.
    // A hold is screened on how many pieces the puzzle still owes, and that
    // count is a frame out of date until the pending ticks are applied: a hold
    // pressed in the same animation frame as the hard drop that spends the
    // second-to-last piece would otherwise be judged against the count from
    // before that drop and sail through — the whole bug, on the one input
    // timing a player hurrying to the end is most likely to produce.
    if (key === "hold" && down && (this.phase === "ready" || this.phase === "playing")) {
      this.flushPending();
    }
    if (this.phase === "solved" || this.phase === "failed") return;
    // A hold with one piece left has nothing to trade with, and the engine would
    // answer it out of the padding beyond the queue — handing the player a
    // tetromino the puzzle never offered. Dropped here rather than let through
    // and caught at the lock, because by then they have already been shown it.
    // A hold with one piece left has nothing to trade with, and the engine would
    // answer it out of the padding beyond the queue — handing the player a
    // tetromino the puzzle never offered. Dropped here rather than let through
    // and caught at the lock, because by then they have already been shown it.
    if (key === "hold" && !this.ledger.canSwap) return;
    if (down === this.held.has(key)) return;
    if (down) this.held.add(key);
    else this.held.delete(key);
    // The piece is about to move under keys, so any drag target computed for
    // the piece as it stood is a lie about a piece that no longer exists. The
    // planner goes with it: it walked the board from a starting square that is
    // being abandoned. A drag still in progress re-aims on its next move.
    this.aim = null;
    this.parked = null;
    this.carryBase = null;
    this.planner = null;

    if (this.phase === "ready") this.begin();
    // The log is what gets scored, so once it is full the attempt is over —
    // continuing to accept input would leave the player driving a board whose
    // moves the server will never see.
    if (this.events.length >= MAX_EVENTS) {
      this.finish(this.solved() ? "solved" : "failed");
      return;
    }

    // How far into the current frame the tick loop had got when this key
    // arrived. It is the accumulator as of the last completed tick rather than
    // the instant of the keypress, so it is coarser than true sub-frame timing
    // — but it is the value that goes in the log, so the server replays exactly
    // what the client played.
    const subframe = Math.min(0.999, Math.max(0, this.accumulator / FRAME_MS));
    const frame = this.engine.frame;
    this.firstInputFrame ??= frame;
    const event: InputEvent = {
      frame,
      type: down ? "keydown" : "keyup",
      data: { key, subframe: Number(subframe.toFixed(3)) },
    };
    // Playing on after an undo is the player choosing this line over the one
    // they took back, so there is no longer a forward to redo into.
    this.undone = [];
    this.events.push(event);
    this.pending.push(event);
  }

  // ── Pointer play ───────────────────────────────────────────────────────

  /** True while a drag is aiming the piece somewhere. */
  get isAiming(): boolean {
    return this.aim !== null;
  }

  /** A key press as one event pair: down and up inside the same frame. */
  tap(key: GameKey): void {
    this.input(key, true);
    this.input(key, false);
  }

  /**
   * Where the piece would go if the pointer let go here.
   *
   * The engine is only ever asked through the planner, whose trials are
   * bracketed by `trialing`, so a preview can never move the real attempt.
   * Full spin support falls out of the planner: a square reachable only by a
   * kick is reachable, and the route replayed ends in the rotation that took
   * it there, so the engine credits the spin a player pressing keys would
   * have earned.
   */
  aimAt(spot: BoardSpot): void {
    if (this.phase !== "ready" && this.phase !== "playing") return;
    this.flushPending();
    // Flushing can itself end the attempt: the guard above ticked the log past
    // its frame ceiling, which finishes the run just as the loop would have.
    if (this.phase !== "ready" && this.phase !== "playing") return;
    // Rebuilt when the piece has moved under it, not only when a key was
    // pressed. `input()` fires once per physical press and drops the OS repeat,
    // but DAS and ARR keep shifting the piece every tick while a direction is
    // held — so a plan built before the shift would commit a route to a square
    // the piece has since left, and the drag would land somewhere the preview
    // never showed.
    const target = this.currentPlanner().targetAt(spot.column, spot.row, this.aim?.cells ?? null);
    this.aim = { cells: target, legal: this.searchPlacement(target) !== null };
    // The hollow is the contract — paint it now rather than whenever the next
    // frame happens to run, so a fast release cannot commit a square whose
    // preview was never shown.
    this.renderOnce();
  }

  /**
   * Drops the aimed piece exactly where the player can see it.
   *
   * The aim is the contract: the route committed is the one the preview
   * showed, found against the same board the attempt is on. A drag whose aim
   * was never accepted — one cut short by a lock, an undo or a restart —
   * commits nothing rather than guessing.
   *
   * The commit plays the route exactly as the trial did, as the timed batches
   * {@link ticksForRoute} builds: releases first, then the route's own ticks,
   * each ticked through the engine here and now. The events go in the log
   * with the same grouping, so the server replays the identical frames.
   * Playing it through `input` instead would retime it — a same-frame tap
   * holds nothing, so a mid-route soft drop would fall nowhere and every kick
   * after it would fire from the wrong height.
   */
  placeAt(): boolean {
    if (this.phase !== "ready" && this.phase !== "playing") return false;
    this.flushPending();
    // Flushing can itself end the attempt: the guard above ticked the log past
    // its frame ceiling, which finishes the run just as the loop would have.
    if (this.phase !== "ready" && this.phase !== "playing") return false;
    const aim = this.aim;
    this.aim = null;
    if (!aim || !aim.legal) return false;

    const placement = this.searchPlacement(aim.cells);
    if (!placement) return false;

    this.firstInputFrame ??= this.engine.frame;
    if (this.phase === "ready") this.begin();
    // The batches the route plays as: the releases first, then the route's
    // own ticks starting on the frame after. Built up front so the log and
    // the engine below stay on the same frames.
    const releases = releaseTicks(this.engine, this.engine.frame);
    const batches = [
      releases,
      ...ticksForRoute(
        placement.route,
        this.engine.frame + (releases.length > 0 ? 1 : 0),
        this.handling.sdf,
        placement.softDrops,
      ),
    ];
    // Held soft-drop frames arrive as eventless batches and are load-bearing:
    // the key must stay down while the clock walks, and the replay ticks every
    // frame whether or not it carries events. Nothing here filters empties.
    const additions = batches.reduce((total, batch) => total + batch.length, 0);
    // One rule from `input`, kept: a full log ends the attempt rather than
    // letting the player drive moves the server will never see.
    if (this.events.length + additions > MAX_EVENTS) {
      this.finish(this.solved() ? "solved" : "failed");
      return true;
    }
    // A slow soft drop spends real frames: its descent is held across as many
    // ticks as the handling needs, which can carry the log past the frame
    // ceiling the server enforces — and an event stamped there would have the
    // whole run rejected, not merely ended. The same honesty as the event
    // ceiling above: finish on what has been earned, commit nothing further.
    const lastBatch = batches[batches.length - 1];
    const lastFrame = lastBatch && lastBatch.length > 0 ? lastBatch[lastBatch.length - 1]!.frame : this.engine.frame;
    if (lastFrame > MAX_FRAMES) {
      this.finish(this.solved() ? "solved" : "failed");
      return true;
    }
    // Playing on after an undo is the player choosing this line over the one
    // they took back, so there is no longer a forward to redo into.
    this.undone = [];
    for (const batch of batches) {
      this.events.push(...batch);
      this.engine.tick(batch as never);
      // The hard drop ends the route, but a swallowed one (safe lock) or a
      // frame ceiling can end the attempt first — never drive the next piece
      // with the rest of this one.
      if (this.phase !== "playing" && this.phase !== "ready") break;
    }
    this.renderOnce();
    return true;
  }

  /** Stops showing where the piece would land. */
  clearAim(): void {
    if (this.aim === null) return;
    this.aim = null;
    this.renderOnce();
  }

  // ── Drag carry ───────────────────────────────────────────────────────────

  /**
   * Takes hold of the piece where it is, without moving it.
   *
   * The carry model's anchor rule: a drag starts from the piece's current
   * preview position — a seat the last release parked it on included — or
   * from the falling piece itself when nothing is parked. The tracker
   * measures the finger's travel and calls {@link carryAt} with the
   * amplified shift; this captures the base the shift applies to and moves
   * nothing.
   */
  grabBase(): void {
    this.flushPending();
    if (this.phase !== "ready" && this.phase !== "playing") return;
    if (this.parked) {
      this.carryBase = { cells: this.parked.cells };
      return;
    }
    this.carryBase = {
      cells: this.engine.falling.absoluteBlocks.map(([x, y]) => [x, y] as const),
    };
  }

  /**
   * The piece's position while a drag carries it: `shift` is the finger's
   * travel from the grab point, already amplified in the tracker, measured
   * in board squares with no clamping — the travel is fully virtual, so an
   * excursion off the board and back lands the piece exactly where it was.
   *
   * On the board the preview shows the carried piece, legal or not; off it,
   * the preview drops (that is the reset the spec asks for) while the drag
   * stays live. The shift is applied to the base captured at the grab, so
   * the preview is exactly where the finger says — the piece underneath
   * keeps falling from its natural seat the whole time.
   */
  carryAt(shift: { column: number; row: number }): void {
    this.flushPending();
    if (!this.carryBase || (this.phase !== "ready" && this.phase !== "playing")) return;
    this.parked = null;
    const shifted = this.carryBase.cells.map(
      ([x, y]) => [x + shift.column, y + shift.row] as const,
    );
    const onBoard =
      shifted.every(([x]) => x >= 0 && x < BOARD_WIDTH) &&
      shifted.every(([, y]) => y >= 0 && y < ENGINE_ROWS);
    if (!onBoard) {
      // Fully virtual: the preview simply vanishes — a carried park included,
      // or a park would outlive its own drag's off-board release. Re-aiming
      // happens on the next in-bounds move; the drag never lost the thread.
      this.aim = null;
      this.parked = null;
      this.renderOnce();
      return;
    }
    const target = shifted as TargetCells;
    this.aim = { cells: target, legal: this.searchPlacement(target) !== null };
    this.renderOnce();
  }

  /**
   * The drag ended with the carried piece on the board.
   *
   * Three endings, exactly as previewed: a placeable seat commits; a
   * seatless one *parks* the piece there — the dashed preview stays on top
   * of whatever it overlaps, nothing is spent, no refusal is spoken, and the
   * next drag starts from this seat; a released aim that is no longer live
   * (a lock or an undo got there first) does nothing at all.
   */
  settleAt(): void {
    const aim = this.aim;
    this.carryBase = null;
    if (!aim) {
      // Released off-board, or the drag was invalidated under the finger:
      // reset — the piece falls on as if untouched. The aim is already gone.
      this.renderOnce();
      return;
    }
    // `placeAt` consumes the live aim — the contract it commits — so the aim
    // stays in place for it and the carry's state stands down around the call.
    if (aim.legal && this.placeAt()) return;
    // Not placeable (or the place was refused): park exactly what was shown.
    this.aim = null;
    this.parked = { cells: aim.cells };
    this.renderOnce();
  }

  /**
   * The planner's answer, with the run's own listeners told to look away.
   *
   * Finding a placement trial-locks pieces on the real engine, and every one
   * of those locks would otherwise be counted against the puzzle — the
   * ledger spent, the undo boundary moved, the attempt even ended, all for
   * routes that are thrown away the moment they are scored.
   */
  private searchPlacement(cells: TargetCells) {
    this.trialing = true;
    try {
      return this.currentPlanner().placementAt(cells);
    } finally {
      this.trialing = false;
    }
  }

  /**
   * The plan for the piece as it is *now*, rebuilding it if the piece has moved.
   *
   * The one place a planner is obtained, because the aim and the commit have to
   * agree about which plan is current and they are separated by however long the
   * player holds their finger down.
   *
   * `input()` drops the plan on a key transition, which looks like enough. It is
   * not: it fires once per physical press and deliberately ignores the OS
   * repeat, while the engine's own DAS and ARR keep shifting the piece every
   * tick for as long as the key stays down. So the piece leaves the square the
   * plan was walked from with no input this class ever sees, and a commit
   * against that plan plays a route for a position the piece no longer holds —
   * the drag lands somewhere the preview never showed.
   */
  private currentPlanner(): RoutePlanner {
    if (!this.planner || !this.planner.matches(this.engine.falling)) {
      this.planner = new RoutePlanner(this.engine);
    }
    return this.planner;
  }

  // ── Clock ──────────────────────────────────────────────────────────────────

  /**
   * Feeds the engine everything recorded but not yet ticked.
   *
   * Planning must see the piece as the log now describes it: a rotation tapped
   * a moment ago sits in `pending` until the frame loop drains it, and an aim
   * computed before that would plan against the un-rotated piece. Every
   * pending event is stamped with the frame it was recorded on — the current
   * one, since only a tick advances the counter — so flushing here ticks
   * exactly the batch the loop would have ticked now, and the server replays
   * identical frames either way.
   */
  private flushPending(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.engine.tick(batch as never);
    // The same guard the frame loop applies after its own ticks.
    if (this.engine.frame > MAX_FRAMES) this.finish("failed");
  }

  private begin(): void {
    this.phase = "playing";
    this.lastTimestamp = performance.now();
    this.accumulator = 0;
    this.startLoop();
  }

  private startLoop(): void {
    if (this.rafHandle !== 0) return;
    const step = (timestamp: number) => {
      this.rafHandle = requestAnimationFrame(step);
      this.advance(timestamp);
      this.renderOnce();
    };
    this.rafHandle = requestAnimationFrame(step);
  }

  private stopLoop(): void {
    if (this.rafHandle !== 0) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private advance(timestamp: number): void {
    if (this.phase !== "playing") return;
    this.accumulator += Math.min(MAX_CATCHUP_MS, timestamp - this.lastTimestamp);
    this.lastTimestamp = timestamp;

    while (this.accumulator >= FRAME_MS && this.phase === "playing") {
      this.accumulator -= FRAME_MS;
      const batch = this.pending;
      this.pending = [];
      this.engine.tick(batch as never);
      if (this.engine.frame > MAX_FRAMES) {
        this.finish("failed");
        return;
      }
    }
  }

  /**
   * Whether the attempt is over, after every lock.
   *
   * The attack target alone used to end it, and that is the bug this feature
   * exists for read from the other side: a puzzle asking for three TSDs is
   * worth twelve, and the run stopped at twelve however the player got there —
   * so the intended line was never the only line, and enforcing the clears on
   * the server without changing this would have ended the run *before* the
   * player could make the clear being demanded. Stricter scoring and an
   * unsolvable puzzle are the same edit unless both move together.
   *
   * So the run now continues past the attack target while a required clear is
   * still outstanding, and ends when the pieces run out.
   */
  private checkForEnd(): void {
    if (this.solved()) this.finish("solved");
    else if (this.ledger.remaining === 0) this.finish("failed");
  }

  /**
   * Whether the run has solved the puzzle — the only question five different
   * exits ask, and now the only place that answers it.
   *
   * A run that already solves as played is taken at its word and costs nothing.
   * One that does not is re-scored on its placements first, because the same
   * squares can be worth two different amounts depending on the kick that
   * reached them and the puzzle's target was derived from the better one. See
   * `credit.ts` for why that asymmetry existed and whom it punished.
   *
   * The re-score runs at most once per placement, and only on a run carrying a
   * T that cleared lines without being credited a T-spin — so an ordinary run
   * never pays for it. The credited totals replace the played ones outright:
   * the meter, the results card and the sheet the server is sent must all say
   * the same thing, and `creditPlacements` can only ever raise a score.
   *
   * This has to happen on the client at all, rather than being left to the
   * server, because a run the client calls failed is never submitted.
   */
  private solved(): boolean {
    if (solvesPuzzle(this.attack, this.clears, this.puzzle)) return true;
    if (this.credited) return false;
    this.credited = true;
    const credited = creditPlacements(this.setup, this.handling, this.placed);
    if (!credited) return false;
    this.placed = credited;
    this.attack = total(credited);
    this.clears = clearsOf(credited);
    return solvesPuzzle(this.attack, this.clears, this.puzzle);
  }

  private finish(phase: "solved" | "failed"): void {
    if (this.phase === "solved" || this.phase === "failed") return;
    this.phase = phase;
    this.finishedAt = Date.now();
    this.stopLoop();
    this.renderOnce();
    this.callbacks.onFinish(this.snapshot(), this.events);
  }

  // ── Reading state ──────────────────────────────────────────────────────────

  /** Squares the falling piece would occupy if hard-dropped right now. */
  private ghostCells(): (readonly [number, number])[] {
    const { falling, board } = this.engine;
    let drop = 0;
    for (;;) {
      const candidate = falling.absoluteAt({ y: falling.location[1] - (drop + 1) });
      if (candidate.some(([x, y]) => board.occupied(x, y))) break;
      drop++;
      if (drop > ENGINE_ROWS) break;
    }
    return falling.absoluteAt({ y: falling.location[1] - drop }).map(([x, y]) => [x, y] as const);
  }

  /** The held piece, but only when it is one the puzzle actually owes. */
  private heldPuzzlePiece(): Mino | null {
    const held = toLetter(this.engine.held);
    if (held === null || held === "G") return null;
    return this.ledger.owes(held) ? held : null;
  }

  snapshot(): RunSnapshot {
    const spent = this.piecesPlaced;
    // The engine's queue is padded so locking the last piece has something to
    // spawn; only the puzzle's own pieces are shown.
    const held = this.engine.held !== null;
    const realPiecesInQueue = Math.max(0, this.budget - spent - 1 - (held ? 1 : 0));
    const upcoming = this.engine.queue
      .raw()
      .map(toLetter)
      .filter((piece): piece is Mino => piece !== null && piece !== "G")
      .slice(0, realPiecesInQueue);


    return {
      phase: this.phase,
      attack: this.attack,
      targetAttack: this.puzzle.targetAttack,
      piecesPlaced: spent,
      pieceBudget: this.budget,
      clears: this.clears,
      elapsedMs: (this.finishedAt ?? Date.now()) - this.startedAt,
      resets: this.resets,
      // The engine's padding can end up in hold after the last real piece is
      // dealt out of it. It is not part of the puzzle, so it is not shown.
      hold: this.ledger.remaining > 0 ? this.heldPuzzlePiece() : null,
      upcoming,
      holdLocked: this.engine.holdLocked,
    };
  }

  view(): BoardView {
    const active = this.engine.falling;
    const stillPlaying = this.phase === "ready" || this.phase === "playing";
    const activeCells = stillPlaying
      ? active.absoluteBlocks.map(([x, y]) => [x, y] as const)
      : [];
    const now = performance.now();
    return {
      cells: readBoard(this.engine) as readonly (readonly BoardCell[])[],
      visibleRows: this.visibleRows,
      active: activeCells,
      activeInk: stillPlaying ? (MINO_INK[toLetter(active.symbol) as Mino] ?? null) : null,
      ghost: stillPlaying ? this.ghostCells() : [],
      flashRows: this.flashRows,
      flashStrength: Math.max(0, (this.flashUntil - now) / FLASH_MS),
      dimmed: this.phase === "failed",
      aim: stillPlaying ? (this.aim ?? (this.parked ? { ...this.parked, legal: false } : null)) : null,
    };
  }

  renderOnce(): void {
    this.callbacks.onFrame(this.view(), this.snapshot());
  }
}
