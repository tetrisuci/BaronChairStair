/**
 * The door a reviewer comes through.
 *
 * Two things are being pinned here and they fail in opposite directions. One is
 * that a review token can never be mistaken for a player's session — the mint
 * that forgets its context argument mints sessions, and nothing in the types,
 * the compiler or the rest of this suite would notice. The other is that a
 * signed payload is still an untrusted payload: `readSession` compared an
 * expiry before checking there was one, and a token with no `expiresAt` on it
 * compared `undefined < Date.now()`, which is `false`, and lived forever. That
 * was unreachable while the server was the only thing holding a secret, and a
 * command line is the second thing.
 *
 * Nothing here opens a database or imports `server/index.ts`. The review routes
 * take their secret as an argument precisely so both halves of "off means 404"
 * are reachable: one process cannot import `server/config.ts` twice with
 * different environments, so a secret read through the module would leave
 * either the enabled path or the disabled one permanently untestable.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
// Type-only, so nothing under `server/` is loaded before `beforeAll` has set the
// environment `config` reads once at import.
import type { AppRouter, Variables } from "../server/http";
import type { Submission } from "../server/submissions";

/** The path every other route-driving file in this suite settles on. */
const DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);
const BASE = "http://localhost";

/** A review secret that is nothing like the session one, for the ordinary tests. */
const SECRET = "review-secret-that-is-only-a-review-secret";

let auth: typeof import("../server/auth");
let tokens: typeof import("../server/tokens");
let review: typeof import("../server/review-token");
let apiError: typeof import("../server/http").apiError;
let registerReviewRoutes: typeof import("../server/review-routes").registerReviewRoutes;
/**
 * The key sessions are signed with.
 *
 * Used as the *review* secret in the domain-separation block below, which is
 * the whole point of that block: with two different secrets those tests would
 * pass on the key alone and prove nothing about the context, which is the thing
 * a forgotten argument actually removes.
 */
let sessionSecret: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  auth = await import("../server/auth");
  tokens = await import("../server/tokens");
  review = await import("../server/review-token");
  ({ apiError } = await import("../server/http"));
  ({ registerReviewRoutes } = await import("../server/review-routes"));
  sessionSecret = (await import("../server/config")).config.sessionSecret;
});

// ── Forging ──────────────────────────────────────────────────────────────────

/**
 * A correctly signed token carrying whatever payload a test wants.
 *
 * Every "the shape is checked before it is believed" test needs a payload the
 * minters would never produce, and the only honest way to get one is to sign it
 * with the real key: a payload the signature check turns away has not tested
 * the shape check at all.
 */
