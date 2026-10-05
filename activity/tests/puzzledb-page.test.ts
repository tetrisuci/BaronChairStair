/**
 * The puzzle database's page: browsing, one puzzle, the days, and moving
 * between them without a reload.
 *
 * Driven the way `tests/review-page.test.ts` drives the review tool. Each view
 * is a function from data to elements with recording handlers, and the board
 * reaches the test through the same `onView` seam the page paints from, so
 * every assertion about a board reads a `BoardView` rather than pixels. The
 * page as a whole is driven too, because it owns the address bar, and that is
 * the half of this site most likely to break quietly: a link that works when
 * clicked and 404s when shared, a click that reloads the page and throws the
 * filter away, or a missing page the server and the browser disagree about.
 *
 * The data is written out by hand rather than built by the server. The page
 * reads `SiteData` from `/puzzles.json` and imports no server module, and a
 * fixture this small names every case it is here for: an unrated puzzle, one
 * with no answer, one whose title is markup, a day that dealt a player's
 * puzzle, and a day that dealt one the archive no longer holds.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";
import { type ArchiveFilter, DEFAULT_ARCHIVE_FILTER, filterArchive } from "../shared/archive-filter";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";
import { BOARD_HEIGHT, COMMUNITY_ID_BASE } from "../shared/puzzle";
import { ApiError } from "../client/src/api";
import type { BoardView } from "../client/src/render/board";
import {
  ALL_SERVERS,
  dateOfDay,
  NOT_FOUND_TEXT,
  pageText,
  SCHEMA_VERSION,
  type SiteData,
  type SiteDay,
  type SiteDayBody,
  type SiteLeaderboardsBody,
  type SitePlayerBody,
  type SitePuzzle,
  type SitePuzzleBody,
  STANDING_BOARDS,
  UNAVAILABLE_TEXT,
} from "../puzzledb/wire";
import type { SitePlayersBody, SiteSolvesBody } from "../puzzledb/wire-profiles";
import { loadBody, loadSiteData } from "../puzzledb/client/api";
import { BoardStage } from "../puzzledb/client/board-stage";
import { createBrowseView } from "../puzzledb/client/browse";
import { indexSiteData, listingOf, readSiteData, type SiteIndex } from "../puzzledb/client/data";
import { createDaysView, createDayView, dealLine } from "../puzzledb/client/days";
import { filterFromQuery, queryFromFilter } from "../puzzledb/client/filter-url";
import { type BodyLoader, SitePage } from "../puzzledb/client/page";
import { createPuzzleView, type PuzzleView } from "../puzzledb/client/puzzle-view";
import { isInternalClick, QUERY_WRITE_MS, REFUSED_RETRY_MS } from "../puzzledb/client/router";

const ORIGIN = "https://db.test";
const MAIN = resolve(import.meta.dir, "../puzzledb/client/main.ts");

// ── The window ───────────────────────────────────────────────────────────────

/**
 * A 2D context that takes every call and draws nothing.
 *
 * happy-dom answers `getContext` with null unless it is handed an adapter, and
 * `BoardRenderer` refuses a canvas without a context. With this the page's own
 * `BoardStage` runs for real — the layout, the sizing, every draw call — and
 * only the pixels are missing, which nothing here could read anyway.
 */
