/**
 * The privacy boundary: the one place that decides what can leave the puzzle database.
 *
 * Everything the site serves is read back out of a SQLite database built here,
 * in memory, from rows handed in — `/puzzles.json`, the `/puzzles.sqlite`
 * download and every page's title and description. So the schema below is the
 * complete list of what can ever be public. It is a list of what goes *in*,
 * not of what to keep out; a list of exclusions goes stale the day somebody
 * adds a column to the game, and nobody notices until it has been served.
 *
 * **It never sees the game's database.** It is handed plain rows, which
 * `dataset.ts` builds from the corrected puzzle list and the finished days, and
 * holds no handle on anything else: nothing here could read a player table if
 * it tried. That is also why this is the one module that calls `serialize()`,
 * and only on its own `:memory:` database. `VACUUM INTO` and copying the game's
 * file were the obvious alternatives, and both publish whatever the file
 * holds, rows still waiting in the write-ahead log included — and a read-only
 * handle does not refuse `VACUUM INTO`. The only safe copy is one that was
 * never a copy.
 *
 * **The schema documents the download.** Every comment sits inside a table's
 * parentheses, because SQLite keeps a `CREATE TABLE`'s text only from `CREATE`
 * to its closing parenthesis and drops a comment above it on the way in. So
 * `.schema` in any `sqlite3` tells a downloader what each column means. The
 * tables are deliberately not `STRICT`, which `sqlite3` builds before 3.37
 * refuse to open at all.
 *
 * **The JSON is read back, not built alongside.** {@link readPublicDatabase}
 * reads the rows out again, and that — not the rows handed in — is what becomes
 * the JSON and the page heads. A field cannot reach the JSON without first
 * being a column here, so the JSON and the download cannot disagree about what
 * is public.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { blueprintLink } from "../../shared/blueprint/viewer";
import { DAILY_TIERS, type DailyTier } from "../../shared/daily";
import type { ClearRequirement, Mino, RowCode, SolutionStep } from "../../shared/puzzle";
import {
  SCHEMA_VERSION,
  type SiteAbout,
  type SiteData,
  type SiteDay,
  type SitePuzzle,
} from "../wire";

/** Every column of every public table, in the order a row lists its values. The allowlist. */
export const PUBLIC_COLUMNS = Object.freeze({
  puzzles: Object.freeze([
    "id",
    "title",
    "author",
    "difficulty",
    "tier",
    "goal",
    "set_name",
    "board",
    "queue",
    "hold",
    "pieces",
    "target_attack",
    "required_clears",
    "solution",
    "source_puzzle",
    "source_solution",
  ] as const),
  day_puzzles: Object.freeze(["day", "date", "tier", "puzzle_id"] as const),
  about: Object.freeze(["key", "value"] as const),
});

type PublicTable = keyof typeof PUBLIC_COLUMNS;

/** The tier names as SQL literals, so the schema's CHECK cannot drift from the game's tiers. */
const TIERS = DAILY_TIERS.map((tier) => `'${tier}'`).join(",");

