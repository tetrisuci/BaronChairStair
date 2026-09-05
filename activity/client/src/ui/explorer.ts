/**
 * The puzzle explorer: the whole archive, filtered down to what you want.
 *
 * The list is held in the browser, so every keystroke re-filters 138 puzzles
 * without a round trip. The same filter decides what a random puzzle is drawn
 * from, which is the point of letting it be saved rather than living in the
 * page — set it once, and the shuffle respects it forever after.
 */

import {
  type ArchiveFilter,
  type ArchiveSort,
  filterArchive,
  isDefaultFilter,
  MAX_DIFFICULTY,
  MAX_PIECES,
  MIN_DIFFICULTY,
  MIN_PIECES,
  SORT_LABELS,
} from "@shared/archive-filter";
import type { ArchiveListing } from "@shared/puzzle";
import { el, panel, replaceChildren, setToggleLabel } from "./dom";

/** Rows drawn at once. Past this the list is scrolled, not paged. */
const MAX_ROWS = 200;

export interface ExplorerCallbacks {
  readonly onChange: (filter: ArchiveFilter) => void;
  readonly onPlay: (id: number) => void;
  readonly onRandom: () => void;
  readonly onClose: () => void;
}

export interface Explorer {
  readonly element: HTMLElement;
  /** `locked` is whichever of today's three are still unplayed. */
  update(entries: readonly ArchiveListing[], filter: ArchiveFilter, locked: ReadonlySet<number>): void;
}

function labelled(label: string, ...controls: (HTMLElement | string)[]): HTMLElement {
  return el(
    "div",
    { class: "explore__row" },
    el("span", { class: "explore__label", text: label }),
    el("div", { class: "explore__controls" }, ...controls),
  );
}

/** A number input, because a pair of them reads better than a two-thumb slider. */
function numberBox(min: number, max: number, onInput: (value: number) => void): HTMLInputElement {
  const input = el("input", {
    class: "explore__number",
    attrs: { type: "number", min, max, inputmode: "numeric" },
  });
  input.addEventListener("change", () => {
    const value = Number(input.value);
    if (Number.isFinite(value)) onInput(value);
  });
  return input;
}

function choice(
  options: readonly { value: string; label: string }[],
  onPick: (value: string) => void,
): HTMLSelectElement {
  const select = el("select", { class: "spec__select explore__select" });
  for (const option of options) {
    select.append(el("option", { text: option.label, attrs: { value: option.value } }));
  }
  select.addEventListener("change", () => onPick(select.value));
  return select;
}

