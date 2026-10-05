/**
 * The profile browser's three panels on `/player/:key`: each tier's record, a
 * calendar of finished days, and the puzzles the player cleared.
 *
 * Each draws from the player's body and the index and nothing else, so it
 * cannot reach past what #92 already cut: the tier summaries are the build's
 * (`server/bodies-profiles.ts`), worked out from the same rows the tier boards
 * publish; the calendar is the body's runs laid over the index's days; the
 * cleared list is ids the build already narrowed to puzzles the site lists.
 *
 * **The calendar has a cell for every finished day and no other.** Its range
 * is the index's days, which stop before today and start where history does,
 * so it can neither show nor hint at how today is going. A date inside a
 * month that is not a finished day — one before history began, or one the box
 * did not deal — is a blank, so the weekdays stay in their columns without any
 * positioning: the page sets no inline style, and a grid of cells in order
 * needs none.
 *
 * **A shade counts the tiers that day dealt.** Three of a three-tier day is
 * as full as four of four, so a short day does not read as a weaker one. The
 * day's own page has the rest.
 */

import { DAILY_TIERS, type DailyTier } from "../../shared/daily";
import { el, formatDuration, panel } from "../../client/src/ui/dom";
import { dateOfDay, dayLabel, pathOf, type SitePlayerBody, type SitePlayerRun, type SiteTierSummary } from "../wire";
import { plural, timeOrDash } from "./board-rows";
import { type SiteIndex, titleOf } from "./data";

/** Months the calendar shows before "Show all": half a year. */
const MONTHS_SHOWN = 6;
/** Cleared puzzles listed before "Show all": a few rows of chips. */
const CLEARED_SHOWN = 40;

/** English and written out, for the reason `wire.ts` gives for `dayLabel`: identical everywhere, every year. */
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
const WEEKDAY_HEADS = ["S", "M", "T", "W", "T", "F", "S"] as const;

