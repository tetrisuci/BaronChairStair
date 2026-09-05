/**
 * The screen itself: structure and the CSS contracts the layout turns on.
 *
 * These exist because three bugs in a row reached a player through a gap the
 * rest of the suite cannot see. `bun test` has no document, so mounting order,
 * canvas sizing and scroll containers were all invisible here and every one of
 * them was found by hand in Discord and fixed by reading.
 *
 * happy-dom closes part of that gap and not all of it. It builds a real DOM and
 * cascades real stylesheets, so "which rules apply to this element" is testable
 * and is what these assert. It does **no layout**: nothing here can tell you a
 * card overflowed its screen, that a wheel event chained, or that a canvas was
 * cleared. Those are still read, not run.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { activeRun } from "../client/src/game/active-run";
import { createHome } from "../client/src/ui/home";
import { createDailyBoard } from "../client/src/ui/daily-board";
import { boardGlyph } from "../client/src/render/piece-glyph";
import { MINO_INK, PAPER } from "../client/src/render/skin";
import { withRush } from "../client/src/ui/daily-board";
import { createRushResultCard } from "../client/src/ui/rush";
import { createBuilder } from "../client/src/ui/builder";
import { createStartedPuzzles } from "../client/src/started";
import { createExplorer } from "../client/src/ui/explorer";
import { lockedPuzzleIds } from "../client/src/daily-lock";
import { DEFAULT_ARCHIVE_FILTER } from "../shared/archive-filter";
import { createCredits } from "../client/src/ui/chrome";
import { MAX_ROWS } from "../client/src/ui/builder-state";
import type { RushPlayed } from "../client/src/api";

let window: Window;
const saved = {
  document: globalThis.document,
  getComputedStyle: globalThis.getComputedStyle,
  // Bun has no `localStorage`, and `started.ts` swallows the ReferenceError it
  // would throw — so without lending it happy-dom's, every assertion about
  // what was remembered would pass by remembering nothing.
  localStorage: globalThis.localStorage,
};

beforeAll(() => {
  // Scoped to this file rather than registered as a preload: `bun test` shares
  // one process, and the server suite leans on Bun's own fetch/Request, which a
  // global DOM registration would shadow.
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
  globalThis.getComputedStyle = window.getComputedStyle.bind(
    window,
  ) as unknown as typeof getComputedStyle;
  globalThis.localStorage = window.localStorage as unknown as Storage;

  // Both, and in the order the app loads them: the front door refines classes
  // panels.css defines, and half of what these tests assert is which of the two
  // rules ends up applying.
  for (const sheet of [
    "client/src/styles/panels.css",
    "client/src/styles/home.css",
    // main.ts loads overlays.css *after* home.css, and `.note` lives there —
    // so without it the cascade these tests read is not the cascade that ships.
    "client/src/styles/overlays.css",
  ]) {
    const style = window.document.createElement("style");
    style.textContent = readFileSync(sheet, "utf8");
    window.document.head.append(style);
  }
});

afterAll(() => {
  globalThis.document = saved.document;
  globalThis.getComputedStyle = saved.getComputedStyle;
  globalThis.localStorage = saved.localStorage;
});

const played = (count: number): RushPlayed[] =>
  Array.from({ length: count }, (_, index) => ({
    id: 100 + index,
    title: `sheet ${100 + index}`,
    solved: index % 2 === 0,
  }));

function mountedResultCard(onRetry: (id: number) => void = () => {}) {
  const card = createRushResultCard(
    () => {},
    () => {},
    onRetry,
  );
  window.document.body.append(card.element as never);
  return card;
}

describe("the rush end screen's puzzle list", () => {
  /**
   * The bug this pins: `.explore__list` is a scroller in its own right with
   * `overscroll-behavior: contain`, which is right where the list *is* the
   * screen and wrong on a card that scrolls as a whole. Contained, the wheel
   * died wherever the pointer sat over a row — most of that card — and the
   * list grew past the card instead of scrolling inside it.
   */
  test("does not contain the wheel, so the screen scrolls under the cursor", () => {
    const card = mountedResultCard();
    card.update({
      run: { solved: 3, attempted: 5, skipsUsed: 0, timeToLastSolveMs: 12_400 },
      played: played(5),
      ranked: true,
      isFirst: true,
      best: 5,
    });

    const list = window.document.querySelector(".explore__list")!;
    const style = window.getComputedStyle(list as never);
    expect(list.className).toContain("explore__list--flow");
    expect(style.overscrollBehavior).not.toBe("contain");
    expect(style.overflowY).toBe("visible");
    // A min-height is what made it grow rather than scroll; on this screen the
    // card's own height is the only one that should matter.
    expect(style.minHeight).toBe("0");
  });

  test("a list that is the whole screen still keeps its scrolling to itself", () => {
    // The explorer and the 1v1 room list are mounted with `screen--fill`, where
    // the card owns the height and the list is the thing that moves. The fix
    // above must not have reached them.
    const plain = window.document.createElement("div");
    plain.className = "explore__list";
    window.document.body.append(plain);
    const style = window.getComputedStyle(plain as never);
    expect(style.overscrollBehavior).toBe("contain");
    expect(style.overflowY).toBe("auto");
  });
});

