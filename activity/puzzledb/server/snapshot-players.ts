/**
 * The only SQL the puzzle database runs against the game's player tables.
 *
 * Until schema 2 the site never named a player table at all, and a test proved
 * it by dropping every one of them from a copy. That rule could not survive the
 * owner's request — leaderboards, players' pages and alternate lines are rows
 * in exactly those tables — so it is replaced by a narrower one that a test can
 * hold just as firmly: **an explicit list of columns**, and every one of them
 * named here. `tests/puzzledb-snapshot.test.ts` strips each column it does not
 * list from a copy and builds anyway. A future read of `avatar_url` or
 * `preferences` fails there, before it could reach anything public.
 *
 * **Who a row belongs to is decided in SQL, and only there.** Every read
 * selects a player through {@link WHO}: their public key and name when they
 * are shown, and NULL for both otherwise. "Otherwise" is a player who chose to
 * hide, the guest, a player an older build inserted without a key, and a name
 * holding a run of seventeen digits, which is what a Discord id looks like.
 * `players.id` is used to join and to group, never selected; `found_by` and
 * `found_at` likewise. So no id, and no hidden player's name or key, is ever a
 * JS value for a leak to start from — every per-player number a hidden player
 * contributes is aggregated before it leaves SQLite, and arrives unlabelled.
 *
 * **Nothing from today, or later.** Every read is cut at {@link PlayerSnapshot.cut},
 * the first day not shown, which is the same `min(site's today, newest pinned
 * day)` the finished days are cut at, for the reason `FINISHED_DAYS_SQL` gives.
 * Two of the columns cut are milliseconds with no day beside them — when a line
 * was filed, when a puzzle was first cleared — and those are cut at the
 * midnight that starts the cut *in the game's zone*, which the game writes into
 * `site_facts` at every boot. The site's own zone setting may differ from the
 * game's, and a midnight taken in the wrong zone could publish an hour of
 * today. The game-zone midnight alone is enough: the cut is never past the
 * game's own today, so its midnight can only hold data back.
 *
 * **Parameters, never literals.** Every value a fragment needs — the guest's
 * id, the digit pattern, the bounds — is bound by name. The fragments are
 * written once, so the rule for who is shown cannot be spelled two ways in two
 * reads.
 *
 * It runs inside `readSnapshot`'s deferred transaction, so it sees the same
 * moment of the database as the puzzles and days it is published beside.
 */

import type { Database } from "bun:sqlite";
import { CREDITED, LIVE } from "../../server/discovery-sql";
import { DAILY_TIERS, type DailyTier, dayStarts, startOfDay } from "../../shared/daily";
import { CLEAR_NAMES } from "../../shared/goal";
import type { ClearName, Mino, SolutionStep } from "../../shared/puzzle";
import { GUEST_ID } from "../../shared/site";
import { ALL_SERVERS, type TierMark } from "../wire";
import type {
  PlayerSnapshot,
  SnapshotClear,
  SnapshotCount,
  SnapshotDailyDays,
  SnapshotDayBoardRow,
  SnapshotLine,
  SnapshotRushRecord,
  SnapshotRushRun,
  SnapshotServer,
  SnapshotTierRun,
} from "./types";

/**
 * A GLOB matching any text that holds seventeen ASCII digits in a row.
 *
 * Seventeen is the shortest a Discord snowflake has been, and GLOB rather than
 * a regular expression because SQLite has GLOB built in and no REGEXP. Bound
 * as a parameter, so the pattern is one string the tests can read.
 */
export const DIGITS17 = `*${"[0-9]".repeat(17)}*`;

/**
 * Whether the player aliased `p` may be named: not hidden by choice, not the
 * guest, keyed by the game, and not carrying a Discord-shaped number in their
 * name. NULL `site_hidden` counts as shown, because the owner chose opt-out.
 */
const SHOWN =
  "(COALESCE(p.site_hidden, 0) = 0 AND p.id <> $guest AND p.public_key IS NOT NULL " +
  "AND p.username NOT GLOB $digits17)";