function silentContext(): unknown {
  return new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

let window: Window;
const saved = { document: globalThis.document, window: globalThis.window };

beforeAll(() => {
  // Scoped to this file rather than registered as a preload, for the reason
  // render.test.ts gives: `bun test` shares one process and the server suites
  // lean on Bun's own fetch/Request.
  window = new Window({
    url: `${ORIGIN}/`,
    settings: {
      canvasAdapter: {
        getContext: () => silentContext(),
        toDataURL: () => "",
        toBlob: (_caller: unknown, done: (blob: null) => void) => done(null),
      } as never,
      // A click the page does not take must not become a real navigation: with
      // these off, happy-dom does nothing at all, so "the URL did not change"
      // means the page left the click alone rather than that a fetch failed.
      navigation: {
        disableMainFrameNavigation: true,
        disableChildPageNavigation: true,
        disableFallbackToSetURL: true,
      },
    },
  });
  globalThis.document = window.document as unknown as Document;
  // `BoardRenderer` reads `window.devicePixelRatio`, and the page listens for resizes.
  globalThis.window = window as unknown as typeof globalThis.window;
});

/** Whatever a test opened, so the next one starts with no listeners and an empty body. */
const opened: { stop(): void }[] = [];

afterEach(() => {
  for (const thing of opened.splice(0)) thing.stop();
  window.document.body.replaceChildren();
  window.document.title = "";
});

afterAll(async () => {
  globalThis.document = saved.document;
  globalThis.window = saved.window;
  // happy-dom holds timers, observers and the whole tree until it is told to stop.
  // Without this the window outlives the file and the process has no reason to exit.
  await window.happyDOM.close();
});

// ── The data ─────────────────────────────────────────────────────────────────

function sitePuzzle(over: Partial<SitePuzzle> & Pick<SitePuzzle, "id" | "title">): SitePuzzle {
  return {
    author: "roland", difficulty: 2, tier: "easy", goal: "Send 2.", set: null, board: ["GGGGG.GGGG"],
    queue: ["I"], hold: null, pieces: 1, targetAttack: 2, requiredClears: null, solution: null,
    source: null, puzzleUrl: null, solutionUrl: null,
    ...over,
  };
}

/** Answered, with Blueprint codes. The T fills row 0's hole and clears it. */
const NOTCH = sitePuzzle({
  id: 4, title: "Notch", author: "petra", difficulty: 6, tier: "hard", goal: "Clear a TSD.", set: "Basics",
  board: ["GGG.GGGGGG"], queue: ["T"], targetAttack: 4, requiredClears: [{ clear: "tsd", count: 1 }],
  solution: [{ piece: "T", cells: [[3, 0], [2, 1], [3, 1], [4, 1]], clear: "tsd", attack: 4 }],
  source: { puzzle: "code-a", solution: "code-b" },
  puzzleUrl: "https://bp.tali.software/?code-a",
  solutionUrl: "https://bp.tali.software/?code-b",
});

/** Answered in two placements, with no codes. */
const TWO_STEP = sitePuzzle({
  id: 9, title: "Two step", board: ["GGGG..GGGG"], queue: ["O", "I"], hold: "T", pieces: 3, targetAttack: 0,
  solution: [
    { piece: "O", cells: [[4, 0], [5, 0], [4, 1], [5, 1]], clear: "single", attack: 0 },
    { piece: "I", cells: [[0, 0], [1, 0], [2, 0], [3, 0]], clear: null, attack: 0 },
  ],
});

/** Unrated, unanswered, never dealt — and required to make two TSDs its goal never names. */
const UNRATED = sitePuzzle({
  id: 12, title: "Loose ends", author: "petra", difficulty: null, tier: "hard", goal: "Make it count.",
  set: "Basics", board: ["GGGGGGGG..", "GGGGGGGG.."], queue: ["O", "T", "I"], pieces: 3, targetAttack: 4,
  requiredClears: [{ clear: "tsd", count: 2 }],
});

/** Every field a person typed is markup. */
const MARKUP = sitePuzzle({
  id: 20, title: "<img src=x onerror=alert(1)>", author: "<b>mallory</b>", goal: "<script>alert(2)</script>",
  set: "<i>tricks</i>", difficulty: 3, tier: "medium", queue: ["I", "L"], pieces: 2,
});

/** Nine rows deep and thirteen pieces long. */
const TALL = sitePuzzle({
  id: 33, title: "Long one", difficulty: 14, tier: "extreme", goal: "Clear 3 TSTs.", targetAttack: 12,
  board: Array.from({ length: 9 }, () => "GGGGGGGG.G"),
  queue: ["I", "T", "O", "L", "J", "S", "Z", "I", "T", "O", "L", "J"], hold: "Z", pieces: 13,
  solution: [{ piece: "I", cells: [[8, 0], [8, 1], [8, 2], [8, 3]], clear: "quad", attack: 4 }],
});

/** A club id the archive no longer holds. */
const DEPARTED = 13;

function day(number: number, deals: Readonly<Record<DailyTier, number | null>>): SiteDay {
  const dealt = DAILY_TIERS.map((tier) => ({ tier, puzzleId: deals[tier] }));
  return { day: number, date: dateOfDay(number), deals: dealt };
}

const DATA: SiteData = {
  about: {
    schema: SCHEMA_VERSION,
    // Built from local fields, so the footer's local time reads the same on any machine.
    builtAt: new Date(2026, 9, 2, 12, 5).toISOString(),
    firstDay: 245,
    throughDay: 274,
  },
  puzzles: [NOTCH, TWO_STEP, UNRATED, MARKUP, TALL],
  days: [
    day(251, { easy: TWO_STEP.id, medium: DEPARTED, hard: NOTCH.id, extreme: TALL.id }),
    day(273, { easy: MARKUP.id, medium: TWO_STEP.id, hard: null, extreme: TALL.id }),
    day(274, { easy: TWO_STEP.id, medium: MARKUP.id, hard: NOTCH.id, extreme: TALL.id }),
  ],
  players: [{ key: "adakey2345", name: "ada", daysSolved: 3, bestStreak: 2 }],
  servers: [{ key: "clubkey234", name: "Club One" }],
};

const ADA = { key: "adakey2345", name: "ada" } as const;
const CLUB = DATA.servers[0]!;
const BUILT = DATA.about.builtAt;

function dayBody(number: number, who: { key: string; name: string }): SiteDayBody {
  const marks = { easy: 2, medium: 0, hard: 0, extreme: 0 } as const;
  return {
    builtAt: BUILT,
    day: number,
    boards: { [ALL_SERVERS]: [{ rank: 1, player: who, solved: 1, timeMs: 61_000, marks }] },
    tiers: [{ tier: "easy", rank: 1, serverKey: CLUB.key, player: who, puzzleId: TWO_STEP.id, solved: true, timeMs: 61_000, attack: 2, targetAttack: 2 }],
    rush: [],
  };
}

const LEADERBOARDS: SiteLeaderboardsBody = {
  builtAt: BUILT,
  boards: Object.fromEntries(STANDING_BOARDS.map((board) => [board, { [ALL_SERVERS]: [] }])) as never,
};
const RUSH_RECORDS: SiteLeaderboardsBody = {
  ...LEADERBOARDS,
  boards: {
    ...LEADERBOARDS.boards,
    rush: {
      [ALL_SERVERS]: [{ rank: 1, player: ADA, value: 14, detail: null, timeMs: 291_000, day: 274 }],
      [CLUB.key]: [{ rank: 1, player: null, value: 3, detail: null, timeMs: 99_000, day: 273 }],
    },
  },
};

const ADA_BODY: SitePlayerBody = {
  builtAt: BUILT,
  totals: {
    daysSolved: 3, dailies: 4, currentStreak: 2, bestStreak: 2, puzzlesCleared: 5, linesFound: 1,
    rushRuns: 0, rushBest: null, rushBestMs: null, rushBestDay: null,
  },
  runs: [{ day: 274, tier: "easy", rank: 1, solved: true, timeMs: 61_000, puzzleId: TWO_STEP.id }],
  rush: [],
  tiers: DAILY_TIERS.map((tier) =>
    tier === "easy"
      ? { tier, handIns: 1, solves: 1, bestMs: 61_000, bestDay: 274, medianMs: 61_000 }
      : { tier, handIns: 0, solves: 0, bestMs: null, bestDay: null, medianMs: null },
  ),
  cleared: [TWO_STEP.id],
};

/** The players table: ada's numbers, by key. */
const PLAYERS_BODY: SitePlayersBody = {
  builtAt: BUILT,
  rows: [{ key: ADA.key, puzzlesCleared: 5, linesFound: 1, rushBest: null, rushBestMs: null, servers: [CLUB.key] }],
};

/** The feed's steering: every day in the data had ada's easy solve in Club One (`dayBody`). */
const SOLVES_BODY: SiteSolvesBody = {
  builtAt: BUILT,
  days: [274, 273, 251].map((number) => ({ day: number, tiers: { easy: 1, medium: 0, hard: 0, extreme: 0 }, servers: [CLUB.key] })),
};

const NOTCH_BODY: SitePuzzleBody = {
  builtAt: BUILT,
  stats: { handIns: 4, solves: 1, fastestMs: 61_000, medianMs: 61_000, fastest: ADA },
  lines: [{ position: 1, attack: 4, clears: ["tsd"], steps: NOTCH.solution! }],
};

/** Every body the server would have built for this data, by path: one per day, puzzle and player, and the boards. */
const BODIES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ...DATA.days.map(({ day: number }): [string, unknown] => [`/data/day/${number}.json`, dayBody(number, ADA)]),
  ...DATA.puzzles.map(({ id }): [string, unknown] => [`/data/puzzle/${id}.json`, { builtAt: BUILT, stats: null, lines: [] }]),
  ["/data/puzzle/4.json", NOTCH_BODY],
  ["/data/leaderboards.json", RUSH_RECORDS],
  [`/data/player/${ADA.key}.json`, ADA_BODY],
  ["/data/players.json", PLAYERS_BODY],
  ["/data/solves.json", SOLVES_BODY],
]);

/** The server, as far as bodies go: what it built, and its 404 for anything else. */
const serverBodies: BodyLoader = async (path) => {
  const body = BODIES.get(path);
  if (body === undefined) throw new ApiError("Not found", 404);
  return structuredClone(body);
};

/** A body loader that answers only when a test says so, recording what it was asked. */
function heldBodies() {
  const asked: string[] = [];
  const waiting = new Map<string, { resolve(body: unknown): void; reject(error: unknown): void }>();
  const loader: BodyLoader = (path) =>
    new Promise((resolve, reject) => {
      asked.push(path);
      waiting.set(path, { resolve, reject });
    });
  return { asked, loader, answer: (path: string, body: unknown) => waiting.get(path)!.resolve(body), fail: (path: string, error: unknown) => waiting.get(path)!.reject(error) };
}

/** Lets every promise already settled run its callbacks. */
const settle = () => new Promise((done) => setTimeout(done, 0));

const INDEX: SiteIndex = indexSiteData(DATA);

// ── Driving it ───────────────────────────────────────────────────────────────

function find<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`nothing matched ${selector}`);
  return node as unknown as T;
}

function buttonSaying(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!match) throw new Error(`no button says ${label}`);
  return match as HTMLButtonElement;
}

function linksSaying(root: ParentNode, label: string): HTMLAnchorElement[] {
  return [...root.querySelectorAll("a")].filter((node) => node.textContent === label) as HTMLAnchorElement[];
}

function hrefs(root: ParentNode, selector: string): (string | null)[] {
  return [...root.querySelectorAll(selector)].map((node) => node.getAttribute("href"));
}

/** The result grid's links, in the order shown. The latest-day card links to puzzles too. */
const gridOf = (root: ParentNode) => hrefs(root, ".pdb-grid a.pdb-card");

function typeInto(field: HTMLInputElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new window.Event("input") as unknown as Event);
}

function changeTo(field: HTMLInputElement | HTMLSelectElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new window.Event("change") as unknown as Event);
}

/** The parts of a click the router reads: which button, and which modifiers. */
type ClickInit = Pick<MouseEventInit, "button" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

/** The DOM's own `Window` type: this file's `Window` is happy-dom's class. */
type DomWindow = typeof globalThis.window;

function click(target: Element, init: ClickInit = {}): MouseEvent {
  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(event as unknown as Event);
  return event as unknown as MouseEvent;
}

function press(key: string): void {
  const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  window.document.dispatchEvent(event);
}

