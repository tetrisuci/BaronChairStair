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
 * Index into the puzzle list for a given day. Each pass through the archive
 * uses its own shuffle, so day 1 of the second cycle is not day 1 again.
 */
export function puzzleIndexForDay(day: number, puzzleCount: number): number {
  if (puzzleCount <= 0) throw new RangeError("No puzzles to choose from");
  const zeroBased = day - 1;
  const cycle = Math.floor(zeroBased / puzzleCount);
  const position = ((zeroBased % puzzleCount) + puzzleCount) % puzzleCount;
  return shuffledIndices(puzzleCount, cycle * 0x9e3779b1 + 0x1a2b3c)[position]!;
}