describe("the rush end screen's contents", () => {
  test("lists every puzzle played, in order, marked as the server scored it", () => {
    const card = mountedResultCard();
    card.update({
      run: { solved: 3, attempted: 5, skipsUsed: 0, timeToLastSolveMs: 12_400 },
      played: played(5),
      ranked: true,
      isFirst: true,
      best: 5,
    });

    const rows = [...card.element.querySelectorAll(".explore__item")];
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.querySelector(".explore__id")!.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(rows.map((row) => row.querySelector(".explore__meta")!.textContent)).toEqual([
      "solved",
      "not solved",
      "solved",
      "not solved",
      "solved",
    ]);
  });

  test("a row hands back the puzzle it names, not the one it sits at", () => {
    // The row index and the puzzle id are different numbers, and the retry has
    // to carry the id — an off-by-one here opens somebody else's puzzle.
    const opened: number[] = [];
    const card = mountedResultCard((id) => opened.push(id));
    card.update({
      run: { solved: 1, attempted: 3, skipsUsed: 0, timeToLastSolveMs: 900 },
      played: played(3),
      ranked: false,
      isFirst: false,
      best: 1,
    });

    const rows = [...card.element.querySelectorAll(".explore__item")];
    (rows[2] as unknown as HTMLElement).click();
    expect(opened).toEqual([102]);
  });

  test("the buttons come after the list, so the list never sits below them", () => {
    const card = mountedResultCard();
    card.update({
      run: { solved: 0, attempted: 1, skipsUsed: 0, timeToLastSolveMs: 0 },
      played: played(1),
      ranked: true,
      isFirst: true,
      best: 0,
    });
    const children = [...card.element.children].map((child) => child.className);
    expect(children.indexOf("explore__list explore__list--flow")).toBeLessThan(
      children.indexOf("btnrow"),
    );
  });

  test("shows no list at all when the run was never filed", () => {
    // The filing failed, so there is no account of which puzzles were solved.
    // An empty list saying "no puzzle was reached" would be a lie about a run
    // that reached several.
    const card = mountedResultCard();
    card.update({
      run: { solved: 2, attempted: 4, skipsUsed: 1, timeToLastSolveMs: 8_000 },
      played: [],
      ranked: false,
      isFirst: false,
      best: 2,
    });
    const list = card.element.querySelector(".explore__list") as unknown as HTMLElement;
    expect(list.hidden).toBe(true);
    expect(card.element.querySelectorAll(".explore__item")).toHaveLength(0);
  });
});

describe("which run a repaint asks for", () => {
  // The bug: relayout redrew `this.run`, the daily's, which is null for the
  // whole of a duel or a rush. Resizing a canvas clears it, and the resize
  // observer fires just after the playfield is mounted — so the first puzzle
  // of a duel or a rush was painted, wiped, and redrawn as nothing. It stayed
  // blank until an input produced the next frame, which in a puzzle with no
  // gravity means until the player pressed a key.
  const sessions = {
    daily: "daily-run",
    rush: "rush-run",
    duel: "duel-run",
    build: "build-run",
  };

  test("a duel is asked for the duel's run, not the daily's", () => {
    expect(activeRun("duel", sessions)).toBe("duel-run");
  });

  test("a rush is asked for the rush's run", () => {
    expect(activeRun("rush", sessions)).toBe("rush-run");
  });

  test("the daily and the explorer share the daily's run", () => {
    expect(activeRun("daily", sessions)).toBe("daily-run");
    expect(activeRun("explore", sessions)).toBe("daily-run");
  });

  test("the builder is asked for the draft being tested", () => {
    // The daily's run is null on the builder screen and the draft's is not
    // scored by anything, so asking the wrong one here draws an empty board
    // over a test the author is in the middle of playing.
    expect(activeRun("build", sessions)).toBe("build-run");
    expect(activeRun("build", { ...sessions, build: null })).toBeNull();
  });

  test("a rush between two puzzles has nothing to repaint", () => {
    // Not a fallthrough to the daily attempt waiting underneath: that is what a
    // chain of `??` would do, and it would draw the daily's board over a rush.
    expect(activeRun("rush", { ...sessions, rush: null })).toBeNull();
    expect(activeRun("duel", { ...sessions, duel: undefined })).toBeNull();
  });
});

