/**
 * The chooser the day opens on.
 *
 * There was a second control here — a picker for the left rail — which was
 * mounted and then wiped by `startRun` and `presentVerdict`, both of which own
 * that rail and rebuild it. It never reached a screen, so it is gone; the home
 * row and the masthead cover switching.
 */

import type { DailyEntry } from "../api";
import type { DailyTier } from "@shared/daily";
import { pieceBudget } from "@shared/puzzle";
import { el, panel, replaceChildren } from "./dom";

const LABELS: Readonly<Record<DailyTier, string>> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

// ── The chooser the day opens on ─────────────────────────────────────────────

export interface DailyMenu {
  readonly element: HTMLElement;
  update(day: number, entries: readonly DailyEntry[]): void;
}

/**
 * The day's three, laid out to be chosen between.
 *
 * A day used to open on its puzzle, because there was only one and there was
 * nothing to decide. There is now: which of three to spend the next ten minutes
 * on is a real choice, and it cannot be made from a title alone — so each row
 * carries what the decision actually turns on. Its goal, its length, its
 * rating, and whether it is already done.
 */
export function createDailyMenu(onPick: (tier: DailyTier) => void): DailyMenu {
  const heading = el("p", { class: "explore__count", text: "" });
  const list = el("div", { class: "explore__list" });
  const element = panel("Today", { class: "explore" }, heading, list);

  return {
    element,
    update(day, entries) {
      const solved = entries.filter((entry) => entry.run?.solved).length;
      heading.textContent =
        `Puzzle #${day} — three of them. ` +
        (solved === entries.length
          ? "All three done."
          : solved > 0
            ? `${solved} of ${entries.length} solved.`
            : "Start wherever you like; any one of them keeps your streak.");

      replaceChildren(
        list,
        ...entries.map((entry) => {
          const { puzzle, run } = entry;
          const state = run?.solved ? "solved" : run ? "filed, not solved" : "not played";
          const row = el(
            "button",
            { class: `explore__item${run?.solved ? " explore__item--done" : ""}` },
            el("span", { class: "explore__id", text: LABELS[entry.tier] }),
            el(
              "span",
              { class: "explore__title" },
              el("span", { text: puzzle.title || `sheet ${puzzle.id}` }),
              el("span", { class: "explore__by", text: ` by ${puzzle.author}` }),
              el("span", { class: "explore__goal", text: puzzle.goal }),
            ),
            el("span", {
              class: "explore__meta",
              text:
                `${puzzle.difficulty > 0 ? `d${puzzle.difficulty}` : "unrated"} · ` +
                `${pieceBudget(puzzle)} pieces · ${state}`,
            }),
          );
          row.addEventListener("click", () => onPick(entry.tier));
          return row;
        }),
      );
    },
  };
}
