/**
 * `switch bot <sha>`: the one app that cannot overlap. Discord delivers a
 * command to every connection on the token, so two copies answer everything
 * twice; the switch is a stop and a start, with a few seconds between.
 *
 * So it happens only when it has to, and when it costs least:
 *
 * - **Only if the bot changed.** If no file matching `botFiles` differs
 *   between the release the bot runs and the new one, the new release is
 *   recorded and the bot keeps running. (Its process keeps its own directory;
 *   `prune` never removes a release a pm2 app runs from.)
 * - **Only when quiet**: ready, nothing in flight, no `/archive sync` running,
 *   and nothing handled for `botQuietSeconds`. `--now` skips the wait.
 * - **Never two copies.** pm2 deletes the old process, the deploy checks its
 *   pid is gone, and only then starts the new one.
 *
 * State is written once the old bot is gone and before the new one starts, so
 * a start that fails or a bot that never reports ready still leaves the way
 * back recorded for `rollback bot`.
 */

import { isFresh } from "../../shared/runtime-status";
import { ensureDirectory, removeFile } from "./effects";
import { assignmentsOf, writeEcosystem } from "./ecosystem";
import { DeployError, withRollbackHint } from "./errors";
import { reportDone } from "./exec";
import type { Context } from "./host";
import { botStatusFile } from "./layout";
import { findProcess, isOnline, pm2Delete, pm2List, pm2Save, pm2Start, type Pm2Process } from "./pm2";
import { botOf, botQuiet, botReady, describeBotActivity, unusableReason } from "./readiness";
import { changedFiles, requirePrepared, shortSha } from "./release";
import { requireSharedFiles } from "./shared-files";
import { loadState, moved, saveState, type DeployState } from "./state";
import { waitUntil } from "./wait";

export interface BotSwitchOptions {
  /** Restart even if no bot file changed, or the release is already recorded. */
  readonly force: boolean;
  /** Restart without waiting for quiet. */
  readonly now: boolean;
  readonly assumePrepared?: boolean;
}

const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 1_000;
const QUIET_POLL_MS = 5_000;
const OLD_EXIT_TIMEOUT_MS = 60_000;
const PROGRESS_EVERY_MS = 30_000;
const MINUTE_MS = 60_000;
/** How many changed bot files to name before "and N more". */
const LISTED_CHANGES = 8;

/** The files between two releases that mean the bot changed. */
export async function botFilesChanged(ctx: Context, from: string, to: string): Promise<readonly string[]> {
  const globs = ctx.config.botFiles.map((pattern) => new Bun.Glob(pattern));
  const files = await changedFiles(ctx, from, to);
  return files.filter((file) => globs.some((glob) => glob.match(file)));
}

function describeChanges(files: readonly string[]): string {
  const named = files.slice(0, LISTED_CHANGES).join(", ");
  return files.length > LISTED_CHANGES ? `${named} and ${files.length - LISTED_CHANGES} more` : named;
}

/** Wait for a quiet moment; false if the limit passed first. */
async function waitForQuiet(ctx: Context): Promise<boolean> {
  const { host, config } = ctx;
  const file = botStatusFile(ctx.layout);
  if (!host.readStatus(file).present) {
    throw new DeployError(
      `${config.pm2.bot} writes no status file (code from before the status contract?), so there is no telling ` +
        "whether anybody is mid-command. Re-run with --now to restart it anyway.",
    );
  }
  if (ctx.dryRun) {
    host.out(`would wait up to ${config.botQuietLimitMinutes} min for ${config.pm2.bot} to be quiet`);
    return true;
  }
  const quiet = () => botQuiet(botOf(host.readStatus(file)), host.clock.now(), config.botQuietSeconds);
  return waitUntil(ctx, quiet, {
    timeoutMs: config.botQuietLimitMinutes * MINUTE_MS,
    intervalMs: QUIET_POLL_MS,
    progressEveryMs: PROGRESS_EVERY_MS,
    onProgress: () => {
      const reading = host.readStatus(file);
      const status = botOf(reading);
      const detail = unusableReason(reading, host.clock.now()) ?? (status ? describeBotActivity(status, host.clock.now()) : "?");
      host.out(`waiting for ${config.pm2.bot} to be quiet: ${detail}`);
    },
  });
}

