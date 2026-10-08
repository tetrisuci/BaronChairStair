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
 *    says it is serving *that* build, from a live pid, freshly written — and
 *    still says so, from the same pid, a few seconds later (`new-slot.ts`);
 * 2. only then tell the live slot to drain (SIGHUP): it stops listening,
 *    closes empty lobbies, and keeps its matches going to their end;
 * 3. wait until it reports drained, or the drain limit passes — or its
 *    process is known to be gone; a stale status is not that
 *    (`game-drain.ts`) — watching the new slot all the while;
 * 4. once the new slot still serves, stop the old one — pm2's graceful stop,
 *    which ends any match still going with a "restarted" notice — and remove
 *    it from pm2's table.
 *
 * If the new slot never comes up, or does not stay up, it is stopped and the
 * live slot is never touched: the box is exactly as it was. If it dies once
 * the drain has begun, the old slot is not stopped either — it no longer
 * listens, but its matches go on — and the switch stops, saying how to
 * recover.
 *
 * Running a switch again finishes one that was interrupted. state.json names
 * the new slot before the drain, and pm2's list is saved only at the end, so
 * a run stopped in between leaves the old slot in pm2 — draining, stopped, or
 * deleted without a save — and pm2's saved list on the old code. When the
 * slot state.json names serves the release asked for, the switch drains what
 * is left of the old slot (to the usual limit), takes it out of pm2, and
 * saves pm2's list; with nothing left over, it only saves. The slot
 * state.json names is never the one taken out.
 *
 * A live slot that cannot drain (code from before the contract, which writes
 * no status file and binds the port without reusePort, or a hung process) is
 * the one exception to "start the new one first": nothing can bind the port
 * beside a socket without SO_REUSEPORT. With `--allow-cold` it is stopped
 * first, so the game is down until the new slot serves; its pm2 entry is kept
 * until then, so `pm2 start <it>` brings it back if the new one never does.
 *
 * The stopped slot is deleted from pm2, not left stopped, and the ecosystem
 * file lists only the live slot, so nothing — a `pm2 resurrect` after a
 * reboot, a `pm2 start` of the file — can bring old code back up on the port
 * beside the new.
 */

import type { GameStatus } from "../../shared/runtime-status";
import { ensureDirectory, removeFile } from "./effects";
import { assignmentsOf, writeEcosystem, type GameAssignment } from "./ecosystem";
import { DeployError } from "./errors";
import { reportDone } from "./exec";
import { drain, servingPid, type LiveSlot } from "./game-drain";
import type { Context } from "./host";
import { slotStatusFile } from "./layout";
import { STEADY_MS, confirmSteady, newSlotGone, newSlotLost, readServing, stillServing, type NewSlot } from "./new-slot";
import { findProcess, isOnline, pm2Delete, pm2List, pm2Save, pm2Start, pm2Stop, type Pm2Process } from "./pm2";
import { gameOf, gameServing, unusableReason } from "./readiness";
import { requirePrepared, shortSha } from "./release";
import { requireSharedFiles } from "./shared-files";
import { loadState, moved, saveState, type DeployState } from "./state";
import { waitUntil } from "./wait";

export interface GameSwitchOptions {
  /** Accept stopping a live slot that cannot drain (it writes no status) before the new one starts, like a restart. */
  readonly allowCold: boolean;
  /** Switch even if the live slot already serves this release: a restart that drops no duel. */
  readonly force: boolean;
  /** Only for a dry run of a whole deploy, whose prepare built nothing. */
  readonly assumePrepared?: boolean;
}

const START_TIMEOUT_MS = 90_000;
const START_POLL_MS = 1_000;

interface Slots {
  /** The slot serving the port now, or null if none runs. */
  readonly active: string | null;
  readonly idle: string;
}

function otherSlot(ctx: Context, slot: string): string {
  const [first, second] = ctx.config.pm2.gameSlots;
  return slot === first ? second : first;
}

