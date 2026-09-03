/**
 * The page's fixed furniture: the header and the credits strip along the bottom.
 *
 * The header carries the club's block mark and the two numbers a daily game
 * lives on — streak and total solved. It used to carry the day's number too,
 * which meant something while a day was one puzzle and named nothing once it
 * became three. The strip underneath credits whoever
 * drew the puzzle, which the archive records and which is half the fun of
 * playing a club's own puzzles — and, in its far corner, Petr.
 */

import type { PuzzlePrompt } from "@shared/puzzle";
import { MINO_INK } from "../render/skin";
import { el, replaceChildren } from "./dom";

/** Difficulty above this is shown as "and then some" rather than more pips. */
const MAX_PIPS = 5;
const PIP_SCALE = 2;

export interface CreditFields {
  readonly day: number;
  readonly puzzle: PuzzlePrompt | null;
}

/** The club's logo motif: four coloured blocks in a square. */
function blockMark(): HTMLElement {
  const colours = [MINO_INK.T, MINO_INK.O, MINO_INK.I, MINO_INK.S];
  return el(
    "span",
    { class: "blockmark", attrs: { "aria-hidden": "true" } },
    ...colours.map((colour) => el("span", { style: { background: colour } })),
  );
}

/**
 * Petr, the Tetris at UCI mascot, tucked into the far corner of the strip.
 *
 * Last child of the footer rather than pinned to the viewport: the corner of
 * the screen is already the countdown's, and a fixed image would sit on top of
 * it. Riding the end of the row puts him in the same corner without taking
 * anything, and he is short enough not to set the strip's height.
 */
function petrEgg(): HTMLElement {
  return el("img", {
    class: "credits__petr",
    title: "Petr",
    attrs: { src: "/petr.png", alt: "", "aria-hidden": "true", decoding: "async" },
  });
}

function tally(key: string): { element: HTMLElement; value: HTMLElement } {
  const value = el("span", { class: "tally__value", text: "0" });
  const element = el(
    "div",
    { class: "tally" },
    value,
    el("span", { class: "tally__key", text: key }),
  );
  return { element, value };
}

export interface Masthead {
  readonly element: HTMLElement;
  setStreak(streak: number, solved: number): void;
  /** Slots a control into the header's right-hand end. */
  mountControl(control: HTMLElement): void;
}

export function createMasthead(onHome: () => void = () => {}): Masthead {
  const streak = tally("streak");
  const solved = tally("solved");
  const controls = el("div", { class: "masthead__controls" });

  /*
   * The wordmark is the way home.
   *
   * It is where anybody looks for one — the top-left mark is a home link
   * everywhere else — and it was inert, which made the header the one part of
   * the app that ignored a click. A button rather than a span with a handler,
   * so it is reachable by keyboard and announces itself as a control.
   */
  const home = el("button", { class: "masthead__home", title: "Back to the main menu" },
    blockMark(),
    el("span", { class: "masthead__mark", text: "Puzzle" }));
  home.addEventListener("click", () => onHome());

  const element = el(
    "header",
    { class: "masthead" },
    home,
    el("span", { class: "masthead__spacer" }),
    el(
      "div",
      { class: "masthead__meta" },
      streak.element,
      solved.element,
      controls,
    ),
  );

  return {
    element,
    setStreak(current, total) {
      streak.value.textContent = String(current);
      solved.value.textContent = String(total);
    },
    mountControl(control) {
      controls.append(control);
    },
  };
}

export interface Credits {
  readonly element: HTMLElement;
  update(fields: CreditFields): void;
  setCountdown(text: string): void;
}

/**
 * The archive's difficulty is a loose 1-to-10-and-beyond vibe scale, so it is
 * shown as filled blocks rather than a precise number it does not deserve.
 */
function difficultyPips(difficulty: number): HTMLElement {
  const filled = Math.min(MAX_PIPS, Math.ceil(difficulty / PIP_SCALE));
  const dots = Array.from({ length: MAX_PIPS }, (_, index) =>
    el("span", { class: `pips__dot${index < filled ? " pips__dot--on" : ""}` }),
  );
  const label = difficulty > 0 ? `difficulty ${difficulty} of 10+` : "not yet rated";
  return el(
    "span",
    { class: "pips", title: label, attrs: { "aria-label": label } },
    ...dots,
    difficulty > MAX_PIPS * PIP_SCALE ? el("span", { class: "pips__plus", text: "+" }) : null,
  );
}

export function createCredits(): Credits {
  const title = el("span", { class: "credits__title", text: "—" });
  const by = el("span", { class: "credits__by", text: "" });
  // A plain slot: `difficultyPips` supplies its own labelled `.pips` element.
  const pips = el("span", { class: "credits__pips" });
  const countdown = el("span", { class: "credits__countdown", text: "--:--:--" });

  const element = el(
    "footer",
    { class: "credits" },
    title,
    by,
    pips,
    el("span", { class: "credits__spacer" }),
    el("span", { class: "label", text: "next puzzle in" }),
    countdown,
    petrEgg(),
  );

  return {
    element,
    update({ puzzle }) {
      title.textContent = puzzle?.title || "Untitled";
      by.textContent = puzzle ? `by ${puzzle.author}` : "";
      replaceChildren(pips, difficultyPips(puzzle?.difficulty ?? 0));
    },
    setCountdown(text) {
      countdown.textContent = text;
    },
  };
}
