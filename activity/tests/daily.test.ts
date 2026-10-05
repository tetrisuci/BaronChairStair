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
  dayStarts,
  nextResetAt,
  puzzleIndexForDay,
  startOfDay,
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

// ── When a day begins, as an instant ─────────────────────────────────────────
//
// db.tetrisatuci.org cuts two millisecond columns — when a line was filed, when
// a puzzle was first cleared — at the start of a day, in the game's own zone.
// A start that is an hour out on a daylight-saving night would show a line
// filed in the first hour of today, so these walk both of 2026's change nights.

/** 2026-03-08 and 2026-11-01: the club's spring-forward and fall-back days. */
const SPRING_FORWARD = 67;
const FALL_BACK = 305;
const HOUR = 3_600_000;

describe("the instant a day begins", () => {
  test("is the local midnight that starts it, either side of daylight saving", () => {
    expect(pacific(startOfDay(15))).toBe("2026-01-15, 00:00");
    expect(startOfDay(15)).toBe(Date.UTC(2026, 0, 15, 8));
    expect(startOfDay(196)).toBe(Date.UTC(2026, 6, 15, 7));
  });

  test("makes the spring-forward day 23 hours long and the fall-back day 25", () => {
    expect(startOfDay(SPRING_FORWARD)).toBe(Date.UTC(2026, 2, 8, 8));
    expect(startOfDay(SPRING_FORWARD + 1) - startOfDay(SPRING_FORWARD)).toBe(23 * HOUR);
    expect(startOfDay(FALL_BACK)).toBe(Date.UTC(2026, 10, 1, 7));
    expect(startOfDay(FALL_BACK + 1) - startOfDay(FALL_BACK)).toBe(25 * HOUR);
  });

  test("agrees with dayNumber on both sides of every boundary for three years, in several zones", () => {
    // Half-hour offsets and a half-hour daylight change included: Lord Howe
    // moves its clocks by thirty minutes, which a whole-hour guess gets wrong.
    const zones = [DEFAULT_TIME_ZONE, "UTC", "Asia/Kolkata", "Australia/Lord_Howe", "Europe/London"];
    const wrong: string[] = [];
    for (const timeZone of zones) {
      for (let day = 1; day <= 3 * 366; day++) {
        const start = startOfDay(day, { timeZone });
        if (dayNumber(start, { timeZone }) !== day) wrong.push(`${timeZone} ${day} start`);
        if (dayNumber(start - 1, { timeZone }) !== day - 1) wrong.push(`${timeZone} ${day} before`);
      }
    }

    expect(wrong).toEqual([]);
  });

  test("is the reset the day before it was counting down to", () => {
    for (const day of [15, 196, SPRING_FORWARD, SPRING_FORWARD + 1, FALL_BACK, FALL_BACK + 1]) {
      const noonBefore = startOfDay(day - 1) + 12 * HOUR;
      expect(nextResetAt(noonBefore)).toBe(startOfDay(day));
    }
  });

  test("defaults to the club's zone, and moves with another", () => {
    expect(startOfDay(15)).toBe(startOfDay(15, { timeZone: DEFAULT_TIME_ZONE }));
    expect(startOfDay(15, { timeZone: "UTC" })).toBe(Date.UTC(2026, 0, 15));
  });
});

describe("a run of day starts", () => {
  test("holds one start per day, first to last inclusive, in order", () => {
    const starts = dayStarts(SPRING_FORWARD - 2, FALL_BACK + 2);

    expect(starts).toHaveLength(FALL_BACK - SPRING_FORWARD + 5);
    expect(starts[0]).toBe(startOfDay(SPRING_FORWARD - 2));
    expect(starts.at(-1)).toBe(startOfDay(FALL_BACK + 2));
    expect(starts.every((start, i) => i === 0 || start > starts[i - 1]!)).toBe(true);
    expect(dayStarts(10, 10)).toEqual([startOfDay(10)]);
  });

  test("is empty when the range is", () => {
    expect(dayStarts(11, 10)).toEqual([]);
  });

  test("takes the zone it is given", () => {
    expect(dayStarts(15, 16, { timeZone: "UTC" })).toEqual([Date.UTC(2026, 0, 15), Date.UTC(2026, 0, 16)]);
  });

  test("names the day of any instant as the site's SQL will: the last start at or before it", () => {
    // `LINE_DAY` in the site's snapshot is MAX(index) over these starts where
    // start <= found_at, plus the first day. Every quarter hour across both
    // change nights, that must be the day the game was on.
    const lo = SPRING_FORWARD - 3;
    const timeZone = DEFAULT_TIME_ZONE;
    const starts = dayStarts(lo, FALL_BACK + 3, { timeZone });
    const lineDay = (instant: number) => starts.findLastIndex((start) => start <= instant) + lo;
    const nights = [
      [startOfDay(SPRING_FORWARD - 1), startOfDay(SPRING_FORWARD + 2)],
      [startOfDay(FALL_BACK - 1), startOfDay(FALL_BACK + 2)],
    ] as const;

    const wrong: number[] = [];
    for (const [from, to] of nights) {
      for (let instant = from; instant < to; instant += 15 * 60_000) {
        if (lineDay(instant) !== dayNumber(instant, { timeZone })) wrong.push(instant);
      }
    }

    expect(wrong).toEqual([]);
  });
});

// ── The four tiers a day holds ───────────────────────────────────────────────

const archive: Puzzle[] = JSON.parse(readFileSync("data/puzzles.json", "utf8")).puzzles;

describe("the day's four tiers", () => {
  const tiers = byTier(archive);

  test("every puzzle lands in exactly one tier, and none is lost", () => {
    const total = DAILY_TIERS.reduce((sum, tier) => sum + tiers[tier].length, 0);
    expect(total).toBe(archive.length);
  });

  test("no tier is empty, because an empty one takes the server down", () => {
    // Load-bearing rather than tidy: `correctedOrSource` refuses a correction
    // that empties a tier, and the constructor throws on one — at module scope,
    // before any route exists.
    for (const tier of DAILY_TIERS) expect(tiers[tier].length).toBeGreaterThan(0);
  });

  test("no tier is so thin it comes round inside a fortnight", () => {
    // The bands used to be chosen to be close to equal, so that no tier lapped
    // another. They are now chosen in *squares* — the unit the club states
    // difficulty in — and that is deliberately not the same thing: measured on
    // today's archive it gives easy 21, medium 24, extreme 27 and hard 66,
    // because hard spans two squares' worth of ratings and takes the unrated
    // besides. So hard repeats about every nine weeks and easy about every
    // three, and the guarantee that survives is only that none of them is
    // thin enough to feel like a loop.
    const sizes = DAILY_TIERS.map((tier) => tiers[tier].length);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(14);
  });

  test("the bands are the squares a player is shown", () => {
    // Easy at most one square, medium two, hard three or four, extreme five up.
    expect(dailyTierOf({ difficulty: 2 })).toBe("easy");
    expect(dailyTierOf({ difficulty: 4 })).toBe("medium");
    expect(dailyTierOf({ difficulty: 8 })).toBe("hard");
    expect(dailyTierOf({ difficulty: 9 })).toBe("extreme");
  });

  test("an unrated puzzle is hard, not easy", () => {
    // Rated nothing because nobody got round to it, not because it is gentle —
    // and it fills no squares, so "at most one square" would otherwise take it.
    expect(dailyTierOf({ difficulty: 0 })).toBe("hard");
  });
});

describe("four rotations running side by side", () => {
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
    const withoutStream = Array.from({ length: 60 }, (_, day) => puzzleIndexForDay(day + 1, 46, 0));
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
