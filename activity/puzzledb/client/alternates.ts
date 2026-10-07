/**
 * `/alternates`: every line players found through any puzzle — every way
 * through besides the maker's — as one table a reader can sort.
 *
 * **The order is the activity's own** (`shared/alternate-sort.ts`): the same
 * six sorts, the same natural direction for each, unrated puzzles last
 * whichever way the list runs, and the same fall-back for a tie, so the
 * activity's list and this one never put two lines in different orders. A row
 * maps onto `SortableAlternate` with the day it was found as `found` and its
 * puzzle and position as the tiebreak, which is unique per line and the same in
 * every build.
 *
 * **A header sorts; pressed again, it turns the sort around**, and the button
 * beside the count turns it around too, saying which way it runs now. The
 * puzzle column has two buttons, by number and by name, because both are the
 * one column's text. Sort and direction are kept in the address
 * (`list-queries.ts`), so "the hardest puzzles' lines" is a link.
 *
 * **A row names a line by its puzzle and position, and links to that chip**,
 * `/puzzle/:id#line-N`, where the puzzle page opens the replay on it. Nothing
 * here says who found a line; the day is the game's calendar day, printed as
 * the site prints every day. A row whose puzzle the index does not list is
 * dropped and never drawn: within one build it cannot happen, and if it ever
 * did it would be a puzzle the site chose not to show.
 */

import {
  type AlternateOrder,
  type AlternateSort,
  defaultDirection,
  type SortableAlternate,
  sortAlternates,
} from "@shared/alternate-sort";
import { GOAL_LABELS } from "@shared/goal";
import type { ClearName } from "@shared/puzzle";
import { el } from "../../client/src/ui/dom";
import { dayLabel, pathOf, type SitePuzzle } from "../wire";
import type { SiteAlternateRow } from "../wire-alternates";
import { plural } from "./board-rows";
import { type BodyView, readBody, type SiteIndex, titleOf } from "./data";
import { queryForAlternates } from "./list-queries";

/** A body row with the index's puzzle for it, in the shape the shared order sorts. */
interface Row extends SortableAlternate {
  readonly line: SiteAlternateRow;
  readonly puzzle: SitePuzzle;
}

/** Room for a thousand lines on one puzzle before two rows' tiebreaks could meet. */
const LINES_PER_PUZZLE = 1_000;

/** A sortable header: its words, and the sort it asks for. */
interface Header {
  readonly sort: AlternateSort;
  readonly label: string;
  /** What a screen reader hears: says what the press does, and holds the words shown, so a spoken "press Attack" still finds it. */
  readonly name: string;
}

const PUZZLE_HEADERS: readonly Header[] = [
  { sort: "number", label: "Number", name: "Sort by puzzle number" },
  { sort: "title", label: "Name", name: "Sort by puzzle name" },
];

/** The number columns after the puzzle, each with its one sort. Clears do not sort. */
const NUMBER_HEADERS: readonly Header[] = [
  { sort: "difficulty", label: "Difficulty", name: "Sort by difficulty" },
  { sort: "found", label: "Found", name: "Sort by the day it was found" },
  { sort: "attack", label: "Attack", name: "Sort by attack" },
  { sort: "pieces", label: "Pieces", name: "Sort by pieces" },
];

const DIRECTION_WORDS = { asc: "Ascending", desc: "Descending" } as const;
const ARIA_SORT = { asc: "ascending", desc: "descending" } as const;

const EMPTY = "No player has found another way through a puzzle yet.";

/** The rows the index can name, mapped for the shared order; any other is dropped here. */
function rowsOf(lines: readonly SiteAlternateRow[], index: SiteIndex): Row[] {
  return lines.flatMap((line) => {
    const puzzle = index.byId.get(line.puzzleId);
    if (!puzzle) return [];
    return [
      {
        line,
        puzzle,
        puzzleId: line.puzzleId,
        title: titleOf(puzzle),
        difficulty: puzzle.difficulty,
        found: line.day,
        attack: line.attack,
        pieces: line.pieces,
        tiebreak: line.puzzleId * LINES_PER_PUZZLE + line.position,
      },
    ];
  });
}

/** `TSD ×2 · Single`, in the order the line first made each; a dash for none. */
export function clearsText(clears: readonly ClearName[]): string {
  if (clears.length === 0) return "—";
  return [...new Set(clears)]
    .map((clear) => {
      const count = clears.filter((made) => made === clear).length;
      return count === 1 ? GOAL_LABELS[clear] : `${GOAL_LABELS[clear]} ×${count}`;
    })
    .join(" · ");
}

/** Where a press on `sort` goes: the other way round if it is the sort already, else that sort's natural way. */
function pressed(order: AlternateOrder, sort: AlternateSort): AlternateOrder {
  if (order.sort !== sort) return { sort, direction: defaultDirection(sort) };
  return { sort, direction: order.direction === "asc" ? "desc" : "asc" };
}

