/**
 * A puzzle's metadata can be corrected, and the correction outlives the file.
 *
 * `data/puzzles.json` is rewritten wholesale from the club's CSVs by
 * `bun run puzzles`, so the obvious fix for a typo — edit the file — is the one
 * that quietly stops being true at the next rebuild. Corrections are rows in
 * `puzzle_overrides` instead, and `PuzzleArchive.load` lays them over both
 * sources: the file, and the accepted player submissions that live in the same
 * database. The rebuild test below is the point of the whole feature.
 *
 * Two other things are pinned here and they fail in different directions.
 *
 * **A bad correction must not be able to stop the server.** `PuzzleArchive.load`
 * runs at module scope and throws, so anything that only fails on the way out
 * takes down every route for every player over one officer's typo — the exact
 * shape `server/review-routes.ts` already guards for a submission's target
 * attack. The rules live on the write, and the merge is defensive anyway.
 *
 * **A correction to a difficulty moves the rotation.** `dailyTierOf` reads it,
 * `byTier` partitions on it, and the daily rotation is an index into those
 * pools derived from their *size* — so re-rating one puzzle out of the easy
 * band re-deals the easy puzzle for almost every day that has already been
 * played. `day_puzzles` is what stops that being history rewriting itself, and
 * the last block proves it the way `tests/rotation-pin.test.ts` proves it for a
 * pool that grows: with a control showing the untouched derivation really did
 * move.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";
import { PuzzleArchive } from "../server/puzzles";
import { DaySchedule, pastDaysOf } from "../server/schedule";
import type { SubmissionDraft } from "../server/submissions";
import { DAILY_TIERS, dailyTierOf, type DailyTier } from "../shared/daily";
import type { Puzzle } from "../shared/puzzle";
import { dailyRushSeed, rushSequence } from "../shared/rush";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";

let dir: string;
let databasePath: string;
/** A copy of the club's archive, so a test may rebuild it without touching the real one. */
let clubPath: string;
/** Exactly what was written to {@link clubPath}, for proving it is still that. */
let clubFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "puzzle-override-"));
  databasePath = join(dir, "daily.sqlite");
  clubPath = join(dir, "puzzles.json");
  // The real archive rather than a fixture: the rotation block below is about
  // how a hundred and thirty-eight puzzles fall into three bands, and a
  // synthetic pool of a convenient size would not reproduce it.
  clubFile = JSON.stringify({
    puzzles: JSON.parse(readFileSync("data/puzzles.json", "utf8")).puzzles as Puzzle[],
  });
  writeFileSync(clubPath, clubFile);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Opened {
  readonly archive: PuzzleArchive;
  readonly store: Store;
  readonly schedule: DaySchedule;
}

/**
 * A server start, in the order `server/index.ts` does it.
 *
 * Store, then the archive out of the club's file *and* this database — accepted
 * puzzles and corrections both — then the backfill. Two of these never overlap:
 * nothing sets `busy_timeout`, so a second writer on one file fails instantly.
 */
function open(): Opened {
  const store = new Store(databasePath);
  const archive = PuzzleArchive.load(
    clubPath,
    {},
    store.acceptedPuzzles(),
    store.overridesFor(),
  );
  store.pinPastDays(pastDaysOf(archive));
  return { archive, store, schedule: new DaySchedule(archive, store) };
}

/** A store on its own, for the corrections a test makes between two starts. */
function withStore<T>(work: (store: Store) => T): T {
  const store = new Store(databasePath);
  try {
    return work(store);
  } finally {
    store.close();
  }
}

/**
 * A submission the store will take, with no replay behind it.
 *
 * `recordSubmission` writes what it is handed and `acceptSubmission` allocates
 * an id without looking at the solve; re-verification is the accept *route*'s
 * job and `tests/review-decide.test.ts`'s subject. What this file needs is a
 * puzzle in the archive that came out of the database rather than the file, so
 * the merge can be shown to reach both.
 */
