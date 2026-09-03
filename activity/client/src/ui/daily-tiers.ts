/**
 * The day's three, and which one you are on.
 *
 * A day used to be one puzzle, so there was nothing to choose and nothing to
 * show. Three of them need both: a way across, and — more importantly — a way
 * to see at a glance that the easy one is done and the hard one is still there.
 * The tick is the point of the control; the switching is incidental.
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

export interface TierPicker {
  readonly element: HTMLElement;
  update(entries: readonly DailyEntry[], current: DailyTier): void;
}

export function createTierPicker(onPick: (tier: DailyTier) => void, onAll: () => void): TierPicker {
  const row = el("div", { class: "tiers" });
  const back = el("button", { class: "btn btn--small tiers__all", text: "All three" });
  back.addEventListener("click", () => onAll());
  return {
    element: row,
    update(entries, current) {
      replaceChildren(
        row,
        ...entries.map((entry) => {
          const solved = entry.run?.solved === true;
          const button = el("button", {
            class: `btn btn--small tiers__pick${entry.tier === current ? " tiers__pick--on" : ""}`,
            // A filed miss is not the same as an untouched puzzle, and the
            // player is the only one who can tell the difference otherwise.
            text: `${LABELS[entry.tier]}${solved ? " ✓" : entry.run ? " ·" : ""}`,
            title: solved
              ? "Solved"
              : entry.run
                ? "Filed, not solved"
                : "Not played yet",
          });
          button.addEventListener("click", () => onPick(entry.tier));
          return button;
        }),
        back,
      );
    },
  };
}

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
