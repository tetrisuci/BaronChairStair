/**
 * Puzzle rush: the parts that have to hold for a run nobody watched.
 *
 * Two things carry the whole mode. The sequence is derived rather than stored,
 * so it has to come out identical on the client and on the server from nothing
 * but a seed, and it has to keep starting gently and keep changing daily. And
 * the replay has to score a log that stops part-way through exactly as it
 * scored one before the idle bound was added, because every skipped puzzle in a
 * rush is a log that stops part-way through.
 *
 * The archive is used wherever it makes the check stronger: a threshold picked
 * against the real hundred and thirty-eight puzzles is a threshold that means
 * something, and a synthetic list of four proves nothing about the ramp.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { archive as puzzles, solutionOf } from "./archive";
import { byTier, DAILY_TIERS, puzzleIndexForDay } from "../shared/daily";
import { seededShuffle, shuffledIndices } from "../shared/rng";
import {
  decodeBoard,
  ENGINE_ROWS,
  meetsTarget,
  type Mino,
  pieceBudget,
  type Puzzle,
} from "../shared/puzzle";
import {
  dailyRushSeed,
  isRushEligible,
  RUSH_MAX_PIECES,
  RUSH_SEQUENCE_LENGTH,
  rushBand,
  rushDifficulty,
  rushSequence,
} from "../shared/rush";
import { createPuzzleEngine, toLetter } from "../shared/tetris/engine";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { findPaths } from "../shared/tetris/pathfinder";
import { type GameKey, type InputEvent, verifyRun } from "../shared/tetris/verify";

// Merged with the untracked answers; see tests/archive.ts.
const eligible = puzzles.filter(isRushEligible);

/** One frame down, one frame up: long enough to register, short of DAS. */
const FRAMES_PER_INPUT = 2;

/** Seeds to sweep whenever a claim has to hold for every day, not one lucky one. */
const SEEDS = Array.from({ length: 60 }, (_, index) => index * 977 + 1);

function setupFor(puzzle: Puzzle) {
  return {
    board: decodeBoard(puzzle.board, ENGINE_ROWS),
    queue: puzzle.queue,
    hold: puzzle.hold,
  };
}

describe("what the archive offers a rush", () => {
  test("exactly one puzzle is too long to belong in five minutes", () => {
    const tooLong = puzzles.filter((puzzle) => !isRushEligible(puzzle));
    expect(tooLong).toHaveLength(1);
    expect(pieceBudget(tooLong[0]!)).toBeGreaterThan(RUSH_MAX_PIECES);
  });

  test("the limit sits in the gap rather than through the middle of the field", () => {
    // Lowering RUSH_MAX_PIECES would start excluding puzzles that are merely
    // long, which is a different decision from excluding the one outlier. The
    // longest puzzle still eligible is exactly at the limit, so the constant is
    // where the archive's own gap is.
    const longestEligible = Math.max(...eligible.map(pieceBudget));
    expect(longestEligible).toBe(RUSH_MAX_PIECES);
    expect(eligible.length).toBe(puzzles.length - 1);
  });
});

