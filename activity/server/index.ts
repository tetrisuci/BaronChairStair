#!/usr/bin/env bun
/**
 * HTTP server for the daily Tetris puzzle.
 *
 * Serves the activity bundle, runs the Discord OAuth exchange, hands out the
 * day's puzzle, and verifies submitted runs by replaying their inputs. The
 * client is never trusted with a score — only with the keys it pressed.
 */

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { decodeBoard, ENGINE_ROWS } from "../shared/puzzle";

import { sanitizeHandling } from "../shared/tetris/handling";
import { sanitizeKeybinds } from "../shared/keybinds";
import { InvalidRunError, parseInputLog, verifyRun } from "../shared/tetris/verify";
import {
  AuthError,
  equalStrings,
  exchangeCode,
  mintSession,
  readSession,
  type Session,
  verifyGuild,
} from "./auth";
import { config } from "./config";
import { Store } from "./db";
import { callerKey, limitBodySize, MAX_BODY_BYTES, rateLimit } from "./limits";
import { PuzzleArchive } from "./puzzles";

const LEADERBOARD_SIZE = 25;
const MINUTE = 60_000;
/** A day of it: anything longer is a broken clock, not a long think. */
const MAX_TOTAL_MS = 24 * 60 * MINUTE;

const archive = PuzzleArchive.load(config.paths.puzzles, { timeZone: config.timeZone });
const store = new Store(config.paths.database);

type Variables = { session: Session };
const app = new Hono<{ Variables: Variables }>();

/**
 * Discord serves activities from its own origin and requires every request to
 * be prefixed with `/.proxy`. Depending on how the URL mapping is configured
 * that prefix may or may not be stripped before it reaches us, so accept both.
 */
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/.proxy/")) {
    url.pathname = url.pathname.slice("/.proxy".length);
    return app.fetch(new Request(url, c.req.raw));
  }
  await next();
});

app.use("/api/*", limitBodySize);

// Signing in talks to Discord on our behalf, and verifying a run blocks the
// event loop for tens of milliseconds, so those two get tighter limits than
// the reads.
app.use("/api/session", rateLimit({ max: 10, windowMs: MINUTE }, callerKey));
app.use("/api/daily/run", rateLimit({ max: 20, windowMs: MINUTE }, callerKey));
app.use("/api/*", rateLimit({ max: 240, windowMs: MINUTE }, callerKey));

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  if (error instanceof AuthError) {
    return c.json({ error: error.message }, error.status as 401);
  }
  // A malformed run is a bad request, not a server fault; saying so keeps real
  // faults visible in the log instead of drowning in client bugs.
  if (error instanceof InvalidRunError) return c.json({ error: error.message }, 400);
  console.error("[puzzle]", error);
  return c.json({ error: "Something went wrong on the server" }, 500);
});

// ── Auth ─────────────────────────────────────────────────────────────────────

async function requireSession(c: Context<{ Variables: Variables }>, next: Next) {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  c.set("session", await readSession(token));
  await next();
}

app.get("/api/config", (c) =>
  c.json({
    clientId: config.discord.clientId,
    allowGuestPlay: config.allowGuestPlay,
  }),
);

/**
 * Trades the embedded SDK's authorization code for a session.
 *
 * In development, a request with no code gets a local guest identity so the
 * activity can be played outside Discord.
 */
app.post("/api/session", async (c) => {
  type SessionBody = { code?: string; guildId?: string | null };
  const body: SessionBody = await c.req.json<SessionBody>().catch(() => ({}) as SessionBody);
  const guildId = typeof body.guildId === "string" && body.guildId ? body.guildId : null;

  if (!body.code) {
    if (!config.allowGuestPlay) throw new AuthError("An authorization code is required");
    // Every guest is the same player, so a guild claim from one would let
    // anyone write to any leaderboard under a shared identity. Guests are
    // global-only.
    const player = { id: "guest", username: "guest", avatarUrl: null };
    const { token } = await mintSession(player, null);
    return c.json({ token, player, guest: true });
  }

  const { accessToken, player } = await exchangeCode(body.code);
  store.upsertPlayer(player);
  const { token } = await mintSession(player, await verifyGuild(accessToken, guildId));
  return c.json({ token, player, accessToken, guest: false });
});

// ── Daily puzzle ─────────────────────────────────────────────────────────────

