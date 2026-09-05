/**
 * Server configuration, read once at startup.
 *
 * Anything secret comes from the environment. Anything the client needs to know
 * is exposed through `/api/config`, so the built bundle stays deployment-neutral.
 */

import { resolve } from "node:path";
import { DEFAULT_TIME_ZONE } from "../shared/daily";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in — see README.md.`,
    );
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${raw}"`);
  return parsed;
}

/**
 * Rejects a mistyped zone at startup rather than silently rolling the puzzle
 * over at the wrong hour for months.
 */
function validTimeZone(name: string | undefined): string {
  const zone = name?.trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new Error(`DAILY_RESET_TIMEZONE "${zone}" is not a known IANA time zone`);
  }
  return zone;
}

const isProduction = process.env.NODE_ENV === "production";
const hasDiscordCredentials = Boolean(
  process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET,
);

/**
 * Outside Discord there is no OAuth handshake, so a single local guest player
 * stands in. This must never turn itself on for a real deployment, and
 * `NODE_ENV` is too easy to leave unset to be the only guard — so guest play is
 * also switched off the moment Discord credentials are configured, which is the
 * one thing every real deployment has and no local checkout does.
 */
const allowGuestPlay =
  !isProduction &&
  (process.env.ALLOW_GUEST_PLAY === "true" ||
    (!hasDiscordCredentials && process.env.ALLOW_GUEST_PLAY !== "false"));

/**
 * A signing key that only exists for this process. Sessions do not survive a
 * restart, which is a fine trade locally and impossible to mistake for a real
 * secret — unlike a hardcoded fallback, which anyone reading the source could
 * use to forge a session for any player.
 */
function ephemeralSecret(): string {
  console.warn(
    "[puzzle] SESSION_SECRET is not set — using a random key for this process. " +
      "Sessions will not survive a restart.",
  );
  return crypto.randomUUID() + crypto.randomUUID();
}

export const config = {
  isProduction,
  allowGuestPlay,
  port: optionalNumber("PORT", 3001),
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID ?? "",
    clientSecret: isProduction
      ? required("DISCORD_CLIENT_SECRET")
      : (process.env.DISCORD_CLIENT_SECRET ?? ""),
  },
  /** Signs session tokens. Rotating it logs everyone out, which is harmless. */
  sessionSecret: isProduction
    ? required("SESSION_SECRET")
    : (process.env.SESSION_SECRET || ephemeralSecret()),
  sessionTtlMs: optionalNumber("SESSION_TTL_HOURS", 24) * 3_600_000,
  /** The zone whose midnight starts a new puzzle. */
  timeZone: validTimeZone(process.env.DAILY_RESET_TIMEZONE),
  /**
   * Shared secret the Discord bot presents to read a server's standings.
   * Unset means the bot endpoints are switched off rather than left open.
   */
  botApiKey: process.env.BOT_API_KEY ?? "",
  /**
   * Signs the links that let an officer into the review queue.
   *
   * Its own secret, and emphatically not `SESSION_SECRET`. There is no
   * denylist, no `jti` and no used-token table anywhere in this repo, so the
   * only way to kill a leaked review link is to rotate the key that signed it
   * and restart. Signed with the session key, that one act would sign out every
   * player *and* invalidate every open rush ticket — and a rush ticket is the
   * only record that a rush is in progress, so rotating would destroy runs
   * mid-flight. With this, killing every review link is `unset REVIEW_SECRET`
   * and a restart, and no player notices.
   *
   * Unset switches the review routes off entirely — 404, the stance
   * `botApiKey` takes above — rather than leaving them open. Deliberately not
   * `required()` even in production: that throws at module import, so adding a
   * new required secret would stop an existing deployment booting the moment it
   * pulled this change.
   */
  reviewSecret: process.env.REVIEW_SECRET ?? "",
  /**
   * Whether a forwarding header may name the caller for rate-limiting.
   *
   * `callerKey`'s whole premise is that the address is "the only identity a
   * caller cannot mint at will" — but a header is exactly that, mintable, and
   * it was trusted unconditionally. Anything directly reachable could send a
   * fresh `Cf-Connecting-Ip` per request and get a fresh bucket every time,
   * which is no limit at all on the routes that run the engine.
   *
   * Off by default **in production**, because the failure it prevents is silent
   * and the failure it causes is loud: with this unset behind a proxy every
   * player shares one bucket and starts seeing 429s, which somebody notices
   * within the hour. **Set it to `true` wherever cloudflared, nginx or Caddy
   * sits in front** — `server/index.ts` warns at start-up when it is not.
   *
   * On everywhere else, because there is no proxy to lie to and nobody to lie:
   * a dev server and the test suite reach Hono through `fetch` with no socket
   * behind it, so there is no peer address to key on and every caller would
   * share one bucket. The suite sets `Cf-Connecting-Ip` deliberately to hold
   * two callers apart, which is the behaviour being tested.
   *
   * An explicit setting always wins, in both directions.
   */
  trustProxy: process.env.TRUST_PROXY?.trim()
    ? process.env.TRUST_PROXY.trim() === "true"
    : !isProduction,
  paths: {
    puzzles: resolve(import.meta.dir, "../data/puzzles.json"),
    database: process.env.DATABASE_PATH
      ? resolve(process.env.DATABASE_PATH)
      : resolve(import.meta.dir, "../data/daily.sqlite"),
    clientBuild: resolve(import.meta.dir, "../dist"),
  },
} as const;
