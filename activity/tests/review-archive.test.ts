/**
 * The review tool's second tab: the archive, and correcting what is in it.
 *
 * Three kinds of failure, and they are why this is a DOM suite rather than more
 * route tests. `tests/review-override.test.ts` already proves what the server
 * does with a correction; nothing there can see an officer sent the wrong one.
 *
 *  1. **The wrong body.** A form that sent all five fields every time would
 *     record a correction on four fields nobody touched — and every one of them
 *     would then stop tracking the club's sheet, silently, for good. "Only what
 *     changed" is the whole contract between this page and `readOverrideChanges`,
 *     and it is invisible from either end on its own.
 *  2. **A refusal that goes nowhere.** The route knows things this page does
 *     not, and its sentence is the answer to the officer's question. Swallowed,
 *     it leaves a Save button that appears to do nothing.
 *  3. **The screen itself.** happy-dom cascades real stylesheets, so "does this
 *     list scroll inside its own card" is answerable here — see
 *     `tests/render.test.ts`, where the same question was answered the hard way
 *     twice after it reached players.
 *
 * The views are driven as what they are, functions from data to elements, with
 * the server standing in as a handler that records. `ReviewPage` itself is
 * driven for the tabs, because switching them is the one behaviour that is not
 * in any single view.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { ApiError } from "../client/src/api";
import type { PuzzleChanges, ReviewPuzzle } from "../client/review/api";
import { createArchiveView } from "../client/review/archive";
import { createCorrectionView } from "../client/review/correction";
import { ReviewPage, type ReviewCalls } from "../client/review/page";

let window: Window;
const saved = { document: globalThis.document, window: globalThis.window };

beforeAll(() => {
  // Scoped to this file rather than registered as a preload, for the reason
  // `tests/render.test.ts` gives: `bun test` shares one process and the server
  // suites lean on Bun's own fetch/Request.
  window = new Window({ url: "https://local.test/review" });
  globalThis.document = window.document as unknown as Document;
  // `ReviewPage` listens for resizes so the board follows the window. Without a
  // global `window` its constructor throws before a single tab is built.
  globalThis.window = window as unknown as typeof globalThis.window;

  const style = window.document.createElement("style");
  style.textContent = readFileSync("client/review/review.css", "utf8");
  window.document.head.append(style);
});

afterAll(() => {
  globalThis.document = saved.document;
  globalThis.window = saved.window;
});

// ── Three puzzles: untouched, corrected, and a player's ──────────────────────

/** A club puzzle nobody has corrected: every field is its own source. */
const CLUB: ReviewPuzzle = {
  id: 12,
  title: "Tuck the T",
  author: "roland",
  difficulty: 6,
  goal: "Clear a TSD.",
  set: "tspins 101",
  pieces: 4,
  targetAttack: 4,
  community: false,
  overridden: false,
  original: {
    title: "Tuck the T",
    author: "roland",
    goal: "Clear a TSD.",
    difficulty: 6,
    set: "tspins 101",
  },
  updatedAt: null,
  correctedBy: {},
  history: [],
};

/** One with a typo fixed and a re-rating on it; the goal was left alone. */
const CORRECTED: ReviewPuzzle = {
  id: 41,
  title: "Quad from the well",
  author: "roland",
  difficulty: 9,
  goal: "Clear four rows at once.",
  set: null,
  pieces: 10,
  targetAttack: 8,
  community: false,
  overridden: true,
  original: {
    title: "Quad frm the well",
    author: "roland",
    goal: "Clear four rows at once.",
    difficulty: 12,
    set: null,
  },
  updatedAt: new Date(2026, 8, 4, 14, 32).getTime(),
  correctedBy: { title: { by: "hannah", at: 1_788_000_000_000 } },
  history: [],
};

/** A player's, accepted into the community band. */
const PLAYER: ReviewPuzzle = {
  id: 100_000,
  title: "Notch",
  author: "petra",
  difficulty: 3,
  goal: "Clear a TSD.",
  set: null,
  pieces: 1,
  targetAttack: 4,
  community: true,
  overridden: false,
  original: {
    title: "Notch",
    author: "petra",
    goal: "Clear a TSD.",
    difficulty: 3,
    set: null,
  },
  updatedAt: null,
  correctedBy: {},
  history: [],
};

