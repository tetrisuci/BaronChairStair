/**
 * `prune [--keep N]`: remove old release worktrees.
 *
 * Kept, always: the newest N; every release state.json names, current or
 * previous (the way back must still be there to go back to); every release a
 * pm2 app runs from — the bot keeps its directory when a deploy records a new
 * release without restarting it; and the release this tool is running from.
 *
 * Removed through `git worktree remove` so the repository's list stays true,
 * oldest first. git takes the links into shared/ out with the rest of the
 * tree, and removes a link, never what it points at (checked);
 * the marker beside the release goes only once git has removed it.
 *
 * A removal git refuses — a locked worktree, git's own way of keeping one —
 * deletes nothing, so the release is left whole: links, marker and all, still
 * one a switch can use. Taking the links out first, as this once did, left a
 * marker vouching for a release with no `.env`, and a bot switched to it
 * started with no token. A removal git gives up on part-way is different: git
 * deletes the worktree's records whatever happened to its files, so it no
 * longer lists it, and what is left is no release. Its marker goes, so
 * nothing switches to it.
 */

import { existsSync, realpathSync } from "node:fs";
import { removeFile } from "./effects";
import { DeployError } from "./errors";
import { exec, outputTail } from "./exec";
import type { Context } from "./host";
import { pm2List } from "./pm2";
import { listReleases, markerPath, shortSha, type ReleaseEntry } from "./release";
import { loadState, type DeployState } from "./state";

function within(path: string | null, dir: string): boolean {
  return path !== null && (path === dir || path.startsWith(`${dir}/`));
}

function namedByState(state: DeployState): ReadonlySet<string> {
  const shas = [state.game, state.site, state.bot].flatMap((record) => [record.release, record.previous]);
  return new Set(shas.filter((sha): sha is string => sha !== null));
}

/** Whether git still lists `dir` as one of the repository's worktrees. */
async function listedByGit(ctx: Context, dir: string): Promise<boolean> {
  const result = await exec(ctx, { argv: ["git", "-C", ctx.layout.repo, "worktree", "list", "--porcelain"], mutates: false });
  if (result.code !== 0) return false;
  const names = new Set([dir, existsSync(dir) ? realpathSync(dir) : dir].map((path) => `worktree ${path}`));
  return result.stdout.split("\n").some((line) => names.has(line.trim()));
}

async function removeRelease(ctx: Context, release: ReleaseEntry): Promise<string | null> {
  const marker = markerPath(ctx.layout, release.sha);
  const result = await exec(ctx, {
    argv: ["git", "-C", ctx.layout.repo, "worktree", "remove", "--force", release.dir],
    mutates: true,
  });
  if (result.code === 0) {
    removeFile(ctx, marker);
    if (!ctx.dryRun) ctx.host.out(`removed ${shortSha(release.sha)} (${release.dir})`);
    return null;
  }
  const failure = `${release.dir}: ${outputTail(result)}`;
  if (await listedByGit(ctx, release.dir)) {
    return `${failure}\n  git deleted nothing: the release is as it was, links and marker, and can still be switched to.`;
  }
  removeFile(ctx, marker);
  return (
    `${failure}\n  git gave up part-way and no longer lists it, so what is left is not a release: its marker is ` +
    "removed, and nothing switches to it. Look at why, then remove the directory by hand (its links into " +
    "shared/ are links: removing them leaves shared/ as it is)."
  );
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
