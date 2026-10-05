/**
 * The site's boards, drawn: the all-time leaderboards, a finished day's
 * boards, a player's page and the list of players.
 *
 * Every view here is a function from a body the server built to elements, so
 * the bodies are written out by hand, each row there for one rule: two rows
 * that tie, so the displayed rank can be seen to repeat; a row of a player who
 * hid, so "a player" can be seen not to be a link; a server with no name, so
 * its chip can be seen to say so; an unsolved hand-in, so its cell can be seen
 * to read as the game reads it. Names are markup where a person typed them,
 * because a player's username is text a stranger chose.
 *
 * The stored rank is a position in a total order and is unique; what a reader
 * sees is a rank in which equal values are equal. That conversion is the
 * page's, and it is pinned here, on every board, scoped and unscoped.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";
import {
  ALL_SERVERS,
  dateOfDay,
  displayRanks,
  type PlayerRef,
  SCHEMA_VERSION,
  type SiteData,
  type SiteDay,
  type SiteDayBody,
  type SiteLeaderboardsBody,
  type SitePlayerBody,
  type SiteStanding,
  STANDING_BOARDS,
  type StandingBoard,
} from "../puzzledb/wire";
import { serverLabel } from "../puzzledb/client/board-rows";
import { indexSiteData, type SiteIndex, type ViewContext } from "../puzzledb/client/data";
import { renderDayBoards } from "../puzzledb/client/day-boards";
import { renderLeaderboards } from "../puzzledb/client/leaderboards";
import { renderPlayer } from "../puzzledb/client/player-view";
import { renderPlayers } from "../puzzledb/client/players";
import { queryForServer, serverFromQuery } from "../puzzledb/client/server-chips";

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

const ADA = { key: "adakey2345", name: "ada" } as const;
const BEA = { key: "beakey2345", name: "<b>bea</b>" } as const;
const CY = { key: "cykey23456", name: "cy" } as const;
const HID: PlayerRef = null;

const CLUB = { key: "clubkey234", name: "Club One" } as const;
const NAMELESS = { key: "unnskey234", name: null } as const;

function siteDay(day: number): SiteDay {
  return { day, date: dateOfDay(day), deals: DAILY_TIERS.map((tier) => ({ tier, puzzleId: null })) };
}

const DATA: SiteData = {
  about: { schema: SCHEMA_VERSION, builtAt: "2026-10-02T19:00:00.000Z", firstDay: 247, throughDay: 274 },
  puzzles: [],
  days: [siteDay(271), siteDay(273), siteDay(274)],
  players: [
    { key: ADA.key, name: ADA.name, daysSolved: 41, bestStreak: 21 },
    { key: BEA.key, name: BEA.name, daysSolved: 1, bestStreak: 1 },
    { key: CY.key, name: CY.name, daysSolved: 3, bestStreak: 2 },
  ],
  servers: [CLUB, NAMELESS],
};

const INDEX: SiteIndex = indexSiteData(DATA);

function standing(rank: number, player: PlayerRef, value: number, extra: Partial<SiteStanding> = {}): SiteStanding {
  return { rank, player, value, detail: null, timeMs: null, day: null, ...extra };
}

function boards(over: Partial<Record<StandingBoard, Record<string, SiteStanding[]>>>): SiteLeaderboardsBody {
  const empty = Object.fromEntries(STANDING_BOARDS.map((board) => [board, { [ALL_SERVERS]: [] }]));
  return { builtAt: DATA.about.builtAt, boards: { ...empty, ...over } as SiteLeaderboardsBody["boards"] };
}

const LEADERBOARDS = boards({
  rush: {
    [ALL_SERVERS]: [
      standing(1, ADA, 14, { timeMs: 291_000, day: 271 }),
      standing(2, HID, 14, { timeMs: 291_000, day: 273 }),
      standing(3, CY, 9, { timeMs: 200_000, day: 274 }),
    ],
    [CLUB.key]: [standing(1, CY, 9, { timeMs: 200_000, day: 274 })],
  },
  dailies: { [ALL_SERVERS]: [standing(1, ADA, 112, { detail: 41 }), standing(2, HID, 112)] },
  streak: { [ALL_SERVERS]: [standing(1, ADA, 9, { detail: 21 })] },
  best_streak: { [ALL_SERVERS]: [standing(1, ADA, 21)] },
  cleared: {
    [ALL_SERVERS]: Array.from({ length: 23 }, (_, at) => standing(at + 1, at % 2 ? HID : CY, 50 - at)),
  },
  discoveries: { [ALL_SERVERS]: [standing(1, BEA, 7), standing(2, HID, 1)] },
});

const DAY_274: SiteDayBody = {
  builtAt: DATA.about.builtAt,
  day: 274,
  boards: {
    [ALL_SERVERS]: [
      { rank: 1, player: ADA, solved: 3, timeMs: 312_300, marks: { easy: 2, medium: 2, hard: 2, extreme: 1 } },
      { rank: 2, player: HID, solved: 1, timeMs: 62_300, marks: { easy: 2, medium: 1, hard: 0, extreme: 0 } },
      { rank: 3, player: CY, solved: 1, timeMs: 62_300, marks: { easy: 2, medium: 0, hard: 0, extreme: null } },
    ],
    [CLUB.key]: [
      { rank: 1, player: CY, solved: 1, timeMs: 62_300, marks: { easy: 2, medium: 0, hard: 0, extreme: null } },
    ],
    [NAMELESS.key]: [
      { rank: 1, player: HID, solved: 1, timeMs: 62_300, marks: { easy: 2, medium: 1, hard: 0, extreme: 0 } },
    ],
  },
  tiers: [
    tierRow("easy", 1, CLUB.key, CY, true, 62_300),
    tierRow("easy", 2, NAMELESS.key, HID, true, 62_300),
    tierRow("easy", 3, null, ADA, true, 70_000),
    tierRow("medium", 1, null, ADA, true, 100_000),
    tierRow("medium", 2, NAMELESS.key, HID, false, null, 8, 12),
    tierRow("hard", 1, null, ADA, true, 142_300),
    tierRow("extreme", 1, null, ADA, false, null, 3, 20),
  ],
  rush: [
    { rank: 1, serverKey: CLUB.key, player: CY, solved: 9, timeMs: 200_000 },
    { rank: 2, serverKey: null, player: ADA, solved: 7, timeMs: 180_000 },
  ],
};

function tierRow(
  tier: DailyTier,
  rank: number,
  serverKey: string | null,
  player: PlayerRef,
  solved: boolean,
  timeMs: number | null,
  attack = 4,
  targetAttack = 4,
) {
  return { tier, rank, serverKey, player, puzzleId: null, solved, timeMs, attack, targetAttack };
}

const ADA_BODY: SitePlayerBody = {
  builtAt: DATA.about.builtAt,
  totals: {
    daysSolved: 41, dailies: 112, currentStreak: 9, bestStreak: 21, puzzlesCleared: 37, linesFound: 2,
    rushRuns: 5, rushBest: 14, rushBestMs: 291_000, rushBestDay: 271,
  },
  runs: [
    { day: 274, tier: "easy", rank: 3, solved: true, timeMs: 70_000, puzzleId: null },
    { day: 274, tier: "extreme", rank: 1, solved: false, timeMs: null, puzzleId: null },
    { day: 273, tier: "hard", rank: 2, solved: true, timeMs: 142_300, puzzleId: null },
  ],
  rush: [{ day: 271, rank: 1, solved: 14, timeMs: 291_000 }],
};

// ── Driving it ───────────────────────────────────────────────────────────────

/** A context that records every chip the reader picks. */
function context(server: string | null = null) {
  const picked: (string | null)[] = [];
  const ctx: ViewContext = { server, onServer: (key) => void picked.push(key) };
  return { ctx, picked };
}

