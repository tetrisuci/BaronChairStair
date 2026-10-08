/**
 * The one ordering both alternate-solution browsers use: the activity's
 * Explore tab and db.tetrisatuci.org's Alternates page. Two copies of a sort
 * would drift, and a player comparing the two would see the same lines in
 * different orders under the same heading.
 */

import { describe, expect, test } from "bun:test";
import {
  ALTERNATE_SORTS,
  ALTERNATE_SORT_LABELS,
  DEFAULT_ALTERNATE_ORDER,
  defaultDirection,
  readAlternateOrder,
  sortAlternates,
  type SortableAlternate,
} from "../shared/alternate-sort";

function row(over: Partial<SortableAlternate> & { tiebreak: number }): SortableAlternate {
  return {
    puzzleId: 1,
    title: "a",
    difficulty: 5,
    found: 100,
    attack: 10,
    pieces: 10,
    ...over,
  };
}

const ids = (rows: readonly SortableAlternate[]) => rows.map((r) => r.tiebreak);

describe("sorting alternates", () => {
  test("newest found first by default, ties broken by the newer filing", () => {
    const rows = [row({ tiebreak: 1, found: 5 }), row({ tiebreak: 2, found: 9 }), row({ tiebreak: 3, found: 9 })];
    expect(ids(sortAlternates(rows, DEFAULT_ALTERNATE_ORDER))).toEqual([3, 2, 1]);
  });

  test("each direction reverses the metric", () => {
    const rows = [row({ tiebreak: 1, attack: 4 }), row({ tiebreak: 2, attack: 12 }), row({ tiebreak: 3, attack: 8 })];
    expect(ids(sortAlternates(rows, { sort: "attack", direction: "desc" }))).toEqual([2, 3, 1]);
    expect(ids(sortAlternates(rows, { sort: "attack", direction: "asc" }))).toEqual([1, 3, 2]);
  });

  test("a value that is not there — unrated, or locked — sorts last in both directions", () => {
    const rows = [
      row({ tiebreak: 1, difficulty: null }),
      row({ tiebreak: 2, difficulty: 3 }),
      row({ tiebreak: 3, difficulty: 15 }),
    ];
    expect(ids(sortAlternates(rows, { sort: "difficulty", direction: "desc" }))).toEqual([3, 2, 1]);
    expect(ids(sortAlternates(rows, { sort: "difficulty", direction: "asc" }))).toEqual([2, 3, 1]);

    const locked = [row({ tiebreak: 1, pieces: null }), row({ tiebreak: 2, pieces: 7 })];
    expect(ids(sortAlternates(locked, { sort: "pieces", direction: "asc" }))).toEqual([2, 1]);
    expect(ids(sortAlternates(locked, { sort: "pieces", direction: "desc" }))).toEqual([2, 1]);
  });

  test("puzzle name and number keep a puzzle's lines together, newest first within it", () => {
    const rows = [
      row({ tiebreak: 1, puzzleId: 9, title: "beta", found: 1 }),
      row({ tiebreak: 2, puzzleId: 4, title: "Alpha", found: 1 }),
      row({ tiebreak: 3, puzzleId: 9, title: "beta", found: 7 }),
    ];
    expect(ids(sortAlternates(rows, { sort: "title", direction: "asc" }))).toEqual([2, 3, 1]);
    expect(ids(sortAlternates(rows, { sort: "number", direction: "desc" }))).toEqual([3, 1, 2]);
  });

  test("leaves its input alone", () => {
    const rows = [row({ tiebreak: 1, found: 1 }), row({ tiebreak: 2, found: 2 })];
    sortAlternates(rows, DEFAULT_ALTERNATE_ORDER);
    expect(ids(rows)).toEqual([1, 2]);
  });
});

describe("reading an order from a query string or a select", () => {
  test("every sort has a label and a natural direction", () => {
    for (const sort of ALTERNATE_SORTS) {
      expect(ALTERNATE_SORT_LABELS[sort].length).toBeGreaterThan(0);
      expect(["asc", "desc"]).toContain(defaultDirection(sort));
    }
  });

  test("junk reads as the default, and a missing direction as the sort's own", () => {
    expect(readAlternateOrder("nonsense", "sideways")).toEqual(DEFAULT_ALTERNATE_ORDER);
    expect(readAlternateOrder(undefined, undefined)).toEqual(DEFAULT_ALTERNATE_ORDER);
    expect(readAlternateOrder("title", null)).toEqual({ sort: "title", direction: "asc" });
    expect(readAlternateOrder("title", "desc")).toEqual({ sort: "title", direction: "desc" });
  });
});
