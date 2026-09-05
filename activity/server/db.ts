/**
 * Persistence. SQLite because the whole game is one row per player per day, and
 * a file that can be copied is worth more here than a database server.
 */

import { Database } from "bun:sqlite";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";
import type { Puzzle } from "../shared/puzzle";
import {
  deleteOverride,
  overrideHistory,
  type OverrideChanges,
  type OverrideLogEntry,
  type PuzzleOverride,
  readOverrides,
  writeOverride,
} from "./puzzle-overrides";
import {
  acceptSubmission,
  countPendingSubmissions,
  insertSubmission,
  isAcceptedPuzzleId,
  readAcceptedPuzzles,
  readPendingSubmissions,
  readSubmission,
  rejectSubmission,
  type Acceptance,
  type Decided,
  type Rejection,
  type Submission,
  type SubmissionDraft,
} from "./submissions";

/** Marks a run filed when a day held one puzzle and there was nothing to name. */
const LEGACY_SLOT = "legacy";

/** One member of a pinned rush pool: its id, and the band it was pinned at. */
export interface PinnedMember {
  readonly id: number;
  readonly difficulty: number;
}

export interface PinnedRushPool {
  readonly ids: readonly number[];
  /**
   * What each id's difficulty was on the day this row was written, or null for
   * a row from before the column existed — in which case the caller has to fall
   * back to the archive and accept that a rebuilt file moves the ladder.
   */
  readonly difficulties: readonly number[] | null;
}

/**
 * A JSON column back as a list of numbers, or a loud failure.
 *
 * Parsed defensively even though this process wrote it. A JSON column is a blob
 * to SQLite, so nothing but this checks it, and a list that came back holding a
 * string or a null would not fail — it would reach `rushSequence`, deal an
 * undefined puzzle, and score a run against it.
 */
