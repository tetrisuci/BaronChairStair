/**
 * The drain half of a game handover: tell the live slot to stop listening and
 * finish its matches, then wait until it says it has — or until the limit.
 *
 * The wait ends early only when the old process is known to be gone: its pid
 * no longer alive, or a fresh status from another pid (pm2 restarted it, and
 * that process serves old code beside the new slot). A status that goes
 * stale, missing or unreadable while the pid lives is a process that stopped
 * writing — a long synchronous SQLite write, a pause under load — and the
 * contract calls that unknown, not idle. Taking it for gone would end every
 * match still running there with a "restarted" notice, so the wait goes on,
 * to the drain limit if need be, and the progress line says the status is
 * stale.
 *
 * The wait also ends, at once, when the caller's `abortIf` says so: the new
 * slot's process is gone (`new-slot.ts`). Then nothing is reported as
 * drained, and the old slot is left for the caller to explain, never stopped.
 */

import { isDrained, isFresh, type GameStatus } from "../../shared/runtime-status";
import type { Context } from "./host";
import { slotStatusFile } from "./layout";
import { pm2Drain } from "./pm2";
import { gameOf, unusableReason } from "./readiness";
import { describeDuration, waitUntil } from "./wait";

const DRAIN_POLL_MS = 5_000;
const PROGRESS_EVERY_MS = 30_000;
const MINUTE_MS = 60_000;

/** The slot serving the port when the switch began, and whether it can be told to drain. */
export type LiveSlot =
  | { readonly name: string; readonly drainable: true; readonly pid: number }
  | { readonly name: string; readonly drainable: false; readonly reason: string };

/** The pid of a slot's fresh status, if that process is alive. */
export function servingPid(ctx: Context, slot: string): number | null {
  const { host } = ctx;
  const status = gameOf(host.readStatus(slotStatusFile(ctx.layout, slot)));
  return status !== null && isFresh(status, host.clock.now()) && host.pidAlive(status.pid) ? status.pid : null;
}

/** What one look at a draining slot found. */
type DrainReading =
  | { readonly kind: "counts"; readonly status: GameStatus }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "gone"; readonly reason: string };

const NOT_READ: DrainReading = { kind: "unknown", reason: "not read yet" };

/**
 * A draining slot, judged against the pid that was told to drain. Only a dead
 * pid, or a fresh status from another one, means it is gone; a status that is
 * stale, missing or unreadable while the pid lives is unknown, never idle.
 */
function readDrain(ctx: Context, slot: string, pid: number): DrainReading {
  const { host } = ctx;
  const now = host.clock.now();
  const reading = host.readStatus(slotStatusFile(ctx.layout, slot));
  const status = gameOf(reading);
  if (status !== null && isFresh(status, now) && status.pid !== pid) {
    return { kind: "gone", reason: `pm2 restarted ${slot} mid-drain (pid ${status.pid}, was ${pid}), and it serves old code` };
  }
  if (!host.pidAlive(pid)) return { kind: "gone", reason: `${slot}'s process ${pid} is gone (it exited or was killed)` };
  if (status === null || !isFresh(status, now)) {
    return { kind: "unknown", reason: unusableReason(reading, now) ?? "not a game status" };
  }
  return { kind: "counts", status };
}

/** "1 duel, 0 in flight", or why that is not known and what was last known. */
function describeReading(reading: DrainReading, lastCounts: GameStatus | null): string {
  if (reading.kind === "counts") return describeDrain(reading.status);
  const known = lastCounts === null ? "" : `; last known ${describeDrain(lastCounts)}`;
  return `${reading.reason}${known}`;
}

/**
 * Tell the live slot to drain, and wait for it — or for the limit. Returns
 * null when the wait ended so (drained, the limit, the old process gone), or
 * what `abortIf` said when it ended the wait instead.
 */
export async function drain(
  ctx: Context,
  live: LiveSlot & { readonly drainable: true },
  abortIf: () => string | null = () => null,
): Promise<string | null> {
  const { host, config } = ctx;
  const slot = live.name;
  // Read again: pm2 may have restarted the slot while the new one started.
  const pid = servingPid(ctx, slot) ?? live.pid;
  await pm2Drain(ctx, slot);
  if (ctx.dryRun) {
    host.out(`would wait up to ${config.drainLimitMinutes} min for ${slot} to drain`);
    return null;
  }
  let latest = NOT_READ;
  let lastCounts: GameStatus | null = null;
  let aborted: string | null = null;
  const drained = await waitUntil(
    ctx,
    () => {
      aborted = abortIf();
      if (aborted !== null) return true;
      latest = readDrain(ctx, slot, pid);
      if (latest.kind === "counts") lastCounts = latest.status;
      return latest.kind === "gone" || (latest.kind === "counts" && isDrained(latest.status));
    },
    {
      timeoutMs: config.drainLimitMinutes * MINUTE_MS,
      intervalMs: DRAIN_POLL_MS,
      progressEveryMs: PROGRESS_EVERY_MS,
      onProgress: (elapsed) => {
        host.out(
          `draining ${slot}: ${describeReading(latest, lastCounts)} · ${describeDuration(elapsed)} of ${config.drainLimitMinutes} min`,
        );
      },
    },
  );
  if (aborted !== null) return aborted;
  reportDrain(ctx, slot, drained, latest, lastCounts);
  return null;
}

function reportDrain(ctx: Context, slot: string, drained: boolean, latest: DrainReading, lastCounts: GameStatus | null): void {
  const { host, config } = ctx;
  if (latest.kind === "gone") {
    host.out(`${latest.reason}: stopping it`);
  } else if (drained) {
    host.out(`${slot} has drained`);
  } else {
    host.out(
      `warning: drain limit of ${config.drainLimitMinutes} min reached with ${describeReading(latest, lastCounts)} in ${slot}; ` +
        'stopping it ends any match left with a "restarted" notice',
    );
  }
}

function describeDrain(status: GameStatus): string {
  return `${status.duelsInMatch} ${status.duelsInMatch === 1 ? "duel" : "duels"}, ${status.inflight} in flight`;
}