/** The public database's schema, comments and all; see the module docstring for where they sit. */
export const PUBLIC_SCHEMA = `
CREATE TABLE puzzles (
  -- Every club puzzle the Tetris at UCI daily deals from, as players are dealt it: the club's
  -- puzzle file and the archive's published rows, officers' corrections applied. Built fresh
  -- from an allowlist on every change; never a copy of the game's database.
  id              INTEGER PRIMARY KEY,
  title           TEXT    NOT NULL,
  author          TEXT    NOT NULL,
  difficulty      REAL,              -- the club's rating; NULL when unrated
  tier            TEXT    NOT NULL   -- the daily tier it is dealt in now
                  CHECK (tier IN (${TIERS})),
  goal            TEXT    NOT NULL,
  set_name        TEXT,              -- NULL when in no set
  board           TEXT    NOT NULL,  -- JSON: rows from the floor up, ten characters each:
                                     -- '.' empty, IJLOSTZ a piece, G garbage
  queue           TEXT    NOT NULL,  -- JSON: the pieces, in order
  hold            TEXT,              -- the piece starting in hold, or NULL
  pieces          INTEGER NOT NULL,  -- queue plus hold: what a player places
  target_attack   INTEGER NOT NULL,  -- attack a solve must send
  required_clears TEXT,              -- JSON [{clear,count}]; NULL undecided, '[]' none
  solution        TEXT,              -- JSON [{piece,cells,clear,attack}], the maker's answer;
                                     -- NULL when none is on file
  source_puzzle   TEXT,              -- Blueprint code of the puzzle, when known
  source_solution TEXT               -- Blueprint code of the answer, when known
);
CREATE TABLE day_puzzles (
  -- Which puzzle each finished day dealt, per tier. Never today or a later day. Day 1 is
  -- 2026-01-01 on the club's clock. A club puzzle no longer in the archive keeps its id.
  day       INTEGER NOT NULL,
  date      TEXT    NOT NULL,        -- the club's calendar date, YYYY-MM-DD
  tier      TEXT    NOT NULL CHECK (tier IN (${TIERS})),
  puzzle_id INTEGER,                 -- a puzzles.id; NULL when the day dealt a puzzle a player
                                     -- wrote, which this file leaves out
  PRIMARY KEY (day, tier)
);
CREATE TABLE about (
  -- schema, built_at (ISO time of this build), first_day (where history starts),
  -- through_day (newest finished day, or NULL)
  key   TEXT PRIMARY KEY,
  value TEXT
);
PRAGMA user_version = ${SCHEMA_VERSION};
`;

/** One `puzzles` row, value for value in {@link PUBLIC_COLUMNS} order, its JSON as text. */
export type PuzzleRow = readonly [
  id: number,
  title: string,
  author: string,
  difficulty: number | null,
  tier: DailyTier,
  goal: string,
  setName: string | null,
  board: string,
  queue: string,
  hold: string | null,
  pieces: number,
  targetAttack: number,
  requiredClears: string | null,
  solution: string | null,
  sourcePuzzle: string | null,
  sourceSolution: string | null,
];
export type DayRow = readonly [day: number, date: string, tier: DailyTier, puzzleId: number | null];
export type AboutKey = "schema" | "built_at" | "first_day" | "through_day";
export type AboutRow = readonly [key: AboutKey, value: string | null];

/** Everything a public database is built from: plain values, nothing that can reach the game. */
export interface PublicRows {
  readonly puzzles: readonly PuzzleRow[];
  readonly days: readonly DayRow[];
  readonly about: readonly AboutRow[];
}

export interface PublicDatabase {
  /** The download, byte for byte. */
  readonly sqlite: Uint8Array;
  /** The same rows read back out: the JSON, and everything a page head says. */
  readonly data: SiteData;
}

/**
 * Builds the public database from `rows` and reads it straight back.
 *
 * Opened `strict`, so a row one value short is an error rather than a NULL
 * quietly written into its last column: a row and the schema disagreeing about
 * the columns is a bug, and this is where it should be loud.
 */
export function writePublicDatabase(rows: PublicRows): PublicDatabase {
  const db = new Database(":memory:", { strict: true });
  try {
    db.exec(PUBLIC_SCHEMA);
    insertRows(db, rows);
    const data = readPublicDatabase(db);
    return Object.freeze({ sqlite: db.serialize(), data });
  } finally {
    db.close();
  }
}

function insertRows(db: Database, rows: PublicRows): void {
  const puzzles = insertInto(db, "puzzles");
  const days = insertInto(db, "day_puzzles");
  const about = insertInto(db, "about");
  db.transaction(() => {
    for (const row of rows.puzzles) puzzles.run(...row);
    for (const row of rows.days) days.run(...row);
    for (const row of rows.about) about.run(...row);
  })();
}

/** An INSERT naming every allowlisted column, so a column the schema lacks fails to prepare. */
function insertInto(db: Database, table: PublicTable) {
  const slots = PUBLIC_COLUMNS[table].map((_, index) => `?${index + 1}`).join(", ");
  return db.query<unknown, SQLQueryBindings[]>(
    `INSERT INTO "${table}" (${columnList(table)}) VALUES (${slots})`,
  );
}

