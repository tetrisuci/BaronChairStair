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
import {
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
  type SiteDay,
  type SiteLookup,
  type SitePuzzle,
} from "../puzzledb/wire";

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

function lookupOf(puzzles: readonly SitePuzzle[], days: readonly SiteDay[] = []): SiteLookup {
  const byId = new Map(puzzles.map((puzzle) => [puzzle.id, puzzle]));
  const byDay = new Map(days.map((day) => [day.day, day]));
  return { puzzle: (id) => byId.get(id), day: (day) => byDay.get(day) };
}

const NOTHING = lookupOf([]);

function descriptionOf(puzzle: SitePuzzle): string {
  const text = pageText({ kind: "puzzle", id: puzzle.id }, lookupOf([puzzle]));
  if (!text) throw new Error(`puzzle ${puzzle.id} has no page text`);
  return text.description;
}

describe("the page routes", () => {
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
    ];

    for (const route of routes) expect(parsePage(pathOf(route))).toEqual(route);
    for (const path of ["/", "/days", "/puzzle/42", "/day/251"]) {
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
    expect(SCHEMA_VERSION).toBe(1);
  });
});
