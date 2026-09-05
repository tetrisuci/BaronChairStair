/**
 * The route that takes a puzzle a player wrote.
 *
 * Lifted out of `server/index.ts` unchanged, because that file had passed a
 * thousand lines and this feature is still adding to it. The route reads the
 * same, throws the same and is registered in the same place in the stack; what
 * it no longer does is sit between the rush leaderboard and the static handler.
 * Its rate limit stays in `server/index.ts` beside the others, where the whole
 * limiter stack can be read as one block.
 */

import { HTTPException } from "hono/http-exception";
import { parseGoalLoosely } from "../shared/goal";
import { clearShortfall, decodeBoard, ENGINE_ROWS } from "../shared/puzzle";
import { sanitizeHandling } from "../shared/tetris/handling";
import { parseInputLog, verifyRun } from "../shared/tetris/verify";
import type { Store } from "./db";
import { type AppRouter, GUEST_ID, requireSession } from "./http";
import { readJsonBody } from "./limits";
import {
  readBoardShape,
  readClaimedDifficulty,
  readGoal,
  readTitle,
} from "./submission-input";

/**
 * How many puzzles one player may have waiting at once.
 *
 * Three: about what somebody writes in a sitting, and comfortably more than a
 * reviewer clears in one. The cap is there to stop a queue nobody can get
 * through, not to ration authors — a decision frees the slot again, so a
 * rejection is never a door closing.
 *
 * It is also the only bound that can tell two players apart. `callerKey`
 * deliberately never reads the Authorization header (see `limits.ts`), so the
 * rate limiter registered in `server/index.ts` counts addresses — and inside
 * Discord a whole server can arrive through one proxy address, which makes it
 * both too generous for one player and too harsh for everybody else.
 */
const MAX_PENDING_SUBMISSIONS = 3;

/**
 * Files a puzzle a player wrote.
 *
 * Every other route in this server rests on the invariant stated above
 * `readTier` in `server/index.ts`: a client names a tier, never a puzzle, so a
 * log filed against the wrong board simply fails to solve it. This route
 * inverts that — the board, the queue and the hold all come from the body — so
 * replaying proves only "this log solves the board the same person sent". That
 * is still exactly the right property, because the two things the server must
 * never take on trust are derived from the replay and from the session:
 *
 * - `targetAttack` is the bar every other player is then scored against
 *   (`meetsTarget`). A number the body carried is a number nobody had to earn,
 *   and the specific number the builder would send is poison: a draft whose
 *   goal names no attack figure carries `NO_TARGET`, which is
 *   `MAX_SAFE_INTEGER`, and `assertValid` checks only `targetAttack > 0` — a
 *   permanently unsolvable puzzle that every gate in this codebase waves
 *   through.
 * - `solution` is the answer key `/api/archive/:id` hands out. It has to be a
 *   list of placements the engine produced, not a list somebody typed.
 * - the author is `session.player`, never the body.
 *
 * What that target *means* is not what an archive target means, and the two
 * must not be quietly mixed. `tools/build-puzzles.ts` derives its target with
 * `replayPlacements`, which tries every kick route per placement and keeps the
 * best line; this one comes from `verifyRun`, which replays the keystrokes
 * somebody actually made. So a community puzzle's target is what its author
 * *did* — provably human-achievable, and beatable — where an archive target
 * usually is not. There is no column recording that: every row in `submissions`
 * is a played target by construction, and a column holding one constant value
 * is not a record, it is a field waiting to disagree with the code. The review
 * screen is where it has to be said out loud, in words, to the officer.
 *
 * The trust inversion has a second cost: this is the only route where the
 * caller picks the board the engine replays. The tighter rate limit in
 * `server/index.ts` and the two bounds in `readBoardShape` are what pay for it.
 */