const ALL = [CLUB, CORRECTED, PLAYER];

function find<T extends Element>(root: Element, selector: string): T {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`nothing matched ${selector}`);
  return node as unknown as T;
}

function buttonSaying(root: Element, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!match) throw new Error(`no button says ${label}`);
  return match as unknown as HTMLButtonElement;
}

function textOf(root: Element, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((node) => node.textContent ?? "");
}

/** Types into a box the way a person does: the value, then the event. */
function type(box: HTMLInputElement, value: string): void {
  box.value = value;
  box.dispatchEvent(new window.Event("input") as unknown as Event);
}

/** The box for one field, found by the label a screen reader would read. */
function boxFor(root: Element, label: string): HTMLInputElement {
  return find<HTMLInputElement>(root, `[aria-label="${label}"]`);
}

/** The whole row a field lives on, so its own Revert can be told from the rest. */
function rowFor(root: Element, label: string): Element {
  const row = boxFor(root, label).closest(".review__edit");
  if (!row) throw new Error(`${label} is not on a field row`);
  return row;
}

// ── The list ─────────────────────────────────────────────────────────────────

function driveList(puzzles: readonly ReviewPuzzle[] = ALL) {
  const opened: number[] = [];
  const refreshed: number[] = [];
  const view = createArchiveView(puzzles, {
    onOpen: (id) => void opened.push(id),
    onRefresh: () => void refreshed.push(1),
  });
  return { view, element: view.element, opened, refreshed };
}

