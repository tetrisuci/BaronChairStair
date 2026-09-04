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
import { createDailyMenu } from "../client/src/ui/daily-tiers";
import { withRush } from "../client/src/ui/daily-board";
import { createRushResultCard } from "../client/src/ui/rush";
import { createBuilder } from "../client/src/ui/builder";
import { createStartedPuzzles } from "../client/src/started";
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

  const style = window.document.createElement("style");
  style.textContent = readFileSync("client/src/styles/panels.css", "utf8");
  window.document.head.append(style);
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

describe("the day's chooser", () => {
  const entry = (tier: string, id: number, solved: boolean | null) => ({
    tier,
    puzzle: {
      id,
      title: `sheet ${id}`,
      author: "satilea",
      difficulty: id,
      goal: "Clear 1 TSD",
      queue: ["T", "O", "S", "Z"],
      hold: null,
    },
    run: solved === null ? null : { solved },
    solution: null,
  });

  const menu = (entries: unknown[], started: readonly number[] = []) => {
    const made = createDailyMenu(() => {});
    window.document.body.append(made.element as never);
    made.update(245, entries as never, new Set(started));
    return made;
  };

  test("shows all three, with what the choice actually turns on", () => {
    const made = menu([entry("easy", 2, true), entry("medium", 6, false), entry("hard", 11, null)]);
    const rows = [...made.element.querySelectorAll(".explore__item")];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector(".explore__id")!.textContent)).toEqual([
      "Easy",
      "Medium",
      "Hard",
    ]);
    // A filed miss and an untouched puzzle are different things, and the row is
    // the only place a player can tell them apart before opening one.
    const meta = rows.map((row) => row.querySelector(".explore__meta")!.textContent);
    expect(meta[0]).toContain("solved");
    expect(meta[1]).toContain("filed, not solved");
    expect(meta[2]).toContain("not played");
    // The length is part of the decision, so it is on the row.
    expect(meta[0]).toContain("4 pieces");
  });

  test("a puzzle the player has opened reads as started, not as untouched", () => {
    // A daily run only reaches the server when it solves, so a puzzle somebody
    // is halfway through has no run on it and used to read exactly like one
    // they had never seen — on a screen they had just walked back from it to.
    const rows = [
      ...menu(
        [entry("easy", 2, null), entry("medium", 6, null), entry("hard", 11, null)],
        [6],
      ).element.querySelectorAll(".explore__meta"),
    ].map((meta) => meta.textContent);

    expect(rows[0]).toContain("not played");
    expect(rows[1]).toContain("started");
    expect(rows[1]).not.toContain("not played");
    expect(rows[2]).toContain("not played");
  });

  test("a filed run outranks having started it", () => {
    // Solving one does not stop it having been opened, and the row has room
    // for one word: the one that says how it ended.
    const rows = [
      ...menu(
        [entry("easy", 2, true), entry("medium", 6, false), entry("hard", 11, null)],
        [2, 6, 11],
      ).element.querySelectorAll(".explore__meta"),
    ].map((meta) => meta.textContent);

    expect(rows[0]).toContain("solved");
    expect(rows[1]).toContain("filed, not solved");
    expect(rows[2]).toContain("started");
  });

  test("says how the day is going without making you count", () => {
    expect(
      menu([entry("easy", 2, true), entry("medium", 6, null), entry("hard", 11, null)]).element
        .querySelector(".explore__count")!.textContent,
    ).toContain("1 of 3 solved");
    expect(
      menu([entry("easy", 2, true), entry("medium", 6, true), entry("hard", 11, true)]).element
        .querySelector(".explore__count")!.textContent,
    ).toContain("All three done");
    // Any one of them keeps the streak, and a beginner should be told so.
    expect(
      menu([entry("easy", 2, null), entry("medium", 6, null), entry("hard", 11, null)]).element
        .querySelector(".explore__count")!.textContent,
    ).toContain("keeps your streak");
  });

  test("a row opens its own tier, not the one it sits at", () => {
    const picked: string[] = [];
    const made = createDailyMenu((tier) => picked.push(tier));
    window.document.body.append(made.element as never);
    made.update(
      245,
      [entry("easy", 2, null), entry("medium", 6, null), entry("hard", 11, null)] as never,
      new Set(),
    );
    const rows = [...made.element.querySelectorAll(".explore__item")];
    (rows[2] as unknown as HTMLElement).click();
    expect(picked).toEqual(["hard"]);
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
