/**
 * `switch site <sha>`: replace db.tetrisatuci.org's server outright.
 *
 * The site holds no sessions, sockets or tickets — only a dataset it rebuilds
 * from the database at boot — and it refuses to bind its port beside another
 * copy (reusePort off, on purpose). So there is no overlap to arrange: delete,
 * start, and wait for `/health` to say `ok: true`, at the cost of a second or
 * two of 502 while the first dataset builds.
 *
 * State is written once the old one is gone and before the new one starts:
 * from then on the new release is what pm2 is meant to run, and a start that
 * fails or a health wait that times out must still leave the way back
 * recorded for `rollback site`.
 */

import { ensureDirectory } from "./effects";
import { assignmentsOf, writeEcosystem } from "./ecosystem";
import { DeployError, withRollbackHint } from "./errors";
import { reportDone } from "./exec";
import type { Context } from "./host";
import { findProcess, isOnline, pm2Delete, pm2List, pm2Save, pm2Start } from "./pm2";
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

function healthy(body: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

async function waitForHealth(ctx: Context): Promise<boolean> {
  const url = `http://127.0.0.1:${ctx.config.sitePort}/health`;
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

export async function switchSite(ctx: Context, sha: string, options: SiteSwitchOptions): Promise<void> {
  requirePrepared(ctx, sha, options.assumePrepared);
  requireSharedFiles(ctx, ["daily", "puzzledbEnv"], "the site");
  const { host } = ctx;
  const name = ctx.config.pm2.site;
  const state = loadState(ctx);
  const current = findProcess(await pm2List(ctx), name);
  if (!options.force && state.site.release === sha && isOnline(current)) {
    host.out(`site: ${name} already runs ${shortSha(sha)}; nothing to do (--force restarts it anyway)`);
    return;
  }

  const next: DeployState = { ...state, site: moved(state.site, sha) };
  if (current) await pm2Delete(ctx, name);
  ensureDirectory(ctx, ctx.layout.run);
  writeEcosystem(ctx, assignmentsOf(next));
  saveState(ctx, next);
  try {
    await pm2Start(ctx, name);
  } catch (error) {
    throw withRollbackHint(error, "site");
  }
  if (!(await waitForHealth(ctx))) {
    const timedOut = new DeployError(
      `${name} on ${shortSha(sha)} did not answer /health with ok:true within ${HEALTH_TIMEOUT_MS / 1000} s. ` +
        `It is left running so \`pm2 logs ${name}\` shows why.`,
    );
    throw withRollbackHint(timedOut, "site");
  }
  await pm2Save(ctx);
  reportDone(ctx, `site: ${name} serves ${shortSha(sha)}`);
}
