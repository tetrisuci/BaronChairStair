/**
 * Puzzles players wrote, waiting for an officer to look at them.
 *
 * The queries live here and not in `server/db.ts` because that file is already
 * past the size where one more table's worth of SQL stops being findable in it.
 * The table itself is still declared in that file's `SCHEMA`, beside every
 * other one, so the shape of the database can be read in a single place — and
 * `Store` still owns the methods, because a caller has no business knowing
 * which file a query happens to be written in.
 *
 * What a row *means* is set by `POST /api/submissions`, which is the only
 * writer: `target_attack` and `solution` are the server's reading of a log the
 * author sent, never numbers the author gave. See the route for why that
 * distinction is the whole feature.
 */

import type { Database } from "bun:sqlite";
import type { ClearName, Mino, RowCode, SolutionStep } from "../shared/puzzle";
import { type Handling, sanitizeHandling } from "../shared/tetris/handling";
import type { InputEvent } from "../shared/tetris/verify";
import type { PlayerProfile } from "./db";

/** `pending → accepted | rejected`, and both of those are terminal. */
export type SubmissionStatus = "pending" | "accepted" | "rejected";

/**
 * A submission on its way in: what the route derived, plus what it was told.
 *
 * The split is deliberate and is the reason this interface exists at all rather
 * than the route handing over a body. `player` and `guildId` come from the
 * session; `targetAttack`, `solution`, `piecesPlaced` and `clears` come from
 * replaying `events`. Only `title`, `goal`, `claimedDifficulty`, the board, the
 * queue, the hold and the handling are the author's words, and every one of
 * those has been checked before it gets here.
 */
export interface SubmissionDraft {
  readonly player: PlayerProfile;
  readonly guildId: string | null;
  readonly title: string;
  readonly goal: string;
  readonly claimedDifficulty: number;
  readonly board: readonly RowCode[];
  readonly queue: readonly Mino[];
  readonly hold: Mino | null;
  /**
   * The attack the author's own solve sent — what they *did*.
   *
   * Not the same kind of number as an archived puzzle's target, which
   * `tools/build-puzzles.ts` gets from `replayPlacements`: that tries every
   * kick route for each placement and keeps the best line, so an archive target
   * is usually past what a human reproduced. This one is provably reachable by
   * a person and therefore beatable. Nothing here mixes the two, because the
   * table is the record: every row in `submissions` carries a played target, so
   * a column saying so would hold one constant value and start lying the first
   * time somebody wrote to it by hand.
   */
  readonly targetAttack: number;
  readonly solution: readonly SolutionStep[];
  /** Kept, so accepting can re-derive rather than trust the column beside it. */
  readonly events: readonly InputEvent[];
  readonly handling: Handling;
  readonly piecesPlaced: number;
  readonly clears: readonly ClearName[];
}

export interface Submission extends Omit<SubmissionDraft, "player"> {
  readonly submissionId: number;
  readonly playerId: string;
  /** The author's name as it was when they filed, so a rename cannot rewrite credit. */
  readonly authorName: string;
  readonly status: SubmissionStatus;
  readonly reviewerNote: string | null;
  readonly reviewedAt: number | null;
  /** The review grant's subject: an attribution the operator typed, not an identity. */
  readonly reviewedBy: string | null;
  /** Assigned on accept, from the community id band. */
  readonly puzzleId: number | null;
  /** The reviewer's rating, which is the one that counts. */
  readonly difficulty: number | null;
  readonly createdAt: number;
}

/** An officer's verdict. `puzzleId` and `difficulty` are accept's business only. */
export interface SubmissionDecision {
  readonly status: "accepted" | "rejected";
  readonly reviewedBy: string;
  readonly note: string | null;
  readonly puzzleId: number | null;
  readonly difficulty: number | null;
}

