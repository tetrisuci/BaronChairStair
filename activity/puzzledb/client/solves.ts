/**
 * `/solves`: every daily solve on a finished day, across every player, newest
 * day first, filtered by tier, server and puzzle.
 *
 * **Steered by one small body, carried by the day bodies.** The page's own
 * body, `/data/solves.json`, says only which finished days had a solve, in
 * which tiers and which servers; the solves themselves are each day's
 * `/data/day/:day.json`, the same bodies the day pages draw, fetched a few at a
 * time through the page's per-visit copy (`SitePage.dayBody`). So no body
 * grows with history by more than a line a day, a filter skips the days that
 * cannot match without fetching them, and the feed shows nothing a day page
 * does not (`solves-rows.ts`).
 *
 * **A press reads a bounded amount.** Days are fetched seven at a time, in
 * parallel, until seven have drawn or twenty-eight have been read, whichever
 * comes first — so a filter whose days mostly turn out empty (a server's solves
 * were all in another tier) costs a reader a press of "Show older days", not
 * the whole of history at once, and stays far inside the site's per-caller
 * budget.
 *
 * **A late answer is dropped, and a press stops when its page goes.** Every
 * filter change takes a number, and a batch that lands for a number no longer
 * current is thrown away rather than drawn under filters it was not read for.
 * Leaving the page is the page's own counter's business, so the feed asks it
 * ({@link SolvesDeps.isCurrent}) after every batch: a reader who clicks a name
 * mid-press costs the batch already asked for, not three more read into a
 * view nobody can see.
 *
 * Rush is not here: it has its own board on each day's page, and a rush is not
 * the same unit as a hand-in.
 */

import { DAILY_TIERS, type DailyTier } from "../../shared/daily";
import { el } from "../../client/src/ui/dom";
import type { SiteDayBody } from "../wire";
import type { SiteSolvesBody } from "../wire-profiles";
import { plural } from "./board-rows";
import { type BodyView, readBody, type SiteIndex, titleOf } from "./data";
import { queryForSolves, type SolvesQuery } from "./list-queries";
import { serverChips, serversAmong } from "./server-chips";
import { feedDay, isFiltered } from "./solves-rows";

/** Days fetched at once. */
export const DAYS_PER_BATCH = 7;
/** Day bodies one press may read before it stops and offers "Show older days". */
export const FETCHES_PER_PRESS = 28;

const READING = "Reading the records…";
const FAILED = "Couldn't load this part of the page.";

/** What the feed needs from the page: a day's body, a way to put its filters in the address, and whether it is still shown. */
export interface SolvesDeps {
  /** A finished day's body, checked, from this visit's copy when there is one. */
  dayBody(day: number): Promise<SiteDayBody>;
  onQuery(search: string): void;
  /** False once the reader has gone to another page; a press stops there. */
  isCurrent(): boolean;
}

/**
 * The finished days that can hold a solve the query keeps, newest first.
 *
 * A tier keeps the days with a solve in it; a server, the days with a solve in
 * it; a puzzle, the days the index says dealt it whose steering has a solve in
 * the tier they dealt it as — and, with a tier chosen too, only the days that
 * dealt it as that tier. Each condition is checked on its own: the steering
 * counts solves per tier and names servers per day, but never says which tier
 * a server's solves were in, so under a server and a tier (or a puzzle) a day
 * kept here may still draw nothing. {@link isProvenMatch} says when it cannot.
 */
export function candidateDays(steering: SiteSolvesBody, query: SolvesQuery, index: SiteIndex): number[] {
  const dealt = query.puzzle === null ? null : new Map((index.dealsOf.get(query.puzzle) ?? []).map((deal) => [deal.day, deal.tier]));
  return steering.days
    .filter((day) => query.tier === null || day.tiers[query.tier] > 0)
    .filter((day) => query.server === null || day.servers.includes(query.server))
    .filter((day) => {
      if (dealt === null) return true;
      const tier = dealt.get(day.day);
      return tier !== undefined && day.tiers[tier] > 0 && (query.tier === null || tier === query.tier);
    })
    .map((day) => day.day)
    .sort((a, b) => b - a);
}

