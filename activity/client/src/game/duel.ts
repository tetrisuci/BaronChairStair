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
import type { PuzzlePrompt, SolutionStep } from "@shared/puzzle";
import { SERVER_GOING_AWAY } from "@shared/runtime-status";
import type { Handling } from "@shared/tetris/handling";
import type { GameKey, InputEvent } from "@shared/tetris/verify";
import type { BoardView } from "../render/board";
import { PuzzleRun, type RunSnapshot } from "./runner";

/** How often the opponent is told how far along we are. */
const PROGRESS_EVERY_MS = 400;

/** The code a socket closes with when it ends without a close frame: a dropped connection. */
const ABNORMAL_CLOSURE = 1006;

/**
 * Why the duel socket closed, and the one sentence that says so.
 *
 * `handover` is the server closing a lobby because a new process is already
 * listening: the player can open it again at once, on the new one. `restart`
 * is the server stopping, which ends a match in progress. `lost` is the
 * network or a server that died without saying goodbye; `closed` is anything
 * else that ended cleanly — the server's "Opened elsewhere" among them.
 */
export interface DuelClosure {
  readonly kind: "handover" | "restart" | "lost" | "closed";
  readonly message: string;
}

/**
 * Reads a close. `failed` is whether an `error` came first — browsers fire one
 * before the `close` of any socket that did not close cleanly, and it carries
 * nothing the close does not, so it is folded in here rather than reported as
 * a second thing that happened.
 *
 * A 1012 without a reason this build knows is read as a restart: the server
 * is going away either way, and "the duel ended" is the safer thing to have
 * said if the lobby turns out to be gone.
 */
export function describeDuelClose(code: number, reason: string, failed: boolean): DuelClosure {
  if (code === SERVER_GOING_AWAY.code) {
    return reason === SERVER_GOING_AWAY.handover
      ? { kind: "handover", message: "The server is updating — open the lobby again" }
      : { kind: "restart", message: "The server restarted, so the duel ended." };
  }
  if (failed || code === ABNORMAL_CLOSURE) {
    return { kind: "lost", message: "Lost the connection to the duel" };
  }
  return { kind: "closed", message: "The duel connection closed" };
}

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
  /**
   * A round ended. `solution` is how it was meant to go and `nextRoundAt` is
   * when the next one is dealt — null when that was the last round, because
   * then there is nothing to wait for and the result screen is the next thing.
   */
  readonly onRoundOver: (
    winnerId: string | null,
    duel: DuelView,
    solution: readonly SolutionStep[] | null,
    nextRoundAt: number | null,
  ) => void;
  readonly onMatchOver: (winnerId: string | null, duel: DuelView) => void;
  readonly onLobbies: (open: readonly DuelView[]) => void;
  /** The server refused something — a full lobby, a bad rule. The socket stays open. */
  readonly onError: (message: string) => void;
  /**
   * The socket closed without being asked to — once per close, with why.
   * A close this side asked for ({@link DuelClient.close}) is not reported.
   */
  readonly onClosed: (closure: DuelClosure) => void;
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
    // An `error` is always followed by a `close`, so it only marks the close
    // as unclean. Toasting on both told the player about one event twice.
    let failed = false;
    socket.onmessage = (message) => this.receive(JSON.parse(String(message.data)) as DuelEvent);
    socket.onerror = () => {
      failed = true;
    };
    socket.onclose = (event) => {
      // `close()` lets go of the socket before closing it, so a close this
      // side asked for — leaving duel mode, a new duel replacing this one —
      // lands here as somebody else's and says nothing.
      if (this.socket !== socket) return;
      this.socket = null;
      this.disposeRun();
      this.callbacks.onClosed(describeDuelClose(event.code, event.reason, failed));
    };
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

  /**
   * Host only: rewrite the room's rules while it is still a lobby.
   *
   * Sent optimistically and not applied locally — the form shows whatever the
   * next `duel` frame carries, so a rule the referee bounds or refuses is
   * corrected on screen rather than lingering as a setting only one side
   * believes in.
   */
  configure(settings: DuelSettings): void {
    this.send({ type: "configure", settings });
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

  /** Closes the socket on purpose. Reports nothing: the caller already knows. */
  close(): void {
    this.disposeRun();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
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
        // Screen first, board second, and the order is the whole of it.
        //
        // `startRound` paints the opening position synchronously, and it is
        // `onRound` that puts the playfield on the page. Painting first put
        // that frame onto a playfield nobody was looking at yet, so the round
        // opened showing whatever had been drawn there last — the previous
        // round, the daily, or nothing at all. A puzzle has no gravity, so no
        // further frame came to correct it until the player pressed a key.
        this.callbacks.onRound(event.round, event.puzzle, event.endsAt, event.duel);
        this.startRound(event.puzzle, event.round);
        return;
      case "rush":
        // Each player walks the shared stack at their own pace, so this is
        // addressed to one of them; a `round` is the thing both are racing on
        // and a rush has none.
        this.callbacks.onRushPuzzle(
          event.puzzle,
          event.endsAt,
          event.solved,
          event.skipsLeft,
          event.duel,
        );
        // Second, for the reason the `round` case gives.
        if (event.puzzle) this.startRound(event.puzzle, event.index);
        else this.disposeRun();
        return;
      case "opponent":
        this.callbacks.onOpponent(event.progress);
        return;
      case "roundOver":
        this.disposeRun();
        this.callbacks.onRoundOver(event.winnerId, event.duel, event.solution, event.nextRoundAt);
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
