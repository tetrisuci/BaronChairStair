/**
 * One deploy at a time. Two runs at once would each think the other's
 * half-started slot was "both slots running", or delete the bot the other
 * just started. The lock is a file created exclusively, holding the pid that
 * took it; one left by a run that died is taken over, since its pid is gone.
 *
 * A dry run changes nothing, so it takes no lock.
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { DeployError } from "./errors";
import type { Context } from "./host";

function holder(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function tryCreate(path: string): boolean {
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function withLock<T>(ctx: Context, work: () => Promise<T>): Promise<T> {
  if (ctx.dryRun) return work();
  const path = ctx.layout.lock;
  mkdirSync(dirname(path), { recursive: true });
  if (!tryCreate(path)) {
    const pid = holder(path);
    if (pid !== null && ctx.host.pidAlive(pid)) {
      throw new DeployError(`another deploy (pid ${pid}) is running; wait for it, or check ${path}`);
    }
    ctx.host.out(`taking over a lock left by a deploy that is no longer running (${path})`);
    unlinkSync(path);
    if (!tryCreate(path)) throw new DeployError(`another deploy took ${path} just now`);
  }
  try {
    return await work();
  } finally {
    unlinkSync(path);
  }
}
