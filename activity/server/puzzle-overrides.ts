/**
 * Corrections an officer has made to a puzzle's metadata.
 *
 * `data/puzzles.json` is rewritten wholesale from the club's CSVs by
 * `bun run puzzles`, so a typo fixed by editing that file dies at the next
 * rebuild. Accepted community puzzles are rows in `submissions` and could have
 * been updated in place instead — and that is the alternative that loses: a
 * correction would then be written one way for a club puzzle and another way
 * for a player's, and two mechanisms for one action is worse than one. This
 * table is the one mechanism, and `PuzzleArchive.load` lays it over both
 * sources in a single pass.
 *
 * The queries live here rather than in `server/db.ts` for the reason
 * `server/submissions.ts` gives about its own: that file is already past the
 * size where one more table's worth of SQL stays findable in it. The table is
 * still declared in that file's `SCHEMA` beside every other one, so the shape
 * of the database reads in a single place, and `Store` still owns the methods.
 *
 * Nothing in here knows what a `Puzzle` is. Which value wins is
 * `server/puzzles.ts`'s business, next to the archive's other merge, because
 * the archive must go on loading with no database anywhere near it — the same
 * seam `PastDays` cuts from the other side.
 */

import type { Database } from "bun:sqlite";

/**
 * The fields an officer may correct, and the whole of them.
 *
 * `board`, `queue`, `hold`, `targetAttack` and `solution` are deliberately not
 * here, and this is the reason: a run is filed against a `puzzle_id` with no
 * record of the board it was played on, so editing one of those would silently
 * invalidate every leaderboard row standing against that puzzle and every past
 * day that dealt it — a target nobody was actually scored against, and a reveal
 * that plays a line which does not work. They are what a puzzle *is*. The five
 * below cannot change what a solve was worth.
 *
 * `difficulty` is the one that still has a consequence, and it is a scheduling
 * one rather than a scoring one: `dailyTierOf` reads it to pick a tier and
 * `rushBand` to place a puzzle on the ladder, so correcting it moves the puzzle
 * between pools and changes what a FUTURE day deals. Days already played are
 * pinned in `day_puzzles` and do not move. See `PATCH /api/review/puzzles/:id`.
 */
export const OVERRIDABLE_FIELDS = ["title", "author", "goal", "difficulty", "set"] as const;

export type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];

/**
 * What an override says, field by field.
 *
 * NULL means "no override, use the source" in every one of them. That is what
 * makes a partial correction expressible — a title fixed while the difficulty
 * still comes from the club's sheet — and a revert a single DELETE.
 *
 * The cost is that `set` cannot be corrected to *no* set: null is already
 * spoken for. A sentinel string was the alternative and it loses twice — it is
 * a set name somebody could genuinely type, and it would make NULL mean one
 * thing in four columns and two things in the fifth. Taking a puzzle out of a
 * set is a change to the club's sheet, which is where sets come from.
 */
export interface OverrideFields {
  readonly title: string | null;
  readonly author: string | null;
  readonly goal: string | null;
  readonly difficulty: number | null;
  readonly set: string | null;
}

/**
 * One row: the correction, plus who made it and when.
 *
 * `updatedBy` is the review grant's `subject` — an attribution the operator
 * typed, never an authenticated identity, exactly as `submissions.reviewed_by`
 * is. It is the only actor column this table has and it is worth what the shell
 * it was typed into is worth.
 */
