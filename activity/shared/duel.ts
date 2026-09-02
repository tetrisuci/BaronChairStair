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
 */

import type { PuzzlePrompt } from "./puzzle";
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
}

export type DuelPhase = "lobby" | "playing" | "over";

export interface DuelView {
  readonly id: string;
  readonly phase: DuelPhase;
  readonly settings: DuelSettings;
  readonly hostId: string;
  readonly players: readonly DuelPlayerView[];
  /** From 1. Zero while still in the lobby. */
  readonly round: number;
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
  /** The log that solves this round's puzzle. The only claim there is. */
  | { readonly type: "claim"; readonly events: readonly InputEvent[] }
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
