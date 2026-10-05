/**
 * `/player/:key`: one shown player's finished days — their totals, each
 * tier's record, a calendar, their recent days, the puzzles they cleared and
 * their rushes. The three in the middle are `profile-panels.ts`.
 *
 * Only a player who has not chosen "Hide me on db.tetrisatuci.org" has this
 * page; for anybody else the address is the site's one 404, decided by the
 * index before this module is ever asked. So nothing here decides who may be
 * shown. What it does decide is how a page about a person reads to a
 * stranger: by the name the game shows, with no picture, and with every number
 * cut to finished days, so a reader cannot learn from it how somebody's today
 * is going.
 *
 * **A streak is "as of" the newest finished day.** It counts a run of solved
 * days that reaches that day, so a player who has already solved today shows
 * one fewer here than in the game until today is over. The note under the
 * cards says which day the numbers run through.
 *
 * A hand-in carries its rank on that day's tier across every server, and no
 * server: the day's own page is where it sits beside everybody else's. The
 * rank is the one that page prints, a tie shared, which the build works out
 * (`server/bodies.ts`); printed here as "2nd", it is only fair if it is.
 */

import { el, formatDuration, panel, stat } from "../../client/src/ui/dom";
import { dayLabel, pathOf, type SitePlayerBody, type SitePlayerEntry, type SitePlayerRun } from "../wire";
import { ordinal, plural } from "./board-rows";
import { type BodyView, readBody, type SiteIndex, titleOf } from "./data";
import { calendarPanel, clearedPanel, showAllButton, tiersPanel } from "./profile-panels";

/** How many days with hand-ins "Recent days" lists. */
const RECENT_DAYS = 30;
/** Rushes listed before "Show all". */
const RUSHES_SHOWN = 30;

function dayLink(day: number, text: string, index: SiteIndex): Node {
  if (!index.dayByNumber.has(day)) return document.createTextNode(text);
  return el("a", { text, attrs: { href: pathOf({ kind: "day", day }) } });
}

/**
 * Lines found, linked to the Discoveries board: the count is theirs, and the
 * board is where it sits beside everybody's. Never to the lines themselves,
 * which name no finder.
 */
function linesStat(count: number): HTMLElement {
  const board = el("a", { text: count, attrs: { href: `${pathOf({ kind: "leaderboards" })}#discoveries` } });
  return el("div", { class: "stat" }, el("span", { class: "stat__key", text: "Lines found" }), el("span", { class: "stat__value" }, board));
}

function totalsCards(body: SitePlayerBody): HTMLElement {
  const t = body.totals;
  const best = t.rushBest === null ? "—" : `${t.rushBest} · ${t.rushBestMs === null ? "—" : formatDuration(t.rushBestMs)}`;
  return el(
    "div",
    { class: "profile__cards" },
    panel(
      "Daily",
      { class: "profile__stats" },
      stat("Days solved", t.daysSolved),
      stat("Dailies", t.dailies),
      stat("Streak", t.currentStreak),
      stat("Best streak", t.bestStreak),
    ),
    panel("Archive", { class: "profile__stats" }, stat("Puzzles cleared", t.puzzlesCleared), linesStat(t.linesFound)),
    panel(
      "Rush",
      { class: "profile__stats" },
      stat("Best rush", best),
      t.rushBestDay === null ? null : stat("Best rush on", `day ${t.rushBestDay}`),
      stat("Rushes", t.rushRuns),
    ),
  );
}

/** `easy · 1:10.0 · 3rd`, the tier linked to its puzzle when the site lists it; a miss is `not solved`. */
function runLine(run: SitePlayerRun, index: SiteIndex): HTMLElement {
  const puzzle = run.puzzleId === null ? undefined : index.byId.get(run.puzzleId);
  const tier: Node = puzzle
    ? el("a", { text: run.tier, title: `#${puzzle.id} ${titleOf(puzzle)}`, attrs: { href: pathOf({ kind: "puzzle", id: puzzle.id }) } })
    : document.createTextNode(run.tier);
  const result = run.solved && run.timeMs !== null ? ` · ${formatDuration(run.timeMs)} · ${ordinal(run.rank)}` : " · not solved";
  return el("li", { class: `pdb-run${run.solved ? "" : " pdb-run--missed"}` }, tier, result);
}

/** The newest days with a hand-in, each a line of its tiers. */
function recentDays(body: SitePlayerBody, index: SiteIndex): HTMLElement {
  const days = new Map<number, SitePlayerRun[]>();
  for (const run of body.runs) days.set(run.day, [...(days.get(run.day) ?? []), run]);
  const newest = [...days].sort(([a], [b]) => b - a).slice(0, RECENT_DAYS);
  return panel(
    "Recent days",
    { class: "pdb-recent" },
    newest.length === 0
      ? el("p", { class: "note", text: "No daily hand-ins on finished days." })
      : el(
          "ol",
          { class: "pdb-run-days" },
          ...newest.map(([day, runs]) =>
            el(
              "li",
              { class: "pdb-run-day" },
              dayLink(day, `Day ${day} · ${dayLabel(day)}`, index),
              el("ul", { class: "pdb-runs" }, ...runs.map((run) => runLine(run, index))),
            ),
          ),
        ),
  );
}

function rushes(body: SitePlayerBody, index: SiteIndex): HTMLElement {
  const lines = body.rush.map((rush) =>
    el(
      "li",
      { class: "pdb-run-day" },
      // One span, so the grid row holds the day and its numbers on one line.
      el(
        "span",
        {},
        dayLink(rush.day, `Day ${rush.day}`, index),
        ` · ${rush.solved} solved · ${formatDuration(rush.timeMs)} · ${ordinal(rush.rank)}`,
      ),
    ),
  );
  const list = el("ol", { class: "pdb-run-days" }, ...lines.slice(0, RUSHES_SHOWN));
  const more = lines.length <= RUSHES_SHOWN ? null : showAllButton(`Show all ${lines.length}`, list, lines);
  return panel(
    "Rushes",
    { class: "pdb-recent" },
    lines.length === 0 ? el("p", { class: "note", text: "No rushes on finished days." }) : list,
    more,
  );
}

/** A shown player's body, drawn. Their name is not in it: the page's heading has it from the index. */
export function renderPlayer(body: SitePlayerBody, index: SiteIndex): HTMLElement {
  const through = index.data.about.throughDay;
  return el(
    "div",
    { class: "pdb-stack profile" },
    totalsCards(body),
    el("p", {
      class: "note profile__note",
      text: through === null ? "No day has finished yet." : `Streaks count finished days, through ${dayLabel(through)}.`,
    }),
    tiersPanel(body, index),
    calendarPanel(body, index),
    recentDays(body, index),
    clearedPanel(body, index),
    rushes(body, index),
  );
}

/** The page: the name at once, from the index, and the rest when the body arrives. */
export function playerPage(entry: SitePlayerEntry, index: SiteIndex): BodyView {
  const slot = el("div", { class: "pdb-slot" });
  const element = el(
    "div",
    { class: "pdb-stack" },
    el(
      "header",
      { class: "pdb-page-head" },
      el("h1", { class: "display pdb-title", text: entry.name }),
      el("p", { class: "pdb-lede", text: `${plural(entry.daysSolved, "day")} solved · best streak ${entry.bestStreak}` }),
    ),
    slot,
  );
  return { element, slot, fill: (body) => slot.replaceChildren(renderPlayer(readBody("player", body), index)) };
}