describe("the front door", () => {
  /**
   * The five that were here read the chooser this screen absorbed. They are
   * the same five claims — the four states and their precedence, the length on
   * the row, the sentence that says how the day is going, and a row opening
   * its own tier — against the screen that now makes them. What moved is the
   * element: the state was a word at the end of a meta line and is a chip.
   */
  const entry = (tier: string, id: number, run: unknown) => ({
    tier,
    puzzle: {
      id,
      title: `sheet ${id}`,
      author: "satilea",
      difficulty: id,
      goal: "Clear 1 TSD",
      set: null,
      board: ["TTTT......", "..OO......"],
      queue: ["T", "O", "S", "Z"],
      hold: null,
      targetAttack: 4,
    },
    run,
    solution: null,
  });

  const solvedRun = { solved: true, totalMs: 102_300, attack: 5, targetAttack: 4 };
  const missedRun = { solved: false, totalMs: 60_000, attack: 2, targetAttack: 4 };

  const home = (
    entries: unknown[],
    options: { started?: readonly number[]; streak?: number; onPick?: (tier: string) => void } = {},
  ) => {
    const made = createHome({
      onPick: (tier) => options.onPick?.(tier),
      onRush: () => {},
      onDuel: () => {},
      onExplore: () => {},
      onBuild: () => {},
    });
    window.document.body.append(made.element as never);
    made.update(247, entries as never, options.streak ?? 0, new Set(options.started ?? []));
    return made;
  };

  const unplayed = () => [entry("easy", 2, null), entry("medium", 6, null), entry("hard", 11, null)];
  const chips = (made: { element: HTMLElement }) =>
    [...made.element.querySelectorAll(".today__chip")].map((chip) => chip.textContent);

  test("shows all three, with what the choice actually turns on", () => {
    const made = home(unplayed());
    const sheets = [...made.element.querySelectorAll(".today__sheet")];
    expect(sheets).toHaveLength(3);
    expect(sheets.map((sheet) => sheet.querySelector(".today__tier")!.textContent)).toEqual([
      "Easy",
      "Medium",
      "Hard",
    ]);
    // The length and the bar are part of the decision, so they are on the card.
    const meta = sheets[0]!.querySelector(".explore__meta")!.textContent!;
    expect(meta).toContain("4 pieces");
    expect(meta).toContain("target 4");
    // The goal, the rating and the pieces you get, none of which the old row of
    // five identical buttons could say at all.
    expect(sheets[0]!.querySelector(".goal__text, .explore__goal")!.textContent).toBe("Clear 1 TSD");
    expect(sheets[0]!.querySelector(".pips")).not.toBeNull();
    expect(sheets[0]!.querySelectorAll(".build__strip .glyph")).toHaveLength(4);
  });

  test("a filed miss and an untouched puzzle are different chips", () => {
    // The one thing a player reading a card already knows: whether they have
    // been here. A daily run reaches the server only when it solves.
    expect(
      chips(home([entry("easy", 2, solvedRun), entry("medium", 6, missedRun), entry("hard", 11, null)])),
    ).toEqual(["Solved 1:42.3", "Filed 2/4", "Not played"]);
  });

  test("a puzzle the player has opened reads as in progress, not as untouched", () => {
    expect(chips(home(unplayed(), { started: [6] }))).toEqual([
      "Not played",
      "In progress",
      "Not played",
    ]);
  });

  test("a filed run outranks having started it", () => {
    // Solving one does not stop it having been opened, and the chip has room
    // for one state: the one that says how it ended.
    expect(
      chips(
        home([entry("easy", 2, solvedRun), entry("medium", 6, missedRun), entry("hard", 11, null)], {
          started: [2, 6, 11],
        }),
      ),
    ).toEqual(["Solved 1:42.3", "Filed 2/4", "In progress"]);
  });

  const note = (made: { element: HTMLElement }) =>
    made.element.querySelector(".home__day-note")!.textContent;

  test("says how the day is going without making you count", () => {
    // Words, not digits: the masthead two rows above owns the tallies, and the
    // streak is spent as a reason inside a sentence rather than printed again.
    expect(note(home(unplayed()))).toContain("start a streak");
    expect(note(home(unplayed(), { streak: 6 }))).toContain("keeps your 6-day streak");
    expect(note(home([entry("easy", 2, solvedRun), entry("medium", 6, null), entry("hard", 11, null)])))
      .toBe("One solved, two left to play.");
    // Filed and missed is over, not still to play.
    expect(note(home([entry("easy", 2, missedRun), entry("medium", 6, null), entry("hard", 11, null)])))
      .toBe("Two left to play.");
    expect(
      note(home([entry("easy", 2, solvedRun), entry("medium", 6, solvedRun), entry("hard", 11, solvedRun)])),
    ).toBe("All three done. Back tomorrow.");
    expect(
      note(home([entry("easy", 2, solvedRun), entry("medium", 6, solvedRun), entry("hard", 11, missedRun)])),
    ).toBe("Today is filed. Two of three solved.");
  });

  test("a sheet opens its own tier, not the one it sits at", () => {
    const picked: string[] = [];
    const made = home(unplayed(), { onPick: (tier) => picked.push(tier) });
    const sheets = [...made.element.querySelectorAll(".today__sheet")];
    (sheets[2] as unknown as HTMLElement).click();
    expect(picked).toEqual(["hard"]);
  });

  test("the hero is the first one still worth playing, and it moves", () => {
    // The whole of the hierarchy this screen was rebuilt for: exactly one card
    // is the big one, it is one you can still play, and the height the filed
    // ones give up goes to it.
    const heroOf = (entries: unknown[]) => {
      const sheets = [...home(entries).element.querySelectorAll(".today__sheet")];
      return sheets.findIndex((sheet) => sheet.classList.contains("today__sheet--hero"));
    };
    expect(heroOf(unplayed())).toBe(0);
    expect(heroOf([entry("easy", 2, solvedRun), entry("medium", 6, null), entry("hard", 11, null)])).toBe(1);
    expect(heroOf([entry("easy", 2, solvedRun), entry("medium", 6, missedRun), entry("hard", 11, null)])).toBe(2);
    // Nothing left to play, so nothing is the hero.
    expect(heroOf([entry("easy", 2, solvedRun), entry("medium", 6, solvedRun), entry("hard", 11, solvedRun)])).toBe(-1);
  });

  test("only the hero carries a picture of its board", () => {
    const made = home(unplayed());
    const thumbs = [...made.element.querySelectorAll(".today__thumb")];
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]!.closest(".today__sheet")!.classList.contains("today__sheet--hero")).toBe(true);
  });

  test("a filed sheet goes quiet, and is still pressable", () => {
    // Done work loses its goal, its queue and its rating and keeps its name and
    // its result — the height it gives up is what the hero grows into.
    const filed = home([entry("easy", 2, solvedRun), entry("medium", 6, null), entry("hard", 11, null)])
      .element.querySelector(".today__sheet--filed")!;
    expect(filed.querySelector(".explore__goal")).toBeNull();
    expect(filed.querySelector(".build__strip")).toBeNull();
    expect(filed.querySelector(".pips")).toBeNull();
    expect(filed.querySelector(".today__chip")!.textContent).toBe("Solved 1:42.3");
    expect((filed as unknown as HTMLButtonElement).disabled).toBe(false);
  });

  test("the card announces itself as one thing, not as four", () => {
    // Display type, mono, pips and an SVG inside one control: read child by
    // child that is a sentence nobody wrote.
    const sheet = home(unplayed()).element.querySelector(".today__sheet")!;
    expect(sheet.getAttribute("aria-label")).toBe(
      "Easy — sheet 2 by satilea. Clear 1 TSD. Not played.",
    );
  });

  test("all three filed gets a receipt and one way on", () => {
    // The least-exercised path, because it only appears after a good day.
    const made = home([
      entry("easy", 2, solvedRun),
      entry("medium", 6, solvedRun),
      entry("hard", 11, missedRun),
    ]);
    const done = made.element.querySelector(".home__done")!;
    expect(done.querySelector(".panel__caption")!.textContent).toBe("The day is filed");
    const rows = [...done.querySelectorAll(".stat")].map((row) => [
      row.querySelector(".stat__key")!.textContent,
      row.querySelector(".stat__value")!.textContent,
    ]);
    expect(rows).toEqual([
      ["Easy", "1:42.3"],
      ["Medium", "1:42.3"],
      // No walkthrough is promised for a miss: the solution is sent only when
      // that puzzle is solved.
      ["Hard", "2 / 4 attack"],
      ["Total", "3:24.6"],
    ]);
    // The only filled-plum control on the screen, and only in this state.
    const primaries = [...made.element.querySelectorAll(".btn--primary")];
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.textContent).toBe("Start a rush");
  });

  test("nothing is emphasised twice while the day is unfinished", () => {
    // While there is a hero it is the single emphasis; the receipt's primary
    // button does not exist yet.
    expect(home(unplayed()).element.querySelectorAll(".btn--primary")).toHaveLength(0);
    expect(home(unplayed()).element.querySelector(".home__done")).toBeNull();
  });

  test("the modes say what they are, rather than repeating the masthead", () => {
    // HOME, 1V1, EXPLORE and RUSH are already in the header. The difference
    // between a menu and a duplicated toolbar is the sentence beside the name.
    const rows = [...home(unplayed()).element.querySelectorAll(".home__ways .explore__item")];
    expect(rows.map((row) => row.querySelector(".home__ways-name")!.textContent)).toEqual([
      "Rush",
      "1v1",
      "Explore",
      // Last, and the only one that is not a way to play.
      "Build",
    ]);
    expect(rows[3]!.querySelector(".explore__goal")!.textContent).toBe(
      "Lay out a board and get a puzzle code",
    );
  });

  test("the rush row never says zero, and never says nothing after it lands", () => {
    const made = home(unplayed());
    const meta = () => made.element.querySelector(".home__ways .explore__meta")!.textContent;
    // Blank is the one honest state: before the leaderboard response arrives.
    expect(meta()).toBe("");
    made.setRush([]);
    expect(meta()).toBe("No runs yet");
    made.setRush([{ solved: 3 }, { solved: 7 }] as never);
    expect(meta()).toBe("2 runs · best 7");
    made.setRush([{ solved: 1 }] as never);
    expect(meta()).toBe("1 run · best 1");
  });

  test("an empty leaderboard is a sentence, not a blank card", () => {
    // Most mornings. The note is seeded at construction, so a fetch that is
    // pending or that failed reads as an empty morning rather than as nothing.
    const made = home(unplayed());
    const board = createDailyBoard();
    made.mountBoard(board.element);
    const side = made.element.querySelector(".home__side")!;
    expect(side.contains(board.element as never)).toBe(true);
    expect(board.element.querySelector(".note")!.textContent).toBe(
      "Nobody has played yet today. Be first.",
    );
    // Mounted into a `.rail`, which is where the panel's licence to shrink
    // comes from: without `min-height: 0` a full board refuses to give way and
    // pushes the day off the top of the column instead of scrolling inside
    // itself. Home does not own the board, so it has to be handed that rule
    // rather than restate it.
    expect(side.classList.contains("rail")).toBe(true);
    expect(window.getComputedStyle(board.element as never).minHeight).toBe("0");
  });

  test("the left column fills by arithmetic, and the hero is the only elastic", () => {
    // The complaint this screen was rebuilt for: a card that filled the window
    // with a third of a window of content. Everything here is sized by what is
    // in it except one card, which takes the rest — so a taller window is a
    // bigger picture of the puzzle you are about to play, not more padding.
    const made = home(unplayed());
    const flex = (selector: string) =>
      window.getComputedStyle(made.element.querySelector(selector) as never).flexGrow;
    expect(flex(".today__sheet--hero")).toBe("1");
    expect(flex(".today__sheet:not(.today__sheet--hero)")).toBe("0");
    expect(flex(".home__ways")).toBe("0");

    // And no floor of zero on the screen itself: with one, a column taller than
    // the window would overflow in silence over the credits strip rather than
    // growing the row and letting `.screen` scroll.
    expect(window.getComputedStyle(made.element as never).minHeight).not.toBe("0");
  });

  test("the hero's queue strip is the size its container asks for", () => {
    // home.css sets `.today__sheet .build__strip { --glyph-cell: 9px }`, and
    // narrow.css drops it to 8px below 560, precisely so the strip shrinks with
    // the window. Neither reaches a glyph: `pieceGlyph` writes `--glyph-cell`
    // onto the svg's own inline style on every call — `options.cell ?? 11` —
    // and an element's own declaration beats any value it would inherit. Not
    // passing `cell` does not opt out of the inline write, it only changes what
    // is written, so both rules are dead and the strip draws at 11.
    const strip = home(unplayed()).element.querySelector(".build__strip")!;
    const glyph = strip.querySelector(".glyph") as unknown as HTMLElement;
    expect(window.getComputedStyle(strip as never).getPropertyValue("--glyph-cell")).toBe("9px");
    // happy-dom does not inherit custom properties down the tree, so the value
    // reaching the glyph is not readable here — the inline declaration that
    // blocks it is, and it is the whole of the bug.
    expect(glyph.style.getPropertyValue("--glyph-cell")).toBe("");
  });

  test("the day's sentence is the size home.css asks for", () => {
    // `.home__day-note { font-size: 12px }` is one class, and so is overlays.css's
    // `.note { font-size: 11px }` on the same element — and overlays.css loads
    // after home.css, so the tie goes to it. home.css's header says nothing in
    // it depends on load order; this one declaration does, and loses.
    const made = home(unplayed());
    expect(
      window.getComputedStyle(made.element.querySelector(".home__day-note") as never).fontSize,
    ).toBe("12px");
  });

  test("a puzzle with no goal still says what to do", () => {
    // Archive puzzle 8, "fourtris mogs", ships `goal: ""`, and at difficulty 4
    // `dailyTierOf` files it under easy — so on the days it comes up it is
    // entries[0] and the hero, and the hero's headline is the goal. `hud.ts`
    // has the fallback for exactly this row ("Send as much as the reference
    // line"); the front door does not, so the biggest card on the screen has a
    // blank line where its sentence goes, and announces itself with a bare stop
    // in the middle: "... by satilea. . Not played."
    const blank = entry("easy", 2, null);
    const made = home([
      { ...blank, puzzle: { ...blank.puzzle, goal: "" } },
      entry("medium", 6, null),
      entry("hard", 11, null),
    ]);
    const hero = made.element.querySelector(".today__sheet--hero")!;
    expect(hero.querySelector(".goal__text")!.textContent).not.toBe("");
    expect(hero.getAttribute("aria-label")).not.toContain(". .");
  });
});

