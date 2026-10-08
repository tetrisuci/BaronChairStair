/**
 * One deploy at a time. Two runs at once would each think the other's
 * half-started slot was "both slots running", or delete the bot the other
 * just started. The lock is a file created exclusively, holding the pid that
 * took it. An existing lock is never replaced automatically: two contenders
 * checking a dead holder could otherwise each remove the other's new lock.
 * SIGINT and SIGTERM release this run's own lock before exiting, and report
 * the saved switch state so the operator can finish it. An unhandled exit
 * still needs manual recovery. Empty and malformed locks fail closed too.
 *
 * A dry run changes nothing, so it takes no lock.
 */

import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { DeployError } from "./errors";
import type { Context } from "./host";
import { loadState } from "./state";

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
  let released = false;
  const cleanup = () => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    if (!released) {
      released = true;
      releaseLock(ctx, path, fd);
    }
  };
  let interrupting = false;
  const interrupted = async (signal: "SIGINT" | "SIGTERM") => {
    if (interrupting) return;
    interrupting = true;
    try {
      // A pm2, git or build command may already be changing something. Keep
      // the lock until it finishes; the host holds its caller and accepts no
      // more commands, so the switch cannot resume beneath this handler.
      if (ctx.host.interrupt) {
        ctx.host.out(`deploy: ${signal} requested; waiting for any active command before releasing the lock`);
        await ctx.host.interrupt();
      }
      ctx.host.out(`deploy: interrupted by ${signal}. Last saved switch state: ${ctx.layout.state}`);
      try {
        const state = loadState(ctx);
        ctx.host.out(
          `game: ${state.game.release ?? "not switched"} (slot ${state.game.activeSlot ?? "none"}); ` +
          `site: ${state.site.release ?? "not switched"}; bot: ${state.bot.release ?? "not switched"}`,
        );
      } catch {
        ctx.host.out("The saved state could not be read; keep it and check it before continuing.");
      }
      ctx.host.out(
        "Run bun run deploy status, then the same command to finish the interrupted switch. " +
        "Keep state.json; tools/deploy/README.md, If a switch is interrupted, explains recovery.",
      );
    } finally {
      // Releasing and returning to the pending work would allow two deploys
      // to mutate the same apps. Exit synchronously: the old work never resumes.
      cleanup();
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
  };
  const onInterrupt = () => { void interrupted("SIGINT"); };
  const onTerminate = () => { void interrupted("SIGTERM"); };
  try {
    writeSync(fd, String(process.pid));
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    return await work();
  } finally {
    cleanup();
  }
}