function draft(overrides: Partial<SubmissionDraft> = {}): SubmissionDraft {
  return {
    player: { id: "ada", username: "Ada", avatarUrl: null },
    guildId: "g1",
    title: "Two rows, one O",
    goal: "Clear both rows",
    claimedDifficulty: 2,
    board: ["GGGG..GGGG", "GGGG..GGGG", "GG........"],
    queue: ["O"],
    hold: null,
    targetAttack: 1,
    solution: [{ piece: "O", cells: [[4, 1], [5, 1], [4, 0], [5, 0]], clear: "double", attack: 1 }],
    events: [{ frame: 0, type: "keydown", data: { key: "hardDrop", subframe: 0 } }],
    handling: DEFAULT_HANDLING,
    piecesPlaced: 1,
    clears: ["double"],
    ...overrides,
  };
}

/** Files a puzzle a player wrote and takes it, returning its archive id. */
function accept(store: Store, difficulty = 6): number {
  const filed = store.recordSubmission(draft());
  const decided = store.acceptSubmission(filed.submissionId, {
    reviewedBy: "hannah",
    difficulty,
    note: null,
  });
  const puzzleId = decided.submission.puzzleId;
  if (puzzleId === null) throw new Error("the accept allocated no puzzle id");
  return puzzleId;
}

// ── The table ────────────────────────────────────────────────────────────────

/** The schema as it stood before a puzzle could be corrected. */
const OLDER_SCHEMA = `
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
`;

function seedOlderDatabase(): void {
  const db = new Database(databasePath, { create: true });
  db.run(OLDER_SCHEMA);
  db.run("INSERT INTO players (id, username, avatar_url, updated_at) VALUES ('p1','Ada',NULL,1)");
  db.run(
    `INSERT INTO runs (day, player_id, guild_id, puzzle_id, solved, attack, target_attack,
                       duration_ms, total_ms, resets, pieces_placed, clears, created_at)
     VALUES (10, 'p1', 'g1', 7, 1, 4, 4, 500, 1000, 0, 4, '[]', 1)`,
  );
  db.close();
}

describe("the table arrives on a database that predates it", () => {
  test("a database with no corrections in it gains the columns, and keeps its rows", () => {
    // `CREATE TABLE IF NOT EXISTS` is the whole migration — there is no old
    // shape of this table to rebuild — so what has to be proven is that opening
    // an existing database really does add it, beside everything already there.
    seedOlderDatabase();
    const store = new Store(databasePath);
    try {
      const db = new Database(databasePath);
      const columns = db
        .query<{ name: string; pk: number }, []>("PRAGMA table_info(puzzle_overrides)")
        .all();
      expect(columns.map((column) => column.name)).toEqual([
        "puzzle_id",
        "title",
        "author",
        "goal",
        "difficulty",
        "set_name",
        "updated_at",
        "updated_by",
      ]);
      // One row per puzzle: a correction is the current state of a puzzle's
      // metadata, not a log of edits to it.
      expect(columns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
        "puzzle_id",
      ]);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(1);
      expect(store.overridesFor()).toEqual([]);
      db.close();
    } finally {
      store.close();
    }
  });

  test("a correction written by one start is there for the next", () => {
    // The point of a table rather than a file: the process that records a
    // correction is not the process that serves it.
    seedOlderDatabase();
    withStore((store) => store.setOverride(7, { title: "Corrected" }, "hannah"));
    withStore((store) => {
      expect(store.overridesFor()).toHaveLength(1);
      expect(store.overridesFor()[0]!.title).toBe("Corrected");
    });
  });
});

// ── The store ────────────────────────────────────────────────────────────────

