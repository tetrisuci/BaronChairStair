/**
 * A player's page, the panels the profile browser adds: each tier's record,
 * a calendar of finished days, and the puzzles they cleared.
 *
 * The body is written out by hand against the wire types, each part there for
 * one rule: a tier with hand-ins and no solve, so its dashes can be seen; a
 * tier never played, so "not played" can be seen across the row; a best set
 * on a day the index does not hold, so it can be seen not to be a link; a
 * three-tier day, so a cell's shade can be seen to count the tiers the day
 * dealt; history starting on 2026-01-01, a Thursday, so the calendar's pads
 * can be counted; and more months than the calendar first shows.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";
import {
  dateOfDay,
  SCHEMA_VERSION,
  type SiteData,
  type SiteDay,
  type SitePlayerBody,
  type SitePlayerRun,
  type SitePuzzle,
  type SiteTierSummary,
} from "../puzzledb/wire";
import { indexSiteData, type SiteIndex } from "../puzzledb/client/data";
import { renderPlayer } from "../puzzledb/client/player-view";
import { cellOf, monthsOf } from "../puzzledb/client/profile-panels";

let window: Window;
const saved = { document: globalThis.document };

beforeAll(() => {
  window = new Window({ url: "https://db.test/" });
  globalThis.document = window.document as unknown as Document;
});

afterAll(async () => {
  globalThis.document = saved.document;
  await window.happyDOM.close();
});

// ── The data ─────────────────────────────────────────────────────────────────

function sitePuzzle(id: number, title: string, tier: DailyTier): SitePuzzle {
  return {
    id, title, author: "roland", difficulty: 2, tier, goal: "Send 2.", set: null, board: ["GGGGG.GGGG"],
    queue: ["I"], hold: null, pieces: 1, targetAttack: 2, requiredClears: null, solution: null,
    source: null, puzzleUrl: null, solutionUrl: null,
  };
}

const NOTCH = sitePuzzle(4, "Notch", "hard");
const MARKUP = sitePuzzle(9, "<img src=x onerror=alert(1)>", "easy");

function siteDay(day: number, tiers: readonly DailyTier[] = DAILY_TIERS): SiteDay {
  return { day, date: dateOfDay(day), deals: tiers.map((tier) => ({ tier, puzzleId: NOTCH.id })) };
}

/** Jan 1 and 3, the first of every month to September, then late September and Oct 1: ten months. */
const DAY_NUMBERS = [1, 3, 32, 60, 91, 121, 152, 182, 213, 244, 270, 272, 274];
const THREE_TIERS: readonly DailyTier[] = ["easy", "medium", "extreme"];

const DATA: SiteData = {
  about: { schema: SCHEMA_VERSION, builtAt: "2026-10-02T19:00:00.000Z", firstDay: 1, throughDay: 274 },
  puzzles: [NOTCH, MARKUP],
  days: DAY_NUMBERS.map((day) => siteDay(day, day === 270 ? THREE_TIERS : DAILY_TIERS)),
  players: [{ key: "adakey2345", name: "ada", daysSolved: 41, bestStreak: 21 }],
  servers: [],
};

const INDEX: SiteIndex = indexSiteData(DATA);

function run(day: number, tier: DailyTier, solved: boolean): SitePlayerRun {
  return { day, tier, rank: 1, solved, timeMs: solved ? 60_000 : null, puzzleId: null };
}

const RUNS: readonly SitePlayerRun[] = [
  // Three of four: the third shade.
  run(274, "easy", true), run(274, "medium", true), run(274, "hard", true), run(274, "extreme", false),
  // One of four: the first.
  run(272, "easy", true),
  // One of the three tiers that day dealt: the second.
  run(270, "easy", true),
  // Handed in, none solved.
  run(244, "easy", false),
  // Four of four.
  ...DAILY_TIERS.map((tier) => run(1, tier, true)),
];

function summary(tier: DailyTier, over: Partial<SiteTierSummary> = {}): SiteTierSummary {
  return { tier, handIns: 0, solves: 0, bestMs: null, bestDay: null, medianMs: null, ...over };
}

