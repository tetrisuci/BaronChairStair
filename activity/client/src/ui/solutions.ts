/**
 * Every way a puzzle has been solved, beside the board that plays them.
 *
 * This was the reveal: one panel that stepped the maker's answer and said, at
 * the bottom, "One solution on file — there may well be others." There are
 * others, the archive has been recording them for weeks, and nobody could look
 * at them. So the sentence became the feature.
 *
 * It is a list and a board rather than a screen of its own, and that is the
 * whole design. A gallery of solutions drawn as thumbnails would be a wall of
 * near-identical boards nobody can read; a solution only means anything played
 * out one placement at a time, and the board that does that is already on
 * screen, at full size, showing the puzzle you just finished. So the panel is
 * an index — who found it, what it sent — and picking a line loads it into the
 * board you are already looking at.
 *
 * The maker's answer is always first and always present, so the list is never
 * empty and there is always something to compare against. Everybody else is in
 * the order they found it, because being first to a line is the thing worth
 * showing and it never changes afterwards.
 *
 * Under the list, a link to the puzzle's page on db.tetrisatuci.org, where
 * every line found on a finished day is kept for anyone to step through. It
 * belongs to the gallery that `show` drew, so it is drawn by `show` and taken
 * away by `readingOnly`: this panel is one long-lived instance, and the reading
 * screen arrives from the menu with a line of a puzzle `show` may never have
 * seen. Community puzzles get no link, because the site does not list them.
 */

import type { GalleryLine } from "../api";
import type { SolutionPlayer } from "../game/solution-player";
import { createReplay } from "./replay";
import { el, panel, replaceChildren } from "./dom";
import { type OpenLink, puzzleLinesPath, siteLink } from "./site-link";

export interface SolutionsPanel {
  readonly element: HTMLElement;
  /**
   * Shows `lines` and selects one.
   *
   * @param onPick called with the line to load into the board. Called once as
   *   the panel is built, so the caller never has to load a first line itself
   *   and the board and the highlighted row cannot start out disagreeing.
   */
  show(
    lines: readonly GalleryLine[],
    selfId: string,
    onPick: (line: GalleryLine) => void,
    /** The puzzle these lines solve, for the site link. No id, no link. */
    puzzleId?: number,
  ): void;
  /**
   * Puts a line's stepper under the list.
   *
   * @param onChange called whenever the board behind this panel should be
   *   redrawn. `stepped` is true only when the player moved the solution
   *   themselves, and false for the first render that happens as the stepper is
   *   built. The caller needs the difference: the verdict badge sits on the
   *   board, and it should survive landing on a solve and then get out of the
   *   way the moment somebody starts stepping through it.
   */
  bind(player: SolutionPlayer, onChange: (stepped: boolean) => void): void;
  /** Stops autoplay and gives up the keyboard. */
  detach(): void;
  /**
   * Drops the gallery list, leaving only the controls.
   *
   * For the reading screen, which arrives with one line already chosen and puts
   * the credit and the way back in its own card above. Without it the panel
   * keeps whatever `show` last wrote — so a reader who had been through the
   * gallery saw "One solution on file" one click after the menu told them there
   * were four.
   */
  readingOnly(): void;
}

/** What to call a line's author. The maker's answer belongs to nobody. */
function credit(line: GalleryLine, selfId: string): string {
  if (line.source !== "player" || !line.finder) return "The maker's answer";
  return line.finder.id === selfId ? "You" : line.finder.username;
}

/**
 * A line's one-glance summary: what it sent, and in how many pieces.
 *
 * Not the clear names. A row reading "tsd · tsd · tst" is the answer, and the
 * list would then give away every solution to anybody who opened it — which is
 * the opposite of a gallery you step through. The attack is the interesting
 * number anyway: it is how two lines on the same puzzle actually differ.
 */
function summary(line: GalleryLine): string {
  return `${line.attack} atk · ${line.placements.length}p`;
}

export function createSolutionsPanel(
  now: () => number = Date.now,
  /** Opens a db.tetrisatuci.org link. Without it the panel draws no link. */
  openSite?: OpenLink,
): SolutionsPanel {
  const rows = el("div", { class: "board-list solutions__list" });
  const site = el("p", { class: "solutions__site" });
  const steps = el("div", { class: "solutions__steps" });
  const replay = createReplay();
  // `selectable`: the walkthrough and the solved-by list exist to be read.
  const element = panel("Solutions", { class: "solutions selectable" }, rows, site, steps);

  function drawSite(puzzleId: number | undefined): void {
    const path = puzzleId === undefined ? null : puzzleLinesPath(puzzleId);
    replaceChildren(
      site,
      path && openSite ? siteLink("Every line on db.tetrisatuci.org", path, openSite) : null,
    );
    site.hidden = site.childElementCount === 0;
  }
  drawSite(undefined);

  return {
    element,
    bind(player, onChange) {
      replaceChildren(steps, replay.element);
      replay.bind(player, onChange);
    },
    detach() {
      replay.detach();
    },
    readingOnly() {
      replaceChildren(rows);
      drawSite(undefined);
    },
    show(lines, selfId, onPick, puzzleId) {
      drawSite(puzzleId);
      if (lines.length === 0) {
        // Only reachable when the archive has no answer on this box either —
        // `data/solutions.json` is untracked, so a deploy without it seeds no
        // reference row. Saying so beats an empty card.
        replaceChildren(rows);
        replaceChildren(steps);
        return;
      }

      let selected = 0;
      const draw = (): void => {
        replaceChildren(
          rows,
          ...lines.map((line, index) =>
            el(
              "button",
              {
                class:
                  "board-list__row solutions__row" +
                  (index === selected ? " solutions__row--on" : "") +
                  (line.finder?.id === selfId ? " board-list__row--self" : ""),
                on: {
                  click: () => {
                    if (index === selected) return;
                    selected = index;
                    draw();
                    onPick(line);
                  },
                },
              },
              el("span", { class: "board-list__rank", text: `${index + 1}` }),
              el("span", { class: "board-list__name", text: credit(line, selfId) }),
              el("span", { class: "board-list__score", text: summary(line) }),
            ),
          ),
        );
      };

      draw();
      // The board and the highlighted row start out agreeing because the same
      // call puts them there.
      onPick(lines[0]!);
    },
  };
}
