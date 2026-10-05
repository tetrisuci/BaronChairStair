/**
 * How a puzzle went on the finished days that dealt it: a card in the puzzle
 * page's rail.
 *
 * Daily hand-ins only, as the build counts them — practice and rush are not
 * the same attempt, and the game keeps no record of a puzzle opened and
 * abandoned, so "hand-ins" is the honest word for the denominator. The solve
 * rate is drawn as the game's own bar (`.boards__bar`) with the number beside
 * it, which is what stops one solve in one hand-in reading as a triumph.
 *
 * The fastest solve names its player, or "a player" when that player hid.
 * The count of players' lines is the published lines, the ones the answers
 * panel can step; it says nothing about lines that are not shown, because
 * the only lines not shown are today's, and saying so would mark today's
 * deal (`puzzledb/README.md`).
 */

import { el, panel, stat } from "../../client/src/ui/dom";
import type { SitePuzzle, SitePuzzleBody, SitePuzzleStats } from "../wire";
import { playerName, plural, timeOrDash } from "./board-rows";
import type { SiteIndex } from "./data";

/** A stat row whose value is more than text: the fastest time and whose it was. */
function fastestRow(stats: SitePuzzleStats): HTMLElement {
  const value = el("span", { class: "stat__value pdb-stat-fastest" }, timeOrDash(stats.fastestMs));
  if (stats.fastestMs !== null) value.append(" · ", playerName(stats.fastest));
  return el("div", { class: "stat" }, el("span", { class: "stat__key", text: "Fastest" }), value);
}

/** The solve rate as a number and as the game's bar. */
function rateRow(stats: SitePuzzleStats): HTMLElement {
  const share = stats.handIns === 0 ? 0 : Math.round((stats.solves / stats.handIns) * 100);
  return el(
    "div",
    { class: "pdb-rate" },
    stat("Solve rate", `${share}%`),
    el("span", { class: "boards__bar" }, el("span", { class: "boards__bar-fill", style: { width: `${share}%` } })),
  );
}

/** The card. `stats` is null when no finished day has dealt the puzzle. */
export function renderPuzzleStats(puzzle: SitePuzzle, body: SitePuzzleBody, index: SiteIndex): HTMLElement {
  const stats = body.stats;
  const lines = stat("Players' lines", body.lines.length);
  if (stats === null) {
    return panel("How it went", { class: "pdb-stats" }, el("p", { class: "note", text: "No finished day has dealt it yet." }), lines);
  }
  const dealt = index.dealsOf.get(puzzle.id)?.length ?? 0;
  return panel(
    "How it went",
    { class: "pdb-stats" },
    stat("Dealt on", plural(dealt, "day")),
    stat("Hand-ins", stats.handIns),
    stat("Solves", stats.solves),
    rateRow(stats),
    fastestRow(stats),
    stat("Median", timeOrDash(stats.medianMs)),
    lines,
  );
}
