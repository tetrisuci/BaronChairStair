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
import { decodeBoard, ENGINE_ROWS, meetsTarget, pieceBudget, toListing } from "../shared/puzzle";
import { sanitizeArchiveFilter } from "../shared/archive-filter";

import { sanitizeHandling } from "../shared/tetris/handling";
import { sanitizeKeybinds } from "../shared/keybinds";
import type { InputEvent } from "../shared/tetris/verify";
import { InvalidRunError, parseInputLog, verifyRun } from "../shared/tetris/verify";
import {
  dailyRushSeed,
  RUSH_DURATION_MS,
  RUSH_SKIPS,
  rushSequence,
} from "../shared/rush";
import {
  AuthError,
  equalStrings,
  exchangeCode,
  mintRushTicket,
  mintSession,
  readRushTicket,
  readSession,
  type RushTicket,
  type Session,
  verifyGuild,
} from "./auth";
import { config } from "./config";
import { Store } from "./db";
import { callerKey, limitBodySize, MAX_BODY_BYTES, rateLimit } from "./limits";
import { PuzzleArchive } from "./puzzles";
import {
  type SocketData,
  duelSocket,
  openDuelSocket,
  sweepLobbies,
  useArchive,
} from "./duel";

const LEADERBOARD_SIZE = 25;
/**
 * How many players a recap will name.
 *
 * The interactive boards show a top 25, which is the right size for a board.
 * A recap names everybody who played, and misses sort last — so the board's
 * own limit would quietly delete exactly the group the recap exists to tease.
 * `total` on the response says when even this was not enough.
 */
const RECAP_SIZE = 100;
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
// A rush is five minutes long, so nobody honest opens many of them a minute.
app.use("/api/rush/start", rateLimit({ max: 6, windowMs: MINUTE }, callerKey));
app.use("/api/rush/run", rateLimit({ max: 12, windowMs: MINUTE }, callerKey));
app.use("/api/*", rateLimit({ max: 240, windowMs: MINUTE }, callerKey));

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    // An exception carrying its own Response knows best. Otherwise Hono renders
    // the message as plain text, which every caller here reads as JSON and
    // reports as a bare "Request failed (409)" — so the one sentence explaining
    // what went wrong never reaches the player who needed it.
    return error.res ?? c.json({ error: error.message }, error.status);
  }
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
    solved: meetsTarget(verified.attack, puzzle.targetAttack),
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
      pieces: pieceBudget(puzzle),
      targetAttack: puzzle.targetAttack,
    },
    solvedCount: store.solvedCount(day),
  });
});

/**
 * The shared secret the bot presents, checked the same way for every bot route.
 *
 * @throws {HTTPException} 404 when bot access is switched off, 401 on a bad key.
 */
function requireBotKey(c: Context<{ Variables: Variables }>): void {
  if (!config.botApiKey) throw new HTTPException(404, { message: "Bot access is not enabled" });
  if (!equalStrings(c.req.header("X-Api-Key") ?? "", config.botApiKey)) {
    throw new HTTPException(401, { message: "Bad API key" });
  }
}

/** Per-server standings for the bot. Gated on a shared secret, not a session. */
app.get("/api/standings", (c) => {
  requireBotKey(c);
  const day = archive.currentDay();
  const guildId = c.req.query("guild") ?? null;
  return c.json({ day, entries: store.leaderboard(day, guildId, LEADERBOARD_SIZE) });
});

/**
 * A finished day, named by the caller.
 *
 * Bounded rather than passed through. SQLite binds NaN, a fraction and a
 * negative without complaint and answers every one of them with no rows, which
 * a recap would go on to post as "nobody played" for a day that people played.
 * `Number` rather than `Number.parseInt` for the same reason the bounds exist:
 * parseInt reads "12abc" as 12 and would answer confidently about the wrong
 * day.
 *
 * Today is refused along with the future, because the streak below counts a
 * gap as a break — which is only honest once the day is over.
 *
 * @throws {HTTPException} 400 if the day is missing, malformed or unfinished.
 */
function finishedDay(c: Context<{ Variables: Variables }>): number {
  const latest = archive.currentDay() - 1;
  const day = Number(c.req.query("day"));
  if (!Number.isInteger(day) || day < 1 || day > latest) {
    throw new HTTPException(400, {
      message: `day must be a whole number between 1 and ${latest}`,
    });
  }
  return day;
}

/**
 * Everything one server needs to look back on a finished day.
 *
 * A single route rather than a `?day=` on the boards, because a recap wants
 * three things about the same day at the same instant — who played, how long
 * the server's run of solves is, and which puzzle it even was — and a board
 * that answered only the first would leave the streak with no home.
 */
