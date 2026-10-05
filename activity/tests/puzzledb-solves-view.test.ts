/**
 * `/solves`, the feed: every daily solve on a finished day, newest day first,
 * read a few day bodies at a time and steered by `/data/solves.json`.
 *
 * The feed's rows are the day bodies' own rows, so what is pinned here is the
 * steering and the drawing: which days it asks for under each filter, and
 * which it never asks for; that it stops after a bounded number of fetches;
 * that an answer for a filter the reader has already left is dropped; and that
 * a row reads as the day page reads it — "a player" for one who hid, never a
 * link, and the rank the day page prints under the same server chip.
 *
 * The bodies are written out by hand against the wire types. Day bodies come
 * from a stand-in that records every day it was asked for.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";
import {
  ALL_SERVERS,
  dateOfDay,
  type PlayerRef,
  SCHEMA_VERSION,
  type SiteData,
  type SiteDay,
  type SiteDayBody,
  type SitePuzzle,
  type SiteTierRow,
} from "../puzzledb/wire";
import type { SiteSolvesBody, SiteSolvesDay } from "../puzzledb/wire-profiles";
import { indexSiteData, type SiteIndex } from "../puzzledb/client/data";
import { queryForSolves, solvesQueryFrom } from "../puzzledb/client/list-queries";
import { FETCHES_PER_PRESS, solvesPage } from "../puzzledb/client/solves";

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

const ADA = { key: "adakey2345", name: "ada" };
const CY = { key: "cykey23456", name: "<img src=x onerror=alert(1)>" };
const HID: PlayerRef = null;
const CLUB = { key: "clubkey234", name: "Club One" } as const;
const NAMELESS = { key: "unnskey234", name: null } as const;

function sitePuzzle(id: number, title: string, tier: DailyTier): SitePuzzle {
  return {
    id, title, author: "roland", difficulty: 2, tier, goal: "Send 2.", set: null, board: ["GGGGG.GGGG"],
    queue: ["I"], hold: null, pieces: 1, targetAttack: 2, requiredClears: null, solution: null,
    source: null, puzzleUrl: null, solutionUrl: null,
  };
}

const JELLY = sitePuzzle(1, "Jelly", "easy");
const SPIRE = sitePuzzle(2, "Spire", "medium");
const HOOK = sitePuzzle(3, "Hook", "hard");
const TOWER = sitePuzzle(4, "Tower", "extreme");
const ANSWER = sitePuzzle(42, "Answer", "hard");

/** Days 241–274. The puzzle under test is dealt twice; day 274 deals a puzzle a player wrote. */
const FIRST = 241;
const LAST = 274;
const ANSWER_DAYS = [262, 250];
/** Days whose only solve was in the unnamed server, so the steering names no Club One for them. */
const UNNAMED_ONLY = [241, 242, 243, 244, 245];

function siteDay(day: number): SiteDay {
  const ids: Record<DailyTier, number | null> = {
    easy: JELLY.id,
    medium: SPIRE.id,
    hard: ANSWER_DAYS.includes(day) ? ANSWER.id : HOOK.id,
    extreme: day === LAST ? null : TOWER.id,
  };
  return { day, date: dateOfDay(day), deals: DAILY_TIERS.map((tier) => ({ tier, puzzleId: ids[tier] })) };
}

const DAYS = Array.from({ length: LAST - FIRST + 1 }, (_, at) => FIRST + at);

const DATA: SiteData = {
  about: { schema: SCHEMA_VERSION, builtAt: "2026-10-02T19:00:00.000Z", firstDay: FIRST, throughDay: LAST },
  puzzles: [JELLY, SPIRE, HOOK, TOWER, ANSWER],
  days: DAYS.map(siteDay),
  players: [
    { ...ADA, daysSolved: 30, bestStreak: 30 },
    { ...CY, daysSolved: 30, bestStreak: 30 },
  ],
  servers: [CLUB, NAMELESS],
};

const INDEX: SiteIndex = indexSiteData(DATA);

