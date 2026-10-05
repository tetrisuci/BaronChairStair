/**
 * The streak rules, once, for the game's boards and for db.tetrisatuci.org.
 *
 * They used to live inside `server/db.ts`, where the site cannot reach them —
 * `tests/puzzledb-isolation.test.ts` forbids it — and a site that wrote its own
 * copy would print a streak the game disagrees with on the first day the two
 * readings of "consecutive" differed. These pin the rule itself, and the one
 * way the site asks it differently: with every day before the cut, and the cut
 * standing in for "today".
 */

import { describe, expect, test } from "bun:test";
import { bestStreak, currentStreak } from "../shared/streaks";

describe("currentStreak", () => {
  test("counts back from today through consecutive solved days", () => {
    expect(currentStreak([10, 9, 8], 10)).toBe(3);
  });

  test("forgives today not yet played, as a grace day", () => {
    // Solved yesterday and the two before, has not opened today: still on three.
    expect(currentStreak([9, 8, 7], 10)).toBe(3);
  });

  test("ends at the first missed day", () => {
    expect(currentStreak([10, 9, 7, 6], 10)).toBe(2);
    expect(currentStreak([9, 7, 6], 10)).toBe(1);
  });

  test("is zero once two days have gone by, or with nothing solved", () => {
    expect(currentStreak([8, 7, 6], 10)).toBe(0);
    expect(currentStreak([], 10)).toBe(0);
  });

  test("forgives only one day, and only at the start", () => {
    // The grace day is for today; it cannot be spent on a gap further back.
    expect(currentStreak([10, 8, 7], 10)).toBe(1);
  });

  test("asked at the site's cut, with only earlier days, counts only if the day before it was solved", () => {
    const cut = 20;
    // Every day handed in is before the cut, so the cut is never itself solved:
    // the streak stands exactly when the newest finished day, cut - 1, was solved.
    expect(currentStreak([19, 18, 17], cut)).toBe(3);
    expect(currentStreak([19], cut)).toBe(1);
    expect(currentStreak([18, 17, 16], cut)).toBe(0);
    expect(currentStreak([17], cut)).toBe(0);
  });
});

describe("bestStreak", () => {
  test("is the longest run of consecutive days, wherever it fell", () => {
    expect(bestStreak([20, 19, 15, 14, 13, 12, 3])).toBe(4);
  });

  test("is one for scattered days and zero for none", () => {
    expect(bestStreak([9, 7, 5])).toBe(1);
    expect(bestStreak([])).toBe(0);
  });

  test("counts a run that is still going", () => {
    expect(bestStreak([10, 9, 8, 2, 1])).toBe(3);
  });

  test("never counts a missed day as part of a run, grace or not", () => {
    // The grace day belongs to the current streak only: a best is what was done.
    expect(bestStreak([10, 8, 7])).toBe(2);
  });
});
