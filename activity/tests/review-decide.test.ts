/**
 * Accepting a submission makes it a real puzzle — in the archive, and in the
 * rotation everybody plays.
 *
 * Two things are pinned here and they fail in different directions.
 *
 * The first is the **rotation invariant**, and it is the reason the owner could
 * choose full rotation at all. The daily and the rush are derived from the
 * pool's *size*, so one extra puzzle re-deals almost every day that has already
 * been played and almost every rush stack ever handed out. `DaySchedule` pins a
 * day the first time anybody asks for it, which is supposed to make growth
 * safe — supposed to, until something proves it end to end, through a real
 * accept and a real restart, rather than through a synthetic pool appended to a
 * file. That is what the last block below does, and it is the most important
 * test in this file.
 *
 * The second is **re-verification at accept**. `recordSubmission` writes what it
 * is given, `boardProblem` never looks at a solution and `assertValid` says
 * outright that it does not, so a row whose stored solve does not solve its
 * stored board would reach the archive with an unreachable target and a reveal
 * that plays a line which does not work. Replaying the stored log is the only
 * thing between those two, and it is why `events` is a column.
 *
 * The store here is a real one on a temporary file, and the app is a throwaway
 * carrying the real error handler — the same shape `tests/review-auth.test.ts`
 * uses, for the same reason: the review routes take their secret as an argument
 * precisely so a test does not have to fight one process's single import of
 * `server/config.ts` for it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";
import {
  COMMUNITY_ID_BASE,
  type Mino,
  type Puzzle,
  type RowCode,
  type SolutionStep,
  toListing,
} from "../shared/puzzle";
import { dailyRushSeed, rushSequence } from "../shared/rush";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import type { InputEvent } from "../shared/tetris/verify";
// Type-only, so nothing under `server/` is loaded before `beforeAll` has set the
// environment `config` reads once at import.
import type { Store } from "../server/db";
import type { AppRouter, Variables } from "../server/http";
import type { PuzzleArchive } from "../server/puzzles";
import type { DaySchedule } from "../server/schedule";
import type { SubmissionDraft } from "../server/submissions";

/** The club's real archive. The measured numbers below are about this file. */
const PUZZLES = "data/puzzles.json";

/**
 * The path every other route-driving file in this suite settles on.
 *
 * Set so that whichever file imports `server/config.ts` first — possibly this
 * one — settles it to the same place they all expect. Nothing here opens it;
 * the store below lives in a directory of its own.
 */
const SHARED_DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);
const BASE = "http://localhost";
const SECRET = "review-secret-that-is-only-a-review-secret";

let StoreClass: typeof import("../server/db").Store;
let PuzzleArchiveClass: typeof import("../server/puzzles").PuzzleArchive;
let DayScheduleClass: typeof import("../server/schedule").DaySchedule;
let pastDaysOf: typeof import("../server/schedule").pastDaysOf;
let registerReviewRoutes: typeof import("../server/review-routes").registerReviewRoutes;
let apiError: typeof import("../server/http").apiError;
let mintReviewToken: typeof import("../server/review-token").mintReviewToken;

beforeAll(async () => {
  process.env.DATABASE_PATH = SHARED_DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  ({ Store: StoreClass } = await import("../server/db"));
  ({ PuzzleArchive: PuzzleArchiveClass } = await import("../server/puzzles"));
  ({ DaySchedule: DayScheduleClass, pastDaysOf } = await import("../server/schedule"));
  ({ registerReviewRoutes } = await import("../server/review-routes"));
  ({ apiError } = await import("../server/http"));
  ({ mintReviewToken } = await import("../server/review-token"));
});

// ── The submission ───────────────────────────────────────────────────────────

/**
 * Two rows one cell wide of each other, and one O to fill them.
 *
 * The whole solve is a single hard drop, because the O spawns over columns 4
 * and 5 and that is exactly where the gap is — so this file needs no
 * pathfinder, no engine import and no builder to produce a log the server will
 * replay and agree with. The third row survives, or an empty board would make
 * this a perfect clear worth eleven attack instead of a plain double worth one,
 * and a fixture whose number moves when the attack table is retuned is a
 * fixture that will fail for the wrong reason.
 */
