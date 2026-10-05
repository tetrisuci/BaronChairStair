/**
 * The public tables that say how finished days went: the second half of the
 * allowlist `public-db.ts` builds.
 *
 * Split out of `public-db.ts` for length, not for a different rule. These
 * tables are created in the same `:memory:` database, from the same kind of
 * plain rows, by the same inserts naming every column, and read back the same
 * way: what a page body or the download says about a player was first a cell
 * here. `public-db.ts` merges {@link PLAYER_SCHEMA} and {@link PLAYER_COLUMNS}
 * into its own, so there is still exactly one list of what can be public.
 *
 * **Who a row belongs to is a key or NULL.** A shown player is `players.key`,
 * the site's own random name for them; every row of a player who hid has
 * `player_key` NULL, and they are not in `players`. No table has a column a
 * Discord id, a guild id or an avatar could go in. Servers are `servers.key`,
 * likewise random, with the name Discord gave them or NULL.
 *
 * **Comments inside the parentheses**, for the reason `public-db.ts` gives:
 * SQLite keeps a `CREATE TABLE`'s text from `CREATE` to its closing
 * parenthesis, and `.schema` is how a downloader learns what a column means.
 *
 * **Read back into the wire's shapes**, with each `player_key` resolved to the
 * `{ key, name }` the page prints through `players` — and a key that resolves
 * to nobody is an error rather than a nameless row, because it would mean a
 * board names a player the index does not list.
 */

import type { Database } from "bun:sqlite";
import { DAILY_TIERS, type DailyTier } from "../../shared/daily";
import type { ClearName, SolutionStep } from "../../shared/puzzle";
import {
  type DayMarks,
  type PlayerRef,
  type SiteDayBoardRow,
  type SiteLine,
  type SitePlayerEntry,
  type SitePlayerTotals,
  type SitePuzzleStats,
  type SiteRushRow,
  type SiteServer,
  type SiteStanding,
  type SiteTierRow,
  STANDING_BOARDS,
  type StandingBoard,
  type TierMark,
} from "../wire";
import { byText, textOrder, then } from "./rank";

/** Every column of every table here, in the order a row lists its values. */
export const PLAYER_COLUMNS = Object.freeze({
  servers: Object.freeze(["key", "name"] as const),
  players: Object.freeze([
    "key",
    "name",
    "days_solved",
    "dailies",
    "current_streak",
    "best_streak",
    "puzzles_cleared",
    "lines_found",
    "rush_runs",
    "rush_best",
    "rush_best_ms",
    "rush_best_day",
  ] as const),
  tier_boards: Object.freeze([
    "day",
    "tier",
    "rank",
    "server_key",
    "player_key",
    "puzzle_id",
    "solved",
    "time_ms",
    "attack",
    "target_attack",
  ] as const),
  day_boards: Object.freeze([
    "day",
    "scope",
    "rank",
    "player_key",
    "solved",
    "time_ms",
    "easy",
    "medium",
    "hard",
    "extreme",
  ] as const),
  rush_boards: Object.freeze(["day", "rank", "server_key", "player_key", "solved", "time_ms"] as const),
  standings: Object.freeze(["board", "scope", "rank", "player_key", "value", "detail", "time_ms", "day"] as const),
  puzzle_stats: Object.freeze([
    "puzzle_id",
    "hand_ins",
    "solves",
    "fastest_ms",
    "median_ms",
    "fastest_player_key",
  ] as const),
  lines: Object.freeze(["puzzle_id", "position", "attack", "clears", "steps"] as const),
});

export type PlayerTable = keyof typeof PLAYER_COLUMNS;

const TIERS = DAILY_TIERS.map((tier) => `'${tier}'`).join(",");
const BOARDS = STANDING_BOARDS.map((board) => `'${board}'`).join(",");

