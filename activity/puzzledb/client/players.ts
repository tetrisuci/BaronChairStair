/**
 * `/players`: everybody the site lists, by the name the game shows, each a
 * link to their page.
 *
 * The list is the index's own, so it needs no body and draws at once. It
 * holds only players who have not hidden and have something on a finished
 * day; the page says the first part out loud, because "why am I not here" is
 * the first question a reader asks of a list of people, and the answer is
 * theirs to change in the activity's settings.
 *
 * The filter is a plain substring match on the name, case-folded, typed into
 * a box: a few hundred names do not need a search engine, and a reader looking
 * for a friend knows how the name starts.
 */

import { el } from "../../client/src/ui/dom";
import { pathOf, type SitePlayerEntry } from "../wire";
import { plural } from "./board-rows";
import type { SiteIndex } from "./data";

function playerCard(player: SitePlayerEntry): HTMLElement {
  return el(
    "li",
    {},
    el(
      "a",
      { class: "pdb-player", attrs: { href: pathOf({ kind: "player", key: player.key }) } },
      el("span", { class: "pdb-player__name", text: player.name }),
      el("span", {
        class: "pdb-player__meta",
        text: `${plural(player.daysSolved, "day")} solved · best streak ${player.bestStreak}`,
      }),
    ),
  );
}

/** The players whose name holds `typed`, ignoring case. */
function matching(players: readonly SitePlayerEntry[], typed: string): SitePlayerEntry[] {
  const wanted = typed.trim().toLocaleLowerCase();
  return wanted === "" ? [...players] : players.filter((player) => player.name.toLocaleLowerCase().includes(wanted));
}

/** The list, filtered as the reader types. */
export function renderPlayers(index: SiteIndex): HTMLElement {
  const players = index.data.players;
  const head = el(
    "header",
    { class: "pdb-page-head" },
    el("h1", { class: "display pdb-title", text: "Players" }),
    el("p", {
      class: "pdb-lede",
      text: `${plural(players.length, "player")}, by the name the game shows. A player who chose to hide is not listed.`,
    }),
  );
  if (players.length === 0) {
    return el("div", { class: "pdb-stack" }, head, el("p", { class: "note", text: "No players on record yet." }));
  }

  const list = el("ul", { class: "pdb-player-list" });
  // The browse page's own search box, named for the reason `browse.ts` gives: autofill flags a nameless field.
  const filter = el("input", {
    class: "explore__search pdb-player-filter",
    attrs: { type: "search", name: "player", "aria-label": "Filter players", placeholder: "Filter by name", autocomplete: "off" },
  });
  const draw = () => {
    const shown = matching(players, filter.value);
    if (shown.length === 0) {
      list.replaceChildren(el("li", { class: "note", text: `No player matches “${filter.value.trim()}”.` }));
      return;
    }
    list.replaceChildren(...shown.map(playerCard));
  };
  filter.addEventListener("input", draw);
  draw();
  return el("div", { class: "pdb-stack" }, head, filter, list);
}
