/**
 * Every `/data/…` body the site serves, cut from the read-back public database.
 *
 * Schema 1 sent one JSON file per visit. A club-year of boards is hundreds of
 * kilobytes gzipped, and nobody reading one day's board wants every other
 * day's, so since schema 2 the index stays one file and each page that needs
 * more fetches one body — a day, a player, a puzzle, or the all-time boards —
 * each under a kilobyte or so.
 *
 * **Built from what was read back, never from what went in.** Every field
 * here was first a cell in the public database, the same one the download
 * is, so a body cannot say anything the `.sqlite` file does not. It is built
 * once per build and served byte for byte, keyed by the path `bodyPathFor`
 * gives its page: a body exists exactly where a page does, and every other
 * path under `/data/` is the one shared 404.
 *
 * **One per listed thing.** A body for every finished day, every listed
 * puzzle and every shown player, and the leaderboards — an empty board
 * included, as an empty list, so a page never has to tell "nothing yet" from
 * "missing". A player who hid has no body, exactly as a key nobody holds.
 */

import { DAILY_TIERS } from "../../shared/daily";
import {
  ALL_SERVERS,
  bodyPathFor,
  displayRanks,
  sameHandIn,
  sameRush,
  type SiteData,
  type SiteDayBody,
  type SiteDayBoardRow,
  type SiteLeaderboardsBody,
  type SitePlayerBody,
  type SitePuzzleBody,
  type SiteStanding,
  STANDING_BOARDS,
  type StandingBoard,
} from "../wire";
import type { PlayerData } from "./public-db-players";
import { groupedBy } from "./rank";

const encoder = new TextEncoder();

/** Every body of one build, by the path its page asks for. */
export function buildBodies(data: SiteData, players: PlayerData): ReadonlyMap<string, Uint8Array> {
  const builtAt = data.about.builtAt;
  const bodies = new Map<string, Uint8Array>();
  const put = (path: string | null, body: object) => {
    if (path === null) throw new Error("A body was built for a page that has none");
    bodies.set(path, encoder.encode(JSON.stringify(body)));
  };
  for (const body of dayBodies(data, players, builtAt)) put(bodyPathFor({ kind: "day", day: body.day }), body);
  for (const [key, body] of playerBodies(players, builtAt)) put(bodyPathFor({ kind: "player", key }), body);
  for (const [id, body] of puzzleBodies(data, players, builtAt)) put(bodyPathFor({ kind: "puzzle", id }), body);
  put(bodyPathFor({ kind: "leaderboards" }), leaderboardsBody(players, builtAt));
  return bodies;
}

/** One finished day: its day boards by scope, the all-servers board always there; its tiers; its rush. */
function dayBodies(data: SiteData, players: PlayerData, builtAt: string): SiteDayBody[] {
  const tiers = groupedBy(players.tierRows, (row) => String(row.day));
  const boards = groupedBy(players.dayBoardRows, (row) => String(row.day));
  const rush = groupedBy(players.rushRows, (row) => String(row.day));
  return data.days.map(({ day }) => {
    const scoped: Record<string, SiteDayBoardRow[]> = { [ALL_SERVERS]: [] };
    for (const { day: _day, scope, ...row } of boards.get(String(day)) ?? []) {
      scoped[scope] = [...(scoped[scope] ?? []), row];
    }
    return {
      builtAt,
      day,
      boards: scoped,
      tiers: (tiers.get(String(day)) ?? []).map(({ day: _day, ...row }) => row),
      rush: (rush.get(String(day)) ?? []).map(({ day: _day, ...row }) => row),
    };
  });
}

/**
 * Each row's rank as its board shows it, ties shared, by the row itself.
 *
 * The rows arrive grouped by board and in stored-rank order (the read orders
 * them so), which is the order `displayRanks` needs, and it is the same call
 * the day page makes over the same rows — so "2nd" on a player's page is the 2
 * beside them on the day. The stored rank would not do: it breaks ties by
 * name, so of two tied players the later in the alphabet would read "3rd", and
 * would move when the other renamed or hid.
 */
function boardRanks<T>(rows: readonly T[], boardOf: (row: T) => string, same: (a: T, b: T) => boolean): Map<T, number> {
  const shown = new Map<T, number>();
  for (const board of groupedBy(rows, boardOf).values()) {
    const ranks = displayRanks(board, same);
    board.forEach((row, at) => shown.set(row, ranks[at]!));
  }
  return shown;
}

/**
 * Each shown player's totals, hand-ins and rushes, newest first. A hand-in
 * carries its rank on that day's tier, as the day's board shows it, but no
 * server and no attack: the day's page is where it sits beside everybody
 * else's.
 */
function playerBodies(players: PlayerData, builtAt: string): Map<string, SitePlayerBody> {
  const tierAt = (tier: string) => DAILY_TIERS.indexOf(tier as (typeof DAILY_TIERS)[number]);
  const tierRank = boardRanks(players.tierRows, (row) => `${row.day}:${row.tier}`, sameHandIn);
  const rushRank = boardRanks(players.rushRows, (row) => String(row.day), sameRush);
  const runs = groupedBy(
    players.tierRows.filter((row) => row.player !== null),
    (row) => row.player!.key,
  );
  const rushes = groupedBy(
    players.rushRows.filter((row) => row.player !== null),
    (row) => row.player!.key,
  );
  return new Map(
    players.players.map(({ key }): [string, SitePlayerBody] => {
      const totals = players.totals.get(key);
      if (!totals) throw new Error("A listed player has no totals row");
      return [
        key,
        {
          builtAt,
          totals,
          runs: (runs.get(key) ?? [])
            .toSorted((a, b) => b.day - a.day || tierAt(a.tier) - tierAt(b.tier))
            .map((row) => ({
              day: row.day,
              tier: row.tier,
              rank: tierRank.get(row)!,
              solved: row.solved,
              timeMs: row.timeMs,
              puzzleId: row.puzzleId,
            })),
          rush: (rushes.get(key) ?? [])
            .toSorted((a, b) => b.day - a.day)
            .map((row) => ({ day: row.day, rank: rushRank.get(row)!, solved: row.solved, timeMs: row.timeMs })),
        },
      ];
    }),
  );
}

/** Each listed puzzle's stats, null when no finished day dealt it, and its lines in position order. */
function puzzleBodies(data: SiteData, players: PlayerData, builtAt: string): Map<number, SitePuzzleBody> {
  const lines = groupedBy(players.lines, (line) => String(line.puzzleId));
  return new Map(
    data.puzzles.map(({ id }): [number, SitePuzzleBody] => [
      id,
      {
        builtAt,
        stats: players.stats.get(id) ?? null,
        lines: (lines.get(String(id)) ?? []).map(({ puzzleId: _id, ...line }) => line),
      },
    ]),
  );
}

/** Every all-time board, each with its all-servers scope even when empty, in the page's order. */
function leaderboardsBody(players: PlayerData, builtAt: string): SiteLeaderboardsBody {
  const boards = Object.fromEntries(
    STANDING_BOARDS.map((board): [StandingBoard, Record<string, SiteStanding[]>] => [board, { [ALL_SERVERS]: [] }]),
  ) as Record<StandingBoard, Record<string, SiteStanding[]>>;
  for (const { board, scope, ...row } of players.standings) {
    boards[board][scope] = [...(boards[board][scope] ?? []), row];
  }
  return { builtAt, boards };
}