export interface PuzzleOverride extends OverrideFields {
  readonly puzzleId: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

/**
 * A change to an override: absent leaves a field alone, null clears it, a value
 * sets it.
 *
 * The three-way distinction is what lets one PATCH fix a title without saying
 * anything about the difficulty, and a later one revert the title alone.
 */
export type OverrideChanges = Partial<OverrideFields>;

interface OverrideRow {
  puzzle_id: number;
  title: string | null;
  author: string | null;
  goal: string | null;
  difficulty: number | null;
  set_name: string | null;
  updated_at: number;
  updated_by: string;
}

const COLUMNS = `
  puzzle_id, title, author, goal, difficulty, set_name, updated_at, updated_by
`;

/** The upsert's eight bound values, in the order {@link COLUMNS} names them. */
type OverrideParameters = [
  number,
  string | null,
  string | null,
  string | null,
  number | null,
  string | null,
  number,
  string,
];

/**
 * A row, as the archive will read it.
 *
 * No validation on the way out, on purpose, and the one place that stops being
 * true is worth naming: SQLite's column types are advisory, so a row somebody
 * edited by hand can hold the string "very hard" in `difficulty`. The gate for
 * that is `overrideProblem` in `server/puzzles.ts`, which runs at the merge and
 * falls back to the source rather than throwing — a second, stricter check here
 * would be a second rule to keep in step, and the same argument
 * `Store.pinnedRushPool` and `jsonList` both make about their own columns.
 */
function toOverride(row: OverrideRow): PuzzleOverride {
  return {
    puzzleId: row.puzzle_id,
    title: row.title,
    author: row.author,
    goal: row.goal,
    difficulty: row.difficulty,
    set: row.set_name,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Every correction on file, for the merge.
 *
 * All of them at once rather than one lookup per puzzle: the merge walks the
 * whole archive exactly once, at start-up, and a table with a handful of rows
 * in it is cheaper to read whole than to ask a hundred and thirty-eight
 * questions of. Ordered by id so the list is stable across restarts, the same
 * courtesy `readAcceptedPuzzles` pays for a stronger reason.
 */
export function readOverrides(db: Database): PuzzleOverride[] {
  return db
    .query<OverrideRow, []>(
      `SELECT ${COLUMNS} FROM puzzle_overrides ORDER BY puzzle_id ASC`,
    )
    .all()
    .map(toOverride);
}

function readOverride(db: Database, puzzleId: number): PuzzleOverride | null {
  const row = db
    .query<OverrideRow, [number]>(
      `SELECT ${COLUMNS} FROM puzzle_overrides WHERE puzzle_id = ?1`,
    )
    .get(puzzleId);
  return row ? toOverride(row) : null;
}

/** Absent leaves the field as it stands; null and a value both say something. */
function merged<T>(change: T | undefined, current: T): T {
  return change === undefined ? current : change;
}

/**
 * Writes a correction, and answers with the row that is now on disk.
 *
 * Read, merge, write, in one transaction. The merge cannot be done in SQL: the
 * three states a PATCH can put a field in are "leave", "clear" and "set", and
 * `COALESCE` collapses the first two into each other. Doing it in the route
 * instead was the alternative, and it loses because two officers correcting
 * different fields of one puzzle in the same moment would each write the row
 * they had read, and the second would silently drop the first one's field.
 *
 * A merge that empties every column DELETEs the row rather than storing eight
 * NULLs. An all-null override is not a correction, and leaving one behind would
 * make "is this puzzle overridden" two questions — does a row exist, and does
 * it say anything — asked in every place that cares.
 *
 * @returns the correction now on file, or null when the merge cleared it out.
 */
/** One entry of the record: a field, the two values either side of the move. */
export interface OverrideLogEntry {
  readonly puzzleId: number;
  readonly field: string;
  readonly was: string | null;
  readonly became: string | null;
  readonly at: number;
  readonly by: string;
}

/**
 * Writes down every field that actually moved, and only those.
 *
 * Inside the caller's transaction, so a correction and its record are one
 * write: a log that can disagree with the row it describes is worse than none.
 * Values are stringified because five columns of three types share one `was`,
 * and a record is read by a person rather than joined on.
 */
function logMoves(
  db: Database,
  puzzleId: number,
  before: OverrideFields | null,
  after: OverrideFields | null,
  by: string,
): void {
  const insert = db.query<unknown, [number, string, string | null, string | null, number, string]>(
    "INSERT INTO puzzle_override_log (puzzle_id, field, was, became, at, by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  );
  const at = Date.now();
  const text = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  for (const field of OVERRIDABLE_FIELDS) {
    const was = text(before?.[field] ?? null);
    const became = text(after?.[field] ?? null);
    if (was === became) continue;
    insert.run(puzzleId, field, was, became, at, by);
  }
}

/** Every correction ever made to one puzzle, oldest first. */
export function overrideHistory(db: Database, puzzleId: number): OverrideLogEntry[] {
  return db
    .query<
      { puzzle_id: number; field: string; was: string | null; became: string | null; at: number; by: string },
      [number]
    >(
      "SELECT puzzle_id, field, was, became, at, by FROM puzzle_override_log WHERE puzzle_id = ?1 ORDER BY entry_id",
    )
    .all(puzzleId)
    .map((row) => ({
      puzzleId: row.puzzle_id,
      field: row.field,
      was: row.was,
      became: row.became,
      at: row.at,
      by: row.by,
    }));
}

export function writeOverride(
  db: Database,
  puzzleId: number,
  changes: OverrideChanges,
  updatedBy: string,
): PuzzleOverride | null {
  return db.transaction(() => {
    const current = readOverride(db, puzzleId);
    const next: OverrideFields = {
      title: merged(changes.title, current?.title ?? null),
      author: merged(changes.author, current?.author ?? null),
      goal: merged(changes.goal, current?.goal ?? null),
      difficulty: merged(changes.difficulty, current?.difficulty ?? null),
      set: merged(changes.set, current?.set ?? null),
    };
    if (OVERRIDABLE_FIELDS.every((field) => next[field] === null)) {
      // A PATCH that clears the last standing field is a revert by another
      // name, and is recorded as one.
      logMoves(db, puzzleId, current, null, updatedBy);
      deleteOverride(db, puzzleId);
      return null;
    }
    logMoves(db, puzzleId, current, next, updatedBy);
    db.query<unknown, OverrideParameters>(
      `INSERT INTO puzzle_overrides
              (puzzle_id, title, author, goal, difficulty, set_name, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(puzzle_id) DO UPDATE SET
         title      = excluded.title,
         author     = excluded.author,
         goal       = excluded.goal,
         difficulty = excluded.difficulty,
         set_name   = excluded.set_name,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    ).run(
      puzzleId,
      next.title,
      next.author,
      next.goal,
      next.difficulty,
      next.set,
      Date.now(),
      updatedBy,
    );

    // A read-back rather than `next` with the timestamps stapled on, the way
    // every other writer in this repo answers: what comes back has been through
    // SQLite's own idea of the column types, so an officer is never shown
    // something the database would not give them later.
    const written = readOverride(db, puzzleId);
    if (!written) {
      throw new Error(`Puzzle ${puzzleId}'s correction vanished immediately after being written`);
    }
    return written;
  })();
}

/**
 * Reverts a puzzle to its source.
 *
 * One DELETE, which is the whole argument for a table of nullable columns: a
 * revert needs no knowledge of what the source said, so it cannot get it wrong.
 *
 * @returns whether there was anything to revert, so a caller can say so.
 */
/**
 * Takes a correction away, and writes down that somebody did.
 *
 * `revertedBy` is optional only because `writeOverride` calls this from inside
 * its own transaction, having already logged the moves itself — passing it
 * there would record every field twice. Every other caller names the officer.
 */
export function deleteOverride(db: Database, puzzleId: number, revertedBy?: string): boolean {
  return db.transaction(() => {
    const standing = readOverride(db, puzzleId);
    if (revertedBy !== undefined && standing) {
      logMoves(db, puzzleId, standing, null, revertedBy);
    }
    const changes = db
      .query<unknown, [number]>("DELETE FROM puzzle_overrides WHERE puzzle_id = ?1")
      .run(puzzleId);
    return changes.changes > 0;
  })();
}