/**
 * The refusal when both slots run and the switch cannot finish the job
 * itself — state.json names neither, the target is another release, the slot
 * it names does not serve, or the other cannot be told to drain — with the
 * whole way out.
 *
 * Stop, delete *and* save: a slot that is only stopped stays in pm2's table,
 * and pm2's saved list, still the one from before the interrupted switch,
 * brings it back on old code at the next reboot instead of the new one.
 */
function bothRunning(state: DeployState, online: readonly string[]): DeployError {
  const head =
    `both game slots are running (${online.join(", ")}): a switch was interrupted, or one was started by hand. ` +
    "Check `bun run deploy status`. ";
  const live = state.game.activeSlot;
  const retiring = live !== null && online.includes(live) ? online.find((slot) => slot !== live) : undefined;
  if (retiring === undefined) {
    return new DeployError(
      `${head}state.json names neither as live, so the tool will not guess which to keep. ` +
        "Take the one that should not serve out of pm2 once it has no duel left — `pm2 stop <name>`, " +
        "`pm2 delete <name>`, then `pm2 save` — and run this again.",
    );
  }
  return new DeployError(
    `${head}state.json names ${live} as live. Once ${retiring} has no duel left, take it out of pm2: ` +
      `\`pm2 stop ${retiring}\`, \`pm2 delete ${retiring}\`, then \`pm2 save\` ` +
      "(stopped alone, it stays in pm2's table and pm2's saved list still brings it back on a reboot).",
  );
}

function pickSlots(ctx: Context, state: DeployState, processes: readonly Pm2Process[]): Slots {
  const slots = ctx.config.pm2.gameSlots;
  const online = slots.filter((slot) => isOnline(findProcess(processes, slot)));
  if (online.length === 2) throw bothRunning(state, online);
  const active = online[0] ?? null;
  if (active !== null && state.game.activeSlot !== null && active !== state.game.activeSlot) {
    ctx.host.out(`warning: state.json says ${state.game.activeSlot} is live, but pm2 runs ${active}; going by pm2`);
  }
  return { active, idle: otherSlot(ctx, active ?? state.game.activeSlot ?? slots[1]) };
}

function inspectLive(ctx: Context, slot: string): LiveSlot {
  const pid = servingPid(ctx, slot);
  if (pid !== null) return { name: slot, drainable: true, pid };
  const reason = unusableReason(ctx.host.readStatus(slotStatusFile(ctx.layout, slot)), ctx.host.clock.now());
  return { name: slot, drainable: false, reason: reason ?? "its status names a process that is gone" };
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

/**
 * Start `idle` on `sha` and wait for it to serve, steadily; on failure, stop
 * it and leave the box as it was. Null in a dry run, which starts nothing.
 */
async function startIdle(
  ctx: Context,
  state: DeployState,
  slots: Slots,
  sha: string,
  idleProcess: Pm2Process | undefined,
): Promise<NewSlot | null> {
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
    ctx.host.out(
      `would wait up to ${START_TIMEOUT_MS / 1000} s for ${idle} to report serving ${shortSha(sha)}, ` +
        `and ${STEADY_MS / 1000} s more for it to stay up`,
    );
    return null;
  }
  const { host } = ctx;
  const serving = await waitUntil(ctx, () => gameServing(host.readStatus(statusFile), sha, host.clock.now(), host.pidAlive), {
    timeoutMs: START_TIMEOUT_MS,
    intervalMs: START_POLL_MS,
  });
  const steady = serving ? await confirmSteady(ctx, idle, sha) : null;
  if (steady?.ok) {
    host.out(`${idle} serves ${shortSha(sha)} (pid ${steady.pid}, steady for ${STEADY_MS / 1000} s)`);
    return { name: idle, pid: steady.pid, sha };
  }
  const reading = host.readStatus(statusFile);
  const why =
    steady === null
      ? `did not report serving ${shortSha(sha)} within ${START_TIMEOUT_MS / 1000} s ` +
        `(${unusableReason(reading, host.clock.now()) ?? describeLast(gameOf(reading), sha)})`
      : `reported serving ${shortSha(sha)}, then did not stay up: ${steady.problem}`;
  await pm2Stop(ctx, idle);
  await pm2Delete(ctx, idle);
  writeEcosystem(ctx, assignmentsOf(state));
  throw new DeployError(
    `${idle} ${why}. It is stopped and out of pm2. ` +
      `Its output is in pm2's logs for ${idle} (~/.pm2/logs/${idle}-out.log and -error.log).`,
  );
}