function find(root: ParentNode, selector: string): HTMLElement {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`nothing matched ${selector}`);
  return node as HTMLElement;
}

function buttonSaying(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!match) throw new Error(`no button says ${label}`);
  return match as HTMLButtonElement;
}

/** Each row of a list as `rank|name|detail|score`, the way a reader reads across it. */
function rowsOf(root: ParentNode): string[] {
  return [...root.querySelectorAll(".pdb-row")].map((row) =>
    [".board-list__rank", ".pdb-row__name", ".pdb-row__detail", ".board-list__score"]
      .map((part) => row.querySelector(part)?.textContent ?? "")
      .join("|"),
  );
}

function card(root: ParentNode, caption: string): HTMLElement {
  const match = [...root.querySelectorAll(".panel")].find(
    (panel) => panel.querySelector(".panel__caption")?.textContent === caption,
  );
  if (!match) throw new Error(`no card is captioned ${caption}`);
  return match as HTMLElement;
}

// ── The tests ────────────────────────────────────────────────────────────────

describe("ranks and names", () => {
  test("gives equal values an equal displayed rank, and the next value its place", () => {
    const values = [9, 7, 7, 7, 3, 3, 1];
    expect(displayRanks(values, (a, b) => a === b)).toEqual([1, 2, 2, 2, 5, 5, 7]);
    expect(displayRanks([], (a, b) => a === b)).toEqual([]);
  });

  test("names a server, or an unnamed one by the start of its key", () => {
    expect(serverLabel(CLUB)).toBe("Club One");
    expect(serverLabel(NAMELESS)).toBe("Unnamed server · unns");
  });

  test("reads the server from the address only when the index knows it", () => {
    expect(serverFromQuery(`?server=${CLUB.key}`, INDEX)).toBe(CLUB.key);
    expect(serverFromQuery("?server=nosuchkey2", INDEX)).toBeNull();
    expect(serverFromQuery("?server=all", INDEX)).toBeNull();
    expect(serverFromQuery("", INDEX)).toBeNull();
    expect(queryForServer(CLUB.key)).toBe(`?server=${CLUB.key}`);
    expect(queryForServer(null)).toBe("");
  });
});