describe("rushSequence", () => {
  test("the same seed gives the same puzzles in the same order, every call", () => {
    // The client is shown this sequence and the server re-derives it to check
    // the run, from separate calls in separate processes. If those two ever
    // disagree the segments line up against the wrong puzzles and every score
    // is wrong.
    for (const seed of SEEDS.slice(0, 8)) {
      const first = rushSequence(puzzles, seed).map((puzzle) => puzzle.id);
      const second = rushSequence(puzzles, seed).map((puzzle) => puzzle.id);
      const third = rushSequence([...puzzles], seed).map((puzzle) => puzzle.id);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
      expect(first).toHaveLength(RUSH_SEQUENCE_LENGTH);
    }
  });

  test("the rung never goes down as the run goes on", () => {
    // By rung, not by rating. The rating itself is allowed to dip inside a rung
    // — that is what stops the run being the same ladder every time — but a run
    // must never hand you something out of an easier rung than one you have
    // already been given.
    for (const seed of SEEDS) {
      const bands = rushSequence(puzzles, seed).map(rushBand);
      for (let index = 1; index < bands.length; index++) {
        expect(bands[index]!).toBeGreaterThanOrEqual(bands[index - 1]!);
      }
    }
  });

  test("the order inside a rung is not the rating order", () => {
    // The feature, stated as the thing that would be false without it: if the
    // sequence were still sorted on the rating, every run would be
    // non-decreasing all the way down and this would find no seed at all.
    const dips = SEEDS.filter((seed) => {
      const difficulties = rushSequence(puzzles, seed).map(rushDifficulty);
      return difficulties.some((value, index) => index > 0 && value < difficulties[index - 1]!);
    });
    expect(dips.length).toBeGreaterThan(SEEDS.length / 2);
  });

  test("the same seed deals the same run, every time", () => {
    // Load-bearing, not a nicety: the server re-derives the sequence from the
    // seed in the ticket to score a run it never watched. A sequence that
    // varied for a fixed seed would make every run unverifiable.
    for (const seed of SEEDS.slice(0, 8)) {
      const once = rushSequence(puzzles, seed).map((puzzle) => puzzle.id);
      const twice = rushSequence(puzzles, seed).map((puzzle) => puzzle.id);
      expect(twice).toEqual(once);
    }
  });

  test("two seeds deal different orders", () => {
    const orders = SEEDS.slice(0, 8).map((seed) =>
      rushSequence(puzzles, seed)
        .map((puzzle) => puzzle.id)
        .join(","),
    );
    expect(new Set(orders).size).toBe(orders.length);
  });

  test("the ramp is a real climb and not a flat line that happens to be sorted", () => {
    // Non-decreasing is free for anything that came out of a sort, so this asks
    // the stronger question: does the run actually open somewhere a beginner
    // can start and end somewhere nobody reaches?
    for (const seed of SEEDS) {
      const difficulties = rushSequence(puzzles, seed).map(rushDifficulty);
      expect(difficulties[0]!).toBeLessThanOrEqual(3);
      // The end of the run is the hardest rung rather than the hardest single
      // puzzle now, so this measures the climb rather than the final step.
      const quarter = Math.floor(difficulties.length / 4);
      const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
      expect(mean(difficulties.slice(-quarter))).toBeGreaterThan(
        mean(difficulties.slice(0, quarter)) + 3,
      );
    }
  });

  test("the over-long puzzle is never dealt", () => {
    const tooLong = puzzles.find((puzzle) => !isRushEligible(puzzle))!;
    for (const seed of SEEDS) {
      for (const puzzle of rushSequence(puzzles, seed)) {
        expect(pieceBudget(puzzle)).toBeLessThanOrEqual(RUSH_MAX_PIECES);
        expect(puzzle.id).not.toBe(tooLong.id);
      }
    }
  });

  test("no puzzle is dealt twice in one rush", () => {
    for (const seed of SEEDS) {
      const ids = rushSequence(puzzles, seed).map((puzzle) => puzzle.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("the caller's archive comes back untouched", () => {
    // The server holds one archive for the process and derives a sequence from
    // it on every start, so a sort in place here would quietly reorder the
    // daily rotation as well.
    const before = puzzles.map((puzzle) => puzzle.id);
    rushSequence(puzzles, 12345);
    expect(puzzles.map((puzzle) => puzzle.id)).toEqual(before);
  });

  test("asking for more than exists returns every eligible puzzle once", () => {
    const everything = rushSequence(puzzles, 99, puzzles.length * 2);
    expect(everything).toHaveLength(eligible.length);
    expect(new Set(everything.map((puzzle) => puzzle.id)).size).toBe(eligible.length);
  });

  test("refuses a field with nothing short enough in it", () => {
    const marathon = {
      difficulty: 1,
      queue: Array.from({ length: RUSH_MAX_PIECES + 1 }, () => "I" as Mino),
      hold: null,
    };
    expect(() => rushSequence([marathon], 1)).toThrow(RangeError);
  });
});

describe("unrated puzzles in the ramp", () => {
  interface SyntheticPuzzle {
    readonly name: string;
    readonly difficulty: number;
    readonly queue: readonly Mino[];
    readonly hold: Mino | null;
  }

  function synthetic(name: string, difficulty: number): SyntheticPuzzle {
    return { name, difficulty, queue: ["I", "O"], hold: null };
  }

  const field = [
    synthetic("unrated", 0),
    synthetic("easy", 1),
    synthetic("mid", 5),
    synthetic("hard", 9),
  ];

  test("a difficulty of zero would lead if it were read as a difficulty", () => {
    // The counterfactual the sort has to avoid, stated so the test below is
    // measuring something rather than asserting a preference.
    const naive = [...field].sort((a, b) => a.difficulty - b.difficulty);
    expect(naive[0]!.name).toBe("unrated");
  });

  test("an unrated puzzle is placed among the hard ones instead", () => {
    // Unrated reads as 8, which shares a rung with the 9 — so which of those
    // two comes last is the shuffle's business. What matters is that neither
    // leads, and that both come after the easy one and the mid one.
    for (const seed of SEEDS.slice(0, 12)) {
      const order = rushSequence(field, seed, field.length).map((puzzle) => puzzle.name);
      expect(order.slice(0, 2)).toEqual(["easy", "mid"]);
      expect([...order.slice(2)].sort()).toEqual(["hard", "unrated"]);
    }
  });

  test("an unrated puzzle outranks a seven and is outranked by a nine", () => {
    expect(rushDifficulty({ difficulty: 0 })).toBeGreaterThan(rushDifficulty({ difficulty: 7 }));
    expect(rushDifficulty({ difficulty: 9 })).toBeGreaterThan(rushDifficulty({ difficulty: 0 }));
  });

  test("the archive's unrated puzzles never open a rush", () => {
    // Seven of the hundred and thirty-eight are unrated, and they ask for
    // things like two TSSs and three TSDs over a dozen pieces. Meeting one in
    // the opening ten seconds is the failure this guards.
    const opening = 10;
    for (const seed of SEEDS) {
      for (const puzzle of rushSequence(puzzles, seed).slice(0, opening)) {
        expect(puzzle.difficulty).toBeGreaterThan(0);
      }
    }
  });
});

describe("one day's rush against the next", () => {
  const DAYS_SAMPLED = 200;

  /**
   * How much of one day's forty may survive into the next.
   *
   * Forty drawn from a hundred and thirty-seven share about twelve by chance,
   * and the worst neighbouring pair in the first two hundred days shares
   * eighteen. Twenty-six leaves room for that and no room at all for a rush
   * that has stopped changing.
   */
  const SHARED_PUZZLE_CEILING = 26;

  /**
   * And how many may sit in the same slot. Some agreement here is the ramp
   * doing its job rather than the seed failing to, since the easiest puzzle
   * drawn goes first whatever day it is; the worst pair measured is eight.
   */
  const SAME_SLOT_CEILING = 16;

  const idsFor = (day: number) =>
    rushSequence(puzzles, dailyRushSeed(day)).map((puzzle) => puzzle.id);

  test("a substantial part of the sequence turns over each day", () => {
    for (let day = 1; day <= DAYS_SAMPLED; day++) {
      const today = idsFor(day);
      const tomorrow = idsFor(day + 1);
      const tomorrowSet = new Set(tomorrow);
      const shared = today.filter((id) => tomorrowSet.has(id)).length;
      const sameSlot = today.filter((id, index) => tomorrow[index] === id).length;
      expect(shared).toBeLessThanOrEqual(SHARED_PUZZLE_CEILING);
      expect(sameSlot).toBeLessThanOrEqual(SAME_SLOT_CEILING);
      expect(today).not.toEqual(tomorrow);
    }
  });

  test("no two days in a decade share a seed", () => {
    const seeds = new Set<number>();
    for (let day = 1; day <= 3650; day++) seeds.add(dailyRushSeed(day));
    expect(seeds.size).toBe(3650);
  });
});

describe("the rush seed against the daily rotation's own", () => {
  const YEAR_OF_DAYS = 365;

  /**
   * How often a year of rushes may open with that day's own daily puzzle.
   *
   * Being seeded apart buys independence, not a guarantee: a rush draws forty
   * of a hundred and thirty-seven and ramps them, so its opener lands on the
   * daily puzzle roughly once in a hundred and thirty-seven days by chance
   * alone, which is two or three times a year. Seeding the two in lockstep
   * would put it there on all three hundred and sixty-five, and that is what
   * this rules out. It is a decorrelation check and not a promise of never.
   */
  const OPENER_COLLISION_CEILING = 12;

  test("the opener is not locked to the puzzle the player just played", () => {
    // The day deals three now, one per tier, each on its own rotation — so the
    // opener has three puzzles to avoid rather than one. The streams here must
    // match PuzzleArchive.STREAM or this measures a rotation nobody plays.
    const tiers = byTier(puzzles);
    const streams = { easy: 1, medium: 2, hard: 3 } as const;
    let collisions = 0;
    for (let day = 1; day <= YEAR_OF_DAYS; day++) {
      const today = DAILY_TIERS.map(
        (tier) => tiers[tier][puzzleIndexForDay(day, tiers[tier].length, streams[tier])]!.id,
      );
      const opener = rushSequence(puzzles, dailyRushSeed(day))[0]!;
      if (today.includes(opener.id)) collisions++;
    }
    expect(collisions).toBeLessThanOrEqual(OPENER_COLLISION_CEILING);
  });

  test("the rush seed is not the day number the rotation counts in", () => {
    for (let day = 1; day <= YEAR_OF_DAYS; day++) {
      expect(dailyRushSeed(day)).not.toBe(day);
    }
  });
});

describe("seededShuffle", () => {
  // Duplicates on purpose: a shuffle that quietly drops or repeats an item
  // still passes a check that only compares sets.
  const items = Array.from({ length: 100 }, (_, index) => index % 7);
  const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b);

  test("keeps every item exactly as often as it was given", () => {
    for (const seed of SEEDS) {
      const shuffled = seededShuffle(items, seed);
      expect(shuffled).toHaveLength(items.length);
      expect(sorted(shuffled)).toEqual(sorted(items));
    }
  });

  test("the same seed gives the same order", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      expect(seededShuffle(items, seed)).toEqual(seededShuffle(items, seed));
    }
  });

  test("different seeds give different orders", () => {
    const orders = new Set(SEEDS.map((seed) => seededShuffle(items, seed).join(",")));
    expect(orders.size).toBe(SEEDS.length);
  });

  test("it really shuffles", () => {
    // A generator stuck at zero returns the list untouched and passes every
    // check above it.
    const ordered = Array.from({ length: 100 }, (_, index) => index);
    for (const seed of SEEDS) {
      const shuffled = seededShuffle(ordered, seed);
      const moved = shuffled.filter((value, index) => value !== ordered[index]).length;
      expect(moved).toBeGreaterThanOrEqual(ordered.length / 2);
    }
  });

  test("the caller's list comes back untouched", () => {
    const original = [...items];
    seededShuffle(items, 4242);
    expect(items).toEqual(original);
  });

  test("nothing to shuffle is not an error", () => {
    expect(seededShuffle([], 5)).toEqual([]);
    expect(seededShuffle(["only"], 5)).toEqual(["only"]);
  });

  test("shuffledIndices covers every position once", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      expect(sorted(shuffledIndices(50, seed))).toEqual(Array.from({ length: 50 }, (_, i) => i));
    }
  });
});

