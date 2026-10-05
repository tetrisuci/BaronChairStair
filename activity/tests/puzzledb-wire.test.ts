/**
 * The contract the puzzle database's server and its page both code against.
 *
 * Every rule here is one the two halves must agree on to the byte, which is
 * why they live in one file and are tested once. A path the page treats as a
 * puzzle while the server answers 404 is a link that works when clicked and
 * breaks when shared; a description the server cuts one way and the page
 * another is a tab title that changes under the reader. So the page asks
 * `pageText(...) === null` to decide "missing", exactly as the server does to
 * decide its status code, and both read days off the same calendar.
 */

import { describe, expect, test } from "bun:test";
import { dayNumber } from "../shared/daily";
import { PUBLIC_KEY_PATTERN } from "../shared/site";
import {
  ALL_SERVERS,
  bodyPathFor,
  dateOfDay,
  dayLabel,
  DESCRIPTION_LIMIT,
  NOT_FOUND_TEXT,
  pageText,
  parsePage,
  pathOf,
  SCHEMA_VERSION,
  SITE_NAME,
  UNAVAILABLE_TEXT,
  type PageRoute,
  STANDING_BOARDS,
  type SiteDay,
  type SiteLookup,
  type SitePlayerEntry,
  type SitePuzzle,
} from "../puzzledb/wire";

/** A key of the shape the game draws; the wire only ever pattern-matches it. */
const KEY = "k7m2p9xq4w";

const LA = "America/Los_Angeles";

function sitePuzzle(over: Partial<SitePuzzle> = {}): SitePuzzle {
  return {
    id: 42,
    title: "Jelly",
    author: "baron",
    difficulty: 6,
    tier: "hard",
    goal: "Clear 3 TSTs",
    set: null,
    board: ["GGGGGGGGG."],
    queue: ["T", "I", "O", "L", "J", "S", "Z", "T"],
    hold: "I",
    pieces: 9,
    targetAttack: 12,
    requiredClears: null,
    solution: null,
    source: null,
    puzzleUrl: null,
    solutionUrl: null,
    ...over,
  };
}

function lookupOf(
  puzzles: readonly SitePuzzle[],
  days: readonly SiteDay[] = [],
  players: readonly SitePlayerEntry[] = [],
): SiteLookup {
  const byId = new Map(puzzles.map((puzzle) => [puzzle.id, puzzle]));
  const byDay = new Map(days.map((day) => [day.day, day]));
  const byKey = new Map(players.map((player) => [player.key, player]));
  return { puzzle: (id) => byId.get(id), day: (day) => byDay.get(day), player: (key) => byKey.get(key) };
}

function sitePlayer(over: Partial<SitePlayerEntry> = {}): SitePlayerEntry {
  return { key: KEY, name: "ada", daysSolved: 41, bestStreak: 21, ...over };
}

const NOTHING = lookupOf([]);

function descriptionOf(puzzle: SitePuzzle): string {
  const text = pageText({ kind: "puzzle", id: puzzle.id }, lookupOf([puzzle]));
  if (!text) throw new Error(`puzzle ${puzzle.id} has no page text`);
  return text.description;
}

