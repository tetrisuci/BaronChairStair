/**
 * The screen the activity opens on.
 *
 * There are five things to do here now — the daily's three puzzles, a rush,
 * a 1v1, the whole archive, the builder — and until this existed the way to
 * any of them was a row of small buttons in the masthead, which is furniture
 * rather than a front door. Discord's side collapsed to one `/puzzle` for the
 * same reason: one way in, and the choosing happens where the game is.
 *
 * The board is on it rather than behind a button because a leaderboard is the
 * thing people open a puzzle game to look at when they are not playing it.
 */

import type { DailyEntry } from "../api";
import type { DailyTier } from "@shared/daily";
import { el, panel, replaceChildren } from "./dom";

export interface HomeCallbacks {
  readonly onDaily: () => void;
  readonly onRush: () => void;
  readonly onDuel: () => void;
  readonly onExplore: () => void;
  readonly onBuild: () => void;
  /** Straight into one of the day's three, past the chooser. */
  readonly onPlayTier: (tier: DailyTier) => void;
}

export interface Home {
  readonly element: HTMLElement;
  /** `board` is the leaderboard panel, mounted here rather than owned here. */
  mountBoard(board: HTMLElement): void;
  update(day: number, entries: readonly DailyEntry[], streak: number): void;
}

export function createHome(callbacks: HomeCallbacks): Home {
  const heading = el("p", { class: "rush__blurb", text: "" });
  const progress = el("div", { class: "tiers" });
  const boardSlot = el("div", {});

  const go = (label: string, hint: string, onClick: () => void) => {
    const button = el("button", { class: "btn btn--primary home__go", text: label, title: hint });
    button.addEventListener("click", onClick);
    return button;
  };

  const element = panel(
    "Puzzle",
    { class: "explore" },
    heading,
    progress,
    el(
      "div",
      { class: "home__nav" },
      go("Daily", "Three puzzles: easy, medium, hard", callbacks.onDaily),
      go("Rush", "Five minutes, as many as you can", callbacks.onRush),
      go("1v1", "Play somebody in this server", callbacks.onDuel),
      go("Explore", "The whole archive", callbacks.onExplore),
      // Last, and the only one that is not a way to play: everybody arriving
      // here wants a puzzle, and a few of them want to write one.
      go("Build", "Lay out a board and get a puzzle code", callbacks.onBuild),
    ),
    boardSlot,
  );

  return {
    element,
    mountBoard(board) {
      replaceChildren(boardSlot, board);
    },
    update(day, entries, streak) {
      const solved = entries.filter((entry) => entry.run?.solved).length;
      heading.textContent =
        `Puzzle #${day}. ` +
        (streak > 0 ? `You are on a ${streak} day streak. ` : "") +
        (solved === entries.length && entries.length > 0
          ? "All three done today."
          : `${solved} of ${entries.length} solved today.`);

      // Buttons, because they looked like buttons and a control that reads as
      // clickable and is not is worse than no control. Each one is the short
      // way into that puzzle; the Daily button below goes to the chooser, which
      // is where the three can be compared before picking.
      replaceChildren(
        progress,
        ...entries.map((entry) => {
          const button = el("button", {
            class: "btn btn--small tiers__pick",
            text: `${entry.tier}${entry.run?.solved ? " ✓" : entry.run ? " ·" : ""}`,
            title: entry.run?.solved
              ? "Solved — open it again"
              : entry.run
                ? "Filed, not solved"
                : "Not played yet",
          });
          button.addEventListener("click", () => callbacks.onPlayTier(entry.tier));
          return button;
        }),
      );
    },
  };
}