interface SubmissionRow {
  submission_id: number;
  player_id: string;
  author_name: string;
  guild_id: string | null;
  title: string;
  goal: string;
  claimed_difficulty: number;
  board: string;
  queue: string;
  hold: string | null;
  target_attack: number;
  solution: string;
  events: string;
  handling: string;
  pieces_placed: number;
  clears: string;
  status: string;
  reviewer_note: string | null;
  reviewed_at: number | null;
  reviewed_by: string | null;
  puzzle_id: number | null;
  difficulty: number | null;
  created_at: number;
}

const COLUMNS = `
  submission_id, player_id, author_name, guild_id, title, goal, claimed_difficulty,
  board, queue, hold, target_attack, solution, events, handling, pieces_placed,
  clears, status, reviewer_note, reviewed_at, reviewed_by, puzzle_id, difficulty,
  created_at
`;

/** How many pending rows a review queue hands over at once. */
const REVIEW_QUEUE_SIZE = 100;

const STATUSES: readonly SubmissionStatus[] = ["pending", "accepted", "rejected"];

/**
 * A JSON column, back as the list it went in as.
 *
 * Parsed defensively even though this process wrote it, for the same reason
 * `Store.pinnedRushPool` is: a JSON column is a blob to SQLite, so nothing but
 * this stands between an edited or half-written row and the engine. A board
 * that came back holding a number would not fail here — it would fail four
 * calls later, inside a replay, naming nothing that would help.
 *
 * The check stops at "is it a list". What is *in* it is settled by the only
 * writer, which validated every element before the row existed, and again at
 * accept time by re-running the log rather than trusting the placements beside
 * it. A second full validation here would be a second rule to keep in step.
 */
function jsonList<T>(id: number, column: string, raw: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Submission ${id}'s ${column} is not valid JSON`, { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error(`Submission ${id}'s ${column} is not a list`);
  return parsed as T[];
}

function toSubmission(row: SubmissionRow): Submission {
  const id = row.submission_id;
  const status = STATUSES.find((candidate) => candidate === row.status);
  // A status outside the three is not a state this code can act on, and
  // treating it as pending would put an already-decided puzzle back in front of
  // an officer.
  if (!status) throw new Error(`Submission ${id} has status ${JSON.stringify(row.status)}`);

  let handling: unknown;
  try {
    handling = JSON.parse(row.handling);
  } catch (error) {
    throw new Error(`Submission ${id}'s handling is not valid JSON`, { cause: error });
  }

  return {
    submissionId: id,
    playerId: row.player_id,
    authorName: row.author_name,
    guildId: row.guild_id,
    title: row.title,
    goal: row.goal,
    claimedDifficulty: row.claimed_difficulty,
    board: jsonList<RowCode>(id, "board", row.board),
    queue: jsonList<Mino>(id, "queue", row.queue),
    hold: row.hold as Mino | null,
    targetAttack: row.target_attack,
    solution: jsonList<SolutionStep>(id, "solution", row.solution),
    events: jsonList<InputEvent>(id, "events", row.events),
    // Through the sanitiser rather than cast: it is total, it is what the
    // replay would have applied anyway, and it costs nothing here.
    handling: sanitizeHandling(handling),
    piecesPlaced: row.pieces_placed,
    clears: jsonList<ClearName>(id, "clears", row.clears),
    status,
    reviewerNote: row.reviewer_note,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    puzzleId: row.puzzle_id,
    difficulty: row.difficulty,
    createdAt: row.created_at,
  };
}

export function readSubmission(db: Database, id: number): Submission | null {
  const row = db
    .query<SubmissionRow, [number]>(
      `SELECT ${COLUMNS} FROM submissions WHERE submission_id = ?1`,
    )
    .get(id);
  return row ? toSubmission(row) : null;
}

