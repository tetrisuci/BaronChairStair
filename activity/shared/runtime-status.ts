/**
 * What a running process tells the deploy about itself, and how the deploy
 * talks back: the contract between the game, the bot and `tools/deploy/`.
 *
 * A deploy has to know two things it cannot see from outside a process: is it
 * up and serving the build it was started with, and is anybody in the middle
 * of something it would cut short. So each long-running app writes a small
 * JSON status file, by path from its environment, and the deploy reads it.
 * A file rather than a route because the game hands over on one port — two
 * processes answer it at once during a switch, so a request cannot pick which
 * one it asks — and because the bot has no HTTP server at all.
 *
 * **Counts only.** A status file holds no player id, name, token, guild id or
 * address: it sits in the shared directory beside the databases, and the
 * deploy prints it.
 *
 * Pure and importing nothing, so the game's server and the deploy tool both
 * load it. The bot writes the same shape from Python (`client/runtime_status.py`);
 * `tests/runtime-status.test.ts` holds both to {@link readStatus}.
 */

/** The response header carrying the build the game serves, on every response. */
export const BUILD_ID_HEADER = "X-Build-Id";

/**
 * Where the client's build records its id, inside the build directory: the
 * game reads it at boot so its header names the bundle it serves, and the
 * client is compiled with the same id, so the two can be compared.
 */
export const BUILD_ID_FILE = "build.json";

/** Environment variables the contract adds. */
export const ENV = {
  /** Absolute path of the status file this process writes. Unset: none is written. */
  statusFile: "STATUS_FILE",
  /** The build id: the release's commit. Read by the client build and the bot. */
  buildId: "BUILD_ID",
  /** The bot's `stats.db`, absolute. Unset: beside the bot's code, as before. */
  statsDb: "STATS_DB",
} as const;

/**
 * What each signal means to the game.
 *
 * Not SIGUSR1 or SIGUSR2: on Bun 1.3.13, the version this box runs, SIGUSR2
 * ends the process before any handler runs and SIGUSR1 crashes it (measured
 * 2026-10-07). SIGHUP, SIGINT and SIGTERM all reach a handler.
 */
export const SIGNALS = {
  /**
   * Hand over: stop listening, close lobbies that have no match with a
   * "reopen it" notice, keep every match in progress to its end, answer
   * whatever still arrives with `Connection: close`, and report `draining`.
   * Never exits by itself — the deploy stops it once it reports idle.
   */
  drain: "SIGHUP",
  /**
   * Stop: let requests in flight finish (a few seconds at most), tell every
   * duel socket the server is restarting, then exit 0. pm2's own stop sends
   * SIGINT, so both mean this.
   */
  stop: ["SIGINT", "SIGTERM"],
} as const;

/**
 * How the game closes a duel socket when the process is going away, so the
 * client can say what happened instead of "the connection closed".
 *
 * 1012 is the WebSocket code for "service restart". The reason tells the two
 * cases apart: `handover` closes a lobby nobody was matched in — the new
 * process is already listening, so the player can open it again at once —
 * and `restart` ends whatever was left when the process stops, a match
 * included.
 */
export const SERVER_GOING_AWAY = {
  code: 1012,
  handover: "handover",
  restart: "restart",
} as const;

/** How often a process rewrites its status file, at most this many ms apart. */
export const STATUS_INTERVAL_MS = 5_000;

/**
 * A status file older than this is a process that has stopped writing — hung,
 * killed, or gone — and the deploy treats it as unknown, not as idle.
 */
export const STATUS_STALE_MS = 20_000;

/** How far back "recent" reaches for rush tickets: a rush and its grace. */
export const RECENT_RUSH_MS = 5 * 60_000 + 10_000;

/** How far back "recent" reaches for sessions. */
export const RECENT_SESSION_MS = 10 * 60_000;

export type GameState = "starting" | "serving" | "draining" | "stopping";

export interface GameStatus {
  readonly app: "game";
  readonly pid: number;
  readonly buildId: string;
  readonly port: number;
  readonly state: GameState;
  /** Epoch ms. */
  readonly startedAt: number;
  /** Epoch ms of this write. */
  readonly updatedAt: number;
  /** Matches with a round under way or between rounds. */
  readonly duelsInMatch: number;
  /** Lobbies open with nobody matched yet. */
  readonly lobbies: number;
  /** Rush tickets minted within {@link RECENT_RUSH_MS}: rushes that may still be handed in. */
  readonly rushTicketsRecent: number;
  /** Distinct sessions that made a request within {@link RECENT_SESSION_MS}. */
  readonly sessionsRecent: number;
  /** HTTP requests being answered right now. */
  readonly inflight: number;
}

export type BotState = "starting" | "ready" | "stopping";

export interface BotStatus {
  readonly app: "bot";
  readonly pid: number;
  readonly buildId: string;
  readonly state: BotState;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** Epoch ms of the last slash command or interaction handled; null before the first. */
  readonly lastInteractionAt: number | null;
  /** Interactions being handled right now. */
  readonly inflight: number;
  /** Whether `/archive sync` is running. A restart would cut it short. */
  readonly syncRunning: boolean;
}

export type RuntimeStatus = GameStatus | BotStatus;

const GAME_STATES: readonly string[] = ["starting", "serving", "draining", "stopping"];
const BOT_STATES: readonly string[] = ["starting", "ready", "stopping"];

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function epoch(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * A status file's contents, checked, or null for anything that is not one.
 *
 * Untrusted in the sense every file is: a half-written file, an old format, a
 * process from before this contract. Null makes the deploy say "unknown" and
 * wait or stop rather than act on a guess.
 */
export function readStatus(text: string): RuntimeStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!count(v.pid) || typeof v.buildId !== "string" || !epoch(v.startedAt) || !epoch(v.updatedAt)) {
    return null;
  }
  if (v.app === "game") {
    if (typeof v.state !== "string" || !GAME_STATES.includes(v.state)) return null;
    if (!count(v.port) || !count(v.duelsInMatch) || !count(v.lobbies)) return null;
    if (!count(v.rushTicketsRecent) || !count(v.sessionsRecent) || !count(v.inflight)) return null;
    return v as unknown as GameStatus;
  }
  if (v.app === "bot") {
    if (typeof v.state !== "string" || !BOT_STATES.includes(v.state)) return null;
    if (v.lastInteractionAt !== null && !epoch(v.lastInteractionAt)) return null;
    if (!count(v.inflight) || typeof v.syncRunning !== "boolean") return null;
    return v as unknown as BotStatus;
  }
  return null;
}

/** Whether a status was written recently enough to be believed. */
export function isFresh(status: RuntimeStatus, now: number): boolean {
  return now - status.updatedAt <= STATUS_STALE_MS;
}

/** A game that has finished every match and request it was holding. */
export function isDrained(status: GameStatus): boolean {
  return status.state === "draining" && status.duelsInMatch === 0 && status.inflight === 0;
}
