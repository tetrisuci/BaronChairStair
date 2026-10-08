/**
 * `switch site <sha>`: replace db.tetrisatuci.org's server outright.
 *
 * The site holds no sessions, sockets or tickets — only a dataset it rebuilds
 * from the database at boot — and it refuses to bind its port beside another
 * copy (reusePort off, on purpose). So there is no overlap to arrange: delete,
 * start, and wait for `/health` to say `ok: true`, at the cost of a second or
 * two of 502 while the first dataset builds.
 *
 * An ok from `/health` proves only that *something* answers the port: the
 * site's `/health` carries no build id (publishing the commit is the owner's
 * call, not this tool's). A second site on the port — one started by hand, or
 * the old one under another name when `pm2.site` names the wrong app —
 * answers it just as well while the new one dies with EADDRINUSE; the
 * rehearsal saw exactly that reported as done. So the switch makes sure from
 * both sides:
 *
 * - before the start, once the old site is gone, nothing may answer the port;
 * - after `/health` says ok, pm2 must show the new app online on a live pid,
 *   and the same pid a few seconds later. A process that exited, or that pm2
 *   is restarting in a loop, changes its status or its pid.
 *
 * The first is the one that does not depend on timing: the site builds its
 * dataset before it binds, so on a large database it can die later than the
 * second check's window.
 *
 * State is written once the old one is gone and before the new one starts:
 * from then on the new release is what pm2 is meant to run, and a start that
 * fails, a health wait that times out or a pm2 check that fails must still
 * leave the way back recorded for `rollback site`. `pm2 save` runs only once
 * all of it passed.
 */

import { ensureDirectory } from "./effects";
import { assignmentsOf, writeEcosystem } from "./ecosystem";
import { DeployError, withRollbackHint } from "./errors";
import { reportDone } from "./exec";
import type { Context } from "./host";
import { findProcess, isOnline, pm2Delete, pm2List, pm2Save, pm2Start, type Pm2Process } from "./pm2";
import { requirePrepared, shortSha } from "./release";
import { requireSharedFiles } from "./shared-files";
import { loadState, moved, saveState, type DeployState } from "./state";
import { waitUntil } from "./wait";

export interface SiteSwitchOptions {
  readonly force: boolean;
  readonly assumePrepared?: boolean;
}

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 1_000;
/** How long the port may take to fall silent once the old site is deleted. */
const PORT_FREE_TIMEOUT_MS = 10_000;
/** How long the new site must stay online on one pid after `/health` first says ok. */
const STEADY_MS = 5_000;

type Running = { readonly ok: true; readonly pid: number } | { readonly ok: false; readonly problem: string };

function healthUrl(ctx: Context): string {
  return `http://127.0.0.1:${ctx.config.sitePort}/health`;
}

