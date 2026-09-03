/**
 * The puzzle turns over at local midnight in the club's own zone.
 *
 * These pin the daylight-saving behaviour specifically: a fixed UTC offset gets
 * this right for four months of the year and is an hour out for the other
 * eight, and the failure is invisible until somebody notices the puzzle
 * changing at 1am.
 */

import { describe, expect, test } from "bun:test";
import {
  byTier,
  DAILY_TIERS,
  DEFAULT_TIME_ZONE,
  dailyTierOf,
  dayNumber,
  nextResetAt,
  puzzleIndexForDay,
} from "../shared/daily";
import { readFileSync } from "node:fs";
import type { Puzzle } from "../shared/puzzle";

/** Reads back the wall-clock time in the club's zone, for assertions. */
function pacific(instant: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(instant));
}

describe("daily rotation", () => {
  test("the day changes exactly at local midnight in winter (UTC-8)", () => {
    // 2026-01-15 07:59 UTC is 23:59 on the 14th in Pacific; 08:00 is midnight.
    const before = Date.UTC(2026, 0, 15, 7, 59);
    const after = Date.UTC(2026, 0, 15, 8, 0);
    expect(dayNumber(after)).toBe(dayNumber(before) + 1);
  });

  test("the day changes exactly at local midnight in summer (UTC-7)", () => {
    // In July the same boundary is an hour earlier in UTC — the whole point.
    const before = Date.UTC(2026, 6, 15, 6, 59);
    const after = Date.UTC(2026, 6, 15, 7, 0);
    expect(dayNumber(after)).toBe(dayNumber(before) + 1);
    // A fixed -8 offset would still be waiting for 08:00 here.
    expect(dayNumber(Date.UTC(2026, 6, 15, 7, 30))).toBe(dayNumber(after));
  });

  test("one day passes per day across the spring-forward weekend", () => {
    // 2026-03-08 is the US spring-forward; that local day is only 23 hours long.
    const saturday = dayNumber(Date.UTC(2026, 2, 7, 20, 0));
    const sunday = dayNumber(Date.UTC(2026, 2, 8, 20, 0));
    const monday = dayNumber(Date.UTC(2026, 2, 9, 20, 0));
    expect(sunday).toBe(saturday + 1);
    expect(monday).toBe(sunday + 1);
  });

  test("one day passes per day across the fall-back weekend", () => {
    // 2026-11-01 is the US fall-back; that local day is 25 hours long.
    const saturday = dayNumber(Date.UTC(2026, 9, 31, 20, 0));
    const sunday = dayNumber(Date.UTC(2026, 10, 1, 20, 0));
    const monday = dayNumber(Date.UTC(2026, 10, 2, 20, 0));
    expect(sunday).toBe(saturday + 1);
    expect(monday).toBe(sunday + 1);
  });

  test("the next reset is always the upcoming local midnight", () => {
    for (const instant of [
      Date.UTC(2026, 0, 15, 9, 30), // winter
      Date.UTC(2026, 6, 15, 9, 30), // summer
      Date.UTC(2026, 2, 8, 9, 30), // spring forward
      Date.UTC(2026, 10, 1, 9, 30), // fall back
    ]) {
      const reset = nextResetAt(instant);
      expect(reset).toBeGreaterThan(instant);
      expect(pacific(reset)).toMatch(/, 00:00$/);
      // And it really is the boundary: a moment later is the next puzzle.
      expect(dayNumber(reset)).toBe(dayNumber(instant) + 1);
    }
  });

  test("a different zone moves the boundary with it", () => {
    // 05:00 UTC on the 15th is still the evening of the 14th in Pacific.
    const instant = Date.UTC(2026, 0, 15, 5, 0);
    expect(dayNumber(instant, { timeZone: "UTC" })).toBe(dayNumber(instant) + 1);
  });
});

// ── The three tiers a day holds ──────────────────────────────────────────────

const archive: Puzzle[] = JSON.parse(readFileSync("data/puzzles.json", "utf8")).puzzles;

describe("the day's three tiers", () => {
  const tiers = byTier(archive);

  test("every puzzle lands in exactly one tier, and none is lost", () => {
    const total = DAILY_TIERS.reduce((sum, tier) => sum + tiers[tier].length, 0);
    expect(total).toBe(archive.length);
  });

  test("no tier is so thin that it repeats months before the others", () => {
    // A tier's size is how many days it takes to come round again, because each
    // walks its own rotation. A lopsided split would mean the hard puzzle
    // repeating while the easy one was still on its first pass.
    const sizes = DAILY_TIERS.map((tier) => tiers[tier].length);
    expect(Math.min(...sizes) * 1.5).toBeGreaterThan(Math.max(...sizes));
  });

  test("an unrated puzzle is hard, not easy", () => {
    // Rated nothing because nobody got round to it, not because it is gentle.
    expect(dailyTierOf({ difficulty: 0 })).toBe("hard");
    expect(dailyTierOf({ difficulty: 4 })).toBe("easy");
    expect(dailyTierOf({ difficulty: 5 })).toBe("medium");
    expect(dailyTierOf({ difficulty: 8 })).toBe("hard");
  });
});

describe("three rotations running side by side", () => {
  test("a tier deals every one of its puzzles before repeating any", () => {
    for (const size of [45, 46, 47]) {
      const seen = Array.from({ length: size }, (_, day) => puzzleIndexForDay(day + 1, size, 1));
      expect(new Set(seen).size).toBe(size);
    }
  });

  test("two tiers of the same size do not march in lockstep", () => {
    // The trap this stream argument exists for. The permutation is otherwise a
    // pure function of the list's length, so two tiers with the same number of
    // puzzles would pick the same positional rank every day for ever, and the
    // pairing of easy to hard would never vary.
    const withoutStream = Array.from({ length: 60 }, (_, day) => puzzleIndexForDay(day + 1, 46));
    const streamOne = Array.from({ length: 60 }, (_, day) => puzzleIndexForDay(day + 1, 46, 1));
    const streamTwo = Array.from({ length: 60 }, (_, day) => puzzleIndexForDay(day + 1, 46, 2));

    expect(streamOne).not.toEqual(withoutStream);
    expect(streamTwo).not.toEqual(streamOne);
    // And not merely offset from one another either.
    const agreements = streamOne.filter((value, index) => value === streamTwo[index]).length;
    expect(agreements).toBeLessThan(10);
  });

  test("the same day and stream always deal the same puzzle", () => {
    // Derived and never stored, so this is what makes a day reproducible on the
    // server, in the browser and in the build tool alike.
    for (const day of [1, 2, 45, 46, 137, 300]) {
      expect(puzzleIndexForDay(day, 46, 2)).toBe(puzzleIndexForDay(day, 46, 2));
    }
  });

  test("a stream keeps reshuffling when it wraps", () => {
    const firstPass = Array.from({ length: 46 }, (_, day) => puzzleIndexForDay(day + 1, 46, 3));
    const secondPass = Array.from({ length: 46 }, (_, day) => puzzleIndexForDay(day + 47, 46, 3));
    expect(secondPass).not.toEqual(firstPass);
    expect(new Set(secondPass).size).toBe(46);
  });
});
