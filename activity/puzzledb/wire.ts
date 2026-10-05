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
 * Since schema 2 the site publishes how finished days went, not only what they
 * dealt, and that adds a second kind of JSON. `/puzzles.json` stays the one
 * index every visit reads — now with the shown players and the servers in it —
 * and each page that needs more fetches one body from `/data/…`
 * ({@link bodyPathFor}). A club-year of boards is hundreds of kilobytes; one
 * day's board or one player's page is under one. The body shapes are here for
 * the same reason as the index's: the build writes them and the page reads
 * them, and a field renamed on one side alone is a view that silently renders
 * nothing.
 *
 * **Who a row belongs to is a {@link PlayerRef}, and never anything else.** A
 * shown player is their public key and the name the game shows; a player who
 * chose "Hide me on db.tetrisatuci.org" is `null`, rendered "a player". No
 * shape here has room for a Discord id, a guild id or an avatar, because the
 * honest way to keep a field out of the JSON is to have nowhere to put it.
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
import type { ClearName, ClearRequirement, Mino, RowCode, SolutionStep } from "../shared/puzzle";

/**
 * The public database's schema: `PRAGMA user_version` in the download and
 * `about.schema`. 1 was the puzzles and days alone; 2 adds the boards, the
 * standings, each puzzle's stats and the players' alternate lines.
 */
export const SCHEMA_VERSION = 2;

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

/**
 * A player listed on the site: one who has not hidden and has something on a
 * finished day. The two numbers are what the player page's description says,
 * so the server can name the page without reading its body.
 */
export interface SitePlayerEntry {
  /** The site's own random name for them (`shared/site.ts`), never a Discord id. */
  readonly key: string;
  /** The username the game shows, as it was at their last sign-in. */
  readonly name: string;
  readonly daysSolved: number;
  readonly bestStreak: number;
}

/**
 * A Discord server with a board here.
 *
 * `name` is what Discord called it at a player's last sign-in from it, and
 * null when nobody has signed in from it since names were first kept, when the
 * name holds a long number, or when the site's owner listed it as one not to
 * name. All three render "Unnamed server", so a reader cannot tell which.
 */
export interface SiteServer {
  readonly key: string;
  readonly name: string | null;
}

/** Whose row it is: a shown player, or null for one who hid, rendered "a player". */
export type PlayerRef = { readonly key: string; readonly name: string } | null;

/** `GET /puzzles.json`, whole. */
export interface SiteData {
  readonly about: SiteAbout;
  /** In id order. */
  readonly puzzles: readonly SitePuzzle[];
  /** Ascending. */
  readonly days: readonly SiteDay[];
  /** Every listed player, sorted by name. A player who hid is not here. */
  readonly players: readonly SitePlayerEntry[];
  /** Every server some published row names, sorted by name, unnamed last. */
  readonly servers: readonly SiteServer[];
}

/**
 * The scope of every server's board at once, beside the per-server scopes
 * that are each a {@link SiteServer.key}. A key is ten characters from an
 * alphabet that spells no word, so it can never be this.
 */
export const ALL_SERVERS = "all";

/**
 * What every body carries: the build it came from, as `about.builtAt` gives it,
 * so a page holding an index and a body from two builds can tell.
 */
export interface SiteBody {
  /** ISO time of the build. */
  readonly builtAt: string;
}

/** How a player's day went in one tier: 0 not played, 1 handed in, 2 solved. */
export type TierMark = 0 | 1 | 2;

/** A day-board row's four tiers. Null is a tier the day did not show. */
export type DayMarks = Readonly<Record<DailyTier, TierMark | null>>;

/** One player's day across its tiers, as the game's own day board ranks it. */
export interface SiteDayBoardRow {
  readonly rank: number;
  readonly player: PlayerRef;
  /** How many tiers they solved. */
  readonly solved: number;
  /** Summed over the solved tiers only. */
  readonly timeMs: number;
  readonly marks: DayMarks;
}

