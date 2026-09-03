/**
 * The one migration this schema cannot do with ADD COLUMN.
 *
 * `runs` was keyed `(day, player_id)`, and that key *was* the rule "one run per
 * player per day" — enforced by SQLite rather than by any code we wrote. A day
 * holding three puzzles needs a third key column, SQLite cannot alter a primary
 * key, and the file's only migration idiom adds columns. So the table is
 * rebuilt, and a rebuild is the kind of thing that has to be proven against a
 * database of the old shape rather than reasoned about.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type RunResult } from "../server/db";

let dir: string;
let path: string;

/** The schema as it stood when a day held one puzzle. */
const LEGACY_SCHEMA = `
CREATE TABLE players (
  id TEXT PRIMARY KEY, username TEXT NOT NULL, avatar_url TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE runs (
  day INTEGER NOT NULL, player_id TEXT NOT NULL REFERENCES players(id), guild_id TEXT,
  puzzle_id INTEGER NOT NULL, solved INTEGER NOT NULL, attack INTEGER NOT NULL,
  target_attack INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
  total_ms INTEGER NOT NULL DEFAULT 0, resets INTEGER NOT NULL,
  pieces_placed INTEGER NOT NULL, clears TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (day, player_id)
);
CREATE INDEX runs_by_day ON runs (day, guild_id);
`;

const player = { id: "p1", username: "Ada", avatarUrl: null };
const result = (solved: boolean, totalMs = 1000): RunResult => ({
  solved,
  attack: solved ? 4 : 0,
  targetAttack: 4,
  durationMs: 500,
  totalMs,
  resets: 0,
  piecesPlaced: 4,
  clears: [],
});

function seedLegacy(days: readonly number[]): void {
  const db = new Database(path, { create: true });
  db.run(LEGACY_SCHEMA);
  db.run("INSERT INTO players (id, username, avatar_url, updated_at) VALUES ('p1','Ada',NULL,1)");
  for (const day of days) {
    db.run(
      `INSERT INTO runs (day, player_id, guild_id, puzzle_id, solved, attack, target_attack,
                         duration_ms, total_ms, resets, pieces_placed, clears, created_at)
       VALUES (?, 'p1', 'g1', 7, 1, 4, 4, 500, 1000, 0, 4, '[]', 1)`,
      [day],
    );
  }
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runs-migration-"));
  path = join(dir, "daily.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("rebuilding the runs key", () => {
  test("keeps every row a database of the old shape was holding", () => {
    seedLegacy([10, 11, 12]);
    const store = new Store(path);
    try {
      const db = new Database(path);
      const key = db
        .query<{ name: string; pk: number }, []>("PRAGMA table_info(runs)")
        .all()
        .filter((column) => column.pk > 0)
        .map((column) => column.name);
      expect(key).toEqual(["day", "player_id", "slot"]);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(3);
      // Not guessed into a tier. Those runs were played against a day's single
      // puzzle, which is none of the three that day deals now.
      const slots = db.query<{ slot: string }, []>("SELECT DISTINCT slot FROM runs").all();
      expect(slots).toEqual([{ slot: "legacy" }]);
      db.close();
    } finally {
      store.close();
    }
  });

  test("puts the indexes back, and leaves no dangling reference", () => {
    // The rebuild drops the table, which takes its indexes with it, and runs
    // with foreign keys off because the pragma is a no-op inside a transaction.
    seedLegacy([10]);
    const store = new Store(path);
    try {
      const db = new Database(path);
      const names = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND tbl_name = 'runs' AND name NOT LIKE 'sqlite_%'`,
        )
        .all()
        .map((row) => row.name)
        .sort();
      expect(names).toEqual(["runs_board", "runs_by_day", "runs_by_guild", "runs_by_player"]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
    } finally {
      store.close();
    }
  });

  test("runs once, not on every start", () => {
    seedLegacy([10]);
    new Store(path).close();
    const second = new Store(path);
    try {
      expect(second.streak("p1", 10)).toBe(1);
    } finally {
      second.close();
    }
  });
});

describe("what the new key admits", () => {
  test("three puzzles a day, each filed on its own", () => {
    // Under the old key the second and third were silently swallowed by the
    // conflict clause, and the caller was handed back the first one's row.
    const store = new Store(path);
    try {
      store.recordRun(10, "easy", 101, player, "g1", result(true));
      store.recordRun(10, "medium", 202, player, "g1", result(true));
      store.recordRun(10, "hard", 303, player, "g1", result(false));

      const runs = store.runsFor(10, "p1");
      expect(Object.keys(runs).sort()).toEqual(["easy", "hard", "medium"]);
      expect(runs.easy!.puzzleId).toBe(101);
      expect(runs.hard!.puzzleId).toBe(303);
      expect(runs.hard!.solved).toBe(false);
    } finally {
      store.close();
    }
  });

  test("a day counts once towards a streak, however many of it you solved", () => {
    const store = new Store(path);
    try {
      for (const day of [8, 9, 10]) {
        store.recordRun(day, "easy", 101, player, "g1", result(true));
        store.recordRun(day, "medium", 202, player, "g1", result(true));
      }
      expect(store.streak("p1", 10)).toBe(3);
    } finally {
      store.close();
    }
  });

  test("solving only the easy one still keeps the day", () => {
    const store = new Store(path);
    try {
      for (const day of [8, 9, 10]) {
        store.recordRun(day, "easy", 101, player, "g1", result(true));
        store.recordRun(day, "hard", 303, player, "g1", result(false));
      }
      expect(store.streak("p1", 10)).toBe(3);
    } finally {
      store.close();
    }
  });

  test("the counters count people, not rows", () => {
    // Three rows a player would otherwise treble the announce embed's solver
    // count and the recap's "and N more who played".
    const store = new Store(path);
    try {
      store.recordRun(10, "easy", 101, player, "g1", result(true));
      store.recordRun(10, "medium", 202, player, "g1", result(true));
      store.recordRun(10, "hard", 303, player, "g1", result(false));
      expect(store.dayCount(10, "g1")).toBe(1);
      expect(store.solvedCount(10)).toBe(1);
    } finally {
      store.close();
    }
  });

  test("each tier has a board of its own", () => {
    const store = new Store(path);
    try {
      store.recordRun(10, "easy", 101, player, "g1", result(true, 900));
      store.recordRun(10, "hard", 303, player, "g1", result(false));
      expect(store.leaderboard(10, "g1", "easy").map((run) => run.puzzleId)).toEqual([101]);
      expect(store.leaderboard(10, "g1", "hard").map((run) => run.puzzleId)).toEqual([303]);
      expect(store.leaderboard(10, "g1", "medium")).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("a later solve still upgrades an earlier miss, within its own tier", () => {
    const store = new Store(path);
    try {
      store.recordRun(10, "hard", 303, player, "g1", result(false));
      const { run } = store.recordRun(10, "hard", 303, player, "g1", result(true, 4000));
      expect(run.solved).toBe(true);
      // And does not reach across into another tier's row.
      store.recordRun(10, "easy", 101, player, "g1", result(false));
      expect(store.runFor(10, "p1", "easy")!.solved).toBe(false);
    } finally {
      store.close();
    }
  });
});
