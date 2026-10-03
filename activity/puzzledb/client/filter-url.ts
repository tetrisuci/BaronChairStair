/**
 * The browse filter, kept in the address bar.
 *
 * A filtered list is something people send each other — "every unrated puzzle
 * by baron", "the short ones, hardest first" — so the filter lives in the
 * query string, where a copied link carries it and a refresh keeps it. It is
 * written with `history.replaceState` on every change rather than pushed, so
 * typing a search does not leave a history entry per keystroke between the
 * reader and the page they came from.
 *
 * **Read back through the game's own sanitizer.** A query string is typed by
 * anyone, and `sanitizeArchiveFilter` already exists for exactly that: it
 * bounds what a request may write into a player's saved preferences. So junk
 * here is read the way the game reads a junk stored filter — clamped, swapped
 * round, or dropped — and no rule about what a filter may be is written twice.
 *
 * The parameters, each left out while it holds its default, so the everyday
 * address is the bare one:
 *
 * | | |
 * |---|---|
 * | `q` | search text |
 * | `d` | difficulty range, `3-7` (or `5` for exactly five) |
 * | `u=0` | unrated puzzles hidden |
 * | `p` | pieces range, as `d` |
 * | `set`, `by` | a set, an author; repeatable |
 * | `sort` | `difficulty`, `pieces` or `title`; number order is the default |
 */

import { type ArchiveFilter, DEFAULT_ARCHIVE_FILTER, sanitizeArchiveFilter } from "@shared/archive-filter";

/** `3-7`, or `5`. Three digits is past either scale, so clamping still has something to clamp. */
const RANGE = /^(\d{1,3})(?:-(\d{1,3}))?$/;

/** A range parameter's two ends, or neither when it is missing or junk — the sanitizer fills them in. */
function readRange(text: string | null): { readonly min?: number; readonly max?: number } {
  const match = text === null ? null : RANGE.exec(text);
  if (!match) return {};
  const min = Number(match[1]);
  return { min, max: match[2] === undefined ? min : Number(match[2]) };
}

/** The filter a query string asks for, sanitized. `""` is the default filter. */
export function filterFromQuery(search: string): ArchiveFilter {
  const params = new URLSearchParams(search);
  const difficulty = readRange(params.get("d"));
  const pieces = readRange(params.get("p"));
  return sanitizeArchiveFilter({
    search: params.get("q") ?? "",
    minDifficulty: difficulty.min,
    maxDifficulty: difficulty.max,
    includeUnrated: params.get("u") !== "0",
    minPieces: pieces.min,
    maxPieces: pieces.max,
    sets: params.getAll("set"),
    authors: params.getAll("by"),
    sort: params.get("sort") ?? undefined,
  });
}

/** The query string for a filter: `""` for the default, else `?…` with only what differs from it. */
export function queryFromFilter(filter: ArchiveFilter): string {
  const plain = DEFAULT_ARCHIVE_FILTER;
  const params = new URLSearchParams();
  if (filter.search.trim() !== "") params.set("q", filter.search);
  if (filter.minDifficulty !== plain.minDifficulty || filter.maxDifficulty !== plain.maxDifficulty) {
    params.set("d", `${filter.minDifficulty}-${filter.maxDifficulty}`);
  }
  if (!filter.includeUnrated) params.set("u", "0");
  if (filter.minPieces !== plain.minPieces || filter.maxPieces !== plain.maxPieces) {
    params.set("p", `${filter.minPieces}-${filter.maxPieces}`);
  }
  for (const set of filter.sets) params.append("set", set);
  for (const author of filter.authors) params.append("by", author);
  if (filter.sort !== plain.sort) params.set("sort", filter.sort);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}
