/**
 * What the puzzle database says, in the shapes its server and its page share.
 *
 * db.tetrisatuci.org is two programs that must agree to the byte: a server that
 * builds `/puzzles.json` and renders each page's `<title>` and description, and
 * a page that reads that JSON, routes by path and sets the same title as the
 * reader moves around. Every rule they have to agree on lives here, once — the
 * JSON's shape, which paths are pages, what each page is called, and how a day
 * number becomes a date. Written twice, they would drift, and the failure is
 * quiet: a link that works when clicked and 404s when shared, or an unfurl that
 * names a different puzzle from the tab it opens.
 *
 * **Importable by both Bun and Vite, so it imports by relative path only and
 * touches no Node or Bun API.** Its one runtime import, `shared/daily.ts`, is
 * already part of the game's page.
 *
 * Nothing here escapes HTML. Text is returned raw and the server's `head.ts`
 * escapes it; the page only ever sets it as text. Escaping here would put
 * `&amp;` in a tab title.
 */

import { type DailyTier, EPOCH_UTC } from "../shared/daily";
import type { ClearRequirement, Mino, RowCode, SolutionStep } from "../shared/puzzle";

/** The public database's schema: `PRAGMA user_version` in the download and `about.schema`. */
export const SCHEMA_VERSION = 1;

/** The site's name, as `og:site_name` gives it to an unfurl. */
export const SITE_NAME = "Tetris at UCI puzzle archive";

/**
 * The longest page description, counted in code points with the ellipsis.
 *
 * Code points rather than `.length`, which counts UTF-16 units: a cut by length
 * can land between the two halves of an emoji and hand an unfurl a lone
 * surrogate. Two hundred is past what Discord and the search engines show, so
 * the cut only ever trims what nobody would have read.
 */
export const DESCRIPTION_LIMIT = 200;

/** One puzzle as players are dealt it: the club's file and published rows, corrections applied. */
export interface SitePuzzle {
  readonly id: number;
  readonly title: string;
  readonly author: string;
  /** The club's rating, or null when unrated — the game stores 0, as `/api/public` reports. */
  readonly difficulty: number | null;
  /** `dailyTierOf` over the corrected difficulty: the tier it is dealt in now. */
  readonly tier: DailyTier;
  readonly goal: string;
  readonly set: string | null;
  /** Rows from the floor up, ten characters each. */
  readonly board: readonly RowCode[];
  readonly queue: readonly Mino[];
  readonly hold: Mino | null;
  /** `pieceBudget`: the queue plus any held piece — what a player actually places. */
  readonly pieces: number;
  readonly targetAttack: number;
  /**
   * Null when nobody has decided, `[]` when somebody decided no count can hold
   * the goal. Data only: the page never shows it, because the game shows it
   * only under `GOAL_ENFORCEMENT=on`, which is the owner's call.
   */
  readonly requiredClears: readonly ClearRequirement[] | null;
  /** The maker's answer, or null when none is on file. Never `[]`. */
  readonly solution: readonly SolutionStep[] | null;
  /** The Blueprint codes, when both are known. */
  readonly source: { readonly puzzle: string; readonly solution: string } | null;
  readonly puzzleUrl: string | null;
  readonly solutionUrl: string | null;
}

/** One tier of a finished day. A null id is a puzzle a player wrote, which is not listed. */
export interface SiteDeal {
  readonly tier: DailyTier;
  readonly puzzleId: number | null;
}

/** One finished day, with its deals in `DAILY_TIERS` order and never empty. */
export interface SiteDay {
  readonly day: number;
  /** The club's calendar date, `YYYY-MM-DD`: {@link dateOfDay}. */
  readonly date: string;
  readonly deals: readonly SiteDeal[];
}

export interface SiteAbout {
  readonly schema: number;
  /** ISO time of the build. */
  readonly builtAt: string;
  /** Where history starts. */
  readonly firstDay: number;
  /** The newest finished day shown, or null while there is none. */
  readonly throughDay: number | null;
}

