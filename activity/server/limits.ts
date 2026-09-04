/**
 * Request limits.
 *
 * The activity is a small game for a single Discord server, so the useful
 * guards are the cheap ones: a cap on how much a client can send, and a cap on
 * how often. Both are per-process and in-memory, which is the right size for a
 * single Bun instance and honest about what it does not cover.
 */

import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";

/** Generous for an input log of a seventy-piece puzzle, tiny for an attacker. */
export const MAX_BODY_BYTES = 512 * 1024;

/** Distinct callers tracked at once. Past this, the oldest buckets are dropped. */
const MAX_TRACKED_CALLERS = 4096;

interface Bucket {
  count: number;
  resetsAt: number;
}

export interface RateLimit {
  /** Requests allowed per window. */
  readonly max: number;
  readonly windowMs: number;
}

/**
 * Rejects a request whose declared body is too large.
 *
 * Content-Length can lie, so this is a fast reject for the honest case; the
 * real bound is that Hono will not buffer a body larger than the runtime's own
 * limit, and every handler validates what it parses.
 */
export async function limitBodySize(c: Context, next: Next): Promise<void> {
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw new HTTPException(413, { message: "Request body is too large" });
  }
  await next();
}

/**
 * A fixed-window limiter keyed by caller.
 *
 * Fixed windows allow a burst across a boundary, which for a puzzle game is
 * fine — the point is to stop a loop, not to shape traffic.
 */
export function rateLimit(limit: RateLimit, keyOf: (c: Context) => string) {
  const buckets = new Map<string, Bucket>();

  return async (c: Context, next: Next): Promise<void> => {
    const now = Date.now();
    const key = keyOf(c);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetsAt <= now) {
      buckets.set(key, { count: 1, resetsAt: now + limit.windowMs });
    } else if (bucket.count >= limit.max) {
      const retryAfter = Math.ceil((bucket.resetsAt - now) / 1000);
      throw new HTTPException(429, {
        res: c.json({ error: "Slow down a moment." }, 429, {
          "Retry-After": String(retryAfter),
        }),
      });
    } else {
      bucket.count++;
    }

    // Sweeping only expired buckets is not a bound: a flood of fresh keys grows
    // the map within a single window. Past the cap, evict oldest-first so the
    // map size is capped by memory rather than by the caller's imagination.
    if (buckets.size > MAX_TRACKED_CALLERS) {
      for (const [id, entry] of buckets) if (entry.resetsAt <= now) buckets.delete(id);
      for (const id of buckets.keys()) {
        if (buckets.size <= MAX_TRACKED_CALLERS) break;
        buckets.delete(id);
      }
    }
    await next();
  };
}

/**
 * Who to count a request against.
 *
 * Deliberately never the `Authorization` header: it is whatever the caller
 * chose, so keying on it means a fresh bucket per request and no limit at all.
 * The peer address is the only identity a caller cannot mint at will.
 *
 * `X-Forwarded-For` is read from the *end*, not the start. A proxy appends the
 * address it saw, so the last entry is the one our own hop wrote; the leading
 * entries are whatever the client sent. `Cf-Connecting-Ip` is preferred where
 * present because cloudflared sets it and a client cannot forge it through the
 * tunnel.
 */
export function callerKey(c: Context): string {
  const direct = c.req.header("Cf-Connecting-Ip")?.trim();
  if (direct) return `ip:${direct}`;

  const forwarded = c.req.header("X-Forwarded-For")?.split(",");
  const nearest = forwarded?.[forwarded.length - 1]?.trim();
  return `ip:${nearest || "unknown"}`;
}

/**
 * A request body as an object, or a 400.
 *
 * `c.req.json()` rejects on malformed JSON, which every caller already
 * handles — but `null`, `42`, `"hello"` and `true` are all *valid* JSON that
 * parse to something with no properties, so the rejection never fires and the
 * first field read throws a TypeError. That becomes a 500 with a stack in the
 * log, which is the opposite of what `onError` is trying to do a few lines
 * away when it maps a bad run to a 400 so "real faults stay visible in the log
 * instead of drowning in client bugs".
 *
 * Six routes read a body and every one of them was one `null` away from that,
 * so the check lives here rather than six times over.
 */
export async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json<unknown>().catch(() => {
    throw new HTTPException(400, { message: "Request body is not valid JSON" });
  });
  // Arrays are objects, and a body of `[]` reads every field as undefined —
  // which is indistinguishable from `{}` to the validators downstream, so it
  // is refused here where the shape is still known.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HTTPException(400, { message: "Request body must be a JSON object" });
  }
  return body as Record<string, unknown>;
}
