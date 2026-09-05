/**
 * The screen the activity opens on.
 *
 * It was five identical dark buttons, one sentence and a leaderboard, in a
 * card that filled the window while its contents stopped a third of the way
 * down. Four things were wrong with that and they are worth naming, because
 * each one is a rule this file now keeps.
 *
 * The daily is what the app is for, and it looked exactly like Build. So the
 * one puzzle still worth ten minutes is the largest object on the page, and
 * Build is the last row of a panel called "More ways to play".
 *
 * The screen is handed all three of the day's puzzles — title, author, goal,
 * difficulty, length, and how this player has done on each — and rendered one
 * sentence off it. So the three are cards carrying what the choice actually
 * turns on, which is the chooser's own list; the chooser itself is gone, and
 * with it a click between opening the activity and being on a board.
 *
 * Three of the five buttons repeated the masthead, which is furniture and
 * stays. So the modes are named with what they *are* rather than with the
 * word already on screen two rows above — the difference between a menu and a
 * duplicated toolbar.
 *
 * And it was full height with a third of a screen of content. So the left
 * column is full by arithmetic: the daystrip, the ways panel and the two
 * compact sheets are content, and the hero is the elastic that takes whatever
 * is left. A taller window is a bigger picture of the puzzle you are about to
 * play, not more padding.
 *
 * The board is on it rather than behind a button because a leaderboard is the
 * thing people open a puzzle game to look at when they are not playing it. On
 * the morning nobody has played — which is most mornings — its card is a
 * caption and one sentence, and the ruled ground shows below it. That is the
 * finished design and not a gap: the complaint was a large empty *box*, and a
 * small card on the club's own ground is what every play screen already looks
 * like. Nothing here reflows when the fetch lands, either; the panel is at the
 * top of the rail and grows downward into ground.
 */

import type { DailyEntry, RushRun } from "../api";
import type { DailyTier } from "@shared/daily";
import { TIER_LABELS, todaySheet } from "./home-sheet";
import { el, formatDuration, panel, replaceChildren, stat } from "./dom";

export interface HomeCallbacks {
  /** Opens one of the day's three. There is no chooser between; this is it. */
  readonly onPick: (tier: DailyTier) => void;
  readonly onRush: () => void;
  readonly onDuel: () => void;
  readonly onExplore: () => void;
  readonly onBuild: () => void;
}

export interface Home {
  readonly element: HTMLElement;
  /** `board` is the leaderboard panel, mounted here rather than owned here. */
  mountBoard(board: HTMLElement): void;
  update(
    day: number,
    entries: readonly DailyEntry[],
    streak: number,
    /** Puzzle ids opened today but not filed — see `started.ts`. */
    started: ReadonlySet<number>,
  ): void;
  /** Today's rushes, for the Rush row's one live number. */
  setRush(runs: readonly RushRun[]): void;
}

/**
 * Counts read as words here, never as digits.
 *
 * The codebase already says "All three done.", and the masthead two rows above
 * owns the tallies — a screen that prints "1 of 3" under a header showing "1"
 * and "247" is three numbers deep before it has said anything.
 */
const COUNT_WORDS = ["None", "One", "Two", "Three"] as const;

function countWord(count: number): string {
  return COUNT_WORDS[count] ?? String(count);
}

/**
 * The state of the day, in one sentence under the heading.
 *
 * The streak is spent as a *reason* inside a sentence and never printed as a
 * tally, for the same reason as above: it is already a number in the masthead,
 * and what it is for — any one of the three keeps it — is the part a player
 * who has not solved anything yet does not know.
 *
 * A filed miss is over. `showDailyTier` routes any entry with a run to its
 * sign-off, so "left to play" counts the entries with no run at all rather
 * than the ones not yet solved.
 */
function dayNote(entries: readonly DailyEntry[], streak: number): string {
  const total = entries.length;
  // The server sends three, always. Nothing below reads sensibly against none.
  if (total === 0) return "";
  const solved = entries.filter((entry) => entry.run?.solved).length;
  const left = entries.filter((entry) => entry.run === null).length;

  if (left === total) {
    return (
      "Three puzzles — easy, medium, hard. " +
      (streak > 0
        ? `Any one of them keeps your ${streak}-day streak.`
        : "Solve any one of them to start a streak.")
    );
  }
  if (left > 0) {
    return solved > 0
      ? `${countWord(solved)} solved, ${countWord(left).toLowerCase()} left to play.`
      : `${countWord(left)} left to play.`;
  }
  return solved === total
    ? "All three done. Back tomorrow."
    : `Today is filed. ${countWord(solved)} of three solved.`;
}

interface Ways {
  readonly element: HTMLElement;
  /** The Rush row's third column, the one datum any of them has. */
  readonly rushMeta: HTMLElement;
}

/**
 * The other four ways in, as rows rather than as buttons.
 *
 * The sentences are the `title=` strings the five buttons carried, promoted to
 * visible text. That promotion is the whole difference between a menu and the
 * masthead repeated: the header says four words, and this says what the four
 * things are. Build is last and is the only one that is not a way to play,
 * which its own sentence settles.
 *
 * No piece glyph beside the names. Colour with no meaning, on the one screen
 * about to carry a seven-colour picture of a board, is the cheap thing to lose.
 */
function waysPanel(callbacks: HomeCallbacks): Ways {
  const rushMeta = el("span", { class: "explore__meta", text: "" });

  const row = (name: string, blurb: string, onClick: () => void, meta?: HTMLElement) =>
    el(
      "button",
      { class: "explore__item", on: { click: onClick } },
      el("span", { class: "home__ways-name", text: name }),
      el("span", { class: "explore__goal", text: blurb }),
      meta ?? null,
    );

  const element = panel(
    "More ways to play",
    { class: "home__ways" },
    el(
      "div",
      { class: "home__ways-grid" },
      row("Rush", "Five minutes, as many as you can", callbacks.onRush, rushMeta),
      row("1v1", "Play somebody in this server", callbacks.onDuel),
      row("Explore", "The whole archive", callbacks.onExplore),
      row("Build", "Lay out a board and get a puzzle code", callbacks.onBuild),
    ),
  );
  return { element, rushMeta };
}

