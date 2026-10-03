/**
 * The archive as the page holds it: checked once on arrival, then indexed
 * every way a view asks for it.
 *
 * `/puzzles.json` is read once per visit and never again — the whole archive
 * is about twenty-five kilobytes gzipped — so every view after the first is
 * built from this index without a request, and every lookup a view makes is a
 * map read rather than a scan.
 *
 * The one piece of translation here is {@link listingOf}, and it matters more
 * than it looks: the browse filters are the game's own (`shared/archive-
 * filter.ts`), and they read a different shape from the one the site sends.
 */

import type { DailyTier } from "@shared/daily";
import { type ArchiveListing, COMMUNITY_ID_BASE } from "@shared/puzzle";
import type { SiteData, SiteDay, SiteLookup, SitePuzzle } from "../wire";

/** One finished day a puzzle was dealt on, and the tier that day dealt it as. */
export interface DealtOn {
  readonly day: number;
  readonly tier: DailyTier;
}

export interface SiteIndex {
  readonly data: SiteData;
  /** Every puzzle in the shape the shared filter reads, in id order. */
  readonly listings: readonly ArchiveListing[];
  readonly byId: ReadonlyMap<number, SitePuzzle>;
  readonly dayByNumber: ReadonlyMap<number, SiteDay>;
  /** Each listed puzzle's finished days, newest first. A puzzle never dealt has no entry. */
  readonly dealsOf: ReadonlyMap<number, readonly DealtOn[]>;
  /** The lookup `pageText` takes, so the page names and misses pages exactly as the server does. */
  readonly lookup: SiteLookup;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The payload, if it is the archive's shape at the top; otherwise a throw.
 *
 * Shallow on purpose. The server builds this file from its own allowlisted
 * database and the page ships beside it, so the question worth asking is not
 * "is every field right" but "is this the archive at all" — a proxy's error
 * page sent with a 200, a captive portal, a stale service from another
 * checkout. Those fail here, at the door, with a sentence, rather than three
 * views later as `undefined is not iterable`.
 */
export function readSiteData(value: unknown): SiteData {
  if (!isRecord(value)) throw new Error("The archive's data is not an object.");
  if (!isRecord(value.about)) throw new Error("The archive's data has no `about`.");
  if (!Array.isArray(value.puzzles)) throw new Error("The archive's data has no list of puzzles.");
  if (!Array.isArray(value.days)) throw new Error("The archive's data has no list of days.");
  return value as unknown as SiteData;
}

/**
 * A puzzle in the shape `shared/archive-filter.ts` filters.
 *
 * Three fields differ, and getting any of them wrong fails silently rather
 * than loudly. The site says an unrated puzzle's difficulty is `null`, as
 * `/api/public` does; the filter reads unrated as `0`, and fed `null` it drops
 * every unrated puzzle from every range, because `null < 1` holds. `pieces` is
 * the site's own count, the queue plus any held piece. And `community` is the
 * id band, which is the only record of where a puzzle came from.
 */
export function listingOf(puzzle: SitePuzzle): ArchiveListing {
  return {
    id: puzzle.id,
    title: puzzle.title,
    author: puzzle.author,
    difficulty: puzzle.difficulty ?? 0,
    goal: puzzle.goal,
    set: puzzle.set,
    pieces: puzzle.pieces,
    targetAttack: puzzle.targetAttack,
    community: puzzle.id >= COMMUNITY_ID_BASE,
  };
}

/**
 * A puzzle's name on screen: its title, or `untitled`.
 *
 * The same rule `pageText` applies to the tab and the unfurl, so a puzzle with
 * a blank title is called one thing everywhere it appears.
 */
export function titleOf(puzzle: Pick<SitePuzzle, "title">): string {
  return puzzle.title.trim() || "untitled";
}

/** `d6 · 9p`, or `unrated · 9p` — the in-game explorer's shorthand, so a reader of both reads one. */
export function ratingOf(puzzle: Pick<SitePuzzle, "difficulty" | "pieces">): string {
  return `${puzzle.difficulty === null ? "unrated" : `d${puzzle.difficulty}`} · ${puzzle.pieces}p`;
}

/** Which finished days dealt each puzzle, newest first. A deal of an unlisted puzzle is nobody's. */
function dealsByPuzzle(days: readonly SiteDay[]): ReadonlyMap<number, readonly DealtOn[]> {
  const dealt = new Map<number, DealtOn[]>();
  for (const day of [...days].sort((a, b) => b.day - a.day)) {
    for (const deal of day.deals) {
      if (deal.puzzleId === null) continue;
      const entry: DealtOn = Object.freeze({ day: day.day, tier: deal.tier });
      dealt.set(deal.puzzleId, [...(dealt.get(deal.puzzleId) ?? []), entry]);
    }
  }
  return new Map([...dealt].map(([id, list]) => [id, Object.freeze(list)]));
}

/** Everything the views need, built once from the payload and frozen. */
export function indexSiteData(data: SiteData): SiteIndex {
  const byId: ReadonlyMap<number, SitePuzzle> = new Map(data.puzzles.map((puzzle) => [puzzle.id, puzzle]));
  const dayByNumber: ReadonlyMap<number, SiteDay> = new Map(data.days.map((day) => [day.day, day]));
  return Object.freeze({
    data,
    listings: Object.freeze(data.puzzles.map(listingOf)),
    byId,
    dayByNumber,
    dealsOf: dealsByPuzzle(data.days),
    lookup: Object.freeze({
      puzzle: (id: number) => byId.get(id),
      day: (day: number) => dayByNumber.get(day),
    }),
  });
}
