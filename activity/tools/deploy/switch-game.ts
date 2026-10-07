/**
 * `switch game <sha>`: hand the port from one game slot to the other without
 * cutting a duel.
 *
 * Both slots bind the same port with reusePort, so the new one starts beside
 * the live one with no proxy change. Measured on Bun 1.3.13: once the old
 * process calls `server.stop()`, every new connection reaches the new one,
 * while a WebSocket already open on the old one keeps working for as long as
 * that process lives. So the order is:
 *
 * 1. start the idle slot on the new release, and wait until its status file
 *    says it is serving *that* build, from a live pid, freshly written;
 * 2. only then tell the live slot to drain (SIGHUP): it stops listening,
 *    closes empty lobbies, and keeps its matches going to their end;
 * 3. wait until it reports drained, or the drain limit passes;
 * 4. stop it — pm2's graceful stop, which ends any match still going with a
 *    "restarted" notice — and remove it from pm2's table.
 *
 * If the new slot never comes up, it is stopped and the live slot is never
 * touched: the box is exactly as it was.
 *
 * The stopped slot is deleted from pm2, not left stopped, and the ecosystem
 * file lists only the live slot, so nothing — a `pm2 resurrect` after a
 * reboot, a `pm2 start` of the file — can bring old code back up on the port
 * beside the new.
 */

import { isDrained, isFresh, type GameStatus } from "../../shared/runtime-status";
import { ensureDirectory, removeFile } from "./effects";
import { assignmentsOf, writeEcosystem, type GameAssignment } from "./ecosystem";
import { DeployError } from "./errors";
import { reportDone } from "./exec";
import type { Context } from "./host";
import { slotStatusFile } from "./layout";
import { findProcess, isOnline, pm2Delete, pm2Drain, pm2List, pm2Save, pm2Start, pm2Stop, type Pm2Process } from "./pm2";
import { gameOf, gameServing, unusableReason } from "./readiness";
import { requirePrepared, shortSha } from "./release";
import { requireSharedFiles } from "./shared-files";
import { loadState, moved, saveState, type DeployState } from "./state";
import { describeDuration, waitUntil } from "./wait";

export interface GameSwitchOptions {
  /** Accept stopping a live slot that cannot drain (it writes no status) like a restart. */
  readonly allowCold: boolean;
  /** Switch even if the live slot already serves this release: a restart that drops no duel. */
  readonly force: boolean;
  /** Only for a dry run of a whole deploy, whose prepare built nothing. */
  readonly assumePrepared?: boolean;
}

const START_TIMEOUT_MS = 90_000;
const START_POLL_MS = 1_000;
const DRAIN_POLL_MS = 5_000;
const PROGRESS_EVERY_MS = 30_000;
const MINUTE_MS = 60_000;

interface Slots {
  /** The slot serving the port now, or null if none runs. */
  readonly active: string | null;
  readonly idle: string;
}

function otherSlot(ctx: Context, slot: string): string {
  const [first, second] = ctx.config.pm2.gameSlots;
  return slot === first ? second : first;
}

function pickSlots(ctx: Context, state: DeployState, processes: readonly Pm2Process[]): Slots {
  const slots = ctx.config.pm2.gameSlots;
  const online = slots.filter((slot) => isOnline(findProcess(processes, slot)));
  if (online.length === 2) {
    throw new DeployError(
      `both game slots are running (${online.join(", ")}): a switch was interrupted, or one was started by hand. ` +
        "Check `bun run deploy status`; once the slot state.json does not name as active has drained, " +
        "stop it with `pm2 stop <name>` and run this again.",
    );
  }
  const active = online[0] ?? null;
  if (active !== null && state.game.activeSlot !== null && active !== state.game.activeSlot) {
    ctx.host.out(`warning: state.json says ${state.game.activeSlot} is live, but pm2 runs ${active}; going by pm2`);
  }
  return { active, idle: otherSlot(ctx, active ?? state.game.activeSlot ?? slots[1]) };
}

/** Why the live slot cannot be drained, or null if it can. */
function coldReason(ctx: Context, slot: string): string | null {
  const { host } = ctx;
  const reading = host.readStatus(slotStatusFile(ctx.layout, slot));
  const status = gameOf(reading);
  if (status !== null && isFresh(status, host.clock.now()) && host.pidAlive(status.pid)) return null;
  return unusableReason(reading, host.clock.now()) ?? "its status names a process that is gone";
}

async function probe(ctx: Context, sha: string, when: string): Promise<void> {
  if (ctx.dryRun) return;
  const reply = await ctx.host.probe(`http://127.0.0.1:${ctx.config.gamePort}/api/health`);
  if (reply === null) {
    ctx.host.out(`health probe ${when}: no answer`);
    return;
  }
  const build = reply.buildId === null ? "no build id" : `build ${shortSha(reply.buildId)}${reply.buildId === sha ? " (new)" : " (old)"}`;
  ctx.host.out(`health probe ${when}: ${reply.status}, answered by ${build}`);
}

