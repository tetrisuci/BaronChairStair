/**
 * The three routes an officer corrects a puzzle through.
 *
 * A correction is the second kind of write behind the reviewer's door and it is
 * not like the first: an accept creates a puzzle, a PATCH here changes five
 * fields of one that already exists and that people have already been scored
 * against. So two things are pinned, and they fail in opposite directions.
 *
 * **What may be corrected, and what may not.** `board`, `queue`, `hold`,
 * `targetAttack` and `solution` are what a puzzle *is*: a run is filed against a
 * `puzzle_id` with no record of the board it was played on, so editing one would
 * silently invalidate every leaderboard row standing against it. A body naming
 * one of them is refused rather than quietly ignored — a 200 to an officer who
 * believes they have just fixed a board is the one outcome worse than saying no.
 *
 * **A bad correction is a 400 here, not a dead server later.**
 * `PuzzleArchive.load` runs at module scope and throws, so a rule enforced only
 * at the merge would take down every route for every player over one typo. The
 * rules are on the write, and every one of them is the rule the submission route
 * already holds its own fields to.
 *
 * The archive these routes are handed is the one this process booted with, and
 * it cannot change — so the effective values in every response are computed from
 * the source and the row on file rather than read off it. "answers with what the
 * next boot will serve, before the next boot" is the test for that, and it is
 * the one that would fail if somebody rendered the page from `archive.get`.
 *
 * The store is a real one on a temporary file and the app is a throwaway
 * carrying the real error handler — the shape `tests/review-decide.test.ts`
 * uses, for the reason its own header gives.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMUNITY_ID_BASE } from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
// Type-only, so nothing under `server/` is loaded before `beforeAll` has set the
// environment `config` reads once at import.
import type { Store } from "../server/db";
import type { AppRouter, Variables } from "../server/http";
import type { PuzzleArchive } from "../server/puzzles";
import type { SubmissionDraft } from "../server/submissions";

/** The club's real archive: the list these routes hand over is this file. */
const PUZZLES = "data/puzzles.json";

/** The path every other route-driving file in this suite settles on. */
const SHARED_DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);
const BASE = "http://localhost";
const SECRET = "review-secret-that-is-only-a-review-secret";

let StoreClass: typeof import("../server/db").Store;
let PuzzleArchiveClass: typeof import("../server/puzzles").PuzzleArchive;
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
  ({ registerReviewRoutes } = await import("../server/review-routes"));
  ({ apiError } = await import("../server/http"));
  ({ mintReviewToken } = await import("../server/review-token"));
});

// ── A server start ───────────────────────────────────────────────────────────

let dir: string;
let store: Store;
let archive: PuzzleArchive;
let app: AppRouter;

/** The first club puzzle, as its source has it. Every correction below is about it. */
interface Target {
  readonly id: number;
  readonly title: string;
  readonly author: string;
  readonly goal: string;
  readonly difficulty: number;
}
let target: Target;

/**
 * A start: the archive out of the club's file *and* this database, and the
 * routes on a throwaway app.
 *
 * A function rather than four lines of `beforeEach`, because a puzzle accepted
 * after this has run is not in the archive this has built — `PuzzleArchive.load`
 * runs once at module scope in the real server and a restart is what picks an
 * accepted puzzle up. A test that wants one in the list has to start again, and
 * saying so out loud is better than a fixture that quietly did it.
 */