/** A row's owner, both columns NULL unless {@link SHOWN}. */
const WHO =
  `CASE WHEN ${SHOWN} THEN p.public_key END AS playerKey, ` +
  `CASE WHEN ${SHOWN} THEN p.username END AS name`;

/** A server's name, or NULL when it holds a Discord-shaped number. */
const GUILD_NAME = "CASE WHEN g.name GLOB $digits17 THEN NULL ELSE g.name END";

/**
 * The game's day a line aliased `s` was filed on: the last day whose start in
 * the game's zone is at or before `found_at`.
 *
 * `$starts` is a JSON list of every day's start from `$lo` on, so the zone
 * stays in JS — SQLite has none — while the rows it orders stay in SQL. A line
 * filed before `$lo` gets `$lo - 1`, still before every published day.
 */
export const LINE_DAY =
  "((SELECT COALESCE(MAX(j.key), -1) FROM json_each($starts) j WHERE j.value <= s.found_at) + $lo)";

/** The four tiers as SQL literals: a legacy run, from a day of one puzzle, is no tier's. */
const TIERS = DAILY_TIERS.map((tier) => `'${tier}'`).join(", ");

/** One mark column of a day board: 0 not played, 1 handed in, 2 solved. */
const markOf = (tier: DailyTier) => `MAX(CASE WHEN r.slot = '${tier}' THEN r.solved + 1 ELSE 0 END) AS ${tier}`;

const MARKS = DAILY_TIERS.map(markOf).join(", ");

/**
 * What every read is bound with. Named, so each statement takes the ones it
 * uses. A type rather than an interface, because bun:sqlite's bindings want an
 * index signature, which only a type alias picks up from its fields.
 */
type Bounds = {
  readonly $guest: string;
  readonly $digits17: string;
  readonly $all: string;
  readonly $lo: number;
  readonly $cut: number;
  readonly $cutStart: number;
  readonly $starts: string;
};

/**
 * Everything one rebuild reads about players, as one moment of the database.
 *
 * Throws SQLite's own "no such table" or "no such column" when the game has
 * not yet run this code's migration, which the refresher already explains as
 * "deploy the game first" while the last good dataset keeps serving.
 */
export function readPlayers(db: Database, clockToday: number, firstTieredDay: number): PlayerSnapshot {
  const timeZone = gameTimeZone(db);
  const cut = cutOf(db, clockToday);
  const bounds: Bounds = {
    $guest: GUEST_ID,
    $digits17: DIGITS17,
    $all: ALL_SERVERS,
    $lo: firstTieredDay,
    $cut: cut,
    $cutStart: startOfDay(cut, { timeZone }),
    $starts: JSON.stringify(dayStarts(firstTieredDay, cut, { timeZone })),
  };
  return deepFrozen({
    cut,
    tierRuns: tierRuns(db, bounds),
    dayBoards: dayBoards(db, bounds),
    rushRuns: rushRuns(db, bounds),
    rushRecords: rushRecords(db, bounds),
    dailyDays: dailyDays(db, bounds),
    cleared: counted(db, bounds, CLEARED_SQL),
    clearedPuzzles: clearedPuzzles(db, bounds),
    discoveries: counted(db, bounds, DISCOVERIES_SQL),
    lines: lines(db, bounds),
    servers: servers(db, bounds),
  });
}

/**
 * The zone whose midnight starts the game's day, as the game last booted with.
 *
 * A table with no row is a game that migrated and then never booted on this
 * code — which cannot happen through the game's own start, so the message says
 * what would fix it rather than guessing at a zone.
 */
function gameTimeZone(db: Database): string {
  const row = db
    .query<{ value: string }, []>("SELECT value FROM site_facts WHERE name = 'time_zone'")
    .get();
  if (!row) throw new Error("the game has not recorded its time zone; start the game on this code first");
  return row.value;
}

