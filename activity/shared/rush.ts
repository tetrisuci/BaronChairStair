/**
 * Puzzle rush: five minutes, as many puzzles as you can solve.
 *
 * The sequence is derived, never stored — the same discipline the daily
 * rotation follows, and for a stronger reason. The server has to be able to
 * re-derive exactly what a player was given in order to check a run it did not
 * watch happen, so the client is never asked which puzzle it was playing: it
 * sends its inputs in order, and position in the sequence says the rest.
 */

import { pieceBudget, type Puzzle } from "./puzzle";
import { seededShuffle } from "./rng";

/** The whole game, in milliseconds. */
export const RUSH_DURATION_MS = 5 * 60_000;

/** Skips granted per run. Two is enough to be a decision and not enough to be a strategy. */
export const RUSH_SKIPS = 2;

/**
 * How many puzzles a rush lines up.
 *
 * The archive's quickest are three or four pieces, so a very fast player might
 * average ten seconds and reach thirty. Forty leaves headroom above that, and
 * the cost of the slack is a few kilobytes of prompt nobody looks at.
 */
export const RUSH_SEQUENCE_LENGTH = 40;

/**
 * The longest puzzle a rush will show you.
 *
 * One archived puzzle runs to seventy-four pieces. Meeting it inside a
 * five-minute run would not be a puzzle in a rush, it would be the rush. Every
 * other puzzle in the archive is twenty-four pieces or shorter, so this
 * excludes exactly the one that does not belong.
 */
export const RUSH_MAX_PIECES = 24;

/**
 * What to assume when the archive never rated a puzzle.
 *
 * `difficulty` is 0 for unrated, which is not the same as easy — the unrated
 * ones ask for things like "2 TSS, 3 TSD" over a dozen-odd pieces. Sorting them
 * as zero would open every rush with a wall, so they are treated as hard, which
 * is what they look like.
 */
const UNRATED_DIFFICULTY = 8;

type Rankable = Pick<Puzzle, "difficulty">;
type Sizeable = Pick<Puzzle, "queue" | "hold">;

/** Difficulty for ordering, with unrated puzzles given a plausible one. */
export function rushDifficulty(puzzle: Rankable): number {
  return puzzle.difficulty > 0 ? puzzle.difficulty : UNRATED_DIFFICULTY;
}

export function isRushEligible(puzzle: Sizeable): boolean {
  return pieceBudget(puzzle) <= RUSH_MAX_PIECES;
}

/**
 * The puzzles for one rush, easiest first.
 *
 * Shuffled first and sorted second, rather than the other way round. Sorting
 * the whole archive and taking the front would hand out the same forty easiest
 * puzzles every single day, with only their order changing; drawing the forty
 * at random and then ramping them gives a fresh set daily that still starts
 * gently and still ends somewhere nobody reaches.
 *
 * `Array.prototype.sort` is stable, so puzzles of equal difficulty keep the
 * order the shuffle gave them and the day still decides between them.
 */
export function rushSequence<T extends Rankable & Sizeable>(
  puzzles: readonly T[],
  seed: number,
  length: number = RUSH_SEQUENCE_LENGTH,
): T[] {
  const eligible = puzzles.filter(isRushEligible);
  if (eligible.length === 0) throw new RangeError("No puzzle is short enough for a rush");
  return seededShuffle(eligible, seed)
    .slice(0, length)
    .sort((a, b) => rushDifficulty(a) - rushDifficulty(b));
}

/**
 * The seed behind the sequence everyone shares on a given day.
 *
 * Mixed rather than passed straight through, so the rush order is independent
 * of the daily rotation instead of marching in step with it. Independent is all
 * it is: over the first two thousand days the rush still opens with that day's
 * daily puzzle eleven times, and still contains it somewhere about as often as
 * chance would have it — forty draws from a hundred and thirty-seven. Keeping
 * the daily out of the rush entirely would mean teaching the sequence about the
 * rotation, and a puzzle you have already seen today is not worth that.
 */
export function dailyRushSeed(day: number): number {
  return (day * 0x85ebca6b + 0x27d4eb2f) >>> 0;
}