describe("a board drawn as a picture", () => {
  test("draws the floor at the bottom, not at the top", () => {
    // `board[0]` is the floor and SVG's y axis points down. Inverted, this is
    // upside down rather than absent, which is the kind of bug that ships.
    const svg = boardGlyph(["TTTTTTTTTT", "..........", "..........", ".........."]);
    expect(svg.getAttribute("viewBox")).toBe("0 0 100 40");
    const filled = [...svg.querySelectorAll("rect")].filter(
      (rect) => rect.getAttribute("fill") === MINO_INK.T,
    );
    expect(filled).toHaveLength(10);
    expect(filled.every((rect) => Number(rect.getAttribute("y")) > 30)).toBe(true);
  });

  test("pads a one-row board rather than drawing a sliver", () => {
    // The archive's shallowest board is one row deep and its median is six, so
    // a 10x1 rectangle is a real puzzle and reads as a failed render.
    const svg = boardGlyph(["GGGGGGGGGG"]);
    expect(svg.getAttribute("viewBox")).toBe("0 0 100 40");
    const rects = [...svg.querySelectorAll("rect")];
    expect(rects).toHaveLength(40);
    // The padding is empty field, which is what the player will see above the
    // stack when they open it.
    expect(rects.filter((rect) => rect.getAttribute("fill") === PAPER.field)).toHaveLength(30);
  });

  test("takes its shape from the board's own depth", () => {
    expect(boardGlyph(Array(14).fill("..........")).getAttribute("viewBox")).toBe("0 0 100 140");
  });
});