async function forge(secret: string, context: string, payload: unknown): Promise<string> {
  const encoded = tokens.base64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encoded}.${await tokens.signWith(secret, encoded, context)}`;
}

const LINK_CONTEXT = "review.v1";
const TOKEN_CONTEXT = "review-session.v1";

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("that was accepted, and it should not have been");
}

// ── The link ─────────────────────────────────────────────────────────────────

describe("a review link is its own kind of token", () => {
  test("round-trips the subject and an expiry inside the window it was minted for", async () => {
    const before = Date.now();
    const grant = await review.readReviewGrant(
      SECRET,
      await review.mintReviewGrant(SECRET, "  hannah  ", 15),
    );
    expect(grant.subject).toBe("hannah");
    expect(grant.issuedAt).toBeGreaterThanOrEqual(before);
    expect(grant.expiresAt - grant.issuedAt).toBe(15 * 60_000);
  });

  test("refuses a signed payload with no expiry on it", async () => {
    // The bug this whole file exists around. `readSession` reads
    // `session.expiresAt < Date.now()` with no prior shape check, so this exact
    // payload — perfectly signed, missing one field — is a token that never
    // expires. The shape check has to come first, and it has to be a check for
    // a number rather than for truthiness.
    const forged = await forge(SECRET, LINK_CONTEXT, { subject: "hannah", issuedAt: Date.now() });
    expect(await refusal(review.readReviewGrant(SECRET, forged))).toContain("Incomplete");
  });

  test("refuses a signed payload with no subject on it", async () => {
    // `reviewed_by` is the only attribution a decision ever gets, so a link
    // that names nobody must not become a token that decides things.
    const now = Date.now();
    const forged = await forge(SECRET, LINK_CONTEXT, {
      subject: "",
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    expect(await refusal(review.readReviewGrant(SECRET, forged))).toContain("Incomplete");
  });

  test("refuses one whose time has run out", async () => {
    const now = Date.now();
    const forged = await forge(SECRET, LINK_CONTEXT, {
      subject: "hannah",
      issuedAt: now - 60_000,
      expiresAt: now - 1,
    });
    expect(await refusal(review.readReviewGrant(SECRET, forged))).toContain("expired");
  });

  test("refuses one minted to outlast the cap, at the mint and at the read", async () => {
    // `--minutes` comes from whoever ran the CLI, and a signature says only
    // that the CLI wrote it. Without the cap one mistyped flag is a key that
    // works for a year, and `issuedAt` is in the payload so the reading end can
    // say so on its own rather than trusting the minter to have been careful.
    expect(
      await refusal(review.mintReviewGrant(SECRET, "hannah", review.MAX_LINK_MINUTES + 1)),
    ).toContain(`${review.MAX_LINK_MINUTES} minutes`);

    const now = Date.now();
    const forged = await forge(SECRET, LINK_CONTEXT, {
      subject: "hannah",
      issuedAt: now,
      expiresAt: now + 365 * 24 * 3_600_000,
    });
    expect(await refusal(review.readReviewGrant(SECRET, forged))).toContain("longer than one may");
  });

  test("a link is not the token it is traded for, in either direction", async () => {
    // Same secret, same payload shape, same two-part format: only the signing
    // context separates them. Without it the exchange route accepts its own
    // output, and a two-hour ceiling you can renew from the token you already
    // hold is not a ceiling at all.
    const link = await review.mintReviewGrant(SECRET, "hannah", 15);
    const token = await review.mintReviewToken(SECRET, "hannah");

    expect(await refusal(review.readReviewToken(SECRET, link))).toContain("signature");
    expect(await refusal(review.readReviewGrant(SECRET, token))).toContain("signature");
  });
});

// ── Domain separation ────────────────────────────────────────────────────────

describe("a review token is not a player, and a player is not a reviewer", () => {
  /**
   * Every test in here signs both kinds with the *session* secret on purpose.
   *
   * `sign(payload, context = "")` defaults to the empty context and the empty
   * context is the session context, so a mint that forgets its second argument
   * mints player sessions and the types cannot tell. Using two different
   * secrets would make all of this pass on the key and prove nothing about the
   * thing that actually breaks.
   */
  const player = { id: "author-1", username: "Ada", avatarUrl: null };

  test("a session token is not a review link", async () => {
    const { token } = await auth.mintSession(player, null);
    expect(await refusal(review.readReviewGrant(sessionSecret, token))).toContain("signature");
  });

  test("a review link is not a session", async () => {
    // The direction that matters most: a review link arriving as a session
    // reaches route code that reads `session.player.id`, and `runs.player_id`
    // has no foreign key to refuse whatever it finds there.
    const link = await review.mintReviewGrant(sessionSecret, "hannah", 15);
    expect(await refusal(auth.readSession(link))).toContain("signature");
  });

  test("a review token is not a session either", async () => {
    const token = await review.mintReviewToken(sessionSecret, "hannah");
    expect(await refusal(auth.readSession(token))).toContain("signature");
  });

  test("a rush ticket is not a review link", async () => {
    const ticket = await auth.mintRushTicket({
      playerId: player.id,
      guildId: null,
      day: 1,
      seed: 1,
      ranked: false,
      startedAt: Date.now(),
    });
    expect(await refusal(review.readReviewGrant(sessionSecret, ticket))).toContain("signature");
  });

  test("a review link is not a rush ticket", async () => {
    const link = await review.mintReviewGrant(sessionSecret, "hannah", 15);
    expect(await refusal(auth.readRushTicket(link))).toContain("signature");
  });
});

// ── The latent session bug ───────────────────────────────────────────────────

describe("a signed session payload is still an untrusted payload", () => {
  test("one with no expiry on it is refused, where it used to last forever", async () => {
    // `undefined < Date.now()` is `false`, so this token was not expired and
    // never would be — no error, no log line, nothing to notice. Reachable the
    // moment a second thing can mint with a context argument, which is what
    // `tools/review-link.ts` is.
    const forged = await forge(sessionSecret, "", {
      player: { id: "forged", username: "forged", avatarUrl: null },
      guildId: null,
    });
    expect(await refusal(auth.readSession(forged))).toContain("Incomplete");
  });

  test("one with no player on it is refused", async () => {
    // The same missing-field failure one field over, and the more expensive
    // one: `session.player.id` is what every run, preference and submission is
    // filed under.
    const forged = await forge(sessionSecret, "", {
      guildId: null,
      expiresAt: Date.now() + 3_600_000,
    });
    expect(await refusal(auth.readSession(forged))).toContain("Incomplete");
  });

  test("a payload of literal null is refused, not crashed on", async () => {
    // The one insane shape that survives `JSON.parse` without throwing. Reading
    // a field off it raises a TypeError, which is neither an AuthError nor an
    // HTTPException — so the payload shaped least like a token was answered
    // 500, with a stack in the log, where every other bad shape is a 401.
    expect(await refusal(auth.readSession(await forge(sessionSecret, "", null)))).toContain(
      "Incomplete",
    );
    expect(await refusal(review.readReviewGrant(SECRET, await forge(SECRET, LINK_CONTEXT, null)))).toContain(
      "Incomplete",
    );
  });

  test("a grant with a nameless subject is refused at the read, not at the next mint", async () => {
    // `read` accepted any subject of non-zero length while `mint` trims, so a
    // whitespace name passed the gate and was thrown out of the exchange as a
    // plain Error — a 500 for a token the read had already had its chance to
    // call a 401.
    const nameless = await forge(SECRET, LINK_CONTEXT, {
      subject: "   ",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    expect(await refusal(review.readReviewGrant(SECRET, nameless))).toContain("Incomplete");
  });

  test("an ordinary expired session is still refused, and a live one still works", async () => {
    // The shape check goes in front of the clock check; putting it there must
    // not have stepped on the clock check itself.
    const expired = await forge(sessionSecret, "", {
      player: { id: "ada", username: "Ada", avatarUrl: null },
      guildId: null,
      expiresAt: Date.now() - 1,
    });
    expect(await refusal(auth.readSession(expired))).toContain("expired");

    const { token } = await auth.mintSession({ id: "ada", username: "Ada", avatarUrl: null }, "g1");
    const session = await auth.readSession(token);
    expect(session.player.id).toBe("ada");
    expect(session.guildId).toBe("g1");
  });
});

// ── The routes ───────────────────────────────────────────────────────────────

/** A pending row, in full, so the queue's own narrowing is visible. */
const WAITING: Submission = {
  submissionId: 7,
  playerId: "author-1",
  authorName: "Ada",
  guildId: null,
  title: "Tuck the T",
  goal: "Clear 1 TSD",
  claimedDifficulty: 4,
  board: ["GGGG.GGGGG"],
  queue: ["T"],
  hold: null,
  targetAttack: 4,
  solution: [{ piece: "T", cells: [[4, 0]], clear: "tsd", attack: 4 }],
  events: [{ frame: 0, type: "keydown", data: { key: "hardDrop", subframe: 0 } }],
  handling: DEFAULT_HANDLING,
  piecesPlaced: 1,
  clears: ["tsd"],
  status: "pending",
  reviewerNote: null,
  reviewedAt: null,
  reviewedBy: null,
  puzzleId: null,
  difficulty: null,
  createdAt: 1_700_000_000_000,
};

/**
 * The review routes on an app of their own.
 *
 * `apiError` is the real one rather than a stand-in, because half of what is
 * being tested is which status an `AuthError` and an `HTTPException` come back
 * as — and that mapping is exactly what a test app with its own error handler
 * would quietly replace.
 */
function reviewApp(secret: string): AppRouter {
  const app = new Hono<{ Variables: Variables }>();
  app.onError(apiError);
  // Only the queue is reachable from this file. Deciding a submission is
  // `tests/review-decide.test.ts`'s subject and correcting a puzzle is
  // `tests/review-override.test.ts`'s, and both drive a real store; a stub here
  // that pretended to write would be a second, quieter definition of what those
  // routes do.
  const unreached = () => {
    throw new Error("this file does not decide submissions or correct puzzles");
  };
  registerReviewRoutes(app, {
    secret,
    store: {
      pendingSubmissions: () => [WAITING],
      submission: () => null,
      acceptSubmission: unreached,
      rejectSubmission: unreached,
      overridesFor: () => [],
      setOverride: unreached,
      clearOverride: unreached,
      acceptedPuzzles: () => [],
      overrideHistory: () => [],
    },
    archive: { originals: [], original: () => undefined },
  });
  return app;
}

function exchange(app: AppRouter, grant: unknown): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}/api/review/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant }),
      }),
    ),
  );
}

function queue(app: AppRouter, token?: string): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}/api/review/queue`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
    ),
  );
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