function numberList(raw: string, named: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${named} is not valid JSON`, { cause: error });
  }
  // `isInteger`, not `isFinite`: every list this reads is puzzle ids or
  // difficulty bands, and a 1.5 that passed here would not fail until
  // `resolve()` could not find a puzzle, which is a worse place to hear it.
  if (!Array.isArray(parsed) || !parsed.every((value) => Number.isInteger(value))) {
    throw new Error(`${named} is not a list of whole numbers`);
  }
  return parsed as number[];
}
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface PlayerProfile {
  readonly id: string;
  readonly username: string;
  readonly avatarUrl: string | null;
}

/** A day's board row: one player, and how each of the three went for them. */
export interface DayBoardRow {
  readonly player: PlayerProfile;
  readonly solved: number;
  readonly totalMs: number;
  /** Missing means never opened; false means filed and not solved. */
  readonly marks: Partial<Record<DailyTier, boolean>>;
}

/** The raw shape of a {@link Store.dayBoard} row: marks as 0 absent, 1 filed, 2 solved. */
interface DayBoardRaw {
  id: string;
  username: string;
  avatarUrl: string | null;
  solved: number;
  totalMs: number;
  easy: number;
  medium: number;
  hard: number;
}

/** One player's best rush ever, for the all-time board. */
export interface RushRecord {
  readonly player: PlayerProfile;
  readonly solved: number;
  readonly timeToLastSolveMs: number;
  /** The day it was set, so a record can be dated. */
  readonly day: number;
}

export interface RunResult {
  readonly solved: boolean;
  readonly attack: number;
  readonly targetAttack: number;
  /** The solving attempt, measured by replaying its inputs. Verified. */
  readonly durationMs: number;
  /** Wall clock from opening the puzzle to solving it. The player's own claim. */
  readonly totalMs: number;
  readonly resets: number;
  readonly piecesPlaced: number;
  readonly clears: readonly string[];
}

/** One rush, as it goes on the board. */
export interface RushResult {
  readonly solved: number;
  /** Puzzles started, including the one the buzzer interrupted. */
  readonly attempted: number;
  readonly skipsUsed: number;
  /**
   * Time to the last solve, which is what separates two players on the same
   * count. Bounded by the server's own measurement of the run; see the note in
   * the rush route.
   */
  readonly timeToLastSolveMs: number;
  /** The whole run, as measured between the server's two timestamps. */
  readonly elapsedMs: number;
}

export interface StoredRushRun extends RushResult {
  readonly day: number;
  readonly player: PlayerProfile;
  readonly createdAt: number;
}

interface RushRow {
  day: number;
  player_id: string;
  username: string;
  avatar_url: string | null;
  solved: number;
  attempted: number;
  skips_used: number;
  time_to_last_ms: number;
  elapsed_ms: number;
  created_at: number;
}

export interface StoredRun extends RunResult {
  readonly day: number;
  readonly puzzleId: number;
  readonly player: PlayerProfile;
  readonly createdAt: number;
}

interface RunRow {
  day: number;
  puzzle_id: number;
  player_id: string;
  username: string;
  avatar_url: string | null;
  solved: number;
  attack: number;
  target_attack: number;
  duration_ms: number;
  total_ms: number;
  resets: number;
  pieces_placed: number;
  clears: string;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  avatar_url  TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  day           INTEGER NOT NULL,
  player_id     TEXT NOT NULL REFERENCES players(id),
  guild_id      TEXT,
  puzzle_id     INTEGER NOT NULL,
  solved        INTEGER NOT NULL,
  attack        INTEGER NOT NULL,
  target_attack INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  total_ms      INTEGER NOT NULL DEFAULT 0,
  resets        INTEGER NOT NULL,
  pieces_placed INTEGER NOT NULL,
  clears        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  -- Which of the day's three puzzles this run is. 'legacy' marks a row filed
  -- when a day held one puzzle and there was nothing to name.
  slot          TEXT NOT NULL DEFAULT 'legacy',
  PRIMARY KEY (day, player_id, slot)
);

CREATE INDEX IF NOT EXISTS runs_by_day    ON runs (day, guild_id);
CREATE INDEX IF NOT EXISTS runs_by_player ON runs (player_id, day);
-- A server's streak asks the opposite question to the two above — one guild
-- across every day, rather than one day across every guild — and neither of
-- them leads with guild_id, so without this it walks the table backwards and
-- pays for every other server's history on the way.
CREATE INDEX IF NOT EXISTS runs_by_guild  ON runs (guild_id, solved, day);

CREATE TABLE IF NOT EXISTS rush_runs (
  day             INTEGER NOT NULL,
  player_id       TEXT NOT NULL REFERENCES players(id),
  guild_id        TEXT,
  solved          INTEGER NOT NULL,
  attempted       INTEGER NOT NULL,
  skips_used      INTEGER NOT NULL,
  time_to_last_ms INTEGER NOT NULL,
  elapsed_ms      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (day, player_id)
);

CREATE INDEX IF NOT EXISTS rush_by_day ON rush_runs (day, guild_id);
-- The all-time board asks a different question to the daily one: every run a
-- player has ever filed, best first, rather than one day across everybody.
CREATE INDEX IF NOT EXISTS rush_records ON rush_runs (player_id, solved DESC, time_to_last_ms ASC);

CREATE TABLE IF NOT EXISTS preferences (
  player_id  TEXT PRIMARY KEY REFERENCES players(id),
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Which three puzzles a day dealt, written down the first time the day is
-- asked for. The rotation is derived from the pool's size, so a pool that
-- grows deals a different puzzle for almost every day that has already been
-- played; this is what stops the archive growing from rewriting history.
--
-- No foreign key on puzzle_id. Puzzles live in a JSON file the build rewrites
-- wholesale, not in a table, so there is no parent row to reference.
CREATE TABLE IF NOT EXISTS day_puzzles (
  day       INTEGER NOT NULL,
  tier      TEXT NOT NULL,
  puzzle_id INTEGER NOT NULL,
  PRIMARY KEY (day, tier)
);

-- The pool a day's rushes are drawn from, as a JSON list of ids in the order
-- the sequence reads them. The pool rather than the forty a rush deals: only
-- the ranked run uses the day's shared seed and every replay draws its own, so
-- freezing the forty would hand every practice run the same stack. Freezing
-- what they are all drawn from leaves the seed to do its job.
CREATE TABLE IF NOT EXISTS day_rush (
  day        INTEGER PRIMARY KEY,
  puzzle_ids TEXT NOT NULL,
  -- The difficulty each id carried on the day it was pinned, in the same order.
  -- rushSequence finishes by sorting on rushBand, which reads difficulty, so
  -- freezing the members and reading their band from the live archive froze the
  -- wrong half. Added by migration and nullable, so a row written before this
  -- column falls back to the source and says so.
  bands      TEXT
);

-- Puzzles players wrote, waiting for an officer. The queries are in
-- server/submissions.ts; the table is here so the shape of the database can
-- still be read in one place.
--
-- A surrogate key rather than anything meaningful, because the resubmission
-- rule belongs in the app and not in the schema: SQLite cannot alter a primary
-- key, and the rule wanted here — a player may write several puzzles, and may
-- write a new one after a rejection — is exactly the rule a key cannot express.
--
-- target_attack and solution are DERIVED. They are the server's reading of
-- the author's own input log, never a number the body carried; see
-- POST /api/submissions for what goes wrong when they are not. The events
-- column is kept beside them, so accepting can re-run the log rather than
-- trust the placements written down next to it.
CREATE TABLE IF NOT EXISTS submissions (
  submission_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id          TEXT NOT NULL REFERENCES players(id),
  author_name        TEXT NOT NULL,
  guild_id           TEXT,
  title              TEXT NOT NULL,
  goal               TEXT NOT NULL,
  claimed_difficulty REAL NOT NULL,
  board              TEXT NOT NULL,   -- JSON RowCode[]
  queue              TEXT NOT NULL,   -- JSON Mino[]
  hold               TEXT,
  target_attack      INTEGER NOT NULL,
  solution           TEXT NOT NULL,   -- JSON SolutionStep[]
  events             TEXT NOT NULL,   -- JSON InputEvent[]
  handling           TEXT NOT NULL,
  pieces_placed      INTEGER NOT NULL,
  clears             TEXT NOT NULL,
  -- JSON ClearRequirement[], or NULL. Frozen at submit from the author's own
  -- goal, gated on their own solve — see server/submissions.ts. Nullable
  -- because most goals name nothing a count can hold.
  required_clears    TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',
  reviewer_note      TEXT,
  reviewed_at        INTEGER,
  reviewed_by        TEXT,
  puzzle_id          INTEGER,
  difficulty         REAL,
  created_at         INTEGER NOT NULL
);

-- The review queue's only question: what is still pending, oldest first.
CREATE INDEX IF NOT EXISTS submissions_queue ON submissions (status, created_at);
-- Two accepted puzzles sharing an id is not a conflict SQLite would otherwise
-- notice, and PuzzleArchive would not either: it builds a Map by id, so the
-- second copy wins the lookup while both stay in the array and in the rush
-- pool. Partial, because every pending and rejected row has no id at all.
CREATE UNIQUE INDEX IF NOT EXISTS submissions_puzzle
  ON submissions (puzzle_id) WHERE puzzle_id IS NOT NULL;

-- An officer's correction to a puzzle's metadata: the only edit that survives
-- \`bun run puzzles\`. The queries are in server/puzzle-overrides.ts, which also
-- says why there is one table for corrections rather than a file edit for club
-- puzzles and an UPDATE for players'; the table is here so the shape of the
-- database can still be read in one place.
--
-- One nullable column per editable field, and NULL means "no override, use the
-- source". That is what makes a partial correction expressible and a revert a
-- single DELETE.
--
-- board, queue, hold, target_attack and solution are deliberately absent: they
-- are what a puzzle IS. Runs are filed against a puzzle_id with no record of
-- the board they were played on, so editing one would silently invalidate every
-- leaderboard row standing against it and every past day that dealt it. The
-- five here cannot change what a solve was worth.
--
-- No foreign key on puzzle_id, for the reason day_puzzles gives: club puzzles
-- live in a JSON file the build rewrites wholesale, not in a table, so there is
-- no parent row to reference. An override naming an id the archive does not
-- hold is inert — the merge only looks up ids it already has — and the PATCH
-- route refuses one at the point somebody can still be told about it.
CREATE TABLE IF NOT EXISTS puzzle_overrides (
  puzzle_id  INTEGER PRIMARY KEY,
  title      TEXT,
  author     TEXT,
  goal       TEXT,
  -- REAL, matching submissions.difficulty: which numbers on the scale mean
  -- anything is the club's convention, not something the column should round.
  difficulty REAL,
  -- set_name, because SET is SQL's own keyword and a column that has to be
  -- quoted in every statement is one statement away from not being.
  set_name   TEXT,
  updated_at INTEGER NOT NULL,
  -- The review grant's subject: an attribution the operator typed, not an
  -- identity, exactly as submissions.reviewed_by is.
  updated_by TEXT NOT NULL
);

/*
 * Who changed what, appended and never rewritten.
 *
 * puzzle_overrides is one row per puzzle with a single updated_by, which is the
 * right shape for the merge to read and the wrong one for a record: five fields
 * share that column, so the second officer to touch a puzzle took credit for
 * the first one's corrections and overwrote their name in place. And a revert
 * is a DELETE, so undoing a correction erased every trace that one had been
 * made. Accept and reject both leave a name behind; this was the one review
 * action that left none.
 *
 * Append-only, one row per field that actually moved, with the value on each
 * side of the move — so the history survives both a second correction and the
 * revert that removes the current-state row entirely.
 */
CREATE TABLE IF NOT EXISTS puzzle_override_log (
  entry_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  puzzle_id INTEGER NOT NULL,
  field     TEXT NOT NULL,
  was       TEXT,
  became    TEXT,
  at        INTEGER NOT NULL,
  by        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS puzzle_override_log_puzzle
  ON puzzle_override_log (puzzle_id, entry_id);
`;

/**
 * How the days that have already happened were dealt.
 *
 * Handed to the {@link Store} so the backfill can write down what the rotation
 * was already producing, and shaped as a callback because the derivation needs
 * the puzzle archive and persistence must not: `day_puzzles` is a table of
 * numbers, and a store that had to load and validate a JSON archive to open
 * itself would be untestable without one.
 */
export interface PastDays {
  /** The last day that has been dealt. Everything up to it is history. */
  readonly throughDay: number;
  /** The three ids a day held, derived the way the code has always derived them. */
  puzzleIdsFor(day: number): Readonly<Record<DailyTier, number>>;
}

function toStoredRun(row: RunRow): StoredRun {
  return {
    day: row.day,
    puzzleId: row.puzzle_id,
    player: { id: row.player_id, username: row.username, avatarUrl: row.avatar_url },
    solved: row.solved === 1,
    attack: row.attack,
    targetAttack: row.target_attack,
    durationMs: row.duration_ms,
    totalMs: row.total_ms,
    resets: row.resets,
    piecesPlaced: row.pieces_placed,
    clears: JSON.parse(row.clears),
    createdAt: row.created_at,
  };
}

function toStoredRushRun(row: RushRow): StoredRushRun {
  return {
    day: row.day,
    player: { id: row.player_id, username: row.username, avatarUrl: row.avatar_url },
    solved: row.solved,
    attempted: row.attempted,
    skipsUsed: row.skips_used,
    timeToLastSolveMs: row.time_to_last_ms,
    elapsedMs: row.elapsed_ms,
    createdAt: row.created_at,
  };
}

const RUSH_COLUMNS = `
  rush_runs.day, rush_runs.player_id, players.username, players.avatar_url,
  rush_runs.solved, rush_runs.attempted, rush_runs.skips_used,
  rush_runs.time_to_last_ms, rush_runs.elapsed_ms, rush_runs.created_at
`;

const RUN_COLUMNS = `
  runs.day, runs.puzzle_id, runs.player_id, players.username, players.avatar_url,
  runs.solved, runs.attack, runs.target_attack, runs.duration_ms, runs.total_ms, runs.resets,
  runs.pieces_placed, runs.clears, runs.created_at
`;

export class Store {
  private readonly db: Database;

  /**
   * @param pastDays the rotation to write history down from, for a caller whose
   *   archive does not come out of this database. `server/index.ts`'s does, so
   *   it opens the store bare and calls {@link pinPastDays} once it has one.
   */
  constructor(path: string, pastDays?: PastDays) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.run(SCHEMA);
    // Before anything else touches `runs`: a database written when a day held
    // one puzzle has the wrong primary key, and no amount of ADD COLUMN fixes
    // that.
    this.addSlotsToRuns();
    // After the rebuild, never in SCHEMA: it names `slot`, and SCHEMA runs
    // against a database that may not have that column yet.
    //
    // A board is one day, one guild, one tier, ordered. Without the slot and
    // the sort columns each of the three boards walks the whole day and
    // rebuilds the same sort — measured at 281us for the three, 83us with it.
    this.db.run(
      "CREATE INDEX IF NOT EXISTS runs_board ON runs (day, guild_id, slot, solved DESC, total_ms ASC)",
    );
    // `CREATE TABLE IF NOT EXISTS` leaves an existing table untouched, so a
    // database made before this column existed needs it added explicitly.
    this.addMissingColumn(
      "runs",
      "total_ms",
      "INTEGER NOT NULL DEFAULT 0",
      // Rows from before the column have no total; their verified per-attempt
      // duration is the closest honest stand-in, and it keeps them from sorting
      // ahead of everybody at a displayed time of zero.
      "UPDATE runs SET total_ms = duration_ms WHERE total_ms = 0",
    );
    this.addMissingColumn(
      "submissions",
      "required_clears",
      "TEXT",
      // Deliberately no backfill. A row written before this column existed was
      // accepted under attack-only scoring, and inventing a requirement for it
      // now would hold later players to a bar its author never cleared. NULL is
      // the honest answer: nothing was decided.
    );
    this.addMissingColumn(
      "day_rush",
      "bands",
      "TEXT",
      // Deliberately no backfill. The value wanted here is what the archive
      // said on the day the row was written, and this process cannot know that
      // — filling it from today's file would write a guess that looks like a
      // record. Null means "not recorded", and `rushPoolFor` reads that as the
      // instruction to fall back.
    );
    // Last, because it writes rows rather than shapes, and it must find every
    // table it touches already built.
    if (pastDays) this.pinPastDays(pastDays);
  }

  /**
   * Writes down what the rotation was already dealing, for every day up to
   * today.
   *
   * Two sources, in this order, and the order is the whole of it.
   *
   * **What was played comes first.** `runs.puzzle_id` is the recorded fact of
   * which puzzle a (day, tier) actually dealt, sitting in this same database,
   * and it is right whatever has happened to the pool since. Deriving over the
   * top of it is how a deploy that ships this table *and* a rebuilt
   * `data/puzzles.json` together — an entirely ordinary pairing, and one nobody
   * would think to sequence — writes history that contradicts the runs beside
   * it, silently: the recap then names a puzzle nobody played, and a player who
   * solved the day is handed no solution because the ids disagree.
   *
   * **The derivation fills the rest**, which is only the days nobody played. It
   * is correct *only* because the pool has not grown yet — re-deriving a
   * finished day is the exact rewrite `day_puzzles` exists to prevent — but on
   * a day with no runs on it there is nothing to be wrong about, which is what
   * makes the remaining window harmless rather than merely narrow. The guard on
   * the table being empty is still there: a later start deriving a day it
   * happened to be missing would be reading the wrong pool and would not know.
   *
   * `INSERT OR IGNORE` on top of the guard, so a start that dies partway
   * through resumes without disturbing what it already pinned. One transaction:
   * a half-backfilled table is one where some days are history and some are
   * whatever today's pool says, which is worse than none.
   *
   * Nothing backfills `day_rush`. A past day's rush stack was never recorded
   * anywhere and no route ever re-derives one, so there is nothing to recover
   * and nothing that would read it. Today's is pinned by `DaySchedule`'s
   * constructor rather than by the first ticket minted — see the comment
   * there, which explains the same-day restart that gap let through.
   *
   * **Public, and called after construction by `server/index.ts` on purpose.**
   * The archive now loads accepted submissions out of this database, so it
   * needs a store before it exists — and this needs an archive, because the
   * derivation is the archive's. That cycle is broken by making the backfill a
   * step rather than part of opening: store, then archive, then this. Deriving
   * from a club-only archive first and rebuilding afterwards was the
   * alternative, and it loses because the two derivations would disagree about
   * every unplayed day the moment one puzzle had ever been accepted — pinning
   * history from a pool the server is not actually running.
   *
   * Idempotent, so calling it late is not calling it twice: the guard above is
   * on the table having any row at all.
   */
  pinPastDays(pastDays: PastDays): void {
    if (this.db.query<{ one: number }, []>("SELECT 1 AS one FROM day_puzzles LIMIT 1").get()) {
      return;
    }
    this.db.transaction(() => {
      this.pinDaysAlreadyPlayed();
      for (let day = 1; day <= pastDays.throughDay; day++) {
        this.insertDay(day, pastDays.puzzleIdsFor(day));
      }
    })();
  }

  /**
   * The days somebody has already played, taken from the runs they played.
   *
   * Runs from before the archive held three a day carry the legacy slot, which
   * names no tier — they are skipped rather than guessed at. Everything else is
   * a `(day, tier, puzzle_id)` triple that is true by construction: it is what
   * the server dealt that player, recorded at the time.
   */
  private pinDaysAlreadyPlayed(): void {
    const insert = this.db.query<unknown, [number, string, number]>(
      "INSERT OR IGNORE INTO day_puzzles (day, tier, puzzle_id) VALUES (?1, ?2, ?3)",
    );
    const played = this.db
      .query<{ day: number; slot: string; puzzle_id: number }, [string]>(
        "SELECT DISTINCT day, slot, puzzle_id FROM runs WHERE slot <> ?1",
      )
      .all(LEGACY_SLOT);
    for (const row of played) {
      if (DAILY_TIERS.includes(row.slot as DailyTier)) insert.run(row.day, row.slot, row.puzzle_id);
    }
  }

  /**
   * One day's three rows, whichever of them are still missing.
   *
   * `INSERT OR IGNORE`, and the caller owns the transaction. Both writers — the
   * one-time backfill and the first request to reach an unpinned day — must
   * leave an existing row alone, because an existing row is the older fact and
   * the older fact is the one somebody played.
   */
  private insertDay(day: number, ids: Readonly<Record<DailyTier, number>>): void {
    const insert = this.db.query<unknown, [number, string, number]>(
      "INSERT OR IGNORE INTO day_puzzles (day, tier, puzzle_id) VALUES (?1, ?2, ?3)",
    );
    for (const tier of DAILY_TIERS) insert.run(day, tier, ids[tier]);
  }

  /**
   * Gives `runs` a slot, and a primary key that admits three a day.
   *
   * `PRIMARY KEY (day, player_id)` was the rule "one run per player per day",
   * and it was enforced by the key itself rather than by any code. SQLite
   * cannot alter a primary key, so this is the documented rebuild: new table,
   * copy, drop, rename. `addMissingColumn` cannot do it — a slot column added
   * to the old table would leave the old key in place, and the second puzzle of
   * a day would still be swallowed by the conflict clause.
   *
   * Existing rows become 'legacy' rather than being guessed into a tier. They
   * were filed against a day's single puzzle, which is not one of the three
   * that day now deals, and calling one of them "the easy one" would be a
   * fabrication that then shows up on a leaderboard. They still count for
   * streaks and totals, which ask only whether a day was solved.
   *
   * Foreign keys are switched off around the swap and not inside it: the
   * pragma is a no-op within a transaction, and `runs.player_id` references
   * `players(id)`, so dropping the old table with them on would be refused.
   */
  private addSlotsToRuns(): void {
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(runs)").all();
    if (columns.some((column) => column.name === "slot")) return;

    const carried = columns.map((column) => column.name).join(", ");
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.run(`CREATE TABLE runs_rebuilt (
          day           INTEGER NOT NULL,
          player_id     TEXT NOT NULL REFERENCES players(id),
          guild_id      TEXT,
          puzzle_id     INTEGER NOT NULL,
          solved        INTEGER NOT NULL,
          attack        INTEGER NOT NULL,
          target_attack INTEGER NOT NULL,
          duration_ms   INTEGER NOT NULL,
          total_ms      INTEGER NOT NULL DEFAULT 0,
          resets        INTEGER NOT NULL,
          pieces_placed INTEGER NOT NULL,
          clears        TEXT NOT NULL,
          created_at    INTEGER NOT NULL,
          slot          TEXT NOT NULL DEFAULT 'legacy',
          PRIMARY KEY (day, player_id, slot)
        )`);
        this.db.run(
          `INSERT INTO runs_rebuilt (${carried}, slot) SELECT ${carried}, '${LEGACY_SLOT}' FROM runs`,
        );
        this.db.run("DROP TABLE runs");
        this.db.run("ALTER TABLE runs_rebuilt RENAME TO runs");
        this.db.run("CREATE INDEX IF NOT EXISTS runs_by_day    ON runs (day, guild_id)");
        this.db.run("CREATE INDEX IF NOT EXISTS runs_by_player ON runs (player_id, day)");
        this.db.run("CREATE INDEX IF NOT EXISTS runs_by_guild  ON runs (guild_id, solved, day)");
      })();
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  /**
   * Adds a column to an existing table, and backfills it.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
   * so a new column needs this. `backfill` matters as much as the column: a
   * default of 0 on `total_ms` would put every run recorded before the column
   * existed permanently at the top of a leaderboard sorted by it.
   *
   * The identifiers are interpolated rather than bound — SQLite cannot bind
   * them — so every caller must pass a literal, never anything from a request.
   */
  private addMissingColumn(
    table: string,
    column: string,
    definition: string,
    backfill?: string,
  ): void {
    const columns = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (columns.some((c) => c.name === column)) return;
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (backfill) this.db.run(backfill);
  }

  close(): void {
    this.db.close();
  }

  upsertPlayer(player: PlayerProfile): void {
    this.db
      .query(
        `INSERT INTO players (id, username, avatar_url, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           avatar_url = excluded.avatar_url,
           updated_at = excluded.updated_at`,
      )
      .run(player.id, player.username, player.avatarUrl, Date.now());
  }

  /**
   * Records a run. The first *solve* of a day is final — a daily puzzle you can
   * retry until you like the number is not a daily puzzle — but an unsolved row
   * can still be replaced by a later solve, so one bad submission never costs
   * somebody their day.
   *
   * @returns the run now on file, which may be an earlier one.
   */
  recordRun(
    day: number,
    slot: DailyTier,
    puzzleId: number,
    player: PlayerProfile,
    guildId: string | null,
    result: RunResult,
  ): { run: StoredRun; isFirst: boolean } {
    this.upsertPlayer(player);
    const changes = this.db
      .query(
        `INSERT INTO runs (day, player_id, guild_id, puzzle_id, solved, attack,
                           target_attack, duration_ms, total_ms, resets,
                           pieces_placed, clears, created_at, slot)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(day, player_id, slot) DO UPDATE SET
           guild_id = excluded.guild_id,
           solved = excluded.solved,
           attack = excluded.attack,
           -- Both of these were left out while a day had one puzzle and the
           -- identity could not change. It can now: a slot is a tier, and the
           -- tier deals a different puzzle each day.
           puzzle_id = excluded.puzzle_id,
           target_attack = excluded.target_attack,
           duration_ms = excluded.duration_ms,
           total_ms = excluded.total_ms,
           resets = excluded.resets,
           pieces_placed = excluded.pieces_placed,
           clears = excluded.clears,
           created_at = excluded.created_at
         WHERE runs.solved = 0 AND excluded.solved = 1`,
      )
      .run(
        day,
        player.id,
        guildId,
        puzzleId,
        result.solved ? 1 : 0,
        result.attack,
        result.targetAttack,
        result.durationMs,
        result.totalMs,
        result.resets,
        result.piecesPlaced,
        JSON.stringify(result.clears),
        Date.now(),
        slot,
      );

    const run = this.runFor(day, player.id, slot);
    if (!run) throw new Error("Run vanished immediately after being written");
    return { run, isFirst: changes.changes > 0 };
  }

  runFor(day: number, playerId: string, slot: DailyTier): StoredRun | null {
    const row = this.db
      .query<RunRow, [number, string, string]>(
        `SELECT ${RUN_COLUMNS} FROM runs
         JOIN players ON players.id = runs.player_id
         WHERE runs.day = ?1 AND runs.player_id = ?2 AND runs.slot = ?3`,
      )
      .get(day, playerId, slot);
    return row ? toStoredRun(row) : null;
  }

  /**
   * The day as one board: a row per player, with what they did to each tier.
   *
   * The merge belongs here and not in the two clients that were doing it. Three
   * per-tier boards each carried their own `LIMIT`, and the limit was applied
   * *before* anything joined them up — so a player twenty-sixth on easy and
   * first on hard came back on the hard board only, and both renderers drew a
   * row that silently dropped their easy mark. One query, one grouping, one
   * limit over the merged rows.
   *
   * Marks are encoded 0/1/2 rather than as two columns: absent, filed and
   * failed, solved. Those are three different days and a boolean cannot hold
   * them. `MAX` over the encoding picks the best a player did on a tier, which
   * matters because a miss can be upgraded by a later solve.
   *
   * 'legacy' rows are excluded. They were filed against a day's single puzzle,
   * which is none of the three that day deals now.
   */
  dayBoard(day: number, guildId: string | null, limit = 25): DayBoardRow[] {
    const rows = this.db
      .query<DayBoardRaw, [number, string | null, number]>(
        `SELECT players.id AS id, players.username AS username,
                players.avatar_url AS avatarUrl,
                SUM(runs.solved) AS solved,
                SUM(CASE WHEN runs.solved = 1 THEN runs.total_ms ELSE 0 END) AS totalMs,
                MAX(CASE WHEN runs.slot = 'easy'   THEN runs.solved + 1 ELSE 0 END) AS easy,
                MAX(CASE WHEN runs.slot = 'medium' THEN runs.solved + 1 ELSE 0 END) AS medium,
                MAX(CASE WHEN runs.slot = 'hard'   THEN runs.solved + 1 ELSE 0 END) AS hard
         FROM runs JOIN players ON players.id = runs.player_id
         WHERE runs.day = ?1 AND (?2 IS NULL OR runs.guild_id = ?2)
           AND runs.slot IN ('easy', 'medium', 'hard')
         GROUP BY runs.player_id
         ORDER BY solved DESC, totalMs ASC
         LIMIT ?3`,
      )
      .all(day, guildId, limit);

    return rows.map((row) => {
      const marks: Partial<Record<DailyTier, boolean>> = {};
      for (const tier of DAILY_TIERS) {
        const state = row[tier];
        if (state > 0) marks[tier] = state === 2;
      }
      return {
        player: { id: row.id, username: row.username, avatarUrl: row.avatarUrl },
        solved: row.solved,
        totalMs: row.totalMs,
        marks,
      };
    });
  }

  /** Every slot this player has filed for a day, keyed by tier. */
  runsFor(day: number, playerId: string): Partial<Record<DailyTier, StoredRun>> {
    const rows = this.db
      .query<RunRow & { slot: string }, [number, string]>(
        `SELECT ${RUN_COLUMNS}, runs.slot FROM runs
         JOIN players ON players.id = runs.player_id
         WHERE runs.day = ?1 AND runs.player_id = ?2`,
      )
      .all(day, playerId);
    const runs: Partial<Record<DailyTier, StoredRun>> = {};
    for (const row of rows) {
      // 'legacy' rows are from a day that held one puzzle. They are kept for
      // streaks and totals, and belong to none of today's three.
      if (DAILY_TIERS.includes(row.slot as DailyTier)) runs[row.slot as DailyTier] = toStoredRun(row);
    }
    return runs;
  }

  /**
   * Leaderboard for a day, best first: solves above misses, then by the least
   * time spent on the puzzle.
   * Scoped to a guild when there is one.
   */
  leaderboard(day: number, guildId: string | null, slot: DailyTier, limit = 25): StoredRun[] {
    const rows = guildId
      ? this.db
          .query<RunRow, [number, string, string, number]>(
            `SELECT ${RUN_COLUMNS} FROM runs
             JOIN players ON players.id = runs.player_id
             WHERE runs.day = ?1 AND runs.guild_id = ?2 AND runs.slot = ?3
             ORDER BY runs.solved DESC, runs.total_ms ASC, runs.attack DESC
             LIMIT ?4`,
          )
          .all(day, guildId, slot, limit)
      : this.db
          .query<RunRow, [number, string, number]>(
            `SELECT ${RUN_COLUMNS} FROM runs
             JOIN players ON players.id = runs.player_id
             WHERE runs.day = ?1 AND runs.slot = ?2
             ORDER BY runs.solved DESC, runs.total_ms ASC, runs.attack DESC
             LIMIT ?3`,
          )
          .all(day, slot, limit);
    return rows.map(toStoredRun);
  }

  /** Consecutive solved days ending at `day`, counting backwards. */
  streak(playerId: string, day: number): number {
    const rows = this.db
      .query<{ day: number }, [string, number]>(
        // DISTINCT is what makes this a streak and not a count of solves: a
        // day now holds three puzzles, and solving two of them would otherwise
        // put the same day in this list twice and stop the walk dead on the
        // duplicate. Solving any one of the three keeps the day.
        `SELECT DISTINCT day FROM runs
         WHERE player_id = ?1 AND solved = 1 AND day <= ?2
         ORDER BY day DESC LIMIT 400`,
      )
      .all(playerId, day);

    let streak = 0;
    let expected = day;
    for (const row of rows) {
      // A missed day breaks the streak; today not yet played does not.
      if (row.day === expected) {
        streak++;
        expected--;
      } else if (row.day === expected - 1 && streak === 0) {
        streak++;
        expected = row.day - 1;
      } else {
        break;
      }
    }
    return streak;
  }

  /**
   * Consecutive days ending at `day` on which somebody in the server solved.
   *
   * Deliberately stricter than {@link streak}. That one forgives a missing
   * anchor day, because the player may simply not have played yet today; a
   * recap only ever asks about a day that is already over, so the same
   * forgiveness would congratulate a server on a run it had just broken. Here
   * a gap is a gap.
   *
   * `DISTINCT` because a day holds one row per member who played it. Without
   * it the limit would bound rows rather than days, and three friends solving
   * together would cost the streak two days of reach.
   */
  guildStreak(guildId: string, day: number): number {
    const rows = this.db
      .query<{ day: number }, [string, number]>(
        `SELECT DISTINCT day FROM runs
         WHERE guild_id = ?1 AND solved = 1 AND day <= ?2
         ORDER BY day DESC LIMIT 400`,
      )
      .all(guildId, day);

    let streak = 0;
    let expected = day;
    for (const row of rows) {
      if (row.day !== expected) break;
      streak++;
      expected--;
    }
    return streak;
  }

  /**
   * How many of a server's members filed a run for a day.
   *
   * A recap names everybody, but the board it reads is capped. This is what
   * tells it that it is about to leave people out, rather than silently
   * shortening the list.
   */
  dayCount(day: number, guildId: string): number {
    return (
      this.db
        .query<{ n: number }, [number, string]>(
          // DISTINCT: three rows a day per player, and this counts people.
          "SELECT COUNT(DISTINCT player_id) AS n FROM runs WHERE day = ?1 AND guild_id = ?2",
        )
        .get(day, guildId)?.n ?? 0
    );
  }

  /** The same, for the rush board. */
  rushDayCount(day: number, guildId: string): number {
    return (
      this.db
        .query<{ n: number }, [number, string]>(
          "SELECT COUNT(*) AS n FROM rush_runs WHERE day = ?1 AND guild_id = ?2",
        )
        .get(day, guildId)?.n ?? 0
    );
  }

  /** How many players have solved a given day, across every server. */
  solvedCount(day: number): number {
    return (
      this.db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(DISTINCT player_id) AS n FROM runs WHERE day = ?1 AND solved = 1",
        )
        .get(day)?.n ?? 0
    );
  }

  totalSolved(playerId: string): number {
    return (
      this.db
        .query<{ n: number }, [string]>(
          // Days, not rows. The header calls this "solved", and a day holding
          // three puzzles would otherwise let one day count three times — the
          // same correction dayCount and solvedCount needed.
          "SELECT COUNT(DISTINCT day) AS n FROM runs WHERE player_id = ?1 AND solved = 1",
        )
        .get(playerId)?.n ?? 0
    );
  }

  /**
   * Records a ranked rush. The first one of the day is the one that counts.
   *
   * `DO NOTHING` rather than the daily's conditional upsert: a rush cannot
   * improve on itself the way an unsolved puzzle can later be solved, and the
   * start ticket is deliberately stateless, so nothing but this stops a player
   * opening rush after rush and keeping the best. Practice runs never reach
   * here at all.
   *
   * @returns the rush now on file, which may be an earlier one.
   */
  recordRushRun(
    day: number,
    player: PlayerProfile,
    guildId: string | null,
    result: RushResult,
  ): { run: StoredRushRun; isFirst: boolean } {
    this.upsertPlayer(player);
    const changes = this.db
      .query(
        `INSERT INTO rush_runs (day, player_id, guild_id, solved, attempted,
                                skips_used, time_to_last_ms, elapsed_ms, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(day, player_id) DO NOTHING`,
      )
      .run(
        day,
        player.id,
        guildId,
        result.solved,
        result.attempted,
        result.skipsUsed,
        result.timeToLastSolveMs,
        result.elapsedMs,
        Date.now(),
      );

    const run = this.rushRunFor(day, player.id);
    if (!run) throw new Error("Rush run vanished immediately after being written");
    return { run, isFirst: changes.changes > 0 };
  }

  rushRunFor(day: number, playerId: string): StoredRushRun | null {
    const row = this.db
      .query<RushRow, [number, string]>(
        `SELECT ${RUSH_COLUMNS} FROM rush_runs
         JOIN players ON players.id = rush_runs.player_id
         WHERE rush_runs.day = ?1 AND rush_runs.player_id = ?2`,
      )
      .get(day, playerId);
    return row ? toStoredRushRun(row) : null;
  }

  /**
   * Rush board for a day: most solved first, then whoever got there soonest.
   * Scoped to a guild when there is one.
   */
  rushLeaderboard(day: number, guildId: string | null, limit = 25): StoredRushRun[] {
    const order = `ORDER BY rush_runs.solved DESC, rush_runs.time_to_last_ms ASC`;
    const rows = guildId
      ? this.db
          .query<RushRow, [number, string, number]>(
            `SELECT ${RUSH_COLUMNS} FROM rush_runs
             JOIN players ON players.id = rush_runs.player_id
             WHERE rush_runs.day = ?1 AND rush_runs.guild_id = ?2
             ${order} LIMIT ?3`,
          )
          .all(day, guildId, limit)
      : this.db
          .query<RushRow, [number, number]>(
            `SELECT ${RUSH_COLUMNS} FROM rush_runs
             JOIN players ON players.id = rush_runs.player_id
             WHERE rush_runs.day = ?1
             ${order} LIMIT ?2`,
          )
          .all(day, limit);
    return rows.map(toStoredRushRun);
  }

  /**
   * The all-time rush board: each player's best run, best first.
   *
   * Not a day. The daily board answers "who ran today" and is empty for most
   * of a morning; this one is a record book, and a record that expired at
   * midnight would not be one. `guildId` narrows it to a server, and null asks
   * across all of them — the same board, two scopes, so a server can see both
   * where it stands and who it is standing against.
   *
   * Only ranked runs are ever stored, so practice cannot reach this.
   *
   * The window function picks each player's own best row before anything is
   * ranked; a plain GROUP BY with MAX(solved) would give the right count
   * attached to the wrong run's time, and the time is the tiebreak.
   */
  rushRecords(guildId: string | null, limit = 25): RushRecord[] {
    return this.db
      .query<RushRecord & { id: string; username: string; avatarUrl: string | null }, [string | null, number]>(
        `SELECT id, username, avatarUrl, solved, timeToLastSolveMs, day FROM (
           SELECT players.id AS id, players.username AS username,
                  players.avatar_url AS avatarUrl,
                  rush_runs.solved AS solved,
                  rush_runs.time_to_last_ms AS timeToLastSolveMs,
                  rush_runs.day AS day,
                  ROW_NUMBER() OVER (
                    PARTITION BY rush_runs.player_id
                    ORDER BY rush_runs.solved DESC, rush_runs.time_to_last_ms ASC
                  ) AS seat
           FROM rush_runs JOIN players ON players.id = rush_runs.player_id
           WHERE (?1 IS NULL OR rush_runs.guild_id = ?1)
         )
         WHERE seat = 1
         ORDER BY solved DESC, timeToLastSolveMs ASC
         LIMIT ?2`,
      )
      .all(guildId, limit)
      .map((row) => ({
        player: { id: row.id, username: row.username, avatarUrl: row.avatarUrl },
        solved: row.solved,
        timeToLastSolveMs: row.timeToLastSolveMs,
        day: row.day,
      }));
  }

  /** A player's best rush ever, for the sign-off after a run. */
  bestRush(playerId: string): number {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "SELECT MAX(solved) AS n FROM rush_runs WHERE player_id = ?1",
        )
        .get(playerId)?.n ?? 0
    );
  }

  loadPreferences(playerId: string): unknown | null {
    const row = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM preferences WHERE player_id = ?1",
      )
      .get(playerId);
    if (!row) return null;
    try {
      return JSON.parse(row.payload);
    } catch {
      return null;
    }
  }

  savePreferences(player: PlayerProfile, payload: unknown): void {
    this.upsertPlayer(player);
    this.db
      .query(
        `INSERT INTO preferences (player_id, payload, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(player_id) DO UPDATE SET
           payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(player.id, JSON.stringify(payload), Date.now());
  }

  // ── What a day dealt ───────────────────────────────────────────────────────

  /**
   * The three puzzle ids a day is pinned to, or null when nobody has asked for
   * that day yet.
   *
   * A day is all three tiers or it is nothing. A partial day would deal one
   * tier out of history and two out of whatever the pool holds now, which is
   * precisely the half-rewritten day this table exists to make impossible — so
   * a partial day reads as unpinned and {@link pinDay} fills the gaps, leaving
   * the tier already on file exactly where it was.
   */
  pinnedDay(day: number): Record<DailyTier, number> | null {
    const rows = this.db
      .query<{ tier: string; puzzle_id: number }, [number]>(
        "SELECT tier, puzzle_id FROM day_puzzles WHERE day = ?1",
      )
      .all(day);
    const ids: Partial<Record<DailyTier, number>> = {};
    for (const row of rows) {
      if (DAILY_TIERS.includes(row.tier as DailyTier)) ids[row.tier as DailyTier] = row.puzzle_id;
    }
    if (!DAILY_TIERS.every((tier) => ids[tier] !== undefined)) return null;
    return ids as Record<DailyTier, number>;
  }

  /**
   * Pins a day's three, and answers with what is on file afterwards.
   *
   * `INSERT OR IGNORE` and a read-back, rather than writing and returning the
   * argument: two requests can reach an unpinned day in the same millisecond,
   * and the first writer has to win for both of them. Handing back what the
   * caller offered would let two players be told different puzzles for the same
   * day — the one failure this whole table exists to rule out.
   */
  pinDay(day: number, ids: Readonly<Record<DailyTier, number>>): Record<DailyTier, number> {
    this.db.transaction(() => this.insertDay(day, ids))();
    const pinned = this.pinnedDay(day);
    if (!pinned) throw new Error(`Day ${day} was not on file immediately after being pinned`);
    return pinned;
  }

  /**
   * The pool a day's rushes are drawn from, or null when no ticket has been
   * minted for that day yet.
   *
   * Parsed defensively even though this process wrote it. A JSON column is a
   * blob to SQLite, so nothing but this checks it, and a pool that came back
   * holding a string or a null would not fail — it would reach `rushSequence`,
   * deal an undefined puzzle, and score a run against it.
   */
  pinnedRushPool(day: number): PinnedRushPool | null {
    const row = this.db
      .query<{ puzzle_ids: string; bands: string | null }, [number]>(
        "SELECT puzzle_ids, bands FROM day_rush WHERE day = ?1",
      )
      .get(day);
    if (!row) return null;
    const ids = numberList(row.puzzle_ids, `Day ${day}'s pinned rush pool`);
    if (row.bands === null) return { ids, difficulties: null };
    const difficulties = numberList(row.bands, `Day ${day}'s pinned rush bands`);
    // A length mismatch means the two columns describe different pools, and
    // there is no way to tell which is right. Falling back is the honest answer
    // — the ids are still the membership, and the bands are refused whole
    // rather than lined up against the wrong ids.
    if (difficulties.length !== ids.length) return { ids, difficulties: null };
    return { ids, difficulties };
  }

  /** Pins a day's rush pool, and answers with what is on file afterwards. */
  pinRushPool(day: number, pool: readonly PinnedMember[]): PinnedRushPool {
    if (pool.length === 0) throw new Error(`Refusing to pin day ${day} to an empty rush pool`);
    // Same race, same answer as {@link pinDay}: the first ticket of the day
    // decides the pool, and everybody else reads that decision back.
    this.db
      .query<unknown, [number, string, string]>(
        "INSERT OR IGNORE INTO day_rush (day, puzzle_ids, bands) VALUES (?1, ?2, ?3)",
      )
      .run(
        day,
        JSON.stringify(pool.map((member) => member.id)),
        JSON.stringify(pool.map((member) => member.difficulty)),
      );
    const pinned = this.pinnedRushPool(day);
    if (!pinned) throw new Error(`Day ${day}'s rush pool was not on file immediately after pinning`);
    return pinned;
  }

  // ── Player submissions ─────────────────────────────────────────────────────
  //
  // Thin on purpose: the SQL and the row mapping are in server/submissions.ts,
  // because this file is already long enough that one more table's worth of
  // queries would stop being findable in it. What stays here is the surface —
  // a caller asks a `Store` for a submission the same way it asks for a run.

  /**
   * Files a puzzle a player wrote, with the server's own reading of their solve.
   *
   * `upsertPlayer` first, the way {@link recordRun} and {@link savePreferences}
   * do it: `submissions.player_id` references `players(id)` and foreign keys
   * are on, so a first-time author has no row for this one to point at yet.
   */
  recordSubmission(draft: SubmissionDraft): Submission {
    this.upsertPlayer(draft.player);
    return insertSubmission(this.db, draft);
  }

  /** Everything still waiting for an officer, oldest first. */
  pendingSubmissions(limit?: number): Submission[] {
    return readPendingSubmissions(this.db, limit);
  }

  submission(id: number): Submission | null {
    return readSubmission(this.db, id);
  }

  /** How many puzzles one player has waiting. The submit route's quota. */
  pendingSubmissionCount(playerId: string): number {
    return countPendingSubmissions(this.db, playerId);
  }

  /**
   * Takes a puzzle into the archive, allocating its community id as it goes.
   *
   * Two methods rather than one `decideSubmission(id, decision)`, because the
   * generic shape would have to take a `puzzleId` from its caller — and an id
   * chosen outside this transaction is an id a second officer clicking Accept
   * in the same moment can be handed too. A signature nobody can misuse beats a
   * comment asking them not to.
   */
  acceptSubmission(id: number, accept: Acceptance): Decided {
    return acceptSubmission(this.db, id, accept);
  }

  /** Turns one down. Both decided states are terminal. */
  rejectSubmission(id: number, reject: Rejection): Decided {
    return rejectSubmission(this.db, id, reject);
  }

  /**
   * Every accepted puzzle, as the archive loads them.
   *
   * Answerable on a store that has only just been opened, which is what lets
   * `server/index.ts` build the archive out of this file *and* hand the
   * archive's derivation back for {@link pinPastDays}. See that method for the
   * order those three steps have to happen in.
   */
  acceptedPuzzles(): Puzzle[] {
    return readAcceptedPuzzles(this.db);
  }

  /** Whether an id names an accepted puzzle, without reading the puzzle. */
  hasAcceptedPuzzle(puzzleId: number): boolean {
    return isAcceptedPuzzleId(this.db, puzzleId);
  }

  // ── Corrections to a puzzle's metadata ─────────────────────────────────────
  //
  // Thin for the same reason the block above is: the SQL and the row mapping
  // are in server/puzzle-overrides.ts, and a caller asks a `Store` for a
  // correction the same way it asks for a run.

  /**
   * Every correction on file, for `PuzzleArchive.load` to lay over both
   * sources.
   *
   * Answerable on a store that has only just been opened, which is what lets
   * `server/index.ts` build the archive out of this database.
   */
  overridesFor(): PuzzleOverride[] {
    return readOverrides(this.db);
  }

  /**
   * Records a correction, and answers with the row now on file — or null when
   * the change cleared the last field and the row went with it.
   *
   * Nothing here checks the values. The rules are the PATCH route's, where a
   * bad one is a 400 to the officer rather than a row the archive has to be
   * defensive about; and nothing here knows what a puzzle is, so a store that
   * validated would need an archive to validate against. See
   * `PATCH /api/review/puzzles/:id` and `overrideProblem`.
   */
  setOverride(
    puzzleId: number,
    fields: OverrideChanges,
    updatedBy: string,
  ): PuzzleOverride | null {
    return writeOverride(this.db, puzzleId, fields, updatedBy);
  }

  /** Every correction ever made to one puzzle, oldest first. */
  overrideHistory(puzzleId: number): OverrideLogEntry[] {
    return overrideHistory(this.db, puzzleId);
  }

  /** Reverts a puzzle to its source. @returns whether there was one to revert. */
  clearOverride(puzzleId: number, revertedBy: string): boolean {
    return deleteOverride(this.db, puzzleId, revertedBy);
  }
}
