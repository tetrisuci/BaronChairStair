/**
 * `/players`, the table: every listed player's numbers, sorted, searched and
 * narrowed to a server, with the choice kept in the address.
 *
 * The bodies are written out by hand against the wire types, each row there
 * for one rule: two players who tie on a column, so the tie can be seen to go
 * by name; a player with no rush, so the dash can be seen; a name that is
 * markup, because a username is text a stranger typed; and a row whose key the
 * index does not hold — what a player who hid would be, if a build ever let
 * one through — so it can be seen never to be drawn.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { SCHEMA_VERSION, type SiteData } from "../puzzledb/wire";
import type { SitePlayerListRow, SitePlayersBody } from "../puzzledb/wire-profiles";
import { indexSiteData, type SiteIndex } from "../puzzledb/client/data";
import { playersQueryFrom, queryForPlayers } from "../puzzledb/client/list-queries";
import { playersPage } from "../puzzledb/client/players";

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
const MARKUP = { key: "imgkey2345", name: "<img src=x onerror=alert(1)>" };
const BEA = { key: "beakey2345", name: "bea" };
const CY = { key: "cykey23456", name: "Cy" };
/** A key the index does not hold: a player who hid has no entry, so a row for one must never draw. */
const HIDDEN_KEY = "hidekey234";

const CLUB = { key: "clubkey234", name: "Club One" } as const;
const NAMELESS = { key: "unnskey234", name: null } as const;

const DATA: SiteData = {
  about: { schema: SCHEMA_VERSION, builtAt: "2026-10-02T19:00:00.000Z", firstDay: 247, throughDay: 274 },
  puzzles: [],
  days: [],
  // The index's order, by name: the markup sorts first, as `<` comes before every letter.
  players: [
    { ...MARKUP, daysSolved: 3, bestStreak: 2 },
    { ...ADA, daysSolved: 41, bestStreak: 21 },
    { ...BEA, daysSolved: 3, bestStreak: 1 },
    { ...CY, daysSolved: 3, bestStreak: 9 },
  ],
  servers: [CLUB, NAMELESS],
};

const INDEX: SiteIndex = indexSiteData(DATA);

function row(key: string, over: Partial<SitePlayerListRow>): SitePlayerListRow {
  return { key, puzzlesCleared: 0, linesFound: 0, rushBest: null, rushBestMs: null, servers: [], ...over };
}

const BODY: SitePlayersBody = {
  builtAt: DATA.about.builtAt,
  rows: [
    row(MARKUP.key, { puzzlesCleared: 5 }),
    row(ADA.key, { puzzlesCleared: 88, linesFound: 6, rushBest: 14, rushBestMs: 184_100, servers: [CLUB.key] }),
    row(BEA.key, { puzzlesCleared: 120, linesFound: 11, rushBest: 14, rushBestMs: 150_000, servers: [CLUB.key, NAMELESS.key] }),
    row(CY.key, { puzzlesCleared: 20, linesFound: 11, rushBest: 9, rushBestMs: 100_000, servers: [NAMELESS.key] }),
    row(HIDDEN_KEY, { puzzlesCleared: 999, linesFound: 99, rushBest: 99, rushBestMs: 1, servers: [CLUB.key] }),
  ],
};

// ── Driving it ───────────────────────────────────────────────────────────────

function drive(search = "", body: unknown = BODY, index: SiteIndex = INDEX) {
  const queries: string[] = [];
  const view = playersPage(index, playersQueryFrom(search, index), (query) => void queries.push(query));
  view.fill(body);
  return { element: view.element, view, queries };
}