describe("the leaderboards", () => {
  test("shows every all-time board as a card, each saying how far it runs", () => {
    const element = renderLeaderboards(LEADERBOARDS, INDEX, context().ctx);
    const captions = [...element.querySelectorAll(".pdb-board-card .panel__caption")].map((node) => node.textContent);
    expect(captions).toEqual([
      "Rush records", "Dailies solved", "Current streak", "Best streak", "Puzzles cleared", "Discoveries",
    ]);
    expect(card(element, "Dailies solved").textContent).toContain("through Thu, Oct 1, 2026");
    // The newest finished day, one press away.
    expect(find(element, 'a[href="/day/274"]').textContent).toContain("Day 274");
  });

  test("reads each board's numbers as the game does, ties sharing a rank", () => {
    const element = renderLeaderboards(LEADERBOARDS, INDEX, context().ctx);
    expect(rowsOf(card(element, "Rush records"))).toEqual([
      "1|ada|day 271|14 · 4:51.0",
      "1|a player|day 273|14 · 4:51.0",
      "3|cy|day 274|9 · 3:20.0",
    ]);
    expect(rowsOf(card(element, "Dailies solved"))).toEqual(["1|ada|41 days|112", "1|a player||112"]);
    expect(rowsOf(card(element, "Current streak"))).toEqual(["1|ada|best 21|9"]);
    expect(rowsOf(card(element, "Best streak"))).toEqual(["1|ada||21"]);
    expect(rowsOf(card(element, "Discoveries"))).toEqual(["1|<b>bea</b>||7 lines", "2|a player||1 line"]);
  });

  test("links a shown player to their page, and never links a player who hid", () => {
    const element = renderLeaderboards(LEADERBOARDS, INDEX, context().ctx);
    const rush = card(element, "Rush records");
    expect(find(rush, ".pdb-row__name a").getAttribute("href")).toBe(`/player/${ADA.key}`);
    const hidden = [...element.querySelectorAll(".pdb-anon")];
    expect(hidden.length).toBeGreaterThan(0);
    for (const node of hidden) {
      expect(node.textContent).toBe("a player");
      expect(node.closest("a")).toBeNull();
      expect(node.querySelector("a")).toBeNull();
    }
    // A name is text, never markup.
    expect(card(element, "Discoveries").querySelector("b")).toBeNull();
  });

  test("puts the Discoveries board where the game's link lands", () => {
    const element = renderLeaderboards(LEADERBOARDS, INDEX, context().ctx);
    expect(find(element, "#discoveries").textContent).toContain("Discoveries");
  });

  test("shows the top ten, and the rest of the fifty on asking", () => {
    const element = renderLeaderboards(LEADERBOARDS, INDEX, context().ctx);
    const cleared = card(element, "Puzzles cleared");
    expect(rowsOf(cleared)).toHaveLength(10);
    buttonSaying(cleared, "Show all 23").click();
    expect(rowsOf(cleared)).toHaveLength(23);
    expect(() => buttonSaying(cleared, "Show all 23")).toThrow();
  });

  test("scopes the rush records to the server chosen, and says so when a pick changes it", () => {
    const { ctx, picked } = context(CLUB.key);
    const element = renderLeaderboards(LEADERBOARDS, INDEX, ctx);
    const rush = () => card(element, "Rush records");
    expect(rowsOf(rush())).toEqual(["1|cy|day 274|9 · 3:20.0"]);
    expect(find(rush(), '[aria-pressed="true"]').textContent).toBe("Club One");

    buttonSaying(rush(), "Unnamed server · unns").click();
    expect(picked).toEqual([NAMELESS.key]);
    expect(rush().textContent).toContain("Nobody on this board yet.");

    buttonSaying(rush(), "All servers").click();
    expect(picked).toEqual([NAMELESS.key, null]);
    expect(rowsOf(rush())).toHaveLength(3);
  });

  test("says so on every board when nothing has been played", () => {
    const element = renderLeaderboards(boards({}), indexSiteData({ ...DATA, servers: [] }), context().ctx);
    const empties = [...element.querySelectorAll(".pdb-board-card")].map((node) =>
      node.textContent?.includes("Nobody on this board yet."),
    );
    expect(empties).toEqual([true, true, true, true, true, true]);
    // No server, so nothing to choose between.
    expect(element.textContent).not.toContain("All servers");
  });
});

