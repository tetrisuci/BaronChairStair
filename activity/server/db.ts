/**
 * Persistence. SQLite because the whole game is one row per player per day, and
 * a file that can be copied is worth more here than a database server.
 */

import { Database } from "bun:sqlite";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";
import type { ClearName, Puzzle, SolutionStep } from "../shared/puzzle";
import type { Handling } from "../shared/tetris/handling";
import type { InputEvent } from "../shared/tetris/verify";
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

/** A day's board row: one player, and how each tier went for them. */
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
  extreme: number;
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

/**
 * The archive table, on its own so `tools/sync-archive.ts` can create it without
 * constructing a `Store`.
 *
 * That matters for the reason `tools/review-link.ts` gives: constructing a Store
 * runs the whole SCHEMA plus the `addSlotsToRuns` DROP/copy/rename rebuild, and a
 * one-off command that can take the server's database down is not a one-off
 * command. The sync needs exactly this one table and nothing else.
 */
export const ARCHIVE_SCHEMA = `
-- The club's puzzle archive, synced from the Google Sheet by
-- tools/sync-archive.ts. Queries live in server/archive-rows.ts, which says
-- why a row is not playable the moment it is written.
--
-- Everything here is DERIVED from the two blueprint codes in source_puzzle and
-- source_solution, by the same decode-and-replay the build script runs. In
-- particular target_attack is what the author's answer actually sends when
-- replayed through the real engine, never a number off the spreadsheet: a
-- puzzle with no verified target is one nobody can be scored against.
--
-- A synced row is NOT playable until published_at is set. The boot read filters
-- on it in SQL rather than after loading, because PuzzleArchive.load runs at
-- module scope and throws -- one malformed unpublished row reaching it takes
-- the server down for every player, with no route left to fix it from.
CREATE TABLE IF NOT EXISTS archive_puzzles (
  -- The sheet's own id. Constrained below the community band because that band
  -- is the only record of where a puzzle came from: toListing reads
  -- \`id >= COMMUNITY_ID_BASE\` to decide whether to show a puzzle as the
  -- club's or a player's, and PuzzleArchive throws at boot if the two collide.
  id               INTEGER PRIMARY KEY CHECK (id > 0 AND id < 100000),
  title            TEXT NOT NULL,
  author           TEXT NOT NULL,
  difficulty       REAL NOT NULL,
  goal             TEXT NOT NULL,
  set_name         TEXT,
  board            TEXT NOT NULL,   -- JSON RowCode[]
  queue            TEXT NOT NULL,   -- JSON Mino[]
  hold             TEXT,
  target_attack    INTEGER NOT NULL CHECK (target_attack > 0),
  solution         TEXT NOT NULL,   -- JSON SolutionStep[]
  -- JSON ClearRequirement[], or NULL. Re-derived from the answer on every
  -- upsert: see \`upsertArchive\`, which writes it unconditionally and treats a
  -- change in it as reason enough to update an otherwise unchanged row.
  -- This comment used to say the opposite, and it was describing a scheme that
  -- went away when the requirement became a pure function of the replayed
  -- solution. Carrying an old value over a new answer is the "demands a clear
  -- its own solution never makes" state that \`withoutUnmeetableClears\` blanks
  -- at load. A metadata correction still leaves it alone; only the answer moves it.
  required_clears  TEXT,
  source_puzzle    TEXT NOT NULL,
  source_solution  TEXT NOT NULL,
  -- Archive bookkeeping the club keeps on the sheet and the game does not use:
  -- when a puzzle was added, and how many people the club has recorded solving
  -- it. They are here because the website shows both, and a data layer that
  -- makes a downstream project keep its own copy of two columns is not one.
  -- Deliberately NOT on the \`Puzzle\` type: nothing about playing a puzzle
  -- depends on them.
  added_on         TEXT,
  solve_count      INTEGER,
  -- Fingerprint of the fields that decide how the puzzle PLAYS -- board, queue,
  -- hold, target and answer. Sheet ids are reused: a row can keep its number
  -- while becoming a different puzzle underneath, which has already happened
  -- to #8. runs and day_puzzles reference a puzzle by id and store no copy of
  -- what was played, so this column is the only way a re-sync can notice that
  -- a published puzzle's content moved.
  content_hash     TEXT NOT NULL,
  synced_at        INTEGER NOT NULL,
  -- NULL until an officer publishes it. Timestamp and name rather than a
  -- boolean, to match reviewed_at/reviewed_by and updated_by elsewhere: every
  -- other decision in this database records who made it.
  published_at     INTEGER,
  published_by     TEXT
);

-- The boot read: what players may be served, in id order.
CREATE INDEX IF NOT EXISTS archive_published
  ON archive_puzzles (published_at) WHERE published_at IS NOT NULL;

-- Every content change ever made to a puzzle, append-only.
--
-- A creator may go back and edit their own puzzle, so \`archive_puzzles\` is
-- rewritten in place -- and the row it overwrites is the only record of what
-- the puzzle used to be. \`runs\` and \`day_puzzles\` reference a puzzle by id and
-- keep no copy of the board, so once the UPDATE lands nothing in this database
-- can say what a finished score was played on.
--
-- Same reasoning as \`puzzle_override_log\`, which is append-only because the
-- current-state row cannot be its own history: the write being recorded is the
-- write that destroys it. And like that table this stores VALUES, not
-- fingerprints -- an eight-character hash proves that something changed and
-- tells nobody what it was.
--
-- Only content changes are logged. Metadata corrections are not: a fixed title
-- does not make an old score unreadable, and \`puzzle_override_log\` already
-- covers officer edits to those fields.
--
-- Changes to an unpublished puzzle are logged too, and marked \`was_published\`
-- 0. Nobody can have played those, so they cost nothing to lose -- but a
-- creator iterating before publication is exactly who wants the history, and a
-- log with a hole in it is harder to trust than one without.
CREATE TABLE IF NOT EXISTS archive_content_log (
  entry_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  puzzle_id     INTEGER NOT NULL,
  was_hash      TEXT NOT NULL,
  became_hash   TEXT NOT NULL,
  was_board     TEXT NOT NULL,   -- JSON RowCode[]
  was_queue     TEXT NOT NULL,   -- JSON Mino[]
  was_hold      TEXT,
  was_target    INTEGER NOT NULL,
  was_solution  TEXT NOT NULL,   -- JSON SolutionStep[]
  -- The frozen clear requirement as it stood, whether or not it was carried
  -- forward. If it was dropped because the new answer no longer meets it, this
  -- is the only place the old decision survives.
  was_clears    TEXT,
  -- Whether the puzzle was playable when this happened, and how much play it
  -- had already had. Both are unrecoverable after the fact: published_at is
  -- overwritten by nothing, but the run count moves every day.
  was_published INTEGER NOT NULL,
  runs_before   INTEGER,
  -- Discovered alternate solutions deleted because of this change. They are
  -- keyed by placements and not by board (see shared/solution-key.ts), so
  -- nothing about them would have noticed the board moving underneath: they
  -- would have stayed on file as \`known\` lines for a puzzle they may not even
  -- be playable on, and the next player to genuinely find one on the new board
  -- would have been refused credit as a duplicate. NULL when this database has
  -- no \`puzzle_solutions\` table to void from.
  solutions_voided INTEGER,
  at            INTEGER NOT NULL,
  by            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_content_log_puzzle
  ON archive_content_log (puzzle_id, entry_id);
`;