/** Delete the old bot and make sure it is gone: a second copy must never start beside it. */
async function removeOldBot(ctx: Context, current: Pm2Process | undefined): Promise<void> {
  if (!current) return;
  const { host } = ctx;
  // A stale status's pid may belong to some other process by now: only a fresh one is the bot's.
  const status = botOf(host.readStatus(botStatusFile(ctx.layout)));
  const statusPid = status !== null && isFresh(status, host.clock.now()) ? status.pid : undefined;
  const pids = [current.pid, statusPid].filter((pid): pid is number => pid !== undefined && pid > 0);
  await pm2Delete(ctx, current.name);
  if (ctx.dryRun) return;
  const gone = await waitUntil(ctx, () => pids.every((pid) => !host.pidAlive(pid)), {
    timeoutMs: OLD_EXIT_TIMEOUT_MS,
    intervalMs: READY_POLL_MS,
  });
  if (!gone) {
    const alive = pids.filter((pid) => host.pidAlive(pid)).join(", ");
    throw new DeployError(
      `the old bot (pid ${alive}) is still alive after pm2 delete; not starting a second copy beside it. ` +
        "Find it by its exact pid, end it, then run this again.",
    );
  }
}

async function waitForReady(ctx: Context, sha: string): Promise<boolean> {
  const { host } = ctx;
  if (ctx.dryRun) {
    host.out(`would wait up to ${READY_TIMEOUT_MS / 1000} s for ${ctx.config.pm2.bot} to report ready on ${shortSha(sha)}`);
    return true;
  }
  const file = botStatusFile(ctx.layout);
  return waitUntil(ctx, () => botReady(host.readStatus(file), sha, host.clock.now(), host.pidAlive), {
    timeoutMs: READY_TIMEOUT_MS,
    intervalMs: READY_POLL_MS,
  });
}

/** Whether the switch can be just a note in state.json: same bot files, bot running. */
async function unchanged(ctx: Context, state: DeployState, sha: string, running: boolean, force: boolean): Promise<boolean> {
  const from = state.bot.release;
  if (force || from === null || !running) return false;
  if (from === sha) {
    ctx.host.out(`bot: ${ctx.config.pm2.bot} already runs ${shortSha(sha)}; nothing to do (--force restarts it anyway)`);
    return true;
  }
  const changed = await botFilesChanged(ctx, from, sha);
  if (changed.length > 0) {
    ctx.host.out(`bot files changed since ${shortSha(from)}: ${describeChanges(changed)}`);
    return false;
  }
  const next: DeployState = { ...state, bot: moved(state.bot, sha) };
  saveState(ctx, next);
  writeEcosystem(ctx, assignmentsOf(next));
  reportDone(ctx, `bot: no bot file differs between ${shortSha(from)} and ${shortSha(sha)}; recorded ${shortSha(sha)} without restarting`);
  return true;
}

export async function switchBot(ctx: Context, sha: string, options: BotSwitchOptions): Promise<void> {
  requirePrepared(ctx, sha, options.assumePrepared);
  requireSharedFiles(ctx, ["stats", "daily"], "the bot");
  const { config } = ctx;
  const name = config.pm2.bot;
  const state = loadState(ctx);
  const current = findProcess(await pm2List(ctx), name);
  const running = isOnline(current);
  if (await unchanged(ctx, state, sha, running, options.force)) return;

  if (running && !options.now && !(await waitForQuiet(ctx))) {
    throw new DeployError(
      `${name} was not quiet within ${config.botQuietLimitMinutes} min; nothing was restarted. ` +
        "Try again later, or pass --now to restart it regardless.",
    );
  }
  await removeOldBot(ctx, current);

  const next: DeployState = { ...state, bot: moved(state.bot, sha) };
  removeFile(ctx, botStatusFile(ctx.layout));
  ensureDirectory(ctx, ctx.layout.run);
  writeEcosystem(ctx, assignmentsOf(next));
  saveState(ctx, next);
  try {
    await pm2Start(ctx, name);
  } catch (error) {
    throw withRollbackHint(error, "bot");
  }
  if (!(await waitForReady(ctx, sha))) {
    const timedOut = new DeployError(
      `${name} on ${shortSha(sha)} did not report ready within ${READY_TIMEOUT_MS / 1000} s. ` +
        `It is left running so \`pm2 logs ${name}\` shows why.`,
    );
    throw withRollbackHint(timedOut, "bot");
  }
  await pm2Save(ctx);
  reportDone(ctx, `bot: ${name} runs ${shortSha(sha)}`);
}
