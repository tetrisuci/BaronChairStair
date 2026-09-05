#!/usr/bin/env bun
/**
 * HTTP server for the daily Tetris puzzle.
 *
 * Serves the activity bundle, runs the Discord OAuth exchange, hands out the
 * day's puzzle, and verifies submitted runs by replaying their inputs. The
 * client is never trusted with a score — only with the keys it pressed.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  decodeBoard,
  ENGINE_ROWS,
  pieceBudget,
  type Puzzle,
  toListing,
} from "../shared/puzzle";
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
  type RushTicket,
  type Session,
  verifyGuild,
} from "./auth";
import { config } from "./config";
import { enforcingGoals, solvedUnderPolicy } from "./solve-verdict";
import { Store, type StoredRun } from "./db";
import { DaySchedule, pastDaysOf } from "./schedule";
import {
  callerKey,
  limitBodySize,
  MAX_BODY_BYTES,
  rateLimit,
  readJsonBody,
} from "./limits";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";
import { PuzzleArchive } from "./puzzles";
import {
  apiError,
  GUEST_ID,
  requireSession,
  type Variables,
} from "./http";
import { registerReviewRoutes } from "./review-routes";
import { registerStaticRoutes } from "./static-routes";
import { registerSubmissionRoutes } from "./submission-routes";
import {
  type SocketData,
  duelSocket,
  puzzlesInPlayFor,
  openDuelSocket,
  sweepDuels,
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

/*
 * Store, then archive, then the backfill — and that order is load-bearing.
 *
 * The archive used to be built first and handed to the store's constructor. It
 * cannot be any more: accepted player submissions are part of the archive and
 * they live in this database, so the archive needs the store. The store's
 * backfill still needs the archive, because the derivation is the archive's.
 * The cycle is broken by making the backfill a step of its own rather than part
 * of opening a database — see `Store.pinPastDays`.
 *
 * Deriving history from a club-only archive and rebuilding afterwards was the
 * obvious alternative, and it is wrong: the two archives disagree about every
 * day nobody has played the moment one puzzle has ever been accepted, so the
 * pinned history would be a pool this process is not serving from.
 */
const store = new Store(config.paths.database);
const community = store.acceptedPuzzles();
/*
 * The corrections come out of the same database and go on last, over both
 * sources. This is the whole reason a correction survives `bun run puzzles`:
 * that command rewrites `data/puzzles.json` from the club's CSVs and knows
 * nothing about this table, so the rebuilt file is the *source* the corrections
 * are laid over rather than the last word.
 */
const archive = PuzzleArchive.load(
  config.paths.puzzles,
  { timeZone: config.timeZone },
  community,
  store.overridesFor(),
);
store.pinPastDays(pastDaysOf(archive));
/*
 * Every "what did day N hold" below goes through here, never through the
 * archive's own derivation. The archive still derives — that is where an
 * unpinned day's answer comes from — but a route that asked it directly would
 * be re-deriving a day somebody has already played, and once the pool grows
 * with accepted submissions the two answers stop agreeing. `archive` keeps only
 * what does not depend on the pool's size: the clock, the id lookup, the whole
 * listing, and the prompt shape.
 */
const schedule = new DaySchedule(archive, store);

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
// Tighter than the daily's twenty, because a submission replays a board the
// caller chose rather than one of today's three. Nobody writes five puzzles a
// minute, so this only ever costs somebody who is not writing puzzles.
app.use("/api/submissions", rateLimit({ max: 5, windowMs: MINUTE }, callerKey));
// Ten a minute on the exchange, knowing it may be one shared bucket: behind a
// proxy with `TRUST_PROXY` unset, `callerKey` falls back to the socket's peer
// address and every caller arrives as the proxy. What actually stands between a
// stranger and the review queue is 256 bits of HMAC, not this line.
app.use("/api/review/session", rateLimit({ max: 10, windowMs: MINUTE }, callerKey));
// Accepting replays a stored solve, so it is an engine call like the two above
// — behind a reviewer token rather than open, but a queue nobody clears at
// thirty a minute is not a queue anybody is reading.
app.use("/api/review/submissions/*", rateLimit({ max: 30, windowMs: MINUTE }, callerKey));
app.use("/api/*", rateLimit({ max: 240, windowMs: MINUTE }, callerKey));

app.onError(apiError);

