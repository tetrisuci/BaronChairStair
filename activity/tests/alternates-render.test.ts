/**
 * Explore's second tab: every alternate solution, across every puzzle.
 *
 * In `render.test.ts`'s style — a happy-dom document with the real stylesheets
 * cascaded into it — and in a file of its own, because that one is past two
 * thousand lines and its own header explains what a growing tree costs it.
 *
 * What is pinned: a row says which puzzle, who, when, and (only once the
 * reader has solved that puzzle) what the line did; a row the reader may not
 * open is visibly shut and says why; the sort and its direction reorder the
 * rows; and the two tabs swap one pane for the other.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { createAlternates } from "../client/src/ui/alternates";
import { createExploreTabs } from "../client/src/ui/explore-tabs";
import { ago } from "../client/src/ui/ago";
import type { AlternateRow } from "../client/src/api";

let window: Window;
const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };

beforeAll(() => {
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
  globalThis.getComputedStyle = window.getComputedStyle.bind(
    window,
  ) as unknown as typeof getComputedStyle;
  for (const sheet of [
    "client/src/styles/panels.css",
    "client/src/styles/home.css",
    "client/src/styles/overlays.css",
    "client/src/styles/sheet.css",
  ]) {
    const style = window.document.createElement("style");
    style.textContent = readFileSync(sheet, "utf8");
    window.document.head.append(style);
  }
});

// `render.test.ts` explains why: a tree that only grows makes every style
// lookup walk more of it than the last.
afterEach(() => {
  window.document.body.replaceChildren();
});

afterAll(async () => {
  globalThis.document = saved.document;
  globalThis.getComputedStyle = saved.getComputedStyle;
  await window.happyDOM.close();
});

const DAY = 86_400_000;
const NOW = 100 * DAY;

const row = (over: Partial<AlternateRow> = {}): AlternateRow => ({
  solutionId: 1,
  puzzleId: 15,
  title: "protanopia",
  difficulty: 6,
  set: null,
  finder: { id: "ada", username: "Ada", avatarUrl: null },
  foundAt: NOW - 3 * DAY,
  locked: false,
  attack: 12,
  pieces: 7,
  clears: ["tsd", "tst"],
  ...over,
});

function browserWith(rows: readonly AlternateRow[], opened: AlternateRow[] = []) {
  const made = createAlternates(
    { onOpen: (line) => opened.push(line), onClose: () => {} },
    () => NOW,
  );
  window.document.body.append(made.element as never);
  made.update(rows, "me");
  return made;
}

const items = (root: HTMLElement) =>
  [...root.querySelectorAll(".alternates__item")] as HTMLButtonElement[];
const ids = (root: HTMLElement) =>
  items(root).map((item) => Number(item.dataset.solution));

describe("a row of the alternate solutions list", () => {
  test("names the puzzle, its difficulty, who found it and how long ago", () => {
    const made = browserWith([row()]);
    const [item] = items(made.element);
    const text = (item!.textContent ?? "").replace(/\s+/g, " ");

    expect(item!.querySelector(".explore__id")!.textContent).toBe("#15");
    expect(item!.querySelector(".explore__title")!.textContent).toContain("protanopia");
    expect(item!.querySelector(".explore__meta")!.textContent).toBe("d6");
    expect(text).toContain("Ada");
    expect(text).toContain("3 days ago");
  });

  test("an open row says what the line sent, how long it is and what it cleared", () => {
    const made = browserWith([row()]);
    const facts = made.element.querySelector(".alternates__facts")!.textContent ?? "";

    expect(facts).toContain("12 attack");
    expect(facts).toContain("7 pieces");
    expect(made.element.querySelector(".alternates__clears")!.textContent).toBe("tsd · tst");
  });

  test("an unrated puzzle says so rather than d0", () => {
    const made = browserWith([row({ difficulty: null })]);
    expect(made.element.querySelector(".explore__meta")!.textContent).toBe("unrated");
  });

  test("your own line is credited to you", () => {
    const made = browserWith([row({ finder: { id: "me", username: "Me", avatarUrl: null } })]);
    expect(made.element.querySelector(".alternates__who")!.textContent).toBe("You");
  });

  test("a locked row is shut, says why, and carries no stats", () => {
    // The server sends nulls for these; the row must not print "null attack",
    // which is what the profile once did with the same shape.
    const made = browserWith([
      row({ locked: true, attack: null, pieces: null, clears: null }),
    ]);
    const [item] = items(made.element);
    const text = item!.textContent ?? "";

    expect(item!.disabled).toBe(true);
    expect(item!.className).toContain("explore__item--locked");
    expect(item!.querySelector(".explore__locked")!.textContent).toBe("solve it first");
    expect(text).not.toContain("attack");
    expect(text).not.toContain("pieces");
    expect(text).not.toContain("null");
    expect(item!.querySelector(".alternates__clears")).toBeNull();
    // Still says whose it is and when: that much the reader may know.
    expect(text).toContain("Ada");
  });

  test("clicking an open row hands it back; a locked one does nothing", () => {
    const opened: AlternateRow[] = [];
    const made = browserWith(
      [row({ solutionId: 1 }), row({ solutionId: 2, locked: true, attack: null, pieces: null, clears: null })],
      opened,
    );
    const [open, shut] = items(made.element);

    shut!.click();
    open!.click();

    expect(opened.map((line) => line.solutionId)).toEqual([1]);
  });

  test("counts what it lists, and says so when there is nothing", () => {
    const some = browserWith([row({ solutionId: 1 }), row({ solutionId: 2 })]);
    expect(some.element.querySelector(".explore__count")!.textContent).toBe("2 alternate solutions");
    some.update([row()], "me");
    expect(some.element.querySelector(".explore__count")!.textContent).toBe("1 alternate solution");

    const none = browserWith([]);
    expect(items(none.element)).toHaveLength(0);
    expect(none.element.querySelector(".explore__list .note")!.textContent).toContain(
      "No alternate solutions",
    );
  });
});

describe("ordering the alternate solutions", () => {
  const rows = [
    row({ solutionId: 1, puzzleId: 30, title: "bravo", difficulty: 2, foundAt: NOW - 1 * DAY, attack: 10, pieces: 9 }),
    row({ solutionId: 2, puzzleId: 10, title: "charlie", difficulty: 8, foundAt: NOW - 5 * DAY, attack: 14, pieces: 5 }),
    row({ solutionId: 3, puzzleId: 20, title: "alpha", difficulty: 5, foundAt: NOW - 3 * DAY, attack: 6, pieces: 7 }),
  ];

  const sortBy = (made: ReturnType<typeof browserWith>, value: string) => {
    const select = made.element.querySelector(".alternates__sort") as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new window.Event("change") as never);
  };
  const flip = (made: ReturnType<typeof browserWith>) =>
    (made.element.querySelector(".alternates__direction") as HTMLButtonElement).click();

  test("offers every sort, newest find first by default", () => {
    const made = browserWith(rows);
    const options = [...made.element.querySelectorAll(".alternates__sort option")].map(
      (option) => option.textContent,
    );

    expect(options).toEqual(["Date found", "Difficulty", "Puzzle name", "Puzzle number", "Attack", "Pieces"]);
    expect(ids(made.element)).toEqual([1, 3, 2]);
  });

  test("a new sort starts in its natural direction", () => {
    const made = browserWith(rows);

    sortBy(made, "title");
    expect(ids(made.element)).toEqual([3, 1, 2]);
    sortBy(made, "difficulty");
    expect(ids(made.element)).toEqual([2, 3, 1]);
    sortBy(made, "number");
    expect(ids(made.element)).toEqual([2, 3, 1]);
    sortBy(made, "attack");
    expect(ids(made.element)).toEqual([2, 1, 3]);
    sortBy(made, "pieces");
    expect(ids(made.element)).toEqual([2, 3, 1]);
  });

  test("the direction button reverses the order, and says which way it runs", () => {
    const made = browserWith(rows);
    const button = made.element.querySelector(".alternates__direction") as HTMLButtonElement;

    expect(button.textContent).toBe("↓");
    expect(button.getAttribute("aria-label")).toBe("Sorted descending. Switch to ascending");

    flip(made);
    expect(ids(made.element)).toEqual([2, 3, 1]);
    expect(button.textContent).toBe("↑");
    expect(button.getAttribute("aria-label")).toBe("Sorted ascending. Switch to descending");

    flip(made);
    expect(ids(made.element)).toEqual([1, 3, 2]);
  });

  test("the order survives fresh rows arriving", () => {
    // The tab refetches on every open; a reader who sorted by attack should
    // not be put back on "newest" by the refresh.
    const made = browserWith(rows);
    sortBy(made, "attack");
    made.update(rows, "me");
    expect(ids(made.element)).toEqual([2, 1, 3]);
    expect((made.element.querySelector(".alternates__sort") as HTMLSelectElement).value).toBe("attack");
  });

  test("a locked row has no attack, so it sorts after the ones that do", () => {
    const made = browserWith([
      row({ solutionId: 1, locked: true, attack: null, pieces: null, clears: null }),
      row({ solutionId: 2, attack: 3 }),
    ]);
    sortBy(made, "attack");
    expect(ids(made.element)).toEqual([2, 1]);
    flip(made);
    expect(ids(made.element)).toEqual([2, 1]);
  });
});

describe("Explore's two tabs", () => {
  const tabsWith = (picked: string[] = [], initial?: "puzzles" | "alternates") => {
    const puzzles = window.document.createElement("section") as unknown as HTMLElement;
    puzzles.className = "panel puzzles-pane";
    const alternates = window.document.createElement("section") as unknown as HTMLElement;
    alternates.className = "panel alternates-pane";
    const made = createExploreTabs({ puzzles, alternates }, (tab) => picked.push(tab), initial);
    window.document.body.append(made.element as never);
    return made;
  };
  const buttons = (root: HTMLElement) =>
    [...root.querySelectorAll(".boards__tabs button")] as HTMLButtonElement[];

  test("opens on Puzzles, the explorer it always was", () => {
    const made = tabsWith();
    const [puzzles, alternates] = buttons(made.element);

    expect(buttons(made.element).map((button) => button.textContent)).toEqual([
      "Puzzles",
      "Alternate solutions",
    ]);
    expect(made.active).toBe("puzzles");
    expect(puzzles!.getAttribute("aria-pressed")).toBe("true");
    expect(puzzles!.className).toContain("btn--primary");
    expect(alternates!.getAttribute("aria-pressed")).toBe("false");
    expect(made.element.querySelector(".puzzles-pane")).not.toBeNull();
    expect(made.element.querySelector(".alternates-pane")).toBeNull();
  });

  test("a tab swaps the pane and says which tab was opened", () => {
    const picked: string[] = [];
    const made = tabsWith(picked);

    buttons(made.element)[1]!.click();

    expect(made.active).toBe("alternates");
    expect(picked).toEqual(["alternates"]);
    expect(made.element.querySelector(".alternates-pane")).not.toBeNull();
    expect(made.element.querySelector(".puzzles-pane")).toBeNull();
    const [puzzles, alternates] = buttons(made.element);
    expect(alternates!.getAttribute("aria-pressed")).toBe("true");
    expect(alternates!.className).toContain("btn--primary");
    expect(puzzles!.className).not.toContain("btn--primary");

    buttons(made.element)[0]!.click();
    expect(made.active).toBe("puzzles");
    expect(picked).toEqual(["alternates", "puzzles"]);
  });

  test("pressing the tab already open does nothing", () => {
    const picked: string[] = [];
    const made = tabsWith(picked);
    buttons(made.element)[0]!.click();
    expect(picked).toEqual([]);
  });

  test("the pane fills the screen and its list is what scrolls", () => {
    // Explore mounts with `screen--fill`, where the card owns the height and
    // the list moves. A wrapper between the screen and the card must hand the
    // height on, or the alternates list grows and the card runs off the frame.
    const browser = createAlternates({ onOpen: () => {}, onClose: () => {} }, () => NOW);
    const shown = createExploreTabs(
      { puzzles: window.document.createElement("section") as unknown as HTMLElement, alternates: browser.element },
      () => {},
      "alternates",
    );
    window.document.body.append(shown.element as never);

    expect(shown.active).toBe("alternates");
    expect(getComputedStyle(shown.element).display).toBe("flex");
    expect(getComputedStyle(shown.element).flexDirection).toBe("column");
    const list = browser.element.querySelector(".explore__list") as HTMLElement;
    expect(getComputedStyle(list).overflowY).toBe("auto");
  });
});

describe("how long ago", () => {
  test("is a rough age, shared by every list that prints one", () => {
    expect(ago(NOW, NOW)).toBe("today");
    expect(ago(NOW - DAY, NOW)).toBe("yesterday");
    expect(ago(NOW - 12 * DAY, NOW)).toBe("12 days ago");
    expect(ago(NOW - 31 * DAY, NOW)).toBe("a month ago");
    expect(ago(NOW - 95 * DAY, NOW)).toBe("3 months ago");
    expect(ago(NOW + DAY, NOW)).toBe("");
  });
});
