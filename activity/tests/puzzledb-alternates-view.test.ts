/**
 * `/alternates`, the table: every line players found through any puzzle,
 * sorted by any of six columns either way, with the choice kept in the
 * address.
 *
 * The body is written out by hand against the wire type, each row there for
 * one rule: two lines found on one day, so a tie can be seen to fall back the
 * same way every time; a line on an unrated puzzle, which sorts last whichever
 * way the list runs; a title that is markup, because a title is text a maker
 * typed; and a line on a puzzle the index does not list, which must never be
 * drawn.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { dateOfDay, dayLabel, SCHEMA_VERSION, type SiteData, type SitePuzzle } from "../puzzledb/wire";
import type { SiteAlternateRow, SiteAlternatesBody } from "../puzzledb/wire-alternates";
import { alternatesPage } from "../puzzledb/client/alternates";
import { indexSiteData, type SiteIndex } from "../puzzledb/client/data";
import { alternatesQueryFrom, queryForAlternates } from "../puzzledb/client/list-queries";

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

function sitePuzzle(over: Partial<SitePuzzle> & Pick<SitePuzzle, "id" | "title">): SitePuzzle {
  return {
    author: "roland", difficulty: 2, tier: "easy", goal: "Send 2.", set: null, board: ["GGGGG.GGGG"],
    queue: ["I"], hold: null, pieces: 1, targetAttack: 2, requiredClears: null, solution: null,
    source: null, puzzleUrl: null, solutionUrl: null,
    ...over,
  };
}

const NOTCH = sitePuzzle({ id: 4, title: "Notch", difficulty: 6 });
const ZIGZAG = sitePuzzle({ id: 9, title: "zigzag", difficulty: null });
const MARKUP = sitePuzzle({ id: 33, title: "<img src=x onerror=alert(1)>", difficulty: 3 });
/** Not in the index: a line on it is what a withheld puzzle's would be, if a build ever let one through. */
const UNLISTED_ID = 77;

const DATA: SiteData = {
  about: { schema: SCHEMA_VERSION, builtAt: "2026-10-02T19:00:00.000Z", firstDay: 247, throughDay: 274 },
  puzzles: [NOTCH, ZIGZAG, MARKUP],
  days: [274].map((day) => ({ day, date: dateOfDay(day), deals: [{ tier: "hard" as const, puzzleId: NOTCH.id }] })),
  players: [],
  servers: [],
};

const INDEX: SiteIndex = indexSiteData(DATA);

function line(puzzleId: number, position: number, over: Partial<SiteAlternateRow>): SiteAlternateRow {
  return { puzzleId, position, day: 270, attack: 4, pieces: 5, clears: [], ...over };
}

const BODY: SiteAlternatesBody = {
  builtAt: DATA.about.builtAt,
  lines: [
    line(NOTCH.id, 1, { day: 250, attack: 10, pieces: 7, clears: ["tsd", "tsd", "single"] }),
    line(NOTCH.id, 2, { day: 273, attack: 6, pieces: 9, clears: ["tsd"] }),
    line(ZIGZAG.id, 1, { day: 273, attack: 12, pieces: 4 }),
    line(MARKUP.id, 1, { day: 262, attack: 8, pieces: 6, clears: ["quad"] }),
    line(UNLISTED_ID, 1, { day: 274, attack: 99, pieces: 1 }),
  ],
};

// ── Driving it ───────────────────────────────────────────────────────────────

function drive(search = "", body: unknown = BODY, index: SiteIndex = INDEX) {
  const queries: string[] = [];
  const view = alternatesPage(index, alternatesQueryFrom(search), (query) => void queries.push(query));
  view.fill(body);
  return { element: view.element, view, queries };
}

/** Each row as `#id/position`, top to bottom, read off its link. */
function order(root: ParentNode): string[] {
  return [...root.querySelectorAll("tbody tr a")].map((link) => {
    const [, id, position] = /\/puzzle\/(\d+)#line-(\d+)$/.exec(link.getAttribute("href") ?? "") ?? [];
    return `${id}/${position}`;
  });
}

/** Each row's cells, as text. */
function cells(root: ParentNode): string[][] {
  return [...root.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""));
}

function buttonSaying(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!match) throw new Error(`no button says ${label}`);
  return match as HTMLButtonElement;
}

/** The header that carries `aria-sort`, and what it says. */
function sorted(root: ParentNode): [string, string | null][] {
  return [...root.querySelectorAll("th[aria-sort]")].map((th) => [th.textContent ?? "", th.getAttribute("aria-sort")]);
}

// ── The tests ────────────────────────────────────────────────────────────────

