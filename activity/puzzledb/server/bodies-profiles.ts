/**
 * The profile browser's bodies: each player's tier summaries, the players
 * table, and the steering body the solves feed reads.
 *
 * Beside `bodies.ts` rather than in it only for length; the rule is the same
 * one. Everything here is built from {@link PlayerData}, what was read back
 * out of the public database, so a body cannot say anything the download does
 * not — and every number in a summary can be worked out again from the
 * download's `tier_boards`, which is why it is built here and not by the page.
 *
 * **Nothing new about anybody.** A tier summary is one shown player's own
 * hand-ins, already on the day bodies. The players table carries a key and
 * the totals `players` holds, never a name: the name is the index's, so one
 * page can never print one person under two names. The steering body is
 * counts and server keys, so it reads the same byte for byte whether a player
 * hid or not; their solves are counted, and their rows are the day bodies',
 * already "a player".
 *
 * **Sized for a year.** The feed's rows are the day bodies, each the same size
 * however long history grows, fetched a few days at a time. The steering body
 * is one short line per finished day with a solve, and the players table one
 * row per listed player, so neither carries history row by row.
 */

import { DAILY_TIERS, type DailyTier } from "../../shared/daily";
import type { SiteTierSummary } from "../wire";
import type { SitePlayerListRow, SitePlayersBody, SiteSolvesBody, SiteSolvesDay } from "../wire-profiles";
import { medianOf } from "./dataset-players";
import type { PlayerData } from "./public-db-players";
import { groupedBy, textOrder } from "./rank";

type TierRow = PlayerData["tierRows"][number];

/**
 * One player's tiers, from their own tier-board rows: always four, in the
 * daily's order, a tier never played reading zeros and nulls.
 *
 * **A tied best goes to the earliest day it was set on**, so the answer never
 * depends on the order the rows came in. The median is `medianOf`, the same
 * rounding as a puzzle's.
 */
export function tierSummaries(rows: readonly TierRow[]): SiteTierSummary[] {
  return DAILY_TIERS.map((tier) => {
    const played = rows.filter((row) => row.tier === tier);
    const solves = played.filter((row) => row.solved && row.timeMs !== null);
    const best = solves.toSorted((a, b) => a.timeMs! - b.timeMs! || a.day - b.day)[0];
    return {
      tier,
      handIns: played.length,
      solves: solves.length,
      bestMs: best?.timeMs ?? null,
      bestDay: best?.day ?? null,
      medianMs: medianOf(solves.map((row) => row.timeMs!).toSorted((a, b) => a - b)),
    };
  });
}

/** Distinct non-null server keys, in code-unit order: the same in every runtime. */
function serverKeys(keys: readonly (string | null)[]): string[] {
  return [...new Set(keys.filter((key): key is string => key !== null))].toSorted(textOrder);
}

/**
 * `GET /data/players.json`: one row per listed player, in the index's order.
 *
 * **The server filter's list, not per-server totals.** The numbers are the
 * game's own, across every server; `servers` holds every server a player
 * handed in or rushed in on a finished day, so a chip can say whether to list
 * them. A row with no shown player names nobody, so it lists nobody's server.
 */
export function playersBody(players: PlayerData, builtAt: string): SitePlayersBody {
  const played = groupedBy(
    [...players.tierRows, ...players.rushRows].filter((row) => row.player !== null),
    (row) => row.player!.key,
  );
  return {
    builtAt,
    rows: players.players.map(({ key }): SitePlayerListRow => {
      const totals = players.totals.get(key);
      if (!totals) throw new Error("A listed player has no totals row");
      return {
        key,
        puzzlesCleared: totals.puzzlesCleared,
        linesFound: totals.linesFound,
        rushBest: totals.rushBest,
        rushBestMs: totals.rushBestMs,
        servers: serverKeys((played.get(key) ?? []).map((row) => row.serverKey)),
      };
    }),
  };
}

/**
 * `GET /data/solves.json`: each finished day with a daily solve, newest first,
 * with its solves per tier and the servers they were in.
 *
 * **It steers; it does not carry.** A day here is enough for the feed to skip
 * it under a tier or server filter without fetching it. Rush is not counted:
 * it has its own board, and a solves feed of two units would mix them.
 */
export function solvesBody(players: PlayerData, builtAt: string): SiteSolvesBody {
  const solved = players.tierRows.filter((row) => row.solved);
  const days = [...groupedBy(solved, (row) => String(row.day)).values()].map((rows): SiteSolvesDay => {
    const count = (tier: DailyTier) => rows.filter((row) => row.tier === tier).length;
    return {
      day: rows[0]!.day,
      tiers: Object.fromEntries(DAILY_TIERS.map((tier) => [tier, count(tier)])) as Record<DailyTier, number>,
      servers: serverKeys(rows.map((row) => row.serverKey)),
    };
  });
  return { builtAt, days: days.toSorted((a, b) => b.day - a.day) };
}