// ── Auth ─────────────────────────────────────────────────────────────────────

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
  const body = await readJsonBody(c);
  const guildId = typeof body.guildId === "string" && body.guildId ? body.guildId : null;

  if (typeof body.code !== "string" || body.code === "") {
    if (!config.allowGuestPlay) throw new AuthError("An authorization code is required");
    // Every guest is the same player, so a guild claim from one would let
    // anyone write to any leaderboard under a shared identity. Guests are
    // global-only.
    const player = { id: GUEST_ID, username: GUEST_ID, avatarUrl: null };
    const { token } = await mintSession(player, null);
    return c.json({ token, player, guest: true });
  }

  const { accessToken, player } = await exchangeCode(String(body.code));
  store.upsertPlayer(player);
  const { token } = await mintSession(player, await verifyGuild(accessToken, guildId));
  return c.json({ token, player, accessToken, guest: false });
});

// ── Daily puzzle ─────────────────────────────────────────────────────────────

/**
 * Which of the day's three a request is about.
 *
 * Client-supplied and never trusted for anything but selection: naming a tier
 * chooses the board a log is replayed against, so a log played on the hard one
 * and filed as "easy" simply fails to solve the easy one. It cannot be used to
 * file somebody else's result, and it cannot be used to fetch an answer —
 * every solution below is gated on the run stored for that same tier, against
 * that same puzzle.
 */
function readTier(value: unknown): DailyTier {
  const tier = DAILY_TIERS.find((candidate) => candidate === value);
  if (!tier) throw new HTTPException(400, { message: "That is not one of today's three puzzles" });
  return tier;
}

/**
 * The reference solution, if this player has earned it on this exact puzzle.
 *
 * Keyed on the puzzle the run was filed against — `runs.puzzle_id` — and not on
 * (day, tier). A stored run names the board it was played on; matching it to a
 * freshly chosen puzzle by tier alone handed out the answer to a board the
 * player had never seen, every time the two disagreed. They disagreed whenever
 * the pool changed underneath a day, which is exactly what accepting community
 * puzzles does.
 *
 * Pinned days mean the two can no longer drift apart. This is what turns that
 * into something the route checks rather than something it assumes, and it
 * costs one comparison.
 */
function earnedSolution(run: StoredRun | undefined, puzzle: Puzzle) {
  if (!run?.solved || run.puzzleId !== puzzle.id) return null;
  // `?? null`, because `solution` became optional when the answers moved into
  // `data/solutions.json`. Undefined is dropped by `JSON.stringify` entirely,
  // so a client reading a documented `solution: … | null` would get no key at
  // all on a server running without that file.
  return puzzle.solution ?? null;
}

app.get("/api/daily", requireSession, (c) => {
  const session = c.get("session");
  const { day, puzzles, resetsAt } = schedule.today();
  const runs = store.runsFor(day, session.player.id);
  return c.json({
    day,
    resetsAt,
    puzzles: DAILY_TIERS.map((tier) => ({
      tier,
      puzzle: archive.prompt(puzzles[tier], enforcingGoals()),
      run: runs[tier] ?? null,
      // Gated per tier, not per day, and then per puzzle. Solving the easy one
      // must not hand over the hard one's answer — with one run a day that
      // distinction did not exist, and reading it as "solved today" is a
      // solution leak.
      solution: earnedSolution(runs[tier], puzzles[tier]),
    })),
    streak: store.streak(session.player.id, day),
    totalSolved: store.totalSolved(session.player.id),
  });
});