/** Start `idle` on `sha` and wait for it to serve; on failure, stop it and leave the box as it was. */
async function startIdle(ctx: Context, state: DeployState, slots: Slots, sha: string, idleProcess: Pm2Process | undefined): Promise<void> {
  const { idle, active } = slots;
  const statusFile = slotStatusFile(ctx.layout, idle);
  if (idleProcess) await pm2Delete(ctx, idle);
  removeFile(ctx, statusFile);
  ensureDirectory(ctx, ctx.layout.run);
  const live: GameAssignment[] =
    active !== null && active === state.game.activeSlot && state.game.release !== null
      ? [{ slot: active, release: state.game.release }]
      : [];
  writeEcosystem(ctx, { ...assignmentsOf(state), games: [...live, { slot: idle, release: sha }] });
  try {
    await pm2Start(ctx, idle);
  } catch (error) {
    writeEcosystem(ctx, assignmentsOf(state));
    throw error;
  }
  if (ctx.dryRun) {
    ctx.host.out(`would wait up to ${START_TIMEOUT_MS / 1000} s for ${idle} to report serving ${shortSha(sha)}`);
    return;
  }
  const { host } = ctx;
  const serving = await waitUntil(ctx, () => gameServing(host.readStatus(statusFile), sha, host.clock.now(), host.pidAlive), {
    timeoutMs: START_TIMEOUT_MS,
    intervalMs: START_POLL_MS,
  });
  if (serving) {
    host.out(`${idle} serves ${shortSha(sha)}`);
    return;
  }
  const reading = host.readStatus(statusFile);
  const last = unusableReason(reading, host.clock.now()) ?? describeLast(gameOf(reading), sha);
  await pm2Stop(ctx, idle);
  await pm2Delete(ctx, idle);
  writeEcosystem(ctx, assignmentsOf(state));
  throw new DeployError(
    `${idle} did not report serving ${shortSha(sha)} within ${START_TIMEOUT_MS / 1000} s (${last}). ` +
      `It is stopped and out of pm2; ${active ?? "nothing"} was not touched. ` +
      `Its output is in pm2's logs for ${idle} (~/.pm2/logs/${idle}-out.log and -error.log).`,
  );
}

function describeLast(status: GameStatus | null, sha: string): string {
  if (status === null) return "no status";
  if (status.buildId !== sha) return `its status names build ${shortSha(status.buildId)}`;
  return `last state: ${status.state}`;
}

/** Tell the live slot to drain, and wait for it — or for the limit. */
async function drain(ctx: Context, slot: string): Promise<void> {
  const { host, config } = ctx;
  const file = slotStatusFile(ctx.layout, slot);
  const pid = gameOf(host.readStatus(file))?.pid ?? null;
  await pm2Drain(ctx, slot);
  if (ctx.dryRun) {
    host.out(`would wait up to ${config.drainLimitMinutes} min for ${slot} to drain`);
    return;
  }
  let last: GameStatus | null = null;
  let gone = false;
  const drained = await waitUntil(
    ctx,
    () => {
      const status = gameOf(host.readStatus(file));
      if (status === null || !isFresh(status, host.clock.now()) || status.pid !== pid) {
        gone = true;
        return true;
      }
      last = status;
      return isDrained(status);
    },
    {
      timeoutMs: config.drainLimitMinutes * MINUTE_MS,
      intervalMs: DRAIN_POLL_MS,
      progressEveryMs: PROGRESS_EVERY_MS,
      onProgress: (elapsed) => {
        const counts = last ? describeDrain(last) : "no status";
        host.out(`draining ${slot}: ${counts} · ${describeDuration(elapsed)} of ${config.drainLimitMinutes} min`);
      },
    },
  );
  if (gone) host.out(`${slot}'s status went away mid-drain (it exited, hung or was restarted): stopping it`);
  else if (drained) host.out(`${slot} has drained`);
  else {
    const left = last ? describeDrain(last) : "an unknown number of duels";
    host.out(
      `warning: drain limit of ${config.drainLimitMinutes} min reached with ${left} in ${slot}; ` +
        'stopping it ends them with a "restarted" notice',
    );
  }
}

function describeDrain(status: GameStatus): string {
  return `${status.duelsInMatch} ${status.duelsInMatch === 1 ? "duel" : "duels"}, ${status.inflight} in flight`;
}

export async function switchGame(ctx: Context, sha: string, options: GameSwitchOptions): Promise<void> {
  requirePrepared(ctx, sha, options.assumePrepared);
  requireSharedFiles(ctx, ["daily"], "the game");
  const { host } = ctx;
  const state = loadState(ctx);
  const processes = await pm2List(ctx);
  const slots = pickSlots(ctx, state, processes);
  const { active, idle } = slots;

  if (!options.force && active !== null && active === state.game.activeSlot && state.game.release === sha) {
    host.out(`game: ${active} already serves ${shortSha(sha)}; nothing to do (--force switches anyway)`);
    return;
  }
  const cold = active === null ? null : coldReason(ctx, active);
  if (cold !== null && !options.allowCold) {
    throw new DeployError(
      `${active} cannot be told to drain: ${cold} (code from before the status contract, or a hung process). ` +
        "Handing over would end its duels like a restart. Re-run with --allow-cold to accept that.",
    );
  }

  await startIdle(ctx, state, slots, sha, findProcess(processes, idle));
  await probe(ctx, sha, "with both slots up");

  const next: DeployState = { ...state, game: { ...moved(state.game, sha), activeSlot: idle } };
  saveState(ctx, next);
  writeEcosystem(ctx, assignmentsOf(next));

  if (active !== null) {
    if (cold !== null) {
      host.out(`warning: ${active}: ${cold}; stopping it outright, which ends its duels like a restart (--allow-cold)`);
    } else {
      await drain(ctx, active);
    }
    await pm2Stop(ctx, active);
    await pm2Delete(ctx, active);
  }
  for (const leftover of ctx.config.pm2.gameSlots) {
    if (leftover !== idle && leftover !== active && findProcess(processes, leftover)) await pm2Delete(ctx, leftover);
  }
  await pm2Save(ctx);
  await probe(ctx, sha, "after the handover");
  reportDone(ctx, `game: ${idle} serves ${shortSha(sha)}${next.game.previous ? `; rollback goes to ${shortSha(next.game.previous)}` : ""}`);
}
