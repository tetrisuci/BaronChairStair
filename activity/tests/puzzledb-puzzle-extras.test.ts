/**
 * What a puzzle's page gains from its body: how the puzzle went on the
 * finished days that dealt it, and the lines players found through it.
 *
 * The lines join the maker's answer behind the one "Show the answers" press,
 * as chips over one replay. One replay, rebound — never one per line, because
 * two replays would both own the arrow keys and step two boards for every
 * press. A line carries no finder, so a chip can name only its position,
 * what it sent and how long it was; the day it was found is said beside the
 * replay, and `#line-N` opens the panel on line N's chip.
 *
 * Nothing here may say a puzzle has lines still to come. Since every finished
 * day's lines are published, the only unpublished ones are today's, and a
 * note saying "more lines soon" on a puzzle would mark it as today's deal.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { BoardView } from "../client/src/render/board";
import {
  dateOfDay,
  SCHEMA_VERSION,
  type SiteData,
  type SiteLine,
  type SitePuzzle,
  type SitePuzzleBody,
} from "../puzzledb/wire";
import { indexSiteData, type SiteIndex } from "../puzzledb/client/data";
import { answerChoices, lineLabel } from "../puzzledb/client/lines";
import { renderPuzzleStats } from "../puzzledb/client/puzzle-stats";
import { createPuzzleView, lineFromHash, LINES_ID, type PuzzleView } from "../puzzledb/client/puzzle-view";

let window: Window;
const saved = { document: globalThis.document, window: globalThis.window };

beforeAll(() => {
  window = new Window({ url: "https://db.test/" });
  globalThis.document = window.document as unknown as Document;
  globalThis.window = window as unknown as typeof globalThis.window;
});

afterAll(async () => {
  globalThis.document = saved.document;
  globalThis.window = saved.window;
  await window.happyDOM.close();
});

// ── The data ─────────────────────────────────────────────────────────────────

function sitePuzzle(over: Partial<SitePuzzle> & Pick<SitePuzzle, "id" | "title">): SitePuzzle {
  return {
    author: "roland", difficulty: 2, tier: "easy", goal: "Send 2.", set: null, board: ["GGGG..GGGG"],
    queue: ["O", "I"], hold: null, pieces: 2, targetAttack: 2, requiredClears: null, solution: null,
    source: null, puzzleUrl: null, solutionUrl: null,
    ...over,
  };
}

const O_FIRST = { piece: "O", cells: [[4, 0], [5, 0], [4, 1], [5, 1]], clear: "single", attack: 0 } as const;
const I_FLAT = { piece: "I", cells: [[0, 0], [1, 0], [2, 0], [3, 0]], clear: null, attack: 0 } as const;
const I_UP = { piece: "I", cells: [[0, 1], [1, 1], [2, 1], [3, 1]], clear: null, attack: 0 } as const;

/** Answered by its maker, with a Blueprint link for that answer. */
const ANSWERED = sitePuzzle({
  id: 9, title: "Two step", solution: [O_FIRST, I_FLAT], solutionUrl: "https://bp.tali.software/?code-b",
});
/** No maker's answer on file. */
const BARE = sitePuzzle({ id: 10, title: "Bare" });

const LINE_ONE: SiteLine = { position: 1, day: 272, attack: 10, clears: ["tsd"], steps: [I_UP, O_FIRST] };
const LINE_TWO: SiteLine = { position: 2, day: 274, attack: 3, clears: [], steps: [O_FIRST] };

const DATA: SiteData = {
  about: { schema: SCHEMA_VERSION, builtAt: "2026-10-02T19:00:00.000Z", firstDay: 247, throughDay: 274 },
  puzzles: [ANSWERED, BARE],
  days: [272, 274].map((day) => ({ day, date: dateOfDay(day), deals: [{ tier: "easy" as const, puzzleId: ANSWERED.id }] })),
  players: [{ key: "adakey2345", name: "<i>ada</i>", daysSolved: 4, bestStreak: 2 }],
  servers: [],
};

const INDEX: SiteIndex = indexSiteData(DATA);

const BODY: SitePuzzleBody = {
  builtAt: DATA.about.builtAt,
  stats: { handIns: 8, solves: 2, fastestMs: 62_300, medianMs: 75_000, fastest: { key: "adakey2345", name: "<i>ada</i>" } },
  lines: [LINE_ONE, LINE_TWO],
};

// ── Driving it ───────────────────────────────────────────────────────────────

const opened: PuzzleView[] = [];

function drive(puzzle: SitePuzzle, options: { revealed?: boolean; line?: number | null } = {}) {
  const views: BoardView[] = [];
  const view = createPuzzleView(puzzle, INDEX, { onView: (board) => void views.push(board) }, options);
  opened.push(view);
  document.body.append(view.element);
  return { view, views, element: view.element };
}

function buttonSaying(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!match) throw new Error(`no button says ${label}`);
  return match as HTMLButtonElement;
}

function chipsOf(root: ParentNode): string[] {
  return [...root.querySelectorAll(".pdb-answer__chips button")].map((chip) => chip.textContent ?? "");
}