/**
 * Brings the archive tables up to date on an existing database.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table untouched, so a
 * database that got `archive_content_log` before a column existed never gains
 * it — the same trap {@link Store.addMissingColumn} exists for. This is that
 * idiom for the two tables `tools/sync-archive.ts` creates, which cannot use
 * the Store's version because it deliberately never constructs one.
 *
 * Run this rather than {@link ARCHIVE_SCHEMA} directly.
 */
/**
 * Adds a column to a table that may already exist, from outside a `Store`.
 *
 * `Store.addMissingColumn` is a method and the archive tools have no Store —
 * they open the database bare. Same rule, same reason: `CREATE TABLE IF NOT
 * EXISTS` does nothing to a table that is already there.
 */
function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  // The table itself may not be there. `migrateArchive` runs against databases
  // that hold only the archive — `tools/sync-archive.ts` builds one from
  // nothing — and `PRAGMA table_info` on a missing table answers with an empty
  // list, which reads exactly like "the column is missing" and then throws on
  // the ALTER. `countDiscoveries` already asks this same question before it
  // counts, and for the same reason.
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (columns.length === 0) return;
  if (!columns.some((row) => row.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function migrateArchive(db: Database): void {
  // `countDiscoveries` and `voidDiscoveries` read and write `voided_at`, and
  // the archive tools reach them through this function rather than through a
  // `Store` — `tools/sync-archive.ts` opens the database bare. Without this the
  // column exists only for a process that happened to construct a Store, and a
  // sync against a deployed database throws "no such column".
  addColumnIfMissing(db, "puzzle_solutions", "voided_at", "INTEGER");
  db.run(ARCHIVE_SCHEMA);
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(archive_content_log)")
    .all()
    .map((row) => row.name);
  // Deliberately no backfill. A change logged before this column existed
  // deleted nothing, because nothing deleted discoveries then; NULL is also
  // what "this database has no puzzle_solutions" means, and both readings lead
  // to the same honest answer -- nobody recorded a count.
  if (columns.length > 0 && !columns.includes("solutions_voided")) {
    db.run("ALTER TABLE archive_content_log ADD COLUMN solutions_voided INTEGER");
  }

  const puzzleColumns = db
    .query<{ name: string }, []>("PRAGMA table_info(archive_puzzles)")
    .all()
    .map((row) => row.name);
  // Same trap, same fix: a database that got archive_puzzles before these
  // existed never gains them from CREATE TABLE IF NOT EXISTS. No backfill —
  // the next sync fills them from the sheet, and NULL until then is the honest
  // answer rather than a guess.
  for (const [name, type] of [["added_on", "TEXT"], ["solve_count", "INTEGER"]] as const) {
    if (puzzleColumns.length > 0 && !puzzleColumns.includes(name)) {
      db.run(`ALTER TABLE archive_puzzles ADD COLUMN ${name} ${type}`);
    }
  }
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
  -- Which of the day's puzzles this run is. 'legacy' marks a row filed
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

/*
 * Which puzzles a player has ever solved, however they solved them.
 *
 * \`runs\` cannot answer this and was never meant to. It is keyed
 * \`(day, player_id, slot)\` — one row per tier per day — so it knows what
 * happened on a *day*, and a player who solves the same puzzle again next month
 * in practice overwrites nothing and adds nothing. Practice never reached the
 * server at all.
 *
 * This is the other question: has this person, ever, solved this board. It is
 * what unlocks a puzzle's solutions gallery and what the Explore list ticks.
 *
 * \`first_at\` rather than a single timestamp because "when did you first get
 * this" is the interesting fact and re-solving must not overwrite it.
 * \`best_ms\` is the fastest solve on record, which is the number a profile
 * wants; it is not a leaderboard and never sorted across players.
 */
CREATE TABLE IF NOT EXISTS puzzle_clears (
  player_id TEXT    NOT NULL REFERENCES players(id),
  puzzle_id INTEGER NOT NULL,
  first_at  INTEGER NOT NULL,
  last_at   INTEGER NOT NULL,
  times     INTEGER NOT NULL,
  best_ms   INTEGER NOT NULL,
  PRIMARY KEY (player_id, puzzle_id)
);

-- Every read is "everything this player has cleared", for the Explore ticks and
-- the profile. The primary key already leads on player_id, so no second index.

CREATE INDEX IF NOT EXISTS rush_by_day ON rush_runs (day, guild_id);
-- The all-time board asks a different question to the daily one: every run a
-- player has ever filed, best first, rather than one day across everybody.
CREATE INDEX IF NOT EXISTS rush_records ON rush_runs (player_id, solved DESC, time_to_last_ms ASC);

CREATE TABLE IF NOT EXISTS preferences (
  player_id  TEXT PRIMARY KEY REFERENCES players(id),
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Which puzzles a day dealt, written down the first time the day is
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
-- Every distinct way a puzzle has been solved, and who got there first.
--
-- A table and not a field on the puzzle, for the reason puzzle_overrides gives:
-- data/puzzles.json is rewritten wholesale by \`bun run puzzles\`, so anything
-- written there dies at the next rebuild. "Saved to the puzzle database" has to
-- mean a row.
--
-- \`canonical_key\` is the fingerprint from shared/solution-key.ts, stored raw.
-- The UNIQUE index on (puzzle_id, canonical_key) IS the deduplication: the first
-- writer of a line takes it and every later writer of the same line conflicts,
-- which is how "the same alternate is not counted twice" is enforced by the
-- database rather than by a check somebody can forget.
--
-- \`events\` and \`handling\` are here so a stored line can be re-verified through
-- \`verifyRun\` — the same path the server already trusts — rather than through
-- \`replayPlacements\`, which cannot express every legal tuck and would reject
-- precisely the cleverest discoveries. That costs about 8 KB a row against 800
-- bytes for the placements alone; it is the price of being able to prove later
-- that a recorded discovery was real.
--
-- \`solved_strict\` is whether the line met the puzzle's required clears, stored
-- rather than derived because \`requiredClears\` can be corrected by an officer
-- and a row must keep saying what was true when it was filed.
CREATE TABLE IF NOT EXISTS puzzle_solutions (
  solution_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  puzzle_id     INTEGER NOT NULL,
  canonical_key TEXT    NOT NULL,
  key_version   INTEGER NOT NULL,
  placements    TEXT    NOT NULL,   -- JSON SolutionStep[]
  events        TEXT,               -- JSON InputEvent[]; NULL for enumerated lines
  handling      TEXT,               -- JSON Handling; NULL for enumerated lines
  attack        INTEGER NOT NULL,
  -- What the puzzle asked for when this was filed. Nullable only because rows
  -- written before the column exist; every new row carries it.
  target_attack INTEGER,
  clears        TEXT    NOT NULL,   -- JSON ClearName[]
  solved_strict INTEGER NOT NULL,
  -- 'reference' (the archive's own answer), 'enumerated' (found by the batch
  -- search, credited to nobody), or 'player'.
  source        TEXT    NOT NULL,
  found_by      TEXT,               -- players.id, NULL unless source = 'player'
  guild_id      TEXT,
  found_at      INTEGER NOT NULL,
  -- When the board this line was played on stopped being that board, or NULL
  -- while it still is. A content edit *voids* a puzzle's lines rather than
  -- deleting them: the claim "these placements solve this position" dies with
  -- the position, but the fact that somebody once found it does not, and the
  -- discovery board is paid on the finding. See \`voidDiscoveries\`.
  voided_at     INTEGER
);

-- The leaderboard reads by finder; the maker view reads by puzzle.
CREATE INDEX IF NOT EXISTS puzzle_solutions_finder ON puzzle_solutions (found_by);
CREATE INDEX IF NOT EXISTS puzzle_solutions_puzzle ON puzzle_solutions (puzzle_id);
-- The dedup index is *not* here: it is partial over \`voided_at IS NULL\`, and
-- this runs against databases that do not have that column yet. It is created
-- in the constructor, straight after the column is added.

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

${ARCHIVE_SCHEMA}

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
/** Where a recorded solution came from. Only `player` earns a discovery. */
export type SolutionSource = "reference" | "enumerated" | "player";

/** A solution about to be filed. */
export interface NewSolution {
  readonly puzzleId: number;
  readonly canonicalKey: string;
  readonly keyVersion: number;
  readonly placements: readonly SolutionStep[];
  /** The log, so the line can be re-verified. Null for an enumerated line. */
  readonly events: readonly InputEvent[] | null;
  readonly handling: Handling | null;
  readonly attack: number;
  /**
   * The bar the puzzle set when this line was filed.
   *
   * Stored rather than looked up, for the reason `runs.target_attack` is: a
   * puzzle's target moves when an officer edits it, and "did this line send
   * more than was asked" is a question about what was asked *then*. It is the
   * second half of {@link countsAsAlternate}, which is what the board pays on.
   */
  readonly targetAttack: number;
  readonly clears: readonly ClearName[];
  /** Whether it met the puzzle's required clears when it was filed. */
  readonly solvedStrict: boolean;
  readonly source: SolutionSource;
  readonly foundBy: string | null;
  readonly guildId: string | null;
}

/** A solution on record, without the log — which no reader needs by default. */
export interface StoredSolution {
  readonly solutionId: number;
  readonly puzzleId: number;
  readonly canonicalKey: string;
  readonly keyVersion: number;
  readonly placements: readonly SolutionStep[];
  readonly attack: number;
  readonly clears: readonly ClearName[];
  readonly solvedStrict: boolean;
  readonly source: SolutionSource;
  readonly foundBy: string | null;
  readonly foundAt: number;
}

interface StoredSolutionRow {
  solution_id: number;
  puzzle_id: number;
  canonical_key: string;
  key_version: number;
  placements: string;
  attack: number;
  clears: string;
  solved_strict: number;
  source: string;
  found_by: string | null;
  found_at: number;
}

function toStoredSolution(row: StoredSolutionRow): StoredSolution {
  return {
    solutionId: row.solution_id,
    puzzleId: row.puzzle_id,
    canonicalKey: row.canonical_key,
    keyVersion: row.key_version,
    placements: JSON.parse(row.placements) as SolutionStep[],
    attack: row.attack,
    clears: JSON.parse(row.clears) as ClearName[],
    solvedStrict: row.solved_strict === 1,
    source: row.source as SolutionSource,
    foundBy: row.found_by,
    foundAt: row.found_at,
  };
}

/**
 * One line in a puzzle's solutions gallery: a way somebody solved it.
 *
 * Carries the placements, because the whole point is stepping it on the board.
 * It does **not** carry the input log — that is 8 KB a row, it is only there so
 * a discovery can be re-proved later, and nothing on the front end replays
 * keystrokes.
 */
export interface GalleryLine {
  readonly solutionId: number;
  readonly placements: readonly SolutionStep[];
  readonly attack: number;
  readonly clears: readonly ClearName[];
  /** 'reference' is the maker's own answer; 'player' is somebody's find. */
  readonly source: SolutionSource;
  /** Who found it. Null for the maker's answer, which belongs to nobody. */
  readonly finder: PlayerProfile | null;
  readonly foundAt: number;
  /** Whether it met the clears the goal names, as judged when it was filed. */
  readonly solvedStrict: boolean;
}

/** One line of the discovery board. */
export interface DiscoveryRow {
  readonly player: PlayerProfile;
  readonly found: number;
  readonly latestAt: number;
}

/** How a puzzle is holding up: distinct lines, and how many miss its goal. */
export interface SolutionCount {
  readonly puzzleId: number;
  readonly total: number;
  readonly missingGoal: number;
}

export interface PastDays {
  /** The last day that has been dealt. Everything up to it is history. */
  readonly throughDay: number;
  /** The ids a day held, derived the way the code has always derived them. */
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

/**
 * What a row has to be for its finder to be paid for it, as one clause.
 *
 * Written once because the board and a player's own standing must agree
 * exactly: a rank counted under a different predicate from the board it is a
 * rank *in* is not wrong in some rare case, it is wrong whenever they differ.
 * Every query using it aliases `puzzle_solutions` as `s`.
 *
 * The last clause is `countsAsAlternate` in SQL — solved it, *or* sent more
 * attack than it was asked for. `tests/alternate-solution.test.ts` runs the
 * function and this string against one table of cases, because a board cannot
 * call the function per row and two spellings of one rule drift.
 *
 * `attack > target_attack` is NULL, and so false, on a row filed before that
 * column existed. Those fall back to the solve, which is what they were
 * credited on when they were written — the honest answer rather than a
 * backfilled guess at a target that may since have moved.
 *
 * Note what is absent: `voided_at`. Credit outlives the board it was earned on
 * — see the column.
 */
const CREDITED =
  "s.source = 'player' AND s.found_by IS NOT NULL " +
  "AND (s.solved_strict = 1 OR s.attack > s.target_attack)";

/** The live rows: the ones still describing a board that exists. */
const LIVE = "voided_at IS NULL";

/**
 * The streak a player is on now, walking back from `today`.
 *
 * `days` arrives newest-first and already distinct. The rule is `Store.streak`'s
 * and is copied rather than shared because that one answers for a single player
 * over a `LIMIT 400` query and this one reduces every player at once — but the
 * *rule* must not differ, so it is written out here in the same shape.
 */
function currentStreak(days: readonly number[], today: number): number {
  let streak = 0;
  let expected = today;
  for (const day of days) {
    if (day === expected) {
      streak++;
      expected--;
    } else if (day === expected - 1 && streak === 0) {
      // Today not yet played does not break a streak; a missed day does.
      streak++;
      expected = day - 1;
    } else {
      break;
    }
  }
  return streak;
}

/** The longest run of consecutive days they ever put together. */
function bestStreak(days: readonly number[]): number {
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  // Newest-first, so consecutive means each day is one less than the last.
  for (const day of days) {
    run = previous !== null && day === previous - 1 ? run + 1 : 1;
    previous = day;
    if (run > best) best = run;
  }
  return best;
}

export class Store {
  private readonly db: Database;

  /**
   * The handle, for the read-only archive queries in `server/archive-rows.ts`.
   *
   * Deliberately narrow in intent rather than in type: SQLite has no read-only
   * connection to hand out, so what stops this becoming a second write path is
   * that only `registerPublicRoutes` is given it, and that module imports
   * nothing that can write. Everything else still goes through a method on this
   * class, where the transaction and the invariant live together.
   */
  get archiveReader(): Database {
    return this.db;
  }

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
    migrateArchive(this.db);
    // Before anything else touches `runs`: a database written when a day held
    // one puzzle has the wrong primary key, and no amount of ADD COLUMN fixes
    // that.
    this.addSlotsToRuns();
    // After the rebuild, never in SCHEMA: it names `slot`, and SCHEMA runs
    // against a database that may not have that column yet.
    //
    // A board is one day, one guild, one tier, ordered. Without the slot and
    // the sort columns every per-tier board walks the whole day and rebuilds the
    // same sort — measured at 281us for three of them, 83us with it, before a
    // fourth tier existed to make the gap wider.
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
    this.addMissingColumn(
      "puzzle_solutions",
      "target_attack",
      "INTEGER",
      // Deliberately no backfill. The value wanted is the target the puzzle set
      // on the day the line was filed, and this process cannot know it — the
      // archive holds today's, which an officer may have moved since. NULL
      // means "not recorded", and `CREDITED` reads that as the row standing on
      // its solve alone, which is what it was credited on when it was written.
    );
    this.addMissingColumn(
      "puzzle_solutions",
      "voided_at",
      "INTEGER",
      // Deliberately no backfill. Every row that exists when this column
      // arrives is a live claim about the board its puzzle currently has —
      // `voidDiscoveries` used to delete the ones that were not, so there is no
      // population of already-dead rows to find. NULL is the truth for all of
      // them.
    );
    // After the column, and in this order. Both statements are no-ops on a
    // database that has already run them.
    //
    // The old index covered every row, which is what made deletion the only
    // possible way to void: a kept row went on holding its key, so the next
    // player to genuinely find that line on the *new* board was refused as a
    // duplicate. Partial over the live rows, a voided row keeps its credit and
    // stops standing in anyone's way.
    this.db.run("DROP INDEX IF EXISTS puzzle_solutions_key");
    this.db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS puzzle_solutions_live_key
         ON puzzle_solutions (puzzle_id, canonical_key) WHERE voided_at IS NULL`,
    );
    // Every daily solve already on file becomes a clear. Practice cannot be
    // recovered — it never reached the server — so a player's count starts at
    // whatever their dailies earned them, which is the honest floor rather than
    // a guess.
    this.backfillClears();
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
   * Runs from before the archive held more than one a day carry the legacy slot, which
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
   * One day's rows, whichever of them are still missing.
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
   * Gives `runs` a slot, and a primary key that admits one per tier a day.
   *
   * `PRIMARY KEY (day, player_id)` was the rule "one run per player per day",
   * and it was enforced by the key itself rather than by any code. SQLite
   * cannot alter a primary key, so this is the documented rebuild: new table,
   * copy, drop, rename. `addMissingColumn` cannot do it — a slot column added
   * to the old table would leave the old key in place, and the second puzzle of
   * a day would still be swallowed by the conflict clause.
   *
   * Existing rows become 'legacy' rather than being guessed into a tier. They
   * were filed against a day's single puzzle, which is not one of the puzzles
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
  /**
   * Files a solution, and answers whether it was new.
   *
   * The UNIQUE index does the deduplication, in one statement. `ON CONFLICT DO
   * NOTHING` plus `changes` is the whole novelty check: two players submitting
   * the same line in the same instant both reach the insert, exactly one gets
   * `changes === 1`, and the loser is told it is already known rather than
   * credited for somebody else's discovery. Written as SELECT-then-INSERT it
   * would be a race, and the race would hand out the credit twice.
   *
   * The `WHERE voided_at IS NULL` repeats the index's own predicate, which is
   * not decoration: SQLite matches an upsert to a *partial* index only when the
   * conflict target carries the same predicate, and without it this statement
   * fails at runtime with "ON CONFLICT clause does not match any PRIMARY KEY or
   * UNIQUE constraint" rather than falling back to something weaker.
   */
  recordSolution(entry: NewSolution): { solutionId: number | null; discovered: boolean } {
    const written = this.db
      .query(
        `INSERT INTO puzzle_solutions
           (puzzle_id, canonical_key, key_version, placements, events, handling,
            attack, target_attack, clears, solved_strict, source, found_by, guild_id, found_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT (puzzle_id, canonical_key) WHERE voided_at IS NULL DO NOTHING`,
      )
      .run(
        entry.puzzleId,
        entry.canonicalKey,
        entry.keyVersion,
        JSON.stringify(entry.placements),
        entry.events === null ? null : JSON.stringify(entry.events),
        entry.handling === null ? null : JSON.stringify(entry.handling),
        entry.attack,
        entry.targetAttack,
        JSON.stringify(entry.clears),
        entry.solvedStrict ? 1 : 0,
        entry.source,
        entry.foundBy,
        entry.guildId,
        Date.now(),
      );
    return {
      solutionId: written.changes > 0 ? Number(written.lastInsertRowid) : null,
      discovered: written.changes > 0,
    };
  }

  /**
   * Who has found the most alternate lines, best first. **One board, for
   * everybody.**
   *
   * The only board here that is not a guild's. Every other one answers "how did
   * this club do today", which is a question about a club; this one answers
   * "who has found lines nobody had", which is a question about the archive —
   * and the archive is one archive however many servers play it. Scoped per
   * guild it also read as a lie the moment somebody played the same puzzle in
   * two servers: `guild_id` records where a line was *filed*, so the same
   * player's own finds were split across boards that each showed a fraction of
   * their total.
   *
   * What counts, and what does not:
   *
   * - only `source = 'player'`. The archive's own answers and everything the
   *   batch enumerator turns up belong to nobody.
   * - only lines that count as alternate solutions: they solved the puzzle, or
   *   they sent more attack than it asked for. A line that merely *reaches* the
   *   target while missing the clears the goal names is evidence for a puzzle
   *   maker, not a point. See `countsAsAlternate`, which `CREDITED` mirrors.
   * - **every distinct line**, including several on one puzzle. The unique
   *   index is the only dedup: find the same line twice and it is one row.
   * - voided rows still pay. A puzzle edited under a player does not take back
   *   what they found — see the column, and {@link voidDiscoveries}.
   *
   * The cost of counting per line rather than per puzzle, stated plainly: a
   * loose puzzle can carry somebody. #123's enforceable condition is
   * `attack >= 2`, and an incomplete search of that four-piece puzzle already
   * turned up 31 distinct lines, so a player who works one of those has a much
   * cheaper route up this board than a player who finds one line each on 31
   * puzzles. That is the trade the board was asked for; the rules above are
   * still what stop it being a measure of who plays most.
   */
  discoveryBoard(limit = 25): DiscoveryRow[] {
    return this.db
      .query<{ id: string; username: string; avatar_url: string | null; found: number; latest: number }, [number]>(
        `SELECT p.id, p.username, p.avatar_url,
                COUNT(*) AS found, MAX(s.found_at) AS latest
           FROM puzzle_solutions s
           JOIN players p ON p.id = s.found_by
          WHERE ${CREDITED}
          GROUP BY p.id
          ORDER BY found DESC, latest ASC
          LIMIT ?1`,
      )
      .all(limit)
      .map((row) => ({
        player: { id: row.id, username: row.username, avatarUrl: row.avatar_url },
        found: row.found,
        latestAt: row.latest,
      }));
  }

  /**
   * The lines one player has found, newest first.
   *
   * Counted under exactly {@link CREDITED} — the same clause the discovery
   * board pays on — because this list sits under the number that board
   * produced. A list that disagrees with the count above it is worse than no
   * list, and this codebase has already been bitten once by a count and its
   * contents drifting apart.
   *
   * `voided_at` comes back rather than being filtered: an edited puzzle does
   * not take back what somebody found, so the row still belongs here — but the
   * line describes a board that no longer exists and cannot be opened, which is
   * a difference the reader has to be told about.
   *
   * The puzzle's title is not here because it is not in this database. The
   * archive is a JSON file the build rewrites wholesale; the route joins them.
   */
  discoveriesBy(playerId: string, limit = 25): {
    puzzleId: number;
    attack: number;
    clears: ClearName[];
    foundAt: number;
    voided: boolean;
  }[] {
    return this.db
      .query<
        { puzzle_id: number; attack: number; clears: string; found_at: number; voided: number },
        [string, number]
      >(
        `SELECT s.puzzle_id, s.attack, s.clears, s.found_at,
                CASE WHEN s.voided_at IS NULL THEN 0 ELSE 1 END AS voided
           FROM puzzle_solutions s
          WHERE ${CREDITED} AND s.found_by = ?1
          ORDER BY s.found_at DESC, s.solution_id DESC
          LIMIT ?2`,
      )
      .all(playerId, limit)
      .map((row) => ({
        puzzleId: row.puzzle_id,
        attack: row.attack,
        clears: JSON.parse(row.clears) as ClearName[],
        foundAt: row.found_at,
        voided: row.voided === 1,
      }));
  }

  /**
   * Where one player stands, whether or not they are on the board.
   *
   * A guild board could be read for your own name; a board of everybody who has
   * ever played cannot, and twenty-five rows of strangers with no line for the
   * person reading them is the shape that makes a leaderboard feel closed. The
   * rank is "how many people are ahead of me" plus one, counted the same way
   * the board orders — so somebody tied with the last visible row reads as tied
   * rather than as one worse.
   *
   * Null when they have found nothing: there is no rank to be had, and a
   * "#391 — 0 lines" is worse than the invitation the empty board already
   * carries.
   */
  discoveryStanding(playerId: string): { rank: number; found: number } | null {
    const mine = this.db
      .query<{ found: number; latest: number }, [string]>(
        `SELECT COUNT(*) AS found, MAX(found_at) AS latest
           FROM puzzle_solutions s
          WHERE ${CREDITED} AND s.found_by = ?1`,
      )
      .get(playerId);
    if (!mine || mine.found === 0) return null;
    // Strictly ahead: more lines, or the same number reached sooner — the
    // board's own `found DESC, latest ASC`.
    const ahead =
      this.db
        .query<{ n: number }, [number, number]>(
          `SELECT COUNT(*) AS n FROM (
             SELECT COUNT(*) AS found, MAX(found_at) AS latest
               FROM puzzle_solutions s
              WHERE ${CREDITED}
              GROUP BY s.found_by
             HAVING found > ?1 OR (found = ?1 AND latest < ?2))`,
        )
        .get(mine.found, mine.latest)?.n ?? 0;
    return { rank: ahead + 1, found: mine.found };
  }

  /**
   * Every distinct line on record for one puzzle. The maker's view.
   *
   * Live rows only. A maker reads these to answer "is my clear requirement too
   * loose", and a line played on a board that has since been edited answers
   * that question about a board they are no longer looking at.
   */
  solutionsFor(puzzleId: number): StoredSolution[] {
    return this.db
      .query<StoredSolutionRow, [number]>(
        `SELECT solution_id, puzzle_id, canonical_key, key_version, placements, attack,
                clears, solved_strict, source, found_by, found_at
           FROM puzzle_solutions WHERE puzzle_id = ?1 AND ${LIVE} ORDER BY found_at ASC`,
      )
      .all(puzzleId)
      .map(toStoredSolution);
  }

  /**
   * How many distinct lines one puzzle has on record.
   *
   * Separate from {@link solutionsFor} because this one is asked on the run
   * submit path, once per solved run, and the rows it would otherwise count
   * carry an input log apiece — roughly 8 KB each, read and parsed to arrive at
   * a number the index already knows.
   */
  /**
   * Drops any `reference` row for this puzzle whose key is not `keep`.
   *
   * A puzzle has exactly one intended answer, so it has exactly one reference
   * row. `voidDiscoveries` clears a puzzle's rows on a content edit, but only
   * once it has been published — an unpublished edit deliberately leaves them
   * alone, and the next boot would otherwise seed the new answer beside the old
   * one. Two reference rows inflate `countSolutions`, which is the number a
   * player is shown as "N distinct lines".
   *
   * Scoped to `reference`: a *player's* line on the old board was still a real
   * line somebody played, and deciding its fate is `voidDiscoveries`' job, not
   * this one's.
   */
  dropStaleReferences(puzzleId: number, keep: string): number {
    return this.db
      .query(
        `DELETE FROM puzzle_solutions
          WHERE puzzle_id = ?1 AND source = 'reference' AND canonical_key <> ?2`,
      )
      .run(puzzleId, keep).changes;
  }

  countSolutions(puzzleId: number): number {
    return (
      this.db
        .query<{ n: number }, [number]>(
          `SELECT COUNT(*) AS n FROM puzzle_solutions WHERE puzzle_id = ?1 AND ${LIVE}`,
        )
        .get(puzzleId)?.n ?? 0
    );
  }

  /**
   * Turns the daily runs already on file into clears, once.
   *
   * `runs` is keyed by day, so a player who solved the same puzzle on two days
   * has two rows and wants one clear — hence the `GROUP BY`. `total_ms` is zero
   * on rows written before that column existed, and `NULLIF` keeps those out of
   * the minimum rather than letting them win it; a puzzle whose every row is
   * legacy comes through with `best_ms = 0`, which the profile already reads as
   * "no time recorded".
   *
   * `INSERT OR IGNORE` and no update clause, so this is a no-op on every boot
   * after the first and can never overwrite a `first_at` a real solve improved.
   */
  private backfillClears(): void {
    this.db.run(
      `INSERT OR IGNORE INTO puzzle_clears (player_id, puzzle_id, first_at, last_at, times, best_ms)
       SELECT player_id, puzzle_id, MIN(created_at), MAX(created_at), COUNT(*),
              COALESCE(MIN(NULLIF(total_ms, 0)), 0)
         FROM runs
        WHERE solved = 1
        GROUP BY player_id, puzzle_id`,
    );
  }

  /**
   * Records that a player solved a puzzle. Idempotent by design, not by luck.
   *
   * Called from all three places a solve can happen — the daily submit, each
   * puzzle a rush solved, and a practice run — so it is written far more often
   * than it changes anything. `first_at` survives every re-solve, because "when
   * did you first crack this" is the fact worth keeping and the upsert would
   * otherwise quietly move it every time somebody replayed a favourite.
   *
   * `best_ms` takes the minimum, and a zero is treated as no time at all: a
   * legacy row can carry `total_ms = 0`, and letting that win would put an
   * unbeatable 0:00.0 on a profile forever.
   */
  recordClear(entry: {
    playerId: string;
    puzzleId: number;
    durationMs: number;
    player?: PlayerProfile;
  }): void {
    // `puzzle_clears.player_id` is `NOT NULL REFERENCES players(id)` and foreign
    // keys are on, so a player this box has never written throws — which the
    // rush and the practice route both can, since neither writes a `players`
    // row of its own. Every other write path here upserts first;
    // `recordSubmission` documents the same hazard three methods up.
    if (entry.player) this.upsertPlayer(entry.player);
    const now = Date.now();
    const ms = entry.durationMs > 0 ? entry.durationMs : 0;
    this.db.run(
      `INSERT INTO puzzle_clears (player_id, puzzle_id, first_at, last_at, times, best_ms)
       VALUES (?1, ?2, ?3, ?3, 1, ?4)
       ON CONFLICT (player_id, puzzle_id) DO UPDATE SET
         last_at = excluded.last_at,
         times   = puzzle_clears.times + 1,
         best_ms = CASE
           WHEN puzzle_clears.best_ms = 0 THEN excluded.best_ms
           WHEN excluded.best_ms = 0      THEN puzzle_clears.best_ms
           ELSE MIN(puzzle_clears.best_ms, excluded.best_ms)
         END`,
      [entry.playerId, entry.puzzleId, now, ms],
    );
  }

  /**
   * Who has solved the most of the archive, all time and every server.
   *
   * Global for the same reason the discovery board is: how much of the archive
   * somebody has worked through is a fact about them and the archive, not about
   * whichever server they happened to open it in — and `puzzle_clears` has no
   * guild on it at all, because a solve counts wherever it happened.
   *
   * Ties broken by who got there first. Somebody who reached forty puzzles last
   * month is ahead of somebody who reached forty this morning, which is the
   * only ordering that does not shuffle under people as new players arrive.
   */
  clearsBoard(limit = 25): { player: PlayerProfile; cleared: number; latestAt: number }[] {
    return this.db
      .query<
        { id: string; username: string; avatar_url: string | null; n: number; latest: number },
        [number]
      >(
        `SELECT p.id, p.username, p.avatar_url,
                COUNT(*) AS n, MAX(c.first_at) AS latest
           FROM puzzle_clears c
           JOIN players p ON p.id = c.player_id
          GROUP BY p.id
          ORDER BY n DESC, latest ASC
          LIMIT ?1`,
      )
      .all(limit)
      .map((row) => ({
        player: { id: row.id, username: row.username, avatarUrl: row.avatar_url },
        cleared: row.n,
        latestAt: row.latest,
      }));
  }

  /**
   * One player by id, for a profile opened from somebody else's row.
   *
   * Null rather than a throw for a player this box has never seen: an id can
   * reach here from a stale board on a client that has been open a while, and
   * "no such player" is an answer rather than a fault.
   */
  playerNamed(id: string): PlayerProfile | null {
    const row = this.db
      .query<{ id: string; username: string; avatar_url: string | null }, [string]>(
        "SELECT id, username, avatar_url FROM players WHERE id = ?1",
      )
      .get(id);
    return row ? { id: row.id, username: row.username, avatarUrl: row.avatar_url } : null;
  }

  /** Whether this player has ever solved this puzzle. The gallery's gate. */
  hasCleared(playerId: string, puzzleId: number): boolean {
    return (
      this.db
        .query<{ n: number }, [string, number]>(
          "SELECT COUNT(*) AS n FROM puzzle_clears WHERE player_id = ?1 AND puzzle_id = ?2",
        )
        .get(playerId, puzzleId)?.n === 1
    );
  }

  /**
   * Every puzzle this player has solved. The Explore list's ticks.
   *
   * The whole set in one query rather than a lookup per row: the explorer draws
   * up to 200 rows and the set is at most 138 integers.
   */
  clearedPuzzleIds(playerId: string): Set<number> {
    return new Set(
      this.db
        .query<{ puzzle_id: number }, [string]>(
          "SELECT puzzle_id FROM puzzle_clears WHERE player_id = ?1",
        )
        .all(playerId)
        .map((row) => row.puzzle_id),
    );
  }

  /**
   * What a player has done, for their profile.
   *
   * Deliberately several small aggregates rather than one join: they come from
   * four unrelated tables, and a single query would be a four-way join whose
   * shape nobody could read in order to check it.
   *
   * `secondsPlayed` counts *solved* time only, from `puzzle_clears.best_ms`.
   * Summing every attempt would mean a profile ticked up while somebody left a
   * tab open, which is a number that flatters rather than informs.
   */
  profile(playerId: string): {
    puzzlesCleared: number;
    clearsTotal: number;
    bestMsTotal: number;
    rushSolved: number;
    rushRuns: number;
    bestRush: number;
    discoveries: number;
  } {
    const clears = this.db
      .query<{ n: number; times: number; ms: number }, [string]>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(times), 0) AS times, COALESCE(SUM(best_ms), 0) AS ms
           FROM puzzle_clears WHERE player_id = ?1`,
      )
      .get(playerId);
    const rush = this.db
      .query<{ solved: number; runs: number; best: number }, [string]>(
        `SELECT COALESCE(SUM(solved), 0) AS solved, COUNT(*) AS runs,
                COALESCE(MAX(solved), 0) AS best
           FROM rush_runs WHERE player_id = ?1`,
      )
      .get(playerId);
    const found = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM puzzle_solutions s WHERE ${CREDITED} AND s.found_by = ?1`,
      )
      .get(playerId);

    return {
      puzzlesCleared: clears?.n ?? 0,
      clearsTotal: clears?.times ?? 0,
      bestMsTotal: clears?.ms ?? 0,
      rushSolved: rush?.solved ?? 0,
      rushRuns: rush?.runs ?? 0,
      bestRush: rush?.best ?? 0,
      discoveries: found?.n ?? 0,
    };
  }

  /**
   * Every way this puzzle has been solved that a player could want to look at.
   *
   * The maker's own answer first, then everybody else's oldest-first — the
   * order the gallery reads in, so the front end sorts nothing and cannot grow
   * a second opinion about whose line comes first. Being first to find a line
   * is the thing worth showing, and it never changes afterwards.
   *
   * Live rows only, for the reason {@link solutionsFor} gives: a line played on
   * a board that has since been edited is not a line on the puzzle sitting
   * there now. The finder keeps their credit on the discovery board either way.
   *
   * **Enumerated lines are left out.** They were found by `find-alternates`
   * grinding through the search space, not by a person, and #123 alone has 31
   * of them — a gallery of "what other people came up with" that is mostly a
   * machine's output is not the thing anybody asked to see. They stay in the
   * table, where the maker's tools read them.
   *
   * The input log is deliberately not selected: 8 KB a row, and nothing that
   * draws a board needs it.
   */
  solutionGallery(puzzleId: number): GalleryLine[] {
    return this.db
      .query<
        {
          solution_id: number;
          placements: string;
          attack: number;
          clears: string;
          source: string;
          found_at: number;
          solved_strict: number;
          finder_id: string | null;
          username: string | null;
          avatar_url: string | null;
        },
        [number]
      >(
        `SELECT s.solution_id, s.placements, s.attack, s.clears, s.source, s.found_at,
                s.solved_strict, s.found_by AS finder_id, p.username, p.avatar_url
           FROM puzzle_solutions s
           LEFT JOIN players p ON p.id = s.found_by
          WHERE s.puzzle_id = ?1 AND s.${LIVE} AND s.source IN ('reference', 'player')
          ORDER BY s.source = 'reference' DESC, s.found_at ASC, s.solution_id ASC`,
      )
      .all(puzzleId)
      .map((row) => ({
        solutionId: row.solution_id,
        placements: JSON.parse(row.placements) as SolutionStep[],
        attack: row.attack,
        clears: JSON.parse(row.clears) as ClearName[],
        source: row.source as SolutionSource,
        // A player row whose `players` entry is missing reads as unattributed
        // rather than as a row with a blank name. It cannot happen — the
        // foreign key is the session's own player — but a gallery that renders
        // `undefined` where a name goes is worse than one that says nothing.
        finder:
          row.finder_id !== null && row.username !== null
            ? { id: row.finder_id, username: row.username, avatarUrl: row.avatar_url }
            : null,
        foundAt: row.found_at,
        solvedStrict: row.solved_strict === 1,
      }));
  }

  /**
   * How many lines each puzzle's gallery holds, for the whole archive at once.
   *
   * One query rather than one per row: the explorer draws up to 200 puzzles and
   * asking per row would be 200 round trips through the same table.
   *
   * Counted under exactly {@link solutionGallery}'s predicate, because it is
   * the number printed beside a row that opens that gallery — a count that
   * disagrees with what the gallery then shows is worse than no count.
   */
  galleryCounts(): Map<number, number> {
    return new Map(
      this.db
        .query<{ puzzle_id: number; n: number }, []>(
          `SELECT puzzle_id, COUNT(*) AS n
             FROM puzzle_solutions s
            WHERE s.${LIVE} AND s.source IN ('reference', 'player')
            GROUP BY puzzle_id`,
        )
        .all()
        .map((row) => [row.puzzle_id, row.n] as const),
    );
  }

  /**
   * How many distinct lines each puzzle has, and how many miss its goal.
   *
   * Live rows only, for the reason {@link solutionsFor} gives: this is the
   * count beside a puzzle in the review tool, and a voided line is not a line
   * on the puzzle sitting there now.
   */
  solutionCounts(): SolutionCount[] {
    return this.db
      .query<{ puzzle_id: number; total: number; missing_goal: number }, []>(
        `SELECT puzzle_id, COUNT(*) AS total,
                SUM(CASE WHEN solved_strict = 0 THEN 1 ELSE 0 END) AS missing_goal
           FROM puzzle_solutions WHERE ${LIVE} GROUP BY puzzle_id ORDER BY total DESC`,
      )
      .all()
      .map((row) => ({
        puzzleId: row.puzzle_id,
        total: row.total,
        missingGoal: row.missing_goal,
      }));
  }

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
   * which is none of the ones that day deals now.
   */
  /**
   * Everybody's daily record: solves, days, and both streaks.
   *
   * One query and one pass, rather than three boards each walking `runs` and
   * `streak()` being asked once per player. The table is one row per player per
   * tier per day, so the whole history of a club is a few thousand rows —
   * cheaper to reduce here than to make the database do it three times.
   *
   * **The streak rule is `streak()`'s, deliberately copied**: a missed day
   * breaks it, and *today not yet played does not* — a player who solved
   * yesterday and has not opened today still has their streak. If these two
   * ever disagree, the number on a player's own profile and the number ranking
   * them on a board would differ, which is the kind of thing nobody reports and
   * everybody notices.
   *
   * Not guild-scoped, because neither `streak` nor `totalSolved` is: a daily is
   * the same daily wherever it was played, and a streak that reset when
   * somebody solved from another server would be a lie about their habit.
   */
  dailyRecords(today: number): {
    player: PlayerProfile;
    solves: number;
    days: number;
    current: number;
    best: number;
  }[] {
    const rows = this.db
      .query<
        { id: string; username: string; avatar_url: string | null; day: number; n: number },
        []
      >(
        `SELECT r.player_id AS id, p.username, p.avatar_url, r.day AS day, COUNT(*) AS n
           FROM runs r JOIN players p ON p.id = r.player_id
          WHERE r.solved = 1
          GROUP BY r.player_id, r.day
          ORDER BY r.player_id, r.day DESC`,
      )
      .all();

    const byPlayer = new Map<
      string,
      { player: PlayerProfile; solves: number; days: number[] }
    >();
    for (const row of rows) {
      const seen = byPlayer.get(row.id) ?? {
        player: { id: row.id, username: row.username, avatarUrl: row.avatar_url },
        solves: 0,
        days: [],
      };
      seen.solves += row.n;
      seen.days.push(row.day);
      byPlayer.set(row.id, seen);
    }

    return [...byPlayer.values()].map((one) => ({
      player: one.player,
      solves: one.solves,
      days: one.days.length,
      current: currentStreak(one.days, today),
      best: bestStreak(one.days),
    }));
  }

  /**
   * How each of today's tiers landed, as a field.
   *
   * The one question nothing else here can answer: "was I the only one who
   * could not do the extreme?" Every existing board is a ranking, and a ranking
   * has no denominator — the day board is `LIMIT 25` and drops the per-tier
   * marks on the way through the leaderboards normaliser.
   *
   * **Counts, not a rate.** One solve out of one hand-in is a hundred per cent,
   * and this board is a single Discord server most of the time.
   *
   * Hand-ins, not attempts: a `runs` row exists only once somebody files, so
   * anybody who opened a tier and walked away is in none of these. The page
   * says so, because a reader will otherwise take `filed` for "played".
   */
  dailyTierStats(day: number, guildId: string | null): Record<DailyTier, { filed: number; solved: number }> {
    const rows = this.db
      .query<{ slot: string; filed: number; solved: number }, [number, string | null]>(
        `SELECT runs.slot AS slot, COUNT(*) AS filed, SUM(runs.solved) AS solved
           FROM runs
          WHERE runs.day = ?1 AND (?2 IS NULL OR runs.guild_id = ?2)
            AND runs.slot IN ('easy', 'medium', 'hard', 'extreme')
          GROUP BY runs.slot`,
      )
      .all(day, guildId);

    const out = {} as Record<DailyTier, { filed: number; solved: number }>;
    for (const tier of DAILY_TIERS) out[tier] = { filed: 0, solved: 0 };
    for (const row of rows) {
      const tier = row.slot as DailyTier;
      if (out[tier]) out[tier] = { filed: row.filed, solved: row.solved };
    }
    return out;
  }

  /**
   * Where one player stands on today's board, and how big the field is.
   *
   * `dayBoard` is `LIMIT 25`, so a player outside it sees a list with no line
   * for themselves and no way to tell whether they are 26th or 200th. Ordered
   * exactly as `dayBoard` orders — solved descending, then total time — because
   * a rank counted under a different rule from the board it is a rank *in* is
   * wrong whenever the two differ.
   *
   * Null when they have filed nothing today: there is no rank to have, and
   * "0th of 52" is worse than the sentence the page prints instead.
   */
  dayStanding(
    day: number,
    guildId: string | null,
    playerId: string,
  ): { rank: number; of: number; solved: number; totalMs: number } | null {
    const totals = `
      SELECT runs.player_id AS id,
             SUM(runs.solved) AS solved,
             SUM(CASE WHEN runs.solved = 1 THEN runs.total_ms ELSE 0 END) AS totalMs
        FROM runs
       WHERE runs.day = ?1 AND (?2 IS NULL OR runs.guild_id = ?2)
         AND runs.slot IN ('easy', 'medium', 'hard', 'extreme')
       GROUP BY runs.player_id`;

    const mine = this.db
      .query<{ solved: number; totalMs: number }, [number, string | null, string]>(
        `SELECT solved, totalMs FROM (${totals}) WHERE id = ?3`,
      )
      .get(day, guildId, playerId);
    if (!mine) return null;

    const field = this.db
      .query<{ n: number }, [number, string | null]>(
        `SELECT COUNT(*) AS n FROM (${totals})`,
      )
      .get(day, guildId)?.n ?? 0;

    // Strictly ahead, so a tie reads as a tie rather than as one worse.
    const ahead = this.db
      .query<{ n: number }, [number, string | null, number, number]>(
        `SELECT COUNT(*) AS n FROM (${totals})
          WHERE solved > ?3 OR (solved = ?3 AND totalMs < ?4)`,
      )
      .get(day, guildId, mine.solved, mine.totalMs)?.n ?? 0;

    return { rank: ahead + 1, of: field, solved: mine.solved, totalMs: mine.totalMs };
  }

  dayBoard(day: number, guildId: string | null, limit = 25): DayBoardRow[] {
    const rows = this.db
      .query<DayBoardRaw, [number, string | null, number]>(
        `SELECT players.id AS id, players.username AS username,
                players.avatar_url AS avatarUrl,
                SUM(runs.solved) AS solved,
                SUM(CASE WHEN runs.solved = 1 THEN runs.total_ms ELSE 0 END) AS totalMs,
                MAX(CASE WHEN runs.slot = 'easy'   THEN runs.solved + 1 ELSE 0 END) AS easy,
                MAX(CASE WHEN runs.slot = 'medium' THEN runs.solved + 1 ELSE 0 END) AS medium,
                MAX(CASE WHEN runs.slot = 'hard'   THEN runs.solved + 1 ELSE 0 END) AS hard,
                  MAX(CASE WHEN runs.slot = 'extreme' THEN runs.solved + 1 ELSE 0 END) AS extreme
         FROM runs JOIN players ON players.id = runs.player_id
         WHERE runs.day = ?1 AND (?2 IS NULL OR runs.guild_id = ?2)
           AND runs.slot IN ('easy', 'medium', 'hard', 'extreme')
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
      // streaks and totals, and belong to none of today's tiers.
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
        // day now holds several puzzles, and solving two of them would otherwise
        // put the same day in this list twice and stop the walk dead on the
        // duplicate. Solving any one of them keeps the day.
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
          // DISTINCT: one row per tier a day per player, and this counts people.
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
          // several puzzles would otherwise let one day count more than once — the
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
   * The puzzle ids a day is pinned to, or null when nobody has asked for
   * that day yet.
   *
   * A day is every tier or it is nothing. A partial day would deal one
   * tier out of history and two out of whatever the pool holds now, which is
   * precisely the half-rewritten day this table exists to make impossible — so
   * a partial day reads as unpinned and {@link pinDay} fills the gaps, leaving
   * the tier already on file exactly where it was.
   */
  /**
   * Whatever tiers a day already has on file, which may be fewer than all of
   * them.
   *
   * Every day pinned before `extreme` existed holds three rows, and those days
   * are history: the puzzles they name were played. {@link pinnedDay} answers
   * null for them because it demands the full set, and the caller then tops the
   * day up — so it needs to know what is already there, or it will deal a fourth
   * puzzle that may be one of the three already on the day.
   */
  pinnedTiers(day: number): Partial<Record<DailyTier, number>> {
    const rows = this.db
      .query<{ tier: string; puzzle_id: number }, [number]>(
        "SELECT tier, puzzle_id FROM day_puzzles WHERE day = ?1",
      )
      .all(day);
    const ids: Partial<Record<DailyTier, number>> = {};
    for (const row of rows) {
      if (DAILY_TIERS.includes(row.tier as DailyTier)) ids[row.tier as DailyTier] = row.puzzle_id;
    }
    return ids;
  }

  pinnedDay(day: number): Record<DailyTier, number> | null {
    const ids = this.pinnedTiers(day);
    if (!DAILY_TIERS.every((tier) => ids[tier] !== undefined)) return null;
    return ids as Record<DailyTier, number>;
  }

  /**
   * Pins a day's tiers, and answers with what is on file afterwards.
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
