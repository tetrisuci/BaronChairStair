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

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { activeRun } from "../client/src/game/active-run";
import { createHome } from "../client/src/ui/home";
import { createDailyBoard } from "../client/src/ui/daily-board";
import { createDiscoveryBoard } from "../client/src/ui/discovery-board";
import { createSolutionsPanel } from "../client/src/ui/solutions";
import { createSolutionsMenu } from "../client/src/ui/solutions-menu";
import { createProfile } from "../client/src/ui/profile";
import { createLeaderboards } from "../client/src/ui/leaderboards";
import { playerAvatar } from "../client/src/ui/avatar";
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
    // `.rail` lives here, and whether it swallows a wheel is a scrolling rule
    // the tests below read out of the cascade.
    "client/src/styles/sheet.css",
  ]) {
    const style = window.document.createElement("style");
    style.textContent = readFileSync(sheet, "utf8");
    window.document.head.append(style);
  }
});

/**
 * EMPTY THE BODY BETWEEN TESTS, or this file cannot finish.
 *
 * Every mount here appends to one `document.body` and nothing ever took anything out
 * again, so across 88 tests the tree only grew. happy-dom resolves style by matching
 * the loaded sheets against the live document, so each `getComputedStyle` had to walk
 * a bigger tree than the last: the cost is quadratic in the number of tests, not linear.
 *
 * Measured: the file never reached its first reported test, oscillated between 0.13 GB
 * and 3.95 GB of violent GC churn, and peaked at a 28 GB physical footprint — enough to
 * push a 16 GB machine into 23 GB of swap. A single test in isolation passes in ~2s.
 */
afterEach(() => {
  window.document.body.replaceChildren();
});