function statsOf(root: ParentNode): Record<string, string> {
  return Object.fromEntries(
    [...root.querySelectorAll(".stat")].map((row) => [
      row.querySelector(".stat__key")?.textContent ?? "",
      row.querySelector(".stat__value")?.textContent ?? "",
    ]),
  );
}

// ── The tests ────────────────────────────────────────────────────────────────

describe("how the puzzle went", () => {
  test("shows the days it was dealt, its hand-ins, solves, rate, fastest and median, and its lines", () => {
    const element = renderPuzzleStats(ANSWERED, BODY, INDEX);
    expect(element.querySelector(".panel__caption")?.textContent).toBe("How it went");
    expect(statsOf(element)).toEqual({
      "Dealt on": "2 days",
      "Hand-ins": "8",
      Solves: "2",
      "Solve rate": "25%",
      Fastest: "1:02.3 · <i>ada</i>",
      Median: "1:15.0",
      "Players' lines": "2",
    });
    const fastest = element.querySelector(".pdb-stat-fastest a");
    expect(fastest?.getAttribute("href")).toBe("/player/adakey2345");
    expect(element.querySelector("i")).toBeNull();
    // The bar is the rate, drawn.
    expect((element.querySelector(".boards__bar-fill") as HTMLElement).style.width).toBe("25%");
  });

  test("names a fastest player who hid as a player, with no link", () => {
    const hidden: SitePuzzleBody = { ...BODY, stats: { ...BODY.stats!, fastest: null } };
    const element = renderPuzzleStats(ANSWERED, hidden, INDEX);
    expect(statsOf(element).Fastest).toBe("1:02.3 · a player");
    expect(element.querySelector(".pdb-stat-fastest a")).toBeNull();
  });

  test("says so for a puzzle no finished day dealt, and for a dealt one nobody solved", () => {
    const never = renderPuzzleStats(BARE, { builtAt: BODY.builtAt, stats: null, lines: [] }, INDEX);
    expect(never.textContent).toContain("No finished day has dealt it yet.");
    expect(statsOf(never)["Players' lines"]).toBe("0");

    const unsolved: SitePuzzleBody = { ...BODY, stats: { handIns: 3, solves: 0, fastestMs: null, medianMs: null, fastest: null } };
    const stats = statsOf(renderPuzzleStats(ANSWERED, unsolved, INDEX));
    expect(stats.Fastest).toBe("—");
    expect(stats.Median).toBe("—");
    expect(stats["Solve rate"]).toBe("0%");
  });

  test("links to every solve of the puzzle in the feed, once it has one", () => {
    const link = renderPuzzleStats(ANSWERED, BODY, INDEX).querySelector('a[href^="/solves"]');
    expect(link?.textContent).toBe("Every solve of this puzzle →");
    expect(link?.getAttribute("href")).toBe(`/solves?puzzle=${ANSWERED.id}`);

    const unsolved: SitePuzzleBody = { ...BODY, stats: { handIns: 3, solves: 0, fastestMs: null, medianMs: null, fastest: null } };
    expect(renderPuzzleStats(ANSWERED, unsolved, INDEX).querySelector('a[href^="/solves"]')).toBeNull();
    const never = renderPuzzleStats(BARE, { builtAt: BODY.builtAt, stats: null, lines: [] }, INDEX);
    expect(never.querySelector('a[href^="/solves"]')).toBeNull();
  });

  test("never says there are lines still to come", () => {
    for (const lines of [[], [LINE_ONE]]) {
      const text = renderPuzzleStats(ANSWERED, { ...BODY, lines }, INDEX).textContent ?? "";
      expect(text.toLowerCase()).not.toMatch(/not yet shown|still to come|more lines|coming/);
    }
  });
});

