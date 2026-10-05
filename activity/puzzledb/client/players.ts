/**
 * `/players`: everybody the site lists, by the name the game shows, as a
 * table a reader can sort, search and narrow to a server.
 *
 * The list holds only players who have not hidden and have something on a
 * finished day; the page says the first part out loud, because "why am I not
 * here" is the first question a reader asks of a list of people, and the
 * answer is theirs to change in the activity's settings.
 *
 * **The name is the index's, the numbers the body's.** `/data/players.json`
 * carries keys, never names, and each row is joined to `index.playerByKey`
 * for its name, days solved and best streak — so one page can never show one
 * person under two names from two builds. A row whose key the index does not
 * hold is dropped and never drawn: within one build it cannot happen, and if
 * it ever did, it would be somebody the index chose not to name.
 *
 * **Every sort puts the most first**, and a tie goes by name, case-folded,
 * then by key — the order the index itself is in — so the same table sorts the
 * same way on every machine. Best rush is most solved, then fastest, and a
 * player who never rushed comes last. The numbers are totals across every
 * server, as the game keeps them; a server chip only narrows who is listed,
 * and the caption says so.
 *
 * The search is a plain substring match on the name, case-folded, typed into
 * a box: a few hundred names do not need a search engine, and a reader looking
 * for a friend knows how the name starts. Sort, search and server are kept in
 * the address (`list-queries.ts`).
 */

import { el, formatDuration } from "../../client/src/ui/dom";
import { pathOf, type SitePlayerEntry } from "../wire";
import type { SitePlayerListRow } from "../wire-profiles";
import { plural } from "./board-rows";
import { type BodyView, readBody, type SiteIndex } from "./data";
import { type PlayersQuery, type PlayersSort, queryForPlayers } from "./list-queries";
import { serverChips, serversAmong } from "./server-chips";

/** A body row with the index's entry for its key. */
interface Joined {
  readonly entry: SitePlayerEntry;
  readonly row: SitePlayerListRow;
}

interface Column {
  readonly sort: PlayersSort;
  readonly label: string;
  readonly cell: (player: Joined) => string;
  /** Negative when `a` goes first. Every column puts the most first. */
  readonly order: (a: Joined, b: Joined) => number;
}

/** A best rush as the profile prints it: `14 · 3:04.1`, or a dash. */
function rushText({ row }: Joined): string {
  if (row.rushBest === null) return "—";
  return `${row.rushBest} · ${row.rushBestMs === null ? "—" : formatDuration(row.rushBestMs)}`;
}

/** Most solved first, then fastest, and no rush at all last. */
function byRush(a: Joined, b: Joined): number {
  const x = a.row;
  const y = b.row;
  if (x.rushBest === null || y.rushBest === null) return (x.rushBest === null ? 1 : 0) - (y.rushBest === null ? 1 : 0);
  return y.rushBest - x.rushBest || (x.rushBestMs ?? Infinity) - (y.rushBestMs ?? Infinity);
}

const most = (value: (player: Joined) => number) => (a: Joined, b: Joined) => value(b) - value(a);

const COLUMNS: readonly Column[] = [
  { sort: "days", label: "Days solved", cell: (p) => String(p.entry.daysSolved), order: most((p) => p.entry.daysSolved) },
  { sort: "streak", label: "Best streak", cell: (p) => String(p.entry.bestStreak), order: most((p) => p.entry.bestStreak) },
  { sort: "cleared", label: "Cleared", cell: (p) => String(p.row.puzzlesCleared), order: most((p) => p.row.puzzlesCleared) },
  { sort: "lines", label: "Lines found", cell: (p) => String(p.row.linesFound), order: most((p) => p.row.linesFound) },
  { sort: "rush", label: "Best rush", cell: rushText, order: byRush },
];

/** By name, case-folded, then by key: the index's own order, so a tie reads the same everywhere. */
function byName(a: Joined, b: Joined): number {
  const x = a.entry.name.toLocaleLowerCase();
  const y = b.entry.name.toLocaleLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : 0;
}

/** The rows the index can name; any other is dropped here and never drawn. */
function joined(rows: readonly SitePlayerListRow[], index: SiteIndex): Joined[] {
  return rows.flatMap((row) => {
    const entry = index.playerByKey.get(row.key);
    return entry ? [{ entry, row }] : [];
  });
}

/** The rows the query keeps, in its order. */
function shownRows(all: readonly Joined[], query: PlayersQuery): Joined[] {
  const wanted = query.q.trim().toLocaleLowerCase();
  const column = COLUMNS.find((each) => each.sort === query.sort) ?? COLUMNS[0]!;
  return all
    .filter((player) => query.server === null || player.row.servers.includes(query.server))
    .filter((player) => wanted === "" || player.entry.name.toLocaleLowerCase().includes(wanted))
    .sort((a, b) => column.order(a, b) || byName(a, b));
}

