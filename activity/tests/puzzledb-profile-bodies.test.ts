/**
 * The profile browser's bodies: a player's tier summaries and cleared list,
 * the players table, and the steering body the solves feed reads.
 *
 * Built from hand-written read-back data, so each case says exactly which
 * rows went in. What reaches that data — the snapshot, the build's cuts, the
 * public database — is tested beside the code that does it; this is the last
 * step, from the public database's rows to the bytes a page fetches.
 *
 * **The size of each body is part of the contract.** The feed exists to show
 * a year of solves without a year in one file, so a synthetic year of a busy
 * club is built here and every body measured: a day's body must not move as
 * history grows, the players table must not grow with days, and the steering
 * body may grow by one short line a day and no more.
 */

import { describe, expect, test } from "bun:test";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";
import { buildBodies } from "../puzzledb/server/bodies";
import { playersBody, solvesBody, tierSummaries } from "../puzzledb/server/bodies-profiles";
import type { PlayerData } from "../puzzledb/server/public-db-players";
import {
  bodyPathFor,
  dateOfDay,
  type PlayerRef,
  SCHEMA_VERSION,
  type SiteData,
  type SitePlayerBody,
  type SitePlayerTotals,
  type SiteTierRow,
} from "../puzzledb/wire";
import type { SitePlayersBody, SiteSolvesBody } from "../puzzledb/wire-profiles";

const BUILT_AT = "2026-10-02T19:00:00.000Z";
const ADA = { key: "adaadaada2", name: "ada" } as const;
const BEN = { key: "benbenben2", name: "Ben" } as const;
const CLUB = "clubclub22";
const OTHER = "otherothe2";
const QUIET = "quietquie2";

type TierRow = PlayerData["tierRows"][number];

function tierRow(player: PlayerRef, day: number, tier: DailyTier, extra: Partial<SiteTierRow> = {}): TierRow {
  return {
    day,
    tier,
    rank: 1,
    serverKey: CLUB,
    player,
    puzzleId: 50,
    solved: true,
    timeMs: 60_000,
    attack: 6,
    targetAttack: 6,
    ...extra,
  };
}

function totals(extra: Partial<SitePlayerTotals> = {}): SitePlayerTotals {
  return {
    daysSolved: 1,
    dailies: 1,
    currentStreak: 0,
    bestStreak: 1,
    puzzlesCleared: 0,
    linesFound: 0,
    rushRuns: 0,
    rushBest: null,
    rushBestMs: null,
    rushBestDay: null,
    ...extra,
  };
}

function playerData(extra: Partial<PlayerData> = {}): PlayerData {
  return {
    players: [ADA, BEN].map((player) => ({ ...player, daysSolved: 1, bestStreak: 1 })),
    totals: new Map([
      [ADA.key, totals()],
      [BEN.key, totals()],
    ]),
    cleared: new Map(),
    servers: [],
    tierRows: [],
    dayBoardRows: [],
    rushRows: [],
    standings: [],
    stats: new Map(),
    lines: [],
    ...extra,
  };
}

function siteData(players: PlayerData, days: readonly number[] = []): SiteData {
  return {
    about: { schema: SCHEMA_VERSION, builtAt: BUILT_AT, firstDay: days[0] ?? 0, throughDay: days.at(-1) ?? null },
    puzzles: [],
    days: days.map((day) => ({ day, date: dateOfDay(day), deals: DAILY_TIERS.map((tier) => ({ tier, puzzleId: 50 })) })),
    players: players.players,
    servers: players.servers,
  };
}

