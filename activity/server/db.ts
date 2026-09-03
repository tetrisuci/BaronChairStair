/**
 * Persistence. SQLite because the whole game is one row per player per day, and
 * a file that can be copied is worth more here than a database server.
 */

import { Database } from "bun:sqlite";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";

/** Marks a run filed when a day held one puzzle and there was nothing to name. */
const LEGACY_SLOT = "legacy";
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

  constructor(path: string) {
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
}
