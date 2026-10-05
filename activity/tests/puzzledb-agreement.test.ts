/**
 * The site's boards against the game's own, over one database.
 *
 * db.tetrisatuci.org cannot import the game's `Store` — constructing it
 * migrates the file it opens — so it re-asks each of the game's questions in
 * its own SQL. Two spellings of one question drift, and the drift is quiet: a
 * board on the site that disagrees with the game's by one row, on one day,
 * for one player. So the game's own methods are the oracle here, run over a
 * copy of the fixture with today taken out (the site never shows today, and
 * the game's all-time boards include it), and every published board is
 * checked against them.
 *
 * **Compared as multisets.** The game breaks no ties the site could repeat:
 * a tie falls in whatever order SQLite hands back, which is id order, and the
 * site deliberately ranks by published columns instead. So each comparison is
 * of the rows, sorted the same way on both sides, not of their ranks.
 *
 * **A hidden player is "a player" on the site and a name in the game**, so the
 * game's rows are mapped through the fixture's cast — a shown player to their
 * key and name, anyone else to null — before they are compared.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { type PlayerProfile, Store } from "../server/db";
import { CREDITED } from "../server/discovery-sql";
import { DAILY_TIERS, startOfDay } from "../shared/daily";
import { buildDataset } from "../puzzledb/server/dataset";
import { FIRST_TIERED_DAY, POLICY } from "../puzzledb/server/policy";
import { openGameDatabase, readSnapshot } from "../puzzledb/server/snapshot";
import type { Dataset } from "../puzzledb/server/types";
import {
  ALL_SERVERS,
  type PlayerRef,
  type SiteDayBody,
  type SiteLeaderboardsBody,
  type SitePlayerBody,
  type SitePuzzleBody,
  type SiteStanding,
} from "../puzzledb/wire";
import {
  fixtureSources,
  gameFixture,
  type GameFixture,
  LA,
  NOW,
  PLAYERS,
  type PlayerRole,
  SERVERS,
  TODAY,
} from "./puzzledb-fixture";

const BIG = 10_000;

let game: GameFixture;
let dataset: Dataset;
/** The game's Store over a copy with today taken out, and that copy's path. */
let store: Store;
let trimmed: string;
/** The game's Store over the untouched copy, for the one difference that is documented. */
let full: Store;

beforeAll(() => {
  game = gameFixture({ journal: "delete" });
  const db = openGameDatabase(game.databasePath);
  try {
    dataset = buildDataset(readSnapshot(db, TODAY, FIRST_TIERED_DAY), fixtureSources(game), NOW, {
      ...POLICY,
      hiddenServerKeys: new Set([SERVERS.quiet.key]),
    });
  } finally {
    db.close();
  }
  trimmed = join(game.dir, "without-today.sqlite");
  copyFileSync(game.databasePath, trimmed);
  withoutToday(trimmed);
  store = new Store(trimmed, undefined, { timeZone: LA });
  // Every boot backfills clears from solved runs, stamped with the real clock,
  // which is past the fixture's today; taking today out again takes those too.
  withoutToday(trimmed);
  const untouched = join(game.dir, "untouched.sqlite");
  copyFileSync(game.databasePath, untouched);
  full = new Store(untouched, undefined, { timeZone: LA });
});

afterAll(() => {
  store?.close();
  full?.close();
  game?.cleanup();
});

/** A database as it stood at the game's midnight: everything filed today, gone. */
function withoutToday(path: string): void {
  const midnight = startOfDay(TODAY, { timeZone: LA });
  const db = new Database(path, { readwrite: true });
  try {
    db.run("DELETE FROM runs WHERE day >= ?1", [TODAY]);
    db.run("DELETE FROM rush_runs WHERE day >= ?1", [TODAY]);
    db.run("DELETE FROM puzzle_solutions WHERE found_at >= ?1", [midnight]);
    db.run("DELETE FROM puzzle_clears WHERE first_at >= ?1", [midnight]);
  } finally {
    db.close();
  }
}

const ROLE_BY_ID = new Map((Object.keys(PLAYERS) as PlayerRole[]).map((role) => [PLAYERS[role].id, role]));

/** How the site must show a player the game names: by key and name if shown, else "a player". */
function siteRef(player: PlayerProfile): PlayerRef {
  const role = ROLE_BY_ID.get(player.id);
  if (!role) throw new Error("The game named a player the fixture never planted");
  const shown = role === "visible" || role === "unchosen";
  return shown ? { key: PLAYERS[role].key, name: PLAYERS[role].name } : null;
}