/**
 * Whether every day {@link candidateDays} keeps is sure to draw a solve: true
 * unless a server is chosen alongside a tier or a puzzle, the one pairing the
 * steering cannot check together.
 */
export function isProvenMatch(query: SolvesQuery): boolean {
  return query.server === null || (query.tier === null && query.puzzle === null);
}

/** Where the feed stands after a press: the filters, the days they allow, how far it has read and drawn. */
interface FeedState {
  readonly query: SolvesQuery;
  readonly candidates: readonly number[];
  readonly cursor: number;
  readonly drawn: number;
}

/** What the foot's count of days says they hold: a solve, a matching one, or — where the steering cannot tell — maybe a match. */
function daysAre(query: SolvesQuery, filtered: boolean): string {
  if (!filtered) return "with a solve";
  return isProvenMatch(query) ? "with a matching solve" : "that may match";
}

/** The foot after a press: more to read, every day read, or nothing to show. */
function ending(state: FeedState, onOlder: () => void): HTMLElement {
  const filtered = isFiltered(state.query);
  if (state.cursor < state.candidates.length) {
    const older = el("button", { class: "btn btn--small", text: "Show older days", attrs: { type: "button" }, on: { click: onOlder } });
    const through = `Through day ${state.candidates[state.cursor - 1]} · ${plural(state.candidates.length, "day")} ${daysAre(state.query, filtered)}`;
    return el("div", { class: "pdb-feed-more" }, older, el("span", { class: "label", text: through }));
  }
  if (state.drawn > 0) return el("p", { class: "note", text: "That's every finished day with a matching solve." });
  return el("p", { class: "note", text: filtered ? "No solves match." : "No solves on a finished day yet." });
}

/** The feed's days and its foot: what is drawn, and what a reader can do next. */
function createFeed(index: SiteIndex, steering: SiteSolvesBody, deps: SolvesDeps) {
  const days = el("div", { class: "pdb-stack pdb-feed-days" });
  const foot = el("div", { class: "pdb-feed-foot" });
  let generation = 0;
  let query: SolvesQuery = { tier: null, server: null, puzzle: null };
  let candidates: number[] = [];
  let cursor = 0;
  let drawn = 0;

  const failed = (mine: number, error: unknown) => {
    console.error("[puzzledb] could not load the solves feed's days:", error);
    const retry = el("button", { class: "btn btn--small", text: "Try again", attrs: { type: "button" }, on: { click: () => void press(mine) } });
    foot.replaceChildren(el("div", { class: "pdb-failed" }, el("p", { class: "note", text: FAILED }), retry));
  };

  /** Reads batches until enough has drawn or enough has been read, for the filters numbered `mine`. */
  const press = async (mine: number): Promise<void> => {
    foot.replaceChildren(el("p", { class: "label pdb-loading", text: READING }));
    let drawnNow = 0;
    let read = 0;
    while (drawnNow < DAYS_PER_BATCH && read < FETCHES_PER_PRESS && cursor < candidates.length) {
      const batch = candidates.slice(cursor, cursor + Math.min(DAYS_PER_BATCH, FETCHES_PER_PRESS - read));
      let bodies: SiteDayBody[];
      try {
        bodies = await Promise.all(batch.map((day) => deps.dayBody(day)));
      } catch (error) {
        if (mine === generation && deps.isCurrent()) failed(mine, error);
        return;
      }
      if (mine !== generation || !deps.isCurrent()) return;
      cursor += batch.length;
      read += batch.length;
      const sections = bodies.flatMap((body) => feedDay(body, query, index) ?? []);
      days.append(...sections);
      drawnNow += sections.length;
      drawn += sections.length;
    }
    foot.replaceChildren(ending({ query, candidates, cursor, drawn }, () => void press(generation)));
  };

  /** Starts over for a new set of filters, from the newest day. */
  const show = (next: SolvesQuery) => {
    generation += 1;
    query = next;
    candidates = candidateDays(steering, next, index);
    cursor = 0;
    drawn = 0;
    days.replaceChildren();
    void press(generation);
  };

  return { days, foot, show };
}

