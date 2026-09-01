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
        this.finish(this.attack >= this.puzzle.targetAttack ? "solved" : "failed");
        return;
      }
      this.piecesPlaced++;
      this.attack += lock.garbage.reduce((total, value) => total + value, 0);
      const clear = nameClear(lock, this.engine.board.perfectClear);
      if (clear) {
        this.clears.push(clear);
        this.flashRows = this.pendingFlash;
        this.flashUntil = performance.now() + FLASH_MS;
      }
      this.callbacks.onLock(clear, this.attack);
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
    this.firstInputFrame = null;
    this.phase = "ready";
    this.flashRows = [];
    this.build();
    this.renderOnce();
  }

  dispose(): void {
    this.stopLoop();
    this.engine.events.removeAllListeners();
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
      this.finish(this.attack >= this.puzzle.targetAttack ? "solved" : "failed");
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

  private checkForEnd(): void {
    if (this.attack >= this.puzzle.targetAttack) this.finish("solved");
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
