/**
 * Signed strings, and nothing that knows what one means.
 *
 * Every token this server hands out is `payload.signature` over an HMAC, and
 * the crypto is the same three lines each time. It lives here rather than in
 * `server/auth.ts` for one reason: `tools/review-link.ts` has to mint a review
 * link on the production VPS without importing `server/config.ts`, which calls
 * `required("DISCORD_CLIENT_SECRET")` under NODE_ENV=production and throws at
 * import — measured from a directory with no `.env` beside it, which is exactly
 * where an operator runs a one-off command. So this file takes the secret as an
 * argument and imports nothing at all, and `server/auth.ts` is the one that
 * knows which secret signs a session.
 *
 * The alternative was a second copy of the format in the CLI. A token kind with
 * two implementations is a token kind that eventually has two formats, and the
 * one thing standing between a review link and a forged player session is a
 * string prefix that both halves have to agree on.
 */

/**
 * The statuses an auth failure is actually answered with.
 *
 * A union rather than `number`, so `server/http.ts` can hand it to `c.json`
 * without a cast. It carried `as 401` there, which was simply false — this is
 * thrown with 400 for a token that is malformed and 500 for a server that has
 * no secret configured, and the cast said neither could happen.
 */
export type AuthStatus = 400 | 401 | 500;

export class AuthError extends Error {
  constructor(message: string, readonly status: AuthStatus = 401) {
    super(message);
    this.name = "AuthError";
  }
}

export function base64url(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Constant-time compare, so a bad secret leaks nothing about the good one. */
export function equalStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Imported once per secret: every sign and verify would otherwise redo it.
 *
 * Keyed on the secret itself rather than on a name for it, because the callers
 * hold strings and neither of them should have to invent a label to get its key
 * cached. This process signs with two secrets and there is no path that invents
 * a third, so the map does not grow.
 */
const keys = new Map<string, Promise<CryptoKey>>();

function signingKey(secret: string): Promise<CryptoKey> {
  const cached = keys.get(secret);
  if (cached) return cached;
  if (!secret) {
    // WebCrypto refuses a zero-length HMAC key with a bare DataError that names
    // nothing. Every caller has already decided what an unset secret means —
    // the review routes answer 404 before they get here, the CLI exits — so
    // arriving with one is a wiring mistake, and a wiring mistake should say
    // which wire.
    throw new Error("Cannot sign with an empty secret");
  }
  const key = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  keys.set(secret, key);
  return key;
}

/**
 * Signs a payload within a named context.
 *
 * The context is mixed into what gets signed so a token minted for one purpose
 * can never validate as another. Two of the four kinds here are signed with the
 * same key and all four are `payload.signature`, so without this a rush ticket
 * presented as a session token would pass the signature check and arrive at a
 * route as a session with no player on it.
 *
 * The `${context}.${payload}` prefix is unambiguous only because `base64url`
 * strips `+`, `/` and `=` and emits no `.`, so a payload can never contain the
 * separator and re-split as somebody else's context. A future kind whose
 * payload could hold a dot would break domain separation, not just tidiness.
 */
export async function signWith(
  secret: string,
  payload: string,
  context: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    new TextEncoder().encode(context ? `${context}.${payload}` : payload),
  );
  return base64url(signature);
}
