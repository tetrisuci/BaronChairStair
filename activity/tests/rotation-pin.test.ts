/**
 * A day's three puzzles, and the pool its rushes are drawn from, are recorded
 * facts rather than derived ones.
 *
 * The rotation is derived from the pool's *size*: `puzzleIndexForDay` reads
 * `puzzleCount` three separate times — the cycle, the position within it, and
 * the length handed to the shuffle — and `shuffledIndices` walks Fisher-Yates
 * down from `count - 1`, so a pool one puzzle bigger draws a different first
 * card and the divergence cascades from there. Measured on the club archive:
 * one extra easy-band puzzle moves the easy puzzle for 239 of 245 past days,
 * and one extra rush-eligible puzzle moves 38 of the 40 slots in every past
 * rush stack.
 *
 * That is the defect these pin. The archive is about to start growing —
 * accepted player submissions join it — and a pool that grows without this
 * would leave every finished day's leaderboard ranking people against a puzzle
 * the route now says was never theirs, with no error anywhere to say so.
 *
 * Each test runs the growth for real: one database, opened twice, with extra
 * puzzles in the pool the second time. Every one of them carries its own
 * control asserting that the raw derivation *did* move, because a pinning test
 * that passes against a pool which happened not to shift proves nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";
import { PuzzleArchive } from "../server/puzzles";
import { DaySchedule, pastDaysOf } from "../server/schedule";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";
import type { Puzzle } from "../shared/puzzle";
import { dailyRushSeed, isRushEligible, rushSequence } from "../shared/rush";

/**
 * Enough extra puzzles to shift the rotation, few enough to stay readable.
 *
 * All of them are difficulty 2 and three pieces long, so every one lands in
 * the easy band *and* is rush-eligible — the two pools this has to hold still.
 */
const COMMUNITY_PUZZLES = 5;

function community(id: number): Puzzle {
  return {
    id,
    title: `community ${id}`,
    author: "a player",
    difficulty: 2,
    goal: "Clear a TSD",
    set: null,
    board: ["ILLZZ.G...", "ILZZ......", "IL........", "I........."],
    queue: ["L", "Z", "T"],
    hold: null,
    targetAttack: 4,
  };
}

let dir: string;
let databasePath: string;
/** The archive as the club keeps it, and the same archive after acceptances. */
let clubPath: string;
let grownPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rotation-pin-"));
  databasePath = join(dir, "daily.sqlite");
  clubPath = join(dir, "puzzles.json");
  grownPath = join(dir, "puzzles-grown.json");

  // The real archive, not a fixture: the numbers in the header were measured on
  // it, and a synthetic pool of a convenient size would not reproduce them.
  const club: Puzzle[] = JSON.parse(readFileSync("data/puzzles.json", "utf8")).puzzles;
  const grown = [
    ...club,
    ...Array.from({ length: COMMUNITY_PUZZLES }, (_, index) => community(100_001 + index)),
  ];
  writeFileSync(clubPath, JSON.stringify({ puzzles: club }));
  writeFileSync(grownPath, JSON.stringify({ puzzles: grown }));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Opened {
  readonly archive: PuzzleArchive;
  readonly store: Store;
  readonly schedule: DaySchedule;
}

/**
 * A server start, as far as the rotation is concerned.
 *
 * Two of these never overlap in a test. The database is opened per Store and
 * nothing sets `busy_timeout`, so a second writer on the same file would fail
 * immediately rather than wait — which is a property of the store, not
 * something a test should be discovering.
 */
function open(puzzlesPath: string, overrides: Parameters<typeof PuzzleArchive.load>[3] = []): Opened {
  const archive = PuzzleArchive.load(puzzlesPath, {}, [], overrides);
  const store = new Store(databasePath, pastDaysOf(archive));
  return { archive, store, schedule: new DaySchedule(archive, store) };
}

const finishedDays = (archive: PuzzleArchive): number[] =>
  Array.from({ length: archive.currentDay() }, (_, index) => index + 1);

