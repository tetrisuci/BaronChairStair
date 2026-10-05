/**
 * The field names of the profile browser's bodies, pinned for both halves.
 *
 * The build writes `/data/players.json`, `/data/solves.json` and the player
 * body's tiers and cleared list; the page reads them. Written in two places by
 * two hands, a field spelt `bestTime` on one side and `bestMs` on the other is a
 * column that renders a dash for everyone and fails nothing. So each shape's
 * keys are spelt out here once, as a `Record` over `keyof` the shape: the type
 * checker refuses a key the shape lacks and a key the shape has that this file
 * does not, and the test then holds the list itself.
 */

import { describe, expect, test } from "bun:test";
import { DAILY_TIERS } from "../shared/daily";
import type { SitePlayerBody, SiteTierSummary } from "../puzzledb/wire";
import type { SitePlayerListRow, SitePlayersBody, SiteSolvesBody, SiteSolvesDay } from "../puzzledb/wire-profiles";

/** Every key of `T`, and only those: an object literal of this type is the key list, checked both ways. */
type EveryKey<T> = { readonly [K in keyof T]-?: true };

const sorted = (keys: object): string[] => Object.keys(keys).sort();

describe("the profile browser's body shapes", () => {
  test("a tier summary carries hand-ins, solves, best with its day, and the median", () => {
    const keys: EveryKey<SiteTierSummary> = {
      tier: true,
      handIns: true,
      solves: true,
      bestMs: true,
      bestDay: true,
      medianMs: true,
    };
    const unplayed: SiteTierSummary = {
      tier: "extreme",
      handIns: 0,
      solves: 0,
      bestMs: null,
      bestDay: null,
      medianMs: null,
    };

    expect(sorted(keys)).toEqual(["bestDay", "bestMs", "handIns", "medianMs", "solves", "tier"]);
    expect(sorted(unplayed)).toEqual(sorted(keys));
  });

  test("a player body adds four tiers and a cleared list to #92's totals, runs and rushes", () => {
    const keys: EveryKey<SitePlayerBody> = {
      builtAt: true,
      totals: true,
      runs: true,
      rush: true,
      tiers: true,
      cleared: true,
    };
    const tiers: readonly SiteTierSummary[] = DAILY_TIERS.map((tier) => ({
      tier,
      handIns: 0,
      solves: 0,
      bestMs: null,
      bestDay: null,
      medianMs: null,
    }));
    const body: SitePlayerBody = {
      builtAt: "2026-10-04T00:00:00.000Z",
      totals: {
        daysSolved: 0,
        dailies: 0,
        currentStreak: 0,
        bestStreak: 0,
        puzzlesCleared: 2,
        linesFound: 0,
        rushRuns: 0,
        rushBest: null,
        rushBestMs: null,
        rushBestDay: null,
      },
      runs: [],
      rush: [],
      tiers,
      cleared: [12, 42],
    };

    expect(sorted(keys)).toEqual(["builtAt", "cleared", "runs", "rush", "tiers", "totals"]);
    expect(body.tiers.map((summary) => summary.tier)).toEqual([...DAILY_TIERS]);
  });

  test("a players-table row carries a key and the table's numbers, never a name", () => {
    const keys: EveryKey<SitePlayerListRow> = {
      key: true,
      puzzlesCleared: true,
      linesFound: true,
      rushBest: true,
      rushBestMs: true,
      servers: true,
    };
    const body: SitePlayersBody = {
      builtAt: "2026-10-04T00:00:00.000Z",
      rows: [{ key: "k7m2p9xq4w", puzzlesCleared: 88, linesFound: 6, rushBest: null, rushBestMs: null, servers: [] }],
    };
    const bodyKeys: EveryKey<SitePlayersBody> = { builtAt: true, rows: true };

    expect(sorted(keys)).toEqual(["key", "linesFound", "puzzlesCleared", "rushBest", "rushBestMs", "servers"]);
    // The name is the index's, alone, so one page can never show a person two ways.
    expect(sorted(keys)).not.toContain("name");
    expect(sorted(bodyKeys)).toEqual(["builtAt", "rows"]);
    expect(sorted(body.rows[0]!)).toEqual(sorted(keys));
  });

  test("a solves-steering day carries counts per tier and server keys, and no rows", () => {
    const keys: EveryKey<SiteSolvesDay> = { day: true, tiers: true, servers: true };
    const day: SiteSolvesDay = {
      day: 274,
      tiers: { easy: 3, medium: 0, hard: 1, extreme: 0 },
      servers: ["k7m2p9xq4w"],
    };
    const body: SiteSolvesBody = { builtAt: "2026-10-04T00:00:00.000Z", days: [day] };
    const bodyKeys: EveryKey<SiteSolvesBody> = { builtAt: true, days: true };

    expect(sorted(keys)).toEqual(["day", "servers", "tiers"]);
    expect(sorted(bodyKeys)).toEqual(["builtAt", "days"]);
    // Every tier is named, a tier nobody solved as 0, so the feed never reads undefined as "none".
    expect(Object.keys(body.days[0]!.tiers).sort()).toEqual([...DAILY_TIERS].sort());
  });
});
