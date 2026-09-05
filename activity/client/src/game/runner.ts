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
    this.engine.events.on("falling.lock.pre", () => {
      this.pendingFlash = this.rowsAboutToClear();
    });
    this.engine.events.on("falling.lock", (lock) => {
      const piece = toLetter(lock.mino);
      // A piece the ledger cannot account for is the engine's padding, not the
      // puzzle's. It never counts and it always ends the run.
      if (piece === null || piece === "G" || !this.ledger.spend(piece)) {
        this.finish(solvesPuzzle(this.attack, this.clears, this.puzzle) ? "solved" : "failed");
        return;
      }
      this.piecesPlaced++;
      this.attack += lock.garbage.reduce((total, value) => total + value, 0);
      const clear = nameClear(lock, this.engine.board.perfectClear);
      if (clear) this.clears.push(clear);
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
    this.attack = 0;
    this.piecesPlaced = 0;
    this.clears = [];
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
    if (this.phase === "solved" || this.phase === "failed") return;
    if (down === this.held.has(key)) return;
    if (down) this.held.add(key);
    else this.held.delete(key);

    if (this.phase === "ready") this.begin();
    // The log is what gets scored, so once it is full the attempt is over —
    // continuing to accept input would leave the player driving a board whose
    // moves the server will never see.
    if (this.events.length >= MAX_EVENTS) {
      this.finish(solvesPuzzle(this.attack, this.clears, this.puzzle) ? "solved" : "failed");
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

  // ── Clock ──────────────────────────────────────────────────────────────────

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
    if (solvesPuzzle(this.attack, this.clears, this.puzzle)) this.finish("solved");
    else if (this.ledger.remaining === 0) this.finish("failed");
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
    };
  }

  renderOnce(): void {
    this.callbacks.onFrame(this.view(), this.snapshot());
  }
}