const BODY: SitePlayerBody = {
  builtAt: DATA.about.builtAt,
  totals: {
    daysSolved: 41, dailies: 112, currentStreak: 9, bestStreak: 21, puzzlesCleared: 5, linesFound: 2,
    rushRuns: 0, rushBest: null, rushBestMs: null, rushBestDay: null,
  },
  runs: RUNS,
  rush: [],
  tiers: [
    summary("easy", { handIns: 14, solves: 12, bestMs: 41_200, bestDay: 274, medianMs: 70_000 }),
    summary("medium", { handIns: 3 }),
    summary("hard", { handIns: 9, solves: 3, bestMs: 123_500, bestDay: 255, medianMs: 160_900 }),
    summary("extreme"),
  ],
  cleared: [NOTCH.id, MARKUP.id],
};

// ── Driving it ───────────────────────────────────────────────────────────────

function card(root: ParentNode, caption: string): HTMLElement {
  const match = [...root.querySelectorAll(".panel")].find(
    (node) => node.querySelector(".panel__caption")?.textContent === caption,
  );
  if (!match) throw new Error(`no card captioned ${caption}`);
  return match as HTMLElement;
}

function buttonSaying(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!match) throw new Error(`no button says ${label}`);
  return match as HTMLButtonElement;
}

function rowsOf(root: ParentNode): string[][] {
  return [...root.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td, th")].map((td) => td.textContent ?? ""));
}

const cellsOf = (root: ParentNode) => [...root.querySelectorAll("a.pdb-cal__cell")] as HTMLAnchorElement[];

// ── The tests ────────────────────────────────────────────────────────────────

describe("a profile's panels", () => {
  test("come in the order a reader looks for them", () => {
    const element = renderPlayer(BODY, INDEX);
    const captions = [...element.querySelectorAll(".panel__caption")].map((caption) => caption.textContent);
    expect(captions).toEqual(["Daily", "Archive", "Rush", "By tier", "Calendar", "Recent days", "Puzzles cleared", "Rushes"]);
  });

  test("link Lines found to the Discoveries board", () => {
    const element = renderPlayer(BODY, INDEX);
    const lines = [...element.querySelectorAll(".stat")].find((row) => row.querySelector(".stat__key")?.textContent === "Lines found")!;
    expect(lines.querySelector(".stat__value")?.textContent).toBe("2");
    expect(lines.querySelector("a")?.getAttribute("href")).toBe("/leaderboards#discoveries");
  });

  test("set no inline style anywhere", () => {
    const element = renderPlayer(BODY, INDEX);
    buttonSaying(element, "Show all 10 months").click();
    expect(element.querySelectorAll("[style]")).toHaveLength(0);
    expect(element.querySelector("img")).toBeNull();
  });
});

describe("by tier", () => {
  test("gives each tier its solves of hand-ins, rate, best and median, and 'not played' for one never played", () => {
    const panel = card(renderPlayer(BODY, INDEX), "By tier");
    expect(rowsOf(panel)).toEqual([
      ["Easy", "12 / 14", "86%", "0:41.2 · day 274", "1:10.0"],
      ["Medium", "0 / 3", "0%", "—", "—"],
      ["Hard", "3 / 9", "33%", "2:03.5 · day 255", "2:40.9"],
      ["Extreme", "not played"],
    ]);
  });

  test("draws the rate as a progress bar of solves over hand-ins", () => {
    const bars = [...card(renderPlayer(BODY, INDEX), "By tier").querySelectorAll("progress")];
    expect(bars.map((bar) => [bar.getAttribute("value"), bar.getAttribute("max")])).toEqual([
      ["12", "14"],
      ["0", "3"],
      ["3", "9"],
    ]);
  });

  test("links a best to its day only when the site has that day", () => {
    const panel = card(renderPlayer(BODY, INDEX), "By tier");
    const links = [...panel.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")]);
    expect(links).toEqual([["day 274", "/day/274"]]);
  });

  test("marks each tier with its colour's class", () => {
    const panel = card(renderPlayer(BODY, INDEX), "By tier");
    const dots = [...panel.querySelectorAll(".pdb-tier-dot")].map((dot) => dot.className);
    expect(dots).toEqual(DAILY_TIERS.map((tier) => `pdb-tier-dot pdb-tier-dot--${tier}`));
  });
});

describe("the calendar", () => {
  test("groups finished days by month, newest month first", () => {
    const months = monthsOf(DAY_NUMBERS);
    expect(months.map((month) => month.title)).toEqual([
      "October 2026", "September 2026", "August 2026", "July 2026", "June 2026",
      "May 2026", "April 2026", "March 2026", "February 2026", "January 2026",
    ]);
    expect(months[1]!.days).toEqual([244, 270, 272]);
    expect(months.at(-1)!.days).toEqual([1, 3]);
  });

  test("shades a day by the share of the tiers it dealt that were solved", () => {
    expect(cellOf(274, RUNS, 4)).toEqual({ shade: "s3", solved: 3, handedIn: 4 });
    expect(cellOf(272, RUNS, 4)).toEqual({ shade: "s1", solved: 1, handedIn: 1 });
    expect(cellOf(270, RUNS, 3)).toEqual({ shade: "s2", solved: 1, handedIn: 1 });
    expect(cellOf(1, RUNS, 4)).toEqual({ shade: "s4", solved: 4, handedIn: 4 });
    expect(cellOf(244, RUNS, 4)).toEqual({ shade: "missed", solved: 0, handedIn: 1 });
    expect(cellOf(3, RUNS, 4)).toEqual({ shade: "none", solved: 0, handedIn: 0 });
  });

  test("shows six months, then every month on request, one linked cell per finished day", () => {
    const panel = card(renderPlayer(BODY, INDEX), "Calendar");
    expect([...panel.querySelectorAll(".pdb-cal__title")].map((title) => title.textContent)).toEqual([
      "October 2026", "September 2026", "August 2026", "July 2026", "June 2026", "May 2026",
    ]);

    buttonSaying(panel, "Show all 10 months").click();
    expect(panel.querySelectorAll(".pdb-cal__title")).toHaveLength(10);
    expect(cellsOf(panel).map((cell) => cell.getAttribute("href"))).toEqual(
      [274, 244, 270, 272, 213, 182, 152, 121, 91, 60, 32, 1, 3].map((day) => `/day/${day}`),
    );
    expect(panel.textContent).not.toContain("Show all");
  });

  test("names each cell's day, date and how it went", () => {
    const panel = card(renderPlayer(BODY, INDEX), "Calendar");
    const label = (day: number) => panel.querySelector(`a[href="/day/${day}"]`)?.getAttribute("aria-label");
    expect(label(274)).toBe("Day 274 · Thu, Oct 1, 2026 — 3 of 4 solved");
    expect(label(270)).toBe("Day 270 · Sun, Sep 27, 2026 — 1 of 3 solved");
    expect(label(244)).toBe("Day 244 · Tue, Sep 1, 2026 — 0 of 4 solved");
    expect(panel.querySelector('a[href="/day/274"]')?.getAttribute("title")).toBe(label(274));
  });

  test("classes each cell by its shade", () => {
    const panel = card(renderPlayer(BODY, INDEX), "Calendar");
    buttonSaying(panel, "Show all 10 months").click();
    const shade = (day: number) => panel.querySelector(`a[href="/day/${day}"]`)?.className;
    expect(shade(274)).toBe("pdb-cal__cell pdb-cal__cell--s3");
    expect(shade(244)).toBe("pdb-cal__cell pdb-cal__cell--missed");
    expect(shade(3)).toBe("pdb-cal__cell pdb-cal__cell--none");
    expect(shade(1)).toBe("pdb-cal__cell pdb-cal__cell--s4");
  });

  test("lines weekdays up with pads before the first date, and blanks for dates that are not finished days", () => {
    const panel = card(renderPlayer(BODY, INDEX), "Calendar");
    buttonSaying(panel, "Show all 10 months").click();
    const january = [...panel.querySelectorAll(".pdb-cal")].at(-1)!;
    const grid = [...january.querySelector(".pdb-cal__grid")!.children].map((node) => node.className.split(" ")[0]);
    // Seven weekday heads; 2026-01-01 is a Thursday, so four pads; then the 1st, a gap for the 2nd, the 3rd.
    expect(grid).toEqual([
      ...Array(7).fill("pdb-cal__weekday"),
      ...Array(4).fill("pdb-cal__pad"),
      "pdb-cal__cell", "pdb-cal__gap", "pdb-cal__cell",
    ]);
    const september = [...panel.querySelectorAll(".pdb-cal")][1]!;
    // Sep 1 to Sep 29: three finished days and twenty-six gaps, after two pads for a Tuesday.
    expect(september.querySelectorAll(".pdb-cal__pad")).toHaveLength(2);
    expect(september.querySelectorAll(".pdb-cal__gap")).toHaveLength(26);
  });

  test("has no cell for a day outside the index: today, the future, or before history", () => {
    const panel = card(renderPlayer(BODY, INDEX), "Calendar");
    buttonSaying(panel, "Show all 10 months").click();
    expect(cellsOf(panel)).toHaveLength(DAY_NUMBERS.length);
    for (const day of [2, 275, 0]) expect(panel.querySelector(`a[href="/day/${day}"]`)).toBeNull();
  });

  test("says so when no day has finished", () => {
    const empty = indexSiteData({ ...DATA, days: [], about: { ...DATA.about, throughDay: null } });
    const panel = card(renderPlayer({ ...BODY, runs: [] }, empty), "Calendar");
    expect(panel.textContent).toContain("No finished days yet.");
  });
});

describe("the puzzles cleared", () => {
  test("lists each as a link named from the index, in id order, with its tier's dot", () => {
    const panel = card(renderPlayer(BODY, INDEX), "Puzzles cleared");
    const links = [...panel.querySelectorAll("a.pdb-cleared__link")];
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["#4 Notch", "/puzzle/4"],
      [`#9 ${MARKUP.title}`, "/puzzle/9"],
    ]);
    expect(links[0]!.querySelector(".pdb-tier-dot--hard")).not.toBeNull();
    expect(panel.querySelector("img")).toBeNull();
  });

  test("says how many more are puzzles the site does not list", () => {
    const panel = card(renderPlayer(BODY, INDEX), "Puzzles cleared");
    expect(panel.textContent).toContain("3 more are puzzles this site does not list.");
    const one = card(renderPlayer({ ...BODY, totals: { ...BODY.totals, puzzlesCleared: 3 } }, INDEX), "Puzzles cleared");
    expect(one.textContent).toContain("1 more is a puzzle this site does not list.");
    const even = card(renderPlayer({ ...BODY, totals: { ...BODY.totals, puzzlesCleared: 2 } }, INDEX), "Puzzles cleared");
    expect(even.textContent).not.toContain("does not list");
  });

  test("shows forty, then all of them on request", () => {
    const many = Array.from({ length: 45 }, (_, at) => sitePuzzle(100 + at, `P${at}`, "medium"));
    const index = indexSiteData({ ...DATA, puzzles: many });
    const body = { ...BODY, cleared: many.map((puzzle) => puzzle.id), totals: { ...BODY.totals, puzzlesCleared: 45 } };
    const panel = card(renderPlayer(body, index), "Puzzles cleared");
    expect(panel.querySelectorAll("a.pdb-cleared__link")).toHaveLength(40);

    buttonSaying(panel, "Show all 45").click();
    expect(panel.querySelectorAll("a.pdb-cleared__link")).toHaveLength(45);
    expect(panel.querySelector("button")).toBeNull();
  });

  test("says so when they cleared none, and when every clear is one the site does not list", () => {
    const none = { ...BODY, cleared: [], totals: { ...BODY.totals, puzzlesCleared: 0 } };
    expect(card(renderPlayer(none, INDEX), "Puzzles cleared").textContent).toContain(
      "No puzzles cleared before the newest finished day.",
    );
    const unlisted = { ...BODY, cleared: [], totals: { ...BODY.totals, puzzlesCleared: 2 } };
    expect(card(renderPlayer(unlisted, INDEX), "Puzzles cleared").textContent).toContain(
      "2 puzzles cleared, none of them one this site lists.",
    );
  });
});