/** The tables, comments and all. `public-db.ts` runs this after its own and before `user_version`. */
export const PLAYER_SCHEMA = `
CREATE TABLE servers (
  -- Discord servers with a board here. key is this site's own random name for a server, never
  -- Discord's id. name is what Discord called it at a player's last sign-in from it; NULL when
  -- nobody has signed in from it since names were first kept, when it holds a long number, or
  -- when the site's owner has chosen not to show it.
  key  TEXT PRIMARY KEY,
  name TEXT
);
CREATE TABLE players (
  -- Players who have not chosen "Hide me on db.tetrisatuci.org" and have something on a
  -- finished day, by the name the game shows. key is this site's own random name, never a
  -- Discord id. A hidden player is not in this table; everywhere else their rows have
  -- player_key NULL. Totals cover finished days only.
  key             TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL,
  days_solved     INTEGER NOT NULL, -- days with at least one daily solved
  dailies         INTEGER NOT NULL, -- daily puzzles solved, one per tier per day
  current_streak  INTEGER NOT NULL, -- consecutive solved days ending with the newest finished day
  best_streak     INTEGER NOT NULL,
  puzzles_cleared INTEGER NOT NULL, -- distinct puzzles ever solved, any mode
  lines_found     INTEGER NOT NULL, -- alternate lines credited to them, as the game counts them
  rush_runs       INTEGER NOT NULL,
  rush_best       INTEGER,          -- most puzzles solved in one rush; NULL with no rush
  rush_best_ms    INTEGER,          -- that rush's time to its last solve
  rush_best_day   INTEGER           -- and its day
);
CREATE TABLE tier_boards (
  -- Every hand-in of a finished day's daily, one row per player per tier, ranked across every
  -- server: solved first, then fastest, then the unsolved by attack. A server's own board is
  -- these rows filtered by server_key, in the same order. Rows a board cannot tell apart are
  -- ordered by name, then by their other columns: never by anything not printed here.
  day           INTEGER NOT NULL,
  tier          TEXT    NOT NULL CHECK (tier IN (${TIERS})),
  rank          INTEGER NOT NULL,
  server_key    TEXT,              -- servers.key; NULL when played outside any known server
  player_key    TEXT,              -- players.key; NULL for a player who hid ("a player")
  puzzle_id     INTEGER,           -- NULL when the day dealt a puzzle a player wrote
  solved        INTEGER NOT NULL,
  time_ms       INTEGER,           -- opening the puzzle to solving it; NULL when unsolved
  attack        INTEGER NOT NULL,  -- what the hand-in sent
  target_attack INTEGER NOT NULL,  -- what the puzzle asked for
  PRIMARY KEY (day, tier, rank)
);
CREATE TABLE day_boards (
  -- A finished day's daily board, per player across tiers. scope 'all' is every server; a
  -- servers.key is that server's board, counting only tiers handed in there.
  day        INTEGER NOT NULL,
  scope      TEXT    NOT NULL,
  rank       INTEGER NOT NULL,
  player_key TEXT,                 -- NULL for a player who hid
  solved     INTEGER NOT NULL,     -- tiers solved
  time_ms    INTEGER NOT NULL,     -- summed over solved tiers
  easy       INTEGER,              -- each tier: 0 not played, 1 handed in, 2 solved;
  medium     INTEGER,              -- NULL when the day did not deal that tier
  hard       INTEGER,
  extreme    INTEGER,
  PRIMARY KEY (day, scope, rank)
);
CREATE TABLE rush_boards (
  -- The first ranked rush each player ran on a finished day, most solved first, then soonest.
  -- Never today's.
  day        INTEGER NOT NULL,
  rank       INTEGER NOT NULL,
  server_key TEXT,
  player_key TEXT,
  solved     INTEGER NOT NULL,
  time_ms    INTEGER NOT NULL,     -- to the last solve
  PRIMARY KEY (day, rank)
);
CREATE TABLE standings (
  -- All-time boards over finished days, top 50 each. value: rush puzzles solved | dailies solved |
  -- current streak | best streak | puzzles cleared | lines found. detail (a shown player only;
  -- NULL for "a player"): dailies -> days solved; streak -> best streak. time_ms and day: rush
  -- only. scope is 'all' except rush, which also has one board per servers.key.
  board      TEXT    NOT NULL CHECK (board IN (${BOARDS})),
  scope      TEXT    NOT NULL,
  rank       INTEGER NOT NULL,
  player_key TEXT,
  value      INTEGER NOT NULL,
  detail     INTEGER,
  time_ms    INTEGER,
  day        INTEGER,
  PRIMARY KEY (board, scope, rank)
);
CREATE TABLE puzzle_stats (
  -- How a puzzle went on the finished days it was dealt: daily hand-ins only.
  puzzle_id          INTEGER PRIMARY KEY,
  hand_ins           INTEGER NOT NULL,
  solves             INTEGER NOT NULL,
  fastest_ms         INTEGER,      -- NULL with no solve
  median_ms          INTEGER,      -- of the solves; NULL with none
  fastest_player_key TEXT          -- NULL with no solve, or a player who hid
);
CREATE TABLE lines (
  -- Players' own ways through a puzzle besides the maker's: lines that solved it or sent more
  -- than it asked, found on a finished day. Never who found a line, or when.
  puzzle_id INTEGER NOT NULL,
  position  INTEGER NOT NULL,      -- 1 is the earliest day's first
  attack    INTEGER NOT NULL,
  clears    TEXT    NOT NULL,      -- JSON: the named clears it made
  steps     TEXT    NOT NULL,      -- JSON [{piece,cells,clear,attack}]
  PRIMARY KEY (puzzle_id, position)
);
`;