function tierRow(
  tier: DailyTier,
  rank: number,
  serverKey: string | null,
  player: PlayerRef,
  timeMs: number | null,
  puzzleId: number | null,
): SiteTierRow {
  return { tier, rank, serverKey, player, puzzleId, solved: timeMs !== null, timeMs, attack: 2, targetAttack: 2 };
}

/** One day's tier rows, each there for a rule; see the file's opening. */
function tiersOf(day: number): SiteTierRow[] {
  if (UNNAMED_ONLY.includes(day)) return [tierRow("easy", 1, NAMELESS.key, HID, 45_000, JELLY.id)];
  const rows = [
    // Ranked across every server; under Club One alone, cy is second.
    tierRow("easy", 1, CLUB.key, ADA, 40_000, JELLY.id),
    tierRow("easy", 2, NAMELESS.key, HID, 45_000, JELLY.id),
    tierRow("easy", 3, CLUB.key, CY, 50_000, JELLY.id),
    // Handed in, not solved: never a feed row.
    tierRow("medium", 1, CLUB.key, CY, null, SPIRE.id),
  ];
  if (ANSWER_DAYS.includes(day)) rows.push(tierRow("hard", 1, NAMELESS.key, CY, 99_000, ANSWER.id));
  if (day === LAST) {
    rows.push(
      // A tie: both first.
      tierRow("hard", 1, CLUB.key, ADA, 120_000, HOOK.id),
      tierRow("hard", 2, NAMELESS.key, CY, 120_000, HOOK.id),
      tierRow("extreme", 1, null, ADA, 200_000, null),
    );
  }
  return rows;
}

function dayBody(day: number, tiers: readonly SiteTierRow[] = tiersOf(day)): SiteDayBody {
  return { builtAt: DATA.about.builtAt, day, boards: { [ALL_SERVERS]: [] }, tiers, rush: [] };
}

/** The steering the build would write for these day bodies. */
function steeringOf(days: readonly number[], tiersFor: (day: number) => readonly SiteTierRow[]): SiteSolvesBody {
  const entries: SiteSolvesDay[] = [...days]
    .sort((a, b) => b - a)
    .map((day) => {
      const solved = tiersFor(day).filter((row) => row.solved);
      const tiers = Object.fromEntries(DAILY_TIERS.map((tier) => [tier, solved.filter((row) => row.tier === tier).length]));
      const servers = [...new Set(solved.flatMap((row) => (row.serverKey === null ? [] : [row.serverKey])))].sort();
      return { day, tiers: tiers as SiteSolvesDay["tiers"], servers };
    })
    .filter((entry) => Object.values(entry.tiers).some((count) => count > 0));
  return { builtAt: DATA.about.builtAt, days: entries };
}

const STEERING = steeringOf(DAYS, tiersOf);

// ── Driving it ───────────────────────────────────────────────────────────────

/** Lets every promise already settled run its callbacks. */
const settle = () => new Promise((done) => setTimeout(done, 0));

/** A day loader that answers at once from `bodyOf`, recording every day asked for. */
function answering(bodyOf: (day: number) => SiteDayBody = (day) => dayBody(day)) {
  const asked: number[] = [];
  const failing = new Set<number>();
  const dayBodyOf = async (day: number) => {
    asked.push(day);
    if (failing.has(day)) throw new Error(`day ${day} is down`);
    return structuredClone(bodyOf(day));
  };
  return { asked, failing, dayBodyOf };
}

/** A day loader that answers only when the test says so, from `bodyOf`. */
function holding(bodyOf: (day: number) => SiteDayBody = (day) => dayBody(day)) {
  const asked: number[] = [];
  const waiting: { day: number; resolve(body: SiteDayBody): void }[] = [];
  const dayBodyOf = (day: number) =>
    new Promise<SiteDayBody>((resolve) => {
      asked.push(day);
      waiting.push({ day, resolve });
    });
  const answer = (days: readonly number[]) => {
    const due = waiting.filter((each) => days.includes(each.day));
    waiting.splice(0, waiting.length, ...waiting.filter((each) => !days.includes(each.day)));
    for (const held of due) held.resolve(bodyOf(held.day));
  };
  return { asked, dayBodyOf, answer };
}

