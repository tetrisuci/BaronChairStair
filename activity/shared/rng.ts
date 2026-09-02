/**
 * Seeded randomness.
 *
 * Both the daily rotation and the rush sequence have to be *derived* rather
 * than stored: everyone must get the same puzzles on the same day without the
 * server keeping a schedule, and the server must be able to re-derive what a
 * client claims it was given. That needs a generator whose output depends only
 * on its seed and is identical in every runtime the code runs in — the browser,
 * the server, and the build tool all produce the same order or the whole scheme
 * is worthless.
 */

/** Mulberry32 — small, fast, and stable across runtimes, which is what matters. */
export function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A Fisher-Yates shuffle of `0..count-1`, decided entirely by `seed`. */
export function shuffledIndices(count: number, seed: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  const random = randomFrom(seed);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** The same shuffle, applied to a list. Returns a new array; the input is untouched. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  return shuffledIndices(items.length, seed).map((index) => items[index]!);
}