/**
 * One hand-in of one tier, ranked across every server: solved first, then
 * fastest. Attack is published as the game shows it, on every row — a solved
 * row reads as its time and an unsolved one as `attack/target`.
 */
export interface SiteTierRow {
  readonly tier: DailyTier;
  readonly rank: number;
  /** Null when it was played outside any known server. */
  readonly serverKey: string | null;
  readonly player: PlayerRef;
  /** Null when the day dealt a puzzle a player wrote, which is not listed. */
  readonly puzzleId: number | null;
  readonly solved: boolean;
  /** Opening the puzzle to solving it; null when unsolved. */
  readonly timeMs: number | null;
  readonly attack: number;
  readonly targetAttack: number;
}

/** The first ranked rush a player ran on a finished day. */
export interface SiteRushRow {
  readonly rank: number;
  readonly serverKey: string | null;
  readonly player: PlayerRef;
  /** Puzzles solved. */
  readonly solved: number;
  /** To the last solve. */
  readonly timeMs: number;
}

/**
 * Competition ranks over rows already in board order: a row equal to the one
 * before it takes that row's rank, and the next different row takes its own
 * place — "1, 2, 2, 4".
 *
 * A stored `rank` is a row's place in a total order, unique because the public
 * database keys on it, and its tail breaks ties by name. A reader is owed a
 * rank where equal results are equal, and two places print it: a day's boards,
 * over whatever rows a server's view keeps, and a player's page, which prints
 * each hand-in's rank as "2nd". Both go through here with the same `same`, so
 * the two cannot disagree about who was second — and a player's rank cannot
 * move because somebody they tied with renamed or hid.
 */
export function displayRanks<T>(rows: readonly T[], same: (a: T, b: T) => boolean): number[] {
  const ranks: number[] = [];
  rows.forEach((row, at) => {
    const previous = rows[at - 1];
    ranks.push(at > 0 && previous !== undefined && same(previous, row) ? ranks[at - 1]! : at + 1);
  });
  return ranks;
}

/**
 * Two hand-ins the tier board cannot tell apart: the same solve and time, and
 * for a miss the same attack. A solve is shown as its time alone, so two
 * solves in the same time read as a tie whatever attack each sent.
 */
export const sameHandIn = (a: SiteTierRow, b: SiteTierRow): boolean =>
  a.solved === b.solved && a.timeMs === b.timeMs && (a.solved || a.attack === b.attack);

/** Two rushes the rush board cannot tell apart: as many solved, in the same time. */
export const sameRush = (a: SiteRushRow, b: SiteRushRow): boolean => a.solved === b.solved && a.timeMs === b.timeMs;

/** `GET /data/day/:day.json`: how one finished day went. */
export interface SiteDayBody extends SiteBody {
  readonly day: number;
  /** Keyed by {@link ALL_SERVERS} and by each server's key that has a row; ranked. */
  readonly boards: Readonly<Record<string, readonly SiteDayBoardRow[]>>;
  /** Every tier's rows, in `DAILY_TIERS` order and ranked within a tier. */
  readonly tiers: readonly SiteTierRow[];
  readonly rush: readonly SiteRushRow[];
}

/** A shown player's totals, over finished days only. */
export interface SitePlayerTotals {
  /** Days with at least one daily solved. */
  readonly daysSolved: number;
  /** Daily puzzles solved, one per tier per day. */
  readonly dailies: number;
  /** Consecutive solved days ending with the newest finished day. */
  readonly currentStreak: number;
  readonly bestStreak: number;
  /** Distinct puzzles ever solved, any mode. */
  readonly puzzlesCleared: number;
  /** Alternate lines credited to them, counted as the game counts them. */
  readonly linesFound: number;
  readonly rushRuns: number;
  /** Most puzzles solved in one rush, and that rush's time and day; all null with no rush. */
  readonly rushBest: number | null;
  readonly rushBestMs: number | null;
  readonly rushBestDay: number | null;
}

