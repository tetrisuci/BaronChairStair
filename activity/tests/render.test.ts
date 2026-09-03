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
import { mergeBoards } from "../client/src/ui/daily-board";
import { createRushResultCard } from "../client/src/ui/rush";
import type { RushPlayed } from "../client/src/api";

let window: Window;
const saved = {
  document: globalThis.document,
  getComputedStyle: globalThis.getComputedStyle,
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

  const style = window.document.createElement("style");
  style.textContent = readFileSync("client/src/styles/panels.css", "utf8");
  window.document.head.append(style);
});

afterAll(() => {
  globalThis.document = saved.document;
  globalThis.getComputedStyle = saved.getComputedStyle;
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
  const sessions = { daily: "daily-run", rush: "rush-run", duel: "duel-run" };

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

  const menu = (entries: unknown[]) => {
    const made = createDailyMenu(() => {});
    window.document.body.append(made.element as never);
    made.update(245, entries as never);
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
    made.update(245, [
      entry("easy", 2, null),
      entry("medium", 6, null),
      entry("hard", 11, null),
    ] as never);
    const rows = [...made.element.querySelectorAll(".explore__item")];
    (rows[2] as unknown as HTMLElement).click();
    expect(picked).toEqual(["hard"]);
  });
});

describe("the day's one leaderboard", () => {
  const run = (id: string, solved: boolean, totalMs: number) =>
    ({ player: { id, username: id, avatarUrl: null }, solved, totalMs }) as never;

  const boards = [
    { tier: "easy" as const, entries: [run("ada", true, 1000), run("bo", true, 500)] },
    { tier: "medium" as const, entries: [run("ada", true, 2000)] },
    { tier: "hard" as const, entries: [run("ada", false, 0), run("cy", true, 100)] },
  ];

  test("puts each player on one row, however many boards they are on", () => {
    // ada appears on all three and comes back once. The order is the ranking,
    // not the order they were merged in: two solves, then the faster of the two
    // who managed one.
    const rows = mergeBoards(boards);
    expect(rows.map((row) => row.id)).toEqual(["ada", "cy", "bo"]);
  });

  test("ranks by solves first, so a fast single solve does not lead", () => {
    // bo and cy each solved one, faster than ada solved two. Sorting on time
    // alone would put them above her — and would put somebody who solved
    // nothing, on a total of zero, above everybody.
    const rows = mergeBoards(boards);
    expect(rows[0]!.id).toBe("ada");
    expect(rows[0]!.solved).toBe(2);
    expect(rows[0]!.totalMs).toBe(3000);
    // Between the two who solved one, the faster one leads.
    expect(rows[1]!.id).toBe("cy");
  });

  test("counts only the time of the puzzles actually solved", () => {
    // ada filed the hard one and failed it; that attempt is not time she spent
    // getting to a solve and must not be added to her total.
    expect(mergeBoards(boards)[0]!.totalMs).toBe(3000);
  });

  test("remembers what was tried and failed, apart from what was never opened", () => {
    const ada = mergeBoards(boards)[0]!;
    expect(ada.marks.hard).toBe(false);
    const cy = mergeBoards(boards).find((row) => row.id === "cy")!;
    expect("easy" in cy.marks).toBe(false);
  });

  test("two players with the same name stay two players", () => {
    const sameName = [
      {
        tier: "easy" as const,
        entries: [
          { player: { id: "1", username: "guest", avatarUrl: null }, solved: true, totalMs: 1 },
          { player: { id: "2", username: "guest", avatarUrl: null }, solved: true, totalMs: 2 },
        ] as never,
      },
    ];
    expect(mergeBoards(sameName)).toHaveLength(2);
  });
});

describe("rush on the day's board", () => {
  const run = (id: string, solved: boolean, totalMs: number) =>
    ({ player: { id, username: id, avatarUrl: null }, solved, totalMs }) as never;
  const rushRun = (id: string, solved: number) =>
    ({ player: { id, username: id, avatarUrl: null }, solved }) as never;

  const boards = [{ tier: "easy" as const, entries: [run("ada", true, 1000)] }];

  test("puts a rush-only player on the board", () => {
    // Somebody who spent their day on rush did not do nothing, and the daily
    // boards have no row for them at all.
    const rows = mergeBoards(boards, [rushRun("bo", 7)]);
    expect(rows.map((row) => row.id).sort()).toEqual(["ada", "bo"]);
    expect(rows.find((row) => row.id === "bo")!.solved).toBe(0);
  });

  test("a rush of zero is not the same as no rush at all", () => {
    // null is the blank. Zero means they ran one and cleared nothing, which is
    // a different day and should read differently.
    const [ran] = mergeBoards([], [rushRun("bo", 0)]);
    expect(ran!.rush).toBe(0);
    const [never] = mergeBoards(boards, []);
    expect(never!.rush).toBeNull();
  });

  test("the daily still decides the order, with rush breaking ties", () => {
    // Not added together: three puzzles chosen for you and as many as you can
    // take in five minutes are not the same unit.
    const rows = mergeBoards(boards, [rushRun("bo", 40)]);
    expect(rows[0]!.id).toBe("ada");

    const tied = mergeBoards(
      [{ tier: "easy" as const, entries: [run("cy", true, 500), run("di", true, 500)] }],
      [rushRun("di", 9)],
    );
    expect(tied[0]!.id).toBe("di");
  });

  test("keeps the best rush when a player ran more than one", () => {
    // Replays are unlimited and unscored, but the board should show the best
    // of them rather than whichever came back last.
    const [row] = mergeBoards([], [rushRun("ada", 3), rushRun("ada", 8), rushRun("ada", 5)]);
    expect(row!.rush).toBe(8);
  });
});