/** `GET /puzzles.json`, whole. */
export interface SiteData {
  readonly about: SiteAbout;
  /** In id order. */
  readonly puzzles: readonly SitePuzzle[];
  /** Ascending. */
  readonly days: readonly SiteDay[];
}

/** A page of the site. The browse filter lives in the query string, not here. */
export type PageRoute =
  | { readonly kind: "browse" }
  | { readonly kind: "days" }
  | { readonly kind: "puzzle"; readonly id: number }
  | { readonly kind: "day"; readonly day: number };

/** How a page finds what it names. The server builds one from its dataset, the page from its index. */
export interface SiteLookup {
  puzzle(id: number): SitePuzzle | undefined;
  day(day: number): SiteDay | undefined;
}

/** A page's `<title>` and description, as raw text. */
export interface PageText {
  readonly title: string;
  readonly description: string;
}

const BROWSE: PageRoute = Object.freeze({ kind: "browse" });
const DAYS: PageRoute = Object.freeze({ kind: "days" });

/**
 * One spelling per page: no leading zero, no trailing slash, no case variant.
 *
 * Two addresses for one page would split every shared link's unfurl, and every
 * search engine's idea of which address is the page. Seven digits takes the
 * community band (100000 and up) with room; five takes any day this site will
 * see.
 */
const PUZZLE_PATH = /^\/puzzle\/([1-9][0-9]{0,6})$/;
const DAY_PATH = /^\/day\/([1-9][0-9]{0,4})$/;

/**
 * The page a path names, or null when it names none.
 *
 * Null is a 404 on the server and the missing view on the page, so the two
 * cannot disagree about which links exist.
 */
export function parsePage(pathname: string): PageRoute | null {
  if (pathname === "/") return BROWSE;
  if (pathname === "/days") return DAYS;
  const puzzle = PUZZLE_PATH.exec(pathname);
  if (puzzle) return Object.freeze({ kind: "puzzle", id: Number(puzzle[1]) });
  const day = DAY_PATH.exec(pathname);
  if (day) return Object.freeze({ kind: "day", day: Number(day[1]) });
  return null;
}

/** The path of a page: the inverse of {@link parsePage}. */
export function pathOf(route: PageRoute): string {
  switch (route.kind) {
    case "browse":
      return "/";
    case "days":
      return "/days";
    case "puzzle":
      return `/puzzle/${route.id}`;
    case "day":
      return `/day/${route.day}`;
  }
}

const SUFFIX = " — Puzzle archive";

const BROWSE_TEXT: PageText = Object.freeze({
  title: "Puzzle archive — Daily Tetris",
  description:
    "Every club puzzle the Tetris at UCI daily deals from, with each maker's answer, " +
    "and the puzzles every finished day dealt.",
});

const DAYS_TEXT: PageText = Object.freeze({
  title: `Daily history${SUFFIX}`,
  description: "Which puzzles each finished day of the Tetris at UCI daily dealt.",
});

/** The 404 page's text: one text for every missing thing, so a miss says nothing about why. */
export const NOT_FOUND_TEXT: PageText = Object.freeze({
  title: `Not found${SUFFIX}`,
  description: "There is no such page in the Tetris at UCI puzzle archive.",
});

/** The text while there is no dataset to serve: before the first build, or while none can be made. */
export const UNAVAILABLE_TEXT: PageText = Object.freeze({
  title: "Puzzle archive — Daily Tetris",
  description: "The archive is not available right now. Try again in a minute.",
});

/**
 * A page's title and description, or null when the page is not on this site.
 *
 * Null is what makes a 404, and it is decided by the lookup alone: a puzzle
 * that is unpublished, written by a player while those are withheld, or simply
 * absent is missing in exactly the same way, so a stranger cannot tell them
 * apart. The same holds for today, a future day and a day before history.
 */