describe("the alternates table", () => {
  test("lists every line on a listed puzzle, newest find first, and never one the index does not list", () => {
    const { element } = drive();

    expect(order(element)).toEqual(["9/1", "4/2", "33/1", "4/1"]);
    expect(element.textContent).not.toContain("99");
  });

  test("draws each line's puzzle, difficulty, the day found, attack, length and clears", () => {
    const { element } = drive();
    const rows = cells(element);

    expect(rows[1]).toEqual(["#4 Notch", "6", dayLabel(273), "6", "9", "TSD"]);
    expect(rows[3]).toEqual(["#4 Notch", "6", dayLabel(250), "10", "7", "TSD ×2 · Single"]);
    // Unrated says so, and a line that named no clear says nothing.
    expect(rows[0]).toEqual(["#9 zigzag", "unrated", dayLabel(273), "12", "4", "—"]);
  });

  test("links each line to its own chip on the puzzle's page", () => {
    const { element } = drive();
    const link = [...element.querySelectorAll("tbody tr a")][1] as HTMLAnchorElement;

    expect(link.getAttribute("href")).toBe("/puzzle/4#line-2");
    expect(link.textContent).toBe("#4 Notch");
  });

  test("prints a markup title as text", () => {
    const { element } = drive();

    expect(element.querySelector("tbody img")).toBeNull();
    expect(element.textContent).toContain("#33 <img src=x onerror=alert(1)>");
  });

  test("marks the column it is sorted by, and says which way", () => {
    const { element } = drive();

    expect(sorted(element)).toEqual([["Found", "descending"]]);
  });

  test("sorts by a pressed header in that column's natural direction, and keeps it in the address", () => {
    const { element, queries } = drive();

    buttonSaying(element, "Attack").click();

    expect(order(element)).toEqual(["9/1", "4/1", "33/1", "4/2"]);
    expect(sorted(element)).toEqual([["Attack", "descending"]]);
    expect(queries).toEqual(["?sort=attack"]);
  });

  test("turns the sort around when its own header is pressed again", () => {
    const { element, queries } = drive("?sort=attack");

    buttonSaying(element, "Attack").click();

    expect(order(element)).toEqual(["4/2", "33/1", "4/1", "9/1"]);
    expect(sorted(element)).toEqual([["Attack", "ascending"]]);
    expect(queries).toEqual(["?sort=attack&dir=asc"]);
  });

  test("turns the sort around from the direction button, which says which way it runs", () => {
    const { element, queries } = drive();
    const toggle = element.querySelector(".pdb-sort-direction") as HTMLButtonElement;
    expect(toggle.textContent).toBe("Descending");

    toggle.click();

    // The two finds of day 273 keep their order: a tie falls back the same way whichever way the list runs.
    expect(order(element)).toEqual(["4/1", "33/1", "9/1", "4/2"]);
    expect((element.querySelector(".pdb-sort-direction") as HTMLButtonElement).textContent).toBe("Ascending");
    expect(queries).toEqual(["?dir=asc"]);
  });

  test("sorts by puzzle number or name from the puzzle column's two buttons, a puzzle's lines kept together", () => {
    const byNumber = drive("?sort=number").element;
    expect(order(byNumber)).toEqual(["4/2", "4/1", "9/1", "33/1"]);
    expect(sorted(byNumber)).toEqual([["NumberName", "ascending"]]);

    // `<` sorts before every letter, and the name sort folds case.
    expect(order(drive("?sort=title").element)).toEqual(["33/1", "4/2", "4/1", "9/1"]);
    expect(order(drive("?sort=title&dir=desc").element)).toEqual(["9/1", "4/2", "4/1", "33/1"]);
  });

  test("puts an unrated puzzle's lines last whichever way difficulty runs", () => {
    expect(order(drive("?sort=difficulty").element)).toEqual(["4/2", "4/1", "33/1", "9/1"]);
    expect(order(drive("?sort=difficulty&dir=asc").element)).toEqual(["33/1", "4/2", "4/1", "9/1"]);
  });

  test("sorts by length, the shortest first", () => {
    expect(order(drive("?sort=pieces").element)).toEqual(["9/1", "33/1", "4/1", "4/2"]);
  });

  test("says so when nobody has found a line yet", () => {
    const { element } = drive("", { builtAt: DATA.about.builtAt, lines: [] });

    expect(element.querySelector("table")).toBeNull();
    expect(element.textContent).toContain("No player has found another way through a puzzle yet.");
  });

  test("refuses a body that is not the alternates body", () => {
    const view = alternatesPage(INDEX, alternatesQueryFrom(""), () => {});

    expect(() => view.fill({ builtAt: "x", rows: [] })).toThrow("The alternates data has no `lines`.");
  });
});

describe("the alternates query", () => {
  test("reads the default order from a bare address, and writes nothing for it", () => {
    expect(alternatesQueryFrom("")).toEqual({ sort: "found", direction: "desc" });
    expect(queryForAlternates({ sort: "found", direction: "desc" })).toBe("");
  });

  test("reads a sort with its natural direction, and leaves that direction out of the address", () => {
    expect(alternatesQueryFrom("?sort=title")).toEqual({ sort: "title", direction: "asc" });
    expect(queryForAlternates({ sort: "title", direction: "asc" })).toBe("?sort=title");
    expect(queryForAlternates({ sort: "title", direction: "desc" })).toBe("?sort=title&dir=desc");
  });

  test("reads junk as the default", () => {
    expect(alternatesQueryFrom("?sort=<script>&dir=asc")).toEqual({ sort: "found", direction: "desc" });
    expect(alternatesQueryFrom("?sort=attack&dir=sideways")).toEqual({ sort: "attack", direction: "desc" });
  });

  test("round-trips every order", () => {
    for (const sort of ["found", "difficulty", "title", "number", "attack", "pieces"] as const) {
      for (const direction of ["asc", "desc"] as const) {
        expect(alternatesQueryFrom(queryForAlternates({ sort, direction }))).toEqual({ sort, direction });
      }
    }
  });
});
