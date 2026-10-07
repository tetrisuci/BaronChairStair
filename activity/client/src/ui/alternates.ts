/**
 * Explore's second tab: every alternate solution on file, across every puzzle.
 *
 * An *alternate* is a line a player found that the game credits — it solved
 * the puzzle, or sent more than it asked — and that still describes a board
 * that exists. Never the maker's own answer and never the batch search's
 * output; the server's query is the Discoveries board's own clause.
 *
 * The rows are the explorer's rows, wearing one more line: the puzzle on top,
 * and under it who found the line, how long ago, and — once the reader has
 * solved that puzzle — what it sent, how long it was and what it cleared. A
 * row on a puzzle the reader has not solved arrives from the server without
 * any of that, and is shut with the reason on it, as the explorer shuts
 * today's puzzle: a disabled button with only a tooltip is a row that looks
 * broken. Today's unsolved tiers are not in the list at all.
 *
 * The order is `shared/alternate-sort.ts`'s, which db.tetrisatuci.org's
 * Alternates page uses too, so the two lists never disagree about what
 * "hardest first" means. It is held here, for the session: a refetch replaces
 * the rows and keeps the reader's sort.
 */

import {
  ALTERNATE_SORT_LABELS,
  ALTERNATE_SORTS,
  type AlternateOrder,
  DEFAULT_ALTERNATE_ORDER,
  defaultDirection,
  readAlternateOrder,
  sortAlternates,
} from "@shared/alternate-sort";
import type { AlternateRow } from "../api";
import { ago } from "./ago";
import { el, panel, replaceChildren } from "./dom";
import { choice, labelled } from "./explorer";

export interface AlternatesCallbacks {
  /** Step this line out on the board. Only ever called for an unlocked row. */
  readonly onOpen: (row: AlternateRow) => void;
  readonly onClose: () => void;
}

export interface AlternatesBrowser {
  readonly element: HTMLElement;
  /**
   * @param selfId the reader, so their own lines are credited to "You".
   */
  update(rows: readonly AlternateRow[], selfId: string): void;
  /** The fetch failed. Says so only if there is nothing older on screen to keep. */
  failed(): void;
}

const DIRECTION_WORDS = {
  asc: { arrow: "↑", word: "ascending", other: "descending" },
  desc: { arrow: "↓", word: "descending", other: "ascending" },
} as const;

/** Who found it. Every alternate has a finder; `null` is a missing players row. */
function credit(row: AlternateRow, selfId: string): string {
  if (!row.finder) return "somebody";
  return row.finder.id === selfId ? "You" : row.finder.username;
}

function countText(total: number): string {
  return total === 1 ? "1 alternate solution" : `${total} alternate solutions`;
}

export function createAlternates(
  callbacks: AlternatesCallbacks,
  now: () => number = Date.now,
): AlternatesBrowser {
  let order: AlternateOrder = DEFAULT_ALTERNATE_ORDER;
  let rows: readonly AlternateRow[] | null = null;
  let selfId = "";

  const sort = choice(
    ALTERNATE_SORTS.map((value) => ({ value, label: ALTERNATE_SORT_LABELS[value] })),
    (value) => {
      // A new sort starts the way a reader expects it to — newest, hardest,
      // most attack — rather than inheriting a direction chosen for another.
      const picked = readAlternateOrder(value, null);
      order = { sort: picked.sort, direction: defaultDirection(picked.sort) };
      draw();
    },
  );
  sort.classList.add("alternates__sort");
  sort.setAttribute("aria-label", "Sort alternate solutions by");

  const direction = el("button", {
    class: "btn btn--small alternates__direction",
    on: {
      click: () => {
        order = { ...order, direction: order.direction === "asc" ? "desc" : "asc" };
        draw();
      },
    },
  });

  const count = el("p", { class: "explore__count", text: "Reading…" });
  const list = el("div", { class: "explore__list alternates__list" });
  const close = el("button", { class: "btn", text: "Back to the daily" });
  close.addEventListener("click", () => callbacks.onClose());

  const element = panel(
    "Alternate solutions",
    { class: "explore alternates" },
    el("div", { class: "explore__filters" }, labelled("Sort by", sort, direction)),
    el("div", { class: "btnrow explore__actions" }, close),
    count,
    list,
  );

  function row(line: AlternateRow): HTMLElement {
    const rating = line.difficulty !== null ? `d${line.difficulty}` : "unrated";
    const facts = [credit(line, selfId), ago(line.foundAt, now())].filter(Boolean);
    // Read off `locked` *and* the values: the server nulls them together, and a
    // row that printed "null attack" because one arrived without the other
    // would be worse than one that printed nothing.
    const stats =
      !line.locked && line.attack !== null && line.pieces !== null
        ? `${line.attack} attack · ${line.pieces} pieces`
        : null;
    const clears = !line.locked && line.clears && line.clears.length > 0 ? line.clears : null;

    const item = el(
      "button",
      {
        class: `explore__item alternates__item${line.locked ? " explore__item--locked" : ""}`,
        attrs: { "data-solution": line.solutionId, ...(line.locked ? { disabled: true } : {}) },
        title: line.locked
          ? "Solve this puzzle yourself and its alternate solutions open here."
          : "Step through this line on the board",
      },
      el("span", { class: "explore__id", text: `#${line.puzzleId}` }),
      el(
        "span",
        { class: "explore__title" },
        line.title || "untitled",
        line.locked ? el("span", { class: "explore__locked", text: "solve it first" }) : null,
      ),
      el("span", { class: "explore__meta", text: rating }),
      el(
        "span",
        { class: "alternates__facts" },
        el("span", { class: "alternates__who", text: facts[0] ?? "" }),
        facts[1] ? ` · ${facts[1]}` : null,
        stats ? ` · ${stats}` : null,
        clears ? el("span", { class: "alternates__clears", text: clears.join(" · ") }) : null,
      ),
    );
    if (!line.locked) item.addEventListener("click", () => callbacks.onOpen(line));
    return item;
  }

  function drawControls(): void {
    sort.value = order.sort;
    const words = DIRECTION_WORDS[order.direction];
    direction.textContent = words.arrow;
    // The arrow is the state; the label says it in words, and what a press does.
    direction.setAttribute("aria-label", `Sorted ${words.word}. Switch to ${words.other}`);
    direction.title = `Sorted ${words.word} — click for ${words.other}`;
  }

  function draw(): void {
    drawControls();
    if (rows === null) return;
    count.textContent = countText(rows.length);
    if (rows.length === 0) {
      replaceChildren(
        list,
        el("p", {
          class: "note",
          text: "No alternate solutions yet. Solve a puzzle a way nobody has, and yours is the first.",
        }),
      );
      return;
    }
    const sorted = sortAlternates(
      rows.map((line) => ({ ...line, found: line.foundAt, tiebreak: line.solutionId })),
      order,
    );
    replaceChildren(list, ...sorted.map(row));
  }

  drawControls();

  return {
    element,
    update(next, reader) {
      rows = next;
      selfId = reader;
      draw();
    },
    failed() {
      if (rows === null) count.textContent = "Could not read the alternate solutions.";
    },
  };
}
