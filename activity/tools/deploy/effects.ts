/**
 * The deploy's own writes under its home — state, the ecosystem file, links,
 * markers — each gated by the dry run the same way `exec` gates a command.
 *
 * Whole files are written to a temporary name and renamed into place, so a
 * reader (pm2 loading the ecosystem, the next run reading state.json) sees the
 * old file or the new one, never half of either.
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DeployError } from "./errors";
import type { Context } from "./host";

export function writeFileAtomic(ctx: Context, path: string, text: string): void {
  if (ctx.dryRun) {
    ctx.host.out(`would write ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

export function ensureDirectory(ctx: Context, path: string): void {
  if (existsSync(path)) return;
  if (ctx.dryRun) {
    ctx.host.out(`would create ${path}/`);
    return;
  }
  mkdirSync(path, { recursive: true });
}

/** Remove a file if it is there. A symlink is removed itself, never what it points at. */
export function removeFile(ctx: Context, path: string): void {
  if (!isThere(path)) return;
  if (ctx.dryRun) {
    ctx.host.out(`would remove ${path}`);
    return;
  }
  unlinkSync(path);
}

function isThere(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Point `path` at `target`. Already pointing there: nothing to do. Anything
 * else in the way — a real file, a link elsewhere — is refused rather than
 * replaced: it is somebody's data, or a sign the release is not what we think.
 */
export function linkFile(ctx: Context, target: string, path: string): void {
  if (isThere(path)) {
    if (lstatSync(path).isSymbolicLink() && readlinkSync(path) === target) return;
    throw new DeployError(`${path} is already there and is not a link to ${target}; move it aside and prepare again`);
  }
  if (ctx.dryRun) {
    ctx.host.out(`would link ${path} -> ${target}`);
    return;
  }
  symlinkSync(target, path);
}

/** Remove `path` only if it is a symlink: used to take shared links out of a release. */
export function unlinkIfLink(ctx: Context, path: string): void {
  if (!isThere(path) || !lstatSync(path).isSymbolicLink()) return;
  removeFile(ctx, path);
}
