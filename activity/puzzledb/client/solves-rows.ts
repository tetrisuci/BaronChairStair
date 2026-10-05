/**
 * One finished day in the solves feed: its heading and its solves, each a row
 * of the day's own body.
 *
 * **A feed row is a day body's row, and nothing else.** The feed adds no field
 * to what `/data/day/:day.json` already publishes, so a player who hid is the
 * same "a player" here as on the day page — never a link, with the server and
 * the rank they earned — and the feed has no privacy of its own to get wrong.
 *
 * **The rank is the day page's, under the same server chip.** It is worked out
 * with `displayRanks` and `sameHandIn` over the tier's rows in the chosen
 * scope — every server, or the chosen one alone — unsolved rows included, so a
 * tie is shared and a server's own board has no gaps. That is exactly what
 * `/day/:day` prints under that chip, so the two can never disagree about who
 * was second. A tier or puzzle filter only hides rows; it never re-ranks them.
 */

import { DAILY_TIERS, type DailyTier } from "../../shared/daily";
import { el, formatDuration } from "../../client/src/ui/dom";
import { dayLabel, displayRanks, pathOf, sameHandIn, type SiteDayBody, type SiteTierRow } from "../wire";
import { ordinal, playerName, plural, serverLabel } from "./board-rows";
import { type SiteIndex, titleOf } from "./data";
import type { SolvesQuery } from "./list-queries";
import { tierDot } from "./profile-panels";
import { queryForServer } from "./server-chips";

/** A solve the feed draws, and the rank the day page prints for it. */
export interface FeedRow {
  readonly row: SiteTierRow;
  readonly rank: number;
}

/** Whether a filter narrows the feed at all, so a day's count can say "of". */
export function isFiltered(query: SolvesQuery): boolean {
  return query.tier !== null || query.server !== null || query.puzzle !== null;
}

/** Each tier's rows in scope, ranked as the day page ranks them under the same chip. */
function ranked(body: SiteDayBody, server: string | null): Map<SiteTierRow, number> {
  const scoped = body.tiers.filter((row) => server === null || row.serverKey === server);
  const ranks = new Map<SiteTierRow, number>();
  for (const tier of DAILY_TIERS) {
    const rows = scoped.filter((row) => row.tier === tier).sort((a, b) => a.rank - b.rank);
    displayRanks(rows, sameHandIn).forEach((rank, at) => ranks.set(rows[at]!, rank));
  }
  return ranks;
}

/** The day's solves the query keeps, in the game's tier order, then by rank. */
export function feedRows(body: SiteDayBody, query: SolvesQuery): FeedRow[] {
  const ranks = ranked(body, query.server);
  const order = (tier: DailyTier) => DAILY_TIERS.indexOf(tier);
  return body.tiers
    .filter((row) => row.solved && ranks.has(row))
    .filter((row) => query.tier === null || row.tier === query.tier)
    .filter((row) => query.puzzle === null || row.puzzleId === query.puzzle)
    .sort((a, b) => order(a.tier) - order(b.tier) || a.rank - b.rank)
    .map((row) => ({ row, rank: ranks.get(row)! }));
}

/** `#42 Jelly`, linked; a puzzle a player wrote, unlinked; a departed one, its number. */
function puzzleCell(id: number | null, index: SiteIndex): HTMLElement {
  const cell = el("span", { class: "pdb-feed-row__puzzle" });
  if (id === null) cell.append(el("span", { class: "pdb-feed-row__community", text: "a puzzle written by a player" }));
  else {
    const puzzle = index.byId.get(id);
    cell.append(puzzle ? el("a", { text: `#${id} ${titleOf(puzzle)}`, attrs: { href: pathOf({ kind: "puzzle", id }) } }) : `#${id}`);
  }
  return cell;
}

function serverCell(key: string | null, index: SiteIndex): HTMLElement {
  const server = key === null ? undefined : index.serverByKey.get(key);
  return el("span", { class: "pdb-feed-row__server", text: server ? serverLabel(server) : "no server" });
}

/** Tier, puzzle, player, server, time, rank: six cells, so every day's columns line up. */
function feedRow({ row, rank }: FeedRow, index: SiteIndex): HTMLElement {
  return el(
    "li",
    { class: "pdb-feed-row" },
    el("span", { class: `pdb-tier pdb-tier--${row.tier}` }, tierDot(row.tier), row.tier),
    puzzleCell(row.puzzleId, index),
    el("span", { class: "pdb-feed-row__player" }, playerName(row.player)),
    serverCell(row.serverKey, index),
    el("span", { class: "pdb-feed-row__time", text: row.timeMs === null ? "—" : formatDuration(row.timeMs) }),
    el("span", { class: "pdb-feed-row__rank", text: ordinal(rank) }),
  );
}

/**
 * The day as the feed draws it, or null when the query keeps none of its
 * solves. The heading links to the day's page, on the chosen server's chip.
 */
export function feedDay(body: SiteDayBody, query: SolvesQuery, index: SiteIndex): HTMLElement | null {
  const rows = feedRows(body, query);
  if (rows.length === 0) return null;
  const total = body.tiers.filter((row) => row.solved).length;
  const count = isFiltered(query) ? `${rows.length} of ${plural(total, "solve")}` : plural(total, "solve");
  const href = `${pathOf({ kind: "day", day: body.day })}${queryForServer(query.server)}`;
  return el(
    "section",
    { class: "panel pdb-feed-day" },
    el(
      "header",
      { class: "pdb-feed-day__head" },
      el("a", { text: `Day ${body.day} · ${dayLabel(body.day)}`, attrs: { href } }),
      el("span", { class: "label", text: count }),
    ),
    el("ol", { class: "pdb-feed-rows" }, ...rows.map((row) => feedRow(row, index))),
  );
}