async function drive(
  search = "",
  loader: (day: number) => Promise<SiteDayBody> = answering().dayBodyOf,
  steering: unknown = STEERING,
  index: SiteIndex = INDEX,
  isCurrent: () => boolean = () => true,
) {
  const queries: string[] = [];
  const view = solvesPage(index, solvesQueryFrom(search, index), {
    dayBody: loader,
    onQuery: (query) => void queries.push(query),
    isCurrent,
  });
  view.fill(steering);
  await settle();
  return { element: view.element, view, queries };
}

function buttonSaying(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!match) throw new Error(`no button says ${label}`);
  return match as HTMLButtonElement;
}

const hasButton = (root: ParentNode, label: string) => [...root.querySelectorAll("button")].some((node) => node.textContent === label);

/** The days drawn, newest first, by their links. */
function daysShown(root: ParentNode): number[] {
  return [...root.querySelectorAll(".pdb-feed-day__head a")].map((link) => Number(link.getAttribute("href")!.split("/")[2]!.split("?")[0]));
}

/** One day's rows, each as its cells' text. */
function rowsOf(root: ParentNode, day: number): string[][] {
  const section = [...root.querySelectorAll(".pdb-feed-day")].find((node) =>
    node.querySelector(`.pdb-feed-day__head a[href^="/day/${day}"]`),
  );
  if (!section) throw new Error(`day ${day} is not drawn`);
  return [...section.querySelectorAll(".pdb-feed-row")].map((row) => [...row.children].map((cell) => cell.textContent ?? ""));
}

/** Every feed row's words, and nothing of the controls above them. */
function feedText(root: ParentNode): string {
  return [...root.querySelectorAll(".pdb-feed-row")].map((row) => row.textContent).join("\n");
}

/** Presses "Show older days" until it is gone, settling after each press. */
async function readToTheEnd(root: ParentNode): Promise<void> {
  while (hasButton(root, "Show older days")) {
    buttonSaying(root, "Show older days").click();
    await settle();
  }
}

// ── The tests ────────────────────────────────────────────────────────────────

/**
 * Forty days that each had an extreme solve and a Club One solve, but never
 * both in one row: the steering cannot tell, so every day is a candidate for
 * `?tier=extreme&server=…` and none of them draws.
 */
const NEVER_BOTH = (() => {
  const days = Array.from({ length: 40 }, (_, at) => 201 + at);
  const tiersFor = () => [
    tierRow("easy", 1, CLUB.key, ADA, 40_000, JELLY.id),
    tierRow("extreme", 1, NAMELESS.key, HID, 90_000, TOWER.id),
  ];
  return {
    tiersFor,
    search: `?tier=extreme&server=${CLUB.key}`,
    steering: steeringOf(days, tiersFor),
    index: indexSiteData({ ...DATA, days: days.map(siteDay) }),
  };
})();