describe("letting a reviewer in", () => {
  test("trades a link for a token, and that token opens the queue", async () => {
    const app = reviewApp(SECRET);
    const traded = await exchange(app, await review.mintReviewGrant(SECRET, "hannah", 15));
    expect(traded.status).toBe(200);

    const { token, subject } = (await traded.json()) as { token: string; subject: string };
    expect(subject).toBe("hannah");

    const listed = await queue(app, token);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      reviewer: string;
      queue: Record<string, unknown>[];
    };
    expect(body.reviewer).toBe("hannah");
    expect(body.queue.length).toBe(1);
    expect(body.queue[0]!.title).toBe("Tuck the T");
    expect(body.queue[0]!.author).toBe("Ada");
    // A queue is a list. The board, the input log and the answer key belong to
    // the detail view, and shipping them with every row would put the answer to
    // every pending puzzle in one response.
    for (const withheld of ["board", "queue", "solution", "events", "handling"]) {
      expect(body.queue[0]).not.toHaveProperty(withheld);
    }
    // Named for what it is at every point it is shown: the attack the author's
    // own solve sent, which is not the best-line number an archived puzzle
    // carries and must never be quietly read as one.
    expect(body.queue[0]!.playedAttack).toBe(4);
  });

  test("will not trade the token it just handed out", async () => {
    // Otherwise the two-hour life is renewable from inside, and the only thing
    // that ever expires is the fifteen-minute link nobody is holding any more.
    const app = reviewApp(SECRET);
    const token = await review.mintReviewToken(SECRET, "hannah");
    const response = await exchange(app, token);
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toContain("signature");
  });

  test("refuses the link itself as a bearer token", async () => {
    // The link has been in a URL by the time anyone holds it. The whole point
    // of the trade is that what outlives the click never was.
    const app = reviewApp(SECRET);
    const link = await review.mintReviewGrant(SECRET, "hannah", 15);
    expect((await queue(app, link)).status).toBe(401);
  });

  test("refuses a request carrying nothing at all", async () => {
    const response = await queue(reviewApp(SECRET));
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toContain("no review token");
  });

  test("refuses a player's session token", async () => {
    // A player who found the endpoint has a perfectly good signed token. It is
    // not this one, and the guard writes `reviewer` rather than `session`, so
    // there is no route in here that could read a player off it even if it were.
    const app = reviewApp(sessionSecret);
    const { token } = await auth.mintSession({ id: "ada", username: "Ada", avatarUrl: null }, null);
    expect((await queue(app, token)).status).toBe(401);
  });

  test("answers 404 with no secret set, before it looks at a token at all", async () => {
    // The stance `requireBotKey` takes: switched off, not left open. It has to
    // be checked first for a second reason — signing with an empty secret
    // throws out of WebCrypto, so a check that ran after the signature would
    // answer 500 and tell a prober the feature is there and broken.
    const off = reviewApp("");
    const valid = await review.mintReviewGrant(SECRET, "hannah", 15);

    const traded = await exchange(off, valid);
    expect(traded.status).toBe(404);
    expect(await errorOf(traded)).toBe("Review access is not enabled");

    const listed = await queue(off, await review.mintReviewToken(SECRET, "hannah"));
    expect(listed.status).toBe(404);
    expect(await errorOf(listed)).toBe("Review access is not enabled");
  });
});

