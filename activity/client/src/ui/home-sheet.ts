/**
 * One of the day's three, as a card you press to play it.
 *
 * Split out of `home.ts` the way `builder-goal.ts` was split out of
 * `builder.ts`: the front door is four regions and this is the only one with
 * real drawing in it, and the two read better apart than the one file read
 * whole.
 *
 * The sheet is a `.panel`'s construction that presses like a `.btn` — the
 * combination the language already implies and had not yet named. It is laid
 * straight on the ruled ground rather than inside a card, because cards inside
 * cards is stickers on stickers.
 *
 * It carries what the choice actually turns on, which is the same list the
 * chooser this replaced carried: the goal, the length, the rating, and how the
 * day has gone for this player on it. What is new is that the one still worth
 * ten minutes is the biggest thing on the page rather than the third row of a
 * list a click away.
 */

import type { DailyEntry } from "../api";
import type { DailyTier } from "@shared/daily";
import { pieceBudget } from "@shared/puzzle";
import { boardGlyph, pieceGlyph } from "../render/piece-glyph";
import { difficultyPips } from "./chrome";
import { el, formatDuration } from "./dom";

export const TIER_LABELS: Readonly<Record<DailyTier, string>> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

/**
 * Queue pieces drawn before the strip gives up and says `+n`.
 *
 * The median queue is nine and the longest in the archive is seventy-four, so
 * the cap is load-bearing rather than decorative: without it the hard puzzle's
 * strip is six lines tall and sets the height of a card it is a footnote on.
 */
const QUEUE_SHOWN = 7;

export interface SheetOptions {
  /** The one still worth playing: bigger type, a board picture, and the slack. */
  readonly hero: boolean;
  /** Puzzle ids this player has opened today — see `started.ts`. */
  readonly started: ReadonlySet<number>;
  readonly onPick: (tier: DailyTier) => void;
}

interface Chip {
  readonly element: HTMLElement;
  /** The same words, for the button's own label. */
  readonly text: string;
}

/**
 * How the day has gone on this puzzle, in four states and one element.
 *
 * The four states and their precedence come across intact from the chooser,
 * including the one that is easy to get backwards: a filed run outranks having
 * started it. A daily run reaches the server only when it solves, so "no run"
 * covers both a puzzle nobody has looked at and one the player is halfway
 * through — and the second of those is a card telling somebody they have not
 * played a puzzle they walked away from ten minutes ago.
 *
 * The state word lives here and only here, which is why the meta line beside
 * it stops at the target.
 *
 * Written in sentence case and uppercased by the stylesheet, as every other
 * shouting label in the interface is. The same string is the button's own
 * label, and a screen reader given `SOLVED` may well spell it out.
 */
function stateChip(entry: DailyEntry, started: ReadonlySet<number>): Chip {
  const { puzzle, run } = entry;
  const [modifier, text] = run?.solved
    ? ["solved", `Solved ${formatDuration(run.totalMs)}`]
    : run
      ? ["filed", `Filed ${run.attack}/${run.targetAttack}`]
      : started.has(puzzle.id)
        ? ["open", "In progress"]
        : // The quietest of the four on purpose: a readout, not a verdict on a
          // puzzle you are being invited to press.
          ["new", "Not played"];
  return {
    element: el("span", { class: `today__chip today__chip--${modifier}`, text }),
    text,
  };
}

/**
 * The board itself, at the size the hero happens to have.
 *
 * The class goes on the glyph rather than on a wrapper: an SVG with a viewBox
 * carries its own ratio, so `height: 100%; width: auto` is the whole of the
 * sizing, and a box around it would need a second rule to agree with it.
 */
function thumbnail(board: DailyEntry["puzzle"]["board"]): SVGSVGElement {
  const glyph = boardGlyph(board);
  glyph.classList.add("today__thumb");
  return glyph;
}

