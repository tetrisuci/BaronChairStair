/**
 * The daily's history: every finished day, and one day at a time.
 *
 * Only finished days ever reach the page — the server cuts history before
 * today, and before the first day dealt in tiers — so nothing here decides
 * what is a spoiler. What this module does decide is how three kinds of deal
 * read, because a day is not always three or four club puzzles:
 *
 * - a club puzzle on the site, linked by number and title;
 * - a puzzle a player wrote, which the site does not list, named by its tier
 *   alone — the data carries no id for it, so there is nothing to link and no
 *   way to look one up;
 * - a club puzzle the archive has since lost, named by its number, because it
 *   was dealt, and leaving the tier out would say it was not.
 *
 * **A day shows each puzzle as it is now.** An officer's correction or a
 * re-sync since may have changed what that day dealt, and there is no record
 * of the old text to show instead, so both views say so in a footnote rather
 * than leave it to be discovered.
 */

import { boardGlyph } from "../../client/src/render/piece-glyph";
import { el, panel } from "../../client/src/ui/dom";
import { dayLabel, pathOf, type SiteDay, type SiteDeal, type SitePuzzle } from "../wire";
import { ratingOf, type SiteIndex, titleOf } from "./data";
import { pager } from "./frame";

/** The footnote under both day views. */
export const AS_THEY_ARE_NOW =
  "Puzzles are shown as they are now; one edited since may differ from what that day dealt.";

const PLAYERS_PUZZLE = "a puzzle written by a player (not listed here)";

function puzzlePath(id: number): string {
  return pathOf({ kind: "puzzle", id });
}

function dayPath(day: number): string {
  return pathOf({ kind: "day", day });
}

/** The listed puzzle a deal dealt, if the site lists it. */
function dealt(deal: SiteDeal, index: SiteIndex): SitePuzzle | undefined {
  return deal.puzzleId === null ? undefined : index.byId.get(deal.puzzleId);
}

/** How an unlisted deal reads: a player's puzzle, or a club number the archive no longer holds. */
function unlistedName(deal: SiteDeal): string {
  return deal.puzzleId === null ? PLAYERS_PUZZLE : `#${deal.puzzleId} (no longer in the archive)`;
}

/**
 * One deal as a line: `easy · #12 Title`, linked; `hard · a puzzle written by a
 * player (not listed here)`; `medium · #13 (no longer in the archive)`.
 */
export function dealLine(deal: SiteDeal, index: SiteIndex): HTMLElement {
  const puzzle = dealt(deal, index);
  return el(
    "li",
    { class: "pdb-deal-line" },
    `${deal.tier} · `,
    puzzle
      ? el("a", { text: `#${puzzle.id} ${titleOf(puzzle)}`, attrs: { href: puzzlePath(puzzle.id) } })
      : unlistedName(deal),
  );
}

/** Open the puzzle, and — when it has one — open it with the answer showing. */
function dealActions(puzzle: SitePuzzle): HTMLElement {
  return el(
    "div",
    { class: "btnrow pdb-deal__actions" },
    el("a", { class: "btn btn--small", text: "Open", attrs: { href: puzzlePath(puzzle.id) } }),
    puzzle.solution
      ? el("a", {
          class: "btn btn--small",
          text: "See the answer",
          attrs: { href: `${puzzlePath(puzzle.id)}#answer` },
        })
      : null,
  );
}

/**
 * One tier of a day as a card: the tier, the board, the number and title, the
 * maker and the rating — or, for a deal the site does not list, the tier and
 * what it was.
 *
 * `actions` adds Open and See the answer, for the day's own page; the browse
 * page's latest-day card leaves them off and links the board and title alone.
 */
export function dealCard(
  deal: SiteDeal,
  index: SiteIndex,
  options: { readonly actions?: boolean } = {},
): HTMLElement {
  const tier = el("span", { class: "label pdb-deal__tier", text: deal.tier });
  const puzzle = dealt(deal, index);
  if (!puzzle) {
    const what = el("p", { class: "note", text: unlistedName(deal) });
    return el("li", { class: "pdb-deal pdb-deal--unlisted" }, tier, what);
  }
  return el(
    "li",
    { class: "pdb-deal" },
    tier,
    el(
      "a",
      { class: "pdb-deal__link", attrs: { href: puzzlePath(puzzle.id) } },
      el("span", { class: "pdb-deal__board" }, boardGlyph(puzzle.board)),
      el("span", { class: "pdb-deal__name", text: `#${puzzle.id} ${titleOf(puzzle)}` }),
    ),
    puzzle.author ? el("span", { class: "pdb-deal__by", text: `by ${puzzle.author}` }) : null,
    el("span", { class: "pdb-deal__meta", text: ratingOf(puzzle) }),
    options.actions ? dealActions(puzzle) : null,
  );
}

/** One row of the history: the day, linked, then each of its deals. */
function dayRow(day: SiteDay, index: SiteIndex): HTMLElement {
  return el(
    "li",
    { class: "pdb-day" },
    el("a", {
      class: "pdb-day__link",
      text: `Day ${day.day} · ${dayLabel(day.day)}`,
      attrs: { href: dayPath(day.day) },
    }),
    el("ul", { class: "pdb-deal-lines" }, ...day.deals.map((deal) => dealLine(deal, index))),
  );
}

/** `/days`: every finished day, newest first. */
export function createDaysView(index: SiteIndex): HTMLElement {
  const newestFirst = [...index.data.days].sort((a, b) => b.day - a.day);
  return el(
    "div",
    { class: "pdb-stack" },
    el("h1", { class: "display pdb-title", text: "Daily history" }),
    panel(
      "Finished days",
      { class: "pdb-days" },
      newestFirst.length === 0
        ? el("p", { class: "note", text: "No finished days on record yet." })
        : el("ol", { class: "pdb-day-list" }, ...newestFirst.map((day) => dayRow(day, index))),
      el("p", { class: "note", text: AS_THEY_ARE_NOW }),
    ),
  );
}

/** The recorded days either side of this one. A gap in the record is skipped, not shown as a day. */
function dayPager(day: SiteDay, index: SiteIndex): HTMLElement {
  const days = index.data.days;
  const at = days.findIndex((entry) => entry.day === day.day);
  const previous = at > 0 ? days[at - 1] : undefined;
  const next = at >= 0 ? days[at + 1] : undefined;
  return pager(
    "Other days",
    previous ? { href: dayPath(previous.day), text: `Day ${previous.day}` } : null,
    next ? { href: dayPath(next.day), text: `Day ${next.day}` } : null,
  );
}

/** `/day/274`: one finished day, a card per tier. */
export function createDayView(day: SiteDay, index: SiteIndex): HTMLElement {
  return el(
    "div",
    { class: "pdb-stack" },
    el(
      "header",
      { class: "pdb-page-head" },
      el("h1", { class: "display pdb-title", text: `Day ${day.day}` }),
      el("p", { class: "label", text: dayLabel(day.day) }),
    ),
    el(
      "ul",
      { class: "pdb-deals pdb-deals--day" },
      ...day.deals.map((deal) => dealCard(deal, index, { actions: true })),
    ),
    el("p", { class: "note", text: AS_THEY_ARE_NOW }),
    dayPager(day, index),
  );
}
