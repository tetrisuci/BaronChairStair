/**
 * Releases: a directory per commit, and the marker that says it passed.
 *
 * The marker is the only thing a switch trusts. A directory without one is a
 * release whose checks failed or never finished — its dependencies may be
 * half installed, its build half written — and nothing switches to it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DeployError } from "./errors";
import { exec, execOk } from "./exec";
import type { Context } from "./host";
import { releaseDir, type Layout } from "./layout";

/** Written in a release's root once every check passed. */
export const MARKER_FILE = ".bcs-prepared";

const FULL_SHA = /^[0-9a-f]{40}$/;
const PARTIAL_SHA = /^[0-9a-f]{7,40}$/;
const SHORT_LENGTH = 7;

export interface Marker {
  readonly sha: string;
  readonly preparedAt: string;
  readonly checks: readonly string[];
}

export function shortSha(sha: string | null): string {
  return sha === null ? "?" : sha.slice(0, SHORT_LENGTH);
}

export function readMarker(layout: Layout, sha: string): Marker | null {
  const path = join(releaseDir(layout, sha), MARKER_FILE);
  if (!existsSync(path)) return null;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8")) as Marker;
    return marker.sha === sha ? marker : null;
  } catch {
    return null;
  }
}

export function isPrepared(layout: Layout, sha: string): boolean {
  return readMarker(layout, sha) !== null;
}

/**
 * Refuse a release that did not pass prepare. `assumePrepared` is for a dry
 * run of a whole deploy, whose prepare step printed its plan but built nothing.
 */
export function requirePrepared(ctx: Context, sha: string, assumePrepared = false): void {
  if (isPrepared(ctx.layout, sha)) return;
  if (assumePrepared && ctx.dryRun) {
    ctx.host.out(`(dry run: ${shortSha(sha)} is not prepared yet; the real run prepares it first)`);
    return;
  }
  throw new DeployError(`release ${shortSha(sha)} is not prepared: run \`bun run deploy prepare ${sha}\` first`);
}

/**
 * A ref as a full commit, from the repository's last fetch. A branch name
 * means the remote's branch — the clone's own branches are never moved — so
 * `main` is tried as `origin/main` first.
 */
export async function resolveRef(ctx: Context, ref: string): Promise<string> {
  const candidates = PARTIAL_SHA.test(ref) ? [ref] : [`refs/remotes/origin/${ref}`, ref];
  for (const candidate of candidates) {
    const result = await exec(ctx, {
      argv: ["git", "-C", ctx.layout.repo, "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
      mutates: false,
    });
    const sha = result.stdout.trim();
    if (result.code === 0 && FULL_SHA.test(sha)) return sha;
  }
  throw new DeployError(`cannot resolve "${ref}" to a commit in ${ctx.layout.repo} (fetched?)`);
}

/** The files `git diff --name-only` says differ between two releases. */
export async function changedFiles(ctx: Context, from: string, to: string): Promise<readonly string[]> {
  const result = await execOk(
    ctx,
    { argv: ["git", "-C", ctx.layout.repo, "diff", "--name-only", from, to], mutates: false },
    `git diff ${shortSha(from)} ${shortSha(to)}`,
  );
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

export interface ReleaseEntry {
  readonly sha: string;
  readonly dir: string;
  /** Epoch ms: when it was prepared, or the directory's mtime if it never was. */
  readonly madeAt: number;
}

/** Every release directory, newest first. Anything not named like a commit is ignored. */
export function listReleases(layout: Layout): readonly ReleaseEntry[] {
  if (!existsSync(layout.releases)) return [];
  return readdirSync(layout.releases)
    .filter((name) => FULL_SHA.test(name) && statSync(join(layout.releases, name)).isDirectory())
    .map((sha) => {
      const dir = releaseDir(layout, sha);
      const marker = readMarker(layout, sha);
      const prepared = marker ? Date.parse(marker.preparedAt) : Number.NaN;
      return { sha, dir, madeAt: Number.isFinite(prepared) ? prepared : statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.madeAt - a.madeAt);
}
