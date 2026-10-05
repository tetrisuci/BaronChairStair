/**
 * A puzzle's answers as the reader chooses between them: the maker's, then
 * every line players found through it, each a chip over one replay.
 *
 * **A line says what it did and nothing about who.** The owner chose to
 * publish players' lines with no finder (beta 0.13), so the site has nothing
 * to say about a line but its place in publication order, what it sent and
 * how many pieces it placed — `Line 2 · 10 atk · 9p`. Its position is the
 * public database's `lines.position`, the same number in the download, so a
 * reader can find the row a chip came from.
 *
 * **One replay, rebound.** A chip press points the panel's one replay at a new
 * player rather than building a second, because two replays would both own
 * the arrow keys and step two boards for every press (`puzzle-view.ts`).
 */

import { el } from "../../client/src/ui/dom";
import type { SolutionStep } from "../../shared/puzzle";
import type { SiteLine, SitePuzzle } from "../wire";

/** One answer the panel can step. */
export interface AnswerChoice {
  readonly label: string;
  readonly steps: readonly SolutionStep[];
  /** The Blueprint viewer's link to this answer: the maker's alone has one. */
  readonly blueprintUrl: string | null;
}

/** `Line 2 · 10 atk · 9p`. */
export function lineLabel(line: SiteLine): string {
  return `Line ${line.position} · ${line.attack} atk · ${line.steps.length}p`;
}

/** The maker's answer when one is on file, then each line in position order. */
export function answerChoices(puzzle: SitePuzzle, lines: readonly SiteLine[]): AnswerChoice[] {
  const maker: AnswerChoice[] =
    puzzle.solution && puzzle.solution.length > 0
      ? [{ label: "Maker's answer", steps: puzzle.solution, blueprintUrl: puzzle.solutionUrl }]
      : [];
  const found = lines
    .filter((line) => line.steps.length > 0)
    .map((line) => ({ label: lineLabel(line), steps: line.steps, blueprintUrl: null }));
  return [...maker, ...found];
}

/** What the panel says before the press: which answers wait behind it. */
export function answersIntro(puzzle: SitePuzzle, choices: readonly AnswerChoice[]): string {
  const hasMaker = Boolean(puzzle.solution && puzzle.solution.length > 0);
  const lines = choices.length - (hasMaker ? 1 : 0);
  const found = lines === 1 ? "1 line players found" : `${lines} lines players found`;
  if (hasMaker && lines === 0) return `The maker's answer, one placement at a time — ${choices[0]!.steps.length} in all.`;
  if (hasMaker) return `The maker's answer and ${found}, one placement at a time.`;
  return `No maker's answer on file. Here ${lines === 1 ? "is" : "are"} ${found}, one placement at a time.`;
}

/** A chip per answer, the one on screen pressed. */
export function answerChips(choices: readonly AnswerChoice[], chosen: number, onPick: (at: number) => void): HTMLElement {
  return el(
    "div",
    { class: "boards__tabs pdb-answer__chips", attrs: { role: "group", "aria-label": "Answers" } },
    ...choices.map((choice, at) =>
      el("button", {
        class: `btn btn--small${at === chosen ? " btn--primary" : ""}`,
        text: choice.label,
        attrs: { type: "button", "aria-pressed": String(at === chosen) },
        on: { click: () => at !== chosen && onPick(at) },
      }),
    ),
  );
}