describe("the playfield field keeps gestures usable", () => {
  test("the field keeps the browser's hands off pointer gestures", () => {
    // The whole mobile feature turns on this one declaration: without it a
    // drag pans the page and the piece never follows the finger. happy-dom
    // cascades real stylesheets, so the contract is checkable here.
    const style = window.document.createElement("style");
    style.textContent = readFileSync("client/src/styles/sheet.css", "utf8");
    window.document.head.append(style);
    const field = window.document.createElement("div");
    field.className = "field";
    window.document.body.append(field);
    expect(window.getComputedStyle(field as never).touchAction).toBe("none");
  });
});

describe("rush attached to the day's board", () => {
  const row = (id: string, solved: number, totalMs: number) =>
    ({ player: { id, username: id, avatarUrl: null }, solved, totalMs, marks: {} }) as never;
  const rushRun = (id: string, solved: number) =>
    ({ player: { id, username: id, avatarUrl: null }, solved }) as never;

  test("puts a rush-only player on the board", () => {
    // Somebody who spent their day on rush did not do nothing, and the daily
    // board — which the server merged — has no row for them at all.
    const rows = withRush([row("ada", 2, 3000)], [rushRun("bo", 7)]);
    expect(rows.map((r) => r.player.id).sort()).toEqual(["ada", "bo"]);
    expect(rows.find((r) => r.player.id === "bo")!.solved).toBe(0);
  });

  test("a rush of zero is not the same as no rush at all", () => {
    // null is the blank. Zero means they ran one and cleared nothing, which is
    // a different day and should read differently.
    expect(withRush([], [rushRun("bo", 0)])[0]!.rush).toBe(0);
    expect(withRush([row("ada", 1, 500)], [])[0]!.rush).toBeNull();
  });

  test("the daily still decides the order, with rush breaking ties", () => {
    expect(withRush([row("ada", 2, 3000)], [rushRun("bo", 40)])[0]!.player.id).toBe("ada");
    const tied = withRush([row("cy", 1, 500), row("di", 1, 500)], [rushRun("di", 9)]);
    expect(tied[0]!.player.id).toBe("di");
  });

  test("keeps the best rush when a player ran more than one", () => {
    // Replays are unlimited and unscored; the best is the interesting one, not
    // whichever came back last.
    expect(withRush([], [rushRun("ada", 3), rushRun("ada", 8), rushRun("ada", 5)])[0]!.rush).toBe(8);
  });
});

