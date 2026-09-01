/**
 * The puzzle turns over at local midnight in the club's own zone.
 *
 * These pin the daylight-saving behaviour specifically: a fixed UTC offset gets
 * this right for four months of the year and is an hour out for the other
 * eight, and the failure is invisible until somebody notices the puzzle
 * changing at 1am.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIME_ZONE, dayNumber, nextResetAt } from "../shared/daily";

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
