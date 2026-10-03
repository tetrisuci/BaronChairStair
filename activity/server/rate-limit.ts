/**
 * Rate limiting, with nothing configured and nothing read from the environment.
 *
 * Moved out of `server/limits.ts` for the reason `server/tokens.ts` gives about
 * its own crypto: a second process needs it and must not import
 * `server/config.ts`, which calls `required("DISCORD_CLIENT_SECRET")` under
 * NODE_ENV=production and throws at import. That process is the puzzle
 * database (`activity/puzzledb/`), which runs beside the game without any of
 * its secrets. So this file imports Hono and nothing else, the one setting the
 * caller key used to read from config is an argument, and `server/limits.ts`
 * is where the game supplies it.
 *
 * The alternative was a copy of the limiter in the database's own tree. A
 * limiter with two implementations is two answers to "who is this caller", and
 * that is the question the whole module exists to get right.
 *
 * Per-process and in-memory, as before: the right size for a single Bun
 * instance, and honest about what it does not cover.
 */

import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";

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
 * A fixed-window limiter keyed by caller.
 *
 * Fixed windows allow a burst across a boundary, which for a puzzle game is
 * fine — the point is to stop a loop, not to shape traffic.
 */
export function rateLimit(
  limit: RateLimit,
  keyOf: (c: Context) => string,
): (c: Context, next: Next) => Promise<void> {
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
 * The peer address is the only identity a caller cannot mint at will — and
 * this used to say that while reading two headers, which are precisely
 * mintable. Anything that could reach the origin directly sent a fresh
 * `Cf-Connecting-Ip` per request and had no rate limit anywhere.
 *
 * So the headers are read only when `trustProxy` says something in front is
 * writing them. Otherwise the socket's own peer address is used, which no
 * header can move. The game passes its `TRUST_PROXY` setting; the puzzle
 * database passes `true`, because it binds loopback only and every peer it can
 * ever see is a proxy on the same box.
 *
 * `X-Forwarded-For` is read from the *end*, not the start. A proxy appends the
 * address it saw, so the last entry is the one our own hop wrote; the leading
 * entries are whatever the client sent. `Cf-Connecting-Ip` is preferred where
 * present because cloudflared sets it and a client cannot forge it through the
 * tunnel.
 */
export function callerKeyFor(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const direct = c.req.header("Cf-Connecting-Ip")?.trim();
    if (direct) return `ip:${direct}`;

    const forwarded = c.req.header("X-Forwarded-For")?.split(",");
    const nearest = forwarded?.[forwarded.length - 1]?.trim();
    if (nearest) return `ip:${nearest}`;
  }
  return `ip:${peerAddress(c) ?? "unknown"}`;
}

/**
 * The address on the other end of the socket, where the runtime offers one.
 *
 * `c.env` is the Bun server, which `server/index.ts` and the puzzle database's
 * entry point both pass through to Hono — but it is optional there so a test
 * suite can drive `fetch` with one argument, so this has to cope with having
 * nothing to ask.
 */
function peerAddress(c: Context): string | null {
  const server = c.env as { requestIP?: (request: Request) => { address?: string } | null };
  return server?.requestIP?.(c.req.raw)?.address ?? null;
}