function decoded<T>(bodies: ReadonlyMap<string, Uint8Array>, path: string | null): T {
  const bytes = path === null ? undefined : bodies.get(path);
  if (!bytes) throw new Error(`no body at ${path}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

describe("a player's tier summaries", () => {
  test("are always four, in the daily's order, a tier never played reading zeros and nulls", () => {
    const summaries = tierSummaries([tierRow(ADA, 10, "hard"), tierRow(ADA, 11, "easy", { solved: false, timeMs: null })]);

    expect(summaries.map((summary) => summary.tier)).toEqual([...DAILY_TIERS]);
    expect(summaries[0]).toEqual({ tier: "easy", handIns: 1, solves: 0, bestMs: null, bestDay: null, medianMs: null });
    expect(summaries[1]).toEqual({ tier: "medium", handIns: 0, solves: 0, bestMs: null, bestDay: null, medianMs: null });
    expect(summaries[2]).toEqual({ tier: "hard", handIns: 1, solves: 1, bestMs: 60_000, bestDay: 10, medianMs: 60_000 });
  });

  test("give a tied best to the earliest day it was set on, whatever order the rows came in", () => {
    const rows = [12, 10, 11].map((day) => tierRow(ADA, day, "easy", { timeMs: day === 11 ? 70_000 : 50_000 }));

    expect(tierSummaries(rows)[0]).toMatchObject({ handIns: 3, solves: 3, bestMs: 50_000, bestDay: 10, medianMs: 50_000 });
  });

  test("take the median of the solves alone, an even count's two middles rounded to a millisecond", () => {
    const rows = [
      tierRow(ADA, 10, "medium", { timeMs: 41_001 }),
      tierRow(ADA, 11, "medium", { timeMs: 41_002 }),
      tierRow(ADA, 12, "medium", { solved: false, timeMs: null }),
    ];

    expect(tierSummaries(rows)[1]).toMatchObject({ handIns: 3, solves: 2, bestMs: 41_001, medianMs: 41_002 });
  });
});

describe("a player's body", () => {
  test("carries their tier summaries and their cleared list, an empty list for none", () => {
    const players = playerData({
      tierRows: [tierRow(ADA, 10, "easy"), tierRow(BEN, 10, "easy", { timeMs: 61_000 }), tierRow(null, 10, "easy")],
      cleared: new Map([[ADA.key, [6, 50]]]),
    });
    const bodies = buildBodies(siteData(players, [10]), players);
    const ada = decoded<SitePlayerBody>(bodies, bodyPathFor({ kind: "player", key: ADA.key }));
    const ben = decoded<SitePlayerBody>(bodies, bodyPathFor({ kind: "player", key: BEN.key }));

    expect(ada.cleared).toEqual([6, 50]);
    expect(ben.cleared).toEqual([]);
    expect(ada.tiers).toEqual(tierSummaries([players.tierRows[0]!]));
    expect(ben.tiers[0]).toMatchObject({ handIns: 1, solves: 1, bestMs: 61_000 });
  });
});

describe("the players table", () => {
  test("has one row per listed player in the index's order, with the totals' numbers", () => {
    const players = playerData({
      totals: new Map([
        [ADA.key, totals({ puzzlesCleared: 9, linesFound: 2, rushBest: 7, rushBestMs: 170_000 })],
        [BEN.key, totals({ puzzlesCleared: 3 })],
      ]),
    });

    expect(playersBody(players, BUILT_AT)).toEqual({
      builtAt: BUILT_AT,
      rows: [
        { key: ADA.key, puzzlesCleared: 9, linesFound: 2, rushBest: 7, rushBestMs: 170_000, servers: [] },
        { key: BEN.key, puzzlesCleared: 3, linesFound: 0, rushBest: null, rushBestMs: null, servers: [] },
      ],
    });
  });

  test("lists the servers each player handed in or rushed in, sorted, once each, a play outside any server adding none", () => {
    const players = playerData({
      tierRows: [
        tierRow(ADA, 10, "easy", { serverKey: OTHER }),
        tierRow(ADA, 10, "hard", { serverKey: CLUB, solved: false, timeMs: null }),
        tierRow(ADA, 11, "easy", { serverKey: OTHER }),
        tierRow(BEN, 10, "easy", { serverKey: null }),
        tierRow(null, 10, "medium", { serverKey: QUIET }),
      ],
      rushRows: [
        { day: 10, rank: 1, serverKey: QUIET, player: BEN, solved: 4, timeMs: 100_000 },
        { day: 10, rank: 2, serverKey: null, player: ADA, solved: 3, timeMs: 100_000 },
      ],
    });

    const rows = playersBody(players, BUILT_AT).rows;

    expect(rows.map((row) => [row.key, row.servers])).toEqual([
      [ADA.key, [CLUB, OTHER]],
      [BEN.key, [QUIET]],
    ]);
  });

  test("holds no row for a player who hid, and no name for anybody: the index has the names", () => {
    const players = playerData({ tierRows: [tierRow(null, 10, "easy", { serverKey: QUIET })] });
    const body = playersBody(players, BUILT_AT);

    expect(JSON.stringify(body)).not.toContain(QUIET);
    expect(JSON.stringify(body)).not.toContain(BEN.name);
    expect(body.rows.map((row) => row.key)).toEqual([ADA.key, BEN.key]);
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual(["key", "linesFound", "puzzlesCleared", "rushBest", "rushBestMs", "servers"]);
    }
  });
});

describe("the solves feed's steering", () => {
  test("lists each finished day with a solve, newest first, counting solves per tier and the servers they were in", () => {
    const players = playerData({
      tierRows: [
        tierRow(ADA, 10, "easy"),
        tierRow(BEN, 10, "easy", { serverKey: OTHER }),
        tierRow(null, 10, "hard", { serverKey: QUIET }),
        tierRow(ADA, 11, "medium", { solved: false, timeMs: null, serverKey: OTHER }),
        tierRow(BEN, 11, "extreme", { serverKey: null }),
        tierRow(ADA, 12, "easy", { solved: false, timeMs: null }),
      ],
    });

    expect(solvesBody(players, BUILT_AT)).toEqual({
      builtAt: BUILT_AT,
      days: [
        { day: 11, tiers: { easy: 0, medium: 0, hard: 0, extreme: 1 }, servers: [] },
        { day: 10, tiers: { easy: 2, medium: 0, hard: 1, extreme: 0 }, servers: [CLUB, OTHER, QUIET] },
      ],
    });
  });

  test("is served at its own path beside the players table, both from one build", () => {
    const players = playerData({ tierRows: [tierRow(ADA, 10, "easy")] });
    const bodies = buildBodies(siteData(players, [10]), players);

    expect(decoded<SiteSolvesBody>(bodies, bodyPathFor({ kind: "solves" }))).toEqual(solvesBody(players, BUILT_AT));
    expect(decoded<SitePlayersBody>(bodies, bodyPathFor({ kind: "players" }))).toEqual(playersBody(players, BUILT_AT));
  });
});

/** Sizes measured over a synthetic year: a busy club of 40, four tiers a day, a rush a day, three servers. */
const PLAYERS = 40;
const SERVERS = ["clubclub22", "otherothe2", "thirdthir2"] as const;
const FIRST_DAY = 100;

/**
 * Bytes of a JSON body, before compression. Measured when written: a day of
 * this club is about 43 KB (under 3 KB gzipped), the players table about 4 KB,
 * and the steering body about 118 bytes a day, 43 KB for the year.
 */
const KB = 1024;
const DAY_BODY_LIMIT = 48 * KB;
const PLAYERS_BODY_LIMIT = 8 * KB;
const SOLVES_BODY_LIMIT = 48 * KB;
const SOLVES_BYTES_PER_DAY = 160;

function syntheticYear(dayCount: number): PlayerData {
  const people = Array.from({ length: PLAYERS }, (_, at) => ({ key: `pl${String(at).padStart(2, "0")}aaaaa2`, name: `player-${at}` }));
  const refOf = (at: number): PlayerRef => (at % 10 === 9 ? null : people[at]!);
  const days = Array.from({ length: dayCount }, (_, at) => FIRST_DAY + at);
  const tierRows = days.flatMap((day) =>
    DAILY_TIERS.flatMap((tier, t) =>
      people.map((_, at) => {
        const solved = (at + day + t) % 5 !== 0;
        const timeMs = solved ? 30_000 + ((at * 7_919 + day * 104_729 + t) % 600_000) : null;
        return tierRow(refOf(at), day, tier, { serverKey: SERVERS[at % 3]!, solved, timeMs, puzzleId: ((day * 4 + t) % 138) + 1, rank: at + 1 });
      }),
    ),
  );
  const rushRows = days.flatMap((day) =>
    people.map((_, at) => ({ day, rank: at + 1, serverKey: SERVERS[at % 3]!, player: refOf(at), solved: 10 - (at % 7), timeMs: 170_000 + at })),
  );
  const dayBoardRows = days.flatMap((day) =>
    [...SERVERS.map((key) => [key, PLAYERS / 3] as const), ["all", PLAYERS] as const].flatMap(([scope, count]) =>
      people.slice(0, Math.ceil(count)).map((_, at) => ({
        day, scope, rank: at + 1, player: refOf(at), solved: 3, timeMs: 400_000 + at, marks: { easy: 2, medium: 2, hard: 2, extreme: 1 } as const,
      })),
    ),
  );
  const shown = people.filter((_, at) => refOf(at) !== null);
  return playerData({
    players: shown.map((person) => ({ ...person, daysSolved: dayCount, bestStreak: dayCount })),
    totals: new Map(shown.map((person) => [person.key, totals({ daysSolved: dayCount, dailies: dayCount * 3, puzzlesCleared: 120, rushRuns: dayCount, rushBest: 10, rushBestMs: 170_000 })])),
    cleared: new Map(shown.map((person) => [person.key, Array.from({ length: 120 }, (_, at) => at + 1)])),
    tierRows,
    rushRows,
    dayBoardRows,
  });
}

describe("over a year of a busy club", () => {
  const year = syntheticYear(365);
  const month = syntheticYear(30);
  const yearDays = Array.from({ length: 365 }, (_, at) => FIRST_DAY + at);
  const yearBodies = buildBodies(siteData(year, yearDays), year);
  const monthBodies = buildBodies(siteData(month, yearDays.slice(0, 30)), month);
  const size = (bodies: ReadonlyMap<string, Uint8Array>, path: string | null) => bodies.get(path!)?.byteLength ?? 0;

  test("keeps every day's body the same bytes however long history grows, and each within a fixed size", () => {
    const dayPaths = [...yearBodies.keys()].filter((path) => path.startsWith("/data/day/"));

    expect(dayPaths).toHaveLength(365);
    for (const path of dayPaths) expect(size(yearBodies, path)).toBeLessThan(DAY_BODY_LIMIT);
    for (const path of [...monthBodies.keys()].filter((each) => each.startsWith("/data/day/"))) {
      expect(Buffer.from(yearBodies.get(path)!).equals(Buffer.from(monthBodies.get(path)!))).toBe(true);
    }
  });

  test("keeps the players table the same size for a month and a year of the same people", () => {
    const path = bodyPathFor({ kind: "players" });

    expect(size(yearBodies, path)).toBeLessThan(PLAYERS_BODY_LIMIT);
    // Only the totals' own digits may differ.
    expect(Math.abs(size(yearBodies, path) - size(monthBodies, path))).toBeLessThan(PLAYERS * 8);
  });

  test("grows the steering body by no more than a short line a day", () => {
    const path = bodyPathFor({ kind: "solves" });
    const perDay = (size(yearBodies, path) - size(monthBodies, path)) / (365 - 30);

    expect(size(yearBodies, path)).toBeLessThan(SOLVES_BODY_LIMIT);
    expect(perDay).toBeGreaterThan(0);
    expect(perDay).toBeLessThanOrEqual(SOLVES_BYTES_PER_DAY);
    expect(decoded<SiteSolvesBody>(yearBodies, path).days).toHaveLength(365);
  });
});