const SLOT_BOARD: readonly RowCode[] = ["GGGG..GGGG", "GGGG..GGGG", "GG........"];
const SLOT_QUEUE: readonly Mino[] = ["O"];
const SLOT_ATTACK = 1;
const SLOT_SOLUTION: readonly SolutionStep[] = [
  {
    piece: "O",
    cells: [
      [4, 1],
      [5, 1],
      [4, 0],
      [5, 0],
    ],
    clear: "double",
    attack: SLOT_ATTACK,
  },
];

const HARD_DROP: readonly InputEvent[] = [
  { frame: 0, type: "keydown", data: { key: "hardDrop", subframe: 0 } },
  { frame: 1, type: "keyup", data: { key: "hardDrop", subframe: 0 } },
];

/**
 * The same board with one more cell painted into it after the solve was made.
 *
 * Design hazard 2, exactly: the author plays, edits, and submits. The O now
 * lands a row higher and clears one line for no attack, so the stored
 * `target_attack` of 1 describes a board that no longer exists.
 */
const REPAINTED_BOARD: readonly RowCode[] = ["GGGG.GGGGG", "GGGG..GGGG", "GG........"];

/**
 * A row as `recordSubmission` writes it — which is to say, unverified.
 *
 * The route is the only writer that derives `targetAttack` and `solution` from
 * a replay; the store takes what it is handed. That is what lets a test forge
 * the one shape the accept route exists to refuse, and it is also the shape a
 * stale client log would really produce.
 */
function draft(overrides: Partial<SubmissionDraft> = {}): SubmissionDraft {
  return {
    player: { id: "ada", username: "Ada", avatarUrl: null },
    guildId: "g1",
    title: "Two rows, one O",
    goal: "Clear both rows",
    claimedDifficulty: 2,
    board: SLOT_BOARD,
    queue: SLOT_QUEUE,
    hold: null,
    targetAttack: SLOT_ATTACK,
    solution: SLOT_SOLUTION,
    events: HARD_DROP,
    handling: DEFAULT_HANDLING,
    piecesPlaced: 1,
    clears: ["double"],
    ...overrides,
  };
}

// ── A server start ───────────────────────────────────────────────────────────

let dir: string;
let databasePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-decide-"));
  databasePath = join(dir, "daily.sqlite");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Opened {
  readonly archive: PuzzleArchive;
  readonly store: Store;
  readonly schedule: DaySchedule;
}

/**
 * Everything `server/index.ts` does at module scope, in the order it does it.
 *
 * Store, then archive out of the club's file *and* this database, then the
 * backfill. Written out rather than imported because importing the server would
 * open the suite's shared database and take its configuration; keeping the
 * order here means a future edit that reversed it in `server/index.ts` would
 * not be caught by this file — so the comment there is what guards that, and
 * this is what proves the order works.
 *
 * Two of these never overlap. Nothing sets `busy_timeout`, so a second writer
 * on one file fails instantly rather than waiting.
 */
function open(): Opened {
  const store = new StoreClass(databasePath);
  const archive = PuzzleArchiveClass.load(PUZZLES, {}, store.acceptedPuzzles());
  store.pinPastDays(pastDaysOf(archive));
  return { archive, store, schedule: new DayScheduleClass(archive, store) };
}

function reviewApp(store: Store, archive?: PuzzleArchive): AppRouter {
  const app = new Hono<{ Variables: Variables }>();
  app.onError(apiError);
  // The archive is only reached for by the correction routes, which are
  // `tests/review-override.test.ts`'s subject; an empty one here keeps this
  // file's `open()` from having to hand one through every decision.
  registerReviewRoutes(app, {
    secret: SECRET,
    store,
    archive: archive ?? { originals: [], original: () => undefined },
  });
  return app;
}

