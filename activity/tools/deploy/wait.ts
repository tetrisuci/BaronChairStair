/**
 * Polling with a deadline, on the host's clock — so a twenty-minute drain is
 * twenty minutes on the box and an instant in a test.
 */

import type { Context } from "./host";

export interface WaitOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
  /** Called this often while still waiting, with how long it has been. */
  readonly progressEveryMs?: number;
  readonly onProgress?: (elapsedMs: number) => void;
}

/**
 * Check until `done` answers true or the time runs out. True if it was done.
 * The check runs once more at the deadline, so a condition met in the last
 * interval is not reported as a timeout.
 */
export async function waitUntil(
  ctx: Context,
  done: () => boolean | Promise<boolean>,
  options: WaitOptions,
): Promise<boolean> {
  const { clock } = ctx.host;
  const started = clock.now();
  let lastProgress = started;
  for (;;) {
    if (await done()) return true;
    const elapsed = clock.now() - started;
    if (elapsed >= options.timeoutMs) return false;
    if (options.onProgress && options.progressEveryMs !== undefined && clock.now() - lastProgress >= options.progressEveryMs) {
      lastProgress = clock.now();
      options.onProgress(elapsed);
    }
    await clock.sleep(Math.min(options.intervalMs, options.timeoutMs - elapsed));
  }
}

/** "45 s", "14 min", "2 h 5 min": how long, said the way an operator reads it. */
export function describeDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