app.get("/api/daily", requireSession, (c) => {
  const session = c.get("session");
  const { day, puzzle, resetsAt } = archive.today();
  const run = store.runFor(day, session.player.id);
  return c.json({
    day,
    resetsAt,
    puzzle: archive.prompt(puzzle),
    run,
    streak: store.streak(session.player.id, day),
    totalSolved: store.totalSolved(session.player.id),
    // The answer is only ever sent once the player has solved it.
    solution: run?.solved ? puzzle.solution : null,
  });
});

app.post("/api/daily/run", requireSession, async (c) => {
  const session = c.get("session");
  const { day, puzzle } = archive.today();

  const body = await c.req
    .json<{ handling?: unknown; events?: unknown; resets?: unknown; totalMs?: unknown }>()
    .catch(() => {
      throw new HTTPException(400, { message: "Request body is not valid JSON" });
    });
  const handling = sanitizeHandling(body.handling);
  const events = parseInputLog(body.events);
  const resets = Number.isInteger(body.resets) ? Math.max(0, Math.min(9999, body.resets as number)) : 0;

  const setup = {
    board: decodeBoard(puzzle.board, ENGINE_ROWS),
    queue: puzzle.queue,
    hold: puzzle.hold,
  };
  const verified = verifyRun(setup, handling, events);

  const { run, isFirst } = store.recordRun(day, puzzle.id, session.player, session.guildId, {
    solved: verified.attack >= puzzle.targetAttack,
    attack: verified.attack,
    targetAttack: puzzle.targetAttack,
    durationMs: verified.durationMs,
    totalMs: totalTimeOnPuzzle(body.totalMs, verified.durationMs),
    resets,
    piecesPlaced: verified.placements.length,
    clears: verified.clears,
  });

  return c.json({
    run,
    isFirst,
    verified,
    streak: store.streak(session.player.id, day),
    totalSolved: store.totalSolved(session.player.id),
    // Same rule as every other route: the answer is only ever sent to somebody
    // who has solved it. Filing a deliberately empty run must not buy it.
    solution: run.solved ? puzzle.solution : null,
    leaderboard: store.leaderboard(day, session.guildId, LEADERBOARD_SIZE),
  });
});

/**
 * Time on the puzzle, as the player reports it.
 *
 * Nothing ties a wall clock to an input log, so this cannot be verified — only
 * bounded. It can never be less than the solving attempt actually took, and a
 * day of it is already far past anything real.
 */
function totalTimeOnPuzzle(claimed: unknown, verifiedMs: number): number {
  const value = typeof claimed === "number" && Number.isFinite(claimed) ? claimed : 0;
  return Math.min(MAX_TOTAL_MS, Math.max(verifiedMs, Math.round(value)));
}

app.get("/api/daily/leaderboard", requireSession, (c) => {
  const session = c.get("session");
  const day = archive.currentDay();
  return c.json({ day, entries: store.leaderboard(day, session.guildId, LEADERBOARD_SIZE) });
});

// ── Bot-facing endpoints ─────────────────────────────────────────────────────

/**
 * A summary of today's sheet with no answer in it, for the bot to post in a
 * channel. Public: everything here is on the puzzle's own front page.
 */
app.get("/api/today", (c) => {
  const { day, puzzle, resetsAt } = archive.today();
  return c.json({
    day,
    resetsAt,
    puzzle: {
      id: puzzle.id,
      title: puzzle.title,
      author: puzzle.author,
      difficulty: puzzle.difficulty,
      goal: puzzle.goal,
      set: puzzle.set,
      pieces: puzzle.queue.length,
      targetAttack: puzzle.targetAttack,
    },
    solvedCount: store.solvedCount(day),
  });
});

/** Per-server standings for the bot. Gated on a shared secret, not a session. */
app.get("/api/standings", (c) => {
  if (!config.botApiKey) throw new HTTPException(404, { message: "Bot access is not enabled" });
  if (!equalStrings(c.req.header("X-Api-Key") ?? "", config.botApiKey)) {
    throw new HTTPException(401, { message: "Bad API key" });
  }
  const day = archive.currentDay();
  const guildId = c.req.query("guild") ?? null;
  return c.json({ day, entries: store.leaderboard(day, guildId, LEADERBOARD_SIZE) });
});

// ── Practice archive ─────────────────────────────────────────────────────────

