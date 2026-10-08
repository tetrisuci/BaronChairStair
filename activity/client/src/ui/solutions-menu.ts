/**
 * Every recorded way through one puzzle, as a screen of its own.
 *
 * It began as a card in the rail beside the board and did not survive contact
 * with a real puzzle: a list, a stepper and a sentence in a 300px column, with
 * the sentence clipped mid-word. The board is the wrong neighbour for this
 * anyway — you come here to *compare* lines, and comparing is the one thing a
 * single board cannot show you.
 *
 * So each entry carries its own picture: the board that line leaves behind,
 * drawn small. Two solutions to the same puzzle usually end differently, and
 * where they end is the fastest way to see that they are different at all.
 * Names, dates and attack are underneath, where they can wrap.
 *
 * Picking one hands it to the board to step through, which is what the board is
 * good at. Back returns to the puzzle you came from.
 */

import type { PuzzlePrompt } from "@shared/puzzle";
import type { GalleryLine } from "../api";
import { SolutionPlayer } from "../game/solution-player";
import { cellsGlyph, stackOnly } from "../render/piece-glyph";
import { el, panel, replaceChildren } from "./dom";
import { ago } from "./ago";

export interface SolutionsMenuCallbacks {
  /** Step this line out on the board. */
  readonly onOpen: (line: GalleryLine) => void;
  /** Back to the puzzle this was opened from. */
  readonly onClose: () => void;
}

export interface SolutionsMenu {
  readonly element: HTMLElement;
  update(puzzle: PuzzlePrompt, lines: readonly GalleryLine[], selfId: string): void;
}

/** Who found it. The maker's own answer belongs to nobody. */
function credit(line: GalleryLine, selfId: string): string {
  if (line.source !== "player" || !line.finder) return "The maker's answer";
  return line.finder.id === selfId ? "You" : line.finder.username;
}

export function createSolutionsMenu(
  callbacks: SolutionsMenuCallbacks,
  now: () => number = Date.now,
): SolutionsMenu {
  const heading = el("h2", { class: "display solutions-menu__title", text: "Solutions" });
  const count = el("p", { class: "note solutions-menu__count", text: "" });
  const list = el("div", { class: "solutions-menu__list" });

  const element = el(
    "div",
    { class: "solutions-menu" },
    el(
      "div",
      { class: "solutions-menu__head" },
      // First and leftmost, because it is the way out and every other screen
      // here puts its way out first.
      el("button", {
        class: "btn",
        text: "← Back to the puzzle",
        on: { click: () => callbacks.onClose() },
      }),
      heading,
    ),
    count,
    list,
  );

  function entry(
    puzzle: PuzzlePrompt,
    line: GalleryLine,
    index: number,
    selfId: string,
  ): HTMLElement {
    // Built here rather than sent by the server: the placements are already on
    // the wire, and locking cells is arithmetic — cheaper than a second field
    // on every row of every gallery.
    const preview = cellsGlyph(stackOnly(new SolutionPlayer(puzzle, line.placements, 0).finalBoard));
    preview.classList.add("solutions-menu__board");

    const mine = line.finder?.id === selfId;
    const when = line.source === "reference" ? "shipped with the puzzle" : ago(line.foundAt, now());

    return el(
      "button",
      {
        class: `solutions-menu__entry${mine ? " solutions-menu__entry--self" : ""}`,
        title: "Step through this one on the board",
        on: { click: () => callbacks.onOpen(line) },
      },
      el("span", { class: "solutions-menu__rank", text: `${index + 1}` }),
      preview,
      el(
        "span",
        { class: "solutions-menu__facts" },
        el("span", { class: "solutions-menu__who", text: credit(line, selfId) }),
        el("span", { class: "solutions-menu__when", text: when }),
        el("span", {
          class: "solutions-menu__score",
          text: `${line.attack} attack · ${line.placements.length} pieces`,
        }),
        // The clear names are the answer, and this screen is only reachable by
        // somebody who has already solved this puzzle — so they cost nothing
        // here and are the most interesting thing about a line.
        line.clears.length > 0
          ? el("span", { class: "solutions-menu__clears", text: line.clears.join(" · ") })
          : null,
        // The one fact that explains why a line counts at all without solving.
        line.solvedStrict
          ? null
          : el("span", { class: "solutions-menu__note", text: "beat the target another way" }),
      ),
    );
  }

  return {
    element,
    update(puzzle, lines, selfId) {
      heading.textContent = `Solutions — ${puzzle.title || `sheet ${puzzle.id}`}`;
      if (lines.length === 0) {
        count.textContent = "No solutions on file for this one.";
        replaceChildren(list);
        return;
      }
      count.textContent =
        lines.length === 1
          ? "One solution on file. Solve it another way and yours lands here."
          : `${lines.length} ways through this board. Pick one to step through it.`;
      replaceChildren(list, ...lines.map((line, index) => entry(puzzle, line, index, selfId)));
    },
  };
}
