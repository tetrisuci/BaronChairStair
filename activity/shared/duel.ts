/**
 * The 1v1 wire format, shared so the two ends cannot disagree about it.
 *
 * One rule shapes everything here: a client never says "I solved it". It sends
 * the input log that solves it, and the server replays that log through the
 * same engine it uses for every other score. Verification is not something
 * that happens after a claim arrives — verification is what reading the claim
 * means. That is why {@link DuelCommand}'s claim carries events and nothing
 * else: there is no field on it a client could lie in.
 *
 * The second rule is about what comes back. A board part-way through a puzzle
 * is a partial solution to that puzzle, so the opponent's board is never
 * mirrored — only how far along they are. Losing must not come with a hint.
 *
 * Rush changes who a message is addressed to, never what a claim means. Both
 * players work one shared stack of puzzles, but each at their own pace, so the
 * puzzle a player is on is sent to that player alone. A `round` names the
 * puzzle both are racing on and a rush has no such thing.
 *
 * A rematch is the third rule: it is an offer, not an order. Either player may
 * ask, both are told who has asked, and the match restarts only once both have.
 * That is why nothing here carries a "restart" — one side cannot put the other
 * back on the board — and why the asking lives in {@link DuelView} rather than
 * in an event of its own: the frame that carries the score carries who has
 * asked, so a client cannot show one without the other.
 */

import type { PuzzlePrompt } from "./puzzle";
import { RUSH_DURATION_MS, RUSH_SEQUENCE_LENGTH } from "./rush";
import type { InputEvent } from "./tetris/verify";

/** Best-of counts a host may pick. Odd, so a decided match cannot tie. */
export const DUEL_ROUND_OPTIONS: readonly number[] = [1, 3, 5, 7];

/** Per-round clock a host may pick, in milliseconds. */
export const DUEL_ROUND_MS_MIN = 30_000;
export const DUEL_ROUND_MS_MAX = 300_000;
export const DUEL_ROUND_MS_DEFAULT = 90_000;

/** Whole-match clock a rush host may pick. */
export const DUEL_RUSH_MS_MIN = 60_000;
export const DUEL_RUSH_MS_MAX = 600_000;
export const DUEL_RUSH_MS_DEFAULT = 300_000;

/**
 * How long after a round's deadline a claim is still admitted.
 *
 * Real slack, not a rounding allowance: a player who keeps going past the
 * buzzer and finishes inside it turns a draw into a win. It is narrow because
 * of that, and non-zero because without it a player on a slow connection is
 * robbed of a solve they genuinely made in time. No value is right for both,
 * which is the same trade the rush submit grace names.
 *
 * It admits a late claim; it never reorders one. A claim inside the grace can
 * never take a round the opponent has already won.
 */
export const DUEL_CLAIM_GRACE_MS = 1_000;

/** Both players must be present before a match starts. */
export const DUEL_PLAYERS = 2;

/** A lobby nobody joins is swept after this. */
export const DUEL_LOBBY_TTL_MS = 15 * 60_000;

/**
 * How long a finished duel waits to be played again before it is swept.
 *
 * A match that is over is kept only because the two people who just played it
 * may want another, and they decide that while they are still looking at the
 * result — not a quarter of an hour later, which is what a lobby is given
 * because a lobby is waiting for somebody who has not arrived yet.
 */
export const DUEL_REMATCH_TTL_MS = 2 * 60_000;

export type DuelMode = "puzzle" | "rush";

export interface DuelSettings {
  readonly mode: DuelMode;
  /** Best of this many. Rush has no rounds and pins this to 1. */
  readonly rounds: number;
  /** Per-round clock for puzzle, whole-match clock for rush. */
  readonly durationMs: number;
}

export interface DuelPlayerView {
  readonly id: string;
  readonly username: string;
  readonly avatarUrl: string | null;
  readonly connected: boolean;
  readonly score: number;
  /** Has asked to go again. Only ever true while the match is over. */
  readonly wantsRematch: boolean;
}

export type DuelPhase = "lobby" | "playing" | "over";

export interface DuelView {
  readonly id: string;
  readonly phase: DuelPhase;
  readonly settings: DuelSettings;
  readonly hostId: string;
  readonly players: readonly DuelPlayerView[];
  /** From 1. Zero in the lobby, and for all of a rush, which has no rounds. */
  readonly round: number;
  /**
   * Server clock: when this finished duel stops accepting a rematch.
   *
   * Null whenever asking is pointless — the match is still on, or the duel has
   * outlived the offer, or the opponent is gone and there is nobody to ask. A
   * client can read it as "the rematch button is live until then", which is the
   * only way to retire that button on time: the sweep that drops the duel runs
   * on its own timer and says so late.
   */
  readonly rematchEndsAt: number | null;
}