/** `FINISHED_DAYS_SQL`'s upper bound: the earlier of the clock and the newest pin, 0 when none. */
function cutOf(db: Database, clockToday: number): number {
  const row = db
    .query<{ cut: number }, [number]>("SELECT MIN(?1, COALESCE(MAX(day), 0)) AS cut FROM day_puzzles")
    .get(clockToday);
  return row?.cut ?? 0;
}

type Cells<T> = { -readonly [K in keyof T]: T[K] };

function tierRuns(db: Database, bounds: Bounds): SnapshotTierRun[] {
  return db
    .query<Cells<Omit<SnapshotTierRun, "solved">> & { solved: number }, Bounds>(
      `SELECT r.day AS day, r.slot AS tier, r.puzzle_id AS puzzleId, r.solved AS solved,
              CASE WHEN r.solved = 1 THEN r.total_ms END AS timeMs,
              r.attack AS attack, r.target_attack AS targetAttack,
              g.public_key AS serverKey, ${WHO}
         FROM runs r
         JOIN players p ON p.id = r.player_id
         LEFT JOIN guilds g ON g.guild_id = r.guild_id
        WHERE r.day >= $lo AND r.day < $cut AND r.slot IN (${TIERS})
        ORDER BY day, tier, solved DESC, timeMs, attack DESC, name, playerKey, serverKey,
                 puzzleId, targetAttack`,
    )
    .all(bounds)
    .map((row) => ({ ...row, solved: row.solved === 1 }));
}

/**
 * `Store.dayBoard`'s grouping, for every finished day at once: once across
 * every server, and once per server key, where only the hand-ins made in that
 * server count. A hand-in outside any server is on the first board only, as
 * in the game.
 */
function dayBoardSelect(perServer: boolean): string {
  return `
    SELECT ${perServer ? "g.public_key" : "$all"} AS scope, r.day AS day,
           SUM(r.solved) AS solved,
           SUM(CASE WHEN r.solved = 1 THEN r.total_ms ELSE 0 END) AS timeMs,
           ${MARKS}, ${WHO}
      FROM runs r
      JOIN players p ON p.id = r.player_id
      ${perServer ? "JOIN guilds g ON g.guild_id = r.guild_id" : ""}
     WHERE r.day >= $lo AND r.day < $cut AND r.slot IN (${TIERS})
     GROUP BY r.day, ${perServer ? "g.public_key, " : ""}r.player_id`;
}

type DayBoardCells = Omit<SnapshotDayBoardRow, "marks"> & Record<DailyTier, TierMark>;

function dayBoards(db: Database, bounds: Bounds): SnapshotDayBoardRow[] {
  return db
    .query<DayBoardCells, Bounds>(
      `${dayBoardSelect(false)} UNION ALL ${dayBoardSelect(true)}
        ORDER BY scope, day, solved DESC, timeMs, name, playerKey, easy, medium, hard, extreme`,
    )
    .all(bounds)
    .map(({ easy, medium, hard, extreme, ...row }) => ({ ...row, marks: { easy, medium, hard, extreme } }));
}

function rushRuns(db: Database, bounds: Bounds): SnapshotRushRun[] {
  return db
    .query<SnapshotRushRun, Bounds>(
      `SELECT x.day AS day, x.solved AS solved, x.time_to_last_ms AS timeMs,
              g.public_key AS serverKey, ${WHO}
         FROM rush_runs x
         JOIN players p ON p.id = x.player_id
         LEFT JOIN guilds g ON g.guild_id = x.guild_id
        WHERE x.day >= $lo AND x.day < $cut
        ORDER BY day, solved DESC, timeMs, name, playerKey, serverKey`,
    )
    .all(bounds);
}

/**
 * `Store.rushRecords`' window, one scope at a time, with the cut added: the
 * game's own board includes today. The day breaks a tie between two of a
 * player's runs, so which one is their record never depends on row order.
 */