describe("the builder", () => {
  const mountedBuilder = () => {
    const builder = createBuilder(
      {
        onClose: () => {},
        onTest: () => {},
        onStopTest: () => {},
        onSubmit: async () => ({ attack: 0 }),
      },
      // Signed in, because these are about where the three parts land on the
      // page and a guest changes only what one button in a rail says.
      false,
    );
    // Mounted the way the app mounts it: three siblings, straight into the deck.
    window.document.body.append(
      builder.left as never,
      builder.board as never,
      builder.right as never,
    );
    return builder;
  };

  test("hands the app a board and two rails, not one card", () => {
    // The board is the centre of the deck — where the game's own board goes —
    // rather than a column inside a card beside its controls, which is what
    // squeezed it to about 260px in a Discord window. The three parts are the
    // whole of that, so they are what the app is handed.
    const builder = mountedBuilder();
    expect(builder.board.querySelector(".build__grid")).not.toBeNull();
    expect(builder.left.classList.contains("rail")).toBe(true);
    expect(builder.right.classList.contains("rail")).toBe(true);
    // The controls live in the rails, so nothing shares the board's room.
    expect(builder.board.querySelector("button")).toBeNull();
    expect(builder.left.querySelector(".build__palette")).not.toBeNull();
    expect(builder.right.querySelector(".build__code")).not.toBeNull();
  });

  test("creates no scroller of its own, so the rail is the only one", () => {
    // The trap `.explore__list--flow` exists for: a nested scroller inside a
    // scroller eats the wheel wherever the pointer sits. A rail scrolls, as
    // every rail does; nothing the builder puts inside one may.
    const builder = mountedBuilder();
    const inside = [builder.left, builder.right, builder.board].flatMap((part) => [
      ...part.querySelectorAll("*"),
    ]);
    const scrollers = inside.filter((node) => {
      const overflow = window.getComputedStyle(node as never).overflowY;
      return overflow === "auto" || overflow === "scroll";
    });
    expect(scrollers).toHaveLength(0);
  });

  test("draws ten columns and the whole twenty-row field", () => {
    const builder = mountedBuilder();
    const rows = builder.board.querySelectorAll(".build__row");
    expect(rows).toHaveLength(MAX_ROWS);
    expect(rows[0]!.querySelectorAll(".build__cell")).toHaveLength(10);
  });
});