function headRow(sort: PlayersSort, onSort: (sort: PlayersSort) => void): HTMLElement {
  const sortable = COLUMNS.map((column) =>
    el(
      "th",
      { class: "pdb-num", attrs: { scope: "col", "aria-sort": column.sort === sort ? "descending" : null } },
      el("button", {
        class: `pdb-sort${column.sort === sort ? " pdb-sort--on" : ""}`,
        text: column.label,
        attrs: { type: "button" },
        on: { click: () => column.sort !== sort && onSort(column.sort) },
      }),
    ),
  );
  return el("thead", {}, el("tr", {}, el("th", { text: "Player", attrs: { scope: "col" } }), ...sortable));
}

function bodyRow(player: Joined): HTMLElement {
  const href = pathOf({ kind: "player", key: player.entry.key });
  return el(
    "tr",
    {},
    el("td", { class: "pdb-table__lead" }, el("a", { class: "pdb-player-link", text: player.entry.name, attrs: { href } })),
    ...COLUMNS.map((column) => el("td", { class: "pdb-num", text: column.cell(player) })),
  );
}

/** The table, or the sentence for a search that found nobody. */
function table(rows: readonly Joined[], query: PlayersQuery, onSort: (sort: PlayersSort) => void): HTMLElement {
  if (rows.length === 0) return el("p", { class: "note", text: `No player matches “${query.q.trim()}”.` });
  return el(
    "div",
    { class: "pdb-table-wrap" },
    el("table", { class: "pdb-table pdb-players" }, headRow(query.sort, onSort), el("tbody", {}, ...rows.map(bodyRow))),
  );
}

/** The caption and the table, redrawn in place as the reader sorts, searches and narrows. */
function tableView(all: readonly Joined[], start: PlayersQuery, onQuery: (search: string) => void) {
  let query = start;
  const caption = el("p", { class: "label pdb-table-caption" });
  const holder = el("div", { class: "pdb-stack pdb-stack--tight" });
  const draw = () => {
    const rows = shownRows(all, query);
    caption.textContent = `Showing ${rows.length} of ${all.length} · totals count every server`;
    holder.replaceChildren(table(rows, query, (sort) => change({ sort })));
  };
  const change = (next: Partial<PlayersQuery>) => {
    query = { ...query, ...next };
    draw();
    onQuery(queryForPlayers(query));
  };
  draw();
  return { caption, holder, change };
}

function lede(count: number): string {
  return `${plural(count, "player")}, by the name the game shows. A player who chose to hide is not listed.`;
}

/**
 * The page: the head and the search box at once, from the index; the chips
 * and the table when `/data/players.json` arrives, since which servers to
 * offer is the body's to say.
 */
export function playersPage(index: SiteIndex, query: PlayersQuery, onQuery: (search: string) => void): BodyView {
  const count = index.data.players.length;
  // The browse page's own search box, named for the reason `browse.ts` gives: autofill flags a nameless field.
  const input = el("input", {
    class: "explore__search pdb-player-filter",
    attrs: { type: "search", name: "player", "aria-label": "Filter players", placeholder: "Filter by name", autocomplete: "off" },
  });
  input.value = query.q;
  const slot = el("div", { class: "pdb-slot" });
  const head = el(
    "header",
    { class: "pdb-page-head" },
    el("h1", { class: "display pdb-title", text: "Players" }),
    el("p", { class: "pdb-lede", text: lede(count) }),
  );
  const element = el("div", { class: "pdb-stack" }, head, count === 0 ? null : input, slot);

  // Until the table is there, a search typed early is simply kept in the box.
  let onType: (() => void) | null = null;
  input.addEventListener("input", () => onType?.());

  const fill = (body: unknown) => {
    const all = joined(readBody("players", body).rows, index);
    if (all.length === 0) {
      slot.replaceChildren(el("p", { class: "note", text: "No players on record yet." }));
      return;
    }
    const servers = serversAmong(index, new Set(all.flatMap((player) => player.row.servers)));
    // A server no listed player played in reads as every server, as a key the index does not know does.
    const server = servers.some((each) => each.key === query.server) ? query.server : null;
    const view = tableView(all, { ...query, q: input.value, server }, onQuery);
    onType = () => view.change({ q: input.value });
    const chips = servers.length === 0 ? null : serverChips(servers, server, (picked) => view.change({ server: picked }));
    slot.replaceChildren(el("div", { class: "pdb-stack" }, chips, view.caption, view.holder));
  };
  return { element, slot, fill };
}