export function createExplorer(callbacks: ExplorerCallbacks): Explorer {
  let filter: ArchiveFilter | null = null;
  const patch = (change: Partial<ArchiveFilter>) => {
    if (filter) callbacks.onChange({ ...filter, ...change });
  };

  const search = el("input", {
    class: "explore__search",
    attrs: { type: "search", placeholder: "title, author, goal…", "aria-label": "Search puzzles" },
  });
  search.addEventListener("input", () => patch({ search: search.value }));

  const minDifficulty = numberBox(MIN_DIFFICULTY, MAX_DIFFICULTY, (v) => patch({ minDifficulty: v }));
  const maxDifficulty = numberBox(MIN_DIFFICULTY, MAX_DIFFICULTY, (v) => patch({ maxDifficulty: v }));
  const minPieces = numberBox(MIN_PIECES, MAX_PIECES, (v) => patch({ minPieces: v }));
  const maxPieces = numberBox(MIN_PIECES, MAX_PIECES, (v) => patch({ maxPieces: v }));

  // The state is spelled out. It was colour alone once, to keep the row on one
  // line, but a green button only reads to someone who has been told what green
  // means here — and to anyone who cannot separate it from the plain one, it
  // reads as nothing at all. The button is held at a fixed width so ON and OFF
  // do not reflow the row on every click; on a narrow viewport it may take a
  // second line, which is the price and is worth it.
  const unrated = el("button", { class: "btn btn--small explore__toggle" });
  setToggleLabel(unrated, "Unrated", true);
  unrated.addEventListener("click", () => patch({ includeUnrated: !filter?.includeUnrated }));

  // Built once the archive arrives, since their options come from it.
  const setSlot = el("span", { class: "explore__slot" });
  const authorSlot = el("span", { class: "explore__slot" });

  const sort = choice(
    (Object.keys(SORT_LABELS) as ArchiveSort[]).map((value) => ({ value, label: SORT_LABELS[value] })),
    (value) => patch({ sort: value as ArchiveSort }),
  );

  const count = el("p", { class: "explore__count", text: "" });
  const list = el("div", { class: "explore__list" });

  const reset = el("button", { class: "btn btn--small", text: "Clear filters" });
  reset.addEventListener("click", () => patch({
    search: "",
    minDifficulty: MIN_DIFFICULTY,
    maxDifficulty: MAX_DIFFICULTY,
    includeUnrated: true,
    minPieces: MIN_PIECES,
    maxPieces: MAX_PIECES,
    sets: [],
    authors: [],
  }));

  const random = el("button", { class: "btn btn--primary", text: "Play a random match" });
  random.addEventListener("click", () => callbacks.onRandom());
  const close = el("button", { class: "btn", text: "Back to the daily" });
  close.addEventListener("click", () => callbacks.onClose());

  // The filters are one block so they can lay out in columns when there is
  // width for it, and so they stay a fixed header while the list below them
  // takes whatever height is left.
  const filters = el(
    "div",
    { class: "explore__filters" },
    labelled("Search", search),
    labelled("Difficulty", minDifficulty, el("span", { class: "explore__to", text: "to" }), maxDifficulty, unrated),
    labelled("Pieces", minPieces, el("span", { class: "explore__to", text: "to" }), maxPieces),
    labelled("Set", setSlot),
    labelled("Author", authorSlot),
    labelled("Sort by", sort),
  );

  const element = panel(
    "Explore",
    { class: "explore" },
    filters,
    el("div", { class: "btnrow explore__actions" }, random, reset, close),
    count,
    list,
  );

  /** Fills a dropdown from whatever values the archive actually contains. */
  function optionsFrom(
    entries: readonly ArchiveListing[],
    read: (entry: ArchiveListing) => string | null,
    anyLabel: string,
  ): { value: string; label: string }[] {
    const seen = new Set<string>();
    for (const entry of entries) {
      const value = read(entry);
      if (value) seen.add(value);
    }
    return [
      { value: "", label: anyLabel },
      ...[...seen].sort().map((value) => ({ value, label: value })),
    ];
  }

  let builtOptions = false;
  let setSelect: HTMLSelectElement | null = null;
  let authorSelect: HTMLSelectElement | null = null;

  function row(entry: ArchiveListing, locked: boolean): HTMLElement {
    const rating = entry.difficulty > 0 ? `d${entry.difficulty}` : "unrated";
    const line = el(
      "button",
      {
        class: `explore__item${locked ? " explore__item--locked" : ""}`,
        attrs: locked ? { disabled: true } : {},
        title: locked
          ? "One of today's three. Solve it on the daily and it opens here."
          : `${entry.goal} · ${entry.targetAttack} attack`,
      },
      el("span", { class: "explore__id", text: `#${entry.id}` }),
      el(
        "span",
        { class: "explore__title" },
        entry.title || "untitled",
        // The reason, on the row rather than in a `title` attribute. A greyed
        // line with a tooltip is a line that looks broken: the attribute needs
        // a hover nobody thinks to try, and a browser will not show one on a
        // disabled button at all — so the only thing the player was told was
        // that this puzzle is different, never why.
        locked
          ? el("span", { class: "explore__locked", text: "today's — solve it on the daily" })
          : null,
      ),
      el("span", { class: "explore__meta", text: `${rating} · ${entry.pieces}p` }),
    );
    if (!locked) line.addEventListener("click", () => callbacks.onPlay(entry.id));
    return line;
  }

  return {
    element,
    update(entries, next, locked) {
      filter = next;

      if (!builtOptions && entries.length > 0) {
        builtOptions = true;
        setSelect = choice(optionsFrom(entries, (e) => e.set, "Any set"), (value) =>
          patch({ sets: value ? [value] : [] }),
        );
        authorSelect = choice(optionsFrom(entries, (e) => e.author, "Anyone"), (value) =>
          patch({ authors: value ? [value] : [] }),
        );
        replaceChildren(setSlot, setSelect);
        replaceChildren(authorSlot, authorSelect);
      }

      // Written back rather than left alone: the filter can change from
      // somewhere else — Clear filters, or a copy synced from another device —
      // and a control still showing the old value would be lying.
      if (document.activeElement !== search) search.value = next.search;
      minDifficulty.value = String(next.minDifficulty);
      maxDifficulty.value = String(next.maxDifficulty);
      minPieces.value = String(next.minPieces);
      maxPieces.value = String(next.maxPieces);
      setToggleLabel(unrated, "Unrated", next.includeUnrated);
      unrated.title = next.includeUnrated
        ? "Unrated puzzles are shown. Click to hide them."
        : "Unrated puzzles are hidden. Click to show them.";
      if (setSelect) setSelect.value = next.sets[0] ?? "";
      if (authorSelect) authorSelect.value = next.authors[0] ?? "";
      sort.value = next.sort;

      const matches = filterArchive(entries, next);
      random.disabled = !matches.some((entry) => !locked.has(entry.id));
      count.textContent =
        matches.length === entries.length
          ? `All ${entries.length} puzzles`
          : `${matches.length} of ${entries.length} puzzles` +
            (isDefaultFilter(next) ? "" : " match your filters");

      if (matches.length === 0) {
        replaceChildren(
          list,
          el("p", { class: "note", text: "Nothing matches. Widen the range, or clear the filters." }),
        );
        return;
      }
      replaceChildren(
        list,
        ...matches.slice(0, MAX_ROWS).map((entry) => row(entry, locked.has(entry.id))),
        matches.length > MAX_ROWS
          ? el("p", { class: "note", text: `…and ${matches.length - MAX_ROWS} more.` })
          : null,
      );
    },
  };
}
