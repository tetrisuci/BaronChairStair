/**
 * Letting an officer in, showing them what is waiting, and taking their verdict.
 *
 * There is no review page yet. What is here is the door and what is behind it: a
 * link minted on the VPS by `tools/review-link.ts` is traded for a bearer token,
 * and that token carries the queue and the two decisions. Enough for an officer
 * with `curl`, and exactly what the page will call when it exists.
 *
 * **Accepting is the only route in this server that writes a puzzle.** Two
 * things stand between a submission and the archive, and both are here rather
 * than at load time, because `PuzzleArchive.load` runs at module scope and
 * throws — a row that only fails on the way *out* takes the whole server down at
 * boot instead of failing one puzzle. They are {@link reverify}, which replays
 * the stored log against the stored board, and `boardProblem`, which is the same
 * function the archive itself validates a file entry with.
 *
 * Three rules this file exists to hold:
 *
 * 1. **Off means 404, not open.** An unset `REVIEW_SECRET` answers "Review
 *    access is not enabled" before anything looks at a token — the stance
 *    `requireBotKey` takes for the bot routes. It has to be first for a second
 *    reason too: signing with an empty secret throws out of WebCrypto, so a
 *    check that ran after the signature would answer 500 and tell a prober that
 *    the feature is there and broken.
 * 2. **A reviewer is not a session.** `requireReviewer` writes `reviewer` and
 *    nothing else; see `server/http.ts` for what a review token arriving under
 *    `session` would do.
 * 3. **The token never goes in a cookie.** There are no cookies anywhere in
 *    this repo, no CORS middleware and no Origin check, which is precisely why
 *    there is no CSRF machinery to build on: auth is an explicit header a
 *    browser never attaches by itself, so a cross-site POST arrives
 *    unauthenticated. A cookie would create the problem and there would be
 *    nothing here to answer it.
 */

import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { decodeBoard, ENGINE_ROWS } from "../shared/puzzle";
import { InvalidRunError, parseInputLog, verifyRun } from "../shared/tetris/verify";
import type { Store } from "./db";
import { type AppRouter, bearerToken, type Variables } from "./http";
import { readJsonBody } from "./limits";
import { boardProblem } from "./puzzles";
import { mintReviewToken, readReviewGrant, readReviewToken } from "./review-token";
import {
  readRejectionNote,
  readReviewedDifficulty,
  readReviewerNote,
} from "./submission-input";
import type { Submission } from "./submissions";

/**
 * What the review routes need, named rather than reached for.
 *
 * The secret is passed in rather than read from `server/config.ts` here so that
 * both halves of rule 1 are reachable from a test: one process cannot import
 * `config` twice with different environments, so a secret that arrived through
 * the module would leave either the enabled path or the 404 permanently
 * untestable.
 */
export interface ReviewDependencies {
  readonly secret: string;
  readonly store: Pick<
    Store,
    "pendingSubmissions" | "submission" | "acceptSubmission" | "rejectSubmission"
  >;
}

function requireReviewEnabled(secret: string): void {
  if (!secret) throw new HTTPException(404, { message: "Review access is not enabled" });
}

/**
 * The guard on everything a reviewer can reach.
 *
 * A factory rather than a plain middleware because the secret is a dependency
 * and not a global. It reads the same bearer header `requireSession` does, and
 * deliberately accepts only the traded token: a link presented here is refused,
 * because a link is the thing that has been in a URL and the whole point of the
 * trade is that what outlives the click never was.
 */
function requireReviewer(secret: string): MiddlewareHandler<{ Variables: Variables }> {
  return async (c, next) => {
    requireReviewEnabled(secret);
    c.set("reviewer", await readReviewToken(secret, bearerToken(c)));
    await next();
  };
}

/**
 * One row of the queue.
 *
 * Not the board, not the queue, not the answer key: this is a list, and the
 * detail view is what a reviewer opens when they have picked something off it.
 * `targetAttack` is named for what it is at every point it is shown — the
 * attack the author's own solve sent, which is a different kind of number from
 * an archived puzzle's target and must never be quietly read as one.
 *
 * `title`, `goal` and `author` are player-written text on their way to a plain
 * web page outside Discord's sandbox. They are checked on the way in
 * (`server/submission-input.ts` refuses control characters and over-length) and
 * they leave here as JSON, which is safe; what is not safe is the page setting
 * them with `innerHTML`, and that is the review page's rule to keep.
 */
