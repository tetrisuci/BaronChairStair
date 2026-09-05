/**
 * The link that lets an officer into the review queue, and the token they trade
 * it for.
 *
 * Modelled on the rush ticket rather than on the session: a signed capability
 * with nothing written down behind it. There is no denylist, no `jti` and no
 * used-token table anywhere in this repo, so the only revocation is rotating
 * the secret — which is the whole argument for `REVIEW_SECRET` being its own
 * (see `server/config.ts`).
 *
 * Two kinds, not one, and that is the load-bearing decision in this file. The
 * **link** is short-lived and travels in a URL: a shell history, a proxy log, a
 * forwarded DM. The **token** is what `POST /api/review/session` trades it for,
 * lasts two hours and only ever appears in an `Authorization` header. They are
 * the same payload, so what keeps them apart is the signing context and nothing
 * else — and it has to be something, because a single kind would let the
 * exchange route accept its own output, and a two-hour ceiling you can renew
 * from the token you already hold is not a ceiling.
 *
 * Nothing here reads `server/config.ts`. Every secret arrives as an argument,
 * so `tools/review-link.ts` can mint a link with `process.env.REVIEW_SECRET`
 * and no configuration at all — see `server/tokens.ts` for why that matters on
 * the one machine the CLI exists to be run on.
 */

import { AuthError, base64url, equalStrings, signWith } from "./tokens";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Who the operator says this is, and how long for.
 *
 * `subject` is an *attribution*, not an identity: nothing validates who ran the
 * CLI, and the person with SSH to the VPS is the officer. It is what lands in
 * `submissions.reviewed_by`, and it is worth exactly as much as the shell it
 * was typed into — which is why the README says so out loud rather than
 * dressing it up as authentication.
 *
 * `issuedAt` is not decoration. It is what bounds a link's life at the reading
 * end: a signature says the CLI wrote it, and the CLI takes `--minutes` from
 * whoever ran it, so `expiresAt` alone would let one mistyped flag mint a key
 * that works for a year.
 */
export interface ReviewGrant {
  readonly subject: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * How long a minted link may be good for.
 *
 * Generous for an officer who is asleep when the link is sent, far short of
 * something worth stealing. Enforced when the link is minted *and* when it is
 * read, because the two happen in different processes and only one of them is
 * the server.
 */
export const MAX_LINK_MINUTES = 60;

/**
 * How long the traded token lasts: one sitting at the review queue.
 *
 * No refresh and no silent renewal. When it runs out the page says one sentence
 * and the officer asks for another link — which is a round trip through
 * somebody with SSH, and that is the point.
 */
export const REVIEW_TOKEN_TTL_MS = 2 * HOUR_MS;

/**
 * A kind of review token: its context, what to call it in a refusal, and the
 * longest life a payload claiming this kind is allowed to claim.
 *
 * The cap on the traded token is its own TTL exactly, which costs nothing —
 * this process mints it and stamps both timestamps itself, so the difference is
 * that constant to the millisecond.
 */
interface TokenKind {
  readonly context: string;
  readonly named: string;
  readonly maxLifetimeMs: number;
}

const LINK: TokenKind = {
  context: "review.v1",
  named: "review link",
  maxLifetimeMs: MAX_LINK_MINUTES * MINUTE_MS,
};

const TOKEN: TokenKind = {
  context: "review-session.v1",
  named: "review token",
  maxLifetimeMs: REVIEW_TOKEN_TTL_MS,
};

async function mint(
  secret: string,
  kind: TokenKind,
  subject: string,
  ttlMs: number,
): Promise<string> {
  if (!subject.trim()) throw new Error("A review grant needs a subject to attribute it to");
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > kind.maxLifetimeMs) {
    throw new Error(
      `A ${kind.named} lasts between a moment and ${kind.maxLifetimeMs / MINUTE_MS} minutes`,
    );
  }
  const issuedAt = Date.now();
  const grant: ReviewGrant = { subject: subject.trim(), issuedAt, expiresAt: issuedAt + ttlMs };
  const payload = base64url(new TextEncoder().encode(JSON.stringify(grant)));
  return `${payload}.${await signWith(secret, payload, kind.context)}`;
}

/**
 * Reads one back, checking the shape before it believes a single field of it.
 *
 * The order matters and is the reason this is not modelled on `readSession`.
 * That function compares `session.expiresAt < Date.now()` with no prior shape
 * check, so a payload carrying no expiry at all compares `undefined < number`,
 * which is `false`, and the token never expires. It was unreachable while the
 * server was the only thing that could mint one. A CLI is a second minter, and
 * a second minter is what makes that shape arrive.
 */
async function read(secret: string, kind: TokenKind, token: unknown): Promise<ReviewGrant> {
  if (typeof token !== "string" || token.length === 0) {
    throw new AuthError(`This request carries no ${kind.named}`);
  }
  const parts = token.split(".");
  if (parts.length !== 2) throw new AuthError(`Malformed ${kind.named}`);
  const [payload, signature] = parts as [string, string];
  if (!payload || !signature) throw new AuthError(`Malformed ${kind.named}`);
  if (!equalStrings(signature, await signWith(secret, payload, kind.context))) {
    throw new AuthError(`Bad ${kind.named} signature`);
  }

  let grant: ReviewGrant;
  try {
    grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new AuthError(`Unreadable ${kind.named}`);
  }

  // A signature proves something wrote it with the right secret, not that it
  // wrote something sane — and one of the two things that can write these is a
  // command line.
  // `null` is the one insane shape that survives `JSON.parse` without throwing,
  // and reading a field off it raises a TypeError rather than an AuthError — so
  // the one refusal that is not a 401 would be the payload this check exists
  // for. Whitespace matches `mint`'s own rule, which trims: read accepting a
  // name mint would refuse turned a nameless grant into a 500 at the exchange
  // instead of a 401 at the read.
  if (
    typeof grant !== "object" ||
    grant === null ||
    typeof grant.subject !== "string" ||
    grant.subject.trim().length === 0 ||
    !Number.isFinite(grant.issuedAt) ||
    !Number.isFinite(grant.expiresAt)
  ) {
    throw new AuthError(`Incomplete ${kind.named}`);
  }
  if (grant.expiresAt - grant.issuedAt > kind.maxLifetimeMs) {
    throw new AuthError(`That ${kind.named} was minted to last longer than one may`);
  }
  if (grant.expiresAt <= Date.now()) {
    throw new AuthError(`This ${kind.named} has expired. Ask for a new one.`);
  }

  // Rebuilt rather than passed through, so whatever else the payload was
  // carrying stops here instead of reaching a route as part of `reviewer`.
  return { subject: grant.subject, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt };
}

/** Mints the thing that goes in the URL. Minutes, because a human types them. */
export function mintReviewGrant(
  secret: string,
  subject: string,
  minutes: number,
): Promise<string> {
  return mint(secret, LINK, subject, minutes * MINUTE_MS);
}

export function readReviewGrant(secret: string, token: unknown): Promise<ReviewGrant> {
  return read(secret, LINK, token);
}

/** Mints what the link is traded for, carrying its attribution forward. */
export function mintReviewToken(secret: string, subject: string): Promise<string> {
  return mint(secret, TOKEN, subject, REVIEW_TOKEN_TTL_MS);
}

export function readReviewToken(secret: string, token: unknown): Promise<ReviewGrant> {
  return read(secret, TOKEN, token);
}
