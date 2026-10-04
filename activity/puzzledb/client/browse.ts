/**
 * The front page: the latest finished day, then every puzzle, filtered the way
 * the game filters them.
 *
 * **The latest day leads.** The most common reason to open the archive is the
 * day just played — "what was yesterday's hard?" — so its puzzles come first,
 * each a click from its board and its answer, before anything has to be
 * searched for. It is the newest *finished* day the data holds; today is never
 * in the data, so nothing here can point at it.
 *
 * **The filters are the game's.** `shared/archive-filter.ts` decides what
 * matches and in what order, with the in-game explorer's layout, classes and
 * wording, so a player who knows one knows the other. `createExplorer` itself
 * is not reused: its buttons are wired to the game ("Play a random match",
 * "Back to the daily") and its rows are play buttons. The thirty lines of
 * control helpers are written again here instead.
 *
 * **Cards are built once and moved, never rebuilt.** Each holds an SVG of its
 * board — the archive's largest is fourteen rows of ten — and a filter change
 * on every keystroke only has to put a different subset of the same elements
 * in a different order.
 *
 * Author-typed text — title, author, goal, set — reaches the DOM as text only,
 * through `el`'s `text` and string children, never as markup.
 */

import {
  type ArchiveFilter,
  type ArchiveSort,
  DEFAULT_ARCHIVE_FILTER,
  filterArchive,
  isDefaultFilter,
  MAX_DIFFICULTY,
  MAX_PIECES,
  MIN_DIFFICULTY,
  MIN_PIECES,
  sanitizeArchiveFilter,
  SORT_LABELS,
} from "@shared/archive-filter";
import type { ArchiveListing } from "@shared/puzzle";
import { boardGlyph } from "../../client/src/render/piece-glyph";
import { el, panel, replaceChildren, setToggleLabel } from "../../client/src/ui/dom";
import { dayLabel, pathOf, type SitePuzzle } from "../wire";
import { ratingOf, type SiteIndex, titleOf } from "./data";
import { dealCard } from "./days";
import { aboutPanel } from "./frame";

export interface BrowseView {
  readonly element: HTMLElement;
  /** Shows a filter that arrived from elsewhere — the address bar, on Back. */
  update(filter: ArchiveFilter): void;
}

export interface BrowseHandlers {
  /** Every filter the reader makes, already sanitized and already on screen. */
  onFilter(filter: ArchiveFilter): void;
}

/** A change to the filter, worked out from the one in force. */
type Change = (current: ArchiveFilter) => Partial<ArchiveFilter>;

const NOTHING_MATCHES = "Nothing matches. Widen the range, or clear the filters.";

// ── The latest day ───────────────────────────────────────────────────────────

/**
 * The newest finished day, a card per tier, or nothing while no day has finished.
 *
 * Its heading links to the day's own page, which is where each tier offers
 * its answer outright; the cards here lead to the puzzles.
 */
function latestDay(index: SiteIndex): HTMLElement | null {
  const days = index.data.days;
  // The last, because `SiteData.days` is ascending: the server reads them back in day order.
  const latest = days[days.length - 1];
  if (!latest) return null;
  const dayLink = el("a", {
    text: `Day ${latest.day} · ${dayLabel(latest.day)}`,
    attrs: { href: pathOf({ kind: "day", day: latest.day }) },
  });
  return el(
    "section",
    { class: "panel pdb-latest" },
    el("h2", { class: "panel__caption" }, dayLink),
    el("p", { class: "label", text: "the latest finished day" }),
    el("ul", { class: "pdb-deals" }, ...latest.deals.map((deal) => dealCard(deal, index))),
    el("a", { class: "pdb-more", text: "All days →", attrs: { href: pathOf({ kind: "days" }) } }),
  );
}

// ── The controls ─────────────────────────────────────────────────────────────

interface Controls {
  readonly search: HTMLInputElement;
  readonly minDifficulty: HTMLInputElement;
  readonly maxDifficulty: HTMLInputElement;
  readonly unrated: HTMLButtonElement;
  readonly minPieces: HTMLInputElement;
  readonly maxPieces: HTMLInputElement;
  readonly set: HTMLSelectElement;
  readonly author: HTMLSelectElement;
  readonly sort: HTMLSelectElement;
}

function labelled(label: string, ...controls: (HTMLElement | string)[]): HTMLElement {
  return el(
    "div",
    { class: "explore__row" },
    el("span", { class: "explore__label", text: label }),
    el("div", { class: "explore__controls" }, ...controls),
  );
}

/**
 * A number box that reports on `change`, as the explorer's do.
 *
 * An emptied box means "no limit" — the end of the scale it bounds — rather
 * than zero, which the sanitizer would clamp to the bottom of the scale and
 * turn "clear the maximum" into "at most 1".
 */