function driveBrowse(filter: ArchiveFilter = DEFAULT_ARCHIVE_FILTER, index: SiteIndex = INDEX) {
  const filters: ArchiveFilter[] = [];
  const view = createBrowseView(index, filter, { onFilter: (next) => void filters.push(next) });
  document.body.append(view.element);
  const control = <T extends HTMLElement>(label: string) => find<T>(view.element, `[aria-label="${label}"]`);
  return { element: view.element, view, filters, control };
}

function drivePuzzle(puzzle: SitePuzzle, options: { revealed?: boolean } = {}) {
  const views: BoardView[] = [];
  const onView = (board: BoardView) => void views.push(board);
  const view: PuzzleView = createPuzzleView(puzzle, INDEX, { onView }, options);
  opened.push({ stop: () => view.detach() });
  document.body.append(view.element);
  return { element: view.element, views, view };
}

async function openPage(
  url: string,
  load: () => Promise<SiteData> = () => Promise.resolve(DATA),
  win: DomWindow = window as unknown as DomWindow,
  bodies: BodyLoader = serverBodies,
) {
  window.happyDOM.setURL(url);
  // `setURL` moves the location and leaves the history entry as it was, so
  // Back would return to wherever the previous test left it. This makes the
  // entry the page opens on the address it opens at.
  window.history.replaceState(null, "", url);
  const root = document.createElement("div");
  document.body.append(root);
  const page = new SitePage(root, load, win, bodies);
  opened.push(page);
  await page.start();
  await settle();
  return { root, page };
}

// ── The address bar's clock ──────────────────────────────────────────────────

/** Timers that fire only when a test turns the clock, in the order they fall due. */
interface HandClock {
  readonly setTimeout: (callback: () => void, delay?: number) => number;
  readonly clearTimeout: (id?: number) => void;
  /** Moves time on by `ms`, firing every timer that falls due on the way. */
  advance(ms: number): void;
  /** How many timers are still waiting to fire. */
  pending(): number;
}

