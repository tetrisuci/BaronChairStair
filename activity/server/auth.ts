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

const DISCORD_API = "https://discord.com/api";
const TOKEN_ENDPOINT = `${DISCORD_API}/oauth2/token`;
const CURRENT_USER_ENDPOINT = `${DISCORD_API}/users/@me`;
const CURRENT_USER_GUILDS_ENDPOINT = `${DISCORD_API}/users/@me/guilds`;

export class AuthError extends Error {
  constructor(message: string, readonly status: number = 401) {
    super(message);
    this.name = "AuthError";
  }
}

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

function base64url(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Imported once: every session sign and verify would otherwise redo it. */
let cachedKey: Promise<CryptoKey> | null = null;

function signingKey(): Promise<CryptoKey> {
  cachedKey ??= crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.sessionSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return cachedKey;
}

async function sign(payload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(),
    new TextEncoder().encode(payload),
  );
  return base64url(signature);
}

/** Constant-time compare, so a bad secret leaks nothing about the good one. */
export function equalStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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