function numberBox(
  label: string,
  name: string,
  bounds: { readonly min: number; readonly max: number; readonly empty: number },
  onValue: (value: number) => void,
) {
  const { min, max, empty } = bounds;
  const input = el("input", {
    class: "explore__number",
    attrs: { type: "number", name, min, max, step: 1, inputmode: "numeric", "aria-label": label },
  });
  input.addEventListener("change", () => {
    const value = input.value.trim() === "" ? empty : Number(input.value);
    if (Number.isFinite(value)) onValue(value);
  });
  return input;
}

function choice(
  label: string,
  name: string,
  options: readonly { value: string; label: string }[],
  onPick: (value: string) => void,
) {
  const select = el("select", {
    class: "spec__select explore__select",
    attrs: { name, "aria-label": label },
  });
  for (const option of options) {
    select.append(el("option", { text: option.label, attrs: { value: option.value } }));
  }
  select.addEventListener("change", () => onPick(select.value));
  return select;
}

/** "Any" first, then every value the archive actually holds, in reading order. */
function optionsFrom(
  listings: readonly ArchiveListing[],
  read: (entry: ArchiveListing) => string | null,
  anyLabel: string,
) {
  const values = [...new Set(listings.map(read).filter((value): value is string => Boolean(value)))];
  return [
    { value: "", label: anyLabel },
    ...values.sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value })),
  ];
}

/**
 * Selects a value, adding it first if the archive does not hold it.
 *
 * A shared link can name a set or an author this archive has never had — a
 * typo, a rename since. The filter still applies it, and matches nothing, so
 * the box has to say what is being applied: showing "Any set" over an empty
 * list would be the control lying about why it is empty.
 */
function showChoice(select: HTMLSelectElement, value: string): void {
  if (value !== "" && ![...select.options].some((option) => option.value === value)) {
    select.append(el("option", { text: value, attrs: { value } }));
  }
  select.value = value;
}

/**
 * Every control, each reporting its change through `apply`.
 *
 * Each field is named after the query parameter it ends up in (`filter-url.ts`).
 * Nothing submits them — there is no form — but a browser's autofill reads a
 * nameless field as one it ought to fill, and flags every one of them.
 */
function buildControls(listings: readonly ArchiveListing[], apply: (change: Change) => void): Controls {
  const patch = (change: Partial<ArchiveFilter>) => apply(() => change);
  const search = el("input", {
    class: "explore__search",
    attrs: {
      type: "search",
      name: "q",
      placeholder: "title, author, goal, set…",
      "aria-label": "Search puzzles",
    },
  });
  search.addEventListener("input", () => patch({ search: search.value }));
  const unrated = el("button", { class: "btn btn--small explore__toggle", attrs: { type: "button" } });
  unrated.addEventListener("click", () => apply((current) => ({ includeUnrated: !current.includeUnrated })));
  const sortKeys = Object.keys(SORT_LABELS) as ArchiveSort[];
  const sorts = sortKeys.map((value) => ({ value, label: SORT_LABELS[value] }));
  const difficulty = { min: MIN_DIFFICULTY, max: MAX_DIFFICULTY };
  const pieces = { min: MIN_PIECES, max: MAX_PIECES };
  return {
    search,
    minDifficulty: numberBox("Lowest difficulty", "d-min", { ...difficulty, empty: MIN_DIFFICULTY }, (v) =>
      patch({ minDifficulty: v }),
    ),
    maxDifficulty: numberBox("Highest difficulty", "d-max", { ...difficulty, empty: MAX_DIFFICULTY }, (v) =>
      patch({ maxDifficulty: v }),
    ),
    unrated,
    minPieces: numberBox("Fewest pieces", "p-min", { ...pieces, empty: MIN_PIECES }, (value) =>
      patch({ minPieces: value }),
    ),
    maxPieces: numberBox("Most pieces", "p-max", { ...pieces, empty: MAX_PIECES }, (value) =>
      patch({ maxPieces: value }),
    ),
    set: choice("Set", "set", optionsFrom(listings, (entry) => entry.set, "Any set"), (value) =>
      patch({ sets: value ? [value] : [] }),
    ),
    author: choice("Author", "by", optionsFrom(listings, (entry) => entry.author, "Anyone"), (value) =>
      patch({ authors: value ? [value] : [] }),
    ),
    sort: choice("Sort by", "sort", sorts, (value) => patch({ sort: value as ArchiveSort })),
  };
}

/**
 * Puts the filter back into every control.
 *
 * Written back rather than left alone, as the explorer does: a filter also
 * arrives from the address bar and from Clear filters, and a control still
 * showing the old value would be lying. The search box is spared while it has
 * the caret, which is the only reason typing into it survives a redraw.
 */
function writeBack(controls: Controls, filter: ArchiveFilter): void {
  const { search } = controls;
  if (search.ownerDocument.activeElement !== search) search.value = filter.search;
  controls.minDifficulty.value = String(filter.minDifficulty);
  controls.maxDifficulty.value = String(filter.maxDifficulty);
  setToggleLabel(controls.unrated, "Unrated", filter.includeUnrated);
  controls.unrated.title = filter.includeUnrated
    ? "Unrated puzzles are shown. Click to hide them."
    : "Unrated puzzles are hidden. Click to show them.";
  controls.minPieces.value = String(filter.minPieces);
  controls.maxPieces.value = String(filter.maxPieces);
  showChoice(controls.set, filter.sets[0] ?? "");
  showChoice(controls.author, filter.authors[0] ?? "");
  controls.sort.value = filter.sort;
}