function columnList(table: PublicTable): string {
  return PUBLIC_COLUMNS[table].map((column) => `"${column}"`).join(", ");
}

/**
 * A public database, read as the site serves it.
 *
 * Puzzles in id order with their JSON columns parsed; days ascending, each
 * with its deals in `DAILY_TIERS` order whatever order the rows went in; the
 * `about` rows typed. Frozen all the way down, because one built value is
 * shared by every request until the next build replaces it.
 */
export function readPublicDatabase(db: Database): SiteData {
  return deepFrozen({ about: readAbout(db), puzzles: readPuzzles(db), days: readDays(db) });
}

interface PuzzleCells {
  id: number;
  title: string;
  author: string;
  difficulty: number | null;
  tier: DailyTier;
  goal: string;
  set_name: string | null;
  board: string;
  queue: string;
  hold: Mino | null;
  pieces: number;
  target_attack: number;
  required_clears: string | null;
  solution: string | null;
  source_puzzle: string | null;
  source_solution: string | null;
}

function readPuzzles(db: Database): SitePuzzle[] {
  return db
    .query<PuzzleCells, []>(`SELECT ${columnList("puzzles")} FROM puzzles ORDER BY id`)
    .all()
    .map(toSitePuzzle);
}

/**
 * One row as the page reads it. The links are built here, from the codes, so
 * the download and the JSON agree on them and no host ever arrives in data.
 * `source` needs both codes; a lone code is still worth its link.
 */
function toSitePuzzle(row: PuzzleCells): SitePuzzle {
  const { source_puzzle: puzzleCode, source_solution: answerCode } = row;
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    difficulty: row.difficulty,
    tier: row.tier,
    goal: row.goal,
    set: row.set_name,
    board: JSON.parse(row.board) as RowCode[],
    queue: JSON.parse(row.queue) as Mino[],
    hold: row.hold,
    pieces: row.pieces,
    targetAttack: row.target_attack,
    requiredClears: parsed<ClearRequirement[]>(row.required_clears),
    solution: parsed<SolutionStep[]>(row.solution),
    source: puzzleCode && answerCode ? { puzzle: puzzleCode, solution: answerCode } : null,
    puzzleUrl: blueprintLink(puzzleCode),
    solutionUrl: blueprintLink(answerCode),
  };
}

/** A nullable JSON column: NULL stays null, and `'[]'` stays an empty list. */
function parsed<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

interface DayCells {
  day: number;
  date: string;
  tier: DailyTier;
  puzzle_id: number | null;
}

function readDays(db: Database): SiteDay[] {
  const cells = db
    .query<DayCells, []>(`SELECT ${columnList("day_puzzles")} FROM day_puzzles ORDER BY day`)
    .all();
  return [...Map.groupBy(cells, (cell) => cell.day)].map(([day, rows]) => ({
    day,
    // Every row of a day carries its date, and a group holds at least the row that made it.
    date: rows[0]!.date,
    deals: DAILY_TIERS.flatMap((tier) => {
      const dealt = rows.find((row) => row.tier === tier);
      return dealt ? [{ tier, puzzleId: dealt.puzzle_id }] : [];
    }),
  }));
}

function readAbout(db: Database): SiteAbout {
  const rows = db
    .query<{ key: string; value: string | null }, []>(`SELECT ${columnList("about")} FROM about`)
    .all();
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const valueOf = (key: AboutKey): string | null => {
    if (!values.has(key)) throw new Error(`The public database has no about row for ${key}`);
    return values.get(key) ?? null;
  };
  const textOf = (key: AboutKey): string => {
    const value = valueOf(key);
    if (value === null) throw new Error(`The public database's about.${key} is NULL`);
    return value;
  };
  const throughDay = valueOf("through_day");
  return {
    schema: Number(textOf("schema")),
    builtAt: textOf("built_at"),
    firstDay: Number(textOf("first_day")),
    throughDay: throughDay === null ? null : Number(throughDay),
  };
}

/** Freezes a freshly read value and everything inside it. */
function deepFrozen<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFrozen(inner);
  }
  return value;
}
