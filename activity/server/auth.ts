/**
 * Discord OAuth exchange and session tokens.
 *
 * The client never tells the server who it is. It hands over the authorization
 * code Discord gave it; the server exchanges that itself, asks Discord who the
 * token belongs to, and issues a signed session. Everything after that is
 * authenticated from the signature.
 */

import { config } from "./config";
import type { PlayerProfile } from "./db";
import { AuthError, base64url, equalStrings, signWith } from "./tokens";

/**
 * Re-exported so nothing outside had to learn that the crypto moved. The token
 * *kinds* are still here — this file is what knows that a session is signed
 * with `config.sessionSecret` — and `server/tokens.ts` is only the part a
 * command line can reach without dragging the whole production environment in
 * with it.
 */
export { AuthError, equalStrings };

const DISCORD_API = "https://discord.com/api";
const TOKEN_ENDPOINT = `${DISCORD_API}/oauth2/token`;
const CURRENT_USER_ENDPOINT = `${DISCORD_API}/users/@me`;
const CURRENT_USER_GUILDS_ENDPOINT = `${DISCORD_API}/users/@me/guilds`;

export interface Session {
  readonly player: PlayerProfile;
  /**
   * Guild whose leaderboard this player reads and writes. Discord does not sign
   * the instance context, so the client's claim is checked against the guilds
   * the access token can actually see before it is put in the session; an
   * unverified claim becomes null and falls back to the global board.
   */
  readonly guildId: string | null;
  readonly expiresAt: number;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
}

