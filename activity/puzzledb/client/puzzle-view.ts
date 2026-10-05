/**
 * One puzzle: its board, what it asks, its answers behind a button, how it
 * went on the finished days that dealt it, and those days.
 *
 * **The answer is public and still hidden.** The club decided answers are
 * public (`server/public-routes.ts`), so this is not secrecy: anybody can read
 * the JSON. It is a puzzle page, though, and a puzzle with its solution drawn
 * on it is not a puzzle any more. So the board arrives bare, and the answer is
 * one deliberate press away — or already open when the link says `#answer`,
 * which is how the day page's "See the answer" asks for it.
 *
 * "Bare" is a decision, not a default. `SolutionPlayer.view()` at position 0
 * already draws the first placement in place and the second as a ghost, which
 * on a page like this is the answer's first two moves. So the bare board is a
 * player over no steps at all, and the real one is built only on the press.
 *
 * **Players' lines join the maker's answer behind the same press.** They
 * arrive with the page's body, after the board is already drawn, as chips over
 * the panel's one replay (`lines.ts`). A line is as much a spoiler as the
 * maker's answer, so it is no easier to open; the page's `#lines` anchor
 * scrolls to the panel and leaves it shut. Beta 0.13 told players that the
 * site now shows these, and why that undoes beta 0.3's promise there.
 *
 * **Required clears are never shown.** The game shows them only under
 * `GOAL_ENFORCEMENT=on`, which is the owner's call, and a page that showed them
 * here would be enforcing a rule the game does not. They stay in the data.
 *
 * **The canvas is drawn by the caller.** This view decides which frame is
 * showing and hands each `BoardView` to `onView`; the page owns the renderer
 * and the pixel size — the split the review page uses, and what lets a test
 * read the board out of a spy instead of out of a canvas nobody can query.
 *
 * Author-typed text reaches the DOM as text only, never as markup.
 */

import { BLUEPRINT_VIEWER } from "@shared/blueprint/viewer";
import { SolutionPlayer } from "../../client/src/game/solution-player";
import type { BoardView } from "../../client/src/render/board";
import { pieceGlyph } from "../../client/src/render/piece-glyph";
import { difficultyPips } from "../../client/src/ui/chrome";
import { el, panel, replaceChildren, stat } from "../../client/src/ui/dom";
import { createReplay, type Replay } from "../../client/src/ui/replay";
import { dayLabel, pathOf, type SiteLine, type SitePuzzle, type SitePuzzleBody } from "../wire";
import { viewRows } from "./board-stage";
import { type SiteIndex, titleOf } from "./data";
import { pager } from "./frame";
import { answerChips, answerChoices, answersIntro } from "./lines";
import { renderPuzzleStats } from "./puzzle-stats";

export interface PuzzleHandlers {
  /** The frame to draw. Called once while the view is built, and on every step after. */
  onView(view: BoardView): void;
}

export interface PuzzleView {
  readonly element: HTMLElement;
  /** Handed back so the page can size it and paint it once it is in the document. */
  readonly canvas: HTMLCanvasElement;
  /** Where the page's body goes: the rail's slot for how the puzzle went, and its notes while it loads. */
  readonly extras: HTMLElement;
  /** Draws the body: the stats card into {@link extras}, and the lines into the answers. */
  addBody(body: SitePuzzleBody, index: SiteIndex): void;
  /** Gives up the answer's keyboard. Called when the page moves on. */
  detach(): void;
}

/** The answer panel's id: what `#answer` in a link names, and where the page scrolls for it. */
export const ANSWER_ID = "answer";
/** The answers' own anchor, inside that panel: where the game's "every line" link lands, shut. */
export const LINES_ID = "lines";

/**
 * A link out to the Blueprint viewer, or nothing.
 *
 * Only ever to the viewer: the server builds these from Blueprint codes, and a
 * URL that does not start where the viewer lives is not one it built, so it is
 * not rendered as a link at all rather than trusted as one.
 */