type Key = string | null;

export type ServerRow = readonly [key: string, name: string | null];
export type PlayerRow = readonly [
  key: string,
  name: string,
  daysSolved: number,
  dailies: number,
  currentStreak: number,
  bestStreak: number,
  puzzlesCleared: number,
  linesFound: number,
  rushRuns: number,
  rushBest: number | null,
  rushBestMs: number | null,
  rushBestDay: number | null,
];
export type TierBoardRow = readonly [
  day: number,
  tier: DailyTier,
  rank: number,
  serverKey: Key,
  playerKey: Key,
  puzzleId: number | null,
  solved: 0 | 1,
  timeMs: number | null,
  attack: number,
  targetAttack: number,
];
export type DayBoardRow = readonly [
  day: number,
  scope: string,
  rank: number,
  playerKey: Key,
  solved: number,
  timeMs: number,
  easy: TierMark | null,
  medium: TierMark | null,
  hard: TierMark | null,
  extreme: TierMark | null,
];
export type RushBoardRow = readonly [day: number, rank: number, serverKey: Key, playerKey: Key, solved: number, timeMs: number];
export type StandingRow = readonly [
  board: StandingBoard,
  scope: string,
  rank: number,
  playerKey: Key,
  value: number,
  detail: number | null,
  timeMs: number | null,
  day: number | null,
];
export type PuzzleStatsRow = readonly [
  puzzleId: number,
  handIns: number,
  solves: number,
  fastestMs: number | null,
  medianMs: number | null,
  fastestPlayerKey: Key,
];
export type LineRow = readonly [puzzleId: number, position: number, attack: number, clears: string, steps: string];

/** Every row of every table here, in each table's own order. */
export interface PlayerRows {
  readonly servers: readonly ServerRow[];
  readonly players: readonly PlayerRow[];
  readonly tierBoards: readonly TierBoardRow[];
  readonly dayBoards: readonly DayBoardRow[];
  readonly rushBoards: readonly RushBoardRow[];
  readonly standings: readonly StandingRow[];
  readonly puzzleStats: readonly PuzzleStatsRow[];
  readonly lines: readonly LineRow[];
}

/** The tables of a build with no player data: a v1-shaped build, and what tests of the puzzles hand in. */
export const NO_PLAYER_ROWS: PlayerRows = Object.freeze({
  servers: [],
  players: [],
  tierBoards: [],
  dayBoards: [],
  rushBoards: [],
  standings: [],
  puzzleStats: [],
  lines: [],
});

/** Which field of {@link PlayerRows} fills which table, in insert order. */
export const PLAYER_TABLE_ROWS: readonly (readonly [PlayerTable, keyof PlayerRows])[] = Object.freeze([
  ["servers", "servers"],
  ["players", "players"],
  ["tier_boards", "tierBoards"],
  ["day_boards", "dayBoards"],
  ["rush_boards", "rushBoards"],
  ["standings", "standings"],
  ["puzzle_stats", "puzzleStats"],
  ["lines", "lines"],
]);

