/**
 * Daily rotation.
 *
 * Everyone must get the same puzzle on the same day without the server keeping
 * a schedule, so the day number is derived from the clock and the puzzle is
 * derived from the day number. The rotation walks a shuffled permutation of the
 * whole archive, reshuffling each time it wraps, so no puzzle repeats until
 * every other one has been played.
 */

import { shuffledIndices } from "./rng";

const MS_PER_DAY = 86_400_000;

/** Day 1 of the game, as a local calendar date. Puzzle numbers count from here. */
export const EPOCH_UTC = Date.UTC(2026, 0, 1);

/**
 * The club is in Irvine, so the puzzle turns over at midnight there.
 *
 * A zone, not a fixed offset: Pacific is UTC-8 in winter and UTC-7 in summer,
 * so an offset that is right in January has the puzzle changing at 1am for the
 * eight months of daylight saving.
 */
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

export interface DayOptions {
  /** IANA zone whose midnight starts a new puzzle. */
  readonly timeZone?: string;
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** Formatters are expensive to build and this runs on every request. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  FORMATTERS.set(timeZone, made);
  return made;
}

/** What a clock on the wall in that zone reads at the given instant. */
function wallClock(instant: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    // Some engines write midnight as hour 24 rather than 0.
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** How far ahead of UTC the zone is at that instant, in milliseconds. */
function zoneOffset(instant: number, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asIfUtc - (Math.floor(instant / 1000) * 1000);
}

/**
 * The instant local midnight begins on the given local date.
 *
 * Twice, because the offset has to be sampled at some instant and the first
 * guess can land on the far side of a daylight-saving change — sampling again
 * at the corrected instant settles it.
 */
function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const naive = Date.UTC(year, month - 1, day);
  const firstPass = naive - zoneOffset(naive, timeZone);
  return naive - zoneOffset(firstPass, timeZone);
}

/** The puzzle number for a moment in time. Day 1 is {@link EPOCH_UTC}. */
export function dayNumber(now: Date | number = Date.now(), options: DayOptions = {}): number {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const instant = typeof now === "number" ? now : now.getTime();
  const wall = wallClock(instant, timeZone);
  const localDate = Date.UTC(wall.year, wall.month - 1, wall.day);
  return Math.floor((localDate - EPOCH_UTC) / MS_PER_DAY) + 1;
}

/** When the current puzzle is replaced: the next local midnight, as a timestamp. */
export function nextResetAt(now: Date | number = Date.now(), options: DayOptions = {}): number {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const instant = typeof now === "number" ? now : now.getTime();
  const wall = wallClock(instant, timeZone);
  // Date.UTC normalises a day past the end of the month.
  return localMidnight(wall.year, wall.month, wall.day + 1, timeZone);
}

/**
 * Index into a puzzle list for a given day. Each pass through the list uses its
 * own shuffle, so day 1 of the second cycle is not day 1 again.
 *
 * `stream` separates lists that are drawn from side by side. Without it the
 * permutation is a pure function of the list's *length*, so two lists of the
 * same size march in lockstep: the easy and the hard track would pick the same
 * positional rank every day, forever, and the pairing would never vary. It is
 * mixed into the cycle seed rather than the position, so each stream still
 * walks a full permutation and still repeats nothing until it wraps.
 *
 * Required, with no default. A forgotten argument is exactly the lockstep this
 * exists to prevent, and a default would let the type checker wave it through.
 */
export function puzzleIndexForDay(day: number, puzzleCount: number, stream: number): number {
  if (puzzleCount <= 0) throw new RangeError("No puzzles to choose from");
  const zeroBased = day - 1;
  const cycle = Math.floor(zeroBased / puzzleCount);
  const position = ((zeroBased % puzzleCount) + puzzleCount) % puzzleCount;
  const seed = (cycle * 0x9e3779b1 + 0x1a2b3c + stream * 0x85ebca6b) >>> 0;
  return shuffledIndices(puzzleCount, seed)[position]!;
}

/**
 * The three puzzles a day holds: one within reach, one to work at, one to lose
 * to.
 *
 * A tier is a band of the archive's own difficulty rating, and unrated puzzles
 * count as hard — they are rated nothing because nobody got round to it, not
 * because they are gentle, and they ask for things like "2 TSS, 3 TSD" over a
 * dozen pieces.
 *
 * The bands are chosen to be close to equal rather than to be round numbers.
 * Each tier walks its own rotation, so a tier's size is how long it takes that
 * tier to repeat itself, and a lopsided split would mean the hard puzzle came
 * round again months before the easy one did.
 */
export type DailyTier = "easy" | "medium" | "hard";

export const DAILY_TIERS: readonly DailyTier[] = ["easy", "medium", "hard"];

export function dailyTierOf(puzzle: { readonly difficulty: number }): DailyTier {
  if (puzzle.difficulty <= 0) return "hard";
  if (puzzle.difficulty <= 4) return "easy";
  if (puzzle.difficulty <= 7) return "medium";
  return "hard";
}

/**
 * Splits a list into the three tiers, keeping each tier's own order.
 *
 * The caller is responsible for handing in a list whose order is stable across
 * restarts — the rotation is an index into these arrays, so a list that came
 * back in a different order would silently deal different puzzles.
 */
export function byTier<T extends { readonly difficulty: number }>(
  puzzles: readonly T[],
): Readonly<Record<DailyTier, readonly T[]>> {
  // Written out rather than built from DAILY_TIERS: the explicit object is what
  // lets the return type check that every tier is present, and a tier added to
  // the union without a line here is then a compile error rather than a gap.
  return {
    easy: puzzles.filter((puzzle) => dailyTierOf(puzzle) === "easy"),
    medium: puzzles.filter((puzzle) => dailyTierOf(puzzle) === "medium"),
    hard: puzzles.filter((puzzle) => dailyTierOf(puzzle) === "hard"),
  };
}