/**
 * The reference solution as keystrokes, with a mark recorded after each
 * placement so the log can be cut off part-way through — which is the shape of
 * every skipped puzzle in a rush.
 */
function solutionLog(puzzle: Puzzle): { events: InputEvent[]; afterStep: number[] } {
  const { engine } = createPuzzleEngine(setupFor(puzzle), DEFAULT_HANDLING);
  const events: InputEvent[] = [];
  const afterStep: number[] = [];
  let frame = 0;

  const tap = (key: GameKey) => {
    events.push({ frame, type: "keydown", data: { key, subframe: 0 } });
    events.push({ frame: frame + 1, type: "keyup", data: { key, subframe: 0 } });
    frame += FRAMES_PER_INPUT;
  };

  for (const step of solutionOf(puzzle)) {
    if (toLetter(engine.falling.symbol) !== step.piece) {
      tap("hold");
      engine.hold(false, true);
    }
    const route = findPaths(engine, step.cells)[0];
    if (!route) throw new Error(`unreachable placement for puzzle ${puzzle.id}`);
    for (const key of route) {
      tap(key);
      engine.press(key);
    }
    tap("hardDrop");
    engine.press("hardDrop");
    afterStep.push(events.length);
  }
  return { events, afterStep };
}

/** Where a log is cut: half the solution, so pieces are always left over. */
function halfway(puzzle: Puzzle): number {
  return Math.max(1, Math.floor(solutionOf(puzzle).length / 2));
}

