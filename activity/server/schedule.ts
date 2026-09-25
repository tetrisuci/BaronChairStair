/**
 * What a day dealt, as a fact on file rather than a sum done again.
 *
 * The rotation is derived from the pool's *size*. `puzzleIndexForDay(day,
 * count, stream)` reads `count` three separate times — the cycle, the position
 * inside it, and the length handed to the shuffle — and `shuffledIndices` walks
 * Fisher-Yates down from `count - 1`, so a pool one puzzle bigger draws a
 * different first card and every draw after it moves too. Measured on the club
 * archive: one extra easy-band puzzle changes the easy puzzle for 239 of 245
 * finished days, and one extra rush-eligible puzzle changes 38 of the 40 slots
 * in every rush stack ever dealt.
 *
 * That was survivable only while the archive never grew. Accepted player
 * submissions make it grow, and a rotation that re-derives the past would leave
 * every finished leaderboard ranking people against a puzzle the server now
 * insists was never theirs — silently, because nothing in the derivation can
 * tell that it is answering about a day somebody already played.
 *
 * So: a day is derived exactly once, the first time anybody asks for it, and
 * written down. After that the row is the answer and the pool may grow
 * underneath it. Days that have not arrived yet are deliberately *not* written
 * down — that floating edge is what "a new puzzle joins the rotation" means.
 *
 * A layer over `PuzzleArchive` rather than a change inside it, on purpose. The
 * derivation is still the source for a day nobody has asked for, so it has to
 * keep working, and being tested, with no database anywhere near it.
 */

import {
  byTier, DAILY_TIERS, type DailyTier } from "../shared/daily";
import type { Puzzle } from "../shared/puzzle";
import { isRushEligible } from "../shared/rush";
import type { PastDays, Store } from "./db";
import type { DailyPuzzles, PuzzleArchive } from "./puzzles";

/**
 * The backfill's source: the rotation as it stands, for every day up to today.
 *
 * Lives here rather than in `server/db.ts` so the store stays a store — it
 * takes ids and gives them back, and knows nothing about how a day was chosen.
 * See {@link PastDays} for why the one-off derivation of finished days is
 * trustworthy exactly once.
 */
export function pastDaysOf(archive: PuzzleArchive): PastDays {
  return { throughDay: archive.currentDay(), puzzleIdsFor: (day) => derive(archive, day) };
}

/**
 * What a pool's rotation deals for a day, before anything is written down.
 *
 * One function for the backfill and the first-ask pin, because they must agree:
 * they are the same derivation run at two different moments, and a day pinned
 * one way by one and another way by the other would be a day that changed its
 * mind about the past depending on when the server first heard of it.
 */
function derive(archive: PuzzleArchive, day: number): Record<DailyTier, number> {
  return {
    easy: archive.forTier(day, "easy").id,
    medium: archive.forTier(day, "medium").id,
    hard: archive.forTier(day, "hard").id,
    extreme: archive.forTier(day, "extreme").id,
  };
}

export class DaySchedule {
  constructor(
    private readonly archive: PuzzleArchive,
    private readonly store: Store,
  ) {
    /*
     * Today's rush pool is pinned here rather than by the first ticket minted.
     *
     * The two halves of a day were freezing at different moments: the startup
     * backfill pins `day_puzzles` for today, but nothing pinned `day_rush`
     * until somebody actually started a rush — so between a start and that
     * day's first ticket the pool was still floating while the day's tiers were
     * already frozen. That gap is exactly where an acceptance lands, because
     * accepting a puzzle is what rebuilds the archive and restarts the server:
     * measured on a same-day restart, the day's tiers held and 37 of 40 rush
     * slots moved.
     *
     * It belongs here and not in `server/index.ts`, where a startup line is
     * unreachable from the test suite — which is why the gap went unnoticed.
     */
    this.rushPoolFor(this.archive.currentDay());
  }

  /** One tier's puzzle for a day: the pinned one, or the pin written just now. */
  forTier(day: number, tier: DailyTier): Puzzle {
    return this.resolve(day, `${tier} puzzle`, this.pinFor(day)[tier]);
  }

  /**
   * The puzzles for a given day number, defaulting to today.
   *
   * Memoised on the day, the same trade `PuzzleArchive.forDay` made and for the
   * same reason: four routes ask per request, and the cost is dominated by
   * `resetsAt` formatting a wall clock through Intl. Safe to memoise for a
   * stronger reason here than there — a pinned day cannot change, so the cache
   * cannot go stale within the day it was filled for.
   */
  private cached: DailyPuzzles | null = null;

