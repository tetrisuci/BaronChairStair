/**
 * The client half of a 1v1 duel: one socket, and the run in front of it.
 *
 * The server is the referee. Nothing here decides a round, keeps a score, or
 * reads a clock that matters — it plays the puzzle it is given, and when the
 * run solves it, it sends the log that solved it. Whether that log arrived
 * first is not this side's business, and the score that comes back is the one
 * to show even if it disagrees with what the player thought happened.
 *
 * A dead board restarts, as it does in rush: a round is lost to the clock, not
 * to the board.
 */

import type {
  DuelCommand,
  DuelEvent,
  DuelProgress,
  DuelSettings,
  DuelView,
} from "@shared/duel";
import type { PuzzlePrompt } from "@shared/puzzle";
import type { Handling } from "@shared/tetris/handling";
import type { GameKey, InputEvent } from "@shared/tetris/verify";
import type { BoardView } from "../render/board";
import { PuzzleRun, type RunSnapshot } from "./runner";

/** How often the opponent is told how far along we are. */
const PROGRESS_EVERY_MS = 400;

export interface DuelCallbacks {
  readonly onFrame: (view: BoardView, run: RunSnapshot) => void;
  readonly onState: (duel: DuelView) => void;
  readonly onRound: (round: number, puzzle: PuzzlePrompt, endsAt: number, duel: DuelView) => void;
  /** Rush: the puzzle this player is on now, and how they are doing. */
  readonly onRushPuzzle: (
    puzzle: PuzzlePrompt | null,
    endsAt: number,
    solved: number,
    skipsLeft: number,
    duel: DuelView,
  ) => void;
  readonly onOpponent: (progress: DuelProgress) => void;
  readonly onRoundOver: (winnerId: string | null, duel: DuelView) => void;
  readonly onMatchOver: (winnerId: string | null, duel: DuelView) => void;
  readonly onLobbies: (open: readonly DuelView[]) => void;
  readonly onError: (message: string) => void;
  readonly onClosed: () => void;
}

export class DuelClient {
  private socket: WebSocket | null = null;
  private run: PuzzleRun | null = null;
  private lastProgressAt = 0;
  /** Set once a claim is away, so a restart cannot send it twice. */
  private claimed = false;
  /**
   * Which puzzle of the match the run in front of us is: the round number, or
   * the place in the stack. Taken from the frame that dealt it and handed back
   * with the claim, so a log the server reads late is refused rather than
   * spent on whatever puzzle has replaced this one.
   */
  private position = 0;

  playerId = "";

  constructor(
    private readonly url: string,
    private readonly handling: Handling,
    private readonly callbacks: DuelCallbacks,
  ) {}

  connect(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onmessage = (message) => this.receive(JSON.parse(String(message.data)) as DuelEvent);
    socket.onclose = () => {
      this.disposeRun();
      this.callbacks.onClosed();
    };
    socket.onerror = () => this.callbacks.onError("Lost the connection to the duel");
  }

  private send(command: DuelCommand): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
  }

  // Sitting down declares the handling this seat plays — and is judged — under.
  open(settings: DuelSettings): void {
    this.send({ type: "open", settings, handling: this.handling });
  }

  join(duelId: string): void {
    this.send({ type: "join", duelId, handling: this.handling });
  }

  ready(): void {
    this.send({ type: "ready" });
  }

  leave(): void {
    this.send({ type: "leave" });
  }

  /** Rush only: give up on this puzzle and take the next. Bounded server-side. */
  skip(): void {
    this.send({ type: "skip" });
  }

  /**
   * Offer to play the same match again.
   *
   * An offer, not a restart: the server waits until both sides have asked
   * before it deals anything, so one player cannot drag the other back in.
   */
  rematch(): void {
    this.send({ type: "rematch" });
  }

  close(): void {
    this.disposeRun();
    this.socket?.close();
    this.socket = null;
  }

  input(key: GameKey, down: boolean): void {
    this.run?.input(key, down);
  }

  restart(): void {
    this.run?.restart();
  }

  get currentRun(): PuzzleRun | null {
    return this.run;
  }

  // ── The server talking ─────────────────────────────────────────────────────

  private receive(event: DuelEvent): void {
    switch (event.type) {
      case "welcome":
        this.playerId = event.playerId;
        this.callbacks.onLobbies(event.open);
        return;
      case "duel":
        this.callbacks.onState(event.duel);
        return;
      case "round":
        this.startRound(event.puzzle, event.round);
        this.callbacks.onRound(event.round, event.puzzle, event.endsAt, event.duel);
        return;
      case "rush":
        // Each player walks the shared stack at their own pace, so this is
        // addressed to one of them; a `round` is the thing both are racing on
        // and a rush has none.
        if (event.puzzle) this.startRound(event.puzzle, event.index);
        else this.disposeRun();
        this.callbacks.onRushPuzzle(
          event.puzzle,
          event.endsAt,
          event.solved,
          event.skipsLeft,
          event.duel,
        );
        return;
      case "opponent":
        this.callbacks.onOpponent(event.progress);
        return;
      case "roundOver":
        this.disposeRun();
        this.callbacks.onRoundOver(event.winnerId, event.duel);
        return;
      case "matchOver":
        this.disposeRun();
        this.callbacks.onMatchOver(event.winnerId, event.duel);
        return;
      case "error":
        this.callbacks.onError(event.message);
        return;
    }
  }

  private startRound(puzzle: PuzzlePrompt, position: number): void {
    this.disposeRun();
    this.claimed = false;
    this.position = position;
    this.run = new PuzzleRun(puzzle, this.handling, {
      onFrame: (view, snapshot) => {
        this.callbacks.onFrame(view, snapshot);
        this.reportProgress(snapshot);
      },
      onLock: () => undefined,
      onFinish: (snapshot, events) => this.settle(snapshot, events),
    });
    this.run.renderOnce();
  }

  /**
   * The run ended: send the log if it solved, start over if it did not.
   *
   * Losing the board is not losing the round — a round is lost to the clock.
   * Restarting costs the seconds it costs, which is the same price the
   * opponent pays for their own mistakes.
   */
  private settle(snapshot: RunSnapshot, events: readonly InputEvent[]): void {
    if (snapshot.phase !== "solved") {
      this.run?.restart();
      return;
    }
    if (this.claimed) return;
    this.claimed = true;
    this.send({ type: "claim", position: this.position, events });
  }

  /** Throttled: the opponent needs a bar, not every frame. */
  private reportProgress(snapshot: RunSnapshot): void {
    const now = Date.now();
    if (now - this.lastProgressAt < PROGRESS_EVERY_MS) return;
    this.lastProgressAt = now;
    this.send({
      type: "progress",
      progress: {
        piecesPlaced: snapshot.piecesPlaced,
        pieceBudget: snapshot.pieceBudget,
        attack: snapshot.attack,
        targetAttack: snapshot.targetAttack,
        solved: 0,
      },
    });
  }

  private disposeRun(): void {
    this.run?.dispose();
    this.run = null;
  }
}
