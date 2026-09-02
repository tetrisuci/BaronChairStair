/**
 * The 1v1 protocol's own arithmetic.
 *
 * What a duel does with a socket is exercised against a real server in
 * `tests/duel.test.ts`; what is left, and what is worth pinning here, is the
 * part both ends compute for themselves. A host's settings arrive in a
 * WebSocket frame that met no middleware on the way in, so `sanitizeSettings`
 * is the only thing standing between a hostile number and a match built on it —
 * and the two modes read the same `durationMs` field against different bounds,
 * which is the kind of thing that regresses without anything failing.
 *
 * The rush stack is sized from the host's clock rather than pinned to the
 * single-player constant, so the sizing is checked against the real archive: a
 * stack a fast player can reach the end of is a match with time still on it and
 * nothing left to play.
 *
 * Nothing under `server/` is imported here, deliberately. `bun test` shares one
 * module registry across files, and `server/config` reads the environment once
 * at import; a file that stays inside `shared/` cannot decide that question for
 * the files that do.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DUEL_ROUND_MS_DEFAULT,
  DUEL_ROUND_MS_MAX,
  DUEL_ROUND_MS_MIN,
  DUEL_ROUND_OPTIONS,
  DUEL_RUSH_MS_DEFAULT,
  DUEL_RUSH_MS_MAX,
  DUEL_RUSH_MS_MIN,
  rushDuelLength,
  sanitizeSettings,
} from "../shared/duel";
import type { Puzzle } from "../shared/puzzle";
import { isRushEligible, RUSH_DURATION_MS, RUSH_SEQUENCE_LENGTH, rushSequence } from "../shared/rush";

const archive: Puzzle[] = JSON.parse(readFileSync("data/puzzles.json", "utf8")).puzzles;
const eligible = archive.filter(isRushEligible);


/** Every duration a host may legally ask for, plus the ends of both ranges. */
const DURATIONS = [
  DUEL_RUSH_MS_MIN,
  DUEL_ROUND_MS_MIN,
  DUEL_ROUND_MS_DEFAULT,
  RUSH_DURATION_MS,
  DUEL_ROUND_MS_MAX,
  DUEL_RUSH_MS_DEFAULT,
  DUEL_RUSH_MS_MAX,
];

describe("sanitizeSettings", () => {
  test("a rush has no rounds to be best of", () => {
    for (const rounds of [...DUEL_ROUND_OPTIONS, 0, 99]) {
      expect(sanitizeSettings({ mode: "rush", rounds, durationMs: RUSH_DURATION_MS }).rounds).toBe(
        1,
      );
    }
  });

  test("a puzzle duel keeps an offered round count and refuses any other", () => {
    for (const rounds of DUEL_ROUND_OPTIONS) {
      expect(
        sanitizeSettings({ mode: "puzzle", rounds, durationMs: DUEL_ROUND_MS_DEFAULT }).rounds,
      ).toBe(rounds);
    }
    for (const rounds of [0, 2, 4, -1, 1e9, Number.NaN]) {
      expect(
        sanitizeSettings({ mode: "puzzle", rounds, durationMs: DUEL_ROUND_MS_DEFAULT }).rounds,
      ).toBe(3);
    }
  });

  test("the same duration is bounded differently by mode", () => {
    // One field, two clocks: a per-round clock for puzzle and a whole-match
    // clock for rush. A duration legal in one mode is out of range in the other
    // at both ends, so a mode read wrong here shows up as a plausible number.
    expect(
      sanitizeSettings({ mode: "rush", rounds: 1, durationMs: DUEL_ROUND_MS_MIN }).durationMs,
    ).toBe(DUEL_RUSH_MS_MIN);
    expect(
      sanitizeSettings({ mode: "puzzle", rounds: 3, durationMs: DUEL_RUSH_MS_MAX }).durationMs,
    ).toBe(DUEL_ROUND_MS_MAX);
  });

  test("nothing a frame can carry escapes the mode's range", () => {
    const hostile = [
      -1,
      0,
      Number.MAX_SAFE_INTEGER,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      "300000",
      null,
      undefined,
      {},
    ];
    for (const durationMs of hostile) {
      const rush = sanitizeSettings({ mode: "rush", rounds: 1, durationMs });
      expect(rush.durationMs).toBeGreaterThanOrEqual(DUEL_RUSH_MS_MIN);
      expect(rush.durationMs).toBeLessThanOrEqual(DUEL_RUSH_MS_MAX);

      const puzzle = sanitizeSettings({ mode: "puzzle", rounds: 3, durationMs });
      expect(puzzle.durationMs).toBeGreaterThanOrEqual(DUEL_ROUND_MS_MIN);
      expect(puzzle.durationMs).toBeLessThanOrEqual(DUEL_ROUND_MS_MAX);
    }
  });

  test("anything that is not the word rush is a puzzle duel", () => {
    for (const mode of ["puzzle", "RUSH", "", null, undefined, 1, {}]) {
      expect(sanitizeSettings({ mode, rounds: 3, durationMs: DUEL_ROUND_MS_DEFAULT }).mode).toBe(
        mode === "rush" ? "rush" : "puzzle",
      );
    }
    expect(sanitizeSettings(undefined)).toEqual({
      mode: "puzzle",
      rounds: 3,
      durationMs: DUEL_ROUND_MS_DEFAULT,
    });
  });
});

describe("rushDuelLength", () => {
  test("a five-minute duel gets the same stack a five-minute rush does", () => {
    expect(rushDuelLength(RUSH_DURATION_MS)).toBe(RUSH_SEQUENCE_LENGTH);
  });

  test("a fast player cannot reach the end of any legal duel's stack", () => {
    // Ten seconds a puzzle is the pace `shared/rush.ts` sizes its own stack
    // against. A stack shorter than that leaves a player with time on the clock
    // and nothing to play, which is the failure this function exists to avoid.
    const FASTEST_PLAUSIBLE_MS_PER_SOLVE = 10_000;
    for (const durationMs of DURATIONS) {
      expect(rushDuelLength(durationMs)).toBeGreaterThanOrEqual(
        durationMs / FASTEST_PLAUSIBLE_MS_PER_SOLVE,
      );
    }
  });

  test("the archive can fill even the longest duel", () => {
    // `rushSequence` slices after filtering, so a length past the eligible
    // count silently comes back short rather than failing.
    expect(rushDuelLength(DUEL_RUSH_MS_MAX)).toBeLessThanOrEqual(eligible.length);
    expect(rushSequence(archive, 12345, rushDuelLength(DUEL_RUSH_MS_MAX))).toHaveLength(
      rushDuelLength(DUEL_RUSH_MS_MAX),
    );
  });

  test("a longer match never gets a shorter stack", () => {
    for (let durationMs = DUEL_RUSH_MS_MIN; durationMs <= DUEL_RUSH_MS_MAX; durationMs += 1_000) {
      expect(rushDuelLength(durationMs + 1_000)).toBeGreaterThanOrEqual(rushDuelLength(durationMs));
    }
  });

  test("both players in a rush duel are dealt one identical stack", () => {
    // The referee derives this once and hands puzzles out of it by position, so
    // "the same puzzles for both" rests on the derivation being a function of
    // the seed alone.
    for (const seed of [1, 977, 0xdeadbeef]) {
      const length = rushDuelLength(DUEL_RUSH_MS_DEFAULT);
      const first = rushSequence(archive, seed, length).map((puzzle) => puzzle.id);
      const second = rushSequence(archive, seed, length).map((puzzle) => puzzle.id);
      expect(second).toEqual(first);
      expect(new Set(first).size).toBe(first.length);
    }
  });
});