function toQueueRow(submission: Submission) {
  return {
    submissionId: submission.submissionId,
    title: submission.title,
    author: submission.authorName,
    goal: submission.goal,
    claimedDifficulty: submission.claimedDifficulty,
    piecesPlaced: submission.piecesPlaced,
    playedAttack: submission.targetAttack,
    clears: submission.clears,
    createdAt: submission.createdAt,
  };
}

/**
 * One submission in full: what a reviewer needs in front of them to judge it.
 *
 * The queue row plus the three things a list has no business carrying — the
 * board, the pieces, and the solve. The solve especially: this is the only
 * response in the whole server that hands over an answer key unearned, and it
 * is the point of the route. A reviewer who cannot step the solution is being
 * asked to approve a puzzle they have not seen solved.
 *
 * The **input log stays here**. `events` is the raw keystrokes, it is what
 * `reverify` replays at accept, and a page that carried it could send it back
 * — at which point the thing being replayed is the reviewer's copy rather than
 * the author's row.
 *
 * The numbers are the ones this server derived at submit by replaying that log,
 * and they are not re-derived here. Accepting replays it again regardless, so a
 * second copy of that check on a read would be a second thing to keep in step
 * and could only ever disagree with the one that decides. What the reviewer is
 * told, they are told once, by the route that writes.
 */
function toDetail(submission: Submission) {
  return {
    ...toQueueRow(submission),
    board: submission.board,
    queue: submission.queue,
    hold: submission.hold,
    solution: submission.solution,
  };
}

/**
 * What comes back from a decision: the verdict, and never the puzzle.
 *
 * The same withholding the queue row makes, for the same reason — a board, an
 * input log and an answer key are the detail view's business, and an officer
 * who just pressed Accept is not asking for them back.
 */
function toVerdict(submission: Submission) {
  return {
    submissionId: submission.submissionId,
    title: submission.title,
    author: submission.authorName,
    status: submission.status,
    reviewedBy: submission.reviewedBy,
    reviewedAt: submission.reviewedAt,
    note: submission.reviewerNote,
    puzzleId: submission.puzzleId,
    difficulty: submission.difficulty,
  };
}

/**
 * The submission a decision is about, or the refusal instead.
 *
 * The digits are tested before anything parses them, because every parser here
 * is lenient in a different direction: `Number.parseInt("12abc")` is 12 and
 * `Number(" 3 ")` is 3, so either alone would answer about a row the officer
 * did not name. `isSafeInteger` afterwards is for the string of digits too long
 * to be a number at all.
 *
 * The already-decided check lives here rather than in each route because both
 * decisions are terminal and the store answers the same way for both. It is a
 * courtesy, not the guard — `WHERE status = 'pending'` in the UPDATE is the
 * guard, and `isFirst` is what the routes below check afterwards. Two officers
 * can hold links at once and nothing coordinates them, so there is a real
 * window between this read and that write.
 */
function pendingSubmission(c: Context, store: ReviewDependencies["store"]): Submission {
  const raw = c.req.param("id") ?? "";
  const id = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isSafeInteger(id)) {
    throw new HTTPException(400, { message: "A submission id is a number" });
  }
  const submission = store.submission(id);
  if (!submission) throw new HTTPException(404, { message: `There is no submission ${id}` });
  if (submission.status !== "pending") throw alreadyDecided(submission);
  return submission;
}

function alreadyDecided(submission: Submission): HTTPException {
  return new HTTPException(409, {
    message:
      `Submission ${submission.submissionId} was already ${submission.status}` +
      (submission.reviewedBy ? ` by ${submission.reviewedBy}` : ""),
  });
}

