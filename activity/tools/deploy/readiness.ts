/**
 * What the deploy concludes from a status file, in one place, built only on
 * the contract's own `isFresh` and `isDrained`.
 *
 * Every question here answers "no" when it cannot be sure: a missing file, a
 * stale one, one written by a process that is no longer alive, or one naming
 * another build. A deploy that guessed "yes" would stop a game mid-duel or
 * restart a bot mid-sync; one that answers "no" only waits, and says why.
 */

import { isFresh, type BotStatus, type GameStatus, type RuntimeStatus } from "../../shared/runtime-status";
import type { StatusReading } from "./host";
import { describeDuration } from "./wait";

export function gameOf(reading: StatusReading): GameStatus | null {
  return reading.status?.app === "game" ? reading.status : null;
}

export function botOf(reading: StatusReading): BotStatus | null {
  return reading.status?.app === "bot" ? reading.status : null;
}

function current(status: RuntimeStatus, buildId: string, now: number, pidAlive: (pid: number) => boolean): boolean {
  return isFresh(status, now) && status.buildId === buildId && pidAlive(status.pid);
}

/** A game slot that is up, listening, and serving exactly this build. */
export function gameServing(reading: StatusReading, buildId: string, now: number, pidAlive: (pid: number) => boolean): boolean {
  const status = gameOf(reading);
  return status !== null && status.state === "serving" && current(status, buildId, now, pidAlive);
}

/** A bot that is connected and running exactly this build. */
export function botReady(reading: StatusReading, buildId: string, now: number, pidAlive: (pid: number) => boolean): boolean {
  const status = botOf(reading);
  return status !== null && status.state === "ready" && current(status, buildId, now, pidAlive);
}

/**
 * A bot a restart would interrupt nobody on: nothing in flight, no sync, and
 * nothing handled for `quietSeconds` (a player mid-conversation is likely to
 * send the next command).
 */
export function botQuiet(status: BotStatus | null, now: number, quietSeconds: number): boolean {
  if (status === null || !isFresh(status, now) || status.state !== "ready") return false;
  if (status.inflight > 0 || status.syncRunning) return false;
  return status.lastInteractionAt === null || now - status.lastInteractionAt >= quietSeconds * 1000;
}

/** A game slot with no match going and no rush that may still be handed in. */
export function gameQuiet(status: GameStatus | null, now: number): boolean {
  return status !== null && isFresh(status, now) && status.duelsInMatch === 0 && status.rushTicketsRecent === 0;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "1 duel, 0 lobbies, 0 rushes, 3 sessions, 0 in flight". */
export function describeGameCounts(status: GameStatus): string {
  return [
    plural(status.duelsInMatch, "duel", "duels"),
    plural(status.lobbies, "lobby", "lobbies"),
    plural(status.rushTicketsRecent, "rush", "rushes"),
    plural(status.sessionsRecent, "session", "sessions"),
    `${status.inflight} in flight`,
  ].join(", ");
}

/** "2 in flight · idle 5 s · sync running": what a bot is busy with. */
export function describeBotActivity(status: BotStatus, now: number): string {
  const parts = status.inflight > 0 ? [`${status.inflight} in flight`] : [];
  parts.push(
    status.lastInteractionAt === null ? "no interaction since start" : `idle ${describeDuration(now - status.lastInteractionAt)}`,
  );
  parts.push(status.syncRunning ? "sync running" : "no sync");
  return parts.join(" · ");
}

/** Why a status cannot be used: said instead of guessed. Null when it can. */
export function unusableReason(reading: StatusReading, now: number): string | null {
  if (!reading.present) return "no status file";
  if (reading.status === null) return "status unreadable";
  if (!isFresh(reading.status, now)) return `status stale (written ${describeDuration(now - reading.status.updatedAt)} ago)`;
  return null;
}