function boot(): void {
  archive = PuzzleArchiveClass.load(PUZZLES, {}, store.acceptedPuzzles(), store.overridesFor());
  app = new Hono<{ Variables: Variables }>();
  app.onError(apiError);
  registerReviewRoutes(app, { secret: SECRET, store, archive });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-override-"));
  store = new StoreClass(join(dir, "daily.sqlite"));
  boot();
  const first = archive.puzzles[0]!;
  target = {
    id: first.id,
    title: first.title,
    author: first.author,
    goal: first.goal,
    difficulty: first.difficulty,
  };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A submission taken straight into the archive, with no route in the way.
 *
 * Re-verification is the accept route's job and `tests/review-decide.test.ts`'s
 * subject. What this file needs is a puzzle in the list that came out of the
 * database rather than the file, so the listing can be shown to carry both.
 */
function acceptOne(): number {
  const draft: SubmissionDraft = {
    player: { id: "ada", username: "Ada", avatarUrl: null },
    guildId: "g1",
    title: "Two rows, one O",
    goal: "Clear both rows",
    claimedDifficulty: 2,
    board: ["GGGG..GGGG", "GGGG..GGGG", "GG........"],
    queue: ["O"],
    hold: null,
    targetAttack: 1,
    solution: [
      { piece: "O", cells: [[4, 1], [5, 1], [4, 0], [5, 0]], clear: "double", attack: 1 },
    ],
    events: [{ frame: 0, type: "keydown", data: { key: "hardDrop", subframe: 0 } }],
    handling: DEFAULT_HANDLING,
    piecesPlaced: 1,
    clears: ["double"],
  };
  const filed = store.recordSubmission(draft);
  const decided = store.acceptSubmission(filed.submissionId, {
    reviewedBy: "hannah",
    difficulty: 6,
    note: null,
  });
  const puzzleId = decided.submission.puzzleId;
  if (puzzleId === null) throw new Error("the accept allocated no puzzle id");
  return puzzleId;
}

/**
 * One row of the correction tool's list.
 *
 * Written out rather than imported from the route, because a test that shared
 * the route's own type would agree with it however it changed — and half of
 * what is being pinned here is the shape a page will read.
 */
interface ReviewPuzzle {
  readonly id: number;
  readonly title: string;
  readonly author: string;
  readonly goal: string;
  readonly difficulty: number;
  readonly set: string | null;
  readonly community: boolean;
  readonly overridden: boolean;
  readonly original: {
    readonly title: string;
    readonly author: string;
    readonly goal: string;
    readonly difficulty: number;
    readonly set: string | null;
  };
  readonly updatedAt: number | null;
  /** Who last moved each field. Per field, because one name for five is a lie. */
  readonly correctedBy: Record<string, { by: string; at: number }>;
  readonly history: readonly { field: string; by: string; was: string | null; became: string | null }[];
}

/** `token: null` sends no Authorization header at all; anything else mints one. */
async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string | null,
): Promise<Response> {
  const bearer =
    token === null ? undefined : (token ?? (await mintReviewToken(SECRET, "hannah")));
  return app.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const patch = (id: number | string, body: unknown, token?: string | null): Promise<Response> =>
  call("PATCH", `/api/review/puzzles/${id}`, body, token);

const revert = (id: number | string, token?: string | null): Promise<Response> =>
  call("DELETE", `/api/review/puzzles/${id}/override`, undefined, token);

async function listed(): Promise<ReviewPuzzle[]> {
  const response = await call("GET", "/api/review/puzzles");
  expect(response.status).toBe(200);
  return ((await response.json()) as { puzzles: ReviewPuzzle[] }).puzzles;
}

async function corrected(response: Response): Promise<ReviewPuzzle> {
  return ((await response.json()) as { puzzle: ReviewPuzzle }).puzzle;
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

// ── The list ─────────────────────────────────────────────────────────────────

describe("the archive, as the thing an officer corrects", () => {
  test("lists every puzzle, from both sources, with what its source said", async () => {
    const community = acceptOne();
    // The accepted puzzle joins the archive at the next start, never in the
    // process that took it — see `boot`.
    boot();
    const rows = await listed();
    expect(rows).toHaveLength(archive.puzzles.length);

    const club = rows.find((row) => row.id === target.id)!;
    expect(club.community).toBe(false);
    expect(club.overridden).toBe(false);
    expect(club.correctedBy).toEqual({});
    // The originals ride along whether or not there is a correction, so the
    // page can say what a field was changed *from* without a second question.
    expect(club.original.title).toBe(target.title);

    // The id band is the record of where a puzzle came from; there has never
    // been a column for it, and a correction is written the same way for both.
    const player = rows.find((row) => row.id === community)!;
    expect(player.community).toBe(true);
    expect(community).toBeGreaterThanOrEqual(COMMUNITY_ID_BASE);
    expect(player.original.author).toBe("Ada");
  });

  test("shows the corrected values beside the ones they replaced", async () => {
    await patch(target.id, { title: "Tuck the T", difficulty: 9 });
    const row = (await listed()).find((entry) => entry.id === target.id)!;
    expect(row.overridden).toBe(true);
    expect(row.title).toBe("Tuck the T");
    expect(row.difficulty).toBe(9);
    expect(row.original.title).toBe(target.title);
    expect(row.original.difficulty).toBe(target.difficulty);
    // Never named, so it comes from the source on both sides.
    expect(row.goal).toBe(target.goal);
    expect(row.original.goal).toBe(target.goal);
  });

  test("answers with what the next boot will serve, before the next boot", async () => {
    // `PuzzleArchive.load` runs once at module scope and `puzzles` is readonly,
    // so the archive this process is serving from cannot grow a correction —
    // a restart is what picks it up, exactly as with an accepted puzzle. That
    // makes the boot snapshot the wrong thing to render a review page from: an
    // officer would be shown the values from before their own correction.
    await patch(target.id, { title: "Tuck the T" });
    expect((await listed()).find((row) => row.id === target.id)!.title).toBe("Tuck the T");
    // The proof that it was not read off the archive: that object still says
    // what it said at boot, and is right to.
    expect(archive.get(target.id)!.title).toBe(target.title);
  });
});

// ── Correcting ───────────────────────────────────────────────────────────────

describe("an officer's correction", () => {
  test("records the fields, and who made it and when", async () => {
    const before = Date.now();
    const response = await patch(target.id, { title: "Tuck the T", set: "tspins 101" });
    expect(response.status).toBe(200);

    const row = await corrected(response);
    expect(row.title).toBe("Tuck the T");
    expect(row.set).toBe("tspins 101");
    // The grant's subject, not anything the body said: an attribution the
    // operator typed. Per field rather than per row — one name over five
    // independently correctable fields credits the last officer to touch the
    // puzzle for everything the previous one did, and overwrites their name in
    // place, so no query afterwards can put it back.
    expect(row.correctedBy.title).toEqual({ by: "hannah", at: expect.any(Number) });
    expect(row.correctedBy.set).toEqual({ by: "hannah", at: expect.any(Number) });
    expect(row.correctedBy.goal).toBeUndefined();
    expect(row.updatedAt).toBeGreaterThanOrEqual(before);
    expect(store.overridesFor()).toHaveLength(1);
  });

  test("leaves a field nobody named exactly as it was", async () => {
    await patch(target.id, { title: "Tuck the T" });
    const row = await corrected(await patch(target.id, { goal: "Clear 1 TSD" }));
    expect(row.title).toBe("Tuck the T");
    expect(row.goal).toBe("Clear 1 TSD");
    expect(row.author).toBe(target.author);
  });

  test("null reverts one field, and nothing else", async () => {
    // The three states: absent leaves, null clears, a value sets. Without the
    // middle one a correction could only ever be reverted wholesale, and an
    // officer who fixed a title and mis-rated a difficulty would have to undo
    // both to undo one.
    await patch(target.id, { title: "Tuck the T", difficulty: 9 });
    const row = await corrected(await patch(target.id, { title: null }));
    expect(row.title).toBe(target.title);
    expect(row.difficulty).toBe(9);
    expect(row.overridden).toBe(true);
  });

  test("clearing the last field leaves no correction behind", async () => {
    await patch(target.id, { title: "Tuck the T" });
    const row = await corrected(await patch(target.id, { title: null }));
    expect(row.overridden).toBe(false);
    expect(store.overridesFor()).toEqual([]);
    // The correction is gone and the record of it is not: a clear is a move
    // like any other, so the log still says hannah set the title and hannah
    // took it away. That is the whole point of the log being append-only.
    expect(row.history.map((entry: { field: string; by: string }) => [entry.field, entry.by])).toEqual([
      ["title", "hannah"],
      ["title", "hannah"],
    ]);
  });
});

// ── What it refuses ──────────────────────────────────────────────────────────

describe("what a correction is not allowed to say", () => {
  test("refuses a field that is what the puzzle is", async () => {
    // Silently ignoring these would answer 200 to an officer who believes they
    // have just fixed a board — and runs are filed against a puzzle id with no
    // record of the board they were played on, so there is no fixing one.
    for (const body of [
      { board: ["GGGG.GGGGG"] },
      { queue: ["T"] },
      { hold: "I" },
      { targetAttack: 9 },
      { solution: [] },
      { id: 4 },
    ]) {
      const response = await patch(target.id, body);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toContain("cannot be corrected");
    }
    expect(store.overridesFor()).toEqual([]);
  });

  test("refuses text the archive would not have accepted from an author", async () => {
    // The same readers the submission route uses, so a title an officer types
    // is held to exactly the rule a title an author types is.
    for (const [body, said] of [
      [{ title: "x".repeat(61) }, "longer than 60"],
      [{ goal: "x".repeat(121) }, "longer than 120"],
      [{ title: "   " }, "A title is required"],
      [{ title: "Tuck\u0000the T" }, "cannot be typed"],
      [{ author: 12 }, "An author is required"],
      [{ set: "x".repeat(41) }, "longer than 40"],
    ] as const) {
      const response = await patch(target.id, body);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toContain(said);
    }
    expect(store.overridesFor()).toEqual([]);
  });

  test("refuses a rating off the archive's own scale", async () => {
    // 1..20 is the one difficulty range this repo enforces, and this number
    // routes: `dailyTierOf` reads it for a tier and `rushBand` for a rung. A 0
    // would read as "unrated", which `dailyTierOf` files as hard.
    //
    // No NaN in this list, and that is not an omission: `JSON.stringify(NaN)`
    // is `null`, so a body carrying one arrives as the revert-this-field null
    // and is answered 200 — correctly. A NaN can only reach this repo out of a
    // column, which is what `overrideProblem` is for.
    for (const difficulty of [0, 21, -1, "6", true]) {
      const response = await patch(target.id, { difficulty });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toContain("between 1 and 20");
    }
    expect(store.overridesFor()).toEqual([]);
  });

  test("refuses a body that corrects nothing", async () => {
    const response = await patch(target.id, {});
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain("at least one field");
  });

  test("refuses a puzzle that is not there, and an id that is not an id", async () => {
    // There is no foreign key on `puzzle_id` — club puzzles live in a JSON file
    // and there is no parent row to point at — so this route is the only place
    // a correction against nothing can be caught while somebody is still there
    // to be told.
    const missing = await patch(999_999, { title: "Nowhere" });
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toContain("no puzzle 999999");
    // `Number.parseInt("12abc")` is 12 and `Number(" 3 ")` is 3, so the digits
    // are tested before anything parses them.
    for (const id of ["12abc", "-1", "1e3"]) {
      expect((await patch(id, { title: "Nowhere" })).status).toBe(400);
    }
    expect(store.overridesFor()).toEqual([]);
  });

  test("a reviewer token is what opens all three, and nothing else is", async () => {
    expect((await call("GET", "/api/review/puzzles", undefined, null)).status).toBe(401);
    expect((await patch(target.id, { title: "Tuck the T" }, null)).status).toBe(401);
    expect((await revert(target.id, null)).status).toBe(401);
    expect(store.overridesFor()).toEqual([]);
  });
});

// ── Reverting ────────────────────────────────────────────────────────────────

describe("reverting to the source", () => {
  test("puts every field back at once, and says it did", async () => {
    await patch(target.id, { title: "Tuck the T", difficulty: 9, goal: "Clear 1 TSD" });
    const response = await revert(target.id);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { reverted: boolean; puzzle: ReviewPuzzle };
    expect(body.reverted).toBe(true);
    expect(body.puzzle.overridden).toBe(false);
    expect(body.puzzle.title).toBe(target.title);
    expect(body.puzzle.difficulty).toBe(target.difficulty);
    expect(body.puzzle.goal).toBe(target.goal);
    expect(store.overridesFor()).toEqual([]);
  });

  test("reverting twice is not an error", async () => {
    // A revert of a puzzle with no correction has already achieved what it
    // asked for; a 404 there would make a page that reverted twice look broken.
    // The 404 this route does have is about a puzzle that does not exist, which
    // is a different thing and one an officer can act on.
    await patch(target.id, { title: "Tuck the T" });
    await revert(target.id);
    const second = await revert(target.id);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { reverted: boolean }).reverted).toBe(false);
  });

  test("refuses to revert a puzzle that is not there", async () => {
    expect((await revert(999_999)).status).toBe(404);
  });
});
