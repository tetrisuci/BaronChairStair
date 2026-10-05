/**
 * One row of a board, the way every board on the site draws it: a rank, whose
 * row it is, an optional second number, and the score.
 *
 * The game's own boards are not reused. They key every row on a Discord id,
 * draw an avatar beside the name and open a profile by id — and the site has
 * none of the three, on purpose: an avatar's URL embeds the id, and the id is
 * the one thing about a player this site never publishes. So the row is
 * rebuilt here from the game's classes (`.board-list`, `.board-list__rank`,
 * `.board-list__score`, `.board__marks`) and nothing of its code.
 *
 * **The rank on screen is not the rank in the data.** The build stores each
 * row's place in a total order, unique within its board, because the public
 * database's key needs it to be. A reader is owed a rank in which equal
 * results are equal, so `displayRanks` (in `wire.ts`, because a player's
 * body is ranked by the same rule on the server) turns places back into ranks
 * — "1, 2, 2, 4" — over whatever rows a view is showing, a server's own board
 * included, where the stored places would have gaps.
 *
 * **Whose row it is, is a {@link PlayerRef} and nothing else.** A shown player
 * is a link to their page; a player who chose to hide is the words "a player",
 * never a link, so the page offers nothing that would 404.
 *
 * Every name is set as text. A username is something a stranger typed.
 */

import { el, formatDuration } from "../../client/src/ui/dom";
import { type DayMarks, type PlayerRef, pathOf, type SiteServer } from "../wire";

/** How many characters of an unnamed server's key tell two unnamed chips apart. */
const KEY_HINT = 4;

/** "1st", "2nd", "11th": a rank read as a place rather than as a quantity. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "1 line", "7 lines". */
export function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** `mm:ss.d`, or a dash for a time there is none of. */
export function timeOrDash(ms: number | null): string {
  return ms === null ? "—" : formatDuration(ms);
}

/**
 * A server as a reader sees it: its Discord name, or "Unnamed server" and the
 * start of its key. The key is already public; the suffix only keeps two
 * unnamed servers' chips from reading the same.
 */
export function serverLabel(server: SiteServer): string {
  return server.name ?? `Unnamed server · ${server.key.slice(0, KEY_HINT)}`;
}

/** A shown player as a link to their page, or "a player", which is never a link. */
export function playerName(player: PlayerRef): HTMLElement {
  if (player === null) return el("span", { class: "pdb-anon", text: "a player" });
  return el("a", { text: player.name, attrs: { href: pathOf({ kind: "player", key: player.key }) } });
}

/** A rank, with the club's three podium colours on the first three. */
function rankCell(rank: number): HTMLElement {
  const podium = rank <= 3 ? ` pdb-rank--${rank}` : "";
  return el("span", { class: `board-list__rank pdb-rank${podium}`, text: rank });
}

export interface RowParts {
  readonly rank: number;
  readonly player: PlayerRef;
  /** Between the name and the score: a second number, a day, or a day's marks. */
  readonly detail?: Node | string | null;
  readonly score: string;
  /** An unsolved hand-in, set a shade quieter. */
  readonly quiet?: boolean;
}

/** One row: rank, name, detail, score — always four cells, so every board's columns line up. */
export function boardRow(parts: RowParts): HTMLElement {
  return el(
    "div",
    { class: `board-list__row pdb-row${parts.quiet ? " pdb-row--quiet" : ""}` },
    rankCell(parts.rank),
    el("span", { class: "board-list__name pdb-row__name" }, playerName(parts.player)),
    el("span", { class: "pdb-row__detail" }, parts.detail ?? null),
    el("span", { class: "board-list__score", text: parts.score }),
  );
}

/** A list of rows, or the sentence that says it is empty. `full` lifts the game's 200px cap. */
export function boardList(rows: readonly HTMLElement[], empty: string, options: { full?: boolean } = {}): HTMLElement {
  if (rows.length === 0) return el("p", { class: "note pdb-board-empty", text: empty });
  return el("div", { class: `board-list${options.full ? " pdb-board-list--full" : ""}` }, ...rows);
}

const MARK_WORDS = { 2: "solved", 1: "handed in, not solved", 0: "not played" } as const;

/**
 * A day's tiers as the game's marks: filled for solved, hollow for handed in
 * and missed, dotted for never opened. A tier the day did not deal has no mark
 * at all, so a three-tier day shows three.
 */
export function tierMarks(marks: DayMarks, tiers: readonly (keyof DayMarks)[]): HTMLElement {
  const look = { 2: "on", 1: "off", 0: "none" } as const;
  return el(
    "span",
    { class: "board__marks" },
    ...tiers.flatMap((tier) => {
      const mark = marks[tier];
      if (mark === null) return [];
      return [el("span", { class: `board__mark board__mark--${look[mark]}`, title: `${tier}: ${MARK_WORDS[mark]}` })];
    }),
  );
}

/**
 * The first `shown` rows, and a "Show all N" button that draws the rest in
 * place. One press, then the button is gone: the boards are fifty at most.
 */
export function cappedList(rows: readonly HTMLElement[], empty: string, shown: number): HTMLElement {
  if (rows.length <= shown) return boardList(rows, empty, { full: true });
  const holder = el("div", { class: "pdb-capped" });
  const more = el("button", {
    class: "btn btn--small pdb-more",
    text: `Show all ${rows.length}`,
    attrs: { type: "button" },
    on: { click: () => holder.replaceChildren(boardList(rows, empty, { full: true })) },
  });
  holder.append(boardList(rows.slice(0, shown), empty, { full: true }), more);
  return holder;
}
