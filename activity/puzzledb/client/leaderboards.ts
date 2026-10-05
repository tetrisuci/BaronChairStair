/**
 * `/leaderboards`: the all-time boards over every finished day, one card each.
 *
 * The game draws these as tabs on one panel, because it shares a narrow
 * Discord window with everything else. Here there is a whole page, so they sit
 * side by side as cards in a grid, and a reader compares by looking across
 * rather than by remembering what the last tab said.
 *
 * **Only the rush records are per server**, as in the game: the daily totals,
 * the streaks, puzzles cleared and Discoveries are kept for the club as one,
 * and the site does not invent per-server versions the game has never shown.
 * So the server chips sit inside the rush card, the one board they change,
 * rather than above the grid where they would look as though they scoped all
 * six. Each card's first line says whose board it is and how far it runs.
 *
 * **Discoveries is every server, and its lines never say who.** The board
 * counts the alternate lines each player found, as the game counts them; the
 * lines themselves are on each puzzle's page with no name on them. The card
 * carries `id="discoveries"`, which is where the game's "see more" link lands.
 *
 * Each card shows its top ten and offers the rest of its fifty on a press.
 */

import { el } from "../../client/src/ui/dom";
import {
  ALL_SERVERS,
  dayLabel,
  displayRanks,
  pathOf,
  type SiteLeaderboardsBody,
  type SiteStanding,
  type StandingBoard,
} from "../wire";
import { boardRow, cappedList, plural, serverLabel, timeOrDash } from "./board-rows";
import { type BodyView, readBody, type SiteIndex, type ViewContext } from "./data";
import { serverChips } from "./server-chips";

/** Rows a card shows before "Show all". */
const TOP = 10;
const EMPTY = "Nobody on this board yet.";

interface BoardSpec {
  readonly board: StandingBoard;
  readonly caption: string;
  /** What the second number on a row is, or null for none. */
  readonly detail: (row: SiteStanding, index: SiteIndex) => Node | string | null;
  readonly score: (row: SiteStanding) => string;
  /** Whether two rows share a rank: the board's own numbers, equal. */
  readonly same: (a: SiteStanding, b: SiteStanding) => boolean;
}

const sameValue = (a: SiteStanding, b: SiteStanding) => a.value === b.value;
const bare = (row: SiteStanding) => String(row.value);
const none = () => null;

/** A record's day, linked when the site has that day's page. */
function recordDay(row: SiteStanding, index: SiteIndex): Node | string | null {
  if (row.day === null) return null;
  const text = `day ${row.day}`;
  return index.dayByNumber.has(row.day) ? el("a", { text, attrs: { href: pathOf({ kind: "day", day: row.day }) } }) : text;
}

const RUSH: BoardSpec = {
  board: "rush",
  caption: "Rush records",
  detail: recordDay,
  score: (row) => `${row.value} · ${timeOrDash(row.timeMs)}`,
  same: (a, b) => a.value === b.value && a.timeMs === b.timeMs,
};

/** The club-wide boards, in the page's order, after the rush records. */
const CLUB_BOARDS: readonly BoardSpec[] = [
  {
    board: "dailies",
    caption: "Dailies solved",
    detail: (row) => (row.detail === null ? null : plural(row.detail, "day")),
    score: bare,
    same: sameValue,
  },
  {
    board: "streak",
    caption: "Current streak",
    detail: (row) => (row.detail === null ? null : `best ${row.detail}`),
    score: bare,
    same: sameValue,
  },
  { board: "best_streak", caption: "Best streak", detail: none, score: bare, same: sameValue },
  { board: "cleared", caption: "Puzzles cleared", detail: none, score: bare, same: sameValue },
  { board: "discoveries", caption: "Discoveries", detail: none, score: (row) => plural(row.value, "line"), same: sameValue },
];

/** "through Thu, Oct 1, 2026", or what to say before any day has finished. */
function throughWords(index: SiteIndex): string {
  const through = index.data.about.throughDay;
  return through === null ? "no finished days yet" : `through ${dayLabel(through)}`;
}