/**
 * One of a player's daily hand-ins. No server and no attack: a player page
 * says how they did, and the day page is where a hand-in sits beside others.
 */
export interface SitePlayerRun {
  readonly day: number;
  readonly tier: DailyTier;
  /**
   * Their rank on that day's tier, across every server, as the day's board
   * shows it: a tie shares the better rank ({@link displayRanks}). Not the
   * stored place, which breaks ties by name.
   */
  readonly rank: number;
  readonly solved: boolean;
  readonly timeMs: number | null;
  readonly puzzleId: number | null;
}

/** One of a player's rushes, with its rank on that day's rush board as the board shows it, ties shared. */
export interface SitePlayerRush {
  readonly day: number;
  readonly rank: number;
  readonly solved: number;
  readonly timeMs: number;
}

/** `GET /data/player/:key.json`: one shown player. Their name is in the index. */
export interface SitePlayerBody extends SiteBody {
  readonly totals: SitePlayerTotals;
  /** Newest day first, then `DAILY_TIERS` order. */
  readonly runs: readonly SitePlayerRun[];
  /** Newest first. */
  readonly rush: readonly SitePlayerRush[];
}

/** How a puzzle went on the finished days it was dealt: daily hand-ins only. */
export interface SitePuzzleStats {
  readonly handIns: number;
  readonly solves: number;
  /** Both null with no solve. */
  readonly fastestMs: number | null;
  readonly medianMs: number | null;
  /** Who was fastest; null with no solve, or when that player hid. */
  readonly fastest: PlayerRef;
}

/**
 * A player's own way through a puzzle besides the maker's: one that solved it
 * or sent more than it asked, found on a finished day. Never who found it, or
 * when — `position` is publication order and nothing more.
 */
export interface SiteLine {
  /** 1 is the earliest day's first line. */
  readonly position: number;
  readonly attack: number;
  readonly clears: readonly ClearName[];
  readonly steps: readonly SolutionStep[];
}

/** `GET /data/puzzle/:id.json`, for a listed puzzle. */
export interface SitePuzzleBody extends SiteBody {
  /** Null when no finished day dealt it. */
  readonly stats: SitePuzzleStats | null;
  readonly lines: readonly SiteLine[];
}

/** The all-time boards, in the order the leaderboards page shows them. */
export const STANDING_BOARDS = Object.freeze([
  "rush",
  "dailies",
  "streak",
  "best_streak",
  "cleared",
  "discoveries",
] as const);

export type StandingBoard = (typeof STANDING_BOARDS)[number];

/**
 * One row of an all-time board. `value` is the board's number: rush puzzles
 * solved, dailies solved, current streak, best streak, puzzles cleared or lines
 * found. `detail` is the second number a shown player's row carries (days
 * solved beside dailies, best streak beside streak) and is null on every row of
 * a player who hid, so that no two of their rows can be matched up by it.
 * `timeMs` and `day` belong to rush rows only.
 */
export interface SiteStanding {
  readonly rank: number;
  readonly player: PlayerRef;
  readonly value: number;
  readonly detail: number | null;
  readonly timeMs: number | null;
  readonly day: number | null;
}

/**
 * `GET /data/leaderboards.json`. Each board is keyed by scope: always
 * {@link ALL_SERVERS}, and rush also by each server's key. Top fifty each.
 */
export interface SiteLeaderboardsBody extends SiteBody {
  readonly boards: Readonly<Record<StandingBoard, Readonly<Record<string, readonly SiteStanding[]>>>>;
}

/** A page of the site. The browse filter and the server chip live in the query string, not here. */
export type PageRoute =
  | { readonly kind: "browse" }
  | { readonly kind: "days" }
  | { readonly kind: "puzzle"; readonly id: number }
  | { readonly kind: "day"; readonly day: number }
  | { readonly kind: "leaderboards" }
  | { readonly kind: "players" }
  | { readonly kind: "player"; readonly key: string };