function rushRecordSelect(perServer: boolean): string {
  return `
    SELECT ${perServer ? "g.public_key" : "$all"} AS scope, x.solved AS solved,
           x.time_to_last_ms AS timeMs, x.day AS day, ${WHO},
           ROW_NUMBER() OVER (
             PARTITION BY ${perServer ? "g.public_key, " : ""}x.player_id
             ORDER BY x.solved DESC, x.time_to_last_ms ASC, x.day ASC
           ) AS seat
      FROM rush_runs x
      JOIN players p ON p.id = x.player_id
      ${perServer ? "JOIN guilds g ON g.guild_id = x.guild_id" : ""}
     WHERE x.day < $cut`;
}

function rushRecords(db: Database, bounds: Bounds): SnapshotRushRecord[] {
  return db
    .query<SnapshotRushRecord, Bounds>(
      `SELECT scope, solved, timeMs, day, playerKey, name
         FROM (${rushRecordSelect(false)} UNION ALL ${rushRecordSelect(true)})
        WHERE seat = 1
        ORDER BY scope, solved DESC, timeMs, day, name, playerKey`,
    )
    .all(bounds);
}

/**
 * Each player's solved days before the cut, legacy days included, and how
 * many dailies they solved — `Store.dailyRecords`' rows, grouped per player
 * here so the id never leaves. The days come back newest-first in JS, which is
 * the order `currentStreak` and `bestStreak` take.
 */
function dailyDays(db: Database, bounds: Bounds): SnapshotDailyDays[] {
  return db
    .query<Cells<Omit<SnapshotDailyDays, "days">> & { days: string }, Bounds>(
      `SELECT ${WHO}, json_group_array(d.day) AS days, SUM(d.n) AS dailies
         FROM (SELECT player_id, day, COUNT(*) AS n FROM runs
                WHERE solved = 1 AND day < $cut GROUP BY player_id, day) d
         JOIN players p ON p.id = d.player_id
        GROUP BY d.player_id
        ORDER BY dailies DESC, name, playerKey`,
    )
    .all(bounds)
    .map((row) => ({ ...row, days: (JSON.parse(row.days) as number[]).toSorted((a, b) => b - a) }));
}

/** First clears before the game's midnight that starts the cut. Never `best_ms`, `times` or `last_at`. */
const CLEARED_SQL = `
  SELECT ${WHO}, COUNT(*) AS count
    FROM puzzle_clears c
    JOIN players p ON p.id = c.player_id
   WHERE c.first_at < $cutStart
   GROUP BY c.player_id`;

/**
 * Which puzzles each shown player first cleared before the game's midnight
 * that starts the cut, in any mode: the list a profile prints under "Puzzles
 * cleared".
 *
 * **Shown players only, decided here with {@link SHOWN}.** Every other
 * per-player read lets a hidden player's rows out unlabelled, because one
 * unlabelled number cannot be traced back to anybody. A set of puzzles can:
 * the whole of what someone has cleared is as good as their name to anyone
 * who has seen it once. So a hidden player's clears are counted
 * ({@link CLEARED_SQL}) and never listed, and the list never becomes a JS value
 * for a leak to start from. Never `best_ms`, `times` or `last_at`; `first_at`
 * only bounds the read.
 */
const CLEARED_PUZZLES_SQL = `
  SELECT ${WHO}, c.puzzle_id AS puzzleId
    FROM puzzle_clears c
    JOIN players p ON p.id = c.player_id
   WHERE c.first_at < $cutStart AND ${SHOWN}
   ORDER BY playerKey, puzzleId`;

function clearedPuzzles(db: Database, bounds: Bounds): SnapshotClear[] {
  return db.query<SnapshotClear, Bounds>(CLEARED_PUZZLES_SQL).all(bounds);
}

/**
 * Lines credited to each finder, counted as the Discoveries board counts them —
 * voided lines included and any puzzle — less the ones filed on the cut's day
 * or later. `found_at < $cutStart` is the same test as {@link LINE_DAY} being
 * before the cut, written the way that needs no list of starts.
 */
const DISCOVERIES_SQL = `
  SELECT ${WHO}, COUNT(*) AS count
    FROM puzzle_solutions s
    JOIN players p ON p.id = s.found_by
   WHERE ${CREDITED} AND s.found_at < $cutStart
   GROUP BY s.found_by`;