describe("a finished day's boards", () => {
  const draw = (server: string | null = null) => {
    const { ctx, picked } = context(server);
    return { element: renderDayBoards(DAY_274, DATA.days[2]!, INDEX, ctx), picked };
  };

  test("ranks the day board across tiers, with each tier's mark and an equal rank for equal days", () => {
    const { element } = draw();
    expect(rowsOf(card(element, "Leaderboard"))).toEqual([
      "1|ada||3/4 · 5:12.3",
      "2|a player||1/4 · 1:02.3",
      "2|cy||1/3 · 1:02.3",
    ]);
    const marks = [...card(element, "Leaderboard").querySelectorAll(".pdb-row")][2]!.querySelectorAll(".board__mark");
    // Three dealt tiers, so three marks: solved, then two never opened.
    expect([...marks].map((mark) => mark.className)).toEqual([
      "board__mark board__mark--on",
      "board__mark board__mark--none",
      "board__mark board__mark--none",
    ]);
  });

  test("reads a solved hand-in as its time and an unsolved one as attack against target", () => {
    const { element } = draw();
    const tiers = card(element, "Tiers");
    expect(rowsOf(tiers)).toEqual(["1|cy||1:02.3", "1|a player||1:02.3", "3|ada||1:10.0"]);
    buttonSaying(tiers, "medium").click();
    expect(rowsOf(card(element, "Tiers"))).toEqual(["1|ada||1:40.0", "2|a player||8/12 atk"]);
    buttonSaying(card(element, "Tiers"), "extreme").click();
    expect(rowsOf(card(element, "Tiers"))).toEqual(["1|ada||3/20 atk"]);
  });

  test("counts the field per tier: solved of handed in", () => {
    const { element } = draw();
    const field = card(element, "The field");
    const counts = [...field.querySelectorAll(".boards__tier")].map(
      (row) => `${row.querySelector(".boards__tier-name")?.textContent} ${row.querySelector(".boards__tier-count")?.textContent}`,
    );
    expect(counts).toEqual(["easy 3 of 3", "medium 1 of 2", "hard 1 of 1", "extreme 0 of 1"]);
    expect(field.textContent).toContain("2 rushes");
  });

  test("shows the rush board, and scopes everything to the server chosen", () => {
    const all = draw().element;
    expect(rowsOf(card(all, "Rush"))).toEqual(["1|cy||9 · 3:20.0", "2|ada||7 · 3:00.0"]);

    const { element, picked } = draw(CLUB.key);
    expect(rowsOf(card(element, "Leaderboard"))).toEqual(["1|cy||1/3 · 1:02.3"]);
    expect(rowsOf(card(element, "Tiers"))).toEqual(["1|cy||1:02.3"]);
    expect(rowsOf(card(element, "Rush"))).toEqual(["1|cy||9 · 3:20.0"]);

    buttonSaying(element, "Unnamed server · unns").click();
    expect(picked).toEqual([NAMELESS.key]);
    expect(rowsOf(card(element, "Leaderboard"))).toEqual(["1|a player||1/4 · 1:02.3"]);
    expect(card(element, "Rush").textContent).toContain("Nobody ran the rush");
  });

  test("falls back to every server for a key the day does not know", () => {
    const { element } = draw("nosuchkey2");
    expect(rowsOf(card(element, "Leaderboard"))).toHaveLength(3);
    expect(find(element, '[aria-pressed="true"]').textContent).toBe("All servers");
  });

  test("says so for a day nobody played", () => {
    const quiet: SiteDayBody = { builtAt: DATA.about.builtAt, day: 273, boards: { [ALL_SERVERS]: [] }, tiers: [], rush: [] };
    const element = renderDayBoards(quiet, DATA.days[1]!, INDEX, context().ctx);
    expect(card(element, "Leaderboard").textContent).toContain("Nobody handed in a daily");
    expect(card(element, "Tiers").textContent).toContain("Nobody handed in the easy");
    expect(card(element, "Rush").textContent).toContain("Nobody ran the rush");
    expect(element.textContent).not.toContain("All servers");
  });
});

