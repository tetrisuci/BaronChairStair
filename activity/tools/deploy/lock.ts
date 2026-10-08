/**
 * One deploy at a time. Two runs at once would each think the other's
 * half-started slot was "both slots running", or delete the bot the other
 * just started. The lock is a file created exclusively, holding the pid that
 * took it. An existing lock is never replaced automatically: two contenders
 * checking a dead holder could otherwise each remove the other's new lock.
 * After a run dies, the operator confirms that no deploy runs and removes its
 * lock by hand. Empty and malformed locks fail closed too.
 *
 * A dry run changes nothing, so it takes no lock.
 */

import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { DeployError } from "./errors";
import type { Context } from "./host";

function holder(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    const pid = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function existingLock(ctx: Context, path: string): DeployError {
  const pid = holder(path);
  if (pid !== null && ctx.host.pidAlive(pid)) {
    return new DeployError(`another deploy (pid ${pid}) is running; wait for it, or check ${path}`);
  }
  const reason = pid === null ? "is empty, malformed or unreadable" : `names pid ${pid}, which is no longer running`;
  return new DeployError(
    `deploy lock ${path} ${reason}. The tool never replaces a lock automatically. ` +
      "Confirm that no deploy is running (an empty lock may still be being written), remove this exact lock by hand, " +
      "then run again; tools/deploy/README.md, Lock recovery, has the checks.",
  );
}

/** Keep the original inode open until cleanup, and never remove a replacement. */
function releaseLock(ctx: Context, path: string, fd: number): void {
  try {
    const ours = fstatSync(fd);
    const current = lstatSync(path);
    if (ours.dev === current.dev && ours.ino === current.ino) unlinkSync(path);
    else ctx.host.out(`warning: ${path} was replaced while the deploy ran; its replacement was left alone`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      ctx.host.out(`warning: could not remove ${path}; check it by hand (${(error as Error).message})`);
    }
  } finally {
    closeSync(fd);
  }
}

export async function withLock<T>(ctx: Context, work: () => Promise<T>): Promise<T> {
  if (ctx.dryRun) return work();
  const path = ctx.layout.lock;
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw existingLock(ctx, path);
    throw error;
  }
  try {
    writeSync(fd, String(process.pid));
    return await work();
  } finally {
    releaseLock(ctx, path, fd);
  }
}