function counted(db: Database, bounds: Bounds, sql: string): SnapshotCount[] {
  return db.query<SnapshotCount, Bounds>(`${sql} ORDER BY count DESC, name, playerKey`).all(bounds);
}

interface LineCells {
  puzzleId: number;
  placements: string;
  attack: number;
  clears: string;
}

/**
 * The live credited lines filed before the cut, in publication order: by
 * puzzle, then by the game's day each was filed on, then as filed. Nothing
 * that orders them is selected, so the order is all a reader gets of when.
 */
function lines(db: Database, bounds: Bounds): SnapshotLine[] {
  return db
    .query<LineCells, Bounds>(
      `SELECT s.puzzle_id AS puzzleId, s.placements AS placements, s.attack AS attack, s.clears AS clears
         FROM puzzle_solutions s
        WHERE ${CREDITED} AND s.${LIVE} AND s.found_at < $cutStart
        ORDER BY s.puzzle_id, ${LINE_DAY}, s.solution_id`,
    )
    .all(bounds)
    .map((row) => ({
      puzzleId: row.puzzleId,
      attack: row.attack,
      clears: knownClears(JSON.parse(row.clears), row.puzzleId),
      steps: reprojected(row.placements, row.puzzleId),
    }));
}

function servers(db: Database, bounds: Bounds): SnapshotServer[] {
  return db
    .query<SnapshotServer, Bounds>(`SELECT g.public_key AS key, ${GUILD_NAME} AS name FROM guilds g ORDER BY key`)
    .all(bounds);
}

const KNOWN_CLEARS: ReadonlySet<string> = new Set(CLEAR_NAMES);
const MINOS: ReadonlySet<string> = new Set(["I", "J", "L", "O", "S", "T", "Z"]);

function knownClears(stored: unknown, puzzleId: number): ClearName[] {
  if (!Array.isArray(stored)) throw new Error(`A stored line on puzzle ${puzzleId} has clears that are not a list`);
  return stored.filter((clear): clear is ClearName => typeof clear === "string" && KNOWN_CLEARS.has(clear));
}

/**
 * A stored line's placements, rebuilt as `{piece, cells, clear, attack}` and
 * nothing else.
 *
 * Rebuilt rather than passed through because the column is JSON the game
 * wrote, and whatever else rides in a step there — a field some later build
 * adds — must not reach the open web because it happened to be in the row.
 * A step that is not a placement is an error: the refresher keeps serving the
 * last good dataset, and the log names the puzzle.
 */
function reprojected(placements: string, puzzleId: number): SolutionStep[] {
  const stored: unknown = JSON.parse(placements);
  if (!Array.isArray(stored)) throw new Error(`A stored line on puzzle ${puzzleId} is not a list of placements`);
  return stored.map((step: unknown) => placementOf(step, puzzleId));
}

function placementOf(step: unknown, puzzleId: number): SolutionStep {
  const { piece, cells, clear, attack } = (step ?? {}) as Record<string, unknown>;
  const pairs = Array.isArray(cells) ? cells.map(cellOf) : null;
  if (typeof piece !== "string" || !MINOS.has(piece) || typeof attack !== "number" || !pairs?.every(Boolean)) {
    throw new Error(`A stored line on puzzle ${puzzleId} holds a step that is not a placement`);
  }
  return {
    piece: piece as Mino,
    cells: pairs as [number, number][],
    clear: typeof clear === "string" && KNOWN_CLEARS.has(clear) ? (clear as ClearName) : null,
    attack,
  };
}

function cellOf(cell: unknown): [number, number] | null {
  if (!Array.isArray(cell) || cell.length !== 2) return null;
  const [x, y] = cell as unknown[];
  return typeof x === "number" && typeof y === "number" ? [x, y] : null;
}

/** Freezes a freshly read value and everything inside it. */
function deepFrozen<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFrozen(inner);
  }
  return value;
}