app.get("/api/recap", (c) => {
  requireBotKey(c);
  const day = finishedDay(c);
  const guildId = c.req.query("guild") ?? "";
  // `leaderboard` treats a falsy guild as "every server at once", so a dropped
  // parameter would put strangers into one server's recap.
  if (!guildId) throw new HTTPException(400, { message: "guild is required" });

  const { puzzle } = archive.forDay(day);
  return c.json({
    day,
    puzzle: {
      id: puzzle.id,
      title: puzzle.title,
      author: puzzle.author,
      goal: puzzle.goal,
      targetAttack: puzzle.targetAttack,
    },
    streak: store.guildStreak(guildId, day),
    daily: {
      entries: store.leaderboard(day, guildId, RECAP_SIZE),
      total: store.dayCount(day, guildId),
    },
    rush: {
      entries: store.rushLeaderboard(day, guildId, RECAP_SIZE),
      total: store.rushDayCount(day, guildId),
      durationMs: RUSH_DURATION_MS,
    },
  });
});

/** The rush board for the bot, same gate as the daily one. */
app.get("/api/rush/standings", (c) => {
  requireBotKey(c);
  const day = archive.currentDay();
  const guildId = c.req.query("guild") ?? null;
  return c.json({
    day,
    durationMs: RUSH_DURATION_MS,
    skips: RUSH_SKIPS,
    entries: store.rushLeaderboard(day, guildId, LEADERBOARD_SIZE),
  });
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
  return c.json({ puzzles: archive.puzzles.map(toListing), today });
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
    .json<{
      preferences?: { version?: unknown; handling?: unknown; keybinds?: unknown; filter?: unknown };
    }>()
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
    filter: sanitizeArchiveFilter(body.preferences?.filter),
  });
  return c.json({ ok: true });
});

// ── Puzzle rush ──────────────────────────────────────────────────────────────

/**
 * Slack on the five minutes, for the round trip the client cannot control.
 *
 * It is real: ten seconds of wall clock a determined client can keep playing
 * in. Shrinking it trades directly against robbing an honest player on a slow
 * connection at the buzzer, and there is no value that is right for both.
 */
const RUSH_GRACE_MS = 10_000;

/**
 * Frames the five minutes can hold, plus the grace, as a ceiling on how far a
 * submission may make the engine tick.
 */
const RUSH_MAX_FRAMES = Math.ceil(((RUSH_DURATION_MS + RUSH_GRACE_MS) / 1000) * 60);

/**
 * Events one rush may submit, across every segment.
 *
 * `MAX_EVENTS` already bounds a single puzzle, but a rush is forty of them, and
 * the body cap alone would let a submission through that costs far more to
 * replay than to send.
 */
const MAX_RUSH_EVENTS = 40_000;

interface RushSegment {
  readonly events: InputEvent[];
}

/**
 * Reads the segments off an untrusted body.
 *
 * A segment is only its input log. It carries no puzzle id, no solved flag and
 * no skip flag, because position in the day's sequence already says which
 * puzzle it was and replaying it says how it went — the same reason
 * `POST /api/daily/run` never lets a client name the puzzle it played.
 */
function parseRushSegments(input: unknown, limit: number): RushSegment[] {
  if (!Array.isArray(input)) throw new InvalidRunError("Segments must be an array");
  if (input.length > limit) {
    throw new InvalidRunError(`A rush has only ${limit} puzzles, got ${input.length} segments`);
  }
  let total = 0;
  const segments = input.map((raw, index) => {
    const events = parseInputLog((raw as { events?: unknown })?.events ?? []);
    total += events.length;
    if (total > MAX_RUSH_EVENTS) {
      throw new InvalidRunError(`Rush input log too long at segment ${index}`);
    }
    return { events };
  });

  // Replaying is the expensive part, so the cheap impossibility is checked
  // first: no honest client can have made the engine run more frames than the
  // five minutes hold. Without it, one event parked at the far end of a segment
  // forces a replay of every frame up to it, forty times over.
  //
  // What is summed is how far each segment REACHES, not how far it spans. Every
  // segment starts a fresh engine at frame zero, so the reach is what the replay
  // costs; the span is not, and measuring the span let a keydown and a keyup at
  // the same far frame through as zero play. Forty of those cost 386ms of
  // blocked event loop and were then turned away by a later rule that had
  // already paid for the replay.
  const frames = segments.reduce((sum, segment) => {
    const last = segment.events[segment.events.length - 1];
    return sum + (last ? last.frame + 1 : 0);
  }, 0);
  if (frames > RUSH_MAX_FRAMES) {
    throw new InvalidRunError("Submitted play is longer than a rush");
  }
  return segments;
}