function avatarUrl(user: DiscordUser): string | null {
  if (!user.avatar) return null;
  const extension = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=64`;
}

function toProfile(user: DiscordUser): PlayerProfile {
  return {
    id: user.id,
    username: user.global_name || user.username,
    avatarUrl: avatarUrl(user),
  };
}

// ── Token signing ────────────────────────────────────────────────────────────

/**
 * Signs a payload with the session secret, within a named context.
 *
 * See {@link signWith} for what the context buys. Sessions keep the empty
 * context they have always used, so tokens already in the wild stay valid —
 * which is also the trap: a new kind whose mint forgets its second argument
 * mints full player sessions, and nothing in the types would notice. Every kind
 * added since names its context on the line that signs it.
 */
function sign(payload: string, context = ""): Promise<string> {
  return signWith(config.sessionSecret, payload, context);
}

const RUSH_CONTEXT = "rush.v1";

export async function mintSession(
  player: PlayerProfile,
  guildId: string | null,
): Promise<{ token: string; session: Session }> {
  const session: Session = {
    player,
    guildId,
    expiresAt: Date.now() + config.sessionTtlMs,
  };
  const payload = base64url(new TextEncoder().encode(JSON.stringify(session)));
  return { token: `${payload}.${await sign(payload)}`, session };
}

export async function readSession(token: string | undefined): Promise<Session> {
  if (!token) throw new AuthError("Not signed in");
  const parts = token.split(".");
  if (parts.length !== 2) throw new AuthError("Malformed session token");
  const [payload, signature] = parts as [string, string];
  if (!payload || !signature) throw new AuthError("Malformed session token");
  if (!equalStrings(signature, await sign(payload))) throw new AuthError("Bad session signature");

  let session: Session;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new AuthError("Unreadable session token");
  }
  /*
   * The shape, before the clock — and in that order, which was the bug.
   *
   * `session.expiresAt < Date.now()` on a payload carrying no `expiresAt`
   * compares `undefined < number`, which is `false`: the token was not expired
   * and never would be. The other two fields fail as quietly. A missing
   * `player` makes `session.player.id` read `undefined` at every route that
   * files a run, and `runs.player_id` has no foreign key to refuse it; a
   * missing `guildId` is bound straight into SQLite, which refuses `undefined`
   * and turns the first run of the day into a 500.
   *
   * All of it was unreachable while this server was the only thing holding the
   * secret and `mintSession` was the only way to spend it. `tools/review-link.ts`
   * is a second minter — of a different kind, with a different secret, but the
   * shape of the mistake is now one forgotten context argument away, and a
   * never-expiring session is not a failure anybody would watch happen.
   */
  // `null` parses without throwing and every field read off it is a TypeError,
  // which `apiError` cannot tell from a server fault — so the token shaped
  // least like a session would be the one answered 500 instead of 401.
  if (typeof session !== "object" || session === null) {
    throw new AuthError("Incomplete session token");
  }
  const guildIsNamed = session.guildId === null || typeof session.guildId === "string";
  if (
    typeof session.player?.id !== "string" ||
    !session.player.id ||
    !guildIsNamed ||
    !Number.isFinite(session.expiresAt)
  ) {
    throw new AuthError("Incomplete session token");
  }
  if (session.expiresAt < Date.now()) throw new AuthError("Session expired");
  return session;
}

// ── OAuth exchange ───────────────────────────────────────────────────────────

/**
 * Exchanges an authorization code from the embedded SDK for a Discord access
 * token, then resolves it to a user.
 *
 * @throws {AuthError} if Discord rejects the code or the token.
 */
export async function exchangeCode(
  code: string,
): Promise<{ accessToken: string; player: PlayerProfile }> {
  if (!config.discord.clientId || !config.discord.clientSecret) {
    throw new AuthError("Discord credentials are not configured on the server", 500);
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret,
      grant_type: "authorization_code",
      code,
    }),
  });

  if (!response.ok) {
    // Discord's error body can contain the code itself; keep it out of logs.
    throw new AuthError(`Discord rejected the authorization code (${response.status})`);
  }

  const { access_token: accessToken } = (await response.json()) as { access_token?: string };
  if (!accessToken) throw new AuthError("Discord returned no access token");

  return { accessToken, player: await fetchUser(accessToken) };
}

export async function fetchUser(accessToken: string): Promise<PlayerProfile> {
  const response = await fetch(CURRENT_USER_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new AuthError(`Could not identify the user (${response.status})`);
  return toProfile((await response.json()) as DiscordUser);
}

/**
 * Confirms the player is actually in the guild they claim to be playing in.
 *
 * Anything that cannot be confirmed — no claim, a missing `guilds` scope, a
 * Discord hiccup — resolves to null, which puts the player on the global
 * leaderboard rather than someone else's.
 */
export async function verifyGuild(
  accessToken: string,
  claimedGuildId: string | null,
): Promise<string | null> {
  if (!claimedGuildId) return null;
  try {
    const response = await fetch(CURRENT_USER_GUILDS_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const guilds = (await response.json()) as { id?: string }[];
    return guilds.some((guild) => guild.id === claimedGuildId) ? claimedGuildId : null;
  } catch {
    // A leaderboard scoped a little too broadly beats blocking the game.
    return null;
  }
}


// ── Rush tickets ─────────────────────────────────────────────────────────────

/**
 * A rush, as the server remembers it — which is to say, not at all.
 *
 * The five minutes have to be measured by a clock the player cannot touch, but
 * keeping a table of open rushes would mean rows to expire, a write on every
 * start, and a rush that dies when the process restarts. Instead the start
 * instant is signed and handed to the client, which gives it back at the end:
 * the server reads its own timestamp out of the ticket and subtracts. The
 * signature is what makes that safe, and nothing is stored.
 *
 * `seed` travels in the ticket too, so a practice rush gets a sequence the
 * client did not choose and cannot re-roll without starting the clock again.
 */
export interface RushTicket {
  readonly playerId: string;
  readonly guildId: string | null;
  /** The day this rush is scored against, fixed at the moment it began. */
  readonly day: number;
  readonly seed: number;
  /** Ranked rushes go on the leaderboard; practice ones are never recorded. */
  readonly ranked: boolean;
  readonly startedAt: number;
}

export async function mintRushTicket(ticket: RushTicket): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(ticket)));
  return `${payload}.${await sign(payload, RUSH_CONTEXT)}`;
}

export async function readRushTicket(token: unknown): Promise<RushTicket> {
  if (typeof token !== "string" || token.length === 0) {
    throw new AuthError("This rush has no ticket. Start it again.", 400);
  }
  const parts = token.split(".");
  if (parts.length !== 2) throw new AuthError("Malformed rush ticket", 400);
  const [payload, signature] = parts as [string, string];
  if (!payload || !signature) throw new AuthError("Malformed rush ticket", 400);
  if (!equalStrings(signature, await sign(payload, RUSH_CONTEXT))) {
    throw new AuthError("Bad rush ticket signature", 400);
  }

  let ticket: RushTicket;
  try {
    ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new AuthError("Unreadable rush ticket", 400);
  }
  // A signature proves the server wrote it, not that it wrote something sane;
  // a ticket from an older build could be missing any of this.
  //
  // The null check first, because `JSON.parse("null")` succeeds and every
  // `typeof ticket.x` below it then throws a TypeError — answered 500 with a
  // stack where every other malformed ticket is a 400. `readSession` and
  // `readReviewGrant` both check shape before anything else for the same
  // reason; this was the one that did not.
  if (
    ticket === null ||
    typeof ticket !== "object" ||
    typeof ticket.playerId !== "string" ||
    !Number.isInteger(ticket.day) ||
    !Number.isInteger(ticket.seed) ||
    typeof ticket.ranked !== "boolean" ||
    !Number.isFinite(ticket.startedAt)
  ) {
    throw new AuthError("Incomplete rush ticket", 400);
  }
  return ticket;
}