describe("remembering which puzzles were opened", () => {
  test("a puzzle opened in one session is still open in the next", () => {
    // The whole reason this is not a field on the app: a Discord activity is
    // closed and reopened constantly, and a record that forgets itself when
    // the panel closes tells the same lie a minute later.
    createStartedPuzzles("ada").add(246, 11);
    expect(createStartedPuzzles("ada").has(246, 11)).toBe(true);
    expect(createStartedPuzzles("ada").has(246, 12)).toBe(false);
  });

  test("yesterday's record is not read as today's", () => {
    const store = createStartedPuzzles("bo");
    store.add(246, 11);
    expect(store.has(247, 11)).toBe(false);
    // And the new day is what gets written, so the old one cannot come back.
    store.add(247, 12);
    expect(createStartedPuzzles("bo").has(246, 11)).toBe(false);
    expect(createStartedPuzzles("bo").has(247, 12)).toBe(true);
  });

  test("one player's record is not another's", () => {
    // One origin serves every Discord account that has ever opened the
    // activity in this browser — the same trap `settings.ts` documents.
    createStartedPuzzles("cy").add(246, 11);
    expect(createStartedPuzzles("di").has(246, 11)).toBe(false);
  });

  test("survives storage it cannot read", () => {
    localStorage.setItem("puzzle.started.v1.eve", "{not json");
    expect(createStartedPuzzles("eve").has(246, 11)).toBe(false);
    // And still records from there, rather than being stuck on the bad value.
    const store = createStartedPuzzles("eve");
    store.add(246, 11);
    expect(createStartedPuzzles("eve").has(246, 11)).toBe(true);
  });
});