/** The puzzles a ticket's rush was built from, re-derived rather than trusted. */
function sequenceFor(ticket: RushTicket) {
  return rushSequence(archive.puzzles, ticket.seed);
}

app.get("/api/rush", requireSession, (c) => {
  const session = c.get("session");
  const { day, resetsAt } = archive.today();
  return c.json({
    day,
    resetsAt,
    durationMs: RUSH_DURATION_MS,
    skips: RUSH_SKIPS,
    run: store.rushRunFor(day, session.player.id),
    best: store.bestRush(session.player.id),
    leaderboard: store.rushLeaderboard(day, session.guildId, LEADERBOARD_SIZE),
  });
});

/**
 * Opens a rush and starts the clock.
 *
 * The response is the only place the puzzles are handed out, and the ticket is
 * the only record that it happened — see {@link RushTicket} for why nothing is
 * written down.
 */
app.post("/api/rush/start", requireSession, async (c) => {
  const session = c.get("session");
  const { day } = archive.today();
  const body = await c.req.json<{ practice?: unknown }>().catch(() => ({}) as { practice?: unknown });
  const practice = body.practice === true;

  if (!practice && store.rushRunFor(day, session.player.id)) {
    throw new HTTPException(409, {
      message: "Today's rush is already on the board. Practice runs are unlimited.",
    });
  }

  // A practice seed the client never chose, so nobody can re-roll for a soft
  // sequence without paying the five minutes for it.
  const seed = practice ? (Math.random() * 0x1_0000_0000) >>> 0 : dailyRushSeed(day);
  const ticket: RushTicket = {
    playerId: session.player.id,
    guildId: session.guildId,
    day,
    seed,
    ranked: !practice,
    startedAt: Date.now(),
  };

  return c.json({
    ticket: await mintRushTicket(ticket),
    ranked: ticket.ranked,
    day,
    durationMs: RUSH_DURATION_MS,
    skips: RUSH_SKIPS,
    puzzles: sequenceFor(ticket).map((puzzle) => archive.prompt(puzzle)),
  });
});

app.post("/api/rush/run", requireSession, async (c) => {
  const session = c.get("session");
  const body = await c.req
    .json<{
      ticket?: unknown;
      handling?: unknown;
      segments?: unknown;
      timeToLastSolveMs?: unknown;
      skipsUsed?: unknown;
    }>()
    .catch(() => {
      throw new HTTPException(400, { message: "Request body is not valid JSON" });
    });

  const ticket = await readRushTicket(body.ticket);
  // A ticket is bound to whoever it was minted for; presenting somebody else's
  // would otherwise file a run under this session with that clock.
  if (ticket.playerId !== session.player.id) {
    throw new HTTPException(403, { message: "That rush ticket belongs to someone else" });
  }

  // The whole timing model, in one subtraction between two instants the server
  // stamped itself. Everything else about the clock is a sanity check.
  const elapsedMs = Date.now() - ticket.startedAt;
  if (elapsedMs < 0) {
    throw new HTTPException(400, { message: "That rush has not started yet" });
  }
  if (elapsedMs > RUSH_DURATION_MS + RUSH_GRACE_MS) {
    throw new HTTPException(408, { message: "That rush ran out of time" });
  }

  const handling = sanitizeHandling(body.handling);
  const puzzles = sequenceFor(ticket);
  const segments = parseRushSegments(body.segments, puzzles.length);

  const results = segments.map((segment, index) => {
    const puzzle = puzzles[index]!;
    const verified = verifyRun(
      { board: decodeBoard(puzzle.board, ENGINE_ROWS), queue: puzzle.queue, hold: puzzle.hold },
      handling,
      segment.events,
    );
    return { solved: meetsTarget(verified.attack, puzzle.targetAttack), durationMs: verified.durationMs };
  });

  // A puzzle is left behind by solving it or by skipping it — a dead board just
  // restarts, and the restarted attempt is what gets submitted. So an unsolved
  // segment is either a skip or the one the buzzer caught mid-puzzle, and there
  // can be at most one of the latter. That total is the budget, and counting it
  // is what enforces it: there is no skip flag on the wire to disbelieve.
  //
  // Counting by position instead — "every unsolved segment except the last one"
  // — was wrong in both directions. A player whose final act was a skip had it
  // excused as the buzzer and saw one fewer than they spent, and the same
  // excuse handed everybody a third skip.
  const unsolved = results.filter((result) => !result.solved).length;
  const unfinished = 1;
  if (unsolved > RUSH_SKIPS + unfinished) {
    throw new InvalidRunError(
      `A rush allows ${RUSH_SKIPS} skips and one unfinished puzzle, this one left ${unsolved}`,
    );
  }

  // Which of the unsolved ones was the buzzer is not visible in the logs, so
  // the count the client kept is used for display — clamped to what the replay
  // actually shows unsolved, and to the budget, so it can only ever be honest
  // about a number the server already proved.
  const claimedSkips = body.skipsUsed;
  const skipsUsed = Math.min(
    Number.isInteger(claimedSkips) ? Math.max(0, claimedSkips as number) : unsolved,
    unsolved,
    RUSH_SKIPS,
  );

  const solved = results.filter((result) => result.solved).length;
  const lastSolvedIndex = results.findLastIndex((result) => result.solved);
  const result = {
    solved,
    attempted: results.length,
    skipsUsed,
    timeToLastSolveMs: timeToLastSolve(body.timeToLastSolveMs, results, lastSolvedIndex, elapsedMs),
    elapsedMs: Math.min(elapsedMs, RUSH_DURATION_MS),
  };

  // Practice never touches the board. It exists so the ranked run is not the
  // only place to learn the mode.
  if (!ticket.ranked) {
    return c.json({
      ranked: false,
      run: { day: ticket.day, player: session.player, createdAt: Date.now(), ...result },
      isFirst: false,
      best: store.bestRush(session.player.id),
      leaderboard: store.rushLeaderboard(archive.currentDay(), session.guildId, LEADERBOARD_SIZE),
    });
  }

  // Scored against the day the rush began, not the day it was handed in: a run
  // started at 23:59 belongs to the day the player started it.
  const { run, isFirst } = store.recordRushRun(ticket.day, session.player, ticket.guildId, result);
  return c.json({
    ranked: true,
    run,
    isFirst,
    best: store.bestRush(session.player.id),
    leaderboard: store.rushLeaderboard(ticket.day, ticket.guildId, LEADERBOARD_SIZE),
  });
});