/** The tables read back, in the wire's shapes, each list in its table's published order. */
export interface PlayerData {
  /** Sorted by name as a reader sees it. */
  readonly players: readonly SitePlayerEntry[];
  readonly totals: ReadonlyMap<string, SitePlayerTotals>;
  /** Sorted by name, the unnamed last. */
  readonly servers: readonly SiteServer[];
  /** By day, then `DAILY_TIERS` order, then rank. */
  readonly tierRows: readonly (SiteTierRow & { readonly day: number })[];
  readonly dayBoardRows: readonly (SiteDayBoardRow & { readonly day: number; readonly scope: string })[];
  readonly rushRows: readonly (SiteRushRow & { readonly day: number })[];
  /** By `STANDING_BOARDS` order, then scope, then rank. */
  readonly standings: readonly (SiteStanding & { readonly board: StandingBoard; readonly scope: string })[];
  readonly stats: ReadonlyMap<number, SitePuzzleStats>;
  /** By puzzle, then position. */
  readonly lines: readonly (SiteLine & { readonly puzzleId: number })[];
}

function columnList(table: PlayerTable): string {
  return PLAYER_COLUMNS[table].map((column) => `"${column}"`).join(", ");
}

/** `ORDER BY` position of a tier or a board, so the read comes back in the wire's order. */
function orderOf(column: string, names: readonly string[]): string {
  return `CASE ${column} ${names.map((name, at) => `WHEN '${name}' THEN ${at}`).join(" ")} END`;
}

/** Reads every table here back out, resolving each player key to the name the page prints. */
export function readPlayerData(db: Database): PlayerData {
  const { players, totals } = readPlayers(db);
  const refOf = playerRefs(players);
  return {
    players,
    totals,
    servers: readServers(db),
    tierRows: readTierRows(db, refOf),
    dayBoardRows: readDayBoardRows(db, refOf),
    rushRows: readRushRows(db, refOf),
    standings: readStandings(db, refOf),
    stats: readStats(db, refOf),
    lines: readLines(db),
  };
}

type PlayerCells = { [K in (typeof PLAYER_COLUMNS.players)[number]]: K extends "key" | "name" ? string : number | null };

/** Case-folded, then exact, then by key: how a reader would look a name up. */
const byName = then<{ name: string; key: string }>(
  byText((row) => row.name.toLowerCase()),
  byText((row) => row.name),
  byText((row) => row.key),
);

function readPlayers(db: Database): { players: SitePlayerEntry[]; totals: Map<string, SitePlayerTotals> } {
  const cells = db.query<PlayerCells, []>(`SELECT ${columnList("players")} FROM players`).all();
  const players = cells
    .map((row) => ({ key: row.key, name: row.name, daysSolved: row.days_solved!, bestStreak: row.best_streak! }))
    .toSorted(byName);
  const totals = new Map(
    cells.map((row): [string, SitePlayerTotals] => [
      row.key,
      {
        daysSolved: row.days_solved!,
        dailies: row.dailies!,
        currentStreak: row.current_streak!,
        bestStreak: row.best_streak!,
        puzzlesCleared: row.puzzles_cleared!,
        linesFound: row.lines_found!,
        rushRuns: row.rush_runs!,
        rushBest: row.rush_best,
        rushBestMs: row.rush_best_ms,
        rushBestDay: row.rush_best_day,
      },
    ]),
  );
  return { players, totals };
}

/** Resolves a stored key: null is "a player"; a key `players` does not hold is a broken build. */
function playerRefs(players: readonly SitePlayerEntry[]): (key: string | null) => PlayerRef {
  const byKey = new Map(players.map((player) => [player.key, { key: player.key, name: player.name }]));
  return (key) => {
    if (key === null) return null;
    const found = byKey.get(key);
    if (!found) throw new Error("A public board names a player key the players table does not hold");
    return found;
  };
}

function readServers(db: Database): SiteServer[] {
  return db
    .query<SiteServer, []>(`SELECT ${columnList("servers")} FROM servers`)
    .all()
    .toSorted(
      then<SiteServer>(
        byText((row) => row.name?.toLowerCase() ?? null),
        byText((row) => row.name),
        (a, b) => textOrder(a.key, b.key),
      ),
    );
}

interface TierCells {
  day: number;
  tier: DailyTier;
  rank: number;
  server_key: Key;
  player_key: Key;
  puzzle_id: number | null;
  solved: number;
  time_ms: number | null;
  attack: number;
  target_attack: number;
}