async function decide(
  store: Store,
  verdict: "accept" | "reject",
  id: number | string,
  body: unknown,
  token?: string,
): Promise<Response> {
  const bearer = token ?? (await mintReviewToken(SECRET, "hannah"));
  return reviewApp(store).fetch(
    new Request(`${BASE}/api/review/submissions/${id}/${verdict}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    }),
  );
}

interface Verdict {
  readonly submissionId: number;
  readonly status: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: number | null;
  readonly note: string | null;
  readonly puzzleId: number | null;
  readonly difficulty: number | null;
}

async function decidedBy(response: Response): Promise<Verdict> {
  return ((await response.json()) as { decided: Verdict }).decided;
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

// ── Deciding ─────────────────────────────────────────────────────────────────

describe("an officer's verdict", () => {
  test("accepting records who, when, the note and an id from the community band", async () => {
    const { store } = open();
    try {
      const filed = store.recordSubmission(draft());
      const before = Date.now();
      const response = await decide(store, "accept", filed.submissionId, {
        difficulty: 6,
        note: "Lovely little opener.",
      });
      expect(response.status).toBe(200);

      const decided = await decidedBy(response);
      expect(decided.status).toBe("accepted");
      // The grant's subject, not anything the body said. It is an attribution
      // rather than an identity — nothing validates who ran the CLI — and it is
      // the only actor column this schema has.
      expect(decided.reviewedBy).toBe("hannah");
      expect(decided.reviewedAt).toBeGreaterThanOrEqual(before);
      expect(decided.note).toBe("Lovely little opener.");
      expect(decided.puzzleId).toBe(COMMUNITY_ID_BASE);
      // The reviewer's rating, not the author's claim of 2. Under full rotation
      // this number routes: `dailyTierOf` reads it for a tier and `rushBand`
      // for a rung, which is exactly why it is not the submitter's to set.
      expect(decided.difficulty).toBe(6);
      expect(store.submission(filed.submissionId)!.claimedDifficulty).toBe(2);
    } finally {
      store.close();
    }
  });

  test("rejecting records the reason, and allocates nothing", async () => {
    const { store } = open();
    try {
      const filed = store.recordSubmission(draft());
      const decided = await decidedBy(
        await decide(store, "reject", filed.submissionId, { note: "We have three of these." }),
      );
      expect(decided.status).toBe("rejected");
      expect(decided.reviewedBy).toBe("hannah");
      expect(decided.note).toBe("We have three of these.");
      // A rejected puzzle never becomes one, so it never takes an id — and the
      // band is not advanced by a refusal either.
      expect(decided.puzzleId).toBeNull();
      expect(decided.difficulty).toBeNull();
      expect(store.acceptedPuzzles()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("will not reject without a reason", async () => {
    // The rejection note is the only thing an author ever hears back about a
    // puzzle they wrote. An empty textarea is "no note", and "no note" is not
    // an answer to give somebody.
    const { store } = open();
    try {
      const filed = store.recordSubmission(draft());
      for (const body of [{}, { note: "   " }, { note: null }]) {
        const response = await decide(store, "reject", filed.submissionId, body);
        expect(response.status).toBe(400);
        expect(await errorOf(response)).toContain("needs a reason");
      }
      expect(store.submission(filed.submissionId)!.status).toBe("pending");
    } finally {
      store.close();
    }
  });

  test("accepts without a note, because the puzzle appearing is the message", async () => {
    const { store } = open();
    try {
      const filed = store.recordSubmission(draft());
      const decided = await decidedBy(
        await decide(store, "accept", filed.submissionId, { difficulty: 4 }),
      );
      expect(decided.status).toBe("accepted");
      expect(decided.note).toBeNull();
    } finally {
      store.close();
    }
  });

  test("refuses a rating off the archive's own scale", async () => {
    // 1..20 is the one difficulty range this repo enforces, and the reviewer's
    // number goes straight onto the puzzle. A 0 would read as "unrated", which
    // `dailyTierOf` files as hard.
    const { store } = open();
    try {
      const filed = store.recordSubmission(draft());
      for (const difficulty of [0, 21, -1, Number.NaN, "6", undefined]) {
        const response = await decide(store, "accept", filed.submissionId, { difficulty });
        expect(response.status).toBe(400);
        expect(await errorOf(response)).toContain("between 1 and 20");
      }
      expect(store.submission(filed.submissionId)!.status).toBe("pending");
    } finally {
      store.close();
    }
  });

  test("both decisions are terminal, and say who got there first", async () => {
    // Two officers can hold links at once and nothing coordinates them. Without
    // the `status = 'pending'` guard on the UPDATE the second click would
    // overwrite the first one's note, rating and allocated id, and the row
    // would still look like a clean decision.
    const { store } = open();
    try {
      const filed = store.recordSubmission(draft());
      await decide(store, "reject", filed.submissionId, { note: "Not this one." });

      const second = await decide(store, "accept", filed.submissionId, { difficulty: 5 });
      expect(second.status).toBe(409);
      expect(await errorOf(second)).toContain("already rejected by hannah");

      const stored = store.submission(filed.submissionId)!;
      expect(stored.status).toBe("rejected");
      expect(stored.puzzleId).toBeNull();
    } finally {
      store.close();
    }
  });

  test("refuses an id that names nothing, and one that is not an id", async () => {
    const { store } = open();
    try {
      expect((await decide(store, "accept", 9999, { difficulty: 5 })).status).toBe(404);
      // `Number.parseInt("12abc")` is 12 and `Number("")` is 0, so a bare digit
      // check is what keeps either from becoming a lookup for some other row.
      // (An empty segment never gets this far — Hono has no route for it.)
      for (const id of ["12abc", "-1", "1e3"]) {
        expect((await decide(store, "accept", id, { difficulty: 5 })).status).toBe(400);
      }
    } finally {
      store.close();
    }
  });

  test("a reviewer token is what opens both, and a player's session is not", async () => {
    const { store } = open();
    try {
      const filed = store.recordSubmission(draft());
      const app = reviewApp(store);
      const naked = await app.fetch(
        new Request(`${BASE}/api/review/submissions/${filed.submissionId}/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ difficulty: 5 }),
        }),
      );
      expect(naked.status).toBe(401);
      expect(store.submission(filed.submissionId)!.status).toBe("pending");
    } finally {
      store.close();
    }
  });
});

