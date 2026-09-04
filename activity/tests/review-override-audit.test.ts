/**
 * What an officer can reconstruct about a correction after the fact.
 *
 * `submissions.reviewed_by` is called "the audit column" in the README, and it
 * earns the name: a decision is terminal (`WHERE status = 'pending'` in the
 * UPDATE), the row is never deleted, and the name on it is the name of the
 * person who took that decision, forever. The README says `puzzle_overrides`'s
 * `updated_by` is "worth what `submissions.reviewed_by` is worth, and for the
 * same reason". These three tests are the places where it is not, and every one
 * of them is a question an officer would actually ask.
 *
 * They fail today. They are written as the shape the answer has to have rather
 * than as the shape the code has, because "who changed puzzle 12's title" has
 * exactly one right answer and the store currently holds a different one.
 *
 * The fix all three point at is one append-only table written inside
 * `writeOverride`'s own transaction and inside `deleteOverride` — puzzle id,
 * field, what it was, what it became, when, and who — with `puzzle_overrides`
 * left as it is, the current-state row the merge reads. Per-field `*_by`
 * columns were the alternative and they lose twice: five more columns answer
 * only the first of these three questions, and they still answer nothing at all
 * once the row is deleted.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Puzzle } from "../shared/puzzle";
// Type-only, so nothing under `server/` is loaded before `beforeAll` has set the
// environment `config` reads once at import — `tests/review-override.test.ts`'s
// own arrangement, for its own reason.
import type { Store } from "../server/db";
import type { AppRouter, Variables } from "../server/http";
import type { PuzzleArchive } from "../server/puzzles";

const PUZZLES = "data/puzzles.json";
const BASE = "http://localhost";
const SECRET = "review-secret-that-is-only-a-review-secret";

let StoreClass: typeof import("../server/db").Store;
let PuzzleArchiveClass: typeof import("../server/puzzles").PuzzleArchive;
let registerReviewRoutes: typeof import("../server/review-routes").registerReviewRoutes;
let apiError: typeof import("../server/http").apiError;
let mintReviewToken: typeof import("../server/review-token").mintReviewToken;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(tmpdir(), `override-audit-${process.pid}.sqlite`);
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  ({ Store: StoreClass } = await import("../server/db"));
  ({ PuzzleArchive: PuzzleArchiveClass } = await import("../server/puzzles"));
  ({ registerReviewRoutes } = await import("../server/review-routes"));
  ({ apiError } = await import("../server/http"));
  ({ mintReviewToken } = await import("../server/review-token"));
});

let dir: string;
let databasePath: string;
/** A copy of the club's archive, so a test may rebuild it without touching the real one. */
let clubPath: string;
let club: Puzzle[];
let store: Store;
let archive: PuzzleArchive;
let app: AppRouter;
let target: Puzzle;

/** A server start, in the order `server/index.ts` does it. */
function boot(): void {
  archive = PuzzleArchiveClass.load(clubPath, {}, store.acceptedPuzzles(), store.overridesFor());
  app = new Hono<{ Variables: Variables }>();
  app.onError(apiError);
  registerReviewRoutes(app, { secret: SECRET, store, archive });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "override-audit-"));
  clubPath = join(dir, "puzzles.json");
  club = JSON.parse(readFileSync(PUZZLES, "utf8")).puzzles as Puzzle[];
  writeFileSync(clubPath, JSON.stringify({ puzzles: club }));
  databasePath = join(dir, "daily.sqlite");
  store = new StoreClass(databasePath);
  boot();
  target = archive.puzzles[0]!;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One officer, by name: the grant's subject is the only actor these routes see. */
async function call(
  method: string,
  path: string,
  who: string,
  body?: unknown,
): Promise<Response> {
  const bearer = await mintReviewToken(SECRET, who);
  return app.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        Authorization: `Bearer ${bearer}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const patch = (id: number, who: string, body: unknown): Promise<Response> =>
  call("PATCH", `/api/review/puzzles/${id}`, who, body);

const revert = (id: number, who: string): Promise<Response> =>
  call("DELETE", `/api/review/puzzles/${id}/override`, who);

interface ReviewPuzzle {
  readonly id: number;
  readonly title: string;
  readonly overridden: boolean;
  readonly updatedAt: number | null;
  readonly updatedBy: string | null;
}

async function listed(who = "hannah"): Promise<ReviewPuzzle[]> {
  const response = await call("GET", "/api/review/puzzles", who);
  expect(response.status).toBe(200);
  return ((await response.json()) as { puzzles: ReviewPuzzle[] }).puzzles;
}

/**
 * Every trace of a correction the database holds, wherever it holds it.
 *
 * The whole file rather than `store.overridesFor()`, because the question these
 * tests ask is "is this recoverable at all" — a fix that wrote the record to a
 * second table would answer it without changing the first, and a probe that
 * only knew about `puzzle_overrides` would go on failing after the bug was
 * fixed. A second connection, read-only, the way `tests/migration.test.ts`
 * inspects a store's file: nothing sets `busy_timeout`, so a second *writer*
 * would fail instantly, and this never writes.
 */
function tracesOf(needle: string): number {
  const db = new Database(databasePath, { readonly: true });
  try {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    let found = 0;
    for (const { name } of tables) {
      for (const row of db.query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`).all()) {
        const holds = Object.values(row).some(
          (value) => typeof value === "string" && value.includes(needle),
        );
        if (holds) found++;
      }
    }
    return found;
  } finally {
    db.close();
  }
}