/**
 * Replays the stored log against the stored board, and refuses any disagreement.
 *
 * This is the last line of defence, and the reason `events` is a column at all.
 * The failure it catches is quiet and permanent: an author plays their puzzle,
 * paints one more cell, and submits — so the row's `solution` and
 * `target_attack` describe a board that no longer exists. Nothing else would
 * notice. `boardProblem` does not look at solutions, `assertValid` says outright
 * that it does not, and the puzzle would ship with an unreachable target and a
 * reveal that plays a line which does not work.
 *
 * Attack *and* placement count, because either alone can match by accident: a
 * repainted board very often sends a different number of attack from the same
 * pieces, and a truncated log very often sends the same attack from fewer. The
 * pair is what pins "this is the run that was filed".
 *
 * Deliberately NOT `replayPlacements`. That re-derives each placement by asking
 * the pathfinder to route to it, and a real keystroke solve can contain a tuck
 * the pathfinder cannot express — so it would turn away valid submissions, and
 * the ones it turned away would be the cleverest.
 *
 * The log goes back through `parseInputLog` on the way out, even though the
 * route that wrote it parsed it on the way in. A JSON column is a blob to
 * SQLite and `toSubmission` checks only that it came back a list, so this is the
 * one thing between a row somebody edited and the engine — the same argument
 * `Store.pinnedRushPool` makes about its own column.
 */
function reverify(submission: Submission): void {
  let verified: ReturnType<typeof verifyRun>;
  try {
    verified = verifyRun(
      {
        board: decodeBoard(submission.board, ENGINE_ROWS),
        queue: submission.queue,
        hold: submission.hold,
      },
      submission.handling,
      parseInputLog(submission.events),
    );
  } catch (error) {
    // Rethrown as a conflict rather than left to `apiError`, which would call an
    // `InvalidRunError` a 400. The bad request would be the officer's, and it is
    // not — the log is one this server wrote down and cannot replay.
    if (!(error instanceof InvalidRunError)) throw error;
    throw new HTTPException(409, {
      message: `This submission's stored solve no longer replays: ${error.message}`,
    });
  }
  // The placements the replay just produced, in the shape the archive stores.
  // Comparing them is the point of replaying at all: two scalars agreeing says
  // the log still reaches the same score, and says nothing about the column
  // that is actually shipped as the answer key. A row whose numbers match and
  // whose `solution` does not would otherwise be accepted and served as the
  // reveal for a puzzle it does not solve.
  const replayed = verified.placements.map(({ frame: _frame, ...step }) => step);
  if (
    verified.attack === submission.targetAttack &&
    verified.placements.length === submission.piecesPlaced &&
    JSON.stringify(replayed) === JSON.stringify(submission.solution)
  ) {
    return;
  }
  throw new HTTPException(409, {
    message:
      "This submission's stored solve does not match its stored board: it now sends " +
      `${verified.attack} attack in ${verified.placements.length} pieces, against the ` +
      `${submission.targetAttack} in ${submission.piecesPlaced} on file. Reject it and ` +
      "ask the author to submit again from the board they played.",
  });
}