/**
 * The receipt, once all three are filed.
 *
 * There is no hero to grow into the freed height then, and the alternative was
 * letting the three short sheets float at the top of an empty column — a
 * finished day getting a shrug. It gets what it did instead, and the one thing
 * left to do tonight.
 *
 * That primary is the only filled-plum control anywhere on this screen, and it
 * exists only in this state: while the day is unfinished the hero is the single
 * emphasis, and when the day is over the emphasis moves to Rush.
 *
 * No promise of a walkthrough for a miss — `DailyEntry.solution` is sent only
 * when *that* puzzle is solved.
 */
function dayDonePanel(
  entries: readonly DailyEntry[],
  callbacks: HomeCallbacks,
): HTMLElement | null {
  // Narrowed by construction rather than by a `some` the checker cannot see
  // through: every row below reads a run, and an `entry.run?.attack ?? 0`
  // would print a zero for a state this panel is never built in.
  const filed = entries.flatMap((entry) =>
    entry.run ? [{ tier: entry.tier, run: entry.run }] : [],
  );
  if (filed.length === 0 || filed.length < entries.length) return null;
  const solved = filed.filter((row) => row.run.solved).length;
  const totalMs = filed.reduce((sum, row) => sum + (row.run.solved ? row.run.totalMs : 0), 0);

  const rush = el("button", {
    class: "btn btn--primary",
    text: "Start a rush",
    on: { click: callbacks.onRush },
  });
  const duel = el("button", {
    class: "btn",
    text: "Play somebody",
    on: { click: callbacks.onDuel },
  });

  return panel(
    solved === filed.length ? "The day is done" : "The day is filed",
    { class: "home__done" },
    // The four rows are one block, not four children of the card. A `.panel` puts
    // eight pixels between everything it holds, and `.stat` is drawn to stack
    // flush — its dotted rule is the separator, and `:last-child` only knows to
    // drop the final one while the rows are siblings of each other.
    el(
      "div",
      { class: "home__done-stats" },
      ...filed.map((row) =>
        stat(
          TIER_LABELS[row.tier],
          row.run.solved
            ? formatDuration(row.run.totalMs)
            : `${row.run.attack} / ${row.run.targetAttack} attack`,
        ),
      ),
      solved > 0 ? stat("Total", formatDuration(totalMs)) : null,
    ),
    el("p", {
      class: "note",
      text:
        (solved === filed.length
          ? "All three, solved and filed."
          : `${countWord(solved)} of three today.`) + " Rush is open until midnight.",
    }),
    el("div", { class: "btnrow" }, rush, duel),
  );
}

export function createHome(callbacks: HomeCallbacks): Home {
  const dayNumber = el("span", { class: "readout home__day-number", text: "" });
  const note = el("p", { class: "note home__day-note", text: "" });
  /** The three sheets, and the receipt that replaces the hero once they are done. */
  const today = el("div", { class: "home__today" });
  const ways = waysPanel(callbacks);
  // `.rail` for its gap, its shadow gutter, its thin scrollbar, its narrow
  // reflow, and above all its `> .panel:has(.board-list) { min-height: 0 }` —
  // which is what lets the board shrink to the column and scroll inside itself
  // instead of pushing the day off the top.
  const side = el("div", { class: "rail home__side" });

  const element = el(
    "div",
    { class: "home" },
    el(
      "div",
      { class: "home__main" },
      el(
        "div",
        { class: "home__day" },
        el(
          "div",
          { class: "home__day-head" },
          // Not "Puzzle #247": the wordmark two rows above already reads
          // PUZZLE, and a heading repeating it is the duplication this screen
          // exists to remove. The number is still here, quietly, beside it.
          el("h2", { class: "display home__day-title", text: "Today's three" }),
          dayNumber,
        ),
        note,
      ),
      today,
      ways.element,
    ),
    side,
  );

  return {
    element,
    mountBoard(board) {
      replaceChildren(side, board);
    },
    update(day, entries, streak, started) {
      dayNumber.textContent = `#${day}`;
      note.textContent = dayNote(entries, streak);
      // The hero is the first entry still playable, so it moves down the day as
      // puzzles are filed — and the height the filed ones give up goes to it.
      const heroIndex = entries.findIndex((entry) => entry.run === null);
      replaceChildren(
        today,
        ...entries.map((entry, index) =>
          todaySheet(entry, {
            hero: index === heroIndex,
            started,
            onPick: callbacks.onPick,
          }),
        ),
        dayDonePanel(entries, callbacks),
      );
    },
    setRush(runs) {
      // Never a zero and never a blank: a row saying "0 runs today" reads as a
      // dead mode, and the day's rushes are already in the leaderboard
      // response this screen asks for, so there is no second request behind
      // this line. Empty until that lands, which is the one honest blank.
      if (runs.length === 0) {
        ways.rushMeta.textContent = "No runs yet";
        return;
      }
      const best = Math.max(...runs.map((run) => run.solved));
      // No "today" in either: the heading above says TODAY'S THREE and the
      // sentence under it says today, and the three words this line can spare
      // are the difference between the row fitting on one line and its sentence
      // wrapping into the count beside it.
      ways.rushMeta.textContent =
        `${runs.length} run${runs.length === 1 ? "" : "s"} · best ${best}`;
    },
  };
}