function blueprintLink(text: string, url: string | null): HTMLAnchorElement | null {
  if (!url?.startsWith(BLUEPRINT_VIEWER)) return null;
  return el("a", {
    class: "btn btn--small pdb-blueprint",
    text,
    attrs: { href: url, rel: "noopener noreferrer" },
  });
}

/** `#42 Title`, by whom, and in which set. */
function heading(puzzle: SitePuzzle): HTMLElement {
  return el(
    "header",
    { class: "pdb-page-head" },
    el(
      "h1",
      { class: "display pdb-title" },
      el("span", { class: "pdb-title__id", text: `#${puzzle.id}` }),
      " ",
      titleOf(puzzle),
    ),
    el(
      "p",
      { class: "pdb-byline" },
      puzzle.author ? `by ${puzzle.author}` : null,
      puzzle.set ? el("span", { class: "label pdb-set", text: puzzle.set }) : null,
    ),
  );
}

/** Hold and queue, in the glyphs the game's own bays use. */
function piecesStrip(puzzle: SitePuzzle): HTMLElement {
  return el(
    "div",
    { class: "pdb-pieces" },
    el("span", { class: "label", text: "hold" }),
    puzzle.hold ? pieceGlyph(puzzle.hold, { cell: 10 }) : el("span", { class: "note", text: "empty" }),
    el("span", { class: "label", text: "next" }),
    ...puzzle.queue.map((piece) => pieceGlyph(piece, { cell: 10 })),
  );
}

/** The goal, the tier it is dealt in now, its rating, what a solve must send, and its length. */
function factsPanel(puzzle: SitePuzzle): HTMLElement {
  return panel(
    "The puzzle",
    { class: "pdb-facts" },
    el("p", { class: "goal__text", text: puzzle.goal }),
    el(
      "div",
      { class: "pdb-rating" },
      difficultyPips(puzzle.difficulty ?? 0),
      el("span", {
        class: "label",
        text: puzzle.difficulty === null ? "Unrated" : `Difficulty ${puzzle.difficulty}`,
      }),
    ),
    stat("Tier now", puzzle.tier),
    stat("Send", `${puzzle.targetAttack} attack`),
    stat("Pieces", puzzle.pieces),
    blueprintLink("Open the puzzle in Blueprint", puzzle.puzzleUrl),
  );
}

interface AnswerPanel {
  readonly element: HTMLElement;
  reveal(): void;
  /** Adds players' lines, before or after the press. */
  setLines(lines: readonly SiteLine[]): void;
  detach(): void;
}

function answerSection(body: HTMLElement): HTMLElement {
  return el(
    "section",
    { class: "panel pdb-answer", attrs: { id: ANSWER_ID } },
    el("h2", { class: "panel__caption", text: "Answers" }),
    body,
  );
}

/**
 * The answers: a button until it is pressed, then the game's own replay —
 * timeline, transport and arrow keys — over the chosen answer's steps, with a
 * chip per answer when there is more than one.
 *
 * One replay at most, ever: a second press is impossible because the button is
 * gone, a second `reveal` is refused, and a chip rebinds the one replay rather
 * than building another, because two replays would both own the arrow keys
 * and step two players for every press. Each answer gets the rows it needs, so
 * a line that builds higher than the maker's is not cut off.
 */
function answerPanel(puzzle: SitePuzzle, onView: (view: BoardView) => void): AnswerPanel {
  let lines: readonly SiteLine[] = [];
  let replay: Replay | null = null;
  let chosen = 0;
  const body = el("div", { class: "pdb-answer__body", attrs: { id: LINES_ID } });
  const choices = () => answerChoices(puzzle, lines);

  const play = () => {
    const choice = choices()[chosen];
    if (!replay || !choice) return;
    const player = new SolutionPlayer(puzzle, choice.steps, viewRows({ board: puzzle.board, solution: choice.steps }));
    replay.bind(player, () => onView(player.view()));
  };
  const pick = (at: number) => {
    chosen = at;
    draw();
    play();
  };
  const reveal = () => {
    if (replay || choices().length === 0) return;
    replay = createReplay();
    draw();
    play();
  };
  function draw(): void {
    const all = choices();
    if (all.length === 0) {
      replaceChildren(body, el("p", { class: "note", text: "No answer on file for this puzzle." }));
      return;
    }
    if (!replay) {
      const label = all.length === 1 ? "Show the answer" : "Show the answers";
      const button = el("button", { class: "btn btn--primary", text: label, attrs: { type: "button" }, on: { click: reveal } });
      replaceChildren(body, el("p", { class: "note", text: answersIntro(puzzle, all) }), button);
      return;
    }
    const choice = all[chosen]!;
    replaceChildren(
      body,
      all.length > 1 ? answerChips(all, chosen, pick) : null,
      replay.element,
      choice.blueprintUrl ? blueprintLink("Open the answer in Blueprint", choice.blueprintUrl) : null,
    );
  }

  draw();
  return {
    element: answerSection(body),
    reveal,
    setLines(next) {
      lines = next;
      draw();
    },
    detach: () => replay?.detach(),
  };
}