describe("the page routes", () => {
  test("reads /leaderboards, /players and /player/<key>", () => {
    expect(parsePage("/leaderboards")).toEqual({ kind: "leaderboards" });
    expect(parsePage("/players")).toEqual({ kind: "players" });
    expect(parsePage(`/player/${KEY}`)).toEqual({ kind: "player", key: KEY });
    expect(parsePage("/player/23456789ab")).toEqual({ kind: "player", key: "23456789ab" });
  });

  test("reads no player path that is not exactly a public key", () => {
    // The page's path pattern and the game's key pattern are one rule: a path
    // the site routes as a player must be one the game could have handed out.
    const strays = [
      "/player",
      "/player/",
      `/player/${KEY}/`,
      `/player/${KEY.toUpperCase()}`,
      "/player/0123456789",
      "/player/abcdefghjl",
      "/player/23456789a",
      "/player/23456789abc",
      "/player/123456789012345678",
      "/player/guest",
      `/Player/${KEY}`,
      `/players/${KEY}`,
      "/leaderboards/",
      "/Leaderboards",
      "/players/",
      "/data/leaderboards.json",
    ];

    expect(strays.filter((path) => parsePage(path) !== null)).toEqual([]);
    expect(PUBLIC_KEY_PATTERN.test(KEY)).toBe(true);
  });

  test("routes a player path exactly when its key is one the game's pattern admits", () => {
    // The path pattern is written out in `wire.ts` rather than built from
    // `PUBLIC_KEY_PATTERN`, so the two are held together here, character by character.
    const disagree: string[] = [];
    for (let code = 0x20; code < 0x7f; code++) {
      const key = String.fromCharCode(code).repeat(10);
      if ((parsePage(`/player/${key}`) !== null) !== PUBLIC_KEY_PATTERN.test(key)) disagree.push(key);
    }

    expect(disagree).toEqual([]);
  });

  test("reads /, /days, /puzzle/N and /day/N", () => {
    expect(parsePage("/")).toEqual({ kind: "browse" });
    expect(parsePage("/days")).toEqual({ kind: "days" });
    expect(parsePage("/puzzle/1")).toEqual({ kind: "puzzle", id: 1 });
    expect(parsePage("/puzzle/42")).toEqual({ kind: "puzzle", id: 42 });
    // The community band, and the widest id the pattern admits.
    expect(parsePage("/puzzle/100000")).toEqual({ kind: "puzzle", id: 100000 });
    expect(parsePage("/puzzle/9999999")).toEqual({ kind: "puzzle", id: 9999999 });
    expect(parsePage("/day/1")).toEqual({ kind: "day", day: 1 });
    expect(parsePage("/day/274")).toEqual({ kind: "day", day: 274 });
    expect(parsePage("/day/99999")).toEqual({ kind: "day", day: 99999 });
  });

  test("reads nothing else", () => {
    // Each of these must be one byte-identical 404 on the server, so the page
    // must call every one of them missing too. A leading zero is not a second
    // address for the same puzzle: two URLs per page split every shared link's
    // unfurl and every search engine's idea of which one is real.
    const strays = [
      "",
      "/puzzle/007",
      "/puzzle/0",
      "/puzzle/12abc",
      "/puzzle/-1",
      "/puzzle/1.5",
      "/puzzle/%31",
      "/puzzle/",
      "/puzzle/1/",
      "/puzzle/12345678",
      "/days/",
      "/Days",
      "/day/0",
      "/day/012",
      "/day/123456",
      "/day/274/",
      "/PUZZLE/1",
      "//",
      "/index.html",
      "/puzzles.json",
      "/api/public",
      " /",
    ];

    expect(strays.filter((path) => parsePage(path) !== null)).toEqual([]);
  });

  test("pathOf inverts parsePage for every route", () => {
    const routes: PageRoute[] = [
      { kind: "browse" },
      { kind: "days" },
      { kind: "puzzle", id: 1 },
      { kind: "puzzle", id: 100000 },
      { kind: "day", day: 274 },
      { kind: "leaderboards" },
      { kind: "players" },
      { kind: "player", key: KEY },
    ];

    for (const route of routes) expect(parsePage(pathOf(route))).toEqual(route);
    for (const path of ["/", "/days", "/puzzle/42", "/day/251", "/leaderboards", "/players", `/player/${KEY}`]) {
      expect(pathOf(parsePage(path)!)).toBe(path);
    }
  });
});