export function pageText(route: PageRoute, lookup: SiteLookup): PageText | null {
  switch (route.kind) {
    case "browse":
      return BROWSE_TEXT;
    case "days":
      return DAYS_TEXT;
    case "puzzle": {
      const puzzle = lookup.puzzle(route.id);
      return puzzle ? puzzleText(puzzle) : null;
    }
    case "day": {
      const day = lookup.day(route.day);
      return day ? dayText(day, lookup) : null;
    }
  }
}

/** `#42 Jelly`, and `Hard · difficulty 6 · 9 pieces · send 12 · by baron. 3 TST`. */
function puzzleText(puzzle: SitePuzzle): PageText {
  const author = oneLine(puzzle.author);
  const goal = oneLine(puzzle.goal);
  const facts = [
    capitalized(puzzle.tier),
    puzzle.difficulty === null ? "unrated" : `difficulty ${puzzle.difficulty}`,
    puzzle.pieces === 1 ? "1 piece" : `${puzzle.pieces} pieces`,
    `send ${puzzle.targetAttack}`,
    ...(author ? [`by ${author}`] : []),
  ].join(" · ");
  return Object.freeze({
    title: `#${puzzle.id} ${titleOf(puzzle)}${SUFFIX}`,
    description: clipped(goal ? `${facts}. ${goal}` : `${facts}.`),
  });
}

/** `Day 274 · Thu, Oct 1, 2026`, and each deal by tier. */
function dayText(day: SiteDay, lookup: SiteLookup): PageText {
  const deals = day.deals.map((deal) => {
    if (deal.puzzleId === null) return `${deal.tier}: a puzzle written by a player`;
    const puzzle = lookup.puzzle(deal.puzzleId);
    // A club id the archive no longer holds keeps its number: it was dealt, and
    // saying so is the truth, where leaving the tier out would not be.
    if (!puzzle) return `${deal.tier} #${deal.puzzleId} (no longer in the archive)`;
    return `${deal.tier} #${puzzle.id} ${titleOf(puzzle)}`;
  });
  return Object.freeze({
    title: `Day ${day.day} · ${dayLabel(day.day)}${SUFFIX}`,
    description: clipped(deals.join(" · ")),
  });
}

function titleOf(puzzle: SitePuzzle): string {
  return oneLine(puzzle.title) || "untitled";
}

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Author-typed text on one line.
 *
 * Three of the club's goals carry a newline, and a title or a description is
 * one line wherever it ends up — a tab, an unfurl, a search result — which
 * shows a break as a break, as nothing, or as a gap. Collapsing every run of
 * whitespace to one space is what all three would have meant.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** At most {@link DESCRIPTION_LIMIT} code points, the ellipsis included. */
function clipped(text: string): string {
  const points = Array.from(text);
  if (points.length <= DESCRIPTION_LIMIT) return text;
  return `${points.slice(0, DESCRIPTION_LIMIT - 1).join("").trimEnd()}…`;
}

const MS_PER_DAY = 86_400_000;

/**
 * English on purpose, and written out rather than asked of `Intl`: the label
 * must be identical on the server, in every browser and in every year, and an
 * ICU update is allowed to reword a formatted date.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * Midnight UTC on a day's calendar date.
 *
 * A day number already *is* a date on the club's clock — `dayNumber` read it
 * off an Irvine wall clock — so turning it back into one is plain arithmetic
 * from {@link EPOCH_UTC}, done in UTC where no day is ever 23 or 25 hours long.
 * No zone is involved, so a day keeps its date whatever zone the reader is in.
 */
function midnightOf(day: number): Date {
  return new Date(EPOCH_UTC + (day - 1) * MS_PER_DAY);
}

/** A day's calendar date, `YYYY-MM-DD`. Day 1 is 2026-01-01; day 274 is 2026-10-01. */
export function dateOfDay(day: number): string {
  return midnightOf(day).toISOString().slice(0, 10);
}

/** A day's date for a reader: day 274 is `Thu, Oct 1, 2026`. */
export function dayLabel(day: number): string {
  const date = midnightOf(day);
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}