function healthy(body: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/** How an operator finds what holds the site's port: the tool cannot tell. */
function howToFindListener(ctx: Context): string {
  const port = ctx.config.sitePort;
  return (
    `Find what listens on port ${port} with \`ss -ltnp 'sport = :${port}'\` (Linux) or ` +
    `\`lsof -nP -iTCP:${port} -sTCP:LISTEN\` (macOS). If \`pm2 ls\` lists that pid, stop that app by its name; ` +
    "otherwise end the process by its exact pid, never with pkill."
  );
}

/** Nothing may answer the port once the old site is gone: whatever does is not the site this tool runs. */
async function requirePortFree(ctx: Context, deletedOld: boolean): Promise<void> {
  const name = ctx.config.pm2.site;
  const url = healthUrl(ctx);
  if (ctx.dryRun) {
    ctx.host.out(`would check that nothing answers ${url} before ${name} starts`);
    return;
  }
  const free = await waitUntil(ctx, async () => (await ctx.host.probe(url)) === null, {
    timeoutMs: PORT_FREE_TIMEOUT_MS,
    intervalMs: HEALTH_POLL_MS,
  });
  if (free) return;
  const where = deletedOld ? `after \`pm2 delete ${name}\`` : `though pm2 runs no ${name}`;
  throw new DeployError(
    `something still answers ${url} ${where}, so it is not ${name}: perhaps a site started by hand, or the old one ` +
      `under another pm2 name. The new ${name} would fail to bind the port (EADDRINUSE) while that answers /health ` +
      `in its place. ${howToFindListener(ctx)} Then run this again: nothing was started, and state.json is unchanged.`,
  );
}

async function waitForHealth(ctx: Context): Promise<boolean> {
  const url = healthUrl(ctx);
  if (ctx.dryRun) {
    ctx.host.out(`would wait up to ${HEALTH_TIMEOUT_MS / 1000} s for ${url} to answer ok`);
    return true;
  }
  return waitUntil(
    ctx,
    async () => {
      const reply = await ctx.host.probe(url);
      return reply !== null && reply.status === 200 && healthy(reply.body);
    },
    { timeoutMs: HEALTH_TIMEOUT_MS, intervalMs: HEALTH_POLL_MS },
  );
}

/** Whether pm2 runs the site: online, with a pid, and that pid alive. */
async function siteRunning(ctx: Context): Promise<Running> {
  const process: Pm2Process | undefined = findProcess(await pm2List(ctx), ctx.config.pm2.site);
  if (process === undefined) return { ok: false, problem: "pm2 has no such app" };
  if (process.status !== "online") return { ok: false, problem: `pm2 shows it ${process.status}` };
  if (process.pid <= 0) return { ok: false, problem: "pm2 shows it online with no pid" };
  if (!ctx.host.pidAlive(process.pid)) return { ok: false, problem: `pm2 shows it online as pid ${process.pid}, which is not alive` };
  return { ok: true, pid: process.pid };
}

function notTheSite(ctx: Context, sha: string, finding: string): DeployError {
  const name = ctx.config.pm2.site;
  return new DeployError(
    `${name} on ${shortSha(sha)} is not running steadily: ${finding}. Something answered ${healthUrl(ctx)} ` +
      `with ok:true, and the tool cannot tell what: most likely another site holding the port while ${name} ` +
      `fails to bind it (look for EADDRINUSE in \`pm2 logs ${name}\`). ${howToFindListener(ctx)} ` +
      `${name} is left in pm2 for its logs, pm2's saved list was not updated, and state.json keeps the way back.`,
  );
}

/** The new site's pid, once pm2 shows it online on that pid now and `STEADY_MS` later. */
async function confirmSteady(ctx: Context, sha: string): Promise<number | null> {
  if (ctx.dryRun) {
    ctx.host.out(`would confirm through pm2 that ${ctx.config.pm2.site} is online and keeps one pid for ${STEADY_MS / 1000} s`);
    return null;
  }
  const first = await siteRunning(ctx);
  if (!first.ok) throw notTheSite(ctx, sha, `${first.problem}, right after /health answered ok`);
  await ctx.host.clock.sleep(STEADY_MS);
  const later = await siteRunning(ctx);
  const after = `${STEADY_MS / 1000} s after /health answered ok`;
  if (!later.ok) throw notTheSite(ctx, sha, `${later.problem}, ${after}`);
  if (later.pid !== first.pid) throw notTheSite(ctx, sha, `pm2 restarted it: pid ${first.pid} became pid ${later.pid}, ${after}`);
  return first.pid;
}

export async function switchSite(ctx: Context, sha: string, options: SiteSwitchOptions): Promise<void> {
  requirePrepared(ctx, sha, options.assumePrepared);
  requireSharedFiles(ctx, ["daily", "puzzledbEnv"], "the site");
  const { host } = ctx;
  const name = ctx.config.pm2.site;
  const state = loadState(ctx);
  const current = findProcess(await pm2List(ctx), name);
  if (!options.force && state.site.release === sha && isOnline(current)) {
    host.out(`site: ${name} already runs ${shortSha(sha)}; nothing to do (--force restarts it anyway)`);
    // Saved anyway, as the game's re-run does: a switch interrupted between its
    // start and its save left pm2's list on the release before.
    await pm2Save(ctx);
    return;
  }

  const next: DeployState = { ...state, site: moved(state.site, sha) };
  if (current) await pm2Delete(ctx, name);
  await requirePortFree(ctx, current !== undefined);
  ensureDirectory(ctx, ctx.layout.run);
  writeEcosystem(ctx, assignmentsOf(next));
  saveState(ctx, next);
  let pid: number | null;
  try {
    await pm2Start(ctx, name);
    if (!(await waitForHealth(ctx))) {
      throw new DeployError(
        `${name} on ${shortSha(sha)} did not answer /health with ok:true within ${HEALTH_TIMEOUT_MS / 1000} s. ` +
          `It is left running so \`pm2 logs ${name}\` shows why.`,
      );
    }
    pid = await confirmSteady(ctx, sha);
  } catch (error) {
    throw withRollbackHint(error, "site");
  }
  await pm2Save(ctx);
  const steady = pid === null ? "" : ` (pid ${pid}, online and unchanged for ${STEADY_MS / 1000} s)`;
  reportDone(ctx, `site: ${name} serves ${shortSha(sha)}${steady}`);
}