describe("the answers", () => {
  test("names each answer: the maker's, then each line by position, attack and length", () => {
    expect(lineLabel(LINE_ONE)).toBe("Line 1 · 10 atk · 2p");
    expect(answerChoices(ANSWERED, [LINE_ONE]).map((choice) => choice.label)).toEqual([
      "Maker's answer",
      "Line 1 · 10 atk · 2p",
    ]);
    expect(answerChoices(BARE, [LINE_TWO]).map((choice) => choice.label)).toEqual(["Line 2 · 3 atk · 1p"]);
    expect(answerChoices(BARE, [])).toEqual([]);
  });

  test("keeps the lines behind the one press, then steps any of them on one replay", () => {
    const { view, views, element } = drive(ANSWERED);
    view.addBody(BODY, INDEX);
    expect(element.querySelector(".replay")).toBeNull();
    expect(element.textContent).toContain("The maker's answer and 2 lines players found");

    buttonSaying(element, "Show the answers").click();
    expect(chipsOf(element)).toEqual(["Maker's answer", "Line 1 · 10 atk · 2p", "Line 2 · 3 atk · 1p"]);
    expect(views.at(-1)!.active).toEqual(O_FIRST.cells);

    buttonSaying(element, "Line 1 · 10 atk · 2p").click();
    expect(element.querySelectorAll(".replay")).toHaveLength(1);
    expect(views.at(-1)!.active).toEqual(I_UP.cells);
    expect(element.querySelector('.pdb-answer__chips [aria-pressed="true"]')?.textContent).toBe("Line 1 · 10 atk · 2p");
    // The maker's Blueprint link belongs to the maker's answer alone.
    expect(element.querySelector('a[href^="https://bp.tali.software"]')).toBeNull();

    // One replay owns the keys: a press steps the line on screen, once.
    const seen = views.length;
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(views).toHaveLength(seen + 1);
    expect(views.at(-1)!.active).toEqual(O_FIRST.cells);
    view.detach();
  });

  test("adds lines that arrive after the answer is already open, keeping the answer on screen", () => {
    const { view, views, element } = drive(ANSWERED, { revealed: true });
    expect(chipsOf(element)).toEqual([]);
    view.addBody(BODY, INDEX);
    expect(chipsOf(element)).toEqual(["Maker's answer", "Line 1 · 10 atk · 2p", "Line 2 · 3 atk · 1p"]);
    expect(views.at(-1)!.active).toEqual(O_FIRST.cells);
    view.detach();
  });

  test("offers a puzzle's lines even with no maker's answer on file", () => {
    const { view, element } = drive(BARE);
    expect(element.textContent).toContain("No answer on file for this puzzle.");
    view.addBody({ ...BODY, lines: [LINE_TWO] }, INDEX);
    buttonSaying(element, "Show the answer").click();
    expect(element.querySelector(".replay")).not.toBeNull();
    // One answer, so nothing to choose between.
    expect(chipsOf(element)).toEqual([]);
    view.detach();
  });

  test("says beside the replay which day the line on screen was found, and nothing for the maker's", () => {
    const { view, element } = drive(ANSWERED);
    view.addBody(BODY, INDEX);
    buttonSaying(element, "Show the answers").click();
    expect(element.querySelector(".pdb-answer__found")).toBeNull();

    buttonSaying(element, "Line 2 · 3 atk · 1p").click();
    expect(element.querySelector(".pdb-answer__found")?.textContent).toBe("Found on day 274 · Thu, Oct 1, 2026");
    view.detach();
  });

  test("gives the answers the anchor the game's link lands on, and puts the stats in the rail", () => {
    const { view, element } = drive(ANSWERED);
    expect(element.querySelector(`#${LINES_ID}`)?.closest(".pdb-answer")).not.toBeNull();
    view.addBody(BODY, INDEX);
    expect(element.querySelector(".pdb-rail .pdb-stats")).not.toBeNull();
    view.detach();
  });
});

describe("a link to one line", () => {
  test("reads #line-N, and nothing else, as a line's number", () => {
    expect(lineFromHash("#line-2")).toBe(2);
    expect(lineFromHash("#line-140")).toBe(140);
    for (const hash of ["", "#lines", "#answer", "#line-0", "#line-02", "#line-", "#line-x", "#line-2a", "#Line-2", "#line-1234567"]) {
      expect({ hash, line: lineFromHash(hash) }).toEqual({ hash, line: null });
    }
  });

  test("opens the answers on that line's chip once the lines arrive", () => {
    const { view, views, element } = drive(ANSWERED, { line: 2 });
    expect(element.querySelector(".replay")).toBeNull();
    expect(view.openedLine).toBeNull();

    view.addBody(BODY, INDEX);

    expect(element.querySelectorAll(".replay")).toHaveLength(1);
    expect(element.querySelector('.pdb-answer__chips [aria-pressed="true"]')?.textContent).toBe("Line 2 · 3 atk · 1p");
    expect(views.at(-1)!.active).toEqual(O_FIRST.cells);
    expect(view.openedLine).toBe(2);
    view.detach();
  });

  test("opens a lone line with no maker's answer, where there are no chips to press", () => {
    const { view, element } = drive(BARE, { line: 2 });
    view.addBody({ ...BODY, lines: [LINE_TWO] }, INDEX);

    expect(element.querySelector(".replay")).not.toBeNull();
    expect(view.openedLine).toBe(2);
    view.detach();
  });

  test("leaves the answers shut, as #lines does, for a line the puzzle does not have", () => {
    const { view, element } = drive(ANSWERED, { line: 7 });
    view.addBody(BODY, INDEX);

    expect(element.querySelector(".replay")).toBeNull();
    expect(buttonSaying(element, "Show the answers")).toBeDefined();
    expect(view.openedLine).toBeNull();
    view.detach();
  });

  test("opens the line only once: lines that arrive again leave the reader's choice alone", () => {
    const { view, element } = drive(ANSWERED, { line: 2 });
    view.addBody(BODY, INDEX);
    buttonSaying(element, "Maker's answer").click();

    view.addBody(BODY, INDEX);

    expect(element.querySelector('.pdb-answer__chips [aria-pressed="true"]')?.textContent).toBe("Maker's answer");
    view.detach();
  });
});