function readTierRows(db: Database, refOf: (key: Key) => PlayerRef): PlayerData["tierRows"] {
  return db
    .query<TierCells, []>(
      `SELECT ${columnList("tier_boards")} FROM tier_boards ORDER BY day, ${orderOf("tier", DAILY_TIERS)}, rank`,
    )
    .all()
    .map((row) => ({
      day: row.day,
      tier: row.tier,
      rank: row.rank,
      serverKey: row.server_key,
      player: refOf(row.player_key),
      puzzleId: row.puzzle_id,
      solved: row.solved === 1,
      timeMs: row.time_ms,
      attack: row.attack,
      targetAttack: row.target_attack,
    }));
}

type DayBoardCells = { day: number; scope: string; rank: number; player_key: Key; solved: number; time_ms: number } & Record<
  DailyTier,
  TierMark | null
>;

function readDayBoardRows(db: Database, refOf: (key: Key) => PlayerRef): PlayerData["dayBoardRows"] {
  return db
    .query<DayBoardCells, []>(`SELECT ${columnList("day_boards")} FROM day_boards ORDER BY day, scope, rank`)
    .all()
    .map((row) => ({
      day: row.day,
      scope: row.scope,
      rank: row.rank,
      player: refOf(row.player_key),
      solved: row.solved,
      timeMs: row.time_ms,
      marks: Object.fromEntries(DAILY_TIERS.map((tier) => [tier, row[tier]])) as unknown as DayMarks,
    }));
}

interface RushCells {
  day: number;
  rank: number;
  server_key: Key;
  player_key: Key;
  solved: number;
  time_ms: number;
}

function readRushRows(db: Database, refOf: (key: Key) => PlayerRef): PlayerData["rushRows"] {
  return db
    .query<RushCells, []>(`SELECT ${columnList("rush_boards")} FROM rush_boards ORDER BY day, rank`)
    .all()
    .map((row) => ({
      day: row.day,
      rank: row.rank,
      serverKey: row.server_key,
      player: refOf(row.player_key),
      solved: row.solved,
      timeMs: row.time_ms,
    }));
}

interface StandingCells {
  board: StandingBoard;
  scope: string;
  rank: number;
  player_key: Key;
  value: number;
  detail: number | null;
  time_ms: number | null;
  day: number | null;
}

function readStandings(db: Database, refOf: (key: Key) => PlayerRef): PlayerData["standings"] {
  return db
    .query<StandingCells, []>(
      `SELECT ${columnList("standings")} FROM standings ORDER BY ${orderOf("board", STANDING_BOARDS)}, scope, rank`,
    )
    .all()
    .map((row) => ({
      board: row.board,
      scope: row.scope,
      rank: row.rank,
      player: refOf(row.player_key),
      value: row.value,
      detail: row.detail,
      timeMs: row.time_ms,
      day: row.day,
    }));
}

interface StatsCells {
  puzzle_id: number;
  hand_ins: number;
  solves: number;
  fastest_ms: number | null;
  median_ms: number | null;
  fastest_player_key: Key;
}

function readStats(db: Database, refOf: (key: Key) => PlayerRef): Map<number, SitePuzzleStats> {
  const rows = db.query<StatsCells, []>(`SELECT ${columnList("puzzle_stats")} FROM puzzle_stats ORDER BY puzzle_id`).all();
  return new Map(
    rows.map((row): [number, SitePuzzleStats] => [
      row.puzzle_id,
      {
        handIns: row.hand_ins,
        solves: row.solves,
        fastestMs: row.fastest_ms,
        medianMs: row.median_ms,
        fastest: refOf(row.fastest_player_key),
      },
    ]),
  );
}

interface LineCells {
  puzzle_id: number;
  position: number;
  attack: number;
  clears: string;
  steps: string;
}

function readLines(db: Database): PlayerData["lines"] {
  return db
    .query<LineCells, []>(`SELECT ${columnList("lines")} FROM lines ORDER BY puzzle_id, position`)
    .all()
    .map((row) => ({
      puzzleId: row.puzzle_id,
      position: row.position,
      attack: row.attack,
      clears: JSON.parse(row.clears) as ClearName[],
      steps: JSON.parse(row.steps) as SolutionStep[],
    }));
}