export function registerSubmissionRoutes(app: AppRouter, store: Store): void {
  app.post("/api/submissions", requireSession, async (c) => {
    const session = c.get("session");
    // Every guest is the same player, so a guest submission has no author to
    // credit, and a quota keyed on `player_id` that all of them share. Guest
    // play is off in production by construction, but local and end-to-end play
    // is exactly where this route gets exercised.
    if (session.player.id === GUEST_ID) {
      throw new HTTPException(403, {
        message: "A guest has no name to put on a puzzle — sign in through Discord to submit one",
      });
    }

    const body = await readJsonBody(c);

    // Everything cheap first, and the quota before the engine: replaying is
    // what this route costs, and a player who is already over their limit must
    // not be able to spend the server's time finding that out.
    const title = readTitle(body.title);
    const goal = readGoal(body.goal);
    const claimedDifficulty = readClaimedDifficulty(body.claimedDifficulty);
    const shape = readBoardShape(body);

    const waiting = store.pendingSubmissionCount(session.player.id);
    if (waiting >= MAX_PENDING_SUBMISSIONS) {
      // 409 and not 429: waiting a minute does not help, and a limiter's
      // Retry-After would promise that it does. What clears this is an officer.
      throw new HTTPException(409, {
        message: `You have ${waiting} puzzles waiting for review — an officer has to look at those first`,
      });
    }

    const handling = sanitizeHandling(body.handling);
    const events = parseInputLog(body.events);
    if (events.length === 0) {
      throw new HTTPException(400, {
        message: "Play your own puzzle first — a submission ships with the solve you made",
      });
    }

    const verified = verifyRun(
      { board: decodeBoard(shape.board, ENGINE_ROWS), queue: shape.queue, hold: shape.hold },
      handling,
      events,
    );
    // Most specific refusal first. A board with no room in it also sends no
    // attack, and a player told only the second would go looking for a bigger
    // clear on a puzzle that has nowhere to put a piece.
    if (verified.toppedOut) {
      throw new HTTPException(400, {
        message: "Your solve topped out — a puzzle has to be survivable",
      });
    }
    if (verified.attack === 0) {
      throw new HTTPException(400, {
        message: "Your solve sends no attack — there is nothing to score",
      });
    }

    // What this puzzle will demand of everybody else, frozen now.
    //
    // Same gate as the archive backfill: the requirement comes from the
    // author's own sentence, never from their solve — deriving it from the
    // answer would make whatever line they happened to play definitionally
    // correct, incidental clears and all — but it is *checked* against that
    // solve, and a goal their own run does not satisfy enforces nothing.
    //
    // Frozen on the row rather than re-read at boot because `goal` is
    // overridable by an officer and `target_attack` deliberately is not: a run
    // is filed with no record of the bar it was scored against. A clear
    // requirement is the same kind of bar.
    const wanted = parseGoalLoosely(goal)?.clears ?? [];
    const requiredClears =
      wanted.length > 0 && clearShortfall(verified.clears, wanted).length === 0 ? wanted : null;

    const submission = store.recordSubmission({
      player: session.player,
      guildId: session.guildId,
      title,
      goal,
      claimedDifficulty,
      ...shape,
      targetAttack: verified.attack,
      requiredClears,
      // `VerifiedPlacement` is a `SolutionStep` plus the frame it locked on, and
      // the frame is the author's timing rather than part of the answer. Dropped
      // here rather than at the reveal, so there is only one place it can leak.
      solution: verified.placements.map(({ frame: _frame, ...step }) => step),
      events,
      handling,
      piecesPlaced: verified.placements.length,
      clears: verified.clears,
    });

    return c.json({
      ok: true,
      submissionId: submission.submissionId,
      // What the server saw, so the builder can report that rather than its own
      // reading of the same run. The two disagreeing is the one thing a player
      // has no way to debug from the outside.
      verified: {
        attack: verified.attack,
        clears: verified.clears,
        piecesPlaced: verified.placements.length,
      },
    });
  });
}