/** What the archive says the first `steps` placements are worth. */
function attackThrough(puzzle: Puzzle, steps: number): number {
  return solutionOf(puzzle).slice(0, steps).reduce((total, step) => total + step.attack, 0);
}

describe("verifyRun on a log that stops mid-solution", () => {
  // The idle bound stops the replay once the log is exhausted and nothing has
  // locked for a while, which is the difference between a skip costing two
  // milliseconds and costing fifteen. It must not be the difference between a
  // skip scoring what it earned and scoring less. The expected numbers come
  // from the archive's own solution steps, so this compares the verifier to the
  // data rather than to itself.
  const sample = puzzles.filter((_, index) => index % 11 === 0);

  test.each(sample.map((puzzle) => [puzzle.id, puzzle] as const))(
    "scores the placements it saw and no fewer for puzzle %i",
    (_id, puzzle) => {
      const steps = halfway(puzzle);
      const { events, afterStep } = solutionLog(puzzle);
      const result = verifyRun(
        setupFor(puzzle),
        DEFAULT_HANDLING,
        events.slice(0, afterStep[steps - 1]!),
      );

      expect(result.placements).toHaveLength(steps);
      expect(result.attack).toBe(attackThrough(puzzle, steps));
      expect(result.toppedOut).toBe(false);
      // Half a solution is not a solve, so this is an abandoned puzzle in a
      // rush and the run must not be credited with one.
      expect(meetsTarget(result.attack, puzzle.targetAttack)).toBe(false);
    },
  );

  test("attack banked before the log stops is still counted", () => {
    // Most half-solutions have cleared nothing yet, so the sweep above would
    // pass against a verifier that scored every cut-off log as zero. This picks
    // the first puzzle in the sample whose first half does earn something.
    const puzzle = sample.find((candidate) => attackThrough(candidate, halfway(candidate)) > 0)!;
    const steps = halfway(puzzle);
    const { events, afterStep } = solutionLog(puzzle);
    const result = verifyRun(
      setupFor(puzzle),
      DEFAULT_HANDLING,
      events.slice(0, afterStep[steps - 1]!),
    );

    expect(result.attack).toBeGreaterThan(0);
    expect(result.attack).toBe(attackThrough(puzzle, steps));
    expect(result.clears.length).toBeGreaterThan(0);
  });
});