/** The finished days that dealt it, newest first, each a link to that day. */
function dealtOnPanel(puzzle: SitePuzzle, index: SiteIndex): HTMLElement {
  const dealt = index.dealsOf.get(puzzle.id) ?? [];
  return panel(
    "Dealt on",
    { class: "pdb-dealt" },
    dealt.length === 0
      ? el("p", { class: "note", text: "Not dealt on any finished day yet." })
      : el(
          "ul",
          { class: "pdb-dealt__list" },
          ...dealt.map(({ day, tier }) => {
            const text = `Day ${day} · ${dayLabel(day)} — ${tier}`;
            return el("li", {}, el("a", { text, attrs: { href: pathOf({ kind: "day", day }) } }));
          }),
        ),
  );
}

/** The listed puzzles either side of this one, by number. */
function puzzlePager(puzzle: SitePuzzle, index: SiteIndex): HTMLElement {
  const list = index.data.puzzles;
  const at = list.findIndex((entry) => entry.id === puzzle.id);
  const previous = at > 0 ? list[at - 1] : undefined;
  const next = at >= 0 ? list[at + 1] : undefined;
  const side = (entry: SitePuzzle) => ({
    href: pathOf({ kind: "puzzle", id: entry.id }),
    text: `#${entry.id} ${titleOf(entry)}`,
  });
  return pager("Other puzzles", previous ? side(previous) : null, next ? side(next) : null);
}

/** `/puzzle/42`. `revealed` opens the answer at once, for an address ending in `#answer`. */
export function createPuzzleView(
  puzzle: SitePuzzle,
  index: SiteIndex,
  handlers: PuzzleHandlers,
  options: { readonly revealed?: boolean } = {},
): PuzzleView {
  const rows = viewRows(puzzle);
  // Wrapped rather than passed by reference: a handler written as a method
  // shorthand would lose its receiver, and the failure would be a board that
  // never redraws rather than anything the compiler could see.
  const onView = (view: BoardView) => handlers.onView(view);
  const canvas = el("canvas", {
    attrs: { role: "img", "aria-label": `The board of puzzle #${puzzle.id}, ${titleOf(puzzle)}` },
  });
  const answer = answerPanel(puzzle, onView);
  const extras = el("div", { class: "pdb-slot" });

  onView(new SolutionPlayer(puzzle, [], rows).view());
  if (options.revealed) answer.reveal();

  const element = el(
    "article",
    { class: "pdb-stack pdb-puzzle" },
    heading(puzzle),
    el(
      "div",
      { class: "pdb-puzzle__body" },
      panel(
        "Board",
        { class: "pdb-puzzle__board" },
        el("div", { class: "pdb-board" }, canvas),
        piecesStrip(puzzle),
      ),
      el("div", { class: "pdb-rail" }, factsPanel(puzzle), extras, answer.element, dealtOnPanel(puzzle, index)),
    ),
    puzzlePager(puzzle, index),
  );
  return {
    element,
    canvas,
    extras,
    addBody(body, bodyIndex) {
      replaceChildren(extras, renderPuzzleStats(puzzle, body, bodyIndex));
      answer.setLines(body.lines);
    },
    detach: () => answer.detach(),
  };
}