/**
 * When the last solve landed, which is what separates two players on the same
 * count.
 *
 * The client reports it, because only the client watched a wall clock while the
 * run was happening. It is bounded on both sides by things the server knows:
 * never less than the replayed play it took to reach that solve, never more
 * than the run the server timed. That is the same trade `totalTimeOnPuzzle`
 * makes for the daily — a claim, squeezed until lying about it buys very
 * little.
 */
function timeToLastSolve(
  claimed: unknown,
  results: readonly { durationMs: number }[],
  lastSolvedIndex: number,
  elapsedMs: number,
): number {
  if (lastSolvedIndex < 0) return 0;
  const played = results
    .slice(0, lastSolvedIndex + 1)
    .reduce((total, result) => total + result.durationMs, 0);
  const ceiling = Math.min(elapsedMs, RUSH_DURATION_MS);
  const value = typeof claimed === "number" && Number.isFinite(claimed) ? Math.round(claimed) : 0;
  return Math.min(ceiling, Math.max(Math.min(played, ceiling), value));
}

app.get("/api/rush/leaderboard", requireSession, (c) => {
  const session = c.get("session");
  const day = archive.currentDay();
  return c.json({
    day,
    entries: store.rushLeaderboard(day, session.guildId, LEADERBOARD_SIZE),
  });
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

useArchive(archive.puzzles);
// Lobbies nobody joins would otherwise sit in memory until the process ends.
setInterval(() => sweepLobbies(), 60_000).unref?.();

const DUEL_PATH = "/api/duel";

/**
 * Whether a request is the duel upgrade, under either prefix.
 *
 * Recognised before Hono routing rather than as a route, because the `/.proxy`
 * middleware re-dispatches through a copy of the request and Bun binds an
 * upgrade to the object it was handed — so an upgrade that reaches a route via
 * that path can never succeed.
 */
function isDuelPath(pathname: string): boolean {
  const bare = pathname.startsWith("/.proxy") ? pathname.slice("/.proxy".length) : pathname;
  return bare === DUEL_PATH;
}

export default {
  port: config.port,
  /**
   * `server` is optional so the test suite, which drives `fetch` with one
   * argument, still exercises every HTTP route.
   */
  fetch(request: Request, server?: import("bun").Server<SocketData>) {
    const url = new URL(request.url);
    if (isDuelPath(url.pathname)) return openDuelSocket(request, server, url);
    return app.fetch(request, server);
  },
  websocket: duelSocket,
  idleTimeout: 60,
  // The Content-Length check in `limitBodySize` is a fast reject for honest
  // clients; a chunked request carries no length at all. This is the bound that
  // actually holds, applied by the runtime before a handler ever sees the body.
  maxRequestBodySize: MAX_BODY_BYTES,
};
