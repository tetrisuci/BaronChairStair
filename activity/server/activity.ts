/**
 * Who is using the game right now, as three counts and nothing else.
 *
 * The deploy decides when a handover is quiet enough from these (through the
 * status file — see `shared/runtime-status.ts`), and the questions it needs
 * answered are all "how many": requests being answered, players who have done
 * something lately, rushes that may still be handed in. None of them needs to
 * know *who*, so nothing here keeps a name, a token or an id — a recent player
 * is held as a hash of their id, which is enough to tell two players apart and
 * useless for anything else.
 *
 * In memory only, and per process: during a handover the old process and the
 * new one each count their own, which is exactly what the deploy wants to know
 * about the old one.
 */

import type { MiddlewareHandler } from "hono";
import { RECENT_RUSH_MS, RECENT_SESSION_MS } from "../shared/runtime-status";
import type { Session } from "./auth";
import type { Variables } from "./http";

/**
 * The most recent players held at once.
 *
 * Far above any honest population — the club is a few dozen people — and there
 * so a flood of sessions cannot grow the map without bound. Past it the oldest
 * is dropped, so the count can only ever under-report a crowd that size, which
 * says "busy" either way.
 */
const SESSION_LIMIT = 10_000;

export interface ActivityCounts {
  readonly inflight: number;
  readonly sessionsRecent: number;
  readonly rushTicketsRecent: number;
}

/** What is held in memory right now, whether or not it is still recent. */
export interface ActivityHeld {
  readonly sessions: number;
  readonly rushTickets: number;
}

export interface ActivityOptions {
  /** See {@link SESSION_LIMIT}; a test lowers it to watch it hold. */
  readonly sessionLimit?: number;
}

export class Activity {
  private inflightRequests = 0;
  /**
   * A hash of each recent player's id, mapped to when they were last seen,
   * oldest first.
   *
   * A `Map` keeps insertion order, and every sighting deletes and re-inserts
   * its key, so the front of the map is always the stalest entry and pruning
   * stops at the first one still inside the window.
   */
  private readonly sessions = new Map<number | bigint, number>();
  /** When each recent rush ticket was minted, oldest first. */
  private readonly rushTickets: number[] = [];
  private readonly sessionLimit: number;

  constructor(
    private readonly now: () => number = Date.now,
    options: ActivityOptions = {},
  ) {
    this.sessionLimit = options.sessionLimit ?? SESSION_LIMIT;
  }

  requestStarted(): void {
    this.inflightRequests++;
  }

  requestFinished(): void {
    this.inflightRequests = Math.max(0, this.inflightRequests - 1);
  }

  /**
   * A signed-in request from this player, just now.
   *
   * Whoever has gone quiet is forgotten here as well as in {@link counts},
   * because nothing promises `counts` is ever called: a process started
   * without a status file never asks, and would otherwise keep every player
   * it has seen until {@link SESSION_LIMIT}. Pruning stops at the first entry
   * still inside the window, so this costs one comparison on the usual call.
   */
  sawSession(playerId: string): void {
    const now = this.now();
    this.forgetSessionsBefore(now - RECENT_SESSION_MS);
    const key = Bun.hash(playerId);
    this.sessions.delete(key);
    this.sessions.set(key, now);
    if (this.sessions.size > this.sessionLimit) {
      const oldest = this.sessions.keys().next();
      if (!oldest.done) this.sessions.delete(oldest.value);
    }
  }

  /**
   * A rush ticket was just handed out: a rush that may come back to be filed.
   *
   * Trimmed to the window on the way in, for the reason {@link sawSession}
   * is — and here there is no cap behind it, so without this a process with
   * no status file would keep one timestamp per rush for as long as it ran.
   */
  mintedRushTicket(): void {
    const now = this.now();
    this.forgetRushTicketsBefore(now - RECENT_RUSH_MS);
    this.rushTickets.push(now);
  }

  counts(): ActivityCounts {
    const now = this.now();
    this.forgetSessionsBefore(now - RECENT_SESSION_MS);
    this.forgetRushTicketsBefore(now - RECENT_RUSH_MS);
    return {
      inflight: this.inflightRequests,
      sessionsRecent: this.sessions.size,
      rushTicketsRecent: this.rushTickets.length,
    };
  }

  /**
   * How many entries are in memory, stale ones included, without pruning
   * anything — so a test can see the memory stays bounded when nothing reads
   * {@link counts}. Not a count anybody should report.
   */
  held(): ActivityHeld {
    return { sessions: this.sessions.size, rushTickets: this.rushTickets.length };
  }

  private forgetSessionsBefore(cutoff: number): void {
    for (const [key, seenAt] of this.sessions) {
      if (seenAt > cutoff) return;
      this.sessions.delete(key);
    }
  }

  private forgetRushTicketsBefore(cutoff: number): void {
    const stale = this.rushTickets.findIndex((mintedAt) => mintedAt > cutoff);
    this.rushTickets.splice(0, stale === -1 ? this.rushTickets.length : stale);
  }
}

/**
 * Counts every signed-in request towards {@link Activity.sawSession}.
 *
 * Read after the route has run, because the session is only known once a
 * route's own `requireSession` has verified it — so a forged or expired token,
 * which that answers 401, is never counted as somebody playing.
 */
export function countSessions(activity: Activity): MiddlewareHandler<{ Variables: Variables }> {
  return async (c, next) => {
    await next();
    const session = c.get("session") as Session | undefined;
    if (session) activity.sawSession(session.player.id);
  };
}