const dealtBy = (schedule: DaySchedule, day: number): number[] =>
  DAILY_TIERS.map((tier) => schedule.forTier(day, tier).id);

const derivedBy = (archive: PuzzleArchive, day: number): number[] =>
  DAILY_TIERS.map((tier) => archive.forTier(day, tier).id);

const stackFor = (pool: readonly Puzzle[], day: number): number[] =>
  rushSequence(pool, dailyRushSeed(day)).map((puzzle) => puzzle.id);

describe("the day's three survive the archive growing", () => {
  test("every day already played deals exactly what it dealt before", () => {
    const before = open(clubPath);
    const days = finishedDays(before.archive);
    const pinned = days.map((day) => dealtBy(before.schedule, day));
    before.store.close();

    const after = open(grownPath);
    try {
      expect(days.map((day) => dealtBy(after.schedule, day))).toEqual(pinned);

      // The control, and the reason the assertion above is not vacuous: the
      // untouched derivation really does move, for most of the archive's life.
      const moved = days.filter(
        (day) => derivedBy(after.archive, day).join() !== derivedBy(before.archive, day).join(),
      ).length;
      expect(moved).toBeGreaterThan(days.length / 2);
    } finally {
      after.store.close();
    }
  });

  test("a day nobody has reached yet still floats with the pool", () => {
    // The other half of the bargain. Freezing every day would mean an accepted
    // puzzle never appeared in the rotation at all, which is the whole point of
    // accepting it — so a day is written down when it is asked for, and not one
    // day sooner.
    const before = open(clubPath);
    const tomorrow = before.archive.currentDay() + 1;
    before.store.close();

    const after = open(grownPath);
    try {
      expect(dealtBy(after.schedule, tomorrow)).toEqual(derivedBy(after.archive, tomorrow));
    } finally {
      after.store.close();
    }
  });

  test("a puzzle that was never today's is never named as today's", () => {
    // `tierOfDay` gates the archive's answer key: a puzzle it calls "not one of
    // today's" gets its solution handed out on request. Derived, it changed its
    // mind the moment the pool grew, and yesterday's easy puzzle — which people
    // were still holding a prompt for — became fair game.
    const before = open(clubPath);
    const day = before.archive.currentDay();
    const easy = before.schedule.forTier(day, "easy").id;
    before.store.close();

    const after = open(grownPath);
    try {
      expect(after.schedule.tierOfDay(day, easy)).toBe("easy");
      expect(after.archive.tierOfDay(day, easy)).toBeNull();
    } finally {
      after.store.close();
    }
  });
});

describe("the day's rush stack survives the archive growing", () => {
  test("a pinned day deals the same forty, in the same order", () => {
    const before = open(clubPath);
    const day = before.archive.currentDay();
    const stack = stackFor(before.schedule.rushPoolFor(day), day);
    before.store.close();

    const after = open(grownPath);
    try {
      expect(stackFor(after.schedule.rushPoolFor(day), day)).toEqual(stack);

      // The control. This is the live bug as well as the historical one: the
      // rush ticket carries no pool identity, so a deploy inside the five
      // minutes rescored an in-flight run against these puzzles instead.
      expect(stackFor(after.archive.puzzles, day)).not.toEqual(stack);
    } finally {
      after.store.close();
    }
  });

  test("the pinned pool is the eligible archive, in the order rush reads it", () => {
    // Pinning has to be a no-op on the day it ships, or it is itself the
    // reshuffle it exists to prevent.
    const opened = open(clubPath);
    try {
      const day = opened.archive.currentDay();
      expect(opened.schedule.rushPoolFor(day).map((puzzle) => puzzle.id)).toEqual(
        opened.archive.puzzles.filter(isRushEligible).map((puzzle) => puzzle.id),
      );
      expect(stackFor(opened.schedule.rushPoolFor(day), day)).toEqual(
        stackFor(opened.archive.puzzles, day),
      );
    } finally {
      opened.store.close();
    }
  });

  test("a replay still draws its own stack from the frozen pool", () => {
    // What must NOT be frozen. Only the ranked run gets the day's shared seed;
    // every replay draws its own, and pinning the forty rather than the pool
    // they come from would have turned every practice run into the same forty.
    const opened = open(clubPath);
    try {
      const day = opened.archive.currentDay();
      const pool = opened.schedule.rushPoolFor(day);
      const ranked = rushSequence(pool, dailyRushSeed(day)).map((puzzle) => puzzle.id);
      const practice = rushSequence(pool, 12_345).map((puzzle) => puzzle.id);
      expect(practice).not.toEqual(ranked);
    } finally {
      opened.store.close();
    }
  });
});