  forDay(day: number = this.archive.currentDay()): DailyPuzzles {
    if (this.cached?.day === day) return this.cached;
    const ids = this.pinFor(day);
    this.cached = {
      day,
      puzzles: {
        easy: this.resolve(day, "easy puzzle", ids.easy),
        medium: this.resolve(day, "medium puzzle", ids.medium),
        hard: this.resolve(day, "hard puzzle", ids.hard),
        extreme: this.resolve(day, "extreme puzzle", ids.extreme),
      },
      resetsAt: this.archive.resetsAt(),
    };
    return this.cached;
  }

  today(): DailyPuzzles {
    return this.forDay();
  }

  /**
   * Writes down every day up to `day` from the pool as it stands, before the
   * pool changes underneath a running server.
   *
   * A day is pinned the first time anybody asks for it, and a server that
   * restarts has the boot backfill for whatever it missed. A pool that grows
   * *without* a restart has neither: a quiet day between the last one asked
   * for and today would be derived later from the bigger pool, which is a
   * different puzzle from the one this server would have dealt on it. So the
   * gap is closed first, from the pool that was live on those days.
   *
   * Today's rush pool too, and today most of all. Players are holding today's
   * tiers and ranked rush tickets right now, and a rush ticket carries a seed
   * and no pool identity — `sequenceFor` re-derives its forty from the pinned
   * pool when the run is handed in.
   *
   * Walks back only as far as the last day with anything on file. A day
   * pinned before `extreme` holds three rows and is topped up when viewed; it
   * is not this method's business to do that eagerly for every old day.
   */
  freezeThrough(day: number): void {
    let first = day;
    while (first > 1 && Object.keys(this.store.pinnedTiers(first - 1)).length === 0) first -= 1;
    for (let each = first; each <= day; each += 1) this.pinFor(each);
    this.rushPoolFor(day);
  }

  /**
   * Drops the memoised day, so a corrected title or difficulty on one of
   * today's puzzles is served without waiting for tomorrow. Safe because the
   * ids it would re-read are pinned, and `PuzzleArchive.reconcile` has already
   * refused to move the board under any of them.
   */
  forget(): void {
    this.cached = null;
  }

  /**
   * Which of a day's tiers a puzzle is, or null if it is not one of them.
   *
   * Answered from the ids alone, without resolving a puzzle. This gates the
   * archive's answer key — a puzzle it calls "none of today's" has its solution
   * handed out on request — so it must keep answering even for a day whose
   * puzzle has since left the archive, where {@link resolve} would rightly
   * refuse.
   */
  tierOfDay(day: number, puzzleId: number): DailyTier | null {
    const ids = this.pinFor(day);
    return DAILY_TIERS.find((tier) => ids[tier] === puzzleId) ?? null;
  }

  /**
   * The puzzles a day's rushes are drawn from.
   *
   * The pool, not the forty a rush deals. Only the ranked run of a day uses the
   * day's shared seed; every replay draws its own, so a table holding the forty
   * and read by every ticket would deal every practice run the identical stack
   * — a memory test, and a behaviour change nobody asked for. Freezing what
   * they are all drawn from fixes the drift and leaves the seed doing its job.
   *
   * This also closes a live bug, not just a historical one. The rush ticket
   * carries a seed and no pool identity, so a deploy inside the five-minute
   * window used to re-derive a different set of puzzles at scoring time and
   * mark an in-flight run against boards it had never been shown — a plausible
   * wrong score, with no error anywhere.
   *
   * Pinned in the archive's own load order after filtering, which is exactly
   * what `rushSequence` used to see, so the day this ships nothing moves.
   */
  rushPoolFor(day: number): Puzzle[] {
    const pinned =
      this.store.pinnedRushPool(day) ??
      this.store.pinRushPool(
        day,
        this.archive.puzzles
          .filter(isRushEligible)
          .map((puzzle) => ({ id: puzzle.id, difficulty: puzzle.difficulty })),
      );
    /*
     * Ordered by the difficulty the day was dealt with, not the one the archive
     * carries now.
     *
     * A pinned pool freezes the rush's MEMBERSHIP; `rushSequence` finishes by
     * sorting on `rushBand`, which reads `difficulty` — so freezing the ids and
     * reading their band live froze only half of it. Both ways of moving that
     * band are real: a reviewer can correct it, and `bun run puzzles` rewrites
     * `data/puzzles.json` wholesale from the club's sheet. Measured on the
     * second: editing one puzzle's rating and restarting left the membership
     * and the day's tiers untouched and moved 26 of 40 slots, which
     * `sequenceFor` then scores an in-flight ranked run against.
     *
     * Reading it back from `day_rush` rather than from the archive is what
     * closes both. An earlier version overlaid `archive.original(id)` — the
     * source file as it stands right now — which defended against the reviewer
     * and not against the rebuild, and also meant a correction never reached
     * the ladder on any day, including days pinned long afterwards.
     *
     * The rest of the puzzle is served corrected. A fixed title or goal is what
     * an officer meant to change, and neither is an ordering key.
     */
    return pinned.ids.map((id, index) => {
      const served = this.resolve(day, "rush pool member", id);
      const band = pinned.difficulties?.[index];
      return band !== undefined && band !== served.difficulty
        ? { ...served, difficulty: band }
        : served;
    });
  }