function rowsOf(spec: BoardSpec, rows: readonly SiteStanding[], index: SiteIndex): HTMLElement[] {
  const ranks = displayRanks(rows, spec.same);
  return rows.map((row, at) =>
    boardRow({ rank: ranks[at]!, player: row.player, detail: spec.detail(row, index), score: spec.score(row) }),
  );
}

/** One board as a card: whose it is and how far it runs, then its rows. */
function boardCard(spec: BoardSpec, rows: readonly SiteStanding[], index: SiteIndex): HTMLElement {
  const discoveries = spec.board === "discoveries";
  return el(
    "section",
    { class: "panel pdb-board-card", attrs: discoveries ? { id: "discoveries" } : {} },
    el("h2", { class: "panel__caption", text: spec.caption }),
    el("p", { class: "note pdb-board-scope", text: `Every server, ${throughWords(index)}.` }),
    discoveries
      ? el("p", { class: "note", text: "Alternate lines each player found. A line on the site never says who found it." })
      : null,
    cappedList(rowsOf(spec, rows, index), EMPTY, TOP),
  );
}

/** The rush records, with the chips that choose a server's own records, redrawn in place. */
function rushCard(body: SiteLeaderboardsBody, index: SiteIndex, ctx: ViewContext): HTMLElement {
  const scopes = body.boards.rush;
  let server = ctx.server !== null && index.serverByKey.has(ctx.server) ? ctx.server : null;
  const content = el("div", { class: "pdb-stack pdb-stack--tight" });
  const draw = () => {
    const named = server === null ? undefined : index.serverByKey.get(server);
    const whose = named ? serverLabel(named) : "Every server";
    content.replaceChildren(
      el("p", { class: "note pdb-board-scope", text: `${whose}, ${throughWords(index)}.` }),
      cappedList(rowsOf(RUSH, scopes[server ?? ALL_SERVERS] ?? [], index), EMPTY, TOP),
    );
  };
  draw();
  const chips =
    index.data.servers.length === 0
      ? null
      : serverChips(index.data.servers, server, (picked) => {
          server = picked;
          draw();
          ctx.onServer(picked);
        });
  return el(
    "section",
    { class: "panel pdb-board-card" },
    el("h2", { class: "panel__caption", text: RUSH.caption }),
    chips,
    content,
  );
}

/** The newest finished day, one press away: the boards a reader most often comes for. */
function latestDayCard(index: SiteIndex): HTMLElement | null {
  const through = index.data.about.throughDay;
  if (through === null || !index.dayByNumber.has(through)) return null;
  return el(
    "section",
    { class: "panel pdb-latest-card" },
    el("h2", { class: "panel__caption", text: "Latest day" }),
    el("a", {
      class: "pdb-latest-card__link",
      text: `Day ${through} · ${dayLabel(through)}`,
      attrs: { href: pathOf({ kind: "day", day: through }) },
    }),
    el("p", { class: "note", text: "Its boards tier by tier, and its rush." }),
  );
}

/** Every all-time board, as cards. */
export function renderLeaderboards(body: SiteLeaderboardsBody, index: SiteIndex, ctx: ViewContext): HTMLElement {
  return el(
    "div",
    { class: "pdb-board-grid" },
    latestDayCard(index),
    rushCard(body, index, ctx),
    ...CLUB_BOARDS.map((spec) => boardCard(spec, body.boards[spec.board][ALL_SERVERS] ?? [], index)),
  );
}

/** The page: its heading at once, and the boards when their body arrives. */
export function leaderboardsPage(index: SiteIndex, ctx: ViewContext): BodyView {
  const slot = el("div", { class: "pdb-slot" });
  const element = el(
    "div",
    { class: "pdb-stack" },
    el(
      "header",
      { class: "pdb-page-head" },
      el("h1", { class: "display pdb-title", text: "Leaderboards" }),
      el("p", { class: "pdb-lede", text: `All-time boards over every finished day, ${throughWords(index)}.` }),
    ),
    slot,
  );
  return {
    element,
    slot,
    fill: (body) => slot.replaceChildren(renderLeaderboards(readBody("leaderboards", body), index, ctx)),
  };
}