// ── Re-verifying ─────────────────────────────────────────────────────────────

describe("the stored solve has to still solve the stored board", () => {
  test("refuses a submission whose board was repainted after the solve", async () => {
    // The bug: the author plays their puzzle, paints one more cell, and
    // submits. `recordSubmission` writes whatever it is handed, `boardProblem`
    // does not look at solutions and `assertValid` says outright that it does
    // not — so without this the puzzle ships with a target nobody can reach and
    // a reveal that plays a line which does not work.
    const { store } = open();
    try {
      const filed = store.recordSubmission(draft({ board: REPAINTED_BOARD }));
      const response = await decide(store, "accept", filed.submissionId, { difficulty: 5 });
      expect(response.status).toBe(409);
      const said = await errorOf(response);
      expect(said).toContain("does not match its stored board");
      // Both halves of the disagreement, in the message: an officer reading it
      // has no other way to tell a stale board from a truncated log.
      expect(said).toContain("0 attack");
      expect(said).toContain(`${SLOT_ATTACK} in 1 on file`);

      expect(store.submission(filed.submissionId)!.status).toBe("pending");
      expect(store.acceptedPuzzles()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("refuses one whose piece count was written down wrong", async () => {
    // Attack and placement count, because either alone matches by accident: a
    // repainted board usually moves the attack, and a truncated log usually
    // does not move it at all while dropping pieces off the end.
    const { store } = open();
    try {
      const filed = store.recordSubmission(draft({ piecesPlaced: 4 }));
      const response = await decide(store, "accept", filed.submissionId, { difficulty: 5 });
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toContain("1 pieces");
    } finally {
      store.close();
    }
  });

  test("a submission that cannot be replayed at all is a conflict, not a bad request", async () => {
    // The malformed run is in this server's own database, not in the officer's
    // request, and `apiError` would call an `InvalidRunError` a 400 — which
    // reads as "you sent something wrong" to the one person who did not.
    const { store } = open();
    try {
      // Frames that go backwards: a shape `parseInputLog` refuses and the
      // replay would simply have ignored, quietly agreeing with the row.
      const filed = store.recordSubmission(
        draft({
          events: [
            { frame: 5, type: "keydown", data: { key: "hardDrop", subframe: 0 } },
            { frame: 1, type: "keyup", data: { key: "hardDrop", subframe: 0 } },
          ],
        }),
      );
      const response = await decide(store, "accept", filed.submissionId, { difficulty: 5 });
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toContain("no longer replays");
    } finally {
      store.close();
    }
  });

  /**
   * ADDED BY REVIEW — currently RED.
   *
   * `server/review-routes.ts` says at the top that its two guards are here
   * "rather than at load time, because `PuzzleArchive.load` runs at module
   * scope and throws — a row that only fails on the way *out* takes the whole
   * server down at boot instead of failing one puzzle". It then runs exactly
   * one of `assertValid`'s three checks. `boardProblem` is covered;
   * `targetAttack > 0` is not.
   *
   * A row whose solve clears nothing replays perfectly — attack 0 equals the
   * stored 0 and one placement equals the stored one — so `reverify` agrees
   * with it and the accept is a 200. `assertValid` then refuses it at the next
   * start, inside `PuzzleArchive.load`, at module scope: the server does not
   * boot, and it is not the review routes that stop working, it is every route.
   * The only way back is editing the database by hand.
   *
   * Unreachable through `POST /api/submissions` today, which refuses a solve
   * sending no attack — which is precisely why this belongs where the *other*
   * defence-in-depth checks in this route already are.
   */
  test("refuses a row whose target attack is not a target", async () => {
    const { store } = open();
    try {
      // A board with no full row in reach: the O drops into columns 4 and 5,
      // clears nothing, and the whole run sends zero.
      const filed = store.recordSubmission(
        draft({
          board: ["GG........"],
          targetAttack: 0,
          piecesPlaced: 1,
          clears: [],
          solution: [
            {
              piece: "O",
              cells: [
                [4, 1],
                [5, 1],
                [4, 0],
                [5, 0],
              ],
              clear: null,
              attack: 0,
            },
          ],
        }),
      );
      const response = await decide(store, "accept", filed.submissionId, { difficulty: 5 });
      expect(response.status).toBe(409);
      expect(store.acceptedPuzzles()).toHaveLength(0);
      // The punchline, and the reason this is a 409 and not a shrug: what the
      // accept let through is what the next boot dies on.
      expect(() => PuzzleArchiveClass.load(PUZZLES, {}, store.acceptedPuzzles())).not.toThrow();
    } finally {
      store.close();
    }
  });

  /**
   * ADDED BY REVIEW — currently RED.
   *
   * `reverify` replays the stored log and then throws the replay away. It
   * compares two scalars — the attack and the placement count — and the archive
   * is handed `submission.solution`, the column, which nothing ever checked
   * against the board it belongs to. Its own doc calls itself "the one thing
   * between a row somebody edited and the engine", and for the one field that
   * *is* the answer key it is not.
   *
   * So a row whose numbers agree and whose `solution` does not is accepted, and
   * `/api/archive/:id` then serves that column as the reveal: a puzzle whose
   * stored solution does not solve its stored board, in the archive, exactly the
   * shape design §8 hazard 2 names.
   *
   * The smallest fix is also the better one: `reverify` already has
   * `verified.placements`, which is a `SolutionStep[]` one `frame` key away —
   * either refuse a row that disagrees with it, or write it in place of the
   * column, the way `POST /api/submissions` writes the server's own reading
   * rather than the body's.
   */
  test("refuses a row whose solution column is not the solve it replayed", async () => {
    const { store } = open();
    try {
      // Attack and placement count both agree with the replay; the placements
      // themselves are an I-piece that could never have been dealt here.
      const filed = store.recordSubmission(
        draft({
          solution: [
            {
              piece: "I",
              cells: [
                [0, 0],
                [1, 0],
                [2, 0],
                [3, 0],
              ],
              clear: "quad",
              attack: SLOT_ATTACK,
            },
          ],
        }),
      );
      const response = await decide(store, "accept", filed.submissionId, { difficulty: 5 });
      expect(response.status).toBe(409);
      expect(store.acceptedPuzzles()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("rejecting a broken submission still works", async () => {
    // No replay on the way out. Demanding one would make the broken submissions
    // the only ones nobody could ever clear from the queue.
    const { store } = open();
    try {
      const filed = store.recordSubmission(draft({ board: REPAINTED_BOARD }));
      const response = await decide(store, "reject", filed.submissionId, {
        note: "Your solve does not fit this board any more — resubmit from the one you played.",
      });
      expect(response.status).toBe(200);
      expect((await decidedBy(response)).status).toBe("rejected");
    } finally {
      store.close();
    }
  });
});

// ── Joining the archive ──────────────────────────────────────────────────────

describe("an accepted puzzle is a real puzzle at the next start", () => {
  test("carries its own solution, its author, and the reviewer's rating", async () => {
    const first = open();
    let puzzleId = 0;
    try {
      const filed = first.store.recordSubmission(draft());
      const decided = await decidedBy(
        await decide(first.store, "accept", filed.submissionId, { difficulty: 6 }),
      );
      puzzleId = decided.puzzleId!;
    } finally {
      first.store.close();
    }

    const second = open();
    try {
      const puzzle = second.archive.get(puzzleId)!;
      expect(puzzle).toBeDefined();
      expect(puzzle.title).toBe("Two rows, one O");
      // The name as it was when they filed, so a later rename cannot rewrite
      // credit for a puzzle already in the archive.
      expect(puzzle.author).toBe("Ada");
      expect(puzzle.difficulty).toBe(6);
      expect(puzzle.targetAttack).toBe(SLOT_ATTACK);
      // The answer key rides on the row. This is the whole reason an accepted
      // puzzle needs no `data/solutions.json` entry — that file is written
      // wholesale by `bun run puzzles` and is not tracked.
      expect(puzzle.solution).toEqual(SLOT_SOLUTION);
      // Sets are the club's groupings of the club's own sheet. The id band is
      // what says where this one came from.
      expect(puzzle.set).toBeNull();
      expect(toListing(puzzle).community).toBe(true);
      expect(toListing(second.archive.get(1)!).community).toBe(false);
    } finally {
      second.store.close();
    }
  });

  test("refuses an archive in which two puzzles claim one id", () => {
    // Silent and terrible rather than loud: the archive keys by id into a Map,
    // so a duplicate resolves cleanly for a lookup while both copies stay in
    // the array the rotation indexes and the rush pool is filtered out of —
    // and `runs.puzzle_id` has no foreign key to merge two histories under.
    const club: Puzzle[] = JSON.parse(readFileSync(PUZZLES, "utf8")).puzzles;
    const stolen: Puzzle = {
      id: club[0]!.id,
      title: "Two rows, one O",
      author: "Ada",
      difficulty: 6,
      goal: "Clear both rows",
      set: null,
      board: SLOT_BOARD,
      queue: SLOT_QUEUE,
      hold: null,
      targetAttack: SLOT_ATTACK,
    };
    expect(() => PuzzleArchiveClass.load(PUZZLES, {}, [stolen])).toThrow(
      new RegExp(`claim id ${club[0]!.id}`),
    );
  });
});

// ── The invariant this whole design rests on ─────────────────────────────────

const finishedDays = (archive: PuzzleArchive): number[] =>
  Array.from({ length: archive.currentDay() }, (_, index) => index + 1);

const dealtBy = (schedule: DaySchedule, day: number): number[] =>
  DAILY_TIERS.map((tier) => schedule.forTier(day, tier).id);

const derivedBy = (archive: PuzzleArchive, day: number): number[] =>
  DAILY_TIERS.map((tier) => archive.forTier(day, tier).id);

const stackFor = (pool: readonly Puzzle[], day: number): number[] =>
  rushSequence(pool, dailyRushSeed(day)).map((puzzle) => puzzle.id);

describe("accepting a puzzle does not move a day anybody has played", () => {
  test("every finished day and every pinned rush pool survives the acceptance", async () => {
    // THE test. The owner chose to let accepted puzzles into the daily and the
    // rush, against the design's own recommendation, and the pinning in
    // `DaySchedule` is the entire reason that is safe. Measured on this
    // archive: one extra easy-band puzzle re-deals the easy puzzle for most
    // days ever played, and one extra rush-eligible puzzle moves 38 of the 40
    // slots in every stack ever handed out. If a pin ever stops holding, a
    // finished leaderboard starts ranking people against a puzzle the server
    // insists was never theirs — silently, because nothing in a derivation can
    // tell it is answering about a day somebody already played.
    const first = open();
    const today = first.archive.currentDay();
    const days = finishedDays(first.archive);
    const dealt = days.map((day) => dealtBy(first.schedule, day));
    // Today's is pinned by `DaySchedule`'s own constructor; yesterday's is
    // pinned here, so this covers a pool written down on some earlier start as
    // well as the one written down on this one.
    const rushDays = [today, today - 1];
    const stacks = rushDays.map((day) => stackFor(first.schedule.rushPoolFor(day), day));
    const tomorrowBefore = derivedBy(first.archive, today + 1);

    let puzzleId = 0;
    try {
      const filed = first.store.recordSubmission(draft());
      // Rated into the easy band on purpose — that is the tier one extra
      // puzzle actually disturbs, because `byTier` partitions on difficulty
      // before the rotation ever indexes anything.
      const decided = await decidedBy(
        await decide(first.store, "accept", filed.submissionId, { difficulty: 3 }),
      );
      puzzleId = decided.puzzleId!;
    } finally {
      first.store.close();
    }

    const second = open();
    try {
      // The acceptance really did land, and really did grow the pool.
      expect(second.archive.get(puzzleId)).toBeDefined();
      expect(second.archive.puzzles.length).toBe(first.archive.puzzles.length + 1);

      // 1. Every day already played deals exactly what it dealt before.
      expect(days.map((day) => dealtBy(second.schedule, day))).toEqual(dealt);

      // 2. Every pinned rush pool deals the same forty in the same order.
      for (const [index, day] of rushDays.entries()) {
        expect(stackFor(second.schedule.rushPoolFor(day), day)).toEqual(stacks[index]!);
      }

      // The controls, and the reason neither assertion above is vacuous: the
      // untouched derivation moves for most of the archive's life, and the
      // untouched rush pool moves for every day of it.
      const moved = days.filter(
        (day) => derivedBy(second.archive, day).join() !== derivedBy(first.archive, day).join(),
      ).length;
      expect(moved).toBeGreaterThan(days.length / 2);
      expect(stackFor(second.archive.puzzles, today)).not.toEqual(stacks[0]!);

      // 3. A day nobody has reached yet is allowed to move, and here it does.
      // That is not damage — it is the whole point of accepting the puzzle, and
      // the floating edge is what "joins the rotation" means.
      const tomorrow = today + 1;
      expect(dealtBy(second.schedule, tomorrow)).toEqual(derivedBy(second.archive, tomorrow));
      expect(derivedBy(second.archive, tomorrow)).not.toEqual(tomorrowBefore);

      // 4. And it really is in the rotation, not merely in the listing: a
      // future day's rush pool is drawn from the whole eligible archive, so a
      // puzzle missing from it would be a puzzle nobody is ever dealt.
      expect(
        second.schedule.rushPoolFor(tomorrow).some((puzzle) => puzzle.id === puzzleId),
      ).toBe(true);
    } finally {
      second.store.close();
    }
  });

  test("a day pinned before the acceptance still names the puzzle it named", async () => {
    // `tierOfDay` gates the archive's answer key — a puzzle it calls "none of
    // today's" has its solution handed out on request — so a day changing its
    // mind about what it held is a live solution leak, not only a wrong recap.
    const first = open();
    const today = first.archive.currentDay();
    const easy = first.schedule.forTier(today, "easy").id;
    const played: Record<DailyTier, number> = {
      easy,
      medium: first.schedule.forTier(today, "medium").id,
      hard: first.schedule.forTier(today, "hard").id,
    };
    try {
      const filed = first.store.recordSubmission(draft());
      await decide(first.store, "accept", filed.submissionId, { difficulty: 3 });
    } finally {
      first.store.close();
    }

    const second = open();
    try {
      expect(second.schedule.tierOfDay(today, easy)).toBe("easy");
      for (const tier of DAILY_TIERS) {
        expect(second.schedule.forTier(today, tier).id).toBe(played[tier]);
      }
    } finally {
      second.store.close();
    }
  });
});
