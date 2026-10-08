/**
 * The new game slot, from its first "serving" until the old slot is out of
 * pm2. The drain cannot be undone — told once, the old slot stops listening
 * for good — so the new slot must be serving before it is sent, and stay so
 * until the old one is stopped:
 *
 * - **Steady before the drain.** One "serving" is not enough: the same pid
 *   must say so again {@link STEADY_MS} later. A release that crashes a few
 *   seconds after binding the port, and that pm2 restarts in a loop, changes
 *   its pid or stops writing.
 * - **Watched during the drain.** Every look at the old slot looks at the new
 *   one too; once its process is gone — its pid dead, or a fresh status from
 *   another pid — the wait ends at once.
 * - **Serving before the old one is stopped**, from that pid. A status gone
 *   stale (a long write, a pause) is given {@link RECHECK_MS} to come back.
 *
 * When the new slot fails after the drain began, the old slot is never
 * stopped: it no longer listens, but its matches go on, and stopping it
 * would end them for nothing. {@link newSlotLost} says what the box is left
 * as, and the two ways back.
 */

import { isFresh } from "../../shared/runtime-status";
import { DeployError } from "./errors";
import type { Context } from "./host";
import { slotStatusFile } from "./layout";
import { gameOf, unusableReason } from "./readiness";
import { shortSha } from "./release";
import { waitUntil } from "./wait";

/** How long a new slot must keep serving on one pid before the old one is told to drain. */
export const STEADY_MS = 5_000;
/** How long a new slot whose status went stale has to serve again before the old one is stopped. */
const RECHECK_MS = 30_000;
const POLL_MS = 1_000;

/** A slot that reported serving `sha` steadily, from `pid`. */
export interface NewSlot {
  readonly name: string;
  readonly pid: number;
  readonly sha: string;
}

export type Serving = { readonly ok: true; readonly pid: number } | { readonly ok: false; readonly problem: string };

/** Whether `slot` serves `sha` now, from a live pid and a fresh status; why not, if it does not. */
export function readServing(ctx: Context, slot: string, sha: string): Serving {
  const { host } = ctx;
  const now = host.clock.now();
  const reading = host.readStatus(slotStatusFile(ctx.layout, slot));
  const unusable = unusableReason(reading, now);
  if (unusable !== null) return { ok: false, problem: unusable };
  const status = gameOf(reading);
  if (status === null) return { ok: false, problem: "its status is not a game's" };
  if (status.buildId !== sha) return { ok: false, problem: `its status names build ${shortSha(status.buildId)}` };
  if (!host.pidAlive(status.pid)) return { ok: false, problem: `its process ${status.pid} is gone` };
  if (status.state !== "serving") return { ok: false, problem: `its status says ${status.state}` };
  return { ok: true, pid: status.pid };
}

/** Serving `sha` from one pid now and {@link STEADY_MS} later: that pid, or why not. */
export async function confirmSteady(ctx: Context, slot: string, sha: string): Promise<Serving> {
  const first = readServing(ctx, slot, sha);
  if (!first.ok) return first;
  await ctx.host.clock.sleep(STEADY_MS);
  const later = readServing(ctx, slot, sha);
  const after = `${STEADY_MS / 1000} s after it first reported serving`;
  if (!later.ok) return { ok: false, problem: `${later.problem}, ${after}` };
  if (later.pid !== first.pid) return { ok: false, problem: `pm2 restarted it: pid ${first.pid} became pid ${later.pid}, ${after}` };
  return first;
}

/** Why the new slot's process is gone, or null while it lives: its pid dead, or a fresh status from another pid. */
export function newSlotGone(ctx: Context, slot: NewSlot): string | null {
  const { host } = ctx;
  const status = gameOf(host.readStatus(slotStatusFile(ctx.layout, slot.name)));
  if (status !== null && isFresh(status, host.clock.now()) && status.pid !== slot.pid) {
    return `pm2 restarted ${slot.name} (pid ${status.pid}, was ${slot.pid})`;
  }
  if (!host.pidAlive(slot.pid)) return `${slot.name}'s process ${slot.pid} is gone`;
  return null;
}

function problemNow(ctx: Context, slot: NewSlot): { readonly problem: string | null; readonly final: boolean } {
  const gone = newSlotGone(ctx, slot);
  if (gone !== null) return { problem: gone, final: true };
  const serving = readServing(ctx, slot.name, slot.sha);
  return { problem: serving.ok ? null : serving.problem, final: false };
}

/** Before the old slot is stopped: null once the new one serves from its pid; why not, if it does not within {@link RECHECK_MS}. */
export async function stillServing(ctx: Context, slot: NewSlot): Promise<string | null> {
  let last = problemNow(ctx, slot);
  if (last.problem === null || last.final) return last.problem;
  await waitUntil(
    ctx,
    () => {
      last = problemNow(ctx, slot);
      return last.problem === null || last.final;
    },
    { timeoutMs: RECHECK_MS, intervalMs: POLL_MS },
  );
  return last.problem;
}

/**
 * The new slot failed while `old` drained: what the box is left as, and the
 * two ways back. `previous` is the release `rollback game` would go to.
 */
export function newSlotLost(ctx: Context, previous: string | null, old: string, slot: NewSlot, problem: string): DeployError {
  const short = shortSha(slot.sha);
  const back =
    previous === null
      ? "There is no earlier release recorded to roll back to."
      : `Or roll back: \`pm2 stop ${slot.name}\`, then \`bun run deploy rollback game\`, which starts ${slot.name} on ` +
        `${shortSha(previous)} beside ${old} and only then finishes ${old}'s drain.`;
  return new DeployError(
    `${slot.name}, the new slot on ${short}, stopped serving while ${old} drained: ${problem}. ` +
      `${old} was told to drain, so it no longer listens, but it was not stopped: it still holds its matches and ` +
      `lets them finish. Nothing may be answering port ${ctx.config.gamePort} now. state.json names ${slot.name} ` +
      `on ${short}; pm2's saved list was not updated. ${slot.name}'s output is in pm2's logs ` +
      `(~/.pm2/logs/${slot.name}-out.log and -error.log).\n` +
      `Start the new slot again: once \`bun run deploy status\` shows ${slot.name} serving ${short} (pm2 may be ` +
      `restarting it already; if it shows stopped or errored, \`pm2 start ${ctx.layout.ecosystem} --only ${slot.name}\`), ` +
      `run \`bun run deploy switch game ${short}\` again: it finishes ${old}'s drain and takes it out of pm2.\n${back}`,
  );
}
