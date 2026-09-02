/**
 * A rush: one clock, many puzzles.
 *
 * Owns the sequence, the five minutes, and whichever {@link PuzzleRun} is in
 * front of the player right now. Each puzzle keeps its own input log, and the
 * logs are handed over in order at the end — the server re-derives which puzzle
 * each one belongs to from its position, so this class never has to be believed
 * about what it was playing, only about how long it took.
 */

import type { PuzzlePrompt } from "@shared/puzzle";
import type { Handling } from "@shared/tetris/handling";
import type { InputEvent, GameKey } from "@shared/tetris/verify";
import type { BoardView } from "../render/board";
import { PuzzleRun, type RunSnapshot } from "./runner";

/**
 * A beat on the solved board before the next puzzle arrives.
 *
 * Without it a solve is invisible: the board is replaced in the same frame the
 * last piece lands, and the player never sees the thing they just did. It comes
 * out of their five minutes, which is fair because it comes out of everybody's.
 */
const ADVANCE_MS = 420;

/**
 * The shortest gap between two skips that counts as two.
 *
 * A skip is irreversible and there are only two of them, so a stuttered
 * keypress or an impatient double-tap must not spend the pair in one go. It is
 * short enough that deliberately skipping twice in a row never feels blocked.
 */
const SKIP_GUARD_MS = 350;

export type RushPhase = "playing" | "over";

export interface RushSnapshot {
  readonly phase: RushPhase;
  /** Position in the sequence, from 1, for display. */
  readonly position: number;
  readonly total: number;
  readonly solved: number;
  readonly skipsLeft: number;
  readonly remainingMs: number;
  /** True between solving a puzzle and the next one appearing. */
  readonly advancing: boolean;
}

/** One puzzle's worth of the submission. */
export interface RushSegment {
  readonly events: readonly InputEvent[];
}

export interface RushSummary {
  readonly segments: readonly RushSegment[];
  readonly solved: number;
  readonly skipsUsed: number;
  /** Milliseconds from the start of the rush to the last solve. */
  readonly timeToLastSolveMs: number;
}

export interface RushCallbacks {
  readonly onFrame: (view: BoardView, run: RunSnapshot, rush: RushSnapshot) => void;
  /** The puzzle in front of the player changed, or came back after a retry. */
  readonly onPuzzle: (puzzle: PuzzlePrompt, rush: RushSnapshot) => void;
  readonly onSolved: (rush: RushSnapshot) => void;
  readonly onFinish: (summary: RushSummary) => void;
}

export class RushSession {
  private run: PuzzleRun | null = null;
  private index = 0;
  private solved = 0;
  private skipsUsed = 0;
  private timeToLastSolveMs = 0;
  private phase: RushPhase = "playing";
  private advancing = false;

  private readonly segments: RushSegment[] = [];
  private readonly startedAt = Date.now();
  private tickHandle = 0;
  private advanceHandle: ReturnType<typeof setTimeout> | null = null;
  private lastSkipAt = 0;

  constructor(
    private readonly puzzles: readonly PuzzlePrompt[],
    private readonly handling: Handling,
    private readonly durationMs: number,
    private readonly skips: number,
    private readonly callbacks: RushCallbacks,
  ) {
    if (puzzles.length === 0) throw new Error("A rush needs at least one puzzle");
    this.open();
    this.startClock();
  }

  // ── The clock ──────────────────────────────────────────────────────────────

  /**
   * The rush runs its own frame loop rather than borrowing the run's.
   *
   * A `PuzzleRun` only starts ticking once the player presses something, which
   * is exactly right for a single puzzle and exactly wrong here: the five
   * minutes are already running while they sit and read the board, and a
   * countdown that does not move until the first keypress would be lying.
   */
  private startClock(): void {
    const step = () => {
      this.tickHandle = requestAnimationFrame(step);
      if (this.remainingMs() <= 0) this.finish();
      else if (!this.run?.isRunning) this.paint();
    };
    this.tickHandle = requestAnimationFrame(step);
  }

  private stopClock(): void {
    if (this.tickHandle !== 0) cancelAnimationFrame(this.tickHandle);
    this.tickHandle = 0;
    if (this.advanceHandle !== null) clearTimeout(this.advanceHandle);
    this.advanceHandle = null;
  }

  private remainingMs(): number {
    return Math.max(0, this.durationMs - (Date.now() - this.startedAt));
  }

  private elapsedMs(): number {
    return Math.min(this.durationMs, Date.now() - this.startedAt);
  }

