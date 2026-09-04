/**
 * What a route may assume about a request, and what becomes of what it throws.
 *
 * All of this was private to `server/index.ts` until the submission and review
 * routes moved into files of their own. A route module that declared its own
 * `Variables` would type-check perfectly and then read a key nothing had ever
 * set, and one that let its own `AuthError` escape would answer 500 where every
 * other route answers 401 — so the shape and the error mapping live here, and
 * `server/index.ts` imports them like every other file does.
 */

import type { Context, ErrorHandler, Hono, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { InvalidRunError } from "../shared/tetris/verify";
import { AuthError, readSession, type Session } from "./auth";
import type { ReviewGrant } from "./review-token";

/**
 * The two identities a request can arrive with, under two different keys.
 *
 * A reviewer is never a `session` and never will be. They have no player id, no
 * guild and no row in `players`, so a review token landing where route code
 * reads `session.player.id` is a 500 at best and a run filed under `undefined`
 * at worst. Separate keys make that a type error rather than a discipline.
 */
export type Variables = { session: Session; reviewer: ReviewGrant };

export type AppRouter = Hono<{ Variables: Variables }>;

type AppContext = Context<{ Variables: Variables }>;

/**
 * The one identity every guest shares.
 *
 * Named because it is a gate and not a label: anything that credits a person —
 * writing a puzzle under their name, counting what they owe a review queue —
 * has to refuse it, and a bare string repeated at each of those places is one
 * typo away from letting them all through.
 */
export const GUEST_ID = "guest";

/**
 * The bearer token on a request, or undefined.
 *
 * Shared with the review guard because a reviewer presents theirs exactly the
 * same way — and because "the header is the only place a long-lived token ever
 * appears" is a rule with two enforcers now.
 */
export function bearerToken(c: Context): string | undefined {
  const header = c.req.header("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

export async function requireSession(c: AppContext, next: Next): Promise<void> {
  c.set("session", await readSession(bearerToken(c)));
  await next();
}

export const apiError: ErrorHandler<{ Variables: Variables }> = (error, c) => {
  if (error instanceof HTTPException) {
    // An exception carrying its own Response knows best. Otherwise Hono renders
    // the message as plain text, which every caller here reads as JSON and
    // reports as a bare "Request failed (409)" — so the one sentence explaining
    // what went wrong never reaches the player who needed it.
    return error.res ?? c.json({ error: error.message }, error.status);
  }
  if (error instanceof AuthError) {
    return c.json({ error: error.message }, error.status as 401);
  }
  // A malformed run is a bad request, not a server fault; saying so keeps real
  // faults visible in the log instead of drowning in client bugs.
  if (error instanceof InvalidRunError) return c.json({ error: error.message }, 400);
  console.error("[puzzle]", error);
  return c.json({ error: "Something went wrong on the server" }, 500);
};