/** How far along the opponent is. Never their board — see the note above. */
export interface DuelProgress {
  readonly piecesPlaced: number;
  readonly pieceBudget: number;
  readonly attack: number;
  readonly targetAttack: number;
  /** Rush only: puzzles solved so far. */
  readonly solved: number;
}

export type RoundEnd = "solved" | "expired" | "forfeit";

// ── Client to server ─────────────────────────────────────────────────────────

export type DuelCommand =
  | { readonly type: "open"; readonly settings: DuelSettings }
  | { readonly type: "join"; readonly duelId: string }
  | { readonly type: "leave" }
  | { readonly type: "ready" }
  /** The log that solves the puzzle this player is on. The only claim there is. */
  | { readonly type: "claim"; readonly events: readonly InputEvent[] }
  /** Rush only: give up on this puzzle and take the next one. Bounded. */
  | { readonly type: "skip" }
  /**
   * Play the finished match again. The first asks, the second accepts.
   *
   * Sending it twice is sending it once: it says "I am willing", not "go", so
   * there is nothing for a repeat to add and nothing it can take away.
   */
  | { readonly type: "rematch" }
  | { readonly type: "progress"; readonly progress: DuelProgress };

// ── Server to client ─────────────────────────────────────────────────────────

export type DuelEvent =
  | { readonly type: "welcome"; readonly playerId: string; readonly open: readonly DuelView[] }
  | { readonly type: "duel"; readonly duel: DuelView }
  | {
      readonly type: "round";
      readonly round: number;
      readonly puzzle: PuzzlePrompt;
      /** Server clock. The client shows a countdown; the server enforces it. */
      readonly endsAt: number;
      readonly duel: DuelView;
    }
  /**
   * Rush only: the puzzle this player is on now, sent to them and nobody else.
   *
   * Arrives once when the match opens and once each time they leave a puzzle
   * behind, so a client never needs to know the stack to stay on it.
   */
  | {
      readonly type: "rush";
      /** Position in the shared stack, from 0. */
      readonly index: number;
      /** Null once the stack is spent — nothing left to play, clock still running. */
      readonly puzzle: PuzzlePrompt | null;
      /** Server clock for the whole match, not for this puzzle. */
      readonly endsAt: number;
      readonly solved: number;
      readonly skipsLeft: number;
      readonly duel: DuelView;
    }
  | { readonly type: "opponent"; readonly progress: DuelProgress }
  | {
      readonly type: "roundOver";
      readonly round: number;
      readonly winnerId: string | null;
      readonly reason: RoundEnd;
      readonly duel: DuelView;
    }
  | {
      readonly type: "matchOver";
      readonly winnerId: string | null;
      readonly reason: RoundEnd;
      readonly duel: DuelView;
    }
  | { readonly type: "error"; readonly message: string };

/**
 * Bounds a host's settings.
 *
 * Every field here arrives in a socket frame, which no middleware in this
 * server ever sees: the body cap and all five rate limiters are Hono HTTP
 * middleware and do not reach a WebSocket. Nothing downstream may assume any
 * of this is sane.
 */
export function sanitizeSettings(input: unknown): DuelSettings {
  const raw = (input ?? {}) as Partial<DuelSettings>;
  const mode: DuelMode = raw.mode === "rush" ? "rush" : "puzzle";
  const rounds = DUEL_ROUND_OPTIONS.includes(raw.rounds as number) ? (raw.rounds as number) : 3;
  const [low, high, fallback] =
    mode === "rush"
      ? [DUEL_RUSH_MS_MIN, DUEL_RUSH_MS_MAX, DUEL_RUSH_MS_DEFAULT]
      : [DUEL_ROUND_MS_MIN, DUEL_ROUND_MS_MAX, DUEL_ROUND_MS_DEFAULT];
  const claimed = raw.durationMs;
  const durationMs =
    typeof claimed === "number" && Number.isFinite(claimed)
      ? Math.min(high, Math.max(low, Math.round(claimed)))
      : fallback;
  return { mode, rounds: mode === "rush" ? 1 : rounds, durationMs };
}

/** Rounds one player must take to win, so a decided match can stop early. */
export function roundsToWin(rounds: number): number {
  return Math.floor(rounds / 2) + 1;
}

/**
 * How many puzzles a rush duel stacks up.
 *
 * The single-player rush sizes its stack for its own five minutes, and a duel
 * host may buy twice that. Pinning the stack to that constant would let a fast
 * player in a long match run off the end of it with time still on the clock and
 * nothing left to play, so the stack is sized to the clock the host chose.
 *
 * Skips are not scaled the same way and should not be: a longer match is more
 * puzzles, but two skips is a decision either way.
 */
export function rushDuelLength(durationMs: number): number {
  return Math.ceil((durationMs / RUSH_DURATION_MS) * RUSH_SEQUENCE_LENGTH);
}