  // ── The sequence ───────────────────────────────────────────────────────────

  private get puzzle(): PuzzlePrompt {
    return this.puzzles[this.index]!;
  }

  /** Puts the current puzzle in front of the player, from the top. */
  private open(): void {
    this.run?.dispose();
    this.run = new PuzzleRun(this.puzzle, this.handling, {
      onFrame: (view, snapshot) => this.callbacks.onFrame(view, snapshot, this.snapshot()),
      onLock: () => {},
      onFinish: (snapshot, events) => this.settle(snapshot, events),
    });
    this.callbacks.onPuzzle(this.puzzle, this.snapshot());
    this.run.renderOnce();
  }

  /**
   * What happens when an attempt ends.
   *
   * A dead board is not a failure that costs anything but time: the same puzzle
   * comes straight back, and the abandoned attempt's log is thrown away, so the
   * segment eventually submitted is whichever attempt the player actually
   * finished on. Leaving a puzzle behind takes either a solve or a skip.
   */
  private settle(snapshot: RunSnapshot, events: readonly InputEvent[]): void {
    if (this.phase === "over") return;
    if (snapshot.phase !== "solved") {
      this.open();
      return;
    }

    this.segments.push({ events: [...events] });
    this.solved++;
    this.timeToLastSolveMs = this.elapsedMs();
    this.advancing = true;
    this.callbacks.onSolved(this.snapshot());

    this.advanceHandle = setTimeout(() => {
      this.advanceHandle = null;
      this.advancing = false;
      this.advance();
    }, ADVANCE_MS);
  }

  private advance(): void {
    if (this.phase === "over") return;
    this.index++;
    // Clearing the whole sequence inside five minutes is not something anyone
    // is going to do, but a rush that ran off the end of its own array would be
    // a poor way to find that out.
    if (this.index >= this.puzzles.length) {
      this.finish();
      return;
    }
    this.open();
  }

  // ── What the player does ───────────────────────────────────────────────────

  input(key: GameKey, down: boolean): void {
    if (this.phase === "over" || this.advancing) return;
    this.run?.input(key, down);
  }

  /** Wipes the current attempt without leaving the puzzle. Skips are untouched. */
  restart(): void {
    if (this.phase === "over" || this.advancing) return;
    this.run?.restart();
  }

  /**
   * Gives up on this puzzle and takes the next.
   *
   * The abandoned log goes in as this puzzle's segment rather than an empty
   * one: it is what the player actually did, it replays to the same verdict,
   * and a submission that reflects the run is worth more than a smaller one.
   */
  skip(): boolean {
    if (this.phase === "over" || this.advancing) return false;
    if (Date.now() - this.lastSkipAt < SKIP_GUARD_MS) return true;
    if (this.skipsUsed >= this.skips) return false;
    this.lastSkipAt = Date.now();
    const events = this.run?.log() ?? [];
    this.segments.push({ events: [...events] });
    this.skipsUsed++;
    this.advance();
    return true;
  }

  /** The buzzer, or the end of the sequence. */
  private finish(): void {
    if (this.phase === "over") return;
    this.phase = "over";
    this.stopClock();

    // Whatever was on the board when time ran out still goes in. The server
    // expects a final unsolved segment and does not count it as a skip.
    const inFlight = this.run?.log() ?? [];
    if (inFlight.length > 0) this.segments.push({ events: [...inFlight] });

    this.run?.dispose();
    this.paint();
    this.callbacks.onFinish({
      segments: this.segments,
      solved: this.solved,
      skipsUsed: this.skipsUsed,
      timeToLastSolveMs: this.timeToLastSolveMs,
    });
  }

  /** Ends the rush early, at the player's request. */
  giveUp(): void {
    this.finish();
  }

  dispose(): void {
    this.phase = "over";
    this.stopClock();
    this.run?.dispose();
    this.run = null;
  }

  // ── Reading state ──────────────────────────────────────────────────────────

  snapshot(): RushSnapshot {
    return {
      phase: this.phase,
      position: Math.min(this.index + 1, this.puzzles.length),
      total: this.puzzles.length,
      solved: this.solved,
      skipsLeft: Math.max(0, this.skips - this.skipsUsed),
      remainingMs: this.remainingMs(),
      advancing: this.advancing,
    };
  }

  private paint(): void {
    if (!this.run) return;
    this.callbacks.onFrame(this.run.view(), this.run.snapshot(), this.snapshot());
  }
}