/** "All tiers", then each tier, the current one pressed; the server chips' look and rule. */
function tierChips(current: DailyTier | null, onPick: (tier: DailyTier | null) => void): HTMLElement {
  const row = el("div", { class: "boards__tabs pdb-chips", attrs: { role: "group", "aria-label": "Tier" } });
  const choices: readonly { readonly tier: DailyTier | null; readonly label: string }[] = [
    { tier: null, label: "All tiers" },
    ...DAILY_TIERS.map((tier) => ({ tier, label: tier })),
  ];
  const draw = (on: DailyTier | null) => {
    row.replaceChildren(
      ...choices.map((choice) =>
        el("button", {
          class: `btn btn--small${choice.tier === on ? " btn--primary" : ""}`,
          text: choice.label,
          attrs: { type: "button", "aria-pressed": String(choice.tier === on) },
          on: {
            click: () => {
              if (choice.tier === on) return;
              draw(choice.tier);
              onPick(choice.tier);
            },
          },
        }),
      ),
    );
  };
  draw(current);
  return row;
}

/** Every listed puzzle some finished day dealt, by id, under "Any puzzle". */
function puzzleSelect(index: SiteIndex, current: number | null, onPick: (puzzle: number | null) => void): HTMLElement {
  const ids = [...index.dealsOf.keys()].filter((id) => index.byId.has(id)).sort((a, b) => a - b);
  const select = el(
    "select",
    { class: "spec__select pdb-feed-puzzle", attrs: { name: "puzzle", "aria-label": "Puzzle" } },
    el("option", { text: "Any puzzle", attrs: { value: "" } }),
    ...ids.map((id) => el("option", { text: `#${id} ${titleOf(index.byId.get(id)!)}`, attrs: { value: id } })),
  );
  select.value = current === null ? "" : String(current);
  select.addEventListener("change", () => onPick(select.value === "" ? null : Number(select.value)));
  return el("label", { class: "label pdb-feed-select" }, "Puzzle ", select);
}

/** The filters and the feed, once the steering is in hand. */
function feedView(index: SiteIndex, steering: SiteSolvesBody, start: SolvesQuery, deps: SolvesDeps): HTMLElement {
  const servers = serversAmong(index, new Set(steering.days.flatMap((day) => day.servers)));
  // A server the steering never names reads as every server, as a key the index does not know does.
  let query: SolvesQuery = { ...start, server: servers.some((server) => server.key === start.server) ? start.server : null };
  const feed = createFeed(index, steering, deps);
  const change = (next: Partial<SolvesQuery>) => {
    query = { ...query, ...next };
    feed.show(query);
    deps.onQuery(queryForSolves(query));
  };
  const controls = el(
    "div",
    { class: "pdb-stack pdb-stack--tight pdb-feed-filters" },
    tierChips(query.tier, (tier) => change({ tier })),
    servers.length === 0 ? null : serverChips(servers, query.server, (server) => change({ server })),
    puzzleSelect(index, query.puzzle, (puzzle) => change({ puzzle })),
  );
  feed.show(query);
  return el("div", { class: "pdb-stack" }, controls, feed.days, feed.foot);
}

/** The page: the head at once; the filters and the feed when `/data/solves.json` arrives. */
export function solvesPage(index: SiteIndex, query: SolvesQuery, deps: SolvesDeps): BodyView {
  const slot = el("div", { class: "pdb-slot" });
  const head = el(
    "header",
    { class: "pdb-page-head" },
    el("h1", { class: "display pdb-title", text: "Recent solves" }),
    el("p", {
      class: "pdb-lede",
      text: "Every daily solve on a finished day, newest first. A player who chose to hide is “a player”.",
    }),
  );
  const fill = (body: unknown) => {
    const steering = readBody("solves", body);
    if (steering.days.length === 0) {
      slot.replaceChildren(el("p", { class: "note", text: "No solves on a finished day yet." }));
      return;
    }
    slot.replaceChildren(feedView(index, steering, query, deps));
  };
  return { element: el("div", { class: "pdb-stack" }, head, slot), slot, fill };
}
