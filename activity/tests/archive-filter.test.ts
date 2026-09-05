/**
 * The archive filter: what the explorer shows, and what a random puzzle is
 * drawn from. It runs in the browser but is stored on the server, so it has to
 * be both correct and bounded.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ArchiveFilter,
  DEFAULT_ARCHIVE_FILTER,
  filterArchive,
  isDefaultFilter,
  MAX_DIFFICULTY,
  MAX_PIECES,
  MIN_DIFFICULTY,
  MIN_PIECES,
  matchesFilter,
  sanitizeArchiveFilter,
} from "../shared/archive-filter";
import { type ArchiveListing, type Puzzle, toListing } from "../shared/puzzle";

const raw: Puzzle[] = (
  JSON.parse(readFileSync(resolve(import.meta.dir, "../data/puzzles.json"), "utf8")) as {
    puzzles: Puzzle[];
  }
).puzzles;
const archive: ArchiveListing[] = raw.map(toListing);

const with_ = (patch: Partial<ArchiveFilter>): ArchiveFilter => ({
  ...DEFAULT_ARCHIVE_FILTER,
  ...patch,
});

function listing(patch: Partial<ArchiveListing>): ArchiveListing {
  return {
    id: 1,
    title: "t",
    author: "a",
    difficulty: 5,
    goal: "g",
    set: null,
    pieces: 5,
    targetAttack: 4,
    community: false,
    ...patch,
  };
}

describe("the default filter", () => {
  test("lets the whole archive through", () => {
    expect(filterArchive(archive, DEFAULT_ARCHIVE_FILTER)).toHaveLength(archive.length);
    expect(isDefaultFilter(DEFAULT_ARCHIVE_FILTER)).toBe(true);
  });

  test("survives being sanitized", () => {
    expect(sanitizeArchiveFilter(DEFAULT_ARCHIVE_FILTER)).toEqual(DEFAULT_ARCHIVE_FILTER);
  });
});

describe("difficulty", () => {
  test("a range keeps only what is inside it", () => {
    const kept = filterArchive(archive, with_({ maxDifficulty: 3, includeUnrated: false }));
    expect(kept.length).toBeGreaterThan(0);
    for (const entry of kept) {
      expect(entry.difficulty).toBeGreaterThanOrEqual(1);
      expect(entry.difficulty).toBeLessThanOrEqual(3);
    }
  });

  test("unrated puzzles are not swept up by a low range", () => {
    // Difficulty 0 sits inside any range that starts at zero, and the archive's
    // unrated puzzles are not beginner puzzles.
    const unrated = archive.filter((entry) => entry.difficulty === 0);
    expect(unrated.length).toBeGreaterThan(0);

    const hidden = filterArchive(archive, with_({ maxDifficulty: 3, includeUnrated: false }));
    expect(hidden.some((entry) => entry.difficulty === 0)).toBe(false);

    const shown = filterArchive(archive, with_({ maxDifficulty: 3, includeUnrated: true }));
    expect(shown.filter((entry) => entry.difficulty === 0)).toHaveLength(unrated.length);
  });

  test("an unrated puzzle ignores the range entirely, in both directions", () => {
    const entry = listing({ difficulty: 0 });
    expect(matchesFilter(entry, with_({ minDifficulty: 9, maxDifficulty: 20 }))).toBe(true);
    expect(matchesFilter(entry, with_({ includeUnrated: false }))).toBe(false);
  });
});

describe("length", () => {
  test("counts the pieces a player actually places", () => {
    // The queue alone undercounts every puzzle that starts with one in hold,
    // which would make a filter for short puzzles quietly wrong.
    const held = raw.find((puzzle) => puzzle.hold);
    expect(held).toBeDefined();
    expect(toListing(held!).pieces).toBe(held!.queue.length + 1);
  });

  test("a range keeps only what is inside it", () => {
    const kept = filterArchive(archive, with_({ maxPieces: 5 }));
    expect(kept.length).toBeGreaterThan(0);
    for (const entry of kept) expect(entry.pieces).toBeLessThanOrEqual(5);
  });
});

describe("search", () => {
  test("looks across title, author, goal and set at once", () => {
    for (const [term, read] of [
      ["baron", (e: ArchiveListing) => e.author],
      ["tsd", (e: ArchiveListing) => e.goal],
    ] as const) {
      const kept = filterArchive(archive, with_({ search: term }));
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.some((entry) => read(entry).toLowerCase().includes(term))).toBe(true);
    }
  });

  test("every word has to match, so terms narrow rather than widen", () => {
    const one = filterArchive(archive, with_({ search: "tsd" }));
    const two = filterArchive(archive, with_({ search: "tsd quad" }));
    expect(two.length).toBeLessThan(one.length);
    expect(two.every((entry) => one.some((other) => other.id === entry.id))).toBe(true);
  });

  test("ignores case and surrounding space", () => {
    const plain = filterArchive(archive, with_({ search: "tsd" }));
    expect(filterArchive(archive, with_({ search: "  TSD  " }))).toEqual(plain);
  });

  test("a search matching nothing returns nothing rather than everything", () => {
    expect(filterArchive(archive, with_({ search: "zzzzzznothing" }))).toEqual([]);
  });
});

describe("sorting", () => {
  test("by length, ascending, with the puzzle number breaking ties", () => {
    const sorted = filterArchive(archive, with_({ sort: "pieces" }));
    for (let i = 1; i < sorted.length; i++) {
      const before = sorted[i - 1]!;
      const after = sorted[i]!;
      expect(
        before.pieces < after.pieces ||
          (before.pieces === after.pieces && before.id < after.id),
      ).toBe(true);
    }
  });

  test("by difficulty, with unrated at the bottom rather than the top", () => {
    const sorted = filterArchive(archive, with_({ sort: "difficulty" }));
    const firstUnrated = sorted.findIndex((entry) => entry.difficulty === 0);
    expect(firstUnrated).toBeGreaterThan(0);
    expect(sorted.slice(firstUnrated).every((entry) => entry.difficulty === 0)).toBe(true);
  });

  test("sorting never adds or drops a puzzle", () => {
    for (const sort of ["number", "difficulty", "pieces", "title"] as const) {
      expect(filterArchive(archive, with_({ sort })).length).toBe(archive.length);
    }
  });

  test("the caller's list is left alone", () => {
    const before = archive.map((entry) => entry.id);
    filterArchive(archive, with_({ sort: "title" }));
    expect(archive.map((entry) => entry.id)).toEqual(before);
  });
});

describe("sanitizing what a client sends", () => {
  test("clamps every range to its bounds", () => {
    const filter = sanitizeArchiveFilter({
      minDifficulty: -999,
      maxDifficulty: 999,
      minPieces: -1,
      maxPieces: 10_000,
    });
    expect(filter.minDifficulty).toBe(MIN_DIFFICULTY);
    expect(filter.maxDifficulty).toBe(MAX_DIFFICULTY);
    expect(filter.minPieces).toBe(MIN_PIECES);
    expect(filter.maxPieces).toBe(MAX_PIECES);
  });

  test("reads a range dragged inside out the way it was meant", () => {
    const filter = sanitizeArchiveFilter({ minDifficulty: 12, maxDifficulty: 4 });
    expect(filter.minDifficulty).toBe(4);
    expect(filter.maxDifficulty).toBe(12);
    // And it still selects something, rather than nothing at all.
    expect(filterArchive(archive, filter).length).toBeGreaterThan(0);
  });

  test("bounds the search box, which is stored on the server", () => {
    const filter = sanitizeArchiveFilter({ search: "x".repeat(50_000) });
    expect(filter.search.length).toBeLessThanOrEqual(64);
  });

  test("bounds the name lists, which are stored on the server", () => {
    const filter = sanitizeArchiveFilter({
      sets: Array.from({ length: 500 }, (_, i) => `set-${i}`),
      authors: Array.from({ length: 500 }, () => "y".repeat(5_000)),
    });
    expect(filter.sets.length).toBeLessThanOrEqual(32);
    expect(filter.authors).toEqual([]);
  });

  test("discards junk rather than trusting it", () => {
    const filter = sanitizeArchiveFilter({
      search: 42,
      sort: "; DROP TABLE runs",
      sets: "not-an-array",
      includeUnrated: "yes please",
      minPieces: Number.NaN,
    });
    expect(filter.search).toBe("");
    expect(filter.sort).toBe("number");
    expect(filter.sets).toEqual([]);
    expect(filter.includeUnrated).toBe(true);
    expect(filter.minPieces).toBe(MIN_PIECES);
  });

  test("nothing at all becomes the default", () => {
    for (const input of [undefined, null, 0, "", []]) {
      expect(sanitizeArchiveFilter(input)).toEqual(DEFAULT_ARCHIVE_FILTER);
    }
  });
});
