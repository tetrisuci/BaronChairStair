/**
 * The players table's, the solves feed's and the alternates table's choices,
 * kept in the address bar.
 *
 * Both are lists people send each other — "the players of our server, by best
 * rush", "every hard solve of #42" — so, like the browse filter
 * (`filter-url.ts`), each choice lives in the query string, where a copied
 * link carries it, and the page writes it back without a history entry once
 * the reader stops changing it. Neither is a page of its own: a choice is a
 * filter, and v1 settled that a filter belongs in the query (`wire.ts`,
 * `PageRoute`).
 *
 * **Junk reads as "all", never as an empty list.** A query string is typed by
 * anyone, and a stale link outlives the server or puzzle it named. So an
 * unknown sort is the default sort, an unknown server is every server — the
 * rule {@link serverFromQuery} already follows — and a puzzle the index does
 * not list, or one no finished day dealt, is every puzzle. Each parameter is left
 * out while it holds its default, so the everyday address is the bare one.
 *
 * | | |
 * |---|---|
 * | `sort` | the players table: `streak`, `cleared`, `lines` or `rush`; days solved is the default |
 * | `q` | the players table: search text |
 * | `server` | either: a server's key |
 * | `tier` | the feed: `easy`, `medium`, `hard` or `extreme` |
 * | `puzzle` | the feed: a listed puzzle's id |
 * | `sort` | the alternates table: `difficulty`, `title`, `number`, `attack` or `pieces`; date found is the default |
 * | `dir` | the alternates table: `asc` or `desc`, left out while it is the sort's natural one |
 *
 * The alternates table's order is read by `readAlternateOrder`, the rule the
 * activity's own list reads a select by (`shared/alternate-sort.ts`), so the two
 * lists cannot disagree about what an unknown sort means.
 */

import { type AlternateOrder, DEFAULT_ALTERNATE_ORDER, defaultDirection, readAlternateOrder } from "@shared/alternate-sort";
import { DAILY_TIERS, type DailyTier } from "@shared/daily";
import type { SiteIndex } from "./data";
import { serverFromQuery } from "./server-chips";

/** The players table's columns a reader can sort by, the default first. Every sort puts the most first. */
export const PLAYERS_SORTS = ["days", "streak", "cleared", "lines", "rush"] as const;

export type PlayersSort = (typeof PLAYERS_SORTS)[number];

export interface PlayersQuery {
  readonly sort: PlayersSort;
  /** As typed; the table trims and case-folds it when matching. */
  readonly q: string;
  readonly server: string | null;
}

export interface SolvesQuery {
  readonly tier: DailyTier | null;
  readonly server: string | null;
  readonly puzzle: number | null;
}

/** A puzzle id as an address writes it: digits, no sign, no leading zero, short of any id the club could reach. */
const PUZZLE_ID = /^[1-9]\d{0,6}$/;

function isSort(value: string | null): value is PlayersSort {
  return (PLAYERS_SORTS as readonly (string | null)[]).includes(value);
}

function isTier(value: string | null): value is DailyTier {
  return (DAILY_TIERS as readonly (string | null)[]).includes(value);
}

/** `?a=b&…`, or nothing when every choice is its default. */
function written(params: URLSearchParams): string {
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** The players table's choice a query string asks for, junk read as the defaults. */
export function playersQueryFrom(search: string, index: Pick<SiteIndex, "serverByKey">): PlayersQuery {
  const params = new URLSearchParams(search);
  const sort = params.get("sort");
  return {
    sort: isSort(sort) ? sort : PLAYERS_SORTS[0],
    q: params.get("q") ?? "",
    server: serverFromQuery(search, index),
  };
}

/** The query string for a players-table choice: `""` for the defaults. */
export function queryForPlayers(query: PlayersQuery): string {
  const params = new URLSearchParams();
  if (query.sort !== PLAYERS_SORTS[0]) params.set("sort", query.sort);
  if (query.server !== null) params.set("server", query.server);
  if (query.q.trim() !== "") params.set("q", query.q);
  return written(params);
}

/** The feed's filters a query string asks for, junk read as "all". */
export function solvesQueryFrom(search: string, index: Pick<SiteIndex, "serverByKey" | "dealsOf" | "byId">): SolvesQuery {
  const params = new URLSearchParams(search);
  const tier = params.get("tier");
  const puzzle = params.get("puzzle");
  const id = puzzle !== null && PUZZLE_ID.test(puzzle) ? Number(puzzle) : null;
  return {
    tier: isTier(tier) ? tier : null,
    server: serverFromQuery(search, index),
    puzzle: id !== null && index.byId.has(id) && index.dealsOf.has(id) ? id : null,
  };
}

/** The query string for the feed's filters: `""` for every solve. */
export function queryForSolves(query: SolvesQuery): string {
  const params = new URLSearchParams();
  if (query.tier !== null) params.set("tier", query.tier);
  if (query.server !== null) params.set("server", query.server);
  if (query.puzzle !== null) params.set("puzzle", String(query.puzzle));
  return written(params);
}

/**
 * The alternates table's order a query string asks for: an unknown sort is the
 * default order, a missing direction the sort's natural one. A missing sort is
 * the default sort, so `?dir=asc` — the oldest finds first, as
 * {@link queryForAlternates} writes it — keeps its direction.
 */
export function alternatesQueryFrom(search: string): AlternateOrder {
  const params = new URLSearchParams(search);
  return readAlternateOrder(params.get("sort") ?? DEFAULT_ALTERNATE_ORDER.sort, params.get("dir"));
}

/** The query string for an alternates order: `""` for the default, and no `dir` while it is the sort's natural one. */
export function queryForAlternates(order: AlternateOrder): string {
  const params = new URLSearchParams();
  if (order.sort !== DEFAULT_ALTERNATE_ORDER.sort) params.set("sort", order.sort);
  if (order.direction !== defaultDirection(order.sort)) params.set("dir", order.direction);
  return written(params);
}
