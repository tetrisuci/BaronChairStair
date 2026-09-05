/**
 * The hand-turned clock and frame loop the run-driving suites share.
 *
 * A run advances on animation frames, which do not exist headlessly — so the
 * suites install a clock they control and pump the run's own loop by hand.
 * One copy: every suite that drives a run imports this instead of mocking
 * the globals itself.
 */

export const FRAME_MS = 1000 / 60;
/** Enough frames for anything grounded to lock, and then some. */
export const PATIENCE = 300;
/**
 * The engine swallows a hard drop for a few frames after a piece locks, so a
 * key still down at the lock cannot slam the next piece. A real player's next
 * press lands after that window — and so do the suites that pump these frames
 * before reading the board or handing the log to the verifier.
 */
export const SAFE_LOCK_FRAMES = 8;

let clock = 0;
let scheduled: FrameRequestCallback | null = null;

const realPerformance = globalThis.performance;

function install(): void {
  globalThis.performance = { now: () => clock } as unknown as Performance;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    scheduled = callback;
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {
    scheduled = null;
  };
}

install();

/** Hands the globals back; the last suite using the clock calls this. */
export function restoreClock(): void {
  globalThis.performance = realPerformance;
}

/** Forgets the loop state between tests. */
export function resetHarness(): void {
  clock = 0;
  scheduled = null;
}

/** Runs the run's own loop for `count` frames, one engine tick each. */
export function pump(count: number): void {
  for (let index = 0; index < count; index++) {
    const step = scheduled;
    if (!step) return;
    clock += FRAME_MS;
    step(clock);
  }
}

/** Runs the loop until `done`, so a test never has to guess a lock delay. */
export function pumpUntil(done: () => boolean): void {
  for (let index = 0; index < PATIENCE && !done(); index++) pump(1);
}