afterAll(async () => {
  globalThis.document = saved.document;
  globalThis.getComputedStyle = saved.getComputedStyle;
  globalThis.localStorage = saved.localStorage;
  // happy-dom holds timers, observers and the whole tree until it is told to stop.
  // Without this the process also has no reason to exit once the tests are done.
  await window.happyDOM.close();
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

  // All four tiers, because the front page counts what it is given: a fixture
  // one tier short would have let "Three of three solved" ship on a four-puzzle
  // day, which is exactly what it did.
  const unplayed = () => [
    entry("easy", 2, null),
    entry("medium", 6, null),
    entry("hard", 11, null),
    entry("extreme", 18, null),
  ];
  const chips = (made: { element: HTMLElement }) =>
    [...made.element.querySelectorAll(".today__chip")].map((chip) => chip.textContent);

  test("shows every tier, with what the choice actually turns on", () => {
    const made = home(unplayed());
    const sheets = [...made.element.querySelectorAll(".today__sheet")];
    expect(sheets).toHaveLength(4);
    expect(sheets.map((sheet) => sheet.querySelector(".today__tier")!.textContent)).toEqual([
      "Easy",
      "Medium",
      "Hard",
      "Extreme",
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

  /**
   * The streak has to survive being extended.
   *
   * Every case above passes streak 0, which is the one value that prints
   * nothing — so the sentences that name it were shipped with no coverage at
   * all. The masthead used to carry the number and this line only gave it a
   * purpose; with the masthead gone, these sentences are the only place a
   * player sees it, and a wrong one is worse than none.
   */
  test("names the streak in every state, not only before the day starts", () => {
    const solvedOne = [entry("easy", 2, solvedRun), entry("medium", 6, null), entry("hard", 11, null)];
    const missedOne = [entry("easy", 2, missedRun), entry("medium", 6, null), entry("hard", 11, null)];
    const allDone = [entry("easy", 2, solvedRun), entry("medium", 6, solvedRun), entry("hard", 11, solvedRun)];

    // Solved something: it is safe, and saying so is the point of the number.
    expect(note(home(solvedOne, { streak: 6 }))).toBe(
      "One solved, two left to play. Your 6-day streak is safe.",
    );
    expect(note(home(allDone, { streak: 6 }))).toBe("All three done. Back tomorrow. Your 6-day streak is safe.");

    // Nothing solved yet and chances left: still riding on them.
    expect(note(home(missedOne, { streak: 6 }))).toBe(
      "Two left to play. Your 6-day streak needs one of them.",
    );

    // No streak, no sentence about one — in every branch.
    expect(note(home(solvedOne))).toBe("One solved, two left to play.");
    expect(note(home(missedOne))).toBe("Two left to play.");
    expect(note(home(allDone))).toBe("All three done. Back tomorrow.");
  });

  test("a day filed with nothing solved says so, rather than counting to zero", () => {
    const noneSolved = [entry("easy", 2, missedRun), entry("medium", 6, missedRun), entry("hard", 11, missedRun)];
    expect(note(home(noneSolved))).toBe("Today is filed, with none solved.");
    // No streak claim either way: there is nothing safe and nothing left to
    // save it with.
    expect(note(home(noneSolved, { streak: 6 }))).toBe("Today is filed, with none solved.");
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

  test("both boards share the side column", () => {
    // Two different questions — how did the server do today, and who has found
    // something nobody had — and the column holds them at once rather than
    // making one a tab behind the other.
    const made = home(unplayed());
    const day = createDailyBoard();
    const found = createDiscoveryBoard();
    made.mountBoard(day.element, found.element);
    const side = made.element.querySelector(".home__side")!;

    expect(side.contains(day.element as never)).toBe(true);
    expect(side.contains(found.element as never)).toBe(true);
  });

  test("an empty discovery board is a standing offer, not an emptiness", () => {
    // On most servers this is empty for a long time, and that is not a failure
    // state — so the card asks for something rather than reporting nothing.
    const found = createDiscoveryBoard();

    expect(found.element.querySelector(".note")!.textContent).toBe(
      "No new lines yet. Solve a puzzle a way nobody has, and this is where it lands.",
    );
    expect(found.element.querySelectorAll(".board-list__row")).toHaveLength(0);
  });

  test("the discovery board ranks finders and marks the reader's own row", () => {
    const found = createDiscoveryBoard();
    found.update(
      [
        { player: { id: "a", username: "ada" }, found: 3, latestAt: 1 },
        { player: { id: "b", username: "bo" }, found: 1, latestAt: 2 },
      ] as never,
      "b",
      { rank: 2, found: 1 },
    );
    const rows = [...found.element.querySelectorAll(".board-list__row")];

    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".board-list__name")!.textContent).toBe("ada");
    expect(rows[0]!.querySelector(".board-list__score")!.textContent).toBe("3 lines");
    // Singular, because "1 lines" is the kind of thing a club notices.
    expect(rows[1]!.querySelector(".board-list__score")!.textContent).toBe("1 line");
    expect(rows[0]!.classList.contains("board-list__row--self")).toBe(false);
    expect(rows[1]!.classList.contains("board-list__row--self")).toBe(true);
  });

  test("a reader too far down to be on the board still gets their own line", () => {
    // The board is now everybody who has ever played rather than one club, so
    // almost nobody reading it is on it. Twenty five strangers and no line for
    // the reader is what makes a leaderboard feel closed.
    const found = createDiscoveryBoard();
    found.update(
      [{ player: { id: "a", username: "ada" }, found: 30, latestAt: 1 }] as never,
      "me",
      { rank: 391, found: 2 },
    );
    const own = found.element.querySelector(".board-list--self-only")!;

    expect((own as HTMLElement).hidden).toBe(false);
    expect(own.querySelector(".board-list__rank")!.textContent).toBe("391");
    expect(own.querySelector(".board-list__name")!.textContent).toBe("You");
    expect(own.querySelector(".board-list__score")!.textContent).toBe("2 lines");
  });

  test("and does not get it twice when they are already up there", () => {
    // One person on a board twice, once labelled "you", is the reading a board
    // gets exactly once before nobody trusts it.
    const found = createDiscoveryBoard();
    found.update(
      [{ player: { id: "me", username: "Me" }, found: 4, latestAt: 1 }] as never,
      "me",
      { rank: 1, found: 4 },
    );

    expect((found.element.querySelector(".board-list--self-only") as HTMLElement).hidden).toBe(true);
    expect(found.element.querySelectorAll(".board-list__row")).toHaveLength(1);
  });

  test("a reader who has found nothing is shown no rank at all", () => {
    // "#0 — 0 lines" is worse than the invitation the empty board already has.
    const found = createDiscoveryBoard();
    found.update([] as never, "me", null);

    expect((found.element.querySelector(".board-list--self-only") as HTMLElement).hidden).toBe(true);
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

  const shown = (locked: readonly number[], cleared: readonly number[] = []) => {
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
      new Set(cleared),
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


/** A `SolutionPlayer` stub: enough of one for the controls to draw. */
function fakePlayer(steps = [{ piece: "T", cells: [], clear: "tsd", attack: 4 }]) {
  let index = 0;
  return {
    get placements() { return steps; },
    get position() { return index; },
    get stepCount() { return steps.length; },
    get current() { return steps[index] ?? null; },
    get atEnd() { return index >= steps.length; },
    next() { index = Math.min(steps.length, index + 1); },
    previous() { index = Math.max(0, index - 1); },
    seek(to: number) { index = Math.max(0, Math.min(steps.length, to)); },
    reset() { index = 0; },
    end() { index = steps.length; },
  } as never;
}

describe("the solutions gallery", () => {
  const line = (over: Record<string, unknown> = {}) => ({
    solutionId: 1,
    placements: [{ piece: "T", cells: [[0, 0]], clear: "tsd", attack: 4 }],
    attack: 4,
    clears: ["tsd"],
    source: "player",
    finder: { id: "ada", username: "Ada", avatarUrl: null },
    foundAt: 1,
    solvedStrict: true,
    ...over,
  });

  const rowsOf = (panel: { element: HTMLElement }) =>
    [...panel.element.querySelectorAll(".solutions__row")];

  test("the maker's answer is named as nobody's", () => {
    const made = createSolutionsPanel();
    made.show([line({ source: "reference", finder: null })] as never, "me", () => {});

    expect(rowsOf(made)[0]!.querySelector(".board-list__name")!.textContent).toBe(
      "The maker's answer",
    );
  });

  test("a finder is named, and you are named as you", () => {
    const made = createSolutionsPanel();
    made.show(
      [line(), line({ solutionId: 2, finder: { id: "me", username: "Me", avatarUrl: null } })] as never,
      "me",
      () => {},
    );
    const rows = rowsOf(made);

    expect(rows.map((r) => r.querySelector(".board-list__name")!.textContent)).toEqual(["Ada", "You"]);
    // Yours is marked the way it is on every other board here.
    expect(rows[1]!.className).toContain("board-list__row--self");
  });

  test("a row says what it sent, not what it cleared", () => {
    // The clear names ARE the answer. A list that prints "tsd · tsd · tst"
    // gives away every solution to anyone who opens the panel, which is the
    // opposite of a gallery you step through.
    const made = createSolutionsPanel();
    made.show([line()] as never, "me", () => {});

    const score = rowsOf(made)[0]!.querySelector(".board-list__score")!.textContent ?? "";
    expect(score).toBe("4 atk · 1p");
    expect(score).not.toContain("tsd");
  });

  test("the first line is loaded without the caller asking", () => {
    // The board and the highlighted row cannot start out disagreeing, because
    // the same call puts them both there.
    const loaded: number[] = [];
    const made = createSolutionsPanel();
    made.show([line(), line({ solutionId: 2 })] as never, "me", (l) => loaded.push(l.solutionId));

    expect(loaded).toEqual([1]);
    expect(rowsOf(made)[0]!.className).toContain("solutions__row--on");
  });

  test("picking a line loads it and moves the marker", () => {
    const loaded: number[] = [];
    const made = createSolutionsPanel();
    made.show([line(), line({ solutionId: 2 })] as never, "me", (l) => loaded.push(l.solutionId));

    (rowsOf(made)[1] as HTMLButtonElement).click();

    expect(loaded).toEqual([1, 2]);
    const rows = rowsOf(made);
    expect(rows[0]!.className).not.toContain("solutions__row--on");
    expect(rows[1]!.className).toContain("solutions__row--on");
  });

  test("picking the line already showing does not reload the board", () => {
    // Stepping through a solution and clicking its own row would otherwise
    // throw the reader back to placement one.
    const loaded: number[] = [];
    const made = createSolutionsPanel();
    made.show([line(), line({ solutionId: 2 })] as never, "me", (l) => loaded.push(l.solutionId));

    (rowsOf(made)[0] as HTMLButtonElement).click();

    expect(loaded).toEqual([1]);
  });

  test("the card is a list and controls, with no prose between them", () => {
    // The rail is ~214px wide. Every sentence in here wrapped to two or three
    // lines and pushed the transport past the bottom of its own card, so the
    // card now carries only what it can show: the lines, and the controls.
    const many = createSolutionsPanel();
    many.show([line(), line({ solutionId: 2 })] as never, "me", () => {});

    expect(many.element.querySelectorAll(".solutions__row")).toHaveLength(2);
    expect(many.element.querySelector(".note")).toBeNull();
    expect(many.element.querySelector(".solutions__about")).toBeNull();
  });

  test("a gallery with lines always has step controls under it", () => {
    // The bug this pins: the panel was seeded with `show([])` and only filled
    // by a fetch, so between the two there were no controls — and permanently
    // none if the fetch failed. `show([])` legitimately clears the stepper,
    // which is why nothing may use it as an initialisation step.
    const made = createSolutionsPanel();
    made.show([line()] as never, "me", () => {});
    made.bind(fakePlayer(), () => {});

    // Five now, not three: the stepper became a transport with a play control
    // and jumps to either end. What this guards is unchanged — that binding a
    // gallery leaves controls under it rather than an empty slot.
    expect(made.element.querySelectorAll(".replay__transport button")).toHaveLength(4);
  });

  test("no lines at all leaves no rows and no controls", () => {
    const made = createSolutionsPanel();
    made.show([] as never, "me", () => {});

    expect(rowsOf(made)).toHaveLength(0);
    expect(made.element.querySelectorAll(".replay__transport button")).toHaveLength(0);
  });
});

describe("the solutions menu", () => {
  const PUZZLE = { id: 15, title: "protanopia", board: ["ggggggggg."], queue: ["T"], hold: null };

  const line = (over: Record<string, unknown> = {}) => ({
    solutionId: 1,
    placements: [{ piece: "T", cells: [[9, 0], [9, 1], [8, 1], [9, 2]], clear: null, attack: 0 }],
    attack: 4,
    clears: ["tsd"],
    source: "player",
    finder: { id: "ada", username: "Ada", avatarUrl: null },
    foundAt: 0,
    solvedStrict: true,
    ...over,
  });

  const menuWith = (lines: unknown[], opened: unknown[] = [], closed: string[] = []) => {
    const made = createSolutionsMenu(
      { onOpen: (l) => opened.push(l), onClose: () => closed.push("back") },
      () => 0,
    );
    made.update(PUZZLE as never, lines as never, "me");
    window.document.body.append(made.element as never);
    return made;
  };

  test("there is a way back to the puzzle, and it is the first control", () => {
    // Every other screen here puts its way out first, and a gallery you cannot
    // leave is the complaint this was built from.
    const closed: string[] = [];
    const made = menuWith([line()], [], closed);
    const first = made.element.querySelector(".solutions-menu__head button") as HTMLButtonElement;

    expect(first.textContent).toContain("Back to the puzzle");
    first.click();
    expect(closed).toEqual(["back"]);
  });

  test("each entry draws the board its line leaves behind", () => {
    // The preview is the point: two lines on one puzzle usually end
    // differently, and where they end is the fastest way to see that.
    const made = menuWith([line(), line({ solutionId: 2 })]);
    const entries = [...made.element.querySelectorAll(".solutions-menu__entry")];

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      const board = entry.querySelector(".solutions-menu__board");
      expect(board).not.toBeNull();
      expect(board!.querySelectorAll("rect").length).toBeGreaterThan(0);
    }
  });

  test("an entry carries who, when, what it sent and what it cleared", () => {
    const made = menuWith([line()]);
    const facts = made.element.querySelector(".solutions-menu__facts")!.textContent ?? "";

    expect(facts).toContain("Ada");
    expect(facts).toContain("today");
    expect(facts).toContain("4 attack");
    expect(facts).toContain("1 pieces");
    // Safe here and only here: this screen is reachable only by somebody who
    // has already solved the puzzle.
    expect(facts).toContain("tsd");
  });

  test("the maker's answer belongs to nobody and says so", () => {
    const made = menuWith([line({ source: "reference", finder: null })]);
    const facts = made.element.querySelector(".solutions-menu__facts")!.textContent ?? "";

    expect(facts).toContain("The maker's answer");
    expect(facts).toContain("shipped with the puzzle");
  });

  test("your own line is named as yours and marked", () => {
    const made = menuWith([line({ finder: { id: "me", username: "Me", avatarUrl: null } })]);
    const entry = made.element.querySelector(".solutions-menu__entry")!;

    expect(entry.querySelector(".solutions-menu__who")!.textContent).toBe("You");
    expect(entry.className).toContain("solutions-menu__entry--self");
  });

  test("a line that beat the target another way says which", () => {
    const made = menuWith([line({ solvedStrict: false })]);
    expect(made.element.querySelector(".solutions-menu__note")!.textContent).toBe(
      "beat the target another way",
    );
  });

  test("picking an entry hands that line back", () => {
    const opened: unknown[] = [];
    const made = menuWith([line(), line({ solutionId: 2 })], opened);

    (made.element.querySelectorAll(".solutions-menu__entry")[1] as HTMLButtonElement).click();

    expect((opened[0] as { solutionId: number }).solutionId).toBe(2);
  });

  test("no lines says so rather than drawing an empty grid", () => {
    const made = menuWith([]);
    expect(made.element.querySelectorAll(".solutions-menu__entry")).toHaveLength(0);
    expect(made.element.querySelector(".solutions-menu__count")!.textContent).toBe(
      "No solutions on file for this one.",
    );
  });

  test("previous versions open separately from the current gallery", () => {
    const opened: unknown[] = [];
    const version = {
      id: 9,
      changedAt: 1_700_000_000_000,
      contentHash: "old",
      puzzle: PUZZLE,
      lines: [line({ solutionId: 2 })],
    };
    const made = createSolutionsMenu(
      {
        onOpen: () => {},
        onVersion: (selected) => opened.push(selected),
        onClose: () => {},
      },
      () => 0,
    );
    made.update(PUZZLE as never, [line()] as never, "me", [version] as never);

    const history = made.element.querySelector(".solutions-menu__history-card")!;
    expect(history.textContent).toContain("Previous versions");
    (history.querySelector("button") as HTMLButtonElement).click();
    expect(opened[0]).toBe(version);
  });

  test("a previous version is labeled read-only", () => {
    const made = createSolutionsMenu({ onOpen: () => {}, onClose: () => {} }, () => 0);
    made.update(PUZZLE as never, [line()] as never, "me", [], true);

    expect(made.element.querySelector(".solutions-menu__title")!.textContent).toContain(
      "Previous version",
    );
    expect(made.element.textContent).toContain("kept for reference and no longer playable");
  });
});

describe("a wheel anywhere on a screen scrolls it", () => {
  /**
   * The complaint: scrolling worked over the day's sheets and nowhere else —
   * not over the yellow ground, not over the leaderboard, not over discoveries.
   *
   * Two separate causes, and both are cascade facts rather than layout, so
   * happy-dom can hold them even though it does no layout of its own.
   */
  const styleOf = (className: string) => {
    const node = window.document.createElement("div");
    node.className = className;
    window.document.body.append(node);
    return window.getComputedStyle(node as never);
  };

  test("the scroll region spans the ground rather than a column down the middle", () => {
    // It used to be `justify-self: center` at `min(--screen-width, 100%)`, so
    // every pixel either side of it had no scrollable ancestor at all and a
    // wheel over the yellow did nothing.
    const screen = styleOf("screen");
    expect(screen.width).toBe("100%");
    expect(screen.overflowY).toBe("auto");
  });

  test("and the cap moved onto what the screen holds, so it still reads centred", () => {
    const card = window.document.createElement("div");
    const screen = window.document.createElement("div");
    screen.className = "screen";
    screen.append(card);
    window.document.body.append(screen);

    expect(window.getComputedStyle(card as never).justifySelf).toBe("center");
    expect(window.getComputedStyle(card as never).maxWidth).not.toBe("none");
  });

  test("a rail that cannot scroll passes the wheel on instead of eating it", () => {
    // `overscroll-behavior: contain` blocks scroll chaining even when the
    // element has nothing to scroll — which is why the leaderboard and the
    // discoveries card, neither of which usually overflows, swallowed it.
    expect(styleOf("rail").overscrollBehavior).not.toBe("contain");
  });

  test("nor does the screen itself refuse what a rail passes up", () => {
    expect(styleOf("screen").overscrollBehavior).not.toBe("contain");
  });
});

describe("a player's picture", () => {
  const STATS = {
    player: { id: "ada", username: "Ada", avatarUrl: "https://local.test/avatar.png" },
    puzzlesCleared: 3, clearsTotal: 5, bestMsTotal: 9_000,
    rushSolved: 2, rushRuns: 1, bestRush: 2, discoveries: 0,
    archiveSize: 138, streak: 1, daysSolved: 1,
  };

  test("the monogram is drawn whether or not there is a picture", () => {
    // It is the floor, not a placeholder: avatars live on an external host and
    // an activity only reaches what Discord's URL mapping allows.
    const withPicture = playerAvatar(STATS.player as never);
    const without = playerAvatar({ id: "b", username: "bo", avatarUrl: null } as never);

    expect(withPicture.querySelector(".avatar__monogram")!.textContent).toBe("A");
    expect(without.querySelector(".avatar__monogram")!.textContent).toBe("B");
    expect(without.querySelector(".avatar__image") === null).toBe(true);
  });

  test("a picture that fails to load takes itself away", () => {
    // Removed rather than hidden: a broken <img> keeps its broken state, and
    // some browsers draw an icon in it regardless of opacity.
    const made = playerAvatar(STATS.player as never);
    const image = made.querySelector(".avatar__image") as HTMLElement;
    expect(image === null).toBe(false);

    image.dispatchEvent(new window.Event("error") as never);

    expect(made.querySelector(".avatar__image") === null).toBe(true);
    expect(made.querySelector(".avatar__monogram")!.textContent).toBe("A");
  });

  test("a name starting with an astral character keeps the whole character", () => {
    // `name[0]` would take half a surrogate pair and draw a replacement box.
    const made = playerAvatar({ id: "c", username: "😀nes", avatarUrl: null } as never);
    expect(made.querySelector(".avatar__monogram")!.textContent).toBe("😀");
  });

  test("the profile shows the picture of whoever it is about", () => {
    const made = createProfile();
    made.update(STATS as never);

    const portrait = made.element.querySelector(".profile__portrait .avatar");
    expect(portrait === null).toBe(false);
    expect(portrait!.querySelector(".avatar__monogram")!.textContent).toBe("A");
    expect(made.element.querySelector(".profile__name")!.textContent).toBe("Ada");
  });
});

describe("reading a solution back", () => {
  const THREE = [
    { piece: "T", cells: [], clear: null, attack: 0 },
    { piece: "I", cells: [], clear: "quad", attack: 4 },
    { piece: "O", cells: [], clear: null, attack: 0 },
  ];

  const bound = (steps = THREE) => {
    const made = createSolutionsPanel();
    const player = fakePlayer(steps as never);
    window.document.body.append(made.element as never);
    made.bind(player, () => {});
    return { made, player };
  };

  test("the timeline has one tick per placement", () => {
    // The whole point: a picture of the solution's length before you have
    // watched any of it. "2 / 3" told you neither how long nor where.
    const { made } = bound();
    expect(made.element.querySelectorAll(".replay__tick")).toHaveLength(3);
  });

  test("a placement that clears lines is marked on its tick", () => {
    // On a long solve the marks are the shape of the answer.
    const { made } = bound();
    const marked = [...made.element.querySelectorAll(".replay__tick--clears")];
    expect(marked).toHaveLength(1);
    expect([...made.element.querySelectorAll(".replay__tick")].indexOf(marked[0]!)).toBe(1);
  });

  test("clicking a tick seeks straight to it", () => {
    const { made, player } = bound();
    (made.element.querySelectorAll(".replay__tick")[2] as HTMLButtonElement).click();

    expect((player as unknown as { position: number }).position).toBe(2);
    expect(made.element.querySelector(".replay__position")!.textContent).toBe("3 / 3");
  });

  test("the transport steps, and jumps to either end", () => {
    const { made, player } = bound();
    const at = () => (player as unknown as { position: number }).position;
    const press = (label: string) =>
      ([...made.element.querySelectorAll(".replay__transport button")] as HTMLButtonElement[])
        .find((b) => b.textContent === label)!
        .click();

    press("⏭");
    expect(at()).toBe(3);
    press("⏮");
    expect(at()).toBe(0);
    press("▶");
    expect(at()).toBe(1);
    press("◀");
    expect(at()).toBe(0);
  });

  test("the arrow keys step it, because both hands are already there", () => {
    const { made, player } = bound();
    const at = () => (player as unknown as { position: number }).position;

    window.document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight" }) as never,
    );
    expect(at()).toBe(1);
    window.document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowLeft" }) as never,
    );
    expect(at()).toBe(0);
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End" }) as never);
    expect(at()).toBe(3);
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home" }) as never);
    expect(at()).toBe(0);

    made.detach();
  });

  test("it does not steal a key from a field being typed in", () => {
    const { made, player } = bound();
    const field = window.document.createElement("input");
    window.document.body.append(field);

    field.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as never,
    );

    expect((player as unknown as { position: number }).position).toBe(0);
    field.remove();
    made.detach();
  });

  test("and gives the keyboard back once it is off screen", () => {
    // The rail is replaced out from under this on every screen change and
    // nothing calls detach on the way, so the listener has to notice itself.
    const { made, player } = bound();
    made.element.remove();

    window.document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight" }) as never,
    );

    expect((player as unknown as { position: number }).position).toBe(0);
  });
});

describe("what the critique found", () => {
  const THREE = [
    { piece: "T", cells: [], clear: null, attack: 0 },
    { piece: "I", cells: [], clear: "quad", attack: 4 },
    { piece: "O", cells: [], clear: null, attack: 0 },
  ];
  const boundReplay = (steps = THREE) => {
    const made = createSolutionsPanel();
    const player = fakePlayer(steps as never);
    window.document.body.append(made.element as never);
    made.bind(player, () => {});
    const at = () => (player as unknown as { position: number }).position;
    return { made, player, at };
  };

  test("the last placement and the finished board read differently", () => {
    // Pressing ▶ on the final piece is the most consequential step in a replay
    // and it used to print "3 / 3" before and after, so it looked like a no-op.
    const { made, player } = boundReplay();
    (player as unknown as { seek: (n: number) => void }).seek(2);
    made.bind(player as never, () => {});
    expect(made.element.querySelector(".replay__position")!.textContent).toBe("3 / 3");

    (player as unknown as { end: () => void }).end();
    made.bind(player as never, () => {});
    expect(made.element.querySelector(".replay__position")!.textContent).toContain("done");
  });

  test("the timeline is one row however long the solution is", () => {
    // The rail is minmax(158px, 214px). The old `repeat(auto-fit, minmax(6px,
    // 1fr))` capped it near 23 columns, so a 73-placement solve wrapped into a
    // block of squares. A timeline that wraps is not a timeline.
    const { made } = boundReplay(
      Array.from({ length: 73 }, (_, i) => ({ piece: "T", cells: [], clear: null, attack: i })),
    );
    const track = made.element.querySelector(".replay__track")!;

    expect(track.querySelectorAll(".replay__tick")).toHaveLength(73);
    const style = window.getComputedStyle(track as never);
    expect(style.gridAutoFlow).toContain("column");
  });

  test("a clearing placement is marked by height, which survives a thin tick", () => {
    // The mark used to be a 2px border on a tick about 1px wide at that length
    // — invisible at exactly the length it was the whole argument for.
    const { made } = boundReplay();
    const clearing = made.element.querySelectorAll(".replay__tick")[1]!;
    expect(clearing.className).toContain("replay__tick--clears");
    expect(window.getComputedStyle(clearing as never).height).toBe("18px");
  });

  test("keys stand down while a dialog is open over the board", () => {
    // The settings sheet is a sibling of the deck, not a screen, so it leaves
    // this mounted and these keys live underneath it.
    const { made, at } = boundReplay();
    const dialog = window.document.createElement("div");
    dialog.setAttribute("role", "dialog");
    window.document.body.append(dialog);

    window.document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight" }) as never,
    );
    expect(at()).toBe(0);

    dialog.remove();
    window.document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight" }) as never,
    );
    expect(at()).toBe(1);
    made.detach();
  });
});

describe("the replay card fits the rail it lives in", () => {
  const THREE = [
    { piece: "T", cells: [], clear: null, attack: 0 },
    { piece: "I", cells: [], clear: "quad", attack: 4 },
    { piece: "O", cells: [], clear: null, attack: 0 },
  ];

  test("all four transport controls sit on one row", () => {
    // The rail is minmax(158px, 214px). As a wrapping flex row the last control
    // fell to a second line on its own, reading as a sixth button somebody
    // forgot to align.
    const made = createSolutionsPanel();
    window.document.body.append(made.element as never);
    made.bind(fakePlayer(THREE as never), () => {});

    const transport = made.element.querySelector(".replay__transport")!;
    expect(transport.querySelectorAll("button")).toHaveLength(4);
    const style = window.getComputedStyle(transport as never);
    expect(style.display).toBe("grid");
    expect(style.gridTemplateColumns).toContain("repeat(4");
  });

  test("the end of a solution is said once, not twice", () => {
    const made = createSolutionsPanel();
    const player = fakePlayer(THREE as never);
    window.document.body.append(made.element as never);
    (player as unknown as { end: () => void }).end();
    made.bind(player, () => {});

    expect(made.element.querySelector(".replay__position")!.textContent).toBe("done");
    // The caption used to print "done" as well, so the rail read "done" twice
    // side by side.
    expect(made.element.querySelector(".replay__caption")!.textContent).not.toContain("done");
  });

  test("the reading screen does not inherit the gallery's list", () => {
    // One long-lived panel serves both paths. A reader who came through the
    // post-run gallery used to see "One solution on file" one click after the
    // menu told them there were four.
    const made = createSolutionsPanel();
    window.document.body.append(made.element as never);
    made.show(
      [
        {
          solutionId: 1, placements: [], attack: 4, clears: [],
          source: "reference", finder: null, foundAt: 0, solvedStrict: true,
        },
      ] as never,
      "me",
      () => {},
    );
    expect(made.element.querySelectorAll(".solutions__row")).toHaveLength(1);

    made.readingOnly();

    expect(made.element.querySelectorAll(".solutions__row")).toHaveLength(0);
  });
});

describe("the solutions card in a short frame", () => {
  test("it is never shrunk past its own controls", () => {
    // `.rail > .panel:has(.board-list) { min-height: 0 }` is written for a
    // leaderboard, whose list scrolls inside itself. This card also holds a
    // `.board-list`, so it was caught by the same selector — and most of its
    // height is a timeline and a transport, which cannot scroll and cannot
    // shrink. In a short Discord frame the buttons drew outside the cream box.
    const rail = window.document.createElement("div");
    rail.className = "rail";
    const made = createSolutionsPanel();
    rail.append(made.element as never);
    window.document.body.append(rail);
    made.bind(fakePlayer(), () => {});

    const style = window.getComputedStyle(made.element as never);
    expect(style.minHeight).toBe("auto");
    expect(style.flexGrow).toBe("0");
    expect(style.flexShrink).toBe("0");
  });
});

describe("the leaderboards page", () => {
  const P = (id: string, username: string) => ({ id, username, avatarUrl: null });
  const CATEGORIES = [
    {
      key: "today", label: "Today", scope: "server", measure: "solved",
      entries: [
        { player: P("ada", "Ada"), value: 3, detailMs: 61_500 },
        { player: P("me", "Me"), value: 1, detailMs: 9_000 },
      ],
    },
    {
      key: "solved", label: "Archive", scope: "everyone", measure: "puzzles",
      entries: [{ player: P("bo", "Bo"), value: 41, detail: "of 138" }],
    },
    { key: "empty", label: "Discoveries", scope: "everyone", measure: "lines", entries: [] },
  ];

  const page = (opened: string[] = []) => {
    const made = createLeaderboards({ onPlayer: (id) => opened.push(id) });
    window.document.body.append(made.element as never);
    made.update(CATEGORIES as never, "me");
    return made;
  };

  test("every category is a tab, and the first is showing", () => {
    const made = page();
    const tabs = [...made.element.querySelectorAll(".boards__tabs button")];
    expect(tabs.map((t) => t.textContent)).toEqual(["Today", "Archive", "Discoveries"]);
    expect(tabs[0]!.className).toContain("btn--primary");
  });

  test("switching tab swaps the list without reloading the page", () => {
    // The point of tabs over screens: what a reader does here is compare.
    const made = page();
    expect(made.element.querySelectorAll(".boards__row")).toHaveLength(2);

    ([...made.element.querySelectorAll(".boards__tabs button")] as HTMLButtonElement[])[1]!.click();

    const rows = [...made.element.querySelectorAll(".boards__row")];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector(".board-list__name")!.textContent).toBe("Bo");
  });

  test("a row says what its number counts, and pluralises", () => {
    const made = page();
    const scores = [...made.element.querySelectorAll(".board-list__score")].map((n) => n.textContent);
    expect(scores).toEqual(["3 solved", "1 solved"]);

    ([...made.element.querySelectorAll(".boards__tabs button")] as HTMLButtonElement[])[1]!.click();
    expect(made.element.querySelector(".board-list__score")!.textContent).toBe("41 puzzles");
  });

  test("a duration is formatted by the client, not shipped as text", () => {
    const made = page();
    expect(made.element.querySelector(".boards__detail")!.textContent).toBe("1:01.5");
  });

  test("the scope is printed, because it is the first thing asked", () => {
    // Two of these boards are this server's and three are everybody's. "Why am
    // I not on this" is the question a reader has.
    const made = page();
    expect(made.element.querySelector(".boards__scope")!.textContent).toBe("This server");

    ([...made.element.querySelectorAll(".boards__tabs button")] as HTMLButtonElement[])[1]!.click();
    expect(made.element.querySelector(".boards__scope")!.textContent).toBe("Everyone, all time");
  });

  test("your own row is marked", () => {
    const made = page();
    const rows = [...made.element.querySelectorAll(".boards__row")];
    expect(rows[0]!.className).not.toContain("board-list__row--self");
    expect(rows[1]!.className).toContain("board-list__row--self");
  });

  test("clicking a name opens that player", () => {
    // A leaderboard whose names cannot be opened is a list of strangers.
    const opened: string[] = [];
    const made = page(opened);
    (made.element.querySelectorAll(".boards__row")[0] as HTMLButtonElement).click();
    expect(opened).toEqual(["ada"]);
  });

  test("an empty board invites rather than showing nothing", () => {
    const made = page();
    ([...made.element.querySelectorAll(".boards__tabs button")] as HTMLButtonElement[])[2]!.click();
    expect(made.element.querySelectorAll(".boards__row")).toHaveLength(0);
    expect(made.element.querySelector(".boards__list .note")!.textContent).toBe(
      "Nobody is on this one yet. Be first.",
    );
  });

  test("a refresh keeps the reader on the board they were reading", () => {
    const made = page();
    ([...made.element.querySelectorAll(".boards__tabs button")] as HTMLButtonElement[])[1]!.click();
    made.update(CATEGORIES as never, "me");
    expect(made.element.querySelector(".boards__scope")!.textContent).toBe("Everyone, all time");
  });
});

describe("somebody else's profile", () => {
  const STATS = (isSelf: boolean) => ({
    player: { id: isSelf ? "me" : "ada", username: isSelf ? "Me" : "Ada", avatarUrl: null },
    isSelf,
    puzzlesCleared: 0, clearsTotal: 0, bestMsTotal: 0,
    rushSolved: 0, rushRuns: 0, bestRush: 0, discoveries: 0,
    archiveSize: 138, streak: 0, daysSolved: 0,
  });

  test("gets a way back to the board it was opened from", () => {
    const made = createProfile();
    const back: string[] = [];
    made.update(STATS(false) as never, () => back.push("back"));

    const button = made.element.querySelector(".profile__back button") as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.click();
    expect(back).toEqual(["back"]);
  });

  test("your own does not, because you did not arrive from one", () => {
    const made = createProfile();
    made.update(STATS(true) as never, () => {});
    expect(made.element.querySelector(".profile__back button") === null).toBe(true);
  });

  test("an empty record does not tell a stranger to go and solve something", () => {
    const mine = createProfile();
    mine.update(STATS(true) as never);
    expect(mine.element.querySelector(".profile__note")!.textContent).toContain("Solve anything");

    const theirs = createProfile();
    theirs.update(STATS(false) as never, () => {});
    expect(theirs.element.querySelector(".profile__note")!.textContent).toBe("No record yet.");
  });
});

describe("a leaderboard row lays out as one row", () => {
  test("its five columns beat the three-column base rule", () => {
    // `.board-list__row` in overlays.css sets three columns and overlays.css
    // loads after panels.css, so a single-class selector lost to it and the
    // last two children wrapped onto an implicit second row — which is how the
    // score came to be printed over the time.
    const made = createLeaderboards({ onPlayer: () => {} });
    window.document.body.append(made.element as never);
    made.update(
      [
        {
          key: "today", label: "Today", scope: "server", measure: "solved",
          entries: [
            {
              player: { id: "ada", username: "Ada", avatarUrl: null },
              value: 3,
              detailMs: 61_500,
            },
          ],
        },
      ] as never,
      "me",
    );

    const row = made.element.querySelector(".boards__row")!;
    // Five children: rank, face, name, detail, score.
    expect(row.children).toHaveLength(5);
    // The declared template, not a split on spaces — `minmax(0, 1fr)` has a
    // space in it and would inflate any naive count.
    const columns = window.getComputedStyle(row as never).gridTemplateColumns;
    expect(columns).toContain("minmax(0, 1fr)");
    expect(columns.startsWith("20px auto")).toBe(true);
    expect(columns.endsWith("auto auto")).toBe(true);
  });
});

describe("the lines on a profile", () => {
  const base = {
    player: { id: "ada", username: "Ada", avatarUrl: null },
    isSelf: false,
    puzzlesCleared: 2, clearsTotal: 2, bestMsTotal: 9_000,
    rushSolved: 0, rushRuns: 0, bestRush: 0, discoveries: 3,
    archiveSize: 138, streak: 0, daysSolved: 1,
  };
  const found = (over: Record<string, unknown> = {}) => ({
    puzzleId: 92, title: "nah sli'd win", attack: 18, clears: ["tsd"],
    foundAt: Date.now(), voided: false, openable: true, ...over,
  });
  const page = (lines: unknown[], opened: number[] = []) => {
    const made = createProfile();
    window.document.body.append(made.element as never);
    made.update({ ...base, found: lines } as never, () => {}, (id) => opened.push(id));
    return made;
  };

  test("each line names the puzzle it was found on", () => {
    const made = page([found()]);
    const row = made.element.querySelector(".profile__found-row")!;
    expect(row.querySelector(".board-list__name")!.textContent).toBe("#92 nah sli'd win");
    expect(row.querySelector(".board-list__score")!.textContent).toBe("18 atk");
    expect(row.querySelector(".profile__found-when")!.textContent).toBe("today");
  });

  test("a line the reader may read is a control; one they may not is not", () => {
    // A button that refuses when pressed is worse than a row that never
    // offered. The gate is the reader's own solve, not the finder's.
    const open = page([found()]).element.querySelector(".profile__found-row")!;
    expect(open.tagName).toBe("BUTTON");

    const shut = page([found({ openable: false })]).element.querySelector(".profile__found-row")!;
    expect(shut.tagName).toBe("DIV");
    expect(shut.getAttribute("title")).toBe("solve it yourself to read it");
  });

  test("a line whose board was edited says why it cannot be opened", () => {
    const row = page([found({ openable: false, voided: true })]).element.querySelector(
      ".profile__found-row",
    )!;
    expect(row.getAttribute("title")).toBe("that board has been edited since");
  });

  test("opening a line asks for that puzzle's solutions", () => {
    const opened: number[] = [];
    const made = page([found()], opened);
    (made.element.querySelector(".profile__found-row") as HTMLButtonElement).click();
    expect(opened).toEqual([92]);
  });

  test("a player who has found nothing gets no card at all", () => {
    // An empty box under a zero says the same nothing twice.
    const made = page([]);
    expect((made.element.querySelector(".profile__found-card") as HTMLElement).hidden).toBe(true);
  });
});

describe("a screen that waits on the network", () => {
  test("the boards page says something before any data arrives", () => {
    // It is mounted on the click and filled on the response, so this is what
    // stands in for the round trip.
    const made = createLeaderboards({ onPlayer: () => {} });
    window.document.body.append(made.element as never);

    expect(made.hasData).toBe(false);
    expect(made.element.querySelector(".boards__scope")!.textContent).toBe("Reading the boards…");
  });

  test("and keeps the boards it has while the next ones are fetched", () => {
    // The same five boards either way: showing yesterday's number briefly beats
    // showing nothing.
    const made = createLeaderboards({ onPlayer: () => {} });
    made.update(
      [
        {
          key: "today", label: "Today", scope: "server", measure: "solved",
          entries: [{ player: { id: "ada", username: "Ada", avatarUrl: null }, value: 1 }],
        },
      ] as never,
      "me",
    );
    expect(made.hasData).toBe(true);
    expect(made.element.querySelectorAll(".boards__row")).toHaveLength(1);
  });

  test("a profile blanks itself instead, because its subject changes", () => {
    // Leaving somebody else's numbers under a new name would be a lie rather
    // than merely stale.
    const made = createProfile();
    made.update(
      {
        player: { id: "ada", username: "Ada", avatarUrl: null }, isSelf: false,
        puzzlesCleared: 9, clearsTotal: 9, bestMsTotal: 1, rushSolved: 0,
        rushRuns: 0, bestRush: 0, discoveries: 0, archiveSize: 138,
        streak: 0, daysSolved: 0,
      } as never,
      () => {},
    );
    expect(made.element.querySelector(".profile__name")!.textContent).toBe("Ada");

    made.loading();

    expect(made.element.querySelector(".profile__name")!.textContent).toBe("");
    expect(made.element.querySelector(".profile__stats")!.textContent).toBe("");
    expect(made.element.querySelector(".profile__note")!.textContent).toBe("Reading…");
  });
});

describe("today's four, on the boards page", () => {
  const DAILY = {
    tiers: [
      { tier: "easy", filed: 18, solved: 15, you: "solved" },
      { tier: "medium", filed: 12, solved: 6, you: "missed" },
      { tier: "hard", filed: 7, solved: 1, you: "none" },
      { tier: "extreme", filed: 0, solved: 0, you: "none" },
    ],
    standing: { rank: 7, of: 52, solved: 1, totalMs: 61_500 },
  };
  const CATS = [
    { key: "today", label: "Today", scope: "server", measure: "solved", entries: [] },
    { key: "solved", label: "Archive", scope: "everyone", measure: "puzzles", entries: [] },
  ];
  const page = (daily: unknown = DAILY) => {
    const made = createLeaderboards({ onPlayer: () => {} });
    window.document.body.append(made.element as never);
    made.update(CATS as never, "me", daily as never);
    return made;
  };

  test("one row per tier, counted rather than rated", () => {
    // One solve out of one hand-in is a hundred per cent, and this board is a
    // single Discord server most of the time.
    const made = page();
    const counts = [...made.element.querySelectorAll(".boards__tier-count")].map((n) => n.textContent);
    expect(counts).toEqual(["15 of 18", "6 of 12", "1 of 7", "nobody yet"]);
  });

  test("the bar is the solve rate, and an untouched tier draws none", () => {
    const made = page();
    const widths = [...made.element.querySelectorAll(".boards__bar-fill")].map(
      (n) => (n as HTMLElement).style.width,
    );
    expect(widths[0]).toBe("83%");
    expect(widths[3]).toBe("0%");
  });

  test("it says what you did on each tier", () => {
    const made = page();
    const yours = [...made.element.querySelectorAll(".boards__tier-you")].map((n) => n.textContent);
    expect(yours).toEqual(["you solved it", "you missed it", "", ""]);
  });

  test("and where you stand, because the list below is only the top 25", () => {
    const made = page();
    const note = made.element.querySelector(".boards__day-note")!.textContent ?? "";
    expect(note).toContain("You are 7th of 52 today");
    // The caveat, because a reader will otherwise take "filed" for "played".
    expect(note).toContain("hand-ins");
  });

  test("somebody who has filed nothing is told so, not ranked zeroth", () => {
    const made = page({ ...DAILY, standing: null });
    expect(made.element.querySelector(".boards__day-note")!.textContent).toContain(
      "not filed anything today",
    );
  });

  test("it is hidden on the boards that have no today", () => {
    // Archive, Discoveries and the rush records are all-time or another mode.
    const made = page();
    expect((made.element.querySelector(".boards__day-card") as HTMLElement).hidden).toBe(false);

    ([...made.element.querySelectorAll(".boards__tabs button")] as HTMLButtonElement[])[1]!.click();

    expect((made.element.querySelector(".boards__day-card") as HTMLElement).hidden).toBe(true);
  });
});

describe("the leaderboard on the front door", () => {
  test("the whole card opens every board, by click and by key", () => {
    // A card that lists the day's top few and cannot be opened is a dead end,
    // and the page it leads to carries seven boards this one is a slice of.
    const opened: string[] = [];
    const made = createDailyBoard(() => opened.push("open"));
    window.document.body.append(made.element as never);

    expect(made.element.getAttribute("role")).toBe("button");
    expect(made.element.getAttribute("tabindex")).toBe("0");

    (made.element as HTMLElement).click();
    expect(opened).toEqual(["open"]);

    // The two keys a role="button" is required to answer to.
    made.element.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }) as never);
    made.element.dispatchEvent(new window.KeyboardEvent("keydown", { key: " " }) as never);
    expect(opened).toHaveLength(3);
  });

  test("and ignores keys that are not those two", () => {
    const opened: string[] = [];
    const made = createDailyBoard(() => opened.push("open"));
    window.document.body.append(made.element as never);

    made.element.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a" }) as never);
    expect(opened).toEqual([]);
  });

  test("without a handler it is not a control at all", () => {
    // The review tool builds this board too, where there is nowhere to go.
    const made = createDailyBoard();
    expect(made.element.getAttribute("role") === null).toBe(true);
    expect(made.element.className).not.toContain("panel--opens");
  });
});