function handClock(): HandClock {
  let now = 0;
  let lastId = 0;
  const waiting = new Map<number, { readonly at: number; readonly callback: () => void }>();
  // The earliest timer due by `until`; of two due together, the one set first, as a browser fires them.
  const firstDue = (until: number) =>
    [...waiting].filter(([, timer]) => timer.at <= until).sort(([a, x], [b, y]) => x.at - y.at || a - b)[0];
  return {
    setTimeout: (callback, delay = 0) => {
      waiting.set(++lastId, { at: now + delay, callback });
      return lastId;
    },
    clearTimeout: (id) => {
      if (id !== undefined) waiting.delete(id);
    },
    advance(ms) {
      const until = now + ms;
      for (let due = firstDue(until); due; due = firstDue(until)) {
        const [id, timer] = due;
        waiting.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = until;
    },
    pending: () => waiting.size,
  };
}

/**
 * This file's window, with a hand-turned clock for its timers.
 *
 * The page is handed this in place of the window itself, so the router's
 * held-back address write runs when a test turns the clock rather than after a
 * real quarter-second, and an error thrown from it reaches the test, where
 * happy-dom's own timers would catch it and report it as a window event.
 * Everything else is the window's own, bound to it, so the history, the
 * location and every listener are the real ones.
 */
function windowOn(clock: HandClock): DomWindow {
  const timers: Readonly<Record<PropertyKey, unknown>> = {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  return new Proxy(window, {
    get(target, key) {
      if (key in timers) return timers[key];
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as DomWindow;
}

/**
 * Every address write the page makes from here on, as `replaceState /?q=two`,
 * and a switch per method that refuses it the way WebKit does past a hundred
 * in ten seconds: a SecurityError thrown from the call. The window's own
 * methods are put back after the test.
 */
function recordHistory() {
  const history = window.history;
  const writes: string[] = [];
  const refusing = { pushState: false, replaceState: false };
  for (const method of ["pushState", "replaceState"] as const) {
    const real = history[method];
    Object.defineProperty(history, method, {
      configurable: true,
      value: (...args: Parameters<typeof real>) => {
        if (refusing[method]) {
          const message = `Attempt to use history.${method}() more than 100 times per 10 seconds`;
          throw new window.DOMException(message, "SecurityError");
        }
        const url = new URL(String(args[2]), window.location.href);
        writes.push(`${method} ${url.pathname}${url.search}`);
        real.apply(history, args);
      },
    });
  }
  opened.push({
    stop: () => {
      Reflect.deleteProperty(history, "pushState");
      Reflect.deleteProperty(history, "replaceState");
    },
  });
  return { writes, refusing };
}

/**
 * Everything a listener throws from here on. A browser does not let it reach
 * whoever dispatched the event, and neither does happy-dom: it reports it as
 * an `error` event on the window, so that event is where an escape shows.
 */
function errorsReported(): readonly unknown[] {
  const errors: unknown[] = [];
  const listener = (event: { readonly error?: unknown }) => void errors.push(event.error);
  window.addEventListener("error", listener as never);
  opened.push({ stop: () => window.removeEventListener("error", listener as never) });
  return errors;
}

/** The page on a hand-turned clock, recording its address writes and anything its listeners throw. */
async function openOnClock(url: string, bodies: BodyLoader = serverBodies) {
  const clock = handClock();
  const { root, page } = await openPage(url, undefined, windowOn(clock), bodies);
  return { root, page, clock, errors: errorsReported(), ...recordHistory() };
}

// ── The tests ────────────────────────────────────────────────────────────────

describe("the data", () => {
  test("refuses a payload without about, puzzles and days", () => {
    for (const payload of [
      null, "<!doctype html>", [], {}, { puzzles: [], days: [] }, { about: null, puzzles: [], days: [] },
      { about: {}, puzzles: {}, days: [] }, { about: {}, puzzles: [], days: "274" },
      { about: {}, puzzles: [], days: [], players: [] }, { about: {}, puzzles: [], days: [], players: [], servers: {} },
    ]) {
      expect(() => readSiteData(payload)).toThrow();
    }
    expect(readSiteData(JSON.parse(JSON.stringify(DATA)))).toEqual(DATA);
  });

  test("reads /puzzles.json, and turns a failure into the server's own words", async () => {
    const asked: string[] = [];
    const answering = (response: () => Response) => async (input: string) => {
      asked.push(input);
      return response();
    };

    expect(await loadSiteData(answering(() => Response.json(DATA)))).toEqual(DATA);
    expect(asked).toEqual(["/puzzles.json"]);

    const refusal = (pending: Promise<unknown>) => pending.then(() => null, (error: ApiError) => error);
    const busy = { error: "The puzzle archive is not available yet. Try again in a minute." };
    const unavailable = await refusal(loadSiteData(answering(() => Response.json(busy, { status: 503 }))));
    expect(unavailable).toEqual(new ApiError(busy.error, 503));
    expect(unavailable?.status).toBe(503);

    const offline = await refusal(loadSiteData(() => Promise.reject(new TypeError("Failed to fetch"))));
    expect(offline).toBeInstanceOf(ApiError);
    expect(offline?.status).toBe(0);

    // A proxy's HTML error page, or a body that is JSON but not the archive.
    const proxyPage = () => new Response("<html>", { status: 502 });
    await expect(loadSiteData(answering(proxyPage))).rejects.toThrow(ApiError);
    await expect(loadSiteData(answering(() => Response.json({ puzzles: [] })))).rejects.toThrow();
  });

  test("reads a body from its own path, and turns a miss into a 404 the page can recognise", async () => {
    const asked: string[] = [];
    const fetcher = async (input: string) => {
      asked.push(input);
      return input === "/data/leaderboards.json" ? Response.json(LEADERBOARDS) : Response.json({ error: "Not found" }, { status: 404 });
    };
    expect(await loadBody("/data/leaderboards.json", fetcher)).toEqual(LEADERBOARDS);
    const miss = await loadBody("/data/player/zzzzzzzzzz.json", fetcher).then(() => null, (error: ApiError) => error);
    expect(miss).toEqual(new ApiError("Not found", 404));
    expect(miss?.status).toBe(404);
    expect(asked).toEqual(["/data/leaderboards.json", "/data/player/zzzzzzzzzz.json"]);
  });

  test("adapts a puzzle to the shared filter without losing unrated puzzles", () => {
    const listing = listingOf(UNRATED);

    // The shared filter reads unrated as 0 and has no idea what null is: fed
    // null, `null < minDifficulty` holds and every unrated puzzle silently drops.
    expect(listing.difficulty).toBe(0);
    expect(listing.pieces).toBe(UNRATED.pieces);
    expect(listing.community).toBe(false);
    expect(listingOf({ ...UNRATED, id: COMMUNITY_ID_BASE }).community).toBe(true);

    expect(filterArchive([listing], DEFAULT_ARCHIVE_FILTER)).toEqual([listing]);
    expect(filterArchive([listing], { ...DEFAULT_ARCHIVE_FILTER, includeUnrated: false })).toEqual([]);
  });
});

describe("browsing", () => {
  test("shows every puzzle as a card with its board, number, title, rating and length", () => {
    const { element } = driveBrowse();
    const cards = [...element.querySelectorAll(".pdb-grid a.pdb-card")];

    expect(cards).toHaveLength(DATA.puzzles.length);
    const notch = cards[0]!;
    expect(notch.querySelector("svg")).not.toBeNull();
    for (const part of ["#4", "Notch", "d6 · 1p", "petra"]) expect(notch.textContent).toContain(part);
    expect(cards[2]!.textContent).toContain("unrated · 3p");
  });

  test("links each card to its puzzle", () => {
    const every = ["/puzzle/4", "/puzzle/9", "/puzzle/12", "/puzzle/20", "/puzzle/33"];
    expect(gridOf(driveBrowse().element)).toEqual(every);
  });

  test("narrows by search across title, author, goal and set", () => {
    const { element, control, filters } = driveBrowse();
    const search = control<HTMLInputElement>("Search puzzles");

    typeInto(search, "notch");
    expect(gridOf(element)).toEqual(["/puzzle/4"]);
    expect(filters.at(-1)).toEqual({ ...DEFAULT_ARCHIVE_FILTER, search: "notch" });
    typeInto(search, "roland");
    expect(gridOf(element)).toEqual(["/puzzle/9", "/puzzle/33"]);
    typeInto(search, "count");
    expect(gridOf(element)).toEqual(["/puzzle/12"]);
    typeInto(search, "basics");
    expect(gridOf(element)).toEqual(["/puzzle/4", "/puzzle/12"]);
  });

  test("filters by difficulty and length, keeping unrated puzzles unless told not to", () => {
    const { element, control } = driveBrowse();

    changeTo(control<HTMLInputElement>("Lowest difficulty"), "5");
    expect(gridOf(element)).toEqual(["/puzzle/4", "/puzzle/12", "/puzzle/33"]);

    const unrated = buttonSaying(element, "Unrated ON");
    unrated.click();
    expect(gridOf(element)).toEqual(["/puzzle/4", "/puzzle/33"]);
    expect(unrated.textContent).toBe("Unrated OFF");
    expect(unrated.getAttribute("aria-pressed")).toBe("false");

    changeTo(control<HTMLInputElement>("Fewest pieces"), "10");
    expect(gridOf(element)).toEqual(["/puzzle/33"]);
  });

  test("filters by set and author", () => {
    const { element, control } = driveBrowse();
    const set = control<HTMLSelectElement>("Set");
    const author = control<HTMLSelectElement>("Author");

    // Filled from the data, and from nothing else.
    expect([...set.options].map((option) => option.value)).toEqual(["", "<i>tricks</i>", "Basics"]);
    changeTo(set, "Basics");
    expect(gridOf(element)).toEqual(["/puzzle/4", "/puzzle/12"]);

    changeTo(set, "");
    changeTo(author, "roland");
    expect(gridOf(element)).toEqual(["/puzzle/9", "/puzzle/33"]);
  });

  test("says how many match, and says so when nothing does", () => {
    const { element, control } = driveBrowse();
    const count = () => find(element, ".explore__count").textContent;

    expect(count()).toBe("All 5 puzzles");
    typeInto(control<HTMLInputElement>("Search puzzles"), "petra");
    expect(count()).toBe("2 of 5 puzzles match your filters");

    typeInto(control<HTMLInputElement>("Search puzzles"), "nothing is called this");
    expect(count()).toBe("0 of 5 puzzles match your filters");
    expect(gridOf(element)).toEqual([]);
    expect(element.textContent).toContain("Nothing matches. Widen the range, or clear the filters.");

    buttonSaying(element, "Clear filters").click();
    expect(count()).toBe("All 5 puzzles");
    expect(gridOf(element)).toHaveLength(5);
  });

  test("keeps the filter in the address and reads it back, sanitizing junk", async () => {
    const filter: ArchiveFilter = {
      search: "tsd spin", minDifficulty: 3, maxDifficulty: 7, includeUnrated: false, minPieces: 2,
      maxPieces: 9, sets: ["Basics"], authors: ["petra"], sort: "title",
    };
    const query = queryFromFilter(filter);
    expect(query).toBe("?q=tsd+spin&d=3-7&u=0&p=2-9&set=Basics&by=petra&sort=title");
    expect(filterFromQuery(query)).toEqual(filter);

    // The everyday address is the bare one, both ways.
    expect(queryFromFilter(DEFAULT_ARCHIVE_FILTER)).toBe("");
    expect(filterFromQuery("")).toEqual(DEFAULT_ARCHIVE_FILTER);
    expect(queryFromFilter({ ...DEFAULT_ARCHIVE_FILTER, sort: "pieces" })).toBe("?sort=pieces");

    // Junk is read the way the game reads a stored filter: clamped, swapped round or dropped.
    expect(filterFromQuery(`?d=abc&p=12-3&u=maybe&sort=random&q=${"x".repeat(80)}`)).toEqual({
      ...DEFAULT_ARCHIVE_FILTER,
      search: "x".repeat(64), minPieces: 3, maxPieces: 12,
    });
    expect(filterFromQuery("?d=0-99&p=-4")).toEqual(DEFAULT_ARCHIVE_FILTER);

    // And the page keeps the address in step without adding a history entry per keystroke.
    const { root, clock } = await openOnClock(`${ORIGIN}/?by=roland&sort=title`);
    expect(gridOf(root)).toEqual(["/puzzle/33", "/puzzle/9"]);
    expect(find<HTMLInputElement>(root, '[aria-label="Author"]').value).toBe("roland");
    const entries = window.history.length;
    typeInto(find<HTMLInputElement>(root, '[aria-label="Search puzzles"]'), "two");
    clock.advance(QUERY_WRITE_MS);
    expect(window.location.search).toBe("?q=two&by=roland&sort=title");
    expect(window.history.length).toBe(entries);
    expect(gridOf(root)).toEqual(["/puzzle/9"]);
  });

  test("sets author-typed text as text, never markup", () => {
    const browse = driveBrowse().element;
    const puzzle = drivePuzzle(MARKUP).element;
    const days = createDaysView(INDEX);
    const oneDay = createDayView(DATA.days[1]!, INDEX);

    for (const root of [browse, puzzle, days, oneDay]) {
      // Tag names, not the elements: a failure should say what was made, not print a DOM.
      expect([...root.querySelectorAll("img, b, i, script")].map((node) => node.tagName)).toEqual([]);
      expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    }
    for (const typed of ["<b>mallory</b>", "<script>alert(2)</script>", "<i>tricks</i>"]) {
      expect(puzzle.textContent).toContain(typed);
    }
  });

  test("leads with the latest finished day", () => {
    const { element } = driveBrowse();
    // The first card on the page, above the filters.
    const [latest, filters] = [...element.querySelectorAll(".panel")];
    expect(filters!.querySelector(".explore__filters")).not.toBeNull();

    expect(latest!.textContent).toContain("Day 274 · Thu, Oct 1, 2026");
    expect(hrefs(latest!, "a")).toEqual(
      expect.arrayContaining(["/puzzle/9", "/puzzle/20", "/puzzle/4", "/puzzle/33", "/days"]),
    );
    expect(latest!.querySelectorAll("svg")).toHaveLength(4);

    // No finished day yet: no card, rather than a card about nothing.
    const fresh = driveBrowse(DEFAULT_ARCHIVE_FILTER, indexSiteData({ ...DATA, days: [] })).element;
    expect(fresh.textContent).not.toContain("Day 274");
    expect(gridOf(fresh)).toHaveLength(5);
  });
});

describe("one puzzle", () => {
  test("draws the bare board until the answer is asked for", () => {
    const { element, views } = drivePuzzle(NOTCH);

    // Not the answer's first frame: at position 0 `SolutionPlayer` already
    // draws placement one in place and placement two as a ghost.
    expect(views).toHaveLength(1);
    expect(views[0]!.active).toEqual([]);
    expect(views[0]!.ghost).toEqual([]);
    expect(views[0]!.cells[0]).toEqual(["G", "G", "G", null, "G", "G", "G", "G", "G", "G"]);
    expect(element.querySelector(".replay")).toBeNull();
    expect(buttonSaying(element, "Show the answer").className).toContain("btn--primary");
  });

  test("steps the answer once Show the answer is pressed", () => {
    const { element, views, view } = drivePuzzle(TWO_STEP);
    const steps = TWO_STEP.solution!;

    buttonSaying(element, "Show the answer").click();
    expect(element.querySelector(".replay")).not.toBeNull();
    expect(() => buttonSaying(element, "Show the answer")).toThrow();
    expect(views.at(-1)!.active).toEqual(steps[0]!.cells);

    press("ArrowRight");
    expect(views.at(-1)!.active).toEqual(steps[1]!.cells);

    // Detached, the keys are the document's again.
    view.detach();
    const seen = views.length;
    press("ArrowRight");
    expect(views).toHaveLength(seen);
  });

  test("opens the answer on arrival when the address ends in #answer", async () => {
    const { element, views } = drivePuzzle(TWO_STEP, { revealed: true });
    expect(element.querySelector(".replay")).not.toBeNull();
    expect(views.at(-1)!.active).toEqual(TWO_STEP.solution![0]!.cells);

    const { root } = await openPage(`${ORIGIN}/puzzle/9#answer`);
    expect(root.querySelector(".replay")).not.toBeNull();
    const { root: plain } = await openPage(`${ORIGIN}/puzzle/9`);
    expect(plain.querySelector(".replay")).toBeNull();
  });

  test("says so when no answer is on file, with nothing to press", () => {
    for (const revealed of [false, true]) {
      const { element } = drivePuzzle(UNRATED, { revealed });
      expect(element.textContent).toContain("No answer on file for this puzzle.");
      expect(element.querySelector("button")).toBeNull();
      expect(element.querySelector(".replay")).toBeNull();
    }
  });

  test("links to Blueprint only when the puzzle has codes, and to the answer only once it is shown", () => {
    const { element } = drivePuzzle(NOTCH);
    const [puzzleLink] = linksSaying(element, "Open the puzzle in Blueprint");
    expect(puzzleLink?.getAttribute("href")).toBe(NOTCH.puzzleUrl);
    expect(puzzleLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(linksSaying(element, "Open the answer in Blueprint")).toHaveLength(0);

    buttonSaying(element, "Show the answer").click();
    const [answerLink] = linksSaying(element, "Open the answer in Blueprint");
    expect(answerLink?.getAttribute("href")).toBe(NOTCH.solutionUrl);
    expect(answerLink?.getAttribute("rel")).toBe("noopener noreferrer");

    const plain = drivePuzzle(TWO_STEP).element;
    buttonSaying(plain, "Show the answer").click();
    expect(plain.querySelector('a[href^="https://bp.tali.software"]')).toBeNull();
  });

  test("never shows the required clears", () => {
    // The game shows them only under GOAL_ENFORCEMENT=on, which is the owner's call.
    const { element } = drivePuzzle(UNRATED);
    expect(element.textContent).toContain("Make it count.");
    expect(element.textContent?.toLowerCase()).not.toContain("tsd");
  });

  test("lists the finished days it was dealt, newest first, as links", () => {
    const { element } = drivePuzzle(TWO_STEP);
    const days = [...element.querySelectorAll('a[href^="/day/"]')];

    expect(days.map((link) => link.getAttribute("href"))).toEqual(["/day/274", "/day/273", "/day/251"]);
    expect(days[0]!.textContent).toBe("Day 274 · Thu, Oct 1, 2026 — easy");
    expect(days[1]!.textContent).toBe("Day 273 · Wed, Sep 30, 2026 — medium");

    const never = drivePuzzle(UNRATED).element;
    expect(never.querySelector('a[href^="/day/"]')).toBeNull();
    expect(never.textContent).toContain("Not dealt on any finished day yet.");
  });

  test("links the puzzles either side of it by number", () => {
    const { element } = drivePuzzle(UNRATED);
    expect(hrefs(element, ".pdb-pager a")).toEqual(["/puzzle/9", "/puzzle/20"]);
    expect(hrefs(drivePuzzle(NOTCH).element, ".pdb-pager a")).toEqual(["/puzzle/9"]);
  });

  test("shows the whole twenty-row field, however shallow the board", () => {
    expect(drivePuzzle(TALL).views[0]!.visibleRows).toBe(BOARD_HEIGHT);
    expect(drivePuzzle(NOTCH).views[0]!.visibleRows).toBe(BOARD_HEIGHT);
  });

  test("sizes the canvas to those rows, whenever the board or the canvas arrives first", () => {
    const rowsOf = (visibleRows: number): BoardView => ({ ...drivePuzzle(NOTCH).views[0]!, visibleRows });
    const stage = new BoardStage({ innerHeight: 900 });
    const canvas = document.createElement("canvas");
    document.body.append(canvas);

    stage.show(rowsOf(BOARD_HEIGHT / 2));
    expect(canvas.style.height).toBe("");
    stage.attach(canvas);
    const short = Number.parseFloat(canvas.style.height);
    stage.show(rowsOf(BOARD_HEIGHT));
    const tall = Number.parseFloat(canvas.style.height);

    expect(short).toBeGreaterThan(0);
    expect(tall).toBeGreaterThan(short);
  });
});

describe("the days", () => {
  test("lists finished days newest first, tiers in daily order", () => {
    const element = createDaysView(INDEX);
    const rows = [...element.querySelectorAll(".pdb-day")];

    const linked = rows.map((row) => row.querySelector("a")?.getAttribute("href"));
    expect(linked).toEqual(["/day/274", "/day/273", "/day/251"]);
    expect(rows[0]!.querySelector("a")?.textContent).toBe("Day 274 · Thu, Oct 1, 2026");
    expect([...rows[0]!.querySelectorAll(".pdb-deal-line")].map((line) => line.textContent)).toEqual([
      "easy · #9 Two step",
      "medium · #20 <img src=x onerror=alert(1)>",
      "hard · #4 Notch",
      "extreme · #33 Long one",
    ]);
    expect(element.textContent).toContain(
      "Puzzles are shown as they are now; one edited since may differ from what that day dealt.",
    );
  });

  test("names a player-written deal without a link, and a departed puzzle by number", () => {
    const written = dealLine({ tier: "hard", puzzleId: null }, INDEX);
    expect(written.textContent).toBe("hard · a puzzle written by a player (not listed here)");
    expect(written.querySelector("a")).toBeNull();

    const departed = dealLine({ tier: "medium", puzzleId: DEPARTED }, INDEX);
    expect(departed.textContent).toBe("medium · #13 (no longer in the archive)");
    expect(departed.querySelector("a")).toBeNull();

    const listed = dealLine({ tier: "easy", puzzleId: TWO_STEP.id }, INDEX);
    expect(hrefs(listed, "a")).toEqual(["/puzzle/9"]);
  });

  test("says so when no day has finished yet", () => {
    const element = createDaysView(indexSiteData({ ...DATA, days: [] }));
    expect(element.textContent).toContain("No finished days on record yet.");
    expect(element.querySelector(".pdb-day")).toBeNull();
  });

  test("shows one day's tiers with their boards, each linking to its answer", () => {
    const element = createDayView(DATA.days[2]!, INDEX);

    expect(find(element, "h1").textContent).toBe("Day 274");
    expect(element.textContent).toContain("Thu, Oct 1, 2026");
    const cards = [...element.querySelectorAll(".pdb-deal")];
    expect(cards.map((card) => card.querySelector(".label")?.textContent)).toEqual([...DAILY_TIERS]);
    expect(cards.every((card) => card.querySelector("svg"))).toBe(true);
    // Every listed tier opens; only those with an answer offer one.
    const targets = (label: string) => linksSaying(element, label).map((link) => link.getAttribute("href"));
    expect(targets("Open")).toEqual(["/puzzle/9", "/puzzle/20", "/puzzle/4", "/puzzle/33"]);
    expect(targets("See the answer")).toEqual(["/puzzle/9#answer", "/puzzle/4#answer", "/puzzle/33#answer"]);
    // The recorded days either side, and nothing past the newest.
    expect(hrefs(element, ".pdb-pager a")).toEqual(["/day/273"]);
    expect(hrefs(createDayView(DATA.days[1]!, INDEX), ".pdb-pager a")).toEqual(["/day/251", "/day/274"]);
  });

  test("shows a player's deal and a departed one on the day without boards or links", () => {
    const cards = [...createDayView(DATA.days[0]!, INDEX).querySelectorAll(".pdb-deal")];
    expect(cards[1]!.textContent).toContain("#13 (no longer in the archive)");
    expect(cards[1]!.querySelector("a, svg")).toBeNull();

    const written = [...createDayView(DATA.days[1]!, INDEX).querySelectorAll(".pdb-deal")][2]!;
    expect(written.textContent).toContain("a puzzle written by a player");
    expect(written.querySelector("a, svg")).toBeNull();
  });
});

describe("the page", () => {
  test("routes by path and navigates without reloading", async () => {
    const { root } = await openPage(`${ORIGIN}/`);
    const entries = window.history.length;

    const event = click(find(root, '.pdb-grid a[href="/puzzle/4"]'));
    expect(event.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe("/puzzle/4");
    expect(window.history.length).toBe(entries + 1);
    expect(find(root, "h1").textContent).toContain("Notch");
    // The same document, still mounted: nothing reloaded.
    expect(root.isConnected).toBe(true);

    window.history.back();
    await new Promise((settle) => setTimeout(settle, 0));
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(gridOf(root)).toHaveLength(5);
  });

  test("intercepts only plain left clicks on internal links", async () => {
    const link = (href: string, attributes: Readonly<Record<string, string>> = {}) => {
      const anchor = document.createElement("a");
      anchor.setAttribute("href", href);
      for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
      return anchor;
    };
    const plain = (init: ClickInit = {}) => {
      const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
      return event as unknown as MouseEvent;
    };

    for (const href of ["/puzzle/4", "/day/274", "/days", "/?q=tsd", `${ORIGIN}/puzzle/4#answer`]) {
      expect(isInternalClick(plain(), link(href), ORIGIN)).toBe(true);
    }
    const modifiers: ClickInit[] = [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }];
    for (const init of [...modifiers, { altKey: true }, { button: 1 }]) {
      expect(isInternalClick(plain(init), link("/puzzle/4"), ORIGIN)).toBe(false);
    }
    // A page's own path, so the attribute alone is what turns each of these away.
    expect(isInternalClick(plain(), link("/puzzle/4", { target: "_blank" }), ORIGIN)).toBe(false);
    expect(isInternalClick(plain(), link("/puzzle/4", { target: "_self" }), ORIGIN)).toBe(true);
    expect(isInternalClick(plain(), link("/puzzle/4", { download: "" }), ORIGIN)).toBe(false);
    // Another origin, and paths on this one that are files rather than pages.
    const elsewhere = ["https://bp.tali.software/?code-a", "https://other.test/puzzle/4"];
    for (const href of [...elsewhere, "/puzzles.json", "/puzzle/007"]) {
      expect(isInternalClick(plain(), link(href), ORIGIN)).toBe(false);
    }

    // And the page itself leaves a modified click to the browser.
    const { root } = await openPage(`${ORIGIN}/`);
    const event = click(find(root, '.pdb-grid a[href="/puzzle/4"]'), { ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe("/");
  });

  test("names the page in the document title", async () => {
    const { root } = await openPage(`${ORIGIN}/puzzle/4`);
    expect(document.title).toBe("#4 Notch — Puzzle archive");
    expect(document.title).toBe(pageText({ kind: "puzzle", id: 4 }, INDEX.lookup)!.title);

    click(linksSaying(root, "Days")[0]!);
    expect(document.title).toBe("Daily history — Puzzle archive");
    click(find(root, 'a[href="/day/274"]'));
    expect(document.title).toBe("Day 274 · Thu, Oct 1, 2026 — Puzzle archive");
  });

  test("answers a page that is not on the site exactly as the server does", async () => {
    for (const [path, sentence] of [
      ["/puzzle/13", "No puzzle #13 here"],
      ["/day/275", "Day 275 is not on this site"],
      ["/puzzle/007", "No such page"],
      ["/days/", "No such page"],
      ["/player/zzzzzzzzzz", "No such page"],
    ] as const) {
      const { root } = await openPage(`${ORIGIN}${path}`);
      expect(document.title).toBe(NOT_FOUND_TEXT.title);
      expect(root.textContent).toContain(sentence);
      expect(hrefs(find(root, "main"), "a")).toContain("/");
    }
  });

  test("carries Leaderboards and Players in the header, each marked on its own page", async () => {
    const { root } = await openPage(`${ORIGIN}/leaderboards`);
    expect(document.title).toBe("Leaderboards — Puzzle archive");
    const nav = (label: string) => linksSaying(find(root, "nav.pdb-nav"), label)[0]!;
    expect(nav("Leaderboards").getAttribute("href")).toBe("/leaderboards");
    expect(nav("Leaderboards").getAttribute("aria-current")).toBe("page");

    click(nav("Players"));
    expect(document.title).toBe("Players — Puzzle archive");
    expect(nav("Players").getAttribute("aria-current")).toBe("page");
    expect(nav("Leaderboards").hasAttribute("aria-current")).toBe(false);
    expect(find(root, "footer").textContent).toContain("Player names as the game shows them.");

    // The feed comes after Players, and is marked on its own page as they are.
    expect(linksSaying(find(root, "nav.pdb-nav"), "Solves")).toHaveLength(1);
    click(nav("Solves"));
    expect(document.title).toBe("Recent solves — Puzzle archive");
    expect(nav("Solves").getAttribute("href")).toBe("/solves");
    expect(nav("Solves").getAttribute("aria-current")).toBe("page");
    expect(nav("Players").hasAttribute("aria-current")).toBe(false);
  });

  test("carries the downloads, and how fresh the data is, on every page", async () => {
    const { root } = await openPage(`${ORIGIN}/days`);
    const download = linksSaying(root, "Download SQLite")[0]!;

    expect(download.getAttribute("href")).toBe("/puzzles.sqlite");
    expect(download.hasAttribute("download")).toBe(true);
    expect(linksSaying(root, "JSON")[0]?.getAttribute("href")).toBe("/puzzles.json");
    expect(find(root, "footer").textContent).toContain("Data as of 2026-10-02 12:05 · finished days 245–274");
  });

  test("shows the unavailable message when the data cannot be loaded", async () => {
    const logged: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const failed = () => Promise.reject(new ApiError("The puzzle archive is not available yet.", 503));
      const { root } = await openPage(`${ORIGIN}/puzzle/4`, failed);

      expect(root.textContent).toContain(UNAVAILABLE_TEXT.description);
      expect(document.title).toBe(UNAVAILABLE_TEXT.title);
      expect(String(logged[0]?.[0])).toStartWith("[puzzledb]");
    } finally {
      console.error = error;
    }
  });

  test("scrolls as a document", () => {
    // The stylesheets main.ts imports, in the order it imports them: tokens.css
    // hides the body's overflow for the game, and only a later rule undoes it.
    const sheets = [...readFileSync(MAIN, "utf8").matchAll(/^import "(.+\.css)";$/gm)].map((match) => {
      const style = document.createElement("style");
      style.textContent = readFileSync(resolve(dirname(MAIN), match[1]!), "utf8");
      document.head.append(style);
      return style;
    });
    try {
      expect(sheets.length).toBeGreaterThanOrEqual(4);
      // The shorthand: happy-dom keeps `overflow` as written rather than splitting it.
      expect(window.getComputedStyle(window.document.body).overflow).toBe("auto");
    } finally {
      for (const sheet of sheets) sheet.remove();
    }
  });
});

describe("the bodies", () => {
  test("draws what the index can at once, and the rest when the page's own body arrives", async () => {
    const held = heldBodies();
    const { root } = await openPage(`${ORIGIN}/day/274`, undefined, undefined, held.loader);

    expect(held.asked).toEqual(["/data/day/274.json"]);
    expect(root.querySelectorAll(".pdb-deal")).toHaveLength(4);
    expect(root.querySelector(".pdb-day-boards")).toBeNull();
    expect(root.textContent).toContain("Reading the records");

    held.answer("/data/day/274.json", dayBody(274, ADA));
    await settle();
    expect(root.querySelector(".pdb-day-boards")).not.toBeNull();
    expect(root.textContent).not.toContain("Reading the records");
    expect(hrefs(find(root, ".pdb-day-boards"), ".pdb-row a")).toContain(`/player/${ADA.key}`);
  });

  test("asks for no body on a page the index draws alone, and keeps a body for the rest of the visit", async () => {
    const asked: string[] = [];
    const counting: BodyLoader = (path) => {
      asked.push(path);
      return serverBodies(path);
    };
    const { root } = await openPage(`${ORIGIN}/days`, undefined, undefined, counting);
    expect(asked).toEqual([]);

    // The players table is a body page now: its numbers are one body, asked for once a visit.
    click(find(root, 'nav.pdb-nav a[href="/players"]'));
    await settle();
    expect(asked).toEqual(["/data/players.json"]);
    expect(hrefs(root, "a.pdb-player-link")).toEqual([`/player/${ADA.key}`]);

    click(find(root, "a.pdb-player-link"));
    await settle();
    expect(document.title).toBe("ada — Puzzle archive");
    expect(root.textContent).toContain("Puzzles cleared");
    window.history.back();
    await settle();
    expect(hrefs(root, "a.pdb-player-link")).toEqual([`/player/${ADA.key}`]);
    window.history.forward();
    await settle();
    expect(asked).toEqual(["/data/players.json", `/data/player/${ADA.key}.json`]);
  });

  test("feeds /solves from its steering and the day bodies, each kept for the rest of the visit", async () => {
    const asked: string[] = [];
    const counting: BodyLoader = (path) => {
      asked.push(path);
      return serverBodies(path);
    };
    const { root } = await openPage(`${ORIGIN}/solves`, undefined, undefined, counting);
    await settle();
    expect(document.title).toBe("Recent solves — Puzzle archive");
    expect(asked).toEqual(["/data/solves.json", "/data/day/274.json", "/data/day/273.json", "/data/day/251.json"]);
    expect(root.querySelectorAll(".pdb-feed-day")).toHaveLength(3);
    expect(hrefs(root, ".pdb-feed-row a[href^='/player/']")).toContain(`/player/${ADA.key}`);

    // The day the feed already read draws from this visit's copy.
    click(find(root, '.pdb-feed-day__head a[href="/day/274"]'));
    await settle();
    expect(root.querySelector(".pdb-day-boards")).not.toBeNull();
    expect(asked).toHaveLength(4);
  });

  test("stops the feed's press once the reader leaves /solves, asking for no further day", async () => {
    const held = heldBodies();
    const { root } = await openPage(`${ORIGIN}/solves?server=${CLUB.key}&tier=easy`, undefined, undefined, held.loader);
    // Twenty days the steering cannot rule out, none of which will draw.
    const days = Array.from({ length: 20 }, (_, at) => 274 - at);
    const steering: SiteSolvesBody = {
      builtAt: BUILT,
      days: days.map((day) => ({ day, tiers: { easy: 1, medium: 0, hard: 0, extreme: 0 }, servers: [CLUB.key] })),
    };
    held.answer("/data/solves.json", steering);
    await settle();
    const firstBatch = held.asked.filter((path) => path.startsWith("/data/day/"));
    expect(firstBatch).toHaveLength(7);

    click(find(root, 'nav.pdb-nav a[href="/days"]'));
    await settle();
    for (const path of firstBatch) {
      const day = Number(path.split("/")[3]!.split(".")[0]);
      held.answer(path, { ...dayBody(day, ADA), tiers: [] });
    }
    await settle();
    expect(held.asked.filter((path) => path.startsWith("/data/day/"))).toEqual(firstBatch);
  });

  test("drops a body that arrives after the reader has moved on", async () => {
    const held = heldBodies();
    const { root } = await openPage(`${ORIGIN}/day/274`, undefined, undefined, held.loader);
    click(find(root, '.pdb-pager a[href="/day/273"]'));
    held.answer("/data/day/273.json", dayBody(273, { key: ADA.key, name: "on time" }));
    held.answer("/data/day/274.json", dayBody(274, { key: ADA.key, name: "too late" }));
    await settle();

    expect(find(root, "h1").textContent).toBe("Day 273");
    expect(root.textContent).toContain("on time");
    expect(root.textContent).not.toContain("too late");
  });

  /**
   * The answers above that can hurt: a stale miss would replace the page now on
   * screen with "No such page", and a stale failure would put a "Couldn't load"
   * note on it, though nothing the reader is looking at failed. A stale success
   * only fills a slot that is no longer in the document, so it cannot show
   * whether the guard holds. The miss can, on screen; the failure's note goes
   * to that same detached slot, so it shows in the console it reports to.
   */
  test("drops a miss that arrives after the reader has moved on", async () => {
    const held = heldBodies();
    const { root } = await openPage(`${ORIGIN}/day/274`, undefined, undefined, held.loader);
    click(find(root, '.pdb-pager a[href="/day/273"]'));
    held.answer("/data/day/273.json", dayBody(273, { key: ADA.key, name: "on time" }));
    held.fail("/data/day/274.json", new ApiError("Not found", 404));
    await settle();

    expect(find(root, "h1").textContent).toBe("Day 273");
    expect(document.title).not.toBe(NOT_FOUND_TEXT.title);
    expect(root.querySelector(".pdb-day-boards")).not.toBeNull();
    expect(root.textContent).toContain("on time");
  });

  test("drops a failure that arrives after the reader has moved on", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const held = heldBodies();
      const { root } = await openPage(`${ORIGIN}/day/274`, undefined, undefined, held.loader);
      click(find(root, '.pdb-pager a[href="/day/273"]'));
      held.answer("/data/day/273.json", dayBody(273, { key: ADA.key, name: "on time" }));
      held.fail("/data/day/274.json", new ApiError("Could not reach the archive.", 0));
      await settle();

      expect(find(root, "h1").textContent).toBe("Day 273");
      expect(root.textContent).toContain("on time");
      expect(root.textContent).not.toContain("Couldn't load this part of the page.");
      // The note would land in the old view's slot, out of the document, so
      // what a missing guard leaks is the report: an operator reading the
      // console would chase a failure no reader saw.
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test("shows the missing page when the body is missing, as the server would have", async () => {
    const held = heldBodies();
    const { root } = await openPage(`${ORIGIN}/player/${ADA.key}`, undefined, undefined, held.loader);
    expect(document.title).toBe("ada — Puzzle archive");

    held.fail(`/data/player/${ADA.key}.json`, new ApiError("Not found", 404));
    await settle();
    expect(document.title).toBe(NOT_FOUND_TEXT.title);
    expect(find(root, "h1").textContent).toBe("No such page");
  });

  test("says so, and offers another try, when a body cannot be loaded", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const held = heldBodies();
      const { root } = await openPage(`${ORIGIN}/leaderboards`, undefined, undefined, held.loader);
      held.fail("/data/leaderboards.json", new ApiError("Could not reach the archive.", 0));
      await settle();
      expect(root.textContent).toContain("Couldn't load this part of the page.");
      expect(String(error.mock.calls[0]?.[0])).toStartWith("[puzzledb]");

      buttonSaying(root, "Try again").click();
      expect(held.asked).toEqual(["/data/leaderboards.json", "/data/leaderboards.json"]);
      held.answer("/data/leaderboards.json", LEADERBOARDS);
      await settle();
      expect(root.querySelectorAll(".pdb-board-card")).toHaveLength(6);

      // A body that is not the body asked for fails the same way.
      const odd = await openPage(`${ORIGIN}/leaderboards`, undefined, undefined, async () => ({ builtAt: BUILT }));
      expect(odd.root.textContent).toContain("Couldn't load this part of the page.");
    } finally {
      error.mockRestore();
    }
  });

  test("reads the server from the address, and writes a chip the reader picks back into it", async () => {
    const { root, clock, writes } = await openOnClock(`${ORIGIN}/leaderboards?server=${CLUB.key}`);
    const rush = () => [...root.querySelectorAll(".pdb-board-card")][0]!;
    expect(find(rush(), '[aria-pressed="true"]').textContent).toBe("Club One");
    expect(rush().textContent).toContain("a player");

    buttonSaying(rush(), "All servers").click();
    clock.advance(QUERY_WRITE_MS);
    expect(writes).toEqual(["replaceState /leaderboards"]);
    expect(rush().textContent).toContain("ada");

    buttonSaying(rush(), "Club One").click();
    clock.advance(QUERY_WRITE_MS);
    expect(writes.at(-1)).toBe(`replaceState /leaderboards?server=${CLUB.key}`);

    // A key the index does not know is every server.
    const { root: junk } = await openPage(`${ORIGIN}/leaderboards?server=nosuchkey2`);
    expect(find(junk, '.pdb-board-card [aria-pressed="true"]').textContent).toBe("All servers");
  });

  test("adds how the puzzle went and its players' lines to a puzzle's page", async () => {
    const { root } = await openPage(`${ORIGIN}/puzzle/4`);
    expect(root.querySelector(".pdb-rail .pdb-stats")).not.toBeNull();
    buttonSaying(root, "Show the answers").click();
    expect([...root.querySelectorAll(".pdb-answer__chips button")].map((chip) => chip.textContent)).toEqual([
      "Maker's answer",
      "Line 1 · 4 atk · 1p",
    ]);
  });

  test("scrolls to the answers for #lines and leaves them shut", async () => {
    const scrolled: string[] = [];
    const scroll = spyOn(window.HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      scrolled.push(this.id);
    });
    try {
      const { root } = await openPage(`${ORIGIN}/puzzle/4#lines`);
      expect(scrolled).toEqual(["lines"]);
      expect(root.querySelector(".replay")).toBeNull();
    } finally {
      scroll.mockRestore();
    }
  });

  test("lands a profile's Lines found on the Discoveries board, once the boards have come", async () => {
    const scrolled: string[] = [];
    const scroll = spyOn(window.HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      scrolled.push(this.id);
    });
    try {
      const held = heldBodies();
      const { root } = await openPage(`${ORIGIN}/player/${ADA.key}`, undefined, undefined, held.loader);
      held.answer(`/data/player/${ADA.key}.json`, ADA_BODY);
      await settle();

      click(find(root, 'a[href="/leaderboards#discoveries"]'));
      await settle();
      // The board is not there yet, so there is nothing to scroll to.
      expect(scrolled).toEqual([]);

      held.answer("/data/leaderboards.json", RUSH_RECORDS);
      await settle();
      expect(scrolled).toEqual(["discoveries"]);
    } finally {
      scroll.mockRestore();
    }
  });

  test("scrolls to nothing for an anchor no element carries", async () => {
    const scroll = spyOn(window.HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      await openPage(`${ORIGIN}/leaderboards#nosuch"]`);
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      scroll.mockRestore();
    }
  });
});

describe("the address bar", () => {
  const search = (root: ParentNode) => find<HTMLInputElement>(root, '[aria-label="Search puzzles"]');

  test("writes the filter once the typing pauses, not once per keystroke", async () => {
    const { root, clock, writes } = await openOnClock(`${ORIGIN}/`);
    for (const typed of ["n", "no", "not", "notc", "notch"]) typeInto(search(root), typed);

    expect(writes).toEqual([]);
    clock.advance(QUERY_WRITE_MS - 1);
    expect(writes).toEqual([]);
    clock.advance(1);
    expect(writes).toEqual(["replaceState /?q=notch"]);
    expect(clock.pending()).toBe(0);
  });

  test("writes a filter still waiting onto the page it was typed on, before going to another", async () => {
    const { root, clock, writes } = await openOnClock(`${ORIGIN}/`);
    typeInto(search(root), "notch");
    click(find(root, '.pdb-grid a[href="/puzzle/4"]'));

    // So Back returns to the list as it was left, and the puzzle's own address carries no filter.
    expect(writes).toEqual(["replaceState /?q=notch", "pushState /puzzle/4"]);
    clock.advance(QUERY_WRITE_MS);
    expect(writes).toHaveLength(2);
  });

  test("drops a filter still waiting when Back moves the page, rather than writing it onto the page arrived at", async () => {
    const { root, clock, writes } = await openOnClock(`${ORIGIN}/`);
    typeInto(search(root), "notch");
    window.dispatchEvent(new window.Event("popstate"));

    clock.advance(QUERY_WRITE_MS);
    expect(writes).toEqual([]);
  });

  test("leaves nothing waiting once stopped", async () => {
    const { root, page, clock, writes } = await openOnClock(`${ORIGIN}/`);
    typeInto(search(root), "notch");
    page.stop();

    expect(clock.pending()).toBe(0);
    clock.advance(QUERY_WRITE_MS);
    expect(writes).toEqual([]);
  });

  test("keeps working when the browser refuses to update the address, and catches up once it allows it", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { root, clock, writes, refusing, errors } = await openOnClock(`${ORIGIN}/`);
      refusing.replaceState = true;
      typeInto(search(root), "notch");
      clock.advance(QUERY_WRITE_MS);
      typeInto(search(root), "notc");
      clock.advance(QUERY_WRITE_MS);

      // Nothing thrown out of the input listener, the list still follows the
      // box, and the refusal is said once rather than on every attempt.
      expect(errors).toEqual([]);
      expect(writes).toEqual([]);
      expect(gridOf(root)).toContain("/puzzle/4");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toStartWith("[puzzledb]");

      refusing.replaceState = false;
      clock.advance(REFUSED_RETRY_MS);
      expect(writes).toEqual(["replaceState /?q=notc"]);
    } finally {
      warn.mockRestore();
    }
  });

  test("loads the page outright when the browser refuses to move in place", async () => {
    const { root, refusing, errors } = await openOnClock(`${ORIGIN}/`);
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      refusing.pushState = true;
      const event = click(find(root, '.pdb-grid a[href="/puzzle/4"]'));

      expect(event.defaultPrevented).toBe(true);
      expect(assign).toHaveBeenCalledWith(`${ORIGIN}/puzzle/4`);
      expect(errors).toEqual([]);
    } finally {
      assign.mockRestore();
    }
  });
});