describe("the feed", () => {
  test("asks for the newest seven days, and draws them newest first with only their solves", async () => {
    const loader = answering();
    const { element } = await drive("", loader.dayBodyOf);
    expect(loader.asked).toEqual([274, 273, 272, 271, 270, 269, 268]);
    expect(daysShown(element)).toEqual([274, 273, 272, 271, 270, 269, 268]);
    expect(rowsOf(element, 273)).toEqual([
      ["easy", "#1 Jelly", "ada", "Club One", "0:40.0", "1st"],
      ["easy", "#1 Jelly", "a player", "Unnamed server · unns", "0:45.0", "2nd"],
      ["easy", "#1 Jelly", CY.name, "Club One", "0:50.0", "3rd"],
    ]);
    expect(feedText(element)).not.toContain("Spire");
  });

  test("names each day with its date, a link to it, and its count of solves", async () => {
    const { element } = await drive();
    const head = element.querySelector(".pdb-feed-day__head")!;
    expect(head.querySelector("a")?.textContent).toBe("Day 274 · Thu, Oct 1, 2026");
    expect(head.querySelector("a")?.getAttribute("href")).toBe("/day/274");
    expect(head.textContent).toContain("6 solves");
  });

  test("writes 'a player' for one who hid, never a link, and sets every name as text", async () => {
    const { element } = await drive();
    const anon = [...element.querySelectorAll(".pdb-feed-row .pdb-anon")];
    expect(anon.length).toBeGreaterThan(0);
    for (const node of anon) {
      expect(node.textContent).toBe("a player");
      expect(node.closest("a")).toBeNull();
      expect(node.querySelector("a")).toBeNull();
    }
    const players = [...element.querySelectorAll(".pdb-feed-row a[href^='/player/']")].map((link) => link.getAttribute("href"));
    expect(new Set(players)).toEqual(new Set([`/player/${ADA.key}`, `/player/${CY.key}`]));
    expect(element.querySelector("img")).toBeNull();
  });

  test("leaves a puzzle a player wrote unlinked, and a solve outside any server as no server", async () => {
    const { element } = await drive();
    const extreme = rowsOf(element, 274).find((cells) => cells[0] === "extreme")!;
    expect(extreme).toEqual(["extreme", "a puzzle written by a player", "ada", "no server", "3:20.0", "1st"]);
    const links = [...element.querySelectorAll(".pdb-feed-row a[href^='/puzzle/']")].map((link) => link.getAttribute("href"));
    expect(new Set(links)).toEqual(new Set(["/puzzle/1", "/puzzle/3"]));
  });

  test("shares a rank on a tie, as the day page does", async () => {
    const { element } = await drive();
    const hard = rowsOf(element, 274).filter((cells) => cells[0] === "hard");
    expect(hard.map((cells) => cells[5])).toEqual(["1st", "1st"]);
  });

  test("ranks within the chosen server, as the day page does under the same chip", async () => {
    const { element } = await drive(`?server=${CLUB.key}`);
    expect(rowsOf(element, 273)).toEqual([
      ["easy", "#1 Jelly", "ada", "Club One", "0:40.0", "1st"],
      ["easy", "#1 Jelly", CY.name, "Club One", "0:50.0", "2nd"],
    ]);
    const head = element.querySelector(".pdb-feed-day__head")!;
    expect(head.querySelector("a")?.getAttribute("href")).toBe(`/day/274?server=${CLUB.key}`);
    expect(head.textContent).toContain("3 of 6 solves");
  });

  test("filters by tier, asking only for the days that had a solve in it", async () => {
    const loader = answering();
    const { element, queries } = await drive("", loader.dayBodyOf);
    loader.asked.length = 0;

    buttonSaying(element, "hard").click();
    await settle();
    expect(loader.asked).toEqual([274, 262, 250]);
    expect(daysShown(element)).toEqual([274, 262, 250]);
    expect(rowsOf(element, 262)).toEqual([["hard", "#42 Answer", CY.name, "Unnamed server · unns", "1:39.0", "1st"]]);
    expect(element.textContent).toContain("That's every finished day with a matching solve.");
    expect(queries).toEqual(["?tier=hard"]);
  });

  test("never asks for a day whose steering names no solve in the chosen server", async () => {
    const loader = answering();
    const { element } = await drive(`?server=${CLUB.key}`, loader.dayBodyOf);
    await readToTheEnd(element);
    expect(loader.asked.filter((day) => UNNAMED_ONLY.includes(day))).toEqual([]);
    expect(loader.asked).toHaveLength(DAYS.length - UNNAMED_ONLY.length);
    expect(element.querySelector(".pdb-feed-row .pdb-anon")).toBeNull();
  });

  test("asks only for the days that dealt the chosen puzzle", async () => {
    const loader = answering();
    const { element } = await drive(`?puzzle=${ANSWER.id}`, loader.dayBodyOf);
    expect(loader.asked).toEqual(ANSWER_DAYS);
    expect(daysShown(element)).toEqual(ANSWER_DAYS);
    expect(rowsOf(element, 250)).toEqual([["hard", "#42 Answer", CY.name, "Unnamed server · unns", "1:39.0", "1st"]]);
  });

  test("asks for nothing when the chosen puzzle was dealt in another tier than the one chosen", async () => {
    const loader = answering();
    const { element } = await drive(`?puzzle=${ANSWER.id}&tier=easy`, loader.dayBodyOf);
    expect(loader.asked).toEqual([]);
    expect(element.textContent).toContain("No solves match.");
    expect(element.textContent).not.toContain("Show older days");

    const agreeing = answering();
    await drive(`?puzzle=${ANSWER.id}&tier=hard`, agreeing.dayBodyOf);
    expect(agreeing.asked).toEqual(ANSWER_DAYS);
  });

  test("counts the days left as matching only where the steering proves it", async () => {
    const all = await drive();
    expect(all.element.textContent).toContain(`Through day 268 · ${DAYS.length} days with a solve`);

    const club = await drive(`?server=${CLUB.key}`);
    expect(club.element.textContent).toContain(`${DAYS.length - UNNAMED_ONLY.length} days with a matching solve`);
  });

  test("offers every listed puzzle some finished day dealt, by id, and writes the choice", async () => {
    const { element, queries } = await drive();
    const select = element.querySelector('select[aria-label="Puzzle"]') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Any puzzle", "#1 Jelly", "#2 Spire", "#3 Hook", "#4 Tower", "#42 Answer",
    ]);
    select.value = String(ANSWER.id);
    select.dispatchEvent(new window.Event("change") as unknown as Event);
    await settle();
    expect(daysShown(element)).toEqual(ANSWER_DAYS);
    expect(queries).toEqual([`?puzzle=${ANSWER.id}`]);
  });

  test("offers only the servers the steering names, and writes the choice", async () => {
    const { element, queries } = await drive();
    const chips = [...element.querySelectorAll('[aria-label="Server"] button')].map((chip) => chip.textContent);
    expect(chips).toEqual(["All servers", "Club One", "Unnamed server · unns"]);
    buttonSaying(element, "Club One").click();
    await settle();
    expect(rowsOf(element, 274).map((cells) => cells[3])).toEqual(["Club One", "Club One", "Club One"]);
    expect(queries).toEqual([`?server=${CLUB.key}`]);
  });

  test("shows older days on request, seven drawn at a time", async () => {
    const loader = answering();
    const { element } = await drive("", loader.dayBodyOf);
    buttonSaying(element, "Show older days").click();
    await settle();
    expect(daysShown(element)).toEqual(Array.from({ length: 14 }, (_, at) => LAST - at));
    await readToTheEnd(element);
    expect(daysShown(element)).toEqual([...DAYS].reverse());
    expect(element.textContent).toContain("That's every finished day with a matching solve.");
  });

  test("stops after a bounded number of fetches when the days it reads turn out to hold nothing", async () => {
    const loader = answering((day) => dayBody(day, NEVER_BOTH.tiersFor()));
    const { element } = await drive(NEVER_BOTH.search, loader.dayBodyOf, NEVER_BOTH.steering, NEVER_BOTH.index);

    expect(loader.asked).toHaveLength(FETCHES_PER_PRESS);
    expect(daysShown(element)).toEqual([]);
    expect(hasButton(element, "Show older days")).toBe(true);
    // A tier and a server are checked one at a time, so these days only may match.
    expect(element.textContent).toContain("40 days that may match");
    expect(element.textContent).not.toContain("matching solve");

    buttonSaying(element, "Show older days").click();
    await settle();
    expect(loader.asked).toHaveLength(40);
    expect(element.textContent).toContain("No solves match.");
  });

  test("drops an answer that lands after the reader changed the filter", async () => {
    const loader = holding();
    const { element } = await drive("", loader.dayBodyOf);
    buttonSaying(element, "hard").click();
    await settle();

    loader.answer([274, 273, 272, 271, 270, 269, 268].filter((day) => day !== 274));
    await settle();
    expect(daysShown(element)).toEqual([]);

    loader.answer([274, 262, 250]);
    await settle();
    expect(daysShown(element)).toEqual([274, 262, 250]);
    expect(feedText(element)).not.toContain("Jelly");
  });

  test("asks for no further day once the reader has left the page mid-press", async () => {
    const loader = holding((day) => dayBody(day, NEVER_BOTH.tiersFor()));
    let current = true;
    const { element } = await drive(NEVER_BOTH.search, loader.dayBodyOf, NEVER_BOTH.steering, NEVER_BOTH.index, () => current);
    expect(loader.asked).toHaveLength(7);

    current = false;
    loader.answer(loader.asked);
    await settle();
    expect(loader.asked).toHaveLength(7);
    expect(element.querySelector(".pdb-loading")).not.toBeNull();
  });

  test("says so, and offers another try, when a batch cannot be had, keeping the days drawn", async () => {
    const error = console.error;
    console.error = () => {};
    try {
      const loader = answering();
      const { element } = await drive("", loader.dayBodyOf);
      loader.failing.add(265);
      buttonSaying(element, "Show older days").click();
      await settle();
      expect(element.textContent).toContain("Couldn't load this part of the page.");
      expect(daysShown(element)).toHaveLength(7);

      loader.failing.clear();
      buttonSaying(element, "Try again").click();
      await settle();
      expect(daysShown(element)).toHaveLength(14);
      expect(element.textContent).not.toContain("Couldn't load");
    } finally {
      console.error = error;
    }
  });

  test("says so when no finished day has a solve, and when nothing matches", async () => {
    const none = await drive("", answering().dayBodyOf, { builtAt: DATA.about.builtAt, days: [] });
    expect(none.element.textContent).toContain("No solves on a finished day yet.");

    const loader = answering();
    const { element } = await drive("?tier=medium", loader.dayBodyOf);
    expect(loader.asked).toEqual([]);
    expect(element.textContent).toContain("No solves match.");
  });

  test("refuses a body that is not the solves body", () => {
    const view = solvesPage(INDEX, solvesQueryFrom("", INDEX), { dayBody: answering().dayBodyOf, onQuery: () => {}, isCurrent: () => true });
    expect(() => view.fill({ builtAt: "x", rows: [] })).toThrow("solves");
  });

  test("sets no inline style anywhere", async () => {
    const { element } = await drive();
    expect(element.querySelectorAll("[style]")).toHaveLength(0);
  });
});