  /**
   * A day's ids: what is on file, or a derivation written down now.
   *
   * The write is what makes the first ask authoritative. Deriving and *not*
   * writing would leave the day floating until somebody happened to file a run,
   * which is the same drift with a smaller window.
   */
  /**
   * The day's puzzles, pinning them the first time anybody asks.
   *
   * A day pinned before `extreme` existed holds three rows, so `pinnedDay`
   * answers null for it and the day is topped up rather than left short. What
   * is already on file is kept — those puzzles were played — and only the
   * missing tier is derived.
   *
   * **Avoiding what the day already deals.** The old `hard` band ran from eight
   * upwards and the new `extreme` band from nine, so a puzzle pinned as that
   * day's hard can sit in today's extreme pool: deriving blind would hand the
   * same puzzle to a player twice on one day, on roughly one legacy day in
   * thirty. The derivation steps along that tier's own rotation until it finds
   * one the day does not already hold. Fresh days never enter this path — the
   * tiers partition the archive, so a complete derivation cannot collide.
   */
  private pinFor(day: number): Record<DailyTier, number> {
    const complete = this.store.pinnedDay(day);
    if (complete) return complete;

    const known = this.store.pinnedTiers(day);
    const taken = new Set(Object.values(known));
    const ids = {} as Record<DailyTier, number>;
    for (const tier of DAILY_TIERS) {
      const already = known[tier];
      if (already !== undefined) {
        ids[tier] = already;
        continue;
      }
      ids[tier] = this.freshFor(day, tier, taken);
      taken.add(ids[tier]);
    }
    return this.store.pinDay(day, ids);
  }

  /** This day's puzzle for a tier, stepped past anything the day already holds. */
  private freshFor(day: number, tier: DailyTier, taken: ReadonlySet<number>): number {
    const chosen = this.archive.forTier(day, tier);
    if (!taken.has(chosen.id)) return chosen.id;
    const pool = byTier(this.archive.all)[tier];
    const at = pool.findIndex((puzzle) => puzzle.id === chosen.id);
    for (let step = 1; step < pool.length; step += 1) {
      const next = pool[(at + step) % pool.length]!;
      if (!taken.has(next.id)) return next.id;
    }
    // Every puzzle in the tier is already on this day, which needs a pool of one
    // and a collision in it. Nothing better to offer than the derived answer.
    return chosen.id;
  }

  /**
   * A pinned id, as a puzzle.
   *
   * Throws rather than falling back to the derivation. A puzzle only leaves the
   * archive by being dropped from the club sheet and `bun run puzzles`
   * rewriting the file, and answering that with "here is what the rotation
   * would deal today instead" is the history rewrite this whole module exists
   * to prevent — quietly, and about the one day somebody would most want the
   * truth. Naming the day and the id is the honest failure.
   */
  private resolve(day: number, named: string, id: number): Puzzle {
    const puzzle = this.archive.get(id);
    if (!puzzle) {
      throw new Error(
        `Day ${day} was dealt puzzle ${id} as its ${named}, and it is no longer in the ` +
          "archive. A puzzle a day has already been dealt cannot be dropped from " +
          "data/puzzles.json.",
      );
    }
    return puzzle;
  }
}