function body<T>(path: string): T {
  const bytes = dataset.bodies.get(path);
  if (!bytes) throw new Error(`no body at ${path}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** Rows as a multiset: each row's JSON, sorted. */
function multiset(rows: readonly unknown[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

const SCOPES: readonly (readonly [string, string | null])[] = [
  [ALL_SERVERS, null],
  ...Object.values(SERVERS).map((server) => [server.key, server.id] as const),
];

const shownDays = () => dataset.data.days.map((day) => day.day);

describe("a finished day", () => {
  test("has the game's day board, in every scope", () => {
    for (const day of shownDays()) {
      const boards = body<SiteDayBody>(`/data/day/${day}.json`).boards;
      for (const [scope, guildId] of SCOPES) {
        const game = store.dayBoard(day, guildId, BIG).map((row) => ({
          player: siteRef(row.player),
          solved: row.solved,
          timeMs: row.totalMs,
          marks: row.marks,
        }));
        const site = (boards[scope] ?? []).map((row) => ({
          player: row.player,
          solved: row.solved,
          timeMs: row.timeMs,
          marks: Object.fromEntries(
            DAILY_TIERS.flatMap((tier) => (row.marks[tier] ? [[tier, row.marks[tier] === 2]] : [])),
          ),
        }));
        expect(multiset(site)).toEqual(multiset(game));
      }
    }
  });

  test("has the game's tier boards, attack and all, in every scope", () => {
    for (const day of shownDays()) {
      const tiers = body<SiteDayBody>(`/data/day/${day}.json`).tiers;
      for (const [scope, guildId] of SCOPES) {
        for (const tier of DAILY_TIERS) {
          const game = store.leaderboard(day, guildId, tier, BIG).map((run) => [
            siteRef(run.player),
            run.solved,
            run.solved ? run.totalMs : null,
            run.attack,
            run.targetAttack,
          ]);
          const site = tiers
            .filter((row) => row.tier === tier && (scope === ALL_SERVERS || row.serverKey === scope))
            .map((row) => [row.player, row.solved, row.timeMs, row.attack, row.targetAttack]);
          expect(multiset(site)).toEqual(multiset(game));
        }
      }
    }
  });

  test("has the game's rush board, in every scope", () => {
    for (const day of shownDays()) {
      const rush = body<SiteDayBody>(`/data/day/${day}.json`).rush;
      for (const [scope, guildId] of SCOPES) {
        const game = store
          .rushLeaderboard(day, guildId, BIG)
          .map((run) => [siteRef(run.player), run.solved, run.timeToLastSolveMs]);
        const site = rush
          .filter((row) => scope === ALL_SERVERS || row.serverKey === scope)
          .map((row) => [row.player, row.solved, row.timeMs]);
        expect(multiset(site)).toEqual(multiset(game));
      }
    }
  });
});

describe("the all-time boards", () => {
  const boards = () => body<SiteLeaderboardsBody>("/data/leaderboards.json").boards;
  const values = (rows: readonly SiteStanding[] | undefined) => multiset((rows ?? []).map((row) => [row.player, row.value]));

  test("have the game's rush records before today, in every scope", () => {
    for (const [scope, guildId] of SCOPES) {
      const game = store
        .rushRecords(guildId, BIG)
        .filter((record) => record.solved > 0)
        .map((record) => [siteRef(record.player), record.solved, record.timeToLastSolveMs, record.day]);
      const site = (boards().rush[scope] ?? []).map((row) => [row.player, row.value, row.timeMs, row.day]);
      expect(multiset(site)).toEqual(multiset(game));
    }
  });

  test("have the game's dailies and streaks, counted as of the newest finished day", () => {
    const records = store.dailyRecords(TODAY);
    const top = (of: (record: (typeof records)[number]) => number) =>
      multiset(records.filter((record) => of(record) > 0).map((record) => [siteRef(record.player), of(record)]));

    expect(values(boards().dailies[ALL_SERVERS])).toEqual(top((record) => record.solves));
    expect(values(boards().streak[ALL_SERVERS])).toEqual(top((record) => record.current));
    expect(values(boards().best_streak[ALL_SERVERS])).toEqual(top((record) => record.best));
  });

  test("read a streak one lower than the game for a player who has already solved today, and no other way", () => {
    const visible = PLAYERS.visible;
    const site = body<SitePlayerBody>(`/data/player/${visible.key}.json`).totals;

    expect(site.currentStreak).toBe(full.streak(visible.id, TODAY) - 1);
    expect(site.currentStreak).toBe(store.streak(visible.id, TODAY));
  });

  test("have the game's Discoveries board, less the lines filed today", () => {
    const game = store.discoveryBoard(BIG).map((row) => [siteRef(row.player), row.found]);

    expect(values(boards().discoveries[ALL_SERVERS])).toEqual(multiset(game));
  });

  test("count each shown player's solved days as the game does", () => {
    for (const role of ["visible", "unchosen"] as const) {
      const site = body<SitePlayerBody>(`/data/player/${PLAYERS[role].key}.json`).totals;
      expect(site.daysSolved).toBe(store.totalSolved(PLAYERS[role].id));
      expect(site.puzzlesCleared).toBe(store.profile(PLAYERS[role].id).puzzlesCleared);
      expect(site.linesFound).toBe(store.profile(PLAYERS[role].id).discoveries);
    }
  });
});

describe("the lines", () => {
  test("are the game's gallery, credited and live, less today's, in the gallery's order", () => {
    const credited = creditedIds(trimmed);
    for (const puzzle of dataset.data.puzzles) {
      const game = store
        .solutionGallery(puzzle.id)
        .filter((line) => line.source === "player" && credited.has(line.solutionId))
        .map((line) => ({
          attack: line.attack,
          clears: line.clears,
          steps: line.placements.map(({ piece, cells, clear, attack }) => ({ piece, cells, clear, attack })),
        }));
      const site = body<SitePuzzleBody>(`/data/puzzle/${puzzle.id}.json`).lines.map(({ attack, clears, steps }) => ({
        attack,
        clears,
        steps,
      }));
      expect(site).toEqual(game);
    }
  });
});

/** The rows the game pays its finders for, by the very clause its board runs. */
function creditedIds(path: string): Set<number> {
  const db = new Database(path, { readonly: true });
  try {
    return new Set(
      db
        .query<{ id: number }, []>(`SELECT s.solution_id AS id FROM puzzle_solutions s WHERE ${CREDITED}`)
        .all()
        .map((row) => row.id),
    );
  } finally {
    db.close();
  }
}
