/**
 * Persistence. SQLite because the whole game is one row per player per day, and
 * a file that can be copied is worth more here than a database server.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface PlayerProfile {
  readonly id: string;
  readonly username: string;
  readonly avatarUrl: string | null;
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
  PRIMARY KEY (day, player_id)
);

CREATE INDEX IF NOT EXISTS runs_by_day    ON runs (day, guild_id);
CREATE INDEX IF NOT EXISTS runs_by_player ON runs (player_id, day);

CREATE TABLE IF NOT EXISTS preferences (
  player_id  TEXT PRIMARY KEY REFERENCES players(id),
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

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

const RUN_COLUMNS = `
  runs.day, runs.puzzle_id, runs.player_id, players.username, players.avatar_url,
  runs.solved, runs.attack, runs.target_attack, runs.duration_ms, runs.total_ms, runs.resets,
  runs.pieces_placed, runs.clears, runs.created_at
`;

export class Store {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.run(SCHEMA);
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
                           pieces_placed, clears, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(day, player_id) DO UPDATE SET
           guild_id = excluded.guild_id,
           solved = excluded.solved,
           attack = excluded.attack,
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
      );

    const run = this.runFor(day, player.id);
    if (!run) throw new Error("Run vanished immediately after being written");
    return { run, isFirst: changes.changes > 0 };
  }

  runFor(day: number, playerId: string): StoredRun | null {
    const row = this.db
      .query<RunRow, [number, string]>(
        `SELECT ${RUN_COLUMNS} FROM runs
         JOIN players ON players.id = runs.player_id
         WHERE runs.day = ?1 AND runs.player_id = ?2`,
      )
      .get(day, playerId);
    return row ? toStoredRun(row) : null;
  }

  /**
   * Leaderboard for a day, best first: solves above misses, then by the least
   * time spent on the puzzle.
   * Scoped to a guild when there is one.
   */
  leaderboard(day: number, guildId: string | null, limit = 25): StoredRun[] {
    const rows = guildId
      ? this.db
          .query<RunRow, [number, string, number]>(
            `SELECT ${RUN_COLUMNS} FROM runs
             JOIN players ON players.id = runs.player_id
             WHERE runs.day = ?1 AND runs.guild_id = ?2
             ORDER BY runs.solved DESC, runs.total_ms ASC, runs.attack DESC
             LIMIT ?3`,
          )
          .all(day, guildId, limit)
      : this.db
          .query<RunRow, [number, number]>(
            `SELECT ${RUN_COLUMNS} FROM runs
             JOIN players ON players.id = runs.player_id
             WHERE runs.day = ?1
             ORDER BY runs.solved DESC, runs.total_ms ASC, runs.attack DESC
             LIMIT ?2`,
          )
          .all(day, limit);
    return rows.map(toStoredRun);
  }

  /** Consecutive solved days ending at `day`, counting backwards. */
  streak(playerId: string, day: number): number {
    const rows = this.db
      .query<{ day: number }, [string, number]>(
        `SELECT day FROM runs
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

  /** How many players have solved a given day, across every server. */
  solvedCount(day: number): number {
    return (
      this.db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM runs WHERE day = ?1 AND solved = 1",
        )
        .get(day)?.n ?? 0
    );
  }

  totalSolved(playerId: string): number {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM runs WHERE player_id = ?1 AND solved = 1",
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
}