describe("what a pinned day is worth to the routes that read it", () => {
  test("the tier a run was filed under still names the puzzle it was played on", () => {
    // The shape of the solution leak this closes: a run is stored as
    // (day, tier, puzzle_id), and the routes matched a stored run to a freshly
    // derived puzzle on (day, tier) alone. Grow the pool and the third column
    // stopped agreeing, so a player who solved the old easy puzzle was handed
    // the new one's answer for a board they had never seen.
    const before = open(clubPath);
    const day = before.archive.currentDay();
    const played: Record<DailyTier, number> = {
      easy: before.schedule.forTier(day, "easy").id,
      medium: before.schedule.forTier(day, "medium").id,
      hard: before.schedule.forTier(day, "hard").id,
    };
    before.store.close();

    const after = open(grownPath);
    try {
      for (const tier of DAILY_TIERS) {
        expect(after.schedule.forTier(day, tier).id).toBe(played[tier]);
      }
    } finally {
      after.store.close();
    }
  });
});

/**
 * ── ADDED IN REVIEW. BOTH OF THESE FAIL AGAINST THE CURRENT CODE. ───────────
 *
 * They are here as the demonstration of two confirmed defects, not as a fix;
 * see the review report. Delete them only by making them pass.
 */
describe("what the pin still gets wrong about the day it ships on", () => {
  /**
   * A database whose runs were filed before any of this existed, opened for the
   * first time by a build that has the backfill — after the club rebuilt
   * `data/puzzles.json`.
   *
   * `new Store(path)` with no `PastDays` is exactly the constructor the old
   * build called: every table, and nothing written down.
   */
  function prePinDatabase(): Record<number, Record<DailyTier, number>> {
    const archive = PuzzleArchive.load(clubPath);
    const store = new Store(databasePath);
    const played: Record<number, Record<DailyTier, number>> = {};
    for (const day of [archive.currentDay() - 1, archive.currentDay()]) {
      const ids = {} as Record<DailyTier, number>;
      for (const tier of DAILY_TIERS) {
        const puzzle = archive.forTier(day, tier);
        ids[tier] = puzzle.id;
        store.recordRun(day, tier, puzzle.id, { id: "u1", username: "alice", avatarUrl: null }, "g1", {
          solved: true,
          attack: puzzle.targetAttack,
          targetAttack: puzzle.targetAttack,
          durationMs: 1000,
          totalMs: 1000,
          resets: 0,
          piecesPlaced: 4,
          clears: [],
        });
      }
      played[day] = ids;
    }
    store.close();
    return played;
  }

  test("the backfill never contradicts a run already on file", () => {
    // The bug: `pinPastDays` derives every finished day from the pool it finds
    // at startup, and is right only if that pool has not grown since the last
    // day was played. Nothing checks that, and the check is free — `runs`
    // records `puzzle_id` for every (day, tier) anybody filed, which IS the
    // history the backfill is trying to reconstruct.
    //
    // Ship the pin in the same deploy as a `bun run puzzles` rebuild — an
    // entirely ordinary pairing — and the recap the bot posts names a puzzle
    // nobody was dealt, beside a leaderboard of people who solved the real one.
    const played = prePinDatabase();

    const after = open(grownPath);
    try {
      for (const [day, ids] of Object.entries(played)) {
        for (const tier of DAILY_TIERS) {
          expect(after.schedule.forTier(Number(day), tier).id).toBe(ids[tier]);
        }
      }
    } finally {
      after.store.close();
    }
  });

  test("a day's rush pool is written down when the day is, not when its first rush is", () => {
    // The bug: the backfill pins `day_puzzles` for today and nothing pins
    // `day_rush` at all, so the two halves of a day freeze at different
    // moments. Between a start and the day's first ticket the rush pool is
    // still floating — and that gap is exactly where an acceptance lands, since
    // accepting a puzzle is what restarts the server.
    //
    // Measured: the day's three hold across that restart and 37 of the 40 rush
    // slots move, while the day's rush leaderboard carries both stacks.
    const before = open(clubPath);
    const day = before.archive.currentDay();
    // Deliberately no `rushPoolFor` here: this is a start on which nobody
    // happened to open a rush before the acceptance landed.
    const stack = stackFor(before.archive.puzzles, day);
    before.store.close();

    const after = open(grownPath);
    try {
      expect(stackFor(after.schedule.rushPoolFor(day), day)).toEqual(stack);
    } finally {
      after.store.close();
    }
  });
});