function filterPanel(controls: Controls, apply: (change: Change) => void): HTMLElement {
  const clear = el("button", { class: "btn btn--small", text: "Clear filters", attrs: { type: "button" } });
  // Everything but the order, as in the game: sorting is how the list reads, not what is in it.
  clear.addEventListener("click", () =>
    apply((current) => ({ ...DEFAULT_ARCHIVE_FILTER, sort: current.sort })),
  );
  const to = () => el("span", { class: "explore__to", text: "to" });
  return panel(
    "Find a puzzle",
    { class: "explore pdb-filters" },
    el(
      "div",
      { class: "explore__filters" },
      labelled("Search", controls.search),
      labelled("Difficulty", controls.minDifficulty, to(), controls.maxDifficulty, controls.unrated),
      labelled("Pieces", controls.minPieces, to(), controls.maxPieces),
      labelled("Set", controls.set),
      labelled("Author", controls.author),
      labelled("Sort by", controls.sort),
    ),
    el("div", { class: "btnrow explore__actions" }, clear),
  );
}

// ── The results ──────────────────────────────────────────────────────────────

/** One puzzle as a link: its board, `#42` and its title, the rating and length, and its maker. */
function puzzleCard(puzzle: SitePuzzle): HTMLAnchorElement {
  return el(
    "a",
    { class: "pdb-card", attrs: { href: pathOf({ kind: "puzzle", id: puzzle.id }) } },
    el("span", { class: "pdb-card__board" }, boardGlyph(puzzle.board)),
    el(
      "span",
      { class: "pdb-card__name" },
      el("span", { class: "pdb-card__id", text: `#${puzzle.id}` }),
      " ",
      el("span", { class: "pdb-card__title", text: titleOf(puzzle) }),
    ),
    el("span", { class: "pdb-card__meta", text: ratingOf(puzzle) }),
    puzzle.author ? el("span", { class: "pdb-card__by", text: `by ${puzzle.author}` }) : null,
  );
}

/** `All 138 puzzles`, or `12 of 138 puzzles match your filters` — the explorer's own words. */
function countLine(shown: number, total: number, filter: ArchiveFilter): string {
  if (shown === total) return `All ${total} puzzles`;
  return `${shown} of ${total} puzzles${isDefaultFilter(filter) ? "" : " match your filters"}`;
}

interface Results {
  readonly element: HTMLElement;
  show(filter: ArchiveFilter): void;
}

function resultsFor(index: SiteIndex): Results {
  const count = el("p", { class: "explore__count", attrs: { role: "status" } });
  const grid = el("div", { class: "pdb-grid" });
  const empty = el("p", { class: "note pdb-empty", text: NOTHING_MATCHES });
  const body = el("div", { class: "pdb-results__body" });
  const cards = new Map<number, HTMLAnchorElement>();
  const cardFor = (id: number): HTMLAnchorElement | null => {
    const puzzle = index.byId.get(id);
    if (!puzzle) return null;
    const card = cards.get(id) ?? puzzleCard(puzzle);
    cards.set(id, card);
    return card;
  };
  return {
    element: el("section", { class: "pdb-results", attrs: { "aria-label": "Puzzles" } }, count, body),
    show(filter) {
      const matches = filterArchive(index.listings, filter);
      count.textContent = countLine(matches.length, index.listings.length, filter);
      replaceChildren(grid, ...matches.map((entry) => cardFor(entry.id)));
      replaceChildren(body, matches.length === 0 ? empty : grid);
    },
  };
}

// ── The page ─────────────────────────────────────────────────────────────────

/** `/`: the latest day, the filters, the matching puzzles, and what this archive is. */
export function createBrowseView(
  index: SiteIndex,
  filter: ArchiveFilter,
  handlers: BrowseHandlers,
): BrowseView {
  let current = sanitizeArchiveFilter(filter);
  const controls = buildControls(index.listings, apply);
  const results = resultsFor(index);

  function render(next: ArchiveFilter): void {
    current = next;
    writeBack(controls, next);
    results.show(next);
  }

  function apply(change: Change): void {
    const next = sanitizeArchiveFilter({ ...current, ...change(current) });
    render(next);
    handlers.onFilter(next);
  }

  const element = el(
    "div",
    { class: "pdb-stack pdb-browse" },
    el(
      "header",
      { class: "pdb-page-head" },
      el("h1", { class: "display pdb-title", text: "The club's puzzles" }),
      el("p", {
        class: "pdb-lede",
        text: "Every puzzle the Tetris at UCI daily deals from, and every finished day's deal.",
      }),
    ),
    latestDay(index),
    filterPanel(controls, apply),
    results.element,
    aboutPanel(index.data.about),
  );
  render(current);
  return { element, update: (next) => render(sanitizeArchiveFilter(next)) };
}