/**
 * Whether this player may see a puzzle's answer: always for the archive, and
 * for today's puzzle only once they have solved it.
 *
 * Solving is the gate rather than merely having a row, because an unsolved row
 * can still be upgraded by a later solve — the day is not over for that player —
 * and because filing a deliberately empty run would otherwise buy the answer.
 */
function maySeeSolution(session: Session, puzzleId: number): boolean {
  const { day, puzzle } = archive.today();
  if (puzzle.id !== puzzleId) return true;
  return store.runFor(day, session.player.id)?.solved === true;
}

app.get("/api/archive", requireSession, (c) => {
  const today = archive.currentDay();
  return c.json({
    puzzles: archive.puzzles.map((puzzle) => ({
      id: puzzle.id,
      title: puzzle.title,
      author: puzzle.author,
      difficulty: puzzle.difficulty,
      goal: puzzle.goal,
      set: puzzle.set,
      pieces: puzzle.queue.length,
      targetAttack: puzzle.targetAttack,
    })),
    today,
  });
});

app.get("/api/archive/:id", requireSession, (c) => {
  const puzzle = archive.get(Number.parseInt(c.req.param("id") ?? "", 10));
  if (!puzzle) throw new HTTPException(404, { message: "No such puzzle" });
  return c.json({
    puzzle: archive.prompt(puzzle),
    solution: maySeeSolution(c.get("session"), puzzle.id) ? puzzle.solution : null,
  });
});

// ── Preferences ──────────────────────────────────────────────────────────────

app.get("/api/prefs", requireSession, (c) =>
  c.json({ preferences: store.loadPreferences(c.get("session").player.id) }),
);

app.put("/api/prefs", requireSession, async (c) => {
  const session = c.get("session");
  const body = await c.req
    .json<{ preferences?: { version?: unknown; handling?: unknown; keybinds?: unknown } }>()
    .catch(() => {
      throw new HTTPException(400, { message: "Request body is not valid JSON" });
    });
  // Stored preferences are player-controlled, so only the known shapes are kept
  // — never the raw body, which would let anyone use the row as free unbounded
  // storage. The version travels through so the client can spot its own stale
  // copies; the server never interprets it.
  const claimed = body.preferences?.version;
  const version = Number.isInteger(claimed) ? (claimed as number) : 0;
  store.savePreferences(session.player, {
    version,
    handling: sanitizeHandling(body.preferences?.handling),
    keybinds: sanitizeKeybinds(body.preferences?.keybinds),
  });
  return c.json({ ok: true });
});

// ── Static client ────────────────────────────────────────────────────────────

// Everything else falls through to index.html, so unmatched API routes have to
// be turned away here or a typo'd endpoint answers 200 with a web page.
app.all("/api/*", (c) => c.json({ error: `No such endpoint: ${c.req.path}` }, 404));

// Any real file in the build — bundles, fonts, icons — is served as itself;
// `serveStatic` falls through when the path does not exist, so unknown routes
// still reach the single-page fallback below.
const buildRoot = relativeTo(config.paths.clientBuild);
app.use("*", serveStatic({ root: buildRoot }));
app.get("*", serveStatic({ path: `${buildRoot}/index.html` }));

/**
 * `serveStatic` resolves against the process working directory, so the build
 * has to be expressed relative to it. A deployment started from somewhere else
 * entirely would serve nothing silently, so say so at startup instead.
 */
function relativeTo(absolute: string): string {
  const cwd = `${process.cwd()}/`;
  if (absolute.startsWith(cwd)) return absolute.slice(cwd.length);
  console.warn(
    `[puzzle] the client build at ${absolute} is outside the working directory ` +
      `${process.cwd()} — start the server from the activity directory, or the ` +
      "page will not load.",
  );
  return absolute;
}

console.log(
  `puzzle — day ${archive.currentDay()}, ` +
    `${archive.puzzles.length} puzzles, resetting at midnight ${config.timeZone}, ` +
    `listening on :${config.port}` +
    (config.allowGuestPlay ? " (guest play enabled)" : ""),
);

export default {
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 60,
  // The Content-Length check in `limitBodySize` is a fast reject for honest
  // clients; a chunked request carries no length at all. This is the bound that
  // actually holds, applied by the runtime before a handler ever sees the body.
  maxRequestBodySize: MAX_BODY_BYTES,
};
