/**
 * What the page looks like once the attempt is over.
 *
 * There is no modal. A badge lands on the board, the left rail becomes the
 * result card, and the right rail turns into the solution walkthrough — so the
 * board the player just finished stays visible behind all of it.
 */

import type { ClearName } from "@shared/puzzle";
import type { StoredRun } from "../api";
import type { SolutionPlayer } from "../game/solution-player";
import { el, formatDuration, panel, replaceChildren, stat } from "./dom";
import { copyText, shareText, type ShareFields } from "./share";

const COPIED_MESSAGE_MS = 1600;

export interface VerdictBadge {
  readonly element: HTMLElement;
  show(solved: boolean, note: string): void;
  hide(): void;
}

export function createVerdictBadge(): VerdictBadge {
  const text = el("span", { class: "verdict-badge__text", text: "" });
  const note = el("span", { class: "verdict-badge__note", text: "" });
  const element = el(
    "div",
    { class: "verdict-badge", attrs: { hidden: true, "aria-hidden": "true" } },
    text,
    note,
  );
  return {
    element,
    show(solved, subtitle) {
      text.textContent = solved ? "Solved!" : "So close";
      note.textContent = subtitle;
      element.classList.toggle("verdict-badge--missed", !solved);
      // Re-trigger the drop animation on a repeat result.
      element.hidden = true;
      void element.offsetWidth;
      element.hidden = false;
    },
    hide() {
      element.hidden = true;
    },
  };
}

// ── Result card ──────────────────────────────────────────────────────────────

export interface VerdictHandlers {
  readonly onRetry: () => void;
  /**
   * Play a *filed* sheet again, unscored.
   *
   * Separate from {@link onRetry}, which restarts an attempt that is still the
   * player's to file. Once a daily is filed the run on the board is the one
   * that counts, so playing it again is practice on the same puzzle and cannot
   * move what is recorded.
   */
  readonly onReplay: () => void;
  readonly onToggleLeaderboard: () => void;
  readonly onPractice: () => void;
  readonly onBackToDaily: () => void;
  /**
   * Open the puzzle's solutions.
   *
   * Offered only once this player has solved this board — see
   * {@link VerdictOptions.cleared}. Reading how other people did it is a reward
   * for having done it, and a shortcut for anybody who has not.
   */
  readonly onSolutions: () => void;
}

export interface VerdictOptions {
  /** Practice puzzles are unscored, so they get no share slip or leaderboard. */
  readonly scored: boolean;
  /**
   * Whether this player has ever solved this puzzle — including just now.
   *
   * Not "did this run solve it": somebody replaying a puzzle they cracked last
   * month should still be offered its solutions, and somebody who has just
   * failed one they have never solved should not.
   */
  readonly cleared: boolean;
}

export interface VerdictPanel {
  readonly element: HTMLElement;
  update(fields: ShareFields, run: StoredRun | null, options: VerdictOptions): void;
}

export function createVerdictPanel(handlers: VerdictHandlers): VerdictPanel {
  const body = el("div", { style: { display: "grid", gap: "8px" } });
  const caption = el("h2", { class: "panel__caption", text: "Result" });
  const element = el("section", { class: "panel" }, caption, body);

  function copyButton(text: string): HTMLElement {
    const button = el("button", { class: "btn btn--primary", text: "Copy result" });
    button.addEventListener("click", async () => {
      button.textContent = (await copyText(text)) ? "Copied!" : "Copy failed";
      setTimeout(() => {
        button.textContent = "Copy result";
      }, COPIED_MESSAGE_MS);
    });
    return button;
  }

  return {
    element,
    update(fields, run, options) {
      caption.textContent = options.scored ? "Result" : "Practice";
      replaceChildren(
        body,
        stat("Attack", `${fields.attack} / ${fields.targetAttack}`),
        stat("Time", formatDuration(fields.durationMs)),
        stat("Restarts", fields.resets),
        run && !run.solved ? stat("Recorded", "unsolved") : null,
        options.scored ? el("pre", { class: "share", text: shareText(fields) }) : null,
        el(
          "div",
          { class: "btnrow" },
          options.scored ? copyButton(shareText(fields)) : null,
          options.scored
            ? el("button", {
                class: "btn",
                text: "Leaderboard",
                on: { click: () => handlers.onToggleLeaderboard() },
              })
            : el("button", {
                class: "btn",
                text: "Today's puzzle",
                on: { click: () => handlers.onBackToDaily() },
              }),
          // Solved, and filed: the attempt is over, so the offer is to play it
          // again rather than to try again — the second would suggest the
          // result is still in play. Unsolved and still the player's to file:
          // "Try again", which is exactly what it does.
          //
          // A filed miss gets both, and they are different things: retry the
          // sheet that is still open, or replay one already closed.
          fields.solved
            ? el("button", {
                class: "btn",
                text: "Play again",
                title: "Play this puzzle again. Your filed run stands — this one is not recorded.",
                on: { click: () => handlers.onReplay() },
              })
            : el("button", {
                class: "btn",
                text: "Try again",
                on: { click: () => handlers.onRetry() },
              }),
          el("button", {
            class: "btn",
            text: "Random puzzle",
            title: "Play one from the archive. Not recorded.",
            on: { click: () => handlers.onPractice() },
          }),
          // Last, and absent rather than disabled when it is not earned. A
          // greyed control here would advertise that there is something to read
          // and refuse to say what — which is worse than not mentioning it, and
          // is itself a small reveal about a puzzle nobody has solved.
          options.cleared
            ? el("button", {
                class: "btn",
                text: "Solutions",
                title: "Every way this puzzle has been solved, including yours.",
                on: { click: () => handlers.onSolutions() },
              })
            : null,
        ),
      );
    },
  };
}

// ── Leaderboard ──────────────────────────────────────────────────────────────

export interface LeaderboardPanel {
  readonly element: HTMLElement;
  update(entries: readonly StoredRun[], selfId: string): void;
  setVisible(visible: boolean): void;
}

export function createLeaderboardPanel(): LeaderboardPanel {
  const body = el("div", { class: "board-list" });
  const element = panel("Leaderboard", {}, body);
  element.hidden = true;

  return {
    element,
    setVisible(visible) {
      element.hidden = !visible;
    },
    update(entries, selfId) {
      if (entries.length === 0) {
        replaceChildren(body, el("p", { class: "note", text: "Nobody has solved it yet. Be first." }));
        return;
      }
      replaceChildren(
        body,
        ...entries.map((entry, index) =>
          el(
            "div",
            {
              class: `board-list__row${entry.player.id === selfId ? " board-list__row--self" : ""}`,
            },
            el("span", { class: "board-list__rank", text: String(index + 1) }),
            el("span", { class: "board-list__name", text: entry.player.username }),
            el("span", {
              class: "board-list__score",
              text: entry.solved
                ? formatDuration(entry.totalMs)
                : `${entry.attack}/${entry.targetAttack}`,
            }),
          ),
        ),
      );
    },
  };
}