/**
 * Files a submission, and answers with the row that is now on disk.
 *
 * A read-back rather than the draft with an id stapled to it, the way every
 * other writer in `Store` answers: what comes back has been through SQLite's
 * own idea of the column types and this module's own parsing, so a reviewer
 * can never be shown something the database would not give them later.
 *
 * The caller must have written the player first — `player_id` references
 * `players(id)` and foreign keys are on.
 */
export function insertSubmission(db: Database, draft: SubmissionDraft): Submission {
  const written = db
    .query(
      `INSERT INTO submissions (player_id, author_name, guild_id, title, goal,
                                claimed_difficulty, board, queue, hold, target_attack,
                                solution, events, handling, pieces_placed, clears,
                                status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'pending', ?16)`,
    )
    .run(
      draft.player.id,
      draft.player.username,
      draft.guildId,
      draft.title,
      draft.goal,
      draft.claimedDifficulty,
      JSON.stringify(draft.board),
      JSON.stringify(draft.queue),
      draft.hold,
      draft.targetAttack,
      JSON.stringify(draft.solution),
      JSON.stringify(draft.events),
      JSON.stringify(draft.handling),
      draft.piecesPlaced,
      JSON.stringify(draft.clears),
      Date.now(),
    );

  const submission = readSubmission(db, Number(written.lastInsertRowid));
  if (!submission) throw new Error("Submission vanished immediately after being written");
  return submission;
}

/**
 * The review queue: everything still waiting, oldest first.
 *
 * Oldest first because a queue that showed the newest would leave the puzzle
 * nobody wanted to review at the bottom of the list forever. `submissions_queue`
 * is `(status, created_at)`, which is exactly this.
 */
export function readPendingSubmissions(db: Database, limit = REVIEW_QUEUE_SIZE): Submission[] {
  return db
    .query<SubmissionRow, [number]>(
      `SELECT ${COLUMNS} FROM submissions
        WHERE status = 'pending'
        ORDER BY created_at ASC, submission_id ASC
        LIMIT ?1`,
    )
    .all(limit)
    .map(toSubmission);
}

/**
 * How many puzzles this player has waiting.
 *
 * A queue depth, not a lifetime allowance: a decided row frees the slot again,
 * or an author would be retired after their third puzzle. In SQL rather than in
 * the limiter because `callerKey` reads an address and never the session — and
 * inside Discord a whole server can arrive through one proxy address.
 */
export function countPendingSubmissions(db: Database, playerId: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM submissions WHERE player_id = ?1 AND status = 'pending'",
      )
      .get(playerId)?.n ?? 0
  );
}

/**
 * Records an officer's verdict, and answers with the row as it now stands.
 *
 * `WHERE status = 'pending'` is what makes both decided states terminal. Two
 * officers can hold review links at once and nothing coordinates them, so
 * without it the second one to click would quietly overwrite the first one's
 * note, rating and allocated puzzle id — and the row would still look like a
 * clean decision. `isFirst` is how a caller tells "you decided this" from
 * "somebody already had", the same answer `recordRun` and `recordRushRun` give
 * for the same reason.
 *
 * @throws {Error} when there is no submission with that id at all, which is a
 *   different thing from one that was already decided and must not read as one.
 */
export function writeSubmissionDecision(
  db: Database,
  id: number,
  decision: SubmissionDecision,
): { submission: Submission; isFirst: boolean } {
  const changes = db
    .query<unknown, [number, string, string | null, number, string, number | null, number | null]>(
      `UPDATE submissions
          SET status = ?2, reviewer_note = ?3, reviewed_at = ?4, reviewed_by = ?5,
              puzzle_id = ?6, difficulty = ?7
        WHERE submission_id = ?1 AND status = 'pending'`,
    )
    .run(
      id,
      decision.status,
      decision.note,
      Date.now(),
      decision.reviewedBy,
      decision.puzzleId,
      decision.difficulty,
    );

  const submission = readSubmission(db, id);
  if (!submission) throw new Error(`There is no submission ${id} to decide`);
  return { submission, isFirst: changes.changes > 0 };
}