describe("a reviewer's correction survives the same way growth does", () => {
  /*
   * Difficulty is the field this suite did not know was rotation input. It is
   * what `byTier` partitions the daily on and what `rushBand` sorts a rush
   * stack by — and it became editable when the review tool learned to correct
   * puzzle metadata. A pinned pool froze the rush's membership, so the *ids*
   * could not move; nothing froze the order they came in.
   */
  test("a difficulty correction moves neither a pinned day nor a pinned stack", () => {
    const before = open(clubPath);
    const day = before.archive.currentDay() - 1;
    const days = finishedDays(before.archive);
    const pinnedDays = days.map((each) => dealtBy(before.schedule, each));
    const pinnedStack = stackFor(before.schedule.rushPoolFor(day), day);

    // A puzzle genuinely in this day's forty, moved to the other end of the
    // scale — the correction an officer makes when a rating is plainly wrong.
    const victim = before.archive.get(pinnedStack[20]!)!;
    const corrected = victim.difficulty > 5 ? 1 : 20;
    before.store.setOverride(victim.id, { difficulty: corrected }, "reviewer");
    const overrides = before.store.overridesFor();

    const after = open(clubPath, overrides);
    expect(days.map((each) => dealtBy(after.schedule, each))).toEqual(pinnedDays);
    expect(stackFor(after.schedule.rushPoolFor(day), day)).toEqual(pinnedStack);

    // And the correction is real rather than the test having failed to make
    // one: the same pool ordered by the *corrected* difficulty does move, which
    // is precisely what `rushPoolFor` freezing the ordering key prevents.
    const pool = after.store.pinnedRushPool(day)!.map((id) => after.archive.get(id)!);
    expect(stackFor(pool, day)).not.toEqual(pinnedStack);
  });

  test("a correction that would empty a tier is refused whole, not at the boot", () => {
    // `byTier` throws in the constructor when a band is empty — at module
    // scope, before any route exists. The server would not start, and the
    // DELETE that undoes the correction lives on that server, so the way back
    // was reachable only through sqlite3.
    const before = open(clubPath);
    const easy = before.archive.puzzles.filter((puzzle) => puzzle.difficulty > 0 && puzzle.difficulty <= 4);
    for (const puzzle of easy) before.store.setOverride(puzzle.id, { difficulty: 20 }, "reviewer");

    const after = open(clubPath, before.store.overridesFor());
    // It boots, serving what the club wrote, so the officer's next DELETE
    // lands on a server that is running.
    expect(after.archive.puzzles.length).toBe(before.archive.puzzles.length);
    expect(after.archive.get(easy[0]!.id)!.difficulty).toBe(easy[0]!.difficulty);
  });
});
