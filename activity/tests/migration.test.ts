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
import { Store, type PastDays, type RunResult } from "../server/db";
import type { SubmissionDraft } from "../server/submissions";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";

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

describe("the day as one board", () => {
  const someone = (id: string) => ({ id, username: id, avatarUrl: null });

  test("a limit counts players, not tier rows", () => {
    // The defect this replaced: each tier was fetched with its own limit and
    // the three were merged afterwards, so a player near the bottom of one
    // tier and the top of another came back on one board only and lost the
    // other mark. Here the grouping happens first and the limit counts people.
    const store = new Store(path);
    try {
      for (let n = 0; n < 5; n++) {
        store.recordRun(10, "easy", 101, someone(`p${n}`), "g1", result(true, 100 + n));
      }
      // Last on easy by time, and the only one who solved the hard puzzle.
      store.recordRun(10, "hard", 303, someone("p4"), "g1", result(true, 50));

      const board = store.dayBoard(10, "g1", 2);
      expect(board).toHaveLength(2);
      // p4 leads on two solves, and carries BOTH marks — the easy one would
      // have been cut by an easy-board limit of 2.
      expect(board[0]!.player.id).toBe("p4");
      expect(board[0]!.solved).toBe(2);
      expect(board[0]!.marks).toEqual({ easy: true, hard: true });
    } finally {
      store.close();
    }
  });

  test("tells apart solved, filed and failed, and never opened", () => {
    const store = new Store(path);
    try {
      store.recordRun(10, "easy", 101, someone("ada"), "g1", result(true));
      store.recordRun(10, "medium", 202, someone("ada"), "g1", result(false));
      const [row] = store.dayBoard(10, "g1");
      expect(row!.marks).toEqual({ easy: true, medium: false });
      expect("hard" in row!.marks).toBe(false);
    } finally {
      store.close();
    }
  });

  test("counts only the time of the puzzles actually solved", () => {
    const store = new Store(path);
    try {
      store.recordRun(10, "easy", 101, someone("ada"), "g1", result(true, 900));
      store.recordRun(10, "hard", 303, someone("ada"), "g1", result(false, 9999));
      expect(store.dayBoard(10, "g1")[0]!.totalMs).toBe(900);
    } finally {
      store.close();
    }
  });

  test("leaves legacy rows out of the day's three", () => {
    // They were filed against a day's single puzzle, which is none of these.
    seedLegacy([10]);
    const store = new Store(path);
    try {
      expect(store.dayBoard(10, "g1")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("the all-time rush board", () => {
  const someone = (id: string) => ({ id, username: id, avatarUrl: null });
  const rush = (solved: number, timeToLastSolveMs: number) => ({
    solved,
    attempted: solved + 1,
    skipsUsed: 0,
    timeToLastSolveMs,
    elapsedMs: 300_000,
  });

  test("keeps a player's best run, not their latest", () => {
    const store = new Store(path);
    try {
      store.recordRushRun(1, someone("ada"), "g1", rush(9, 200_000));
      store.recordRushRun(2, someone("ada"), "g1", rush(4, 100_000));
      const [row] = store.rushRecords(null);
      expect(row!.solved).toBe(9);
      // And the time from that run, not from the other one. A GROUP BY with
      // MAX(solved) would pair the right count with the wrong run's time, and
      // the time is the tiebreak.
      expect(row!.timeToLastSolveMs).toBe(200_000);
      expect(row!.day).toBe(1);
    } finally {
      store.close();
    }
  });

  test("does not reset with the day", () => {
    // The point of the feature: a record set weeks ago still stands. The daily
    // board would be empty for every one of these days but the last.
    const store = new Store(path);
    try {
      store.recordRushRun(1, someone("ada"), "g1", rush(12, 200_000));
      store.recordRushRun(90, someone("bo"), "g1", rush(5, 100_000));
      expect(store.rushRecords(null).map((row) => row.player.id)).toEqual(["ada", "bo"]);
    } finally {
      store.close();
    }
  });

  test("one player, one row, however many rushes they have run", () => {
    const store = new Store(path);
    try {
      for (let day = 1; day <= 5; day++) {
        store.recordRushRun(day, someone("ada"), "g1", rush(day, 100_000));
      }
      const rows = store.rushRecords(null);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.solved).toBe(5);
    } finally {
      store.close();
    }
  });

  test("ties break on reaching it sooner", () => {
    const store = new Store(path);
    try {
      store.recordRushRun(1, someone("slow"), "g1", rush(7, 250_000));
      store.recordRushRun(1, someone("quick"), "g1", rush(7, 90_000));
      expect(store.rushRecords(null).map((row) => row.player.id)).toEqual(["quick", "slow"]);
    } finally {
      store.close();
    }
  });

  test("the server scope is one server, and global is all of them", () => {
    const store = new Store(path);
    try {
      store.recordRushRun(1, someone("here"), "g1", rush(6, 100_000));
      store.recordRushRun(1, someone("elsewhere"), "g2", rush(20, 100_000));
      expect(store.rushRecords("g1").map((row) => row.player.id)).toEqual(["here"]);
      expect(store.rushRecords(null).map((row) => row.player.id)).toEqual([
        "elsewhere",
        "here",
      ]);
    } finally {
      store.close();
    }
  });
});

/**
 * The two tables that turn a day's puzzles from a sum into a record.
 *
 * Both are brand-new with every column present, so `CREATE TABLE IF NOT EXISTS`
 * in SCHEMA is the whole shape migration — no rebuild, no ADD COLUMN. What
 * needs proving is the other half: that they appear on a database of the old
 * shape without disturbing it, and that the one-time backfill never runs twice.
 * A backfill that re-derived on a later start would be reading a pool that had
 * grown since, and would rewrite exactly the history it was written to save.
 */
describe("writing down what a day dealt", () => {
  /** A stand-in rotation: day 4 deals 41/42/43, and so on. */
  const dealing = (throughDay: number, offset = 0): PastDays => ({
    throughDay,
    puzzleIdsFor: (day) => ({
      easy: day * 10 + 1 + offset,
      medium: day * 10 + 2 + offset,
      hard: day * 10 + 3 + offset,
    }),
  });

  test("the new tables arrive, and the old ones come through untouched", () => {
    seedLegacy([10, 11]);
    const store = new Store(path, dealing(3));
    try {
      const db = new Database(path);
      const named = (type: string) =>
        db
          .query<{ name: string }, [string]>(
            `SELECT name FROM sqlite_master WHERE type = ?1 AND name NOT LIKE 'sqlite_%'`,
          )
          .all(type)
          .map((row) => row.name)
          .sort();

      // Exhaustive on purpose: this is the list of everything `SCHEMA` builds
      // against a database of the old shape, so a table that quietly failed to
      // appear — or one that appeared and was never meant to — shows up here
      // and nowhere else.
      expect(named("table")).toEqual([
        "day_puzzles",
        "day_rush",
        "players",
        "preferences",
        "runs",
        "rush_runs",
        "submissions",
      ]);
      // The runs rebuild happens on the same start; its indexes must survive it.
      expect(named("index")).toEqual([
        "runs_board",
        "runs_by_day",
        "runs_by_guild",
        "runs_by_player",
        "rush_by_day",
        "rush_records",
        "submissions_puzzle",
        "submissions_queue",
      ]);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(2);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
    } finally {
      store.close();
    }
  });

  test("every day up to today is written down, and tomorrow is not", () => {
    const store = new Store(path, dealing(3));
    try {
      expect(store.pinnedDay(1)).toEqual({ easy: 11, medium: 12, hard: 13 });
      expect(store.pinnedDay(3)).toEqual({ easy: 31, medium: 32, hard: 33 });
      // Days that have not arrived still float, which is the entire point: an
      // accepted puzzle has to be able to reach the rotation eventually.
      expect(store.pinnedDay(4)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("a restart leaves every pinned day exactly where it was", () => {
    // The bug this catches: a backfill that runs on every start. The second
    // open here is a pool that deals differently — an accepted submission, a
    // rebuilt puzzles.json — and re-deriving day 1 against it is the history
    // rewrite the table exists to prevent.
    new Store(path, dealing(3)).close();
    const second = new Store(path, dealing(3, 500));
    try {
      expect(second.pinnedDay(1)).toEqual({ easy: 11, medium: 12, hard: 13 });
      expect(second.pinnedDay(3)).toEqual({ easy: 31, medium: 32, hard: 33 });
    } finally {
      second.close();
    }
  });

  test("a store opened with no rotation still gets the tables", () => {
    // `new Store(path)` is how every other test and every tool opens it. The
    // backfill is the only thing that needs a rotation, and nothing else may
    // start depending on one.
    const store = new Store(path);
    try {
      expect(store.pinnedDay(1)).toBeNull();
      expect(store.pinnedRushPool(1)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("the first writer of a day decides it, and the second reads that back", () => {
    // Two requests can reach an unpinned day in the same millisecond. Returning
    // the argument instead of a read-back would tell them different puzzles for
    // the same day — the one outcome nothing else in the system could detect.
    const store = new Store(path);
    try {
      expect(store.pinDay(9, { easy: 1, medium: 2, hard: 3 })).toEqual({
        easy: 1,
        medium: 2,
        hard: 3,
      });
      expect(store.pinDay(9, { easy: 7, medium: 8, hard: 9 })).toEqual({
        easy: 1,
        medium: 2,
        hard: 3,
      });
    } finally {
      store.close();
    }
  });

  test("a day written down only in part is completed, never mixed", () => {
    // A day is all three tiers or it is nothing: one tier out of history and
    // two out of today's pool is the half-rewritten day this table rules out.
    // The surviving tier is kept — it is the older fact of the two.
    const seed = new Database(path, { create: true });
    seed.run(`CREATE TABLE day_puzzles (
      day INTEGER NOT NULL, tier TEXT NOT NULL, puzzle_id INTEGER NOT NULL,
      PRIMARY KEY (day, tier)
    )`);
    seed.run("INSERT INTO day_puzzles (day, tier, puzzle_id) VALUES (77, 'easy', 5)");
    seed.close();

    const store = new Store(path, dealing(90));
    try {
      expect(store.pinnedDay(77)).toBeNull();
      expect(store.pinDay(77, { easy: 1, medium: 2, hard: 3 })).toEqual({
        easy: 5,
        medium: 2,
        hard: 3,
      });
    } finally {
      store.close();
    }
  });

  test("a day's rush pool keeps its order, and the first ticket decides it", () => {
    // Order is not decoration: `rushSequence` shuffles positions, so the same
    // ids in a different order are a different forty puzzles.
    const store = new Store(path);
    try {
      expect(store.pinnedRushPool(5)).toBeNull();
      expect(store.pinRushPool(5, [30, 10, 20])).toEqual([30, 10, 20]);
      expect(store.pinRushPool(5, [1, 2, 3])).toEqual([30, 10, 20]);
      expect(store.pinnedRushPool(5)).toEqual([30, 10, 20]);
    } finally {
      store.close();
    }
  });

  test("a rush pool that is not a list of ids is refused, not dealt", () => {
    // SQLite treats the column as a blob, so nothing but the reader checks it.
    // Left unchecked it reaches `rushSequence` and deals an undefined puzzle,
    // which scores a run against a board that does not exist.
    const seed = new Database(path, { create: true });
    seed.run("CREATE TABLE day_rush (day INTEGER PRIMARY KEY, puzzle_ids TEXT NOT NULL)");
    seed.run("INSERT INTO day_rush (day, puzzle_ids) VALUES (4, '[1, null, 3]')");
    seed.run("INSERT INTO day_rush (day, puzzle_ids) VALUES (5, 'not json')");
    seed.close();

    const store = new Store(path);
    try {
      expect(() => store.pinnedRushPool(4)).toThrow("not a list of puzzle ids");
      expect(() => store.pinnedRushPool(5)).toThrow("not valid JSON");
    } finally {
      store.close();
    }
  });
});

/**
 * The submissions table, at the level a schema can be wrong at.
 *
 * Everything about what a submission *means* is pinned in
 * `tests/submissions.test.ts`, against the route that is its only writer. What
 * is left here is the part that only shows up against a real file: the foreign
 * key that makes `recordSubmission` upsert the player first, and the columns
 * surviving the trip through SQLite and back.
 */
describe("the submissions table", () => {
  const author = { id: "author-1", username: "Ada", avatarUrl: null };
  const draft = (title: string): SubmissionDraft => ({
    player: author,
    guildId: "g1",
    title,
    goal: "Clear 1 TSD",
    claimedDifficulty: 4,
    board: ["GGGG.GGGGG"],
    queue: ["T"],
    hold: null,
    targetAttack: 4,
    solution: [{ piece: "T", cells: [[3, 1], [4, 1], [5, 1], [4, 0]], clear: "tsd", attack: 4 }],
    events: [{ frame: 0, type: "keydown", data: { key: "hardDrop", subframe: 0 } }],
    handling: DEFAULT_HANDLING,
    piecesPlaced: 1,
    clears: ["tsd"],
  });

  test("comes back as what went in, and survives a restart", () => {
    const first = new Store(path);
    let id = 0;
    try {
      id = first.recordSubmission(draft("Tuck the T")).submissionId;
    } finally {
      first.close();
    }

    const second = new Store(path);
    try {
      const stored = second.submission(id)!;
      expect(stored.title).toBe("Tuck the T");
      expect(stored.playerId).toBe("author-1");
      expect(stored.authorName).toBe("Ada");
      expect(stored.guildId).toBe("g1");
      expect(stored.hold).toBeNull();
      expect(stored.status).toBe("pending");
      // The JSON columns, which SQLite stores as opaque text: a board that came
      // back as the string "[...]" rather than a list would not fail until it
      // reached a replay, naming nothing that would help.
      expect(stored.board).toEqual(["GGGG.GGGGG"]);
      expect(stored.solution[0]!.clear).toBe("tsd");
      expect(stored.events.length).toBe(1);
      expect(stored.handling.das).toBe(DEFAULT_HANDLING.das);
      expect(second.pendingSubmissionCount("author-1")).toBe(1);
    } finally {
      second.close();
    }
  });

  test("cannot name a player who does not exist", () => {
    // Foreign keys are on per connection, so this is what makes
    // `recordSubmission`'s `upsertPlayer` load-bearing rather than tidy. A
    // submission whose author has no row is one the review queue cannot show.
    const store = new Store(path);
    try {
      const db = new Database(path);
      db.run("PRAGMA foreign_keys = ON");
      expect(() =>
        db.run(
          `INSERT INTO submissions (player_id, author_name, title, goal, claimed_difficulty,
                                    board, queue, target_attack, solution, events, handling,
                                    pieces_placed, clears, status, created_at)
           VALUES ('nobody', 'Nobody', 't', 'g', 1, '[]', '[]', 1, '[]', '[]', '{}', 0, '[]',
                   'pending', 1)`,
        ),
      ).toThrow(/FOREIGN KEY/i);
      db.close();
      expect(store.pendingSubmissions().length).toBe(0);
    } finally {
      store.close();
    }
  });

  test("refuses a second accepted puzzle under one archive id", () => {
    // `PuzzleArchive` builds a Map by id, so a duplicate resolves silently for
    // a lookup while both copies stay in the array and in the rush pool — and
    // `runs.puzzle_id` has no foreign key, so the two puzzles' play history
    // merges with no complaint. The index is the only thing that says no.
    const store = new Store(path);
    try {
      const first = store.recordSubmission(draft("First"));
      const second = store.recordSubmission(draft("Second"));
      const decision = { status: "accepted", reviewedBy: "an officer", note: null, difficulty: 5 } as const;
      store.decideSubmission(first.submissionId, { ...decision, puzzleId: 100_001 });
      expect(() =>
        store.decideSubmission(second.submissionId, { ...decision, puzzleId: 100_001 }),
      ).toThrow(/UNIQUE/i);
      // Rejections all carry a null puzzle id, and a unique index that counted
      // them would let exactly one puzzle ever be turned down.
      store.decideSubmission(second.submissionId, {
        status: "rejected",
        reviewedBy: "an officer",
        note: null,
        puzzleId: null,
        difficulty: null,
      });
      const third = store.recordSubmission(draft("Third"));
      expect(() =>
        store.decideSubmission(third.submissionId, {
          status: "rejected",
          reviewedBy: "an officer",
          note: null,
          puzzleId: null,
          difficulty: null,
        }),
      ).not.toThrow();
    } finally {
      store.close();
    }
  });
});