describe("the difficulty pips", () => {
  const credits = () => createCredits();

  /** What one difficulty renders as: filled of total, with a "+" if there is one. */
  const shown = (difficulty: number): string => {
    const strip = credits();
    strip.update({
      id: 1,
      title: "sheet",
      author: "satilea",
      difficulty,
      goal: "Clear 1 TSD",
      set: null,
      board: [],
      queue: ["T"],
      hold: null,
      targetAttack: 4,
    } as never);
    const pips = strip.element.querySelector(".credits__pips")!;
    const dots = [...pips.querySelectorAll(".pips__dot")];
    const on = dots.filter((dot) => dot.className.includes("--on")).length;
    return `${on}/${dots.length}${pips.querySelector(".pips__plus") ? "+" : ""}`;
  };

  test("fills one square per two rating points, and caps at five and a plus", () => {
    // The archive's scale is 1-to-10-and-beyond and the strip has five squares,
    // so the banding is the whole of what a reader gets. It was arithmetic with
    // no test under it: `Math.ceil(d / 2)` is one edit away from `Math.round`,
    // which quietly moves every odd rating down a square.
    expect([1, 2].map(shown)).toEqual(["1/5", "1/5"]);
    expect([3, 4].map(shown)).toEqual(["2/5", "2/5"]);
    expect([5, 6].map(shown)).toEqual(["3/5", "3/5"]);
    expect([7, 8].map(shown)).toEqual(["4/5", "4/5"]);
    expect([9, 10].map(shown)).toEqual(["5/5", "5/5"]);
  });

  test("says 'and then some' above ten, which the archive really reaches", () => {
    // Seventeen archived puzzles are rated above ten and one is a 20, so the
    // cap is a real band rather than a defensive one. Ten itself is not in it.
    expect(shown(10)).toBe("5/5");
    expect([11, 15, 20].map(shown)).toEqual(["5/5+", "5/5+", "5/5+"]);
  });

  test("unrated fills nothing, and is not the same as easy", () => {
    // Seven archived puzzles carry no rating. They ask for things like
    // "2 TSS, 3 TSD", so reading a zero as the gentlest puzzle on the board
    // would be the wrong way round — the row says so in words instead.
    expect(shown(0)).toBe("0/5");
    const strip = credits();
    strip.update({ id: 1, title: "s", author: "a", difficulty: 0, goal: "", set: null,
      board: [], queue: ["T"], hold: null, targetAttack: 1 } as never);
    expect(strip.element.querySelector(".pips")!.getAttribute("aria-label")).toBe("not yet rated");
  });

  test("no puzzle at all draws no pips, not five empty ones", () => {
    const strip = credits();
    strip.update(null);
    expect(strip.element.querySelector(".credits__pips")!.childElementCount).toBe(0);
    expect(strip.element.querySelector(".credits__title")!.textContent).toBe("—");
  });
});

describe("a puzzle the explorer will not open", () => {
  const listing = (id: number, title: string) => ({
    id,
    title,
    author: "satilea",
    difficulty: 4,
    goal: "Clear 1 TSD",
    set: null,
    pieces: 3,
    targetAttack: 4,
    community: false,
  });

  const shown = (locked: readonly number[]) => {
    const made = createExplorer({
      onPlay: () => {},
      onRandom: () => {},
      onFilter: () => {},
      onClose: () => {},
    } as never);
    window.document.body.append(made.element as never);
    made.update(
      [listing(15, "protanopia"), listing(46, "stmb cave")] as never,
      DEFAULT_ARCHIVE_FILTER,
      new Set(locked),
    );
    return [...made.element.querySelectorAll(".explore__item")].map((row) => ({
      text: (row.textContent ?? "").replace(/\s+/g, " "),
      locked: row.className.includes("explore__item--locked"),
      reason: row.querySelector(".explore__locked")?.textContent ?? null,
    }));
  };

  test("says on the row why, rather than only in a tooltip", () => {
    // The reason lived in a `title` attribute, which needs a hover nobody
    // thinks to try — and a browser will not show one on a disabled button at
    // all. So the only thing the player was told was that this row is
    // different from the others, never why, which is what the greying looks
    // like when you cannot read the explanation.
    const rows = shown([15]);
    expect(rows[0]!.locked).toBe(true);
    expect(rows[0]!.reason).toBe("today's — solve it on the daily");
    expect(rows[0]!.text).toContain("today's");
  });

  test("says nothing on a puzzle that is open", () => {
    const rows = shown([15]);
    expect(rows[1]!.locked).toBe(false);
    expect(rows[1]!.reason).toBeNull();
  });
});

describe("what practice may open of today's three", () => {
  const day = (runs: readonly (boolean | null)[]) =>
    runs.map((solved, index) => ({
      puzzle: { id: 10 + index },
      run: solved === null ? null : { solved },
    }));

  test("a puzzle you have solved is open", () => {
    // The whole point of the lock is that today's three are not a rehearsal
    // room. Once one is solved there is nothing left to rehearse for.
    expect([...lockedPuzzleIds(day([true, null, null]))]).toEqual([11, 12]);
  });

  test("a puzzle you filed and did not solve stays shut", () => {
    // The bug this pins. `recordRun` upserts a solve over a miss —
    // `WHERE runs.solved = 0 AND excluded.solved = 1` — so a filed miss is not
    // a finished puzzle: the player can still come back and file the solve.
    // Unlocking on the row's existence let them practise it first, with the
    // answer in hand, which is exactly the rehearsal the lock forbids.
    expect([...lockedPuzzleIds(day([false, null, null]))]).toEqual([10, 11, 12]);
  });

  test("solving one does not open the other two", () => {
    // Three puzzles, three places on the board. Read as "solved today" this
    // would hand somebody the hard one for beating the easy one.
    expect([...lockedPuzzleIds(day([true, true, null]))]).toEqual([12]);
    expect([...lockedPuzzleIds(day([true, true, true]))]).toEqual([]);
  });

  test("a day that has not loaded locks nothing", () => {
    expect([...lockedPuzzleIds([])]).toEqual([]);
  });
});
