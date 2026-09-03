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
import { el, replaceChildren } from "./dom";

const LABELS: Readonly<Record<DailyTier, string>> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export interface TierPicker {
  readonly element: HTMLElement;
  update(entries: readonly DailyEntry[], current: DailyTier): void;
}

export function createTierPicker(onPick: (tier: DailyTier) => void): TierPicker {
  const row = el("div", { class: "tiers" });
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
      );
    },
  };
}