// ── What the operator is told a link is worth ────────────────────────────────

describe("the window a link actually buys", () => {
  /**
   *
   * `tools/review-link.ts` prints "Anyone holding this link is a reviewer for
   * the next N minutes", and the README's bolded **What the link is worth** says
   * the same in words: "Fifteen minutes, and whoever holds it is the reviewer
   * for those fifteen minutes". Both are the sentence an operator reads when
   * they pick `--minutes`, and when they decide whether a leak still matters.
   *
   * Neither is true. The exchange puts no ceiling of its own on the trade:
   * `mintReviewToken` stamps a fresh `REVIEW_TOKEN_TTL_MS` from `Date.now()`,
   * so a link caught in the last second of its life buys a full two-hour token
   * that keeps working long after the link is dead. The real worst case is
   * `--minutes` PLUS two hours, and the gap is what an operator gets wrong in
   * the direction that matters: "it was a five-minute link and it expired
   * twenty minutes ago, we are fine" is wrong by two hours, and the remedy they
   * would skip on the strength of it — rotate `REVIEW_SECRET` and restart — is
   * the only revocation this feature has.
   *
   * The first assertion passes and is what makes the second one's number real.
   */
  test("a link spent in its last second still opens the queue for two hours", async () => {
    const now = Date.now();
    const dying = await forge(SECRET, LINK_CONTEXT, {
      subject: "hannah",
      issuedAt: now - 59_000,
      expiresAt: now + 250,
    });

    const app = reviewApp(SECRET);
    const traded = await exchange(app, dying);
    expect(traded.status).toBe(200);
    const { token } = (await traded.json()) as { token: string };

    // Two hours from the trade, not from what is left of the link.
    const held = await review.readReviewToken(SECRET, token);
    expect(held.expiresAt - Date.now()).toBeGreaterThan(review.REVIEW_TOKEN_TTL_MS - 5_000);

    await Bun.sleep(300);
    expect(await refusal(review.readReviewGrant(SECRET, dying))).toContain("expired");
    // The link is dead and the reviewer is still in.
    expect((await queue(app, token)).status).toBe(200);
  });

  test("the CLI says so, because it is the only place an operator reads it", async () => {
    const printed = Bun.spawnSync(["bun", "run", "tools/review-link.ts", "hannah", "--minutes", "5"], {
      env: { ...process.env, REVIEW_SECRET: SECRET },
    });
    const said = new TextDecoder().decode(printed.stdout);

    // It already says the five. What it must also say is the two hours the five
    // turns into, or the sentence understates the exposure by 24x.
    expect(said).toContain("5 minutes");
    expect(said.toLowerCase()).toContain("two hours");
  });
});