describe("the feed's address", () => {
  test("round-trips every tier, a server and a puzzle", () => {
    for (const tier of [...DAILY_TIERS, null]) {
      const query = { tier, server: NAMELESS.key, puzzle: ANSWER.id };
      expect(solvesQueryFrom(queryForSolves(query), INDEX)).toEqual(query);
    }
    expect(queryForSolves({ tier: null, server: null, puzzle: null })).toBe("");
    expect(queryForSolves({ tier: "hard", server: CLUB.key, puzzle: 42 })).toBe(`?tier=hard&server=${CLUB.key}&puzzle=42`);
  });

  test("reads junk as 'all': an unknown tier, server or puzzle, and a puzzle no finished day dealt", () => {
    const all = { tier: null, server: null, puzzle: null };
    expect(solvesQueryFrom("?tier=HARD&server=nosuchkey&puzzle=abc", INDEX)).toEqual(all);
    expect(solvesQueryFrom("?puzzle=042", INDEX)).toEqual(all);
    expect(solvesQueryFrom("?puzzle=-1", INDEX)).toEqual(all);
    expect(solvesQueryFrom("?puzzle=99", INDEX)).toEqual(all);
    expect(solvesQueryFrom("?puzzle=1e3", INDEX)).toEqual(all);
  });

  test("reads a dealt id the archive no longer holds as every puzzle", () => {
    const departed = indexSiteData({ ...DATA, puzzles: DATA.puzzles.filter((puzzle) => puzzle.id !== ANSWER.id) });
    expect(departed.dealsOf.has(ANSWER.id)).toBe(true);
    expect(solvesQueryFrom(`?puzzle=${ANSWER.id}`, departed).puzzle).toBeNull();
  });
});