/** How a page finds what it names. The server builds one from its dataset, the page from its index. */
export interface SiteLookup {
  puzzle(id: number): SitePuzzle | undefined;
  day(day: number): SiteDay | undefined;
  /** A listed player. A hidden one, or a key nobody holds, is undefined alike. */
  player(key: string): SitePlayerEntry | undefined;
}

/** A page's `<title>` and description, as raw text. */
export interface PageText {
  readonly title: string;
  readonly description: string;
}

const BROWSE: PageRoute = Object.freeze({ kind: "browse" });
const DAYS: PageRoute = Object.freeze({ kind: "days" });
const LEADERBOARDS: PageRoute = Object.freeze({ kind: "leaderboards" });
const PLAYERS: PageRoute = Object.freeze({ kind: "players" });

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
 * `PUBLIC_KEY_PATTERN` (`shared/site.ts`) under `/player/`, written out because
 * a RegExp cannot be spliced into another without losing its anchors. The
 * wire test checks every path it takes holds a key that pattern takes.
 */
const PLAYER_PATH = /^\/player\/([2-9a-hjkmnp-z]{10})$/;

/**
 * The page a path names, or null when it names none.
 *
 * Null is a 404 on the server and the missing view on the page, so the two
 * cannot disagree about which links exist.
 */
export function parsePage(pathname: string): PageRoute | null {
  if (pathname === "/") return BROWSE;
  if (pathname === "/days") return DAYS;
  if (pathname === "/leaderboards") return LEADERBOARDS;
  if (pathname === "/players") return PLAYERS;
  const player = PLAYER_PATH.exec(pathname);
  if (player) return Object.freeze({ kind: "player", key: player[1]! });
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
    case "leaderboards":
      return "/leaderboards";
    case "players":
      return "/players";
    case "player":
      return `/player/${route.key}`;
  }
}

/**
 * Where a page's body is, or null for a page the index alone can draw.
 *
 * Always the page's own path under `/data`, with `.json`, so a body can exist
 * only where a page might, and the build keys `Dataset.bodies` by exactly what
 * the page will ask for. Whether that body exists is the build's call, and a
 * miss is the same byte-identical 404 as any other.
 */
export function bodyPathFor(route: PageRoute): string | null {
  switch (route.kind) {
    case "day":
    case "puzzle":
    case "player":
    case "leaderboards":
      return `/data${pathOf(route)}.json`;
    case "browse":
    case "days":
    case "players":
      return null;
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

const LEADERBOARDS_TEXT: PageText = Object.freeze({
  title: `Leaderboards${SUFFIX}`,
  description:
    "Each Discord server's daily and rush boards from the Tetris at UCI daily, " +
    "and the all-time boards, for every finished day.",
});

const PLAYERS_TEXT: PageText = Object.freeze({
  title: `Players${SUFFIX}`,
  description:
    "The players of the Tetris at UCI daily, by the name the game shows, " +
    "each with a page of their finished days.",
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
 * apart. The same holds for today, a future day and a day before history —
 * and for a player who hid, a key nobody holds, and a key from before a hide.
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
    case "leaderboards":
      return LEADERBOARDS_TEXT;
    case "players":
      return PLAYERS_TEXT;
    case "player": {
      const player = lookup.player(route.key);
      return player ? playerText(player) : null;
    }
  }
}

/** `ada`, and `ada's finished days in the Tetris at UCI daily: 41 days solved, best streak 21.` */
function playerText(player: SitePlayerEntry): PageText {
  const name = oneLine(player.name) || "unnamed";
  const days = player.daysSolved === 1 ? "1 day" : `${player.daysSolved} days`;
  return Object.freeze({
    title: `${name}${SUFFIX}`,
    description: clipped(
      `${name}'s finished days in the Tetris at UCI daily: ${days} solved, best streak ${player.bestStreak}.`,
    ),
  });
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