/**
 * Drain `old` while watching the new slot, then stop `old` — but only once
 * the new slot still serves. `previous` is where `rollback game` would go.
 * `started` is null only in a dry run.
 */
async function retire(
  ctx: Context,
  previous: string | null,
  old: LiveSlot & { readonly drainable: true },
  started: NewSlot | null,
): Promise<void> {
  if (started === null) {
    await drain(ctx, old);
  } else {
    const problem = (await drain(ctx, old, () => newSlotGone(ctx, started))) ?? (await stillServing(ctx, started));
    if (problem !== null) throw newSlotLost(ctx, previous, old.name, started, problem);
  }
  await pm2Stop(ctx, old.name);
}

/**
 * The slot state.json names, when pm2 runs it and it serves `sha`: the switch
 * to `sha` happened already, or all of it but the old slot's removal and the
 * save. Null otherwise; a recorded slot that runs but does not serve `sha` is
 * said, and switched again.
 */
function recordedServing(ctx: Context, state: DeployState, processes: readonly Pm2Process[], sha: string): string | null {
  const slot = state.game.activeSlot;
  if (slot === null || state.game.release !== sha || !isOnline(findProcess(processes, slot))) return null;
  const serving = readServing(ctx, slot, sha);
  if (serving.ok) return slot;
  ctx.host.out(
    `warning: state.json records ${slot} on ${shortSha(sha)} and pm2 runs it, but it does not serve ${shortSha(sha)} ` +
      `(${serving.problem}); switching again`,
  );
  return null;
}

/** The old slot still runs beside the recorded one: a switch stopped mid-drain. Drain it to the usual limit, and stop it. */
async function finishDrain(ctx: Context, state: DeployState, live: string, other: string, sha: string): Promise<void> {
  const old = inspectLive(ctx, other);
  if (!old.drainable) throw bothRunning(state, [live, other]);
  ctx.host.out(
    `${other} still runs beside ${live}, which serves ${shortSha(sha)}: a switch was interrupted before ${other} ` +
      "had drained. Finishing it",
  );
  let started: NewSlot | null = null;
  if (!ctx.dryRun) {
    const steady = await confirmSteady(ctx, live, sha);
    if (!steady.ok) {
      throw new DeployError(
        `${live}, which state.json names, does not serve ${shortSha(sha)} steadily (${steady.problem}), so ${other} ` +
          "is not told to drain; neither slot was touched. Check `bun run deploy status`, and run this again.",
      );
    }
    started = { name: live, pid: steady.pid, sha };
  }
  await retire(ctx, state.game.previous, old, started);
}

/** Finish a switch to `sha` that state.json already records: take out what is left of the old slot, and save. */
async function finishRecorded(
  ctx: Context,
  state: DeployState,
  processes: readonly Pm2Process[],
  live: string,
  sha: string,
): Promise<void> {
  const other = otherSlot(ctx, live);
  const leftover = findProcess(processes, other);
  if (leftover !== undefined) {
    if (isOnline(leftover)) {
      await finishDrain(ctx, state, live, other, sha);
    } else {
      ctx.host.out(`${other} is still in pm2's table (${leftover.status}): a switch was interrupted after its drain; taking it out`);
    }
    await pm2Delete(ctx, other);
  }
  // The file and pm2's saved list may both still be the interrupted run's.
  writeEcosystem(ctx, assignmentsOf(state));
  await pm2Save(ctx);
  reportDone(
    ctx,
    leftover === undefined
      ? `game: ${live} already serves ${shortSha(sha)}; nothing to switch, pm2's list saved (--force switches anyway)`
      : `game: ${live} serves ${shortSha(sha)}; ${other} is out of pm2, and pm2's list saved`,
  );
}