/** The names in the table, top to bottom. */
function names(root: ParentNode): string[] {
  return [...root.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")?.textContent ?? "");
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

function typeInto(field: HTMLInputElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new window.Event("input") as unknown as Event);
}

const search = (root: ParentNode) => root.querySelector('[aria-label="Filter players"]') as HTMLInputElement;

/** The header that carries `aria-sort`, by its button's words. */
function sorted(root: ParentNode): string[] {
  return [...root.querySelectorAll("th[aria-sort]")].map((th) => th.textContent ?? "");
}

// ── The tests ────────────────────────────────────────────────────────────────

describe("the players table", () => {
  test("joins each row to the index's name, days solved and best streak, and links the name", () => {
    const { element } = drive();
    expect(cells(element)[0]).toEqual(["ada", "41", "21", "88", "6", "14 · 3:04.1"]);
    const link = element.querySelector("tbody tr a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`/player/${ADA.key}`);
    expect(element.textContent).toContain("4 players, by the name the game shows. A player who chose to hide is not listed.");
    expect(element.textContent).toContain("Showing 4 of 4 · totals count every server");
  });

  test("sorts by days solved by default, a tie going by name, case-folded", () => {
    const { element } = drive();
    expect(names(element)).toEqual(["ada", MARKUP.name, "bea", "Cy"]);
    expect(sorted(element)).toEqual(["Days solved"]);
    expect(element.querySelector("th[aria-sort]")?.getAttribute("aria-sort")).toBe("descending");
  });

  test("reorders by each header, moving aria-sort and writing the sort into the address", () => {
    const { element, queries } = drive();

    buttonSaying(element, "Best streak").click();
    expect(names(element)).toEqual(["ada", "Cy", MARKUP.name, "bea"]);
    expect(sorted(element)).toEqual(["Best streak"]);

    buttonSaying(element, "Cleared").click();
    expect(names(element)).toEqual(["bea", "ada", "Cy", MARKUP.name]);

    buttonSaying(element, "Lines found").click();
    expect(names(element)).toEqual(["bea", "Cy", "ada", MARKUP.name]);

    // Most solved first, then the faster of two equal rushes, and nobody's rush last.
    buttonSaying(element, "Best rush").click();
    expect(names(element)).toEqual(["bea", "ada", "Cy", MARKUP.name]);

    buttonSaying(element, "Days solved").click();
    expect(names(element)).toEqual(["ada", MARKUP.name, "bea", "Cy"]);
    expect(queries).toEqual(["?sort=streak", "?sort=cleared", "?sort=lines", "?sort=rush", ""]);
  });

  test("does nothing when the column already on is pressed again", () => {
    const { element, queries } = drive();
    buttonSaying(element, "Days solved").click();
    expect(queries).toEqual([]);
  });

  test("opens on the sort, search and server the address names", () => {
    const { element } = drive(`?sort=cleared&server=${NAMELESS.key}&q=C`);
    expect(names(element)).toEqual(["Cy"]);
    expect(sorted(element)).toEqual(["Cleared"]);
    expect(search(element).value).toBe("C");
  });

  test("searches by name, ignoring case, and says so when nobody matches", () => {
    const { element, queries } = drive();
    typeInto(search(element), "BE");
    expect(names(element)).toEqual(["bea"]);
    expect(element.textContent).toContain("Showing 1 of 4");

    typeInto(search(element), "nobody");
    expect(names(element)).toEqual([]);
    expect(element.textContent).toContain("No player matches “nobody”.");
    expect(queries).toEqual(["?q=BE", "?q=nobody"]);
  });

  test("narrows to a server's players with a chip, and writes it into the address", () => {
    const { element, queries } = drive();
    const chips = [...element.querySelectorAll(".pdb-chips button")].map((chip) => chip.textContent);
    expect(chips).toEqual(["All servers", "Club One", "Unnamed server · unns"]);

    buttonSaying(element, "Club One").click();
    expect(names(element)).toEqual(["ada", "bea"]);
    buttonSaying(element, "Unnamed server · unns").click();
    expect(names(element)).toEqual(["bea", "Cy"]);
    buttonSaying(element, "All servers").click();
    expect(names(element)).toHaveLength(4);
    expect(queries).toEqual([`?server=${CLUB.key}`, `?server=${NAMELESS.key}`, ""]);
  });

  test("shows a dash for a player with no rush", () => {
    const { element } = drive();
    const markup = cells(element).find((cellsOf) => cellsOf[0] === MARKUP.name)!;
    expect(markup[5]).toBe("—");
  });

  test("never draws a row whose key the index does not hold, as a player who hid would be", () => {
    const { element } = drive();
    expect(element.textContent).not.toContain("999");
    expect(element.querySelector(`a[href="/player/${HIDDEN_KEY}"]`)).toBeNull();
    expect(element.innerHTML).not.toContain(HIDDEN_KEY);
    // Even its server: a chip offered only for a hidden player's play would say who played there.
    buttonSaying(element, "Club One").click();
    expect(names(element)).toEqual(["ada", "bea"]);
  });

  test("sets a name as text, so markup in it is only words", () => {
    const { element } = drive();
    expect(names(element)).toContain(MARKUP.name);
    expect(element.querySelector("img")).toBeNull();
  });

  test("sets no inline style anywhere", () => {
    const { element } = drive("?sort=rush");
    expect(element.querySelectorAll("[style]")).toHaveLength(0);
  });

  test("draws the head and the search at once, and the table when the body arrives", () => {
    const view = playersPage(INDEX, playersQueryFrom("", INDEX), () => {});
    expect(view.element.querySelector(".pdb-title")?.textContent).toBe("Players");
    expect(search(view.element)).not.toBeNull();
    expect(view.element.querySelector("table")).toBeNull();
    expect(view.element.contains(view.slot)).toBe(true);

    view.fill(BODY);
    expect(view.element.querySelector("table")).not.toBeNull();
  });

  test("refuses a body that is not the players body", () => {
    const view = playersPage(INDEX, playersQueryFrom("", INDEX), () => {});
    expect(() => view.fill({ builtAt: "x", days: [] })).toThrow("players");
  });

  test("says so when nobody is listed yet", () => {
    const empty = indexSiteData({ ...DATA, players: [] });
    const { element } = drive("", { builtAt: DATA.about.builtAt, rows: [] }, empty);
    expect(element.textContent).toContain("No players on record yet.");
    expect(element.querySelector("table")).toBeNull();
  });
});

describe("the players table's address", () => {
  test("round-trips every sort, the search and the server", () => {
    for (const sort of ["days", "streak", "cleared", "lines", "rush"] as const) {
      const query = { sort, q: "ad a", server: CLUB.key };
      expect(playersQueryFrom(queryForPlayers(query), INDEX)).toEqual(query);
    }
  });

  test("leaves the defaults out, so the everyday address is the bare one", () => {
    expect(queryForPlayers({ sort: "days", q: "", server: null })).toBe("");
    expect(queryForPlayers({ sort: "days", q: "   ", server: null })).toBe("");
    expect(queryForPlayers({ sort: "rush", q: "", server: null })).toBe("?sort=rush");
  });

  test("reads junk as the defaults: an unknown sort as days, an unknown server as every server", () => {
    expect(playersQueryFrom("?sort=name&server=nosuchkey", INDEX)).toEqual({ sort: "days", q: "", server: null });
    expect(playersQueryFrom("?sort=DAYS&server=all", INDEX)).toEqual({ sort: "days", q: "", server: null });
    expect(playersQueryFrom("", INDEX)).toEqual({ sort: "days", q: "", server: null });
  });
});
