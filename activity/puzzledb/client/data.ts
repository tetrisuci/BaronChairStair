/**
 * The archive as the page holds it: checked once on arrival, then indexed
 * every way a view asks for it.
 *
 * `/puzzles.json` is read once per visit and never again — the puzzles, the
 * days, the listed players and the servers — so every page can be named, and
 * every list drawn, from this index without a request, and every lookup a view
 * makes is a map read rather than a scan. What a page shows beyond the index —
 * a day's boards, a player's runs, a puzzle's lines, the all-time boards — is
 * one body from `/data/…`, fetched as the page opens and checked here at the
 * door the same shallow way the index is ({@link readBody}).
 *
 * The one piece of translation here is {@link listingOf}, and it matters more
 * than it looks: the browse filters are the game's own (`shared/archive-
 * filter.ts`), and they read a different shape from the one the site sends.
 */

import type { DailyTier } from "@shared/daily";
import { type ArchiveListing, COMMUNITY_ID_BASE } from "@shared/puzzle";
import type {
  SiteData,
  SiteDay,
  SiteDayBody,
  SiteLeaderboardsBody,
  SiteLookup,
  SitePlayerBody,
  SitePlayerEntry,
  SitePuzzle,
  SitePuzzleBody,
  SiteServer,
} from "../wire";

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
  /** Every listed player by key. A player who hid is not here, exactly as a key nobody holds. */
  readonly playerByKey: ReadonlyMap<string, SitePlayerEntry>;
  /** Every server some published row names, by key. */
  readonly serverByKey: ReadonlyMap<string, SiteServer>;
  /** The lookup `pageText` takes, so the page names and misses pages exactly as the server does. */
  readonly lookup: SiteLookup;
}

/**
 * What a view that draws boards needs from the page besides the data.
 *
 * The server chip lives in the address, `?server=<key>`, so a shared link
 * opens on the same board; the page reads it and the view draws it. A chip
 * press is redrawn by the view in place — it is a filter, not a page, and the
 * reader's place on a long day page must not jump to the top — and the page
 * writes it into the address without a history entry, as it does the browse
 * filter.
 */
export interface ViewContext {
  /** The server the address names, already checked against the index; null is every server. */
  readonly server: string | null;
  /** The reader picked a chip: null is every server. */
  onServer(server: string | null): void;
}

/**
 * A page whose body is still on its way: the part the index alone can draw,
 * and the slot the body goes into.
 *
 * The page puts its "reading" and "could not load" notes in the slot, so a
 * view never has to know how its body travels, only what to do with one.
 * `fill` checks the body's shape itself and throws when it is not the shape
 * it asked for, which the page treats as any other failed load.
 */
export interface BodyView {
  readonly element: HTMLElement;
  readonly slot: HTMLElement;
  fill(body: unknown): void;
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
  if (!Array.isArray(value.players)) throw new Error("The archive's data has no list of players.");
  if (!Array.isArray(value.servers)) throw new Error("The archive's data has no list of servers.");
  return value as unknown as SiteData;
}

/** The fields each body must have at its top, each an object (`{}`) or a list (`[]`). */
const BODY_FIELDS = {
  day: { boards: "{}", tiers: "[]", rush: "[]" },
  player: { totals: "{}", runs: "[]", rush: "[]" },
  puzzle: { lines: "[]" },
  leaderboards: { boards: "{}" },
} as const;

type BodyKind = keyof typeof BODY_FIELDS;

/** The body each page reads. */
interface BodyOf {
  day: SiteDayBody;
  player: SitePlayerBody;
  puzzle: SitePuzzleBody;
  leaderboards: SiteLeaderboardsBody;
}

/**
 * A page's body, if it is that body's shape at the top; otherwise a throw.
 *
 * Shallow, for the reason {@link readSiteData} gives: the question is whether
 * this is the body at all, not whether every row is right. A puzzle's `stats`
 * may be null, so it is checked only for being an object when present.
 */
export function readBody<K extends BodyKind>(kind: K, value: unknown): BodyOf[K] {
  if (!isRecord(value) || typeof value.builtAt !== "string") throw new Error(`The ${kind} data is not an object.`);
  for (const [field, shape] of Object.entries(BODY_FIELDS[kind])) {
    const held = value[field];
    if (shape === "[]" ? !Array.isArray(held) : !isRecord(held)) throw new Error(`The ${kind} data has no \`${field}\`.`);
  }
  if (kind === "puzzle" && value.stats !== null && !isRecord(value.stats)) {
    throw new Error("The puzzle data's `stats` is not an object.");
  }
  return value as unknown as BodyOf[K];
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
  const playerByKey: ReadonlyMap<string, SitePlayerEntry> = new Map(data.players.map((player) => [player.key, player]));
  return Object.freeze({
    data,
    listings: Object.freeze(data.puzzles.map(listingOf)),
    byId,
    dayByNumber,
    dealsOf: dealsByPuzzle(data.days),
    playerByKey,
    serverByKey: new Map(data.servers.map((server) => [server.key, server])),
    lookup: Object.freeze({
      puzzle: (id: number) => byId.get(id),
      day: (day: number) => dayByNumber.get(day),
      player: (key: string) => playerByKey.get(key),
    }),
  });
}