describe("a player's page", () => {
  test("shows their totals, their recent days and their rushes", () => {
    const element = renderPlayer(ADA_BODY, INDEX);
    const stats = Object.fromEntries(
      [...element.querySelectorAll(".stat")].map((row) => [
        row.querySelector(".stat__key")?.textContent,
        row.querySelector(".stat__value")?.textContent,
      ]),
    );
    expect(stats).toMatchObject({
      "Days solved": "41", Dailies: "112", Streak: "9", "Best streak": "21",
      "Puzzles cleared": "37", "Lines found": "2", "Best rush": "14 · 4:51.0", Rushes: "5",
    });
    expect(element.textContent).toContain("Streaks count finished days, through Thu, Oct 1, 2026.");

    const days = [...card(element, "Recent days").querySelectorAll(".pdb-run-day")];
    expect(days.map((day) => day.querySelector("a")?.getAttribute("href"))).toEqual(["/day/274", "/day/273"]);
    expect(days[0]!.textContent).toContain("easy · 1:10.0 · 3rd");
    expect(days[0]!.textContent).toContain("extreme · not solved");

    expect(card(element, "Rushes").textContent).toContain("14 solved · 4:51.0 · 1st");
  });

  test("says so when they have no rush and no hand-in", () => {
    const empty: SitePlayerBody = {
      builtAt: DATA.about.builtAt,
      totals: { ...ADA_BODY.totals, rushRuns: 0, rushBest: null, rushBestMs: null, rushBestDay: null },
      runs: [],
      rush: [],
    };
    const element = renderPlayer(empty, INDEX);
    expect(element.textContent).toContain("No daily hand-ins on finished days.");
    expect(element.textContent).toContain("No rushes on finished days.");
    const best = [...element.querySelectorAll(".stat")].find((row) => row.textContent?.startsWith("Best rush"));
    expect(best?.querySelector(".stat__value")?.textContent).toBe("—");
  });
});

describe("the players", () => {
  test("lists every listed player as a link, filtering as the reader types", () => {
    const element = renderPlayers(INDEX);
    const links = () => [...element.querySelectorAll("a.pdb-player")].map((link) => link.getAttribute("href"));
    expect(links()).toEqual([`/player/${ADA.key}`, `/player/${BEA.key}`, `/player/${CY.key}`]);
    expect(element.querySelector("a.pdb-player b")).toBeNull();
    expect(element.textContent).toContain("41 days solved · best streak 21");

    const filter = find(element, '[aria-label="Filter players"]') as HTMLInputElement;
    filter.value = "BE";
    filter.dispatchEvent(new window.Event("input") as unknown as Event);
    expect(links()).toEqual([`/player/${BEA.key}`]);

    filter.value = "nobody";
    filter.dispatchEvent(new window.Event("input") as unknown as Event);
    expect(links()).toEqual([]);
    expect(element.textContent).toContain("No player matches");
  });

  test("says so when nobody is listed yet", () => {
    const element = renderPlayers(indexSiteData({ ...DATA, players: [] }));
    expect(element.textContent).toContain("No players on record yet.");
  });
});