describe("days on the club's calendar", () => {
  test("dates day 1 as 2026-01-01 and labels day 274 Thu, Oct 1, 2026", () => {
    expect(dateOfDay(1)).toBe("2026-01-01");
    expect(dateOfDay(274)).toBe("2026-10-01");
    expect(dayLabel(274)).toBe("Thu, Oct 1, 2026");
    expect(dayLabel(1)).toBe("Thu, Jan 1, 2026");
    // Across a year end and onto a leap day.
    expect(dayLabel(366)).toBe("Fri, Jan 1, 2027");
    expect(dateOfDay(790)).toBe("2028-02-29");
    expect(dayLabel(790)).toBe("Tue, Feb 29, 2028");
  });

  test("labels every day of three years in step with its date", () => {
    // Independent of Intl on purpose — the label is built from fixed English
    // arrays so that no ICU update can reword it — so it is checked against
    // the date it sits beside and against the weekday it must follow.
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const wrong: number[] = [];
    let weekday = weekdays.indexOf("Thu");
    for (let day = 1; day <= 3 * 366; day++) {
      const [year, month, date] = dateOfDay(day).split("-").map(Number);
      const expected = `${weekdays[weekday]}, ${months[month! - 1]} ${date}, ${year}`;
      if (dayLabel(day) !== expected) wrong.push(day);
      weekday = (weekday + 1) % 7;
    }

    expect(wrong).toEqual([]);
  });

  test("puts every day of three years on the date dayNumber gives it", () => {
    const wrong: number[] = [];
    for (let day = 1; day <= 3 * 366; day++) {
      const [year, month, date] = dateOfDay(day).split("-").map(Number);
      // 20:00 UTC is midday in Irvine all year, either side of daylight saving.
      const midday = Date.UTC(year!, month! - 1, date!, 20);
      if (dayNumber(midday, { timeZone: LA }) !== day) wrong.push(day);
    }

    expect(wrong).toEqual([]);
  });

  test("agrees with dayNumber across both daylight-saving changes", () => {
    // The two nights the club's clock jumps in 2026: 8 March and 1 November.
    // Every quarter hour across each, the date the site prints for the day the
    // game is on must be the date on a wall clock in Irvine.
    const wall = new Intl.DateTimeFormat("en-US", {
      timeZone: LA,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const wallDate = (instant: number) => {
      const parts = Object.fromEntries(wall.formatToParts(instant).map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const quarterHour = 15 * 60_000;
    const nights = [
      [Date.UTC(2026, 2, 7), Date.UTC(2026, 2, 10)],
      [Date.UTC(2026, 9, 31), Date.UTC(2026, 10, 3)],
    ] as const;

    const wrong: string[] = [];
    for (const [from, to] of nights) {
      for (let instant = from; instant <= to; instant += quarterHour) {
        const printed = dateOfDay(dayNumber(instant, { timeZone: LA }));
        if (printed !== wallDate(instant)) wrong.push(new Date(instant).toISOString());
      }
    }

    expect(wrong).toEqual([]);
  });
});

describe("page text", () => {
  test("names the browse and history pages", () => {
    expect(pageText({ kind: "browse" }, NOTHING)).toEqual({
      title: "Puzzle archive — Daily Tetris",
      description:
        "Every club puzzle the Tetris at UCI daily deals from, with each maker's answer, " +
        "and the puzzles every finished day dealt.",
    });
    expect(pageText({ kind: "days" }, NOTHING)).toEqual({
      title: "Daily history — Puzzle archive",
      description: "Which puzzles each finished day of the Tetris at UCI daily dealt.",
    });
  });

  test("names a puzzle page by number, title and goal, cut to 200 characters", () => {
    const puzzle = sitePuzzle();

    expect(pageText({ kind: "puzzle", id: 42 }, lookupOf([puzzle]))).toEqual({
      title: "#42 Jelly — Puzzle archive",
      description: "Hard · difficulty 6 · 9 pieces · send 12 · by baron. Clear 3 TSTs",
    });

    const long = descriptionOf(sitePuzzle({ goal: "x".repeat(300) }));
    expect(Array.from(long)).toHaveLength(DESCRIPTION_LIMIT);
    expect(long.startsWith("Hard · difficulty 6 · 9 pieces · send 12 · by baron. xxx")).toBe(true);
    expect(long.endsWith("x…")).toBe(true);
  });

  test("counts the cut in code points, so a character is never split in half", () => {
    // Each of these is two UTF-16 units. A cut by `.length` would land between
    // the halves of one and hand an unfurl a lone surrogate.
    const description = descriptionOf(sitePuzzle({ goal: "🧩".repeat(300) }));

    expect(Array.from(description)).toHaveLength(DESCRIPTION_LIMIT);
    expect(description.length).toBeGreaterThan(DESCRIPTION_LIMIT);
    expect(description).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  test("leaves no space hanging before the ellipsis", () => {
    const description = descriptionOf(sitePuzzle({ goal: "a ".repeat(200) }));

    expect(description.endsWith("a…")).toBe(true);
    expect(Array.from(description).length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
  });

  test("says unrated rather than a difficulty of zero, and untitled for a blank title", () => {
    const text = pageText(
      { kind: "puzzle", id: 7 },
      lookupOf([sitePuzzle({ id: 7, title: "  ", difficulty: null })]),
    );

    expect(text?.title).toBe("#7 untitled — Puzzle archive");
    expect(text?.description).toBe("Hard · unrated · 9 pieces · send 12 · by baron. Clear 3 TSTs");
  });

  test("keeps an author's line breaks out of the page text", () => {
    // Three of the club's goals carry a newline (#62, #104, #112), and an
    // unfurl or a tab title shows it as a break or as nothing at all.
    const description = descriptionOf(
      sitePuzzle({ goal: "Clear 4 TSDs and 1 Quad\n(solvable no hold)" }),
    );

    expect(description).toEndWith("Clear 4 TSDs and 1 Quad (solvable no hold)");
  });

  test("ends a goal-less puzzle's facts at the full stop", () => {
    // #8 has an empty goal on the club's sheet.
    expect(descriptionOf(sitePuzzle({ goal: "", pieces: 1 }))).toBe(
      "Hard · difficulty 6 · 1 piece · send 12 · by baron.",
    );
  });

  test("names a day page by its tiers, a player-written deal included without a name", () => {
    const day: SiteDay = {
      day: 274,
      date: "2026-10-01",
      deals: [
        { tier: "easy", puzzleId: 12 },
        { tier: "medium", puzzleId: 13 },
        { tier: "hard", puzzleId: null },
        { tier: "extreme", puzzleId: 42 },
      ],
    };
    const lookup = lookupOf(
      [sitePuzzle({ id: 12, title: "Jelly" }), sitePuzzle({ id: 42, title: "" })],
      [day],
    );

    expect(pageText({ kind: "day", day: 274 }, lookup)).toEqual({
      title: "Day 274 · Thu, Oct 1, 2026 — Puzzle archive",
      description:
        "easy #12 Jelly · medium #13 (no longer in the archive) · " +
        "hard: a puzzle written by a player · extreme #42 untitled",
    });
  });

  test("answers null for a puzzle or day the lookup does not have, which is what makes a 404", () => {
    expect(pageText({ kind: "puzzle", id: 42 }, NOTHING)).toBeNull();
    expect(pageText({ kind: "day", day: 274 }, NOTHING)).toBeNull();
    // The two list pages exist whatever the data holds.
    expect(pageText({ kind: "browse" }, NOTHING)).not.toBeNull();
    expect(pageText({ kind: "days" }, NOTHING)).not.toBeNull();
  });

  test("keeps the not-found and unavailable texts fixed", () => {
    expect(NOT_FOUND_TEXT).toEqual({
      title: "Not found — Puzzle archive",
      description: "There is no such page in the Tetris at UCI puzzle archive.",
    });
    expect(UNAVAILABLE_TEXT).toEqual({
      title: "Puzzle archive — Daily Tetris",
      description: "The archive is not available right now. Try again in a minute.",
    });
    // Shared by every response, so one handler must not be able to edit them
    // for the next.
    expect(Object.isFrozen(NOT_FOUND_TEXT)).toBe(true);
    expect(Object.isFrozen(UNAVAILABLE_TEXT)).toBe(true);
  });

  test("names the site and the schema the download carries", () => {
    expect(SITE_NAME).toBe("Tetris at UCI puzzle archive");
    // 2 is the schema with player data in it: boards, standings, stats, lines.
    expect(SCHEMA_VERSION).toBe(2);
  });

  test("names the leaderboards and players pages, which exist whatever the data holds", () => {
    expect(pageText({ kind: "leaderboards" }, NOTHING)).toEqual({
      title: "Leaderboards — Puzzle archive",
      description:
        "Each Discord server's daily and rush boards from the Tetris at UCI daily, " +
        "and the all-time boards, for every finished day.",
    });
    expect(pageText({ kind: "players" }, NOTHING)).toEqual({
      title: "Players — Puzzle archive",
      description:
        "The players of the Tetris at UCI daily, by the name the game shows, " +
        "each with a page of their finished days.",
    });
  });

  test("names a player's page by their name, days solved and best streak", () => {
    const lookup = lookupOf([], [], [sitePlayer()]);

    expect(pageText({ kind: "player", key: KEY }, lookup)).toEqual({
      title: "ada — Puzzle archive",
      description: "ada's finished days in the Tetris at UCI daily: 41 days solved, best streak 21.",
    });
  });

  test("says one day in the singular, and keeps a name on one line", () => {
    const lookup = lookupOf([], [], [sitePlayer({ name: "  baron\nchair ", daysSolved: 1, bestStreak: 1 })]);

    expect(pageText({ kind: "player", key: KEY }, lookup)).toEqual({
      title: "baron chair — Puzzle archive",
      description: "baron chair's finished days in the Tetris at UCI daily: 1 day solved, best streak 1.",
    });
  });

  test("answers null for any key that is not a listed player, which is what makes the shared 404", () => {
    // A hidden player, a random key and a key from before a hide are all just
    // absent from the lookup, and so missing in exactly the same way.
    const lookup = lookupOf([], [], [sitePlayer()]);

    expect(pageText({ kind: "player", key: "23456789ab" }, lookup)).toBeNull();
    expect(pageText({ kind: "player", key: KEY }, NOTHING)).toBeNull();
  });

  test("clips a long name's description in code points", () => {
    const lookup = lookupOf([], [], [sitePlayer({ name: "🧩".repeat(300) })]);
    const description = pageText({ kind: "player", key: KEY }, lookup)?.description ?? "";

    expect(Array.from(description)).toHaveLength(DESCRIPTION_LIMIT);
    expect(description.endsWith("…")).toBe(true);
  });
});

describe("the data a page fetches beside the index", () => {
  test("names one body per page that has one, under /data/", () => {
    expect(bodyPathFor({ kind: "day", day: 274 })).toBe("/data/day/274.json");
    expect(bodyPathFor({ kind: "player", key: KEY })).toBe(`/data/player/${KEY}.json`);
    expect(bodyPathFor({ kind: "puzzle", id: 42 })).toBe("/data/puzzle/42.json");
    expect(bodyPathFor({ kind: "leaderboards" })).toBe("/data/leaderboards.json");
  });

  test("names none for the pages the index alone can draw", () => {
    expect(bodyPathFor({ kind: "browse" })).toBeNull();
    expect(bodyPathFor({ kind: "days" })).toBeNull();
    expect(bodyPathFor({ kind: "players" })).toBeNull();
  });

  test("puts each body at its page's own path, under /data and ending .json", () => {
    // A body's path is its page's path with a prefix and a suffix, so a body
    // can exist only where `parsePage` already said a page might.
    for (const path of ["/day/274", "/puzzle/42", `/player/${KEY}`, "/leaderboards"]) {
      const route = parsePage(path)!;
      expect(bodyPathFor(route)).toBe(`/data${path}.json`);
    }
  });
});

describe("the scopes and boards the public rows are keyed by", () => {
  test("calls every server's board 'all', which no server's key can collide with", () => {
    expect(ALL_SERVERS).toBe("all");
    expect(PUBLIC_KEY_PATTERN.test(ALL_SERVERS)).toBe(false);
  });

  test("lists the all-time boards in the order the leaderboards page shows them", () => {
    expect(STANDING_BOARDS).toEqual(["rush", "dailies", "streak", "best_streak", "cleared", "discoveries"]);
    expect(Object.isFrozen(STANDING_BOARDS)).toBe(true);
  });
});