/** A failed start, with what it means for the slot that was live. */
function startFailed(ctx: Context, error: unknown, live: LiveSlot | null): unknown {
  if (!(error instanceof DeployError) || live === null) return error;
  if (live.drainable) return new DeployError(`${error.message}\n${live.name} was not touched: it still serves the old release.`);
  return new DeployError(
    `${error.message}\nThe game is down: ${live.name} was stopped first (--allow-cold), and nothing serves port ` +
      `${ctx.config.gamePort} now. \`pm2 start ${live.name}\` brings the old process back; its pm2 entry was kept for this.`,
  );
}

function coldRefused(live: LiveSlot & { readonly drainable: false }): DeployError {
  return new DeployError(
    `${live.name} cannot be told to drain: ${live.reason} (code from before the status contract, or a hung process). ` +
      "Code from before the contract also holds the port alone, so the new slot cannot start beside it. " +
      "Re-run with --allow-cold to stop it first and then start the new slot: its duels end like a restart, " +
      "and the game is down until the new slot serves.",
  );
}

/** Stop a live slot that cannot drain, before the new one starts: it holds the port alone. */
async function stopCold(ctx: Context, live: LiveSlot & { readonly drainable: false }): Promise<void> {
  ctx.host.out(
    `warning: ${live.name}: ${live.reason}. Stopping it before the new slot starts, which ends its duels like a restart ` +
      "(--allow-cold); the game is down until the new slot serves",
  );
  await pm2Stop(ctx, live.name);
}

function describeLast(status: GameStatus | null, sha: string): string {
  if (status === null) return "no status";
  if (status.buildId !== sha) return `its status names build ${shortSha(status.buildId)}`;
  return `last state: ${status.state}`;
}

export async function switchGame(ctx: Context, sha: string, options: GameSwitchOptions): Promise<void> {
  requirePrepared(ctx, sha, options.assumePrepared);
  requireSharedFiles(ctx, ["daily"], "the game");
  const state = loadState(ctx);
  const processes = await pm2List(ctx);
  const recorded = options.force ? null : recordedServing(ctx, state, processes, sha);
  if (recorded !== null) return finishRecorded(ctx, state, processes, recorded, sha);
  const slots = pickSlots(ctx, state, processes);
  const { active, idle } = slots;
  const live = active === null ? null : inspectLive(ctx, active);
  if (live !== null && !live.drainable) {
    if (!options.allowCold) throw coldRefused(live);
    await stopCold(ctx, live);
  }
  let started: NewSlot | null;
  try {
    started = await startIdle(ctx, state, slots, sha, findProcess(processes, idle));
  } catch (error) {
    throw startFailed(ctx, error, live);
  }
  await probe(ctx, sha, live?.drainable ? "with both slots up" : "on the new slot");

  const next: DeployState = { ...state, game: { ...moved(state.game, sha), activeSlot: idle } };
  saveState(ctx, next);
  writeEcosystem(ctx, assignmentsOf(next));

  if (live !== null) {
    if (live.drainable) await retire(ctx, next.game.previous, live, started);
    await pm2Delete(ctx, live.name);
  }
  for (const leftover of ctx.config.pm2.gameSlots) {
    if (leftover !== idle && leftover !== active && findProcess(processes, leftover)) await pm2Delete(ctx, leftover);
  }
  await pm2Save(ctx);
  await probe(ctx, sha, "after the handover");
  reportDone(ctx, `game: ${idle} serves ${shortSha(sha)}${next.game.previous ? `; rollback goes to ${shortSha(next.game.previous)}` : ""}`);
}