function sortButton(header: Header, order: AlternateOrder, onOrder: (next: AlternateOrder) => void): HTMLElement {
  const on = header.sort === order.sort;
  return el("button", {
    class: `pdb-sort${on ? ` pdb-sort--on pdb-sort--${order.direction}` : ""}`,
    text: header.label,
    attrs: { type: "button", "aria-label": header.name },
    on: { click: () => onOrder(pressed(order, header.sort)) },
  });
}

/** One column's header: its sort buttons, and `aria-sort` while the table is sorted by one of them. */
function headerCell(
  headers: readonly Header[],
  order: AlternateOrder,
  onOrder: (next: AlternateOrder) => void,
  numeric: boolean,
): HTMLElement {
  const sorting = headers.some((header) => header.sort === order.sort);
  return el(
    "th",
    {
      class: numeric ? "pdb-num" : "pdb-alternates__puzzle-head",
      attrs: { scope: "col", "aria-sort": sorting ? ARIA_SORT[order.direction] : null },
    },
    ...headers.map((header) => sortButton(header, order, onOrder)),
  );
}

function headRow(order: AlternateOrder, onOrder: (next: AlternateOrder) => void): HTMLElement {
  return el(
    "thead",
    {},
    el(
      "tr",
      {},
      headerCell(PUZZLE_HEADERS, order, onOrder, false),
      ...NUMBER_HEADERS.map((header) => headerCell([header], order, onOrder, true)),
      el("th", { text: "Clears", attrs: { scope: "col" } }),
    ),
  );
}

function bodyRow(row: Row): HTMLElement {
  const href = `${pathOf({ kind: "puzzle", id: row.puzzleId })}#line-${row.line.position}`;
  return el(
    "tr",
    {},
    el("td", { class: "pdb-table__lead" }, el("a", { text: `#${row.puzzleId} ${row.title}`, attrs: { href } })),
    el("td", { class: "pdb-num", text: row.difficulty === null ? "unrated" : String(row.difficulty) }),
    el("td", { class: "pdb-num", text: dayLabel(row.line.day) }),
    el("td", { class: "pdb-num", text: String(row.line.attack) }),
    el("td", { class: "pdb-num", text: String(row.line.pieces) }),
    el("td", { text: clearsText(row.line.clears) }),
  );
}

/** The count, the direction button and the table, redrawn in place as the reader sorts. */
function tableView(rows: readonly Row[], start: AlternateOrder, onQuery: (search: string) => void): HTMLElement {
  let order = start;
  const holder = el("div", { class: "pdb-stack pdb-stack--tight" });
  const change = (next: AlternateOrder) => {
    order = next;
    draw();
    onQuery(queryForAlternates(order));
  };
  function draw(): void {
    const direction = el("button", {
      class: "btn btn--small pdb-sort-direction",
      text: DIRECTION_WORDS[order.direction],
      attrs: { type: "button", "aria-label": `${DIRECTION_WORDS[order.direction]}: turn the order around` },
      on: { click: () => change({ ...order, direction: order.direction === "asc" ? "desc" : "asc" }) },
    });
    const count = el("p", { class: "label pdb-table-caption", text: plural(rows.length, "line") });
    const caption = el("div", { class: "pdb-alternates__bar" }, count, direction);
    const shown = el("tbody", {}, ...sortAlternates(rows, order).map(bodyRow));
    const table = el(
      "div",
      { class: "pdb-table-wrap" },
      el("table", { class: "pdb-table pdb-alternates" }, headRow(order, change), shown),
    );
    holder.replaceChildren(caption, table);
  }
  draw();
  return holder;
}

const LEDE =
  "Every other way through a club puzzle that players found, besides the maker's: lines that solved it, " +
  "or sent more than it asked. Who found a line is never shown.";

/** The page: its head at once, from nothing; the table when `/data/alternates.json` arrives. */
export function alternatesPage(index: SiteIndex, order: AlternateOrder, onQuery: (search: string) => void): BodyView {
  const slot = el("div", { class: "pdb-slot" });
  const head = el(
    "header",
    { class: "pdb-page-head" },
    el("h1", { class: "display pdb-title", text: "Alternate solutions" }),
    el("p", { class: "pdb-lede", text: LEDE }),
  );
  const element = el("div", { class: "pdb-stack" }, head, slot);
  const fill = (body: unknown) => {
    const rows = rowsOf(readBody("alternates", body).lines, index);
    slot.replaceChildren(rows.length === 0 ? el("p", { class: "note", text: EMPTY }) : tableView(rows, order, onQuery));
  };
  return { element, slot, fill };
}
