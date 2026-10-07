/**
 * The day a daily hand-in says it was played on, checked against today.
 *
 * `POST /api/daily/run` files a run against whatever `schedule.today()` says
 * when the request arrives, and replays the log against that day's puzzle.
 * That is right for a hand-in that arrives at once. It is wrong for one that is
 * *retried* — the first attempt met a restart, the client tried again — and the
 * retry lands after midnight: the log is then replayed against tomorrow's
 * board, which it either fails or, worse, files as a run on a puzzle the player
 * never saw. So a client names the day it played, and a hand-in naming any day
 * but today is refused with 409 and a sentence the player can act on.
 *
 * Optional, so a client from before it — an activity left open across a
 * deploy — keeps the behaviour it always had.
 */

import { HTTPException } from "hono/http-exception";

export const DAY_IS_OVER = "That day is over — today's puzzles are new. Open the daily again.";

/**
 * @throws {HTTPException} 400 for a day that is not a whole number, 409 for a
 *   day that is not today. Absent (or null) passes, as it always did.
 */
export function requireHandInDay(claimed: unknown, today: number): void {
  if (claimed === undefined || claimed === null) return;
  if (typeof claimed !== "number" || !Number.isSafeInteger(claimed)) {
    throw new HTTPException(400, { message: "day must be a whole number" });
  }
  if (claimed !== today) throw new HTTPException(409, { message: DAY_IS_OVER });
}
