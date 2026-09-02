/**
 * Filtering the puzzle archive.
 *
 * The whole archive is twenty-odd kilobytes, so this runs in the browser
 * against the list it already has rather than as a query the server answers.
 * It lives in `shared/` all the same, because the filter is part of a player's
 * saved preferences and the server has to bound what it writes to that row.
 */

import type { ArchiveListing } from "./puzzle";

/** The author's own 1–20 scale. Zero means unrated, which is not a rating. */
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 20;
export const MIN_PIECES = 1;
export const MAX_PIECES = 80;

/** Longer than this and a search box is being used as a payload. */
const MAX_SEARCH_LENGTH = 64;

export type ArchiveSort = "number" | "difficulty" | "pieces" | "title";

const SORTS: readonly ArchiveSort[] = ["number", "difficulty", "pieces", "title"];

export const SORT_LABELS: Readonly<Record<ArchiveSort, string>> = {
  number: "Puzzle number",
  difficulty: "Difficulty",
  pieces: "Length",
  title: "Title",
};

export interface ArchiveFilter {
  /** Matched against title, author, goal and set together. */
  readonly search: string;
  readonly minDifficulty: number;
  readonly maxDifficulty: number;
  /**
   * Unrated puzzles carry `difficulty: 0`, which no difficulty range can
   * sensibly include — a range of 1 to 20 that silently dropped them would
   * hide seven puzzles for no reason a player could see. They are in or out on
   * their own say-so.
   */
  readonly includeUnrated: boolean;
  readonly minPieces: number;
  readonly maxPieces: number;
  /** Empty means any. Sets are the archive's own groupings. */
  readonly sets: readonly string[];
  /** Empty means any. */
  readonly authors: readonly string[];
  readonly sort: ArchiveSort;
}

export const DEFAULT_ARCHIVE_FILTER: ArchiveFilter = {
  search: "",
  minDifficulty: MIN_DIFFICULTY,
  maxDifficulty: MAX_DIFFICULTY,
  includeUnrated: true,
  minPieces: MIN_PIECES,
  maxPieces: MAX_PIECES,
  sets: [],
  authors: [],
  sort: "number",
};

function clampInt(value: unknown, low: number, high: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(high, Math.max(low, Math.round(value)));
}

/** Keeps a bounded list of short strings, dropping anything else. */
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const kept = value.filter(
    (name): name is string => typeof name === "string" && name.length > 0 && name.length <= 64,
  );
  return [...new Set(kept)].slice(0, 32);
}

/**
 * Coerces a stored or submitted filter into a usable one.
 *
 * Bounded on every axis because this is written to the preferences row from a
 * request body: without it the row is free unbounded storage for anyone with a
 * session, the same reason the handling and keybind values are bounded.
 */
export function sanitizeArchiveFilter(input: unknown): ArchiveFilter {
  const raw = (input ?? {}) as Partial<ArchiveFilter>;
  const minDifficulty = clampInt(raw.minDifficulty, MIN_DIFFICULTY, MAX_DIFFICULTY, MIN_DIFFICULTY);
  const maxDifficulty = clampInt(raw.maxDifficulty, MIN_DIFFICULTY, MAX_DIFFICULTY, MAX_DIFFICULTY);
  const minPieces = clampInt(raw.minPieces, MIN_PIECES, MAX_PIECES, MIN_PIECES);
  const maxPieces = clampInt(raw.maxPieces, MIN_PIECES, MAX_PIECES, MAX_PIECES);
  const sort = SORTS.includes(raw.sort as ArchiveSort) ? (raw.sort as ArchiveSort) : "number";
  return {
    search: typeof raw.search === "string" ? raw.search.slice(0, MAX_SEARCH_LENGTH) : "",
    // A range whose ends have been dragged past each other is a slider mishap,
    // not a request for nothing; it is read the way it was clearly meant.
    minDifficulty: Math.min(minDifficulty, maxDifficulty),
    maxDifficulty: Math.max(minDifficulty, maxDifficulty),
    includeUnrated: raw.includeUnrated !== false,
    minPieces: Math.min(minPieces, maxPieces),
    maxPieces: Math.max(minPieces, maxPieces),
    sets: names(raw.sets),
    authors: names(raw.authors),
    sort,
  };
}

/** Whether a filter would let everything through, for telling the player so. */
export function isDefaultFilter(filter: ArchiveFilter): boolean {
  return (
    filter.search.trim() === "" &&
    filter.minDifficulty === MIN_DIFFICULTY &&
    filter.maxDifficulty === MAX_DIFFICULTY &&
    filter.includeUnrated &&
    filter.minPieces === MIN_PIECES &&
    filter.maxPieces === MAX_PIECES &&
    filter.sets.length === 0 &&
    filter.authors.length === 0
  );
}

const UNRATED = 0;

export function matchesFilter(entry: ArchiveListing, filter: ArchiveFilter): boolean {
  if (entry.difficulty === UNRATED) {
    if (!filter.includeUnrated) return false;
  } else if (entry.difficulty < filter.minDifficulty || entry.difficulty > filter.maxDifficulty) {
    return false;
  }
  if (entry.pieces < filter.minPieces || entry.pieces > filter.maxPieces) return false;
  if (filter.sets.length > 0 && !filter.sets.includes(entry.set ?? "")) return false;
  if (filter.authors.length > 0 && !filter.authors.includes(entry.author)) return false;

  const search = filter.search.trim().toLowerCase();
  if (search === "") return true;
  // One box across every text field, because a player looking for "tsd" does
  // not know or care whether the archive filed that under the goal or the title.
  const haystack = `${entry.title} ${entry.author} ${entry.goal} ${entry.set ?? ""}`.toLowerCase();
  return search.split(/\s+/).every((term) => haystack.includes(term));
}

function compare(a: ArchiveListing, b: ArchiveListing, sort: ArchiveSort): number {
  switch (sort) {
    case "difficulty":
      // Unrated has no place on a difficulty ladder, so it sits at the bottom
      // rather than at the top pretending to be the easiest thing here.
      return (a.difficulty || Infinity) - (b.difficulty || Infinity) || a.id - b.id;
    case "pieces":
      return a.pieces - b.pieces || a.id - b.id;
    case "title":
      return a.title.localeCompare(b.title) || a.id - b.id;
    case "number":
      return a.id - b.id;
  }
}

/** The matching puzzles, in the filter's order. The input is left alone. */
export function filterArchive(
  entries: readonly ArchiveListing[],
  filter: ArchiveFilter,
): ArchiveListing[] {
  return entries
    .filter((entry) => matchesFilter(entry, filter))
    .sort((a, b) => compare(a, b, filter.sort));
}
