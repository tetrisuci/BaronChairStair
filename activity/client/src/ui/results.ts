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
import { pieceGlyph } from "../render/piece-glyph";
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
  readonly onToggleLeaderboard: () => void;
  readonly onPractice: () => void;
  readonly onBackToDaily: () => void;
}

export interface VerdictOptions {
  /** Practice puzzles are not filed, so they get no share slip or leaderboard. */
  readonly scored: boolean;
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
          fields.solved
            ? null
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
        ),
      );
    },
  };
}

// ── Solution walkthrough ─────────────────────────────────────────────────────

export interface WalkthroughPanel {
  readonly element: HTMLElement;
  /**
   * @param onChange called whenever the board behind this panel should be
   *   redrawn. `stepped` is true only when the player moved the solution
   *   themselves, and false for the first render that happens as the panel is
   *   built. The caller needs the difference: the verdict badge
   *   sits on the board, and it should survive landing on a solve and then get
   *   out of the way the moment somebody starts stepping through it.
   */
  bind(player: SolutionPlayer, onChange: (stepped: boolean) => void): void;
}

const CLEAR_LABELS: Readonly<Record<ClearName, string>> = {
  single: "single",
  double: "double",
  triple: "triple",
  quad: "quad",
  tss: "TSS",
  tsd: "TSD",
  tst: "TST",
  tsmini: "T mini",
  spin: "spin",
  "perfect clear": "perfect clear",
};

export function createWalkthroughPanel(): WalkthroughPanel {
  const body = el("div", { class: "walkthrough" });
  const element = panel("Solution", {}, body);

  return {
    element,
    bind(player, onChange) {
      const stepLabel = el("span", { class: "walkthrough__step" });
      const caption = el("div", { class: "walkthrough__caption" });

      const render = (stepped: boolean) => {
        const current = player.current;
        stepLabel.textContent = `${Math.min(player.position + 1, player.stepCount)} / ${player.stepCount}`;
        replaceChildren(
          caption,
          current
            ? pieceGlyph(current.piece, { cell: 10 })
            : el("span", { class: "label", text: "done" }),
          current?.clear
            ? el("span", {
                class: "walkthrough__clear",
                text: `${CLEAR_LABELS[current.clear]} +${current.attack}`,
              })
            : null,
        );
        onChange(stepped);
      };

      const control = (label: string, title: string, action: () => void) =>
        el("button", {
          class: "btn btn--small",
          text: label,
          title,
          on: {
            click: () => {
              action();
              render(true);
            },
          },
        });

      replaceChildren(
        body,
        el(
          "div",
          { class: "walkthrough__head" },
          el("span", { class: "label", text: "step" }),
          stepLabel,
        ),
        caption,
        el(
          "div",
          { class: "btnrow" },
          control("◀", "Previous placement", () => player.previous()),
          control("▶", "Next placement", () => player.next()),
          control("↺", "Back to the start", () => player.reset()),
        ),
        el("p", {
          class: "note",
          text: "One solution on file — there may well be others.",
        }),
      );
      // Not a step: this is the panel drawing itself for the first time, and a
      // result the player has not moved off yet.
      render(false);
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