/** A tier's name for a heading: `Easy`. */
function tierName(tier: DailyTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/** The tier's colour, as a dot `profiles.css` paints; it says nothing a screen reader needs. */
export function tierDot(tier: DailyTier): HTMLElement {
  return el("span", { class: `pdb-tier-dot pdb-tier-dot--${tier}`, attrs: { "aria-hidden": "true" } });
}

/**
 * "Show all …": one press draws every item into `holder`, then the button is
 * gone. The lists it ends are a player's own, so a page of them is never long.
 */
export function showAllButton(label: string, holder: HTMLElement, items: readonly HTMLElement[]): HTMLElement {
  return el("button", {
    class: "btn btn--small pdb-more",
    text: label,
    attrs: { type: "button" },
    on: {
      click: (event) => {
        holder.replaceChildren(...items);
        (event.currentTarget as HTMLElement).remove();
      },
    },
  });
}

function dayLink(day: number, text: string, index: SiteIndex): Node {
  if (!index.dayByNumber.has(day)) return document.createTextNode(text);
  return el("a", { text, attrs: { href: pathOf({ kind: "day", day }) } });
}

// ── By tier ──────────────────────────────────────────────────────────────────

function tierRow(summary: SiteTierSummary, index: SiteIndex): HTMLElement {
  const name = el("th", { attrs: { scope: "row" } }, tierDot(summary.tier), tierName(summary.tier));
  if (summary.handIns === 0) return el("tr", { class: "pdb-row--quiet" }, name, el("td", { text: "not played", attrs: { colspan: 4 } }));
  const share = Math.round((summary.solves / summary.handIns) * 100);
  const best =
    summary.bestMs === null || summary.bestDay === null
      ? el("td", { class: "pdb-num", text: "—" })
      : el("td", { class: "pdb-num" }, `${formatDuration(summary.bestMs)} · `, dayLink(summary.bestDay, `day ${summary.bestDay}`, index));
  return el(
    "tr",
    {},
    name,
    el("td", { class: "pdb-num", text: `${summary.solves} / ${summary.handIns}` }),
    el(
      "td",
      { class: "pdb-rate-cell" },
      el("progress", { class: "pdb-progress", attrs: { value: summary.solves, max: summary.handIns, "aria-hidden": "true" } }),
      el("span", { class: "pdb-num", text: `${share}%` }),
    ),
    best,
    el("td", { class: "pdb-num", text: timeOrDash(summary.medianMs) }),
  );
}

/** Solves of hand-ins, the rate, the best and the median, one row per tier in the game's order. */
export function tiersPanel(body: SitePlayerBody, index: SiteIndex): HTMLElement {
  const byTier = new Map(body.tiers.map((summary) => [summary.tier, summary]));
  const rows = DAILY_TIERS.map((tier) =>
    tierRow(byTier.get(tier) ?? { tier, handIns: 0, solves: 0, bestMs: null, bestDay: null, medianMs: null }, index),
  );
  const head = el(
    "thead",
    {},
    el("tr", {}, ...["Tier", "Solved", "Rate", "Best", "Median"].map((text) => el("th", { text, attrs: { scope: "col" } }))),
  );
  return panel(
    "By tier",
    { class: "pdb-tiers" },
    el("div", { class: "pdb-table-wrap" }, el("table", { class: "pdb-table pdb-tier-table" }, head, el("tbody", {}, ...rows))),
  );
}

// ── The calendar ─────────────────────────────────────────────────────────────

/** One calendar month that holds finished days. */
export interface CalendarMonth {
  /** `October 2026`. */
  readonly title: string;
  /** Its finished days, ascending. */
  readonly days: readonly number[];
}

/** How a day went, for its cell: its shade, and the counts its label says. */
export interface CalendarCell {
  /** `none` not played, `missed` handed in and none solved, `s1`–`s4` the quarter of the dealt tiers solved. */
  readonly shade: "none" | "missed" | "s1" | "s2" | "s3" | "s4";
  readonly solved: number;
  readonly handedIn: number;
}

/** The finished days, grouped into calendar months, newest month first. */
export function monthsOf(days: readonly number[]): CalendarMonth[] {
  const months = new Map<string, number[]>();
  for (const day of [...days].sort((a, b) => a - b)) {
    const month = dateOfDay(day).slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), day]);
  }
  return [...months]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([month, list]) => ({ title: `${MONTH_NAMES[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`, days: list }));
}

/** How `day` went in `runs`, shaded against the `dealt` tiers that day dealt. */
export function cellOf(day: number, runs: readonly SitePlayerRun[], dealt: number): CalendarCell {
  const handed = runs.filter((run) => run.day === day);
  const solved = handed.filter((run) => run.solved).length;
  if (handed.length === 0) return { shade: "none", solved, handedIn: 0 };
  if (solved === 0) return { shade: "missed", solved, handedIn: handed.length };
  const quarter = Math.min(4, Math.max(1, Math.ceil((4 * solved) / Math.max(dealt, 1))));
  return { shade: `s${quarter}` as CalendarCell["shade"], solved, handedIn: handed.length };
}

/** Day of the month, 1–31. */
const dateIn = (day: number) => Number(dateOfDay(day).slice(8));

function dayCell(day: number, runs: readonly SitePlayerRun[], index: SiteIndex): HTMLElement {
  const dealt = index.dayByNumber.get(day)?.deals.length ?? DAILY_TIERS.length;
  const cell = cellOf(day, runs, dealt);
  const how = cell.handedIn === 0 ? "not played" : `${cell.solved} of ${dealt} solved`;
  const label = `Day ${day} · ${dayLabel(day)} — ${how}`;
  return el("a", {
    class: `pdb-cal__cell pdb-cal__cell--${cell.shade}`,
    text: dateIn(day),
    title: label,
    attrs: { href: pathOf({ kind: "day", day }), "aria-label": label },
  });
}

