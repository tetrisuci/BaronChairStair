/**
 * The puzzle archive, readable by anybody, from anywhere.
 *
 * This is the piece that turns a table into a *data layer*. The club's archive
 * is meant to have one home that every project reads from — the activity, the
 * website, and whatever gets built next — and a SQLite file only the activity
 * can open is not that. These routes are the only way another deployment can
 * see it.
 *
 * **Three things make these different from every other route here, and each is
 * deliberate.**
 *
 * *They need no session and no key.* The archive is the club's public record.
 * `/api/today` is already unauthenticated for the same reason.
 *
 * *They serve solutions.* The club decided the answers are public — they are
 * already published beside every puzzle on the website. This is the one place
 * in the server that hands out a `Puzzle` rather than a `PuzzlePrompt`, and it
 * is safe **because it is not the game**: nothing here knows what today's
 * puzzle is or whether the caller is mid-run. The player-facing routes still
 * serve `PuzzlePrompt`, and `shared/puzzle.ts` still makes that a type error to
 * get wrong. Do not reuse these handlers to answer a player.
 *
 * *They are the only routes in this repository with CORS.* Everything else
 * deliberately has none — the README, `review-routes.ts` and the review client
 * all state that the absence of cookies, CORS and Origin checks is what makes
 * CSRF unbuildable here, because auth is a header a browser never attaches by
 * itself. That argument survives intact only if CORS stays scoped to routes
 * that read public data and accept no credentials. So it is mounted on this
 * prefix alone, `GET` only, with no `credentials`. Widening it to `/api/*`
 * would hand every authenticated route the one ingredient CSRF needs.
 */

import type { Database } from "bun:sqlite";
import { cors } from "hono/cors";
import type { AppRouter } from "./http";
import { archiveEntry, publishedEntries, type ArchiveEntry } from "./archive-rows";
import { blueprintLink } from "../shared/blueprint/viewer";

/** Where every route in this module lives. One prefix, so CORS can be scoped. */
export const PUBLIC_PREFIX = "/api/public";

/**
 * How long a caller may reuse an answer.
 *
 * The archive changes when somebody runs the sync and publishes, which is a
 * deliberate human act a few times a term — not a live feed. Five minutes costs
 * a downstream site nothing and keeps a popular page from turning into a
 * request per visitor.
 */
const CACHE_SECONDS = 300;

/** The wire shape. Named so a downstream project can be written against it. */
export interface PublicPuzzle {
  readonly id: number;
  readonly title: string;
  readonly author: string;
  /**
   * The club's own 1-10ish rating, or null when the sheet's cell is blank.
   *
   * Null rather than zero. `buildPuzzle` coerces a blank cell to 0 because the
   * game's `Puzzle` type needs a number and nothing in the game reads it — but
   * 0 is not a difficulty on a scale that starts at 1, and publishing it as one
   * makes every consumer either show "difficulty 0" or invent this same rule.
   * The website's own schema declares `ge=1`, so it would have been refusing a
   * value this service told it was true.
   */
  readonly difficulty: number | null;
  readonly goal: string;
  readonly set: string | null;
  readonly board: readonly string[];
  readonly queue: readonly string[];
  readonly hold: string | null;
  readonly targetAttack: number;
  readonly requiredClears: readonly { clear: string; count: number }[] | null;
  /** The author's answer. Public by decision — see the module docstring. */
  readonly solution: readonly unknown[] | null;
  /** The Blueprint codes the puzzle was built from. */
  readonly source: { readonly puzzle: string; readonly solution: string } | null;
  /** The same two, as links, so a consumer does not hard-code the viewer. */
  readonly puzzleUrl: string | null;
  readonly solutionUrl: string | null;
  /** The club's bookkeeping, straight off the sheet. */
  readonly addedOn: string | null;
  readonly solveCount: number | null;
}

function toPublic(entry: ArchiveEntry): PublicPuzzle {
  const puzzle = entry.puzzle;
  return {
    id: puzzle.id,
    title: puzzle.title,
    author: puzzle.author,
    difficulty: puzzle.difficulty === 0 ? null : puzzle.difficulty,
    goal: puzzle.goal,
    set: puzzle.set,
    board: puzzle.board,
    queue: puzzle.queue,
    hold: puzzle.hold,
    targetAttack: puzzle.targetAttack,
    requiredClears: puzzle.requiredClears ?? null,
    solution: puzzle.solution ?? null,
    source: puzzle.source ?? null,
    // Never a URL that arrived in data: shared/blueprint/viewer.ts says why.
    puzzleUrl: blueprintLink(puzzle.source?.puzzle),
    solutionUrl: blueprintLink(puzzle.source?.solution),
    addedOn: entry.addedOn,
    solveCount: entry.solveCount,
  };
}


/**
 * Mounts the public archive on `app`.
 *
 * Takes the `Database` rather than the `Store` because that is all it needs:
 * these routes read two tables and can write nothing, and a handler that
 * cannot reach `recordRun` cannot be talked into calling it.
 */
export function registerPublicRoutes(app: AppRouter, db: Database): void {
  // Scoped to this prefix, GET-only, no credentials. See the module docstring
  // for why widening any of those three is a security change, not a convenience.
  app.use(
    `${PUBLIC_PREFIX}/*`,
    cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], maxAge: 86_400 }),
  );

  /**
   * Every published puzzle.
   *
   * Unpublished rows are excluded in SQL by `readPublishedArchive`, not
   * filtered here: a row nobody has approved is not part of the club's record,
   * and doing it in the query means a future caller cannot forget.
   */
  app.get(PUBLIC_PREFIX, (c) => {
    const puzzles = publishedEntries(db).map(toPublic);
    c.header("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
    return c.json({ puzzles, count: puzzles.length });
  });

  /** One puzzle, by the id the club's spreadsheet gave it. */
  app.get(`${PUBLIC_PREFIX}/:id`, (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "That is not a puzzle id." }, 400);

    const entry = archiveEntry(db, id);
    // A row that exists but is unpublished answers exactly as a row that does
    // not exist. The alternative tells a stranger which ids are in the queue.
    if (!entry || entry.publishedAt === null) {
      return c.json({ error: `No published puzzle ${id}.` }, 404);
    }
    c.header("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
    return c.json({ puzzle: toPublic(entry) });
  });
}