/** The pieces you get, in order, with anything pre-held in front of them. */
function queueStrip(puzzle: DailyEntry["puzzle"]): HTMLElement {
  const shown = puzzle.queue.slice(0, QUEUE_SHOWN);
  const rest = puzzle.queue.length - shown.length;
  // No `cell` option: `pieceGlyph` writes that one *inline on the glyph*, which
  // an ancestor's `--glyph-cell` can never override — narrow.css's
  // `.queue { --glyph-cell: 8px }` has been inert since the day the hud started
  // passing a size. The strip's own rule in panels.css sets it instead, so the
  // breakpoint that shrinks these actually shrinks them.
  return el(
    "span",
    { class: "build__strip", attrs: { "aria-hidden": "true" } },
    puzzle.hold
      ? el("span", { class: "build__strip-first" }, pieceGlyph(puzzle.hold))
      : null,
    ...shown.map((piece) => pieceGlyph(piece)),
    rest > 0 ? el("span", { class: "explore__meta", text: `+${rest}` }) : null,
  );
}

/**
 * The sheet.
 *
 * A filed one — solved or missed — is built short: the tier word, the title
 * with its byline, and the chip, and nothing else. Done work gets quieter as
 * the day goes on, and the height it gives up goes to the hero, so the page
 * visibly changes shape between morning and lunch. It stays pressable, because
 * a solved tier opens its filed run and its walkthrough exactly as before.
 *
 * The parts a filed sheet drops are not built rather than hidden in CSS: the
 * card is rebuilt from scratch on every update anyway, and a `display: none`
 * for each of them is three rules that have to be kept in step with this
 * function.
 */
export function todaySheet(entry: DailyEntry, options: SheetOptions): HTMLButtonElement {
  const { puzzle, run } = entry;
  const filed = run !== null;
  const hero = options.hero && !filed;
  const chip = stateChip(entry, options.started);
  const title = puzzle.title || `sheet ${puzzle.id}`;
  // Two of the archive's goals carry newlines, and a label is one line.
  //
  // The fallback is the same sentence `hud.ts` uses over a board, and it is not
  // defensive: archive puzzle 8, "fourtris mogs", ships `goal: ""`, and at
  // difficulty 4 it files under easy — so on the days it comes up it is the
  // hero, and the biggest card on the screen had a blank line where its
  // sentence goes and announced itself with a bare stop, "... by satilea. .
  // Not played."
  const goal = puzzle.goal.replace(/\s+/g, " ").trim() || "Send as much as the reference line";

  return el(
    "button",
    {
      class:
        "today__sheet" +
        (hero ? " today__sheet--hero" : "") +
        (filed ? " today__sheet--filed" : ""),
      attrs: {
        // The card is display type, mono, pips and an SVG inside one control.
        // Read child by child that is a sentence nobody wrote, so the button
        // says what it is instead. Getting this wrong is invisible on screen
        // and broken everywhere else.
        "aria-label": `${TIER_LABELS[entry.tier]} — ${title} by ${puzzle.author}. ${goal}. ${chip.text}.`,
      },
      on: { click: () => options.onPick(entry.tier) },
    },
    el(
      "span",
      { class: "today__sheet-tier" },
      el("span", { class: "display today__tier", text: TIER_LABELS[entry.tier] }),
      filed ? null : difficultyPips(puzzle.difficulty),
    ),
    el(
      "span",
      { class: "today__sheet-body" },
      el(
        "span",
        { class: "today__sheet-name" },
        el("span", { class: "display today__title", text: title }),
        el("span", { class: "explore__by", text: ` by ${puzzle.author}` }),
      ),
      // The hero says the goal in the app's own "what you must do" type — the
      // same face the goal panel uses over a board — because on the hero it is
      // the sentence the next ten minutes are about.
      filed
        ? null
        : hero
          ? el("p", { class: "goal__text", text: goal })
          : el("span", { class: "explore__goal", text: goal }),
      filed
        ? null
        : el("span", {
            class: "explore__meta",
            text:
              `${puzzle.difficulty > 0 ? `d${puzzle.difficulty}` : "unrated"} · ` +
              `${pieceBudget(puzzle)} pieces · target ${puzzle.targetAttack}`,
          }),
      // The hero's, and only the hero's — measured, not preferred. Two strips
      // of nine-pixel glyphs on cards nobody is about to press cost 52px of a
      // 588px column at 1280x720, which is the whole of the difference between
      // a hero that is obviously the biggest thing on the page and one that is
      // twenty pixels taller than its neighbours. The count is still on the
      // meta line above; the pieces themselves are for the board you are about
      // to open, and the other two are one press away from being the hero.
      hero ? queueStrip(puzzle) : null,
    ),
    el(
      "span",
      { class: "today__sheet-side" },
      chip.element,
      hero ? thumbnail(puzzle.board) : null,
    ),
  );
}
