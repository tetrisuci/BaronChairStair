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

import { config } from "./config";

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
 * The peer address is the only identity a caller cannot mint at will — and
 * this used to say that while reading two headers, which are precisely
 * mintable. Anything that could reach the origin directly sent a fresh
 * `Cf-Connecting-Ip` per request and had no rate limit anywhere.
 *
 * So the headers are read only when {@link config.trustProxy} says something
 * in front is writing them. Otherwise the socket's own peer address is used,
 * which no header can move.
 *
 * `X-Forwarded-For` is read from the *end*, not the start. A proxy appends the
 * address it saw, so the last entry is the one our own hop wrote; the leading
 * entries are whatever the client sent. `Cf-Connecting-Ip` is preferred where
 * present because cloudflared sets it and a client cannot forge it through the
 * tunnel.
 */
export function callerKey(c: Context): string {
  if (config.trustProxy) {
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
 * `c.env` is the Bun server, which `server/index.ts` passes through to Hono —
 * but it is optional there so the test suite can drive `fetch` with one
 * argument, so this has to cope with having nothing to ask.
 */
function peerAddress(c: Context): string | null {
  const server = c.env as { requestIP?: (request: Request) => { address?: string } | null };
  return server?.requestIP?.(c.req.raw)?.address ?? null;
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
  // An empty body reads as `{}`, not as a refusal. Two routes take one where
  // every field is optional — `/api/session` mints a guest token from nothing,
  // and `/api/rush/start` defaults every setting — and both carried their own
  // `.catch(() => ({}))` before this helper replaced them, so a bodiless POST
  // worked and then quietly stopped. Nothing is loosened by it: a body that is
  // present and malformed is still a 400, and every validator downstream reads
  // an absent field exactly as it reads a missing one.
  const raw = (await c.req.text().catch(() => "")).trim();
  if (raw === "") return {};

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HTTPException(400, { message: "Request body is not valid JSON" });
  }
  // Arrays are objects, and a body of `[]` reads every field as undefined —
  // which is indistinguishable from `{}` to the validators downstream, so it
  // is refused here where the shape is still known.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HTTPException(400, { message: "Request body must be a JSON object" });
  }
  return body as Record<string, unknown>;
}