describe("verifyRun on a log with nothing in it", () => {
  /**
   * A full rush of abandoned segments, replayed.
   *
   * Before the idle bound each of these ticked all thirty simulated minutes for
   * nothing, about fifteen milliseconds of blocked event loop apiece, so
   * twenty-five of them cost the better part of a second. They now cost single
   * figures in total; a hundred and fifty leaves room for a slow machine and
   * still catches the ceiling coming back.
   */
  const ABANDONED_SEGMENTS = 25;
  const IDLE_BUDGET_MS = 150;

  test("scores nothing rather than crashing or hanging", () => {
    const result = verifyRun(setupFor(puzzles[0]!), DEFAULT_HANDLING, []);
    expect(result.placements).toEqual([]);
    expect(result.clears).toEqual([]);
    expect(result.attack).toBe(0);
    expect(result.durationMs).toBe(0);
    expect(result.toppedOut).toBe(false);
  });

  test("a rush full of them replays in well under a second", () => {
    const setups = Array.from({ length: ABANDONED_SEGMENTS }, (_, index) =>
      setupFor(puzzles[index % puzzles.length]!),
    );
    const started = performance.now();
    for (const setup of setups) verifyRun(setup, DEFAULT_HANDLING, []);
    expect(performance.now() - started).toBeLessThan(IDLE_BUDGET_MS);
  });
});