describe("the archive list", () => {
  test("a row carries the number, title, author, rating, goal, length and source", () => {
    const { element } = driveList([CLUB]);
    const row = find(element, ".review__row");

    expect(find(row, ".review__row-name").textContent).toBe("Tuck the T");
    expect(find(row, ".review__row-by").textContent).toBe("by roland · club");
    expect(find(row, ".review__row-goal").textContent).toBe("Clear a TSD.");
    const meta = find(row, ".review__row-meta").textContent ?? "";
    expect(meta).toContain("#12");
    expect(meta).toContain("d6");
    expect(meta).toContain("4 pieces");
  });

  /**
   * A club puzzle and a player's are corrected by the same PATCH, so the only
   * thing that says which is which is the row. `community` and not the id band:
   * the band is the record, but re-deriving it on every screen that cares is how
   * the two get to disagree.
   */
  test("a player's puzzle says so where the club's says club", () => {
    const { element } = driveList([PLAYER]);
    expect(find(element, ".review__row-by").textContent).toBe("by petra · player");
  });

  test("only the corrected one is marked as corrected", () => {
    const { element } = driveList();
    expect(textOf(element, ".review__flag")).toEqual(["corrected"]);
    expect(find(element, ".review__row").querySelector(".review__flag")).toBeNull();
  });

  test("the search box narrows by title, by author and by number", () => {
    const { element } = driveList();
    const search = find<HTMLInputElement>(element, "input");
    const titles = () => textOf(element, ".review__row-name");
    expect(titles()).toHaveLength(3);

    type(search, "tuck");
    expect(titles()).toEqual(["Tuck the T"]);

    type(search, "petra");
    expect(titles()).toEqual(["Notch"]);

    // With the # the row prints it with, and without: an officer copying a
    // number off a row should not be answered with nothing.
    type(search, "#41");
    expect(titles()).toEqual(["Quad from the well"]);
    type(search, "41");
    expect(titles()).toEqual(["Quad from the well"]);
  });

  test("the count says how much of the archive is showing", () => {
    const { element } = driveList();
    expect(find(element, ".label").textContent).toBe("all 3 puzzles");

    type(find<HTMLInputElement>(element, "input"), "roland");
    expect(find(element, ".label").textContent).toBe("2 of 3 puzzles");
  });

  /**
   * Two officers can hold links at once and nothing coordinates them, so a list
   * fetched once is a list that can be wrong by the time it is read.
   */
  test("Refresh asks the server for the archive again", () => {
    const { element, refreshed } = driveList();
    buttonSaying(element, "Refresh").click();
    expect(refreshed).toEqual([1]);
  });

  test("a search that matches nothing says so, rather than showing an empty card", () => {
    const { element } = driveList();
    type(find<HTMLInputElement>(element, "input"), "zzz");

    expect(element.querySelector(".review__row")).toBeNull();
    expect(element.textContent).toContain("Nothing in the archive matches “zzz”");
  });

  /**
   * The bug this pins: the rows are redrawn on every keystroke, so a mark the
   * page had set from outside would be wiped by the next letter typed into the
   * search box — leaving a form open on a puzzle no row admitted to being.
   */
  test("the open row stays marked through a search", () => {
    const { element, opened } = driveList();
    find<HTMLButtonElement>(element, ".review__row").click();
    expect(opened).toEqual([12]);
    expect(find(element, ".review__row--open").textContent).toContain("Tuck the T");

    type(find<HTMLInputElement>(element, "input"), "tuck");
    expect(find(element, ".review__row--open").textContent).toContain("Tuck the T");
  });

  test("a new list keeps the search box and shows the corrected title", () => {
    const { view, element } = driveList();
    type(find<HTMLInputElement>(element, "input"), "quad");

    view.update(ALL.map((puzzle) => (puzzle.id === 41 ? { ...puzzle, title: "Quad from the well!" } : puzzle)));

    expect(find<HTMLInputElement>(element, "input").value).toBe("quad");
    expect(textOf(element, ".review__row-name")).toEqual(["Quad from the well!"]);
  });

  /**
   * The bug this pins: `title`, `author` and `goal` are typed by players and by
   * officers, and this page is a plain document outside Discord's sandbox with
   * no CSP behind it. The server refuses control characters and over-length; it
   * does not escape HTML, because escaping belongs to whoever renders.
   */
  test("a title that looks like markup is text, not markup", () => {
    const { element } = driveList([{ ...CLUB, title: "<img src=x onerror=alert(1)>" }]);

    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

// ── Where it scrolls ─────────────────────────────────────────────────────────

describe("where the archive scrolls", () => {
  /**
   * The bug this pins, which the game client shipped twice in the other
   * direction: a list that grows without a ceiling pushes the rest of the card
   * off the bottom, and one that contains its own overscroll kills the page's
   * wheel wherever the pointer sits over a row. 139 rows is three screens, so
   * both are reachable on the first day this tab is used.
   */
  test("the rows scroll inside their own card, and do not eat the page's wheel", () => {
    const { element } = driveList();
    window.document.body.append(element as never);

    const style = window.getComputedStyle(find(element, ".review__list") as never);
    expect(style.overflowY).toBe("auto");
    expect(style.maxHeight).not.toBe("none");
    expect(style.overscrollBehavior).not.toBe("contain");
  });
});

// ── The correction form ──────────────────────────────────────────────────────

interface DrivenForm {
  readonly element: HTMLElement;
  readonly sent: PuzzleChanges[];
  readonly reverts: number[];
  readonly told: string[];
}

function driveForm(
  puzzle: ReviewPuzzle = CLUB,
  answer: (changes: PuzzleChanges) => Promise<ReviewPuzzle> = () => Promise.resolve(puzzle),
  reverted = true,
): DrivenForm {
  const sent: PuzzleChanges[] = [];
  const reverts: number[] = [];
  const told: string[] = [];
  const element = createCorrectionView(puzzle, {
    onSave: (changes) => {
      sent.push(changes);
      return answer(changes);
    },
    onRevert: () => {
      reverts.push(puzzle.id);
      return Promise.resolve({ reverted, puzzle: { ...puzzle, overridden: false } });
    },
    onSaved: (_saved, said) => void told.push(said),
  });
  return { element, sent, reverts, told };
}

describe("the correction form", () => {
  test("every editable field is on it, and nothing else is", () => {
    const { element } = driveForm();
    expect(textOf(element, ".explore__label")).toEqual([
      "Title",
      "Author",
      "Goal",
      "Set",
      "Difficulty",
    ]);
    // The five that cannot change what a solve was worth, and the sentence
    // saying why the rest are absent rather than merely missing.
    expect(element.textContent).toContain("Board, queue, hold, target and solution are not");
  });

  test("the boxes hold what is in force", () => {
    const { element } = driveForm(CORRECTED);
    expect(boxFor(element, "Title").value).toBe("Quad from the well");
    expect(boxFor(element, "Difficulty").value).toBe("9");
  });

  /**
   * The reason this screen exists. An officer looking at a corrected puzzle has
   * to be able to see that it *is* corrected, what it used to say, and who said
   * otherwise — otherwise a wrong correction is indistinguishable from a wrong
   * source, and the two are fixed in completely different places.
   */
  test("the source is shown beside a field that has been changed, and only there", () => {
    const { element } = driveForm(CORRECTED);

    expect(textOf(rowFor(element, "Title"), ".review__was")).toEqual([
      "source: Quad frm the well",
    ]);
    expect(textOf(rowFor(element, "Difficulty"), ".review__was")).toEqual(["source: 12"]);
    // The goal was never corrected: there is nothing to show and nothing to
    // put back, so the row carries neither.
    expect(rowFor(element, "Goal").querySelector(".review__was")).toBeNull();
    expect(rowFor(element, "Goal").querySelector("button")).toBeNull();
  });

  test("who corrected it, and when, are on the form", () => {
    expect(driveForm(CORRECTED).element.textContent).toContain(
      "corrected by hannah · 2026-09-04 14:32",
    );
    expect(driveForm(CLUB).element.textContent).toContain("no correction on file");
  });

  /**
   * The contract this whole page rests on. A form that posted all five fields
   * would record a correction on four nobody touched, and every one of them
   * would stop tracking the club's sheet from then on — silently, and for good,
   * because a correction that repeats its source is still a correction.
   */
  test("Save sends only the fields that changed", () => {
    const { element, sent } = driveForm(CLUB);
    const save = buttonSaying(element, "Save");
    // Nothing has moved, so there is nothing to send.
    expect(save.disabled).toBe(true);

    type(boxFor(element, "Title"), "Tuck the T twice");
    expect(save.disabled).toBe(false);
    save.click();

    expect(sent).toEqual([{ title: "Tuck the T twice" }]);
  });

  test("a difficulty change is sent as a number, not as the text of one", () => {
    const { element, sent } = driveForm(CLUB);

    type(boxFor(element, "Difficulty"), "11");
    buttonSaying(element, "Save").click();

    expect(sent).toEqual([{ difficulty: 11 }]);
  });

  test("two fields at once are one body", () => {
    const { element, sent } = driveForm(CLUB);

    type(boxFor(element, "Title"), "Tuck it");
    type(boxFor(element, "Set"), "tspins 201");
    buttonSaying(element, "Save").click();

    expect(sent).toEqual([{ title: "Tuck it", set: "tspins 201" }]);
  });

  /**
   * The bug this pins: null is "use the source" in every column, so there is no
   * body that says "this field is now blank". Sent as `""` the route answers
   * "A title is required", which is true and does not tell the officer what to
   * do instead.
   */
  test("an emptied box is refused, and names the way back", () => {
    const { element, sent } = driveForm(CORRECTED);

    type(boxFor(element, "Title"), "   ");
    buttonSaying(element, "Save").click();

    expect(sent).toEqual([]);
    expect(find(element, ".review__status").textContent).toContain("cannot be left empty");
    expect(find(element, ".review__status").textContent).toContain("Revert");
  });

  test("a rating outside the scale never reaches the server", () => {
    const { element, sent } = driveForm(CLUB);

    type(boxFor(element, "Difficulty"), "40");
    buttonSaying(element, "Save").click();

    expect(sent).toEqual([]);
    expect(find(element, ".review__status").textContent).toContain("between 1 and 20");
  });

  test("the rating's own pool is named, derived rather than printed", () => {
    const { element } = driveForm(CLUB);
    const tier = find(element, ".review__tier");
    expect(tier.textContent).toBe("medium");

    type(boxFor(element, "Difficulty"), "2");
    expect(tier.textContent).toBe("easy");

    // `Number("")` is 0 and 0 is a tier — hard — so an emptied box would sit
    // there naming one the server would refuse in the same breath.
    type(boxFor(element, "Difficulty"), "");
    expect(tier.textContent).toBe("");
  });

  /** The one consequence of this form that is not confined to the puzzle's row. */
  test("the difficulty's effect on the rotation is spelled out", () => {
    const said = driveForm(CLUB).element.textContent ?? "";
    expect(said).toContain("easy, medium and hard pools that future days");
    expect(said).toContain("already played is written down and does not move");
  });
});

describe("putting a correction back", () => {
  test("Revert on one field sends null for that field alone", () => {
    const { element, sent } = driveForm(CORRECTED);

    buttonSaying(rowFor(element, "Title"), "Revert").click();

    expect(sent).toEqual([{ title: null }]);
  });

  test("Revert on the difficulty sends null for the difficulty alone", () => {
    const { element, sent } = driveForm(CORRECTED);

    buttonSaying(rowFor(element, "Difficulty"), "Revert").click();

    expect(sent).toEqual([{ difficulty: null }]);
  });

  test("Revert all goes to the DELETE, not to a body of five nulls", async () => {
    const { element, sent, reverts, told } = driveForm(CORRECTED);

    buttonSaying(element, "Revert all").click();
    await settle();

    expect(sent).toEqual([]);
    expect(reverts).toEqual([41]);
    expect(told[0]).toContain("back to its source");
  });

  /**
   * The route is idempotent — reverting a puzzle with no correction is a 200 —
   * so the page has to tell the two apart itself. "Done" for a revert that
   * reverted nothing would be a page agreeing with an officer who is wrong.
   */
  test("a revert that had nothing to revert says so", async () => {
    const { element, told } = driveForm(CORRECTED, () => Promise.resolve(CORRECTED), false);

    buttonSaying(element, "Revert all").click();
    await settle();

    expect(told[0]).toContain("nothing to revert");
  });

  test("Revert all is shut on a puzzle that has no correction", () => {
    expect(buttonSaying(driveForm(CLUB).element, "Revert all").disabled).toBe(true);
    expect(buttonSaying(driveForm(CORRECTED).element, "Revert all").disabled).toBe(false);
  });
});

describe("when the server says no", () => {
  /**
   * The bug this pins: the route knows things this page does not — which field
   * it refused, why, and whether the puzzle is there at all — so its sentence
   * is the answer to the officer's question. Swallowed, Save is a button that
   * appears to do nothing.
   */
  test("the refusal is shown in the server's own words", async () => {
    const refused = () =>
      Promise.reject(new ApiError("A title is longer than 60 characters", 400));
    const { element, told } = driveForm(CLUB, refused);

    type(boxFor(element, "Title"), "Tuck the T twice");
    buttonSaying(element, "Save").click();
    await settle();

    expect(find(element, ".review__status").textContent).toBe(
      "A title is longer than 60 characters",
    );
    expect(told).toEqual([]);
    // And the officer can try again, rather than being left with dead buttons.
    expect(buttonSaying(element, "Save").disabled).toBe(false);
  });

  test("the buttons are shut while a save is in flight", () => {
    const { element, sent } = driveForm(CLUB, () => new Promise<ReviewPuzzle>(() => {}));
    const save = buttonSaying(element, "Save");

    type(boxFor(element, "Title"), "Tuck it");
    save.click();
    expect(save.disabled).toBe(true);

    save.click();
    expect(sent).toHaveLength(1);
  });

  test("what a save reports is what happened, and when players see it", async () => {
    const { element, told } = driveForm(CLUB);

    type(boxFor(element, "Title"), "Tuck it");
    buttonSaying(element, "Save").click();
    await settle();

    expect(told).toEqual(["Saved. Players see it when the server next restarts."]);
  });
});

// ── The two tabs ─────────────────────────────────────────────────────────────

/**
 * Lets a click that started a request finish landing.
 *
 * The stand-in answers immediately, but the page still awaits its way through
 * `guard` before a screen is on it. A timeout drains the microtask queue in one
 * go, where a count of `Promise.resolve()`s is a number that has to be kept in
 * step with however many awaits the page grows.
 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The server, as far as the page is concerned. */
function stubApi(): ReviewCalls {
  return {
    queue: () => Promise.resolve({ reviewer: "hannah", queue: [] }),
    submission: () => Promise.reject(new Error("no submission is opened here")),
    accept: () => Promise.reject(new Error("nothing is decided here")),
    reject: () => Promise.reject(new Error("nothing is decided here")),
    puzzles: () => Promise.resolve({ reviewer: "hannah", puzzles: ALL }),
    // The route's own answer in miniature: the source underneath, the
    // correction laid over it, and both computed rather than read back off an
    // archive that was built at boot and cannot have heard about this yet.
    correct: (_id, changes) =>
      Promise.resolve({
        ...CLUB,
        title: changes.title ?? CLUB.original.title,
        difficulty: changes.difficulty ?? CLUB.original.difficulty,
        overridden: true,
      }),
    revert: () => Promise.resolve({ reverted: true, puzzle: CLUB }),
  };
}

function captions(root: Element): string[] {
  return textOf(root, ".panel__caption");
}

describe("the two tabs", () => {
  async function open(): Promise<HTMLElement> {
    const root = window.document.createElement("div") as unknown as HTMLElement;
    const page = new ReviewPage(root, stubApi(), "hannah");
    await page.showQueue();
    return root;
  }

  /**
   * The queue stays the landing screen. A submission waiting on a decision is
   * time-sensitive in a way a typo in a title is not, and an officer who opened
   * their link to clear the queue should not have to go and find it.
   */
  test("the tool lands on the queue", async () => {
    const root = await open();
    expect(captions(root)).toEqual(["Queue"]);
    expect(buttonSaying(root, "Queue").getAttribute("aria-current")).toBe("true");
    expect(buttonSaying(root, "Archive").getAttribute("aria-current")).toBeNull();
  });

  test("Archive shows the archive, and Queue brings the queue back", async () => {
    const root = await open();

    buttonSaying(root, "Archive").click();
    await settle();
    expect(captions(root)).toEqual(["Archive"]);
    expect(buttonSaying(root, "Archive").getAttribute("aria-current")).toBe("true");
    expect(buttonSaying(root, "Queue").getAttribute("aria-current")).toBeNull();

    buttonSaying(root, "Queue").click();
    await settle();
    expect(captions(root)).toEqual(["Queue"]);
    expect(buttonSaying(root, "Queue").getAttribute("aria-current")).toBe("true");
  });

  test("both tabs are on the page from the start, whichever screen is showing", async () => {
    const root = await open();
    expect(textOf(root, ".review__tab")).toEqual(["Queue", "Archive"]);
  });

  test("opening a row puts that puzzle's form beside the list", async () => {
    const root = await open();
    buttonSaying(root, "Archive").click();
    await settle();

    find<HTMLButtonElement>(root, ".review__row").click();
    expect(captions(root)).toEqual(["Archive", "Puzzle #12"]);
    expect(boxFor(root, "Title").value).toBe("Tuck the T");
  });

  /**
   * The bug this pins: rebuilding the whole tab after a correction is the
   * obvious way to show the new title, and it throws away the search the
   * officer typed to find the row with — on a list of 139 that is the work of
   * finding it again, after every single fix.
   */
  test("a correction repaints the row and keeps the search that found it", async () => {
    const root = await open();
    buttonSaying(root, "Archive").click();
    await settle();

    type(find<HTMLInputElement>(root, ".panel input"), "tuck");
    find<HTMLButtonElement>(root, ".review__row").click();

    type(boxFor(root, "Title"), "Tuck the T twice");
    buttonSaying(root, "Save").click();
    await settle();

    expect(textOf(root, ".review__row-name")).toEqual(["Tuck the T twice"]);
    expect(find<HTMLInputElement>(root, ".panel input").value).toBe("tuck");
    // And the form is showing what came back, with the source beside it.
    expect(textOf(rowFor(root, "Title"), ".review__was")).toEqual(["source: Tuck the T"]);
    expect(find(root, ".review__status").textContent).toContain("Saved.");
  });
});