app.post("/api/daily/run", requireSession, async (c) => {
  const session = c.get("session");
  const { day, puzzles } = schedule.today();

  const body = await readJsonBody(c);
  const tier = readTier(body.tier);
  const puzzle = puzzles[tier];
  const handling = sanitizeHandling(body.handling);
  const events = parseInputLog(body.events);
  const resets = Number.isInteger(body.resets) ? Math.max(0, Math.min(9999, body.resets as number)) : 0;

  const setup = {
    board: decodeBoard(puzzle.board, ENGINE_ROWS),
    queue: puzzle.queue,
    hold: puzzle.hold,
  };
  const verified = verifyRun(setup, handling, events);

  const { run, isFirst } = store.recordRun(day, tier, puzzle.id, session.player, session.guildId, {
    solved: solvedUnderPolicy(verified.attack, verified.clears, puzzle, "daily"),
    attack: verified.attack,
    targetAttack: puzzle.targetAttack,
    durationMs: verified.durationMs,
    totalMs: totalTimeOnPuzzle(body.totalMs, verified.durationMs),
    resets,
    piecesPlaced: verified.placements.length,
    clears: verified.clears,
  });

  return c.json({
    tier,
    run,
    isFirst,
    verified,
    streak: store.streak(session.player.id, day),
    totalSolved: store.totalSolved(session.player.id),
    // Same rule as every other route: the answer is only ever sent to somebody
    // who has solved it, on the puzzle they solved. Filing a deliberately empty
    // run must not buy it — and neither must an earlier row for this same tier,
    // which is what `recordRun` hands back when today's attempt did not improve
    // on it.
    solution: earnedSolution(run, puzzle),
    leaderboard: store.leaderboard(day, session.guildId, tier, LEADERBOARD_SIZE),
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
  // One board for the day, merged in SQL. Three per-tier boards each applied
  // their own limit before anything joined them, which quietly dropped marks
  // for anyone near the bottom of one tier and the top of another.
  return c.json({
    day,
    board: store.dayBoard(day, session.guildId, LEADERBOARD_SIZE),
    // The day's rush, in the same answer. It belongs on the same board — a
    // player who spent their day on rush is not somebody who did nothing —
    // and a second round trip to say so would only be a second thing to fail.
    rush: store.rushLeaderboard(day, session.guildId, LEADERBOARD_SIZE),
  });
});

// ── Bot-facing endpoints ─────────────────────────────────────────────────────

/**
 * A summary of today's sheet with no answer in it, for the bot to post in a
 * channel. Public: everything here is on the puzzle's own front page.
 */
app.get("/api/today", (c) => {
  const { day, puzzles, resetsAt } = schedule.today();
  const describe = (puzzle: (typeof puzzles)[DailyTier]) => ({
    id: puzzle.id,
    title: puzzle.title,
    author: puzzle.author,
    difficulty: puzzle.difficulty,
    goal: puzzle.goal,
    set: puzzle.set,
    pieces: pieceBudget(puzzle),
    targetAttack: puzzle.targetAttack,
  });
  return c.json({
    day,
    resetsAt,
    puzzles: DAILY_TIERS.map((tier) => ({ tier, ...describe(puzzles[tier]) })),
    // People, not rows: a player has three results a day now, and this is the
    // "solved by N so far" line on the announcement.
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
  // One board per tier, because a player has a result in each and ranking them
  // against each other would compare a five-piece opener with a wall.
  return c.json({
    day,
    boards: DAILY_TIERS.map((tier) => ({
      tier,
      entries: store.leaderboard(day, guildId, tier, LEADERBOARD_SIZE),
    })),
  });
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

  const { puzzles } = schedule.forDay(day);
  return c.json({
    day,
    puzzles: DAILY_TIERS.map((tier) => ({
      tier,
      id: puzzles[tier].id,
      title: puzzles[tier].title,
      author: puzzles[tier].author,
      goal: puzzles[tier].goal,
      targetAttack: puzzles[tier].targetAttack,
    })),
    streak: store.guildStreak(guildId, day),
    daily: {
      rows: store.dayBoard(day, guildId, RECAP_SIZE),
      // How many people played, not how many rows they left.
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
  // Never the puzzle they are on right now: a duel round names its puzzle, and
  // this route would otherwise answer with the way to win it.
  if (puzzlesInPlayFor(session.player.id).has(puzzleId)) return false;
  // Which of today's three this is, if it is one of them at all. Asking "is it
  // today's puzzle" no longer has a single answer, and the tier matters: the
  // gate has to be the run for *this* puzzle's tier. Read as "solved today" it
  // would hand the hard answer to somebody who solved the easy one.
  //
  // Sound only because the day is pinned: while the three were re-derived, a
  // puzzle that had been today's easy an hour ago was suddenly none of today's,
  // and this answered `true` for it while players were still holding its
  // prompt.
  const day = archive.currentDay();
  const tier = schedule.tierOfDay(day, puzzleId);
  if (!tier) return true;
  const run = store.runFor(day, session.player.id, tier);
  // And the run has to be the run on *this* puzzle, for the same reason
  // `earnedSolution` checks it: a row filed under this tier against some other
  // board proves nothing about this one.
  return run?.solved === true && run.puzzleId === puzzleId;
}

app.get("/api/archive", requireSession, (c) => {
  const today = archive.currentDay();
  return c.json({ puzzles: archive.puzzles.map(toListing), today });
});

app.get("/api/archive/:id", requireSession, (c) => {
  const puzzle = archive.get(Number.parseInt(c.req.param("id") ?? "", 10));
  if (!puzzle) throw new HTTPException(404, { message: "No such puzzle" });
  return c.json({
    puzzle: archive.prompt(puzzle, enforcingGoals()),
    // `?? null` for the same reason as `earnedSolution`: an absent
    // `data/solutions.json` must read as "no solution", not as no field.
    solution: maySeeSolution(c.get("session"), puzzle.id) ? (puzzle.solution ?? null) : null,
  });
});

// ── Preferences ──────────────────────────────────────────────────────────────

app.get("/api/prefs", requireSession, (c) =>
  c.json({ preferences: store.loadPreferences(c.get("session").player.id) }),
);

app.put("/api/prefs", requireSession, async (c) => {
  const session = c.get("session");
  const body = await readJsonBody(c);
  // Stored preferences are player-controlled, so only the known shapes are kept
  // — never the raw body, which would let anyone use the row as free unbounded
  // storage. The version travels through so the client can spot its own stale
  // copies; the server never interprets it.
  const preferences = (body.preferences ?? {}) as Record<string, unknown>;
  const claimed = preferences.version;
  const version = Number.isInteger(claimed) ? (claimed as number) : 0;
  store.savePreferences(session.player, {
    version,
    handling: sanitizeHandling(preferences.handling),
    keybinds: sanitizeKeybinds(preferences.keybinds),
    filter: sanitizeArchiveFilter(preferences.filter),
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

/**
 * The puzzles a ticket's rush was built from, re-derived rather than trusted.
 *
 * From the day's *pinned* pool, so re-deriving really does reproduce what was
 * handed out. Drawn straight from `archive.puzzles`, it did not: the ticket
 * carries a seed and no pool identity, so a deploy inside the five-minute
 * window scored an in-flight run against a different set of forty puzzles and
 * reported the result as if nothing had happened.
 */
function sequenceFor(ticket: RushTicket) {
  return rushSequence(schedule.rushPoolFor(ticket.day), ticket.seed);
}

app.get("/api/rush", requireSession, (c) => {
  const session = c.get("session");
  const { day, resetsAt } = schedule.today();
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
  const { day } = schedule.today();
  const body = await readJsonBody(c);
  const practice = body.practice === true;

  // The daily rush can be played as often as you like. Only the first one of
  // the day is filed, and a replay keeps the day's own sequence rather than
  // being pushed into practice: "let me try that again" means that stack of
  // puzzles, not a fresh random one.
  //
  // `ranked` is decided here and travels inside the signed ticket, so the run
  // that comes back cannot claim to be the first when it is the fourth.
  const filed = store.rushRunFor(day, session.player.id) !== null;
  const ranked = !practice && !filed;

  /*
   * The day's shared sequence belongs to the run that is scored, and to that
   * run only. Everyone gets the same forty in the same order for the one
   * attempt that reaches the board, which is the whole basis for comparing two
   * players — and every run after it draws its own, because a replay that deals
   * the identical stack is a memory test rather than another go at the mode.
   *
   * The seed is the server's either way, never the client's, so nobody can
   * re-roll for a soft sequence without paying the five minutes for it.
   */
  const seed = ranked ? dailyRushSeed(day) : (Math.random() * 0x1_0000_0000) >>> 0;
  const ticket: RushTicket = {
    playerId: session.player.id,
    guildId: session.guildId,
    day,
    seed,
    ranked,
    startedAt: Date.now(),
  };

  return c.json({
    ticket: await mintRushTicket(ticket),
    ranked: ticket.ranked,
    day,
    durationMs: RUSH_DURATION_MS,
    skips: RUSH_SKIPS,
    puzzles: sequenceFor(ticket).map((puzzle) => archive.prompt(puzzle, enforcingGoals())),
  });
});

app.post("/api/rush/run", requireSession, async (c) => {
  const session = c.get("session");
  const body = await readJsonBody(c);

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
    return {
      solved: solvedUnderPolicy(verified.attack, verified.clears, puzzle, "rush"),
      durationMs: verified.durationMs,
    };
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

  /**
   * What happened on each puzzle, in the order they were played.
   *
   * The verifier's own answer rather than the client's: the end screen lists
   * these, and a screen that called something solved which the server had just
   * refused would be the one place the two disagree in front of the player.
   * Only the puzzles actually reached — the rest were never seen.
   */
  const played = results.map((outcome, index) => ({
    id: puzzles[index]!.id,
    title: puzzles[index]!.title,
    solved: outcome.solved,
  }));

  // Practice never touches the board. It exists so the ranked run is not the
  // only place to learn the mode.
  if (!ticket.ranked) {
    return c.json({
      ranked: false,
      played,
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
    played,
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

/**
 * The all-time rush board, in two scopes.
 *
 * `scope=server` narrows to the caller's guild; anything else is global. The
 * guild comes from the session and never from the query, so "server" cannot be
 * pointed at somebody else's.
 *
 * A session with no guild — the activity opened outside a server, and every
 * guest session — cannot have a server scope, and asking for one used to be
 * answered with `store.rushRecords(null)`, which means "across all servers".
 * That is the global board returned under `scope: "server"`, so the client lit
 * the "This server" tab over everybody's records. It answers `global` now, and
 * says so, which is the tab the client then lights.
 */
app.get("/api/rush/records", requireSession, (c) => {
  const session = c.get("session");
  const server = c.req.query("scope") === "server" && session.guildId !== null;
  return c.json({
    scope: server ? "server" : "global",
    entries: store.rushRecords(server ? session.guildId : null, LEADERBOARD_SIZE),
  });
});

app.get("/api/rush/leaderboard", requireSession, (c) => {
  const session = c.get("session");
  const day = archive.currentDay();
  return c.json({
    day,
    entries: store.rushLeaderboard(day, session.guildId, LEADERBOARD_SIZE),
  });
});

// ── Player submissions and review ────────────────────────────────────────────

/*
 * Both registered here rather than declared here, and both above the `/api/*`
 * catch-all below: a route added after it is dead code that answers 404, and
 * one added after the static handler answers 200 with the game.
 *
 * They moved into files of their own because this one had passed a thousand
 * lines with a review GUI still to come. `server/http.ts` holds the two things
 * a route module cannot invent for itself — the `Variables` shape and the error
 * mapping — so a route reads there exactly as it read here, and the rate limits
 * stay above with the rest of the stack rather than scattering with them.
 */
registerSubmissionRoutes(app, store);
registerReviewRoutes(app, { secret: config.reviewSecret, store, archive });

// ── Static client ────────────────────────────────────────────────────────────

// Everything else falls through to index.html, so unmatched API routes have to
// be turned away here or a typo'd endpoint answers 200 with a web page.
app.all("/api/*", (c) => c.json({ error: `No such endpoint: ${c.req.path}` }, 404));

// Both pages in the build, and the headers the review one needs. Registered
// from a module of its own so a test can point a build root at a fixture: the
// activity and the review tool come out of the same `dist`, and "/review served
// the game" is a silent success rather than an error.
registerStaticRoutes(app, relativeTo(config.paths.clientBuild));

/**
 * `serveStatic` resolves against the process working directory, so a build
 * inside it is expressed relative to it.
 *
 * An absolute root works too — `registerStaticRoutes` passes `root` and `path`
 * separately for exactly that reason — so this is a note, not a failure. What
 * it costs is that the process is then pinned to one checkout rather than to
 * wherever it was started, which is worth saying once at boot and is the only
 * thing left to say: `warnAboutMissingPages` covers the case where the files
 * genuinely are not there, and that is the warning an operator can act on.
 *
 * It used to end "or the page will not load", which stopped being true when the
 * single-page fallback started passing `path` rather than a joined string. A
 * warning nobody can act on is worse than none: it teaches the operator to
 * ignore the log the real warning is printed to.
 */
function relativeTo(absolute: string): string {
  const cwd = `${process.cwd()}/`;
  if (absolute.startsWith(cwd)) return absolute.slice(cwd.length);
  console.warn(
    `[puzzle] serving the client build from ${absolute}, which is outside the ` +
      `working directory ${process.cwd()} — it will load, but this process is ` +
      "pinned to that checkout.",
  );
  return absolute;
}

console.log(
  `puzzle — day ${archive.currentDay()}, ` +
    `${archive.puzzles.length} puzzles` +
    // Said at startup because this is the only moment it is ever answered. An
    // accepted puzzle joins the archive here and nowhere else, so a restart
    // that did not pick one up looks exactly like a restart that did.
    (community.length > 0 ? ` (${community.length} from players)` : "") +
    `, resetting at midnight ${config.timeZone}, ` +
    `listening on :${config.port}` +
    (config.allowGuestPlay ? " (guest play enabled)" : ""),
);

// Loud, because the failure it warns about is the quiet one. Behind a proxy
// with this unset, every player shares one rate-limit bucket and starts
// collecting 429s; the alternative default — trusting the header — is a bucket
// per forged header, which is no limit at all and says nothing when abused.
if (config.isProduction && !config.trustProxy) {
  console.warn(
    "[limits] TRUST_PROXY is not set, so rate limits are keyed on the socket's peer " +
      "address. If cloudflared, nginx or Caddy is in front of this, every player counts " +
      "as one caller — set TRUST_PROXY=true in activity/.env and restart.",
  );
}

useArchive(archive.puzzles);
// A lobby nobody joins, and a finished match nobody plays again, would
// otherwise sit in memory until the process ends.
setInterval(() => sweepDuels(), 60_000).unref?.();

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