export function registerReviewRoutes(app: AppRouter, deps: ReviewDependencies): void {
  const { secret, store } = deps;

  /**
   * Trades the link for the token.
   *
   * The grant arrives in the **body** and not in the query string, which is the
   * only part of this exchange that buys anything: the link has already been in
   * a URL by the time it gets here — a shell history, a proxy log, a forwarded
   * DM — and what comes back is what will still be worth something in an hour.
   * A POST body is not logged by whatever sits in front, is not in the address
   * bar, and is not in a `Referer`.
   *
   * Replay is deliberately not solved. Whoever holds the link is the reviewer
   * until it expires; preventing that needs a used-nonce table, which is exactly
   * the storage a rush ticket exists to avoid. At a handful of officers, one
   * VPS and a fifteen-minute window it costs more than the risk — and a
   * single-use link would be burnt by Discord's own unfurler before the officer
   * clicked it. The CLI says so in its own output rather than leaving the
   * property to be discovered.
   */
  app.post("/api/review/session", async (c) => {
    requireReviewEnabled(secret);
    const body = await readJsonBody(c);
    const grant = await readReviewGrant(secret, body.grant);
    const token = await mintReviewToken(secret, grant.subject);
    // The subject comes back so the page can show whose link it is holding.
    // It is an attribution the operator typed, never an authenticated identity
    // — see `ReviewGrant`.
    return c.json({ token, subject: grant.subject });
  });

  app.get("/api/review/queue", requireReviewer(secret), (c) =>
    c.json({
      reviewer: c.get("reviewer").subject,
      queue: store.pendingSubmissions().map(toQueueRow),
    }),
  );

  /**
   * One submission, opened.
   *
   * A decided row is a 409 here and not a 200, which is unusual for a GET and
   * deliberate: this is the page an officer takes a decision on, a decided row
   * has none left to take, and `pendingSubmission`'s sentence — "already
   * accepted by hannah" — is the whole of what they need to know. Answering
   * with the puzzle instead would put Accept and Reject in front of somebody
   * for a row that will refuse both.
   */
  app.get("/api/review/submissions/:id", requireReviewer(secret), (c) =>
    c.json({ submission: toDetail(pendingSubmission(c, store)) }),
  );

  /**
   * Takes a puzzle: rates it, allocates its archive id, and lets it in.
   *
   * Cheap refusals first, and the replay last, in the order they are written.
   * Reading the body and the id costs nothing; the engine is the expensive part
   * of this route, and an officer who typed a difficulty of 40 should not be
   * told so only after the server has replayed somebody's solve.
   *
   * It does not make the puzzle playable. `PuzzleArchive.load` runs once at
   * module scope, `puzzles` is readonly and `forDay` memoises, so the archive
   * this process is serving from cannot grow; a restart is what picks the row
   * up. That is a feature and not a shortcut — a live-mutating archive would
   * reshuffle a day underneath the players holding its prompt, which is the
   * whole hazard `DaySchedule` was written to close.
   */
  app.post("/api/review/submissions/:id/accept", requireReviewer(secret), async (c) => {
    const body = await readJsonBody(c);
    const difficulty = readReviewedDifficulty(body.difficulty);
    const note = readReviewerNote(body.note);
    const submission = pendingSubmission(c, store);

    // The same rule `PuzzleArchive.load` holds a file entry to, run here where
    // failing costs one puzzle rather than at boot where it costs the server.
    const fault = boardProblem(submission);
    if (fault) {
      throw new HTTPException(409, {
        message: `This submission cannot become a puzzle: ${fault}`,
      });
    }
    // `boardProblem` is only two of the three rules `assertValid` holds a file
    // entry to. The third one is checked here rather than left to the archive,
    // because the archive checks it at module scope: a row accepted with a
    // target of zero replays perfectly — nothing disagrees with nothing — and
    // then stops the whole server booting, for every player, over one puzzle.
    if (!(submission.targetAttack > 0)) {
      throw new HTTPException(409, {
        message: "This submission cannot become a puzzle: its solve sends no attack",
      });
    }
    reverify(submission);

    const decided = store.acceptSubmission(submission.submissionId, {
      reviewedBy: c.get("reviewer").subject,
      difficulty,
      note,
    });
    // Somebody decided it between the read above and this write. Their verdict
    // stands; the id this call would have allocated was never spent.
    if (!decided.isFirst) throw alreadyDecided(decided.submission);
    return c.json({ ok: true, decided: toVerdict(decided.submission) });
  });

  /**
   * Turns one down, with the reason the author will read.
   *
   * No replay. A submission whose stored solve does not match its stored board
   * is exactly the kind this route exists for, and demanding it verify first
   * would make the broken ones the only ones nobody could clear.
   */
  app.post("/api/review/submissions/:id/reject", requireReviewer(secret), async (c) => {
    const body = await readJsonBody(c);
    const note = readRejectionNote(body.note);
    const submission = pendingSubmission(c, store);

    const decided = store.rejectSubmission(submission.submissionId, {
      reviewedBy: c.get("reviewer").subject,
      note,
    });
    if (!decided.isFirst) throw alreadyDecided(decided.submission);
    return c.json({ ok: true, decided: toVerdict(decided.submission) });
  });
}