describe("what a correction is, as a row", () => {
  test("records who and when, and leaves every field nobody named alone", () => {
    withStore((store) => {
      const before = Date.now();
      const written = store.setOverride(12, { title: "Tuck the T" }, "hannah")!;
      expect(written.puzzleId).toBe(12);
      expect(written.title).toBe("Tuck the T");
      // NULL is "use the source", which is what makes a partial correction a
      // thing a row can express at all.
      expect(written.author).toBeNull();
      expect(written.goal).toBeNull();
      expect(written.difficulty).toBeNull();
      expect(written.set).toBeNull();
      expect(written.updatedBy).toBe("hannah");
      expect(written.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  test("a second correction merges into the first rather than replacing it", () => {
    // The three states a change can put a field in — leave, clear, set — are
    // why the merge is a read-modify-write in a transaction rather than an
    // upsert: COALESCE cannot tell "leave" from "clear".
    withStore((store) => {
      store.setOverride(12, { title: "Tuck the T" }, "hannah");
      const written = store.setOverride(12, { difficulty: 9 }, "sam")!;
      expect(written.title).toBe("Tuck the T");
      expect(written.difficulty).toBe(9);
      expect(written.updatedBy).toBe("sam");
    });
  });

  test("clearing the last field takes the row with it", () => {
    // An all-null row is not a correction, and leaving one behind would make
    // "is this puzzle corrected" two questions instead of one.
    withStore((store) => {
      store.setOverride(12, { title: "Tuck the T" }, "hannah");
      expect(store.setOverride(12, { title: null }, "hannah")).toBeNull();
      expect(store.overridesFor()).toEqual([]);
    });
  });

  test("reverting says whether there was anything to revert", () => {
    withStore((store) => {
      expect(store.clearOverride(12, "reviewer")).toBe(false);
      store.setOverride(12, { title: "Tuck the T" }, "hannah");
      expect(store.clearOverride(12, "reviewer")).toBe(true);
      expect(store.overridesFor()).toEqual([]);
    });
  });
});

// ── The merge ────────────────────────────────────────────────────────────────

describe("a correction reaches both sources", () => {
  test("a club puzzle is served corrected, and still remembers what it said", () => {
    const source = open();
    const target = source.archive.puzzles[0]!;
    source.store.close();

    withStore((store) =>
      store.setOverride(target.id, { title: "Tuck the T", goal: "Clear 1 TSD" }, "hannah"),
    );

    const after = open();
    try {
      const corrected = after.archive.get(target.id)!;
      expect(corrected.title).toBe("Tuck the T");
      expect(corrected.goal).toBe("Clear 1 TSD");
      // Untouched, because nothing named them: a partial correction is the
      // ordinary case, not an edge one.
      expect(corrected.author).toBe(target.author);
      expect(corrected.difficulty).toBe(target.difficulty);
      // What the review tool shows an officer as "changed from". Every other
      // reader wants the corrected puzzle.
      expect(after.archive.original(target.id)!.title).toBe(target.title);
    } finally {
      after.store.close();
    }
  });

  test("a puzzle a player wrote is corrected by the same row, in the same pass", () => {
    // The reason there is one mechanism: accepted submissions are rows in this
    // same database and could have been UPDATEd in place, and then a correction
    // would be written one way for the club's puzzles and another for players'.
    const puzzleId = withStore((store) => accept(store));

    withStore((store) => store.setOverride(puzzleId, { author: "Ada L." }, "hannah"));

    const after = open();
    try {
      expect(after.archive.get(puzzleId)!.author).toBe("Ada L.");
      expect(after.archive.original(puzzleId)!.author).toBe("Ada");
      // The row in `submissions` is the source and is left exactly as filed —
      // the name as it was when they filed, so credit cannot be rewritten by a
      // rename, and now not by a correction to the archive either.
      expect(after.store.acceptedPuzzles()[0]!.author).toBe("Ada");
    } finally {
      after.store.close();
    }
  });

  test("a correction cannot reach anything a solve was scored against", () => {
    // The whole reason the editable set is five fields. A run is filed against
    // a puzzle_id with no record of the board it was played on, so a board or a
    // target that could be edited would silently invalidate every leaderboard
    // row standing against that puzzle and every past day that dealt it.
    const source = open();
    const target = source.archive.puzzles[0]!;
    source.store.close();

    withStore((store) => store.setOverride(target.id, { title: "Tuck the T" }, "hannah"));

    const after = open();
    try {
      const corrected = after.archive.get(target.id)!;
      expect(corrected.board).toEqual(target.board);
      expect(corrected.queue).toEqual(target.queue);
      expect(corrected.hold).toEqual(target.hold);
      expect(corrected.targetAttack).toBe(target.targetAttack);
      expect(corrected.solution).toEqual(target.solution);
    } finally {
      after.store.close();
    }
  });
});

// ── Surviving the rebuild ────────────────────────────────────────────────────

describe("a correction outlives the file it corrects", () => {
  test("`bun run puzzles` rewrites the archive and the correction still stands", () => {
    // THE test. Editing `data/puzzles.json` is the obvious way to fix a typo
    // and it is the one that quietly stops being true: the build regenerates
    // that file wholesale from the club's CSVs, so the edit is gone at the next
    // rebuild with nothing anywhere to say it ever happened.
    const source = open();
    const target = source.archive.puzzles[0]!;
    source.store.close();

    withStore((store) => store.setOverride(target.id, { title: "Tuck the T" }, "hannah"));

    // The rebuild, exactly as far as this feature is concerned: the file is
    // written again from the club's own source, knowing nothing about any
    // correction.
    writeFileSync(clubPath, clubFile);

    const after = open();
    try {
      expect(after.archive.get(target.id)!.title).toBe("Tuck the T");
    } finally {
      after.store.close();
    }
  });

  test("and the file on disk never learns about it", () => {
    // The other half: a correction that wrote itself back into the archive file
    // would be an edit the next rebuild silently reverts, which is the failure
    // this design exists to avoid rather than a second way to store it.
    const source = open();
    const target = source.archive.puzzles[0]!;
    source.store.close();

    withStore((store) => store.setOverride(target.id, { title: "Tuck the T" }, "hannah"));
    const after = open();
    try {
      expect(after.archive.get(target.id)!.title).toBe("Tuck the T");
    } finally {
      after.store.close();
    }
    expect(readFileSync(clubPath, "utf8")).toBe(clubFile);
  });
});

// ── A correction the archive cannot use ──────────────────────────────────────

describe("a bad row cannot stop the server booting", () => {
  test("a correction nothing could have written is dropped, and the source served", () => {
    // The rules are on the write, where a bad correction is a 400 to the
    // officer who typed it. This is the row nobody typed: SQLite's column types
    // are advisory, so a hand-edited `difficulty` can hold a string — and
    // `dailyTierOf` compares it, `rushBand` does arithmetic on it, and neither
    // would fail, they would just answer nonsense.
    //
    // The whole row goes rather than the offending field. Half a correction is
    // a puzzle in a state nobody ever wrote, and source-or-corrected is the
    // only pair a reader should have to reason about.
    const source = open();
    const target = source.archive.puzzles[0]!;
    source.store.close();

    withStore((store) => store.setOverride(target.id, { title: "Tuck the T" }, "hannah"));
    const db = new Database(databasePath);
    db.run("UPDATE puzzle_overrides SET difficulty = 'very hard'");
    db.close();

    const after = open();
    try {
      const served = after.archive.get(target.id)!;
      expect(served.difficulty).toBe(target.difficulty);
      expect(served.title).toBe(target.title);
    } finally {
      after.store.close();
    }
  });

  test("loading is what refuses it, not booting", () => {
    // `PuzzleArchive.load` runs at module scope and throws, so a correction
    // that failed on the way out would take down every route for every player
    // over one bad row — the same failure `server/review-routes.ts` guards a
    // submission's target attack against, and the only way back from it is
    // editing the database by hand.
    withStore((store) => store.setOverride(1, { title: "Tuck the T" }, "hannah"));
    const db = new Database(databasePath);
    db.run("UPDATE puzzle_overrides SET title = 42, difficulty = 'very hard'");
    db.close();

    const store = new Store(databasePath);
    try {
      expect(() => PuzzleArchive.load(clubPath, {}, [], store.overridesFor())).not.toThrow();
    } finally {
      store.close();
    }
  });

  test("a correction for a puzzle that is not in the archive is inert", () => {
    // There is no foreign key on `puzzle_id` — club puzzles live in a JSON file
    // and there is no parent row to reference — so the merge has to be the
    // thing that ignores an id nothing holds. The PATCH route is where somebody
    // is told, at the one moment they can still act on it.
    withStore((store) => store.setOverride(999_999, { title: "Nowhere" }, "hannah"));
    const opened = open();
    try {
      expect(opened.archive.get(999_999)).toBeUndefined();
      expect(opened.archive.puzzles.some((puzzle) => puzzle.title === "Nowhere")).toBe(false);
    } finally {
      opened.store.close();
    }
  });
});

// ── What a correction does to the rotation ───────────────────────────────────

const finishedDays = (archive: PuzzleArchive): number[] =>
  Array.from({ length: archive.currentDay() }, (_, index) => index + 1);

const dealtBy = (schedule: DaySchedule, day: number): number[] =>
  DAILY_TIERS.map((tier) => schedule.forTier(day, tier).id);

const derivedBy = (archive: PuzzleArchive, day: number): number[] =>
  DAILY_TIERS.map((tier) => archive.forTier(day, tier).id);

describe("correcting a difficulty moves the rotation, and never a day already dealt", () => {
  test("every day already played deals exactly what it dealt before", () => {
    // The consequence stated in `PATCH /api/review/puzzles/:id`, proven here.
    // `dailyTierOf` reads the difficulty and `byTier` partitions on it, and the
    // rotation is an index into those pools derived from their *size* — so one
    // puzzle re-rated out of the easy band re-deals the easy puzzle for most
    // days the club has ever played. `day_puzzles` is the only reason that is
    // not history rewriting itself, and a finished leaderboard ranking people
    // against a puzzle the server insists was never theirs is what it costs.
    const before = open();
    const days = finishedDays(before.archive);
    const dealt = days.map((day) => dealtBy(before.schedule, day));
    const easy = before.archive.puzzles.find((puzzle) => dailyTierOf(puzzle) === "easy")!;
    before.store.close();

    withStore((store) => store.setOverride(easy.id, { difficulty: 15 }, "hannah"));

    const after = open();
    try {
      // The correction really landed, and really did move the puzzle's band.
      expect(dailyTierOf(after.archive.get(easy.id)!)).toBe("hard");
      expect(days.map((day) => dealtBy(after.schedule, day))).toEqual(dealt);

      // The control, and the reason the assertion above is not vacuous: the
      // untouched derivation moves for most of the archive's life.
      const moved = days.filter(
        (day) => derivedBy(after.archive, day).join() !== derivedBy(before.archive, day).join(),
      ).length;
      expect(moved).toBeGreaterThan(days.length / 2);
    } finally {
      after.store.close();
    }
  });

  test("a day nobody has reached yet deals from the corrected pools", () => {
    // The other half of the bargain, and the reason to correct a rating at all:
    // a puzzle rated wrong goes on being dealt in the wrong tier until the
    // correction reaches a day that has not happened yet.
    const before = open();
    const tomorrow = before.archive.currentDay() + 1;
    const wasDealt = derivedBy(before.archive, tomorrow);
    const easy = before.archive.puzzles.find((puzzle) => dailyTierOf(puzzle) === "easy")!;
    before.store.close();

    withStore((store) => store.setOverride(easy.id, { difficulty: 15 }, "hannah"));

    const after = open();
    try {
      expect(dealtBy(after.schedule, tomorrow)).toEqual(derivedBy(after.archive, tomorrow));
      expect(derivedBy(after.archive, tomorrow)).not.toEqual(wasDealt);
    } finally {
      after.store.close();
    }
  });

  test("a day pinned before the correction still names the puzzle it named", () => {
    // `tierOfDay` gates the archive's answer key — a puzzle it calls "none of
    // today's" has its solution handed out on request — so a day changing its
    // mind about what it held is a live solution leak, not only a wrong recap.
    const before = open();
    const today = before.archive.currentDay();
    const played: Record<DailyTier, number> = {
      easy: before.schedule.forTier(today, "easy").id,
      medium: before.schedule.forTier(today, "medium").id,
      hard: before.schedule.forTier(today, "hard").id,
    };
    before.store.close();

    withStore((store) => store.setOverride(played.easy, { difficulty: 15 }, "hannah"));

    const after = open();
    try {
      expect(after.schedule.tierOfDay(today, played.easy)).toBe("easy");
      for (const tier of DAILY_TIERS) {
        expect(after.schedule.forTier(today, tier).id).toBe(played[tier]);
      }
      // And the day still deals the puzzle by its corrected name, because the
      // pin is an id: a correction shows up everywhere, a rotation does not.
      expect(after.schedule.forTier(today, "easy").difficulty).toBe(15);
    } finally {
      after.store.close();
    }
  });
});

// ── What a correction does to a rush already dealt ───────────────────────────

describe("correcting a difficulty must not re-deal a rush that is already out", () => {
  test("the same day and the same seed re-derive the same stack, in the same order", () => {
    // `day_rush` pins a day's rush pool the first time anybody asks, and
    // `DaySchedule`'s own header says why: the ticket carries a seed and no
    // pool identity, so a deploy inside the five-minute window used to score an
    // in-flight run against a different set of forty puzzles.
    //
    // The pin freezes the pool's MEMBERSHIP. It does not freeze its ORDER:
    // `rushSequence` shuffles the pinned pool by the ticket's seed and then
    // sorts the forty it drew by `rushBand`, which reads `difficulty` — and
    // difficulty is now a field an officer can correct. So a correction plus
    // the restart that carries it re-derives a different stack from the same
    // pinned pool and the same ticket, and `POST /api/rush/run` replays each
    // segment against `puzzles[index]` — a plausible wrong score, with no error
    // anywhere, which is the exact failure the pin exists to prevent.
    const before = open();
    const day = before.archive.currentDay();
    const seed = dailyRushSeed(day);
    const pool = before.schedule.rushPoolFor(day).map((puzzle) => puzzle.id);
    const dealt = rushSequence(before.schedule.rushPoolFor(day), seed).map((p) => p.id);
    // A puzzle the stack actually holds, and one a re-rating really moves: a
    // correction to something the rush never drew could not reorder anything.
    const target = before.archive.puzzles.find(
      (puzzle) => dealt.includes(puzzle.id) && dailyTierOf(puzzle) === "easy",
    )!;
    before.store.close();

    withStore((store) => store.setOverride(target.id, { difficulty: 20 }, "hannah"));

    const after = open();
    try {
      // The pin held, which is the half that works: the same puzzles are in it.
      expect(after.schedule.rushPoolFor(day).map((puzzle) => puzzle.id)).toEqual(pool);
      // And the stack drawn from it is the stack that was handed out. This is
      // what `sequenceFor(ticket)` re-derives to check a run it never watched.
      expect(rushSequence(after.schedule.rushPoolFor(day), seed).map((p) => p.id)).toEqual(dealt);
    } finally {
      after.store.close();
    }
  });
});

// ── A correction that stops the server, and cannot be taken back ─────────────

describe("a correction cannot be allowed to empty a tier", () => {
  test("re-rating a whole band out of itself does not take the next boot with it", () => {
    // The promise this feature makes, in `server/puzzles.ts`, in the PATCH
    // route's doc and in the README: a correction the archive cannot use is
    // dropped and the source served, because `PuzzleArchive.load` runs at
    // module scope and throws, and a rule enforced only at the merge would take
    // every route down for every player over one officer's edit.
    //
    // The constructor's own invariant — a day needs one puzzle of each tier —
    // is enforced nowhere on the write. `readReviewedDifficulty` cannot see the
    // archive; `overrideProblem` judges one row at a time; and `byTier` is read
    // in the constructor, which throws. Every PATCH below is an ordinary 200:
    // 20 is inside the 1..20 scale the route accepts.
    //
    // And the documented way back does not exist. `DELETE
    // /api/review/puzzles/:id/override` is registered long after the archive is
    // built, so the route that reverts this lives in the server this stops from
    // booting; recovery is editing SQLite by hand on the VPS.
    const before = open();
    const easy = before.archive.puzzles.filter((puzzle) => dailyTierOf(puzzle) === "easy");
    before.store.close();

    withStore((store) => {
      for (const puzzle of easy) store.setOverride(puzzle.id, { difficulty: 20 }, "hannah");
    });

    const store = new Store(databasePath);
    try {
      expect(() => PuzzleArchive.load(clubPath, {}, [], store.overridesFor())).not.toThrow();
    } finally {
      store.close();
    }
  });
});
