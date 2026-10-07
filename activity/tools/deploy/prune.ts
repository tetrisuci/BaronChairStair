/**
 * `prune [--keep N]`: remove old release worktrees.
 *
 * Kept, always: the newest N; every release state.json names, current or
 * previous (the way back must still be there to go back to); every release a
 * pm2 app runs from — the bot keeps its directory when a deploy records a new
 * release without restarting it; and the release this tool is running from.
 *
 * Removed through `git worktree remove` so the repository's list stays true,
 * oldest first, after the links into shared/ are taken out — so nothing that
 * walks the tree can reach the env files or the solutions through them.
 */

import { join } from "node:path";
import { unlinkIfLink } from "./effects";
import { DeployError } from "./errors";
import { exec, outputTail } from "./exec";
import type { Context } from "./host";
import { pm2List } from "./pm2";
import { listReleases, shortSha, type ReleaseEntry } from "./release";
import { loadState, type DeployState } from "./state";

/** The links prepare made into shared/, relative to a release. */
const SHARED_LINKS = [".env", "activity/.env", "activity/data/solutions.json"];

function within(path: string | null, dir: string): boolean {
  return path !== null && (path === dir || path.startsWith(`${dir}/`));
}

function namedByState(state: DeployState): ReadonlySet<string> {
  const shas = [state.game, state.site, state.bot].flatMap((record) => [record.release, record.previous]);
  return new Set(shas.filter((sha): sha is string => sha !== null));
}

async function removeRelease(ctx: Context, release: ReleaseEntry): Promise<string | null> {
  for (const link of SHARED_LINKS) unlinkIfLink(ctx, join(release.dir, link));
  const result = await exec(ctx, {
    argv: ["git", "-C", ctx.layout.repo, "worktree", "remove", "--force", release.dir],
    mutates: true,
  });
  if (result.code !== 0) return `${release.dir}: ${outputTail(result)}`;
  if (!ctx.dryRun) ctx.host.out(`removed ${shortSha(release.sha)} (${release.dir})`);
  return null;
}

export async function prune(ctx: Context, keep: number): Promise<void> {
  const state = loadState(ctx);
  const processes = await pm2List(ctx);
  const releases = listReleases(ctx.layout);
  const named = namedByState(state);
  const newest = new Set(releases.slice(0, keep).map((release) => release.sha));
  const inUse = (release: ReleaseEntry) =>
    processes.some((process) => within(process.cwd, release.dir)) || within(ctx.selfRelease, release.dir);
  const doomed = releases
    .filter((release) => !newest.has(release.sha) && !named.has(release.sha) && !inUse(release))
    .reverse();

  if (doomed.length === 0) {
    ctx.host.out(`nothing to prune: ${releases.length} release(s), all kept`);
    return;
  }
  const failures: string[] = [];
  for (const release of doomed) {
    const failure = await removeRelease(ctx, release);
    if (failure !== null) failures.push(failure);
  }
  await exec(ctx, { argv: ["git", "-C", ctx.layout.repo, "worktree", "prune"], mutates: true });
  if (failures.length > 0) throw new DeployError(`could not remove:\n${failures.join("\n")}`);
}