// ── Who changed what ─────────────────────────────────────────────────────────

describe("who made a correction that is still in force", () => {
  /**
   * The bug this would have caught: `puzzle_overrides` has one `updated_by` for
   * five independently correctable fields, and the upsert stamps it on every
   * write. So the second officer to touch a puzzle takes the credit — and the
   * blame — for every field the first one corrected, and the first officer's
   * name is not merely unreported, it is gone from the database.
   *
   * This is the difference between this column and `submissions.reviewed_by`,
   * which the README says it is worth the same as: a decision is written once
   * and is terminal, so nobody can ever overwrite somebody else's name with it.
   */
  test("is the officer who changed it, not the last officer to touch the puzzle", async () => {
    await patch(target.id, "hannah", { title: "Tuck the T" });
    await patch(target.id, "ivan", { goal: "Clear 1 TSD" });

    const row = (await listed()).find((entry) => entry.id === target.id)!;
    expect(row.title).toBe("Tuck the T");
    // Ivan never said a word about the title. The tool credits it to him.
    expect(row.updatedBy).not.toBe("ivan");
    // And hannah is not anywhere behind it either: her name was overwritten in
    // place, so no query of this database can put it back.
    expect(tracesOf("hannah")).toBeGreaterThan(0);
  });
});

// ── What a revert leaves behind ──────────────────────────────────────────────

describe("a correction that has been reverted", () => {
  /**
   * The bug this would have caught: `DELETE` on the only row is the whole of a
   * revert, so afterwards nothing anywhere says a correction was ever made,
   * what it said, who made it, who undid it, or when either happened. An
   * officer arriving at a puzzle whose title changed twice this week has no
   * question they can ask.
   *
   * A PATCH that nulls the last standing field takes the same path — see the
   * all-null DELETE in `writeOverride` — so this is not only the DELETE route.
   */
  test("can still be told from one that was never made", async () => {
    await patch(target.id, "hannah", { title: "Tuck the T", difficulty: 19 });
    expect(tracesOf("Tuck the T")).toBeGreaterThan(0);

    const response = await revert(target.id, "mallory");
    expect(response.status).toBe(200);

    // What it said, and who said it.
    expect(tracesOf("Tuck the T")).toBeGreaterThan(0);
    // And who undid it: mallory's name reaches this server on a token and is
    // spent on a row that is about to be deleted, so it is never written down
    // at all — the one review action in this repo that leaves no name behind.
    expect(tracesOf("mallory")).toBeGreaterThan(0);
  });
});

// ── A correction whose puzzle went away ──────────────────────────────────────

describe("a correction the archive no longer has a puzzle for", () => {
  /**
   * The bug this would have caught: `GET /api/review/puzzles` walks
   * `archive.originals` and looks corrections up by id, so a row naming an id
   * the archive does not hold is dropped from the list without a word; and
   * `correctablePuzzle` throws its 404 *before* `store.clearOverride` is
   * reached, so the DELETE that exists to undo a correction cannot undo this
   * one. The row is live, invisible and unreachable, and `sqlite3` is the only
   * way to it.
   *
   * Not a hypothetical: `bun run puzzles` rewrites `data/puzzles.json` wholesale
   * from the club's CSVs, and surviving that rebuild is the entire reason this
   * feature exists. A puzzle retired from the sheet leaves its correction
   * behind — and the merge is by id alone, so whatever the club numbers that
   * puzzle next quietly inherits somebody's old correction. Being able to see
   * the row is what makes that answerable; being able to DELETE it is the
   * answer.
   */
  test("is still listed, and can still be reverted", async () => {
    await patch(target.id, "hannah", { title: "hannah's fix for the OLD puzzle" });

    // `bun run puzzles` runs, and the club has retired this puzzle.
    const rebuilt = club.filter((puzzle) => puzzle.id !== target.id);
    writeFileSync(clubPath, JSON.stringify({ puzzles: rebuilt }));
    boot();

    // The correction is still on file — nothing deleted it, and nothing could
    // have: there is no foreign key, because club puzzles live in a JSON file.
    expect(store.overridesFor()).toHaveLength(1);

    // An officer has to be able to see it and to undo it. Today it is absent
    // from the list, and the route that undoes a correction answers 404.
    const row = (await listed()).find((entry) => entry.id === target.id);
    expect(row?.overridden).toBe(true);
    expect((await revert(target.id, "hannah")).status).toBe(200);
    expect(store.overridesFor()).toEqual([]);
  });
});