function monthGrid(month: CalendarMonth, runs: readonly SitePlayerRun[], index: SiteIndex): HTMLElement {
  const first = month.days[0]!;
  const last = month.days.at(-1)!;
  const held = new Set(month.days);
  const weekday = new Date(`${dateOfDay(first)}T00:00:00Z`).getUTCDay();
  const cells: HTMLElement[] = [
    ...WEEKDAY_HEADS.map((head) => el("span", { class: "pdb-cal__weekday", text: head, attrs: { "aria-hidden": "true" } })),
    ...Array.from({ length: weekday }, () => el("span", { class: "pdb-cal__pad" })),
  ];
  // Day numbers are consecutive dates, so the dates between the first and last are the numbers between.
  for (let day = first; day <= last; day++) {
    cells.push(held.has(day) ? dayCell(day, runs, index) : el("span", { class: "pdb-cal__gap" }));
  }
  return el(
    "div",
    { class: "pdb-cal" },
    el("h3", { class: "pdb-cal__title", text: month.title }),
    el("div", { class: "pdb-cal__grid" }, ...cells),
  );
}

function legend(): HTMLElement {
  const key = (shade: CalendarCell["shade"], text: string) =>
    el("span", { class: "pdb-cal__key" }, el("span", { class: `pdb-cal__swatch pdb-cal__cell--${shade}` }), text);
  return el(
    "p",
    { class: "label pdb-cal__legend" },
    key("none", "not played"),
    key("missed", "handed in, none solved"),
    key("s2", "some solved"),
    key("s4", "all solved"),
  );
}

/** One mini-month per month that holds finished days, newest first; six, then the rest on request. */
export function calendarPanel(body: SitePlayerBody, index: SiteIndex): HTMLElement {
  const months = monthsOf(index.data.days.map((day) => day.day));
  if (months.length === 0) return panel("Calendar", { class: "pdb-calendar" }, el("p", { class: "note", text: "No finished days yet." }));
  const grids = months.map((month) => monthGrid(month, body.runs, index));
  const holder = el("div", { class: "pdb-cal-months" }, ...grids.slice(0, MONTHS_SHOWN));
  const more = grids.length <= MONTHS_SHOWN ? null : showAllButton(`Show all ${grids.length} months`, holder, grids);
  return panel("Calendar", { class: "pdb-calendar" }, holder, more, legend());
}

// ── The puzzles cleared ──────────────────────────────────────────────────────

function clearedChip(id: number, index: SiteIndex): HTMLElement {
  const puzzle = index.byId.get(id);
  // The build lists only puzzles the index holds; one it somehow does not is its number, unlinked.
  if (!puzzle) return el("li", {}, el("span", { class: "pdb-cleared__link", text: `#${id}` }));
  return el(
    "li",
    {},
    el(
      "a",
      { class: "pdb-cleared__link", attrs: { href: pathOf({ kind: "puzzle", id }) } },
      tierDot(puzzle.tier),
      `#${id} ${titleOf(puzzle)}`,
    ),
  );
}

/** Of the count, the clears the list cannot show, said once. */
function unlistedNote(count: number, listed: number): HTMLElement | null {
  const more = count - listed;
  if (more <= 0) return null;
  if (listed === 0) return el("p", { class: "note", text: `${plural(count, "puzzle")} cleared, none of them one this site lists.` });
  const text = more === 1 ? "1 more is a puzzle this site does not list." : `${more} more are puzzles this site does not list.`;
  return el("p", { class: "note", text });
}

/** The listed puzzles they cleared, as chips in id order: forty, then the rest on request. */
export function clearedPanel(body: SitePlayerBody, index: SiteIndex): HTMLElement {
  const count = body.totals.puzzlesCleared;
  const ids = [...body.cleared].sort((a, b) => a - b);
  if (ids.length === 0 && count === 0) {
    return panel("Puzzles cleared", { class: "pdb-cleared" }, el("p", { class: "note", text: "No puzzles cleared before the newest finished day." }));
  }
  const chips = ids.map((id) => clearedChip(id, index));
  const list = el("ul", { class: "pdb-cleared__list" }, ...chips.slice(0, CLEARED_SHOWN));
  const more = chips.length <= CLEARED_SHOWN ? null : showAllButton(`Show all ${chips.length}`, list, chips);
  return panel("Puzzles cleared", { class: "pdb-cleared" }, ids.length === 0 ? null : list, more, unlistedNote(count, ids.length));
}
