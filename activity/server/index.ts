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
import { trackedAnswers } from "./archive-solutions";
import { profileLines, recordDiscovery, seedReferenceSolutions } from "./discoveries";
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
import { reloadInPlace } from "./archive-reload";
import {
  apiError,
  GUEST_ID,
  requireSession,
  type Variables,
} from "./http";
import { registerReviewRoutes } from "./review-routes";
import { registerPublicRoutes, PUBLIC_PREFIX } from "./public-routes";
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
 * The top of one measure, ties broken by the measure itself.
 *
 * Sorted here rather than in SQL because all three daily boards come from one
 * pass over the same rows — see `Store.dailyRecords`. Zero is dropped: a board
 * of players on a nought-day streak is every player who has ever opened the
 * app, in no meaningful order.
 */
function topBy<T>(rows: readonly T[], of: (row: T) => number): T[] {
  return rows
    .filter((row) => of(row) > 0)
    .sort((a, b) => of(b) - of(a))
    .slice(0, LEADERBOARD_SIZE);
}
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
const trackedSolutions = trackedAnswers(config.paths.trackedArchive);
const archive = PuzzleArchive.load(
  config.paths.puzzles,
  { timeZone: config.timeZone },
  community,
  store.overridesFor(),
  trackedSolutions,
  store.publishedArchive(),
);
{
  // Worth a line. Without it a deploy box serves every puzzle answerless, and
  // the symptom — an empty reveal after a solve — reads as a client bug rather
  // than a file that was never there.
  const answered = archive.all.filter((puzzle) => puzzle.solution?.length).length;
  console.log(
    `[puzzle] answers: ${answered} of ${archive.all.length} puzzles have one ` +
      `(${trackedSolutions.size} available from the tracked archive)`,
  );
}
store.pinPastDays(pastDaysOf(archive));

/*
 * The archive's own answers, put on record so nobody can discover them. Without
 * this the first player to solve a puzzle the way its maker did collides with
 * nothing and is credited with finding an alternate. Idempotent, so it runs on
 * every boot; a no-op on a box without `data/solutions.json`, which is every
 * ordinary deploy, and it says so once rather than per puzzle.
 */
const seeded = seedReferenceSolutions(store, archive.all);
if (seeded.seeded > 0 || seeded.skipped > 0) {
  console.log(
    `[discovery] reference solutions: ${seeded.seeded} newly on record, ` +
      `${seeded.skipped} without an answer on this box`,
  );
}
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
// Practice runs the engine exactly as the daily does, so it is limited the
// same way. It is the one engine route a player can hit without a ticket or
// a once-a-day slot, so leaving it open would make it the cheapest way to
// spend the server's CPU.
app.use("/api/puzzles/:id/clear", rateLimit({ max: 20, windowMs: MINUTE }, callerKey));
// A rush is five minutes long, so nobody honest opens many of them a minute.
app.use("/api/rush/start", rateLimit({ max: 6, windowMs: MINUTE }, callerKey));
app.use("/api/rush/run", rateLimit({ max: 12, windowMs: MINUTE }, callerKey));
// Tighter than the daily's twenty, because a submission replays a board the
// caller chose rather than one of today's. Nobody writes five puzzles a
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
// The public archive gets its own budget, in its own key space.
//
// Both halves of that matter, and the first version of this had neither. Hono
// runs *every* matching middleware, so a `/api/*` limiter also covers
// `/api/public` — which meant the 600 below was unreachable (the 240 tripped
// first, measured at request 241) and, worse, that a stranger reading puzzles
// spent the same bucket the game uses. Behind cloudflared with `TRUST_PROXY`
// unset every caller collapses to one key, so that was one anonymous reader
// away from players getting 429 on sign-in and run submission.
//
// So the key is prefixed, making it a genuinely separate bucket, and the
// blanket limiter below steps aside for this prefix rather than double-counting
// it.
const publicKey = (c: Parameters<typeof callerKey>[0]) => `public:${callerKey(c)}`;
app.use(`${PUBLIC_PREFIX}/*`, rateLimit({ max: 600, windowMs: MINUTE }, publicKey));

const gameLimit = rateLimit({ max: 240, windowMs: MINUTE }, callerKey);
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith(PUBLIC_PREFIX)) return next();
  return gameLimit(c, next);
});

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
 * Which of the day's tiers a request is about.
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
  if (!tier) throw new HTTPException(400, { message: "That is not one of today's puzzles" });
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

  // A solve is a solve however it was reached, and this is one of three places
  // one can happen. Recorded off `run.solved` rather than re-deciding: the row
  // that was just filed is the fact, and a second judgement here could disagree
  // with the leaderboard about the same run.
  // `isFirst`, not `run.solved`: `recordRun`'s upsert is guarded by
  // `WHERE runs.solved = 0 AND excluded.solved = 1`, so re-posting a tier that
  // is already solved changes nothing and hands back the *existing* row — with
  // `solved` true. Counting off that inflated `times` on every replay.
  if (run.solved && isFirst) {
    store.recordClear({
      player: session.player,
      playerId: session.player.id,
      puzzleId: puzzle.id,
      durationMs: run.totalMs,
    });
  }

  // Filed after the run is recorded, never before: a discovery is a fact about
  // a run that counted, and nothing in here may cost a player the run they
  // just earned.
  const discovery = recordDiscovery(store, puzzle, verified, events, handling, {
    playerId: session.player.id,
    guildId: session.guildId,
  });

  return c.json({
    tier,
    run,
    isFirst,
    verified,
    discovery,
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

/**
 * Who has found the most lines nobody had found before — the ones that solved
 * a puzzle, and the ones that beat its attack target by another route.
 *
 * The one board here that is **not** scoped to a guild, and deliberately: every
 * other one answers "how did this club do today", while this one is a standing
 * about the archive, which is the same archive in every server that plays it.
 * See {@link Store.discoveryBoard}.
 *
 * `self` rides along because a global board is one almost nobody is on. Twenty
 * five strangers and no line for the person reading is what makes a leaderboard
 * feel closed, and the rank is already a cheap query.
 */
/**
 * What one player has done, for their own profile.
 *
 * Theirs by default, anybody's by id — the leaderboards link to these, so a name
 * on a board has to lead somewhere.
 *
 * This reverses what stood here. The earlier note said "there is no `?player=`
 * and there will not be one from here", on the grounds that a lifetime record is
 * not something a player opted into. What changed is that the boards now publish
 * most of it under a name anyway: puzzles solved, rush bests, streaks and lines
 * found are all on a board. What is *not* already public is withheld — see
 * `profileLines`, which shuts a found line's content to a reader who has not
 * solved that puzzle.
 *
 * `puzzlesCleared` is a count of distinct puzzles, which is not what the
 * masthead's older "solved" tally means — `totalSolved` counts distinct *days*,
 * so a player who solved all four tiers on ten days reads as 10 there and 40
 * here. Both are right about different questions; the labels have to say which.
 */
app.get("/api/profile/:id?", requireSession, (c) => {
  const session = c.get("session");
  const asked = c.req.param("id");
  // Their own unless another id is named. Every number this returns is one the
  // leaderboards already show under a name — puzzles solved, rush bests, lines
  // found — so opening a row to read the rest of them is not a new disclosure.
  // A player nobody has a row for still resolves: `profile` answers zeros and
  // `playerNamed` answers null, which the page renders as "no record yet"
  // rather than a 404 somebody has to interpret.
  const id = asked && asked !== session.player.id ? asked : session.player.id;
  const day = archive.currentDay();
  const player = id === session.player.id ? session.player : store.playerNamed(id);
  if (!player) throw new HTTPException(404, { message: "No such player" });

  // What they found, under the same name the count above it uses. `openable`
  // is about the *reader*, not the finder: a line is somebody else's answer to
  // a puzzle, so it stays shut until this reader has solved that puzzle
  // themselves — the same gate `/api/puzzles/:id/solutions` enforces, asked
  // here so the row can say so instead of failing when it is clicked.
  const mine = store.clearedPuzzleIds(session.player.id);
  const found = profileLines(
    store.discoveriesBy(id),
    (puzzleId) => archive.get(puzzleId)?.title ?? null,
    mine,
  );

  return c.json({
    player,
    isSelf: id === session.player.id,
    ...store.profile(id),
    archiveSize: archive.puzzles.length,
    streak: store.streak(id, day),
    daysSolved: store.totalSolved(id),
    found,
  });
});

/**
 * Every board, in one shape, in one round trip.
 *
 * Several categories that were unrelated queries returning unrelated row types. Normalised here rather than in the browser: a page whose
 * job is "the same list, five ways" should be handed the same list five times,
 * and the alternative is a client that knows how to unpack a rush row, a day
 * row, a discovery row and two more besides.
 *
 * `scope` is on every category because it is the question a reader will ask
 * first when they cannot find themselves. Two of these are this server's and
 * three are everybody's — the archive is one archive however many servers play
 * it, and how much of it somebody has solved is not a fact about a guild.
 *
 * None of them joins the others, so this is cheap
 * enough to answer whole rather than a category at a time.
 */
app.get("/api/leaderboards", requireSession, (c) => {
  const session = c.get("session");
  const day = archive.currentDay();
  const guild = session.guildId;

  // How today landed as a field, and where this player sits in it. Only the
  // "Today" board has a today; the other four are all-time or a different mode,
  // so this rides beside the categories rather than inside one.
  const mine = store.runsFor(day, session.player.id);
  const tiers = store.dailyTierStats(day, guild);
  // One pass over the daily history, sliced three ways below. Zeroes are
  // dropped rather than ranked: a board of people on a nought-day streak is a
  // list of everybody who has ever played, ordered arbitrarily.
  const records = store.dailyRecords(day);

  return c.json({
    day,
    daily: {
      tiers: DAILY_TIERS.map((tier) => ({
        tier,
        filed: tiers[tier].filed,
        solved: tiers[tier].solved,
        // What this player did on it: solved, filed and missed, or untouched.
        // `runsFor` drops 'legacy' rows, which is right — they belong to no tier.
        you: mine[tier] === undefined ? "none" : mine[tier]!.solved ? "solved" : "missed",
      })),
      standing: store.dayStanding(day, guild, session.player.id),
    },
    categories: [
      {
        key: "today",
        label: "Today",
        scope: guild ? "server" : "everyone",
        measure: "solved",
        entries: store.dayBoard(day, guild, LEADERBOARD_SIZE).map((row) => ({
          player: row.player,
          value: row.solved,
          // Raw, not formatted. `formatDuration` lives in the client and is
          // the one definition of what a time looks like here; a second one on
          // the server would be a second thing to keep in step.
          detailMs: row.solved > 0 ? row.totalMs : null,
        })),
      },
      {
        key: "rush-best",
        label: "Rush records",
        scope: guild ? "server" : "everyone",
        measure: "solved",
        entries: store.rushRecords(guild, LEADERBOARD_SIZE).map((row) => ({
          player: row.player,
          value: row.solved,
          detail: `day ${row.day}`,
        })),
      },
      {
        key: "dailies",
        label: "Dailies",
        scope: "everyone",
        measure: "solved",
        entries: topBy(records, (r) => r.solves).map((row) => ({
          player: row.player,
          value: row.solves,
          detail: `${row.days} ${row.days === 1 ? "day" : "days"}`,
        })),
      },
      {
        key: "streak",
        label: "Streak",
        scope: "everyone",
        measure: "days",
        entries: topBy(records, (r) => r.current).map((row) => ({
          player: row.player,
          value: row.current,
          detail: `best ${row.best}`,
        })),
      },
      {
        key: "streak-best",
        label: "Best streak",
        scope: "everyone",
        measure: "days",
        entries: topBy(records, (r) => r.best).map((row) => ({
          player: row.player,
          value: row.best,
          detail: `${row.days} ${row.days === 1 ? "day" : "days"} in all`,
        })),
      },
      {
        key: "solved",
        label: "Archive",
        scope: "everyone",
        measure: "puzzles",
        entries: store.clearsBoard(LEADERBOARD_SIZE).map((row) => ({
          player: row.player,
          value: row.cleared,
          detail: `of ${archive.puzzles.length}`,
        })),
      },
      {
        key: "discoveries",
        label: "Discoveries",
        scope: "everyone",
        measure: "lines",
        entries: store.discoveryBoard(LEADERBOARD_SIZE).map((row) => ({
          player: row.player,
          value: row.found,
          detail: "",
        })),
      },
    ],
  });
});

app.get("/api/discoveries", requireSession, (c) => {
  const session = c.get("session");
  return c.json({
    board: store.discoveryBoard(LEADERBOARD_SIZE),
    self: store.discoveryStanding(session.player.id),
  });
});

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
    // People, not rows: a player has one result per tier a day now, and this is the
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
  // The tiers this day actually dealt, which for any day pinned before `extreme`
  // existed is three. Reporting four would have the bot draw a fourth, always
  // blank square for a puzzle nobody was ever shown, and — because it sizes its
  // sweep line off the same list — deny the sweep to players who solved every
  // puzzle the day really had.
  const held = store.pinnedTiers(day);
  const dealt = DAILY_TIERS.filter((tier) => held[tier] !== undefined);
  const reported = dealt.length > 0 ? dealt : DAILY_TIERS;
  return c.json({
    day,
    puzzles: reported.map((tier) => ({
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

/**
 * The bot's `/archive sync` calls this once the sync has published, so what it
 * synced is playable without anybody restarting the server — which would drop
 * every duel in progress. See `server/archive-reload.ts` for how the swap keeps
 * everybody mid-game on the board they were shown.
 *
 * 422 when the sources would not load: the running archive is untouched, and
 * the message is the one an operator would otherwise have read in a crashed
 * boot.
 */
app.post("/api/bot/reload-archive", (c) => {
  requireBotKey(c);
  try {
    return c.json(
      reloadInPlace({
        archive,
        schedule,
        store,
        onPool: useArchive,
        load: () =>
          PuzzleArchive.load(
            config.paths.puzzles,
            { timeZone: config.timeZone },
            store.acceptedPuzzles(),
            store.overridesFor(),
            trackedSolutions,
            store.publishedArchive(),
          ),
      }),
    );
  } catch (error) {
    console.warn("[puzzle] archive reload refused; still serving the old pool.", error);
    throw new HTTPException(422, {
      message: `The archive did not reload, and players still have the old one: ${String(error)}`,
    });
  }
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
  // Which of today's tiers this is, if it is one of them at all. Asking "is it
  // today's puzzle" no longer has a single answer, and the tier matters: the
  // gate has to be the run for *this* puzzle's tier. Read as "solved today" it
  // would hand the hard answer to somebody who solved the easy one.
  //
  // Sound only because the day is pinned: while the day's puzzles were re-derived, a
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
  const session = c.get("session");
  // What this player has solved, so the list can tick them. It replaces a count
  // of how many lines each puzzle has on file, which was a reveal in its own
  // right — it told an unsolved player how many answers a puzzle has, which
  // `app.ts` already refuses to do in a toast.
  return c.json({
    puzzles: archive.puzzles.map(toListing),
    today,
    cleared: [...store.clearedPuzzleIds(session.player.id)],
  });
});

/**
 * Every way a puzzle has been solved, for the gallery beside the board.
 *
 * Behind the same gate as the answer itself, and not a looser one: these *are*
 * answers, several of them, and handing them out for a puzzle somebody has not
 * solved would give away far more than the reveal ever did. `maySeeSolution`
 * already carries that policy — always for the archive, and for today's only
 * once this player has solved that tier — so this asks it rather than
 * inventing a second rule that could drift from it.
 *
 * 403 rather than an empty list, because "you have not solved this yet" and
 * "nobody has found anything" are different answers and the card says
 * different things about them.
 */
/**
 * Files a practice solve, so it counts towards what a player has cleared.
 *
 * Practice has always been unscored and stays unscored: nothing here touches a
 * leaderboard, a streak, a rush board or a discovery. The single thing it
 * records is "this person has solved this board", which is what ticks the
 * Explore list and unlocks the puzzle's solutions.
 *
 * **The log is replayed, not believed** — but be clear about what that buys.
 * It stops a body with no run in it counting as a solve, which keeps
 * `puzzle_clears` an honest record of what people actually played: the Explore
 * ticks, the Archive leaderboard and the profile all read it. `verifyRun` is
 * the same path the daily and the rush already trust, and the verdict comes
 * from `solvedUnderPolicy`, so a practice solve is held to exactly a daily's bar.
 *
 * It is **not** a secrecy boundary, and nothing downstream should be built as
 * if it were. `/api/archive/:id` hands the reference answer to anyone signed
 * in for every puzzle that is not one of today's — `maySeeSolution` returns
 * `true` outright once the tier check passes — and `pathfinder.ts` ships in the
 * browser bundle, so a determined caller can route that answer into an input
 * log and file a real solve without ever playing the board. That is accepted:
 * the club's answers are public, and the gate on the gallery is there so a
 * reader does not spoil a puzzle they were about to try, not to keep a secret
 * there is none of.
 *
 * Today's puzzles are refused outright. A player could otherwise practise the
 * board they are about to be scored on and read its answers first — the exact
 * rehearsal `lockedPuzzleIds` exists to stop, arriving through a different
 * door. The client already refuses it; this is the half that cannot be edited
 * out in a console.
 */
app.post("/api/puzzles/:id/clear", requireSession, async (c) => {
  const session = c.get("session");
  const puzzle = archive.get(Number.parseInt(c.req.param("id") ?? "", 10));
  if (!puzzle) throw new HTTPException(404, { message: "No such puzzle" });
  if (schedule.tierOfDay(archive.currentDay(), puzzle.id)) {
    throw new HTTPException(403, { message: "That is one of today's — play it on the daily" });
  }

  const body = await readJsonBody(c);
  const handling = sanitizeHandling(body.handling);
  const verified = verifyRun(
    { board: decodeBoard(puzzle.board, ENGINE_ROWS), queue: puzzle.queue, hold: puzzle.hold },
    handling,
    parseInputLog(body.events),
  );
  const solved = solvedUnderPolicy(verified.attack, verified.clears, puzzle, "daily");
  if (solved) {
    store.recordClear({
      playerId: session.player.id,
      puzzleId: puzzle.id,
      durationMs: verified.durationMs,
    });
  }
  // The verdict goes back so the client can stop asking. It is not a score.
  //
  // And the answer, but only on a solve. The sheet was fetched when this player
  // had not yet cleared the puzzle, so `/api/archive/:id` rightly withheld it;
  // without handing it over here, solving a board for the first time would show
  // no walkthrough at all — the reveal would arrive only on the *second* visit.
  // Gated on the same `solved` the clear itself is, so a failure still learns
  // nothing.
  return c.json({
    solved,
    attack: verified.attack,
    clears: verified.clears,
    solution: solved ? (puzzle.solution ?? null) : null,
  });
});

app.get("/api/puzzles/:id/solutions", requireSession, (c) => {
  const puzzleId = Number.parseInt(c.req.param("id") ?? "", 10);
  const puzzle = archive.get(puzzleId);
  if (!puzzle) throw new HTTPException(404, { message: "No such puzzle" });
  const session = c.get("session");
  // Both gates, and they answer different questions. `maySeeSolution` is about
  // *today*: a puzzle currently being dealt as a daily tier stays shut until
  // this player has filed it, so the gallery can never be a rehearsal.
  // `hasCleared` is about ever: you may read how other people solved a board
  // once you have solved it yourself.
  //
  // This is a tightening. Until now every archive puzzle's answer was readable
  // by anyone signed in, solved or not.
  if (!maySeeSolution(session, puzzleId)) {
    throw new HTTPException(403, { message: "That is one of today's — play it on the daily first" });
  }
  if (!store.hasCleared(session.player.id, puzzleId)) {
    throw new HTTPException(403, { message: "Solve it yourself first" });
  }
  return c.json({ solutions: store.solutionGallery(puzzleId) });
});

app.get("/api/archive/:id", requireSession, (c) => {
  const puzzle = archive.get(Number.parseInt(c.req.param("id") ?? "", 10));
  if (!puzzle) throw new HTTPException(404, { message: "No such puzzle" });
  const session = c.get("session");
  // Both gates, the same pair the gallery route composes and for the same two
  // reasons. `maySeeSolution` is about *today*: a puzzle being dealt as a tier
  // stays shut until this player has filed it. `hasCleared` is about ever.
  //
  // The second one was missing here, and that was the whole bug: for any
  // puzzle that is not one of today's, `maySeeSolution` returns true outright,
  // so this route handed the maker's answer to anyone signed in. Open a puzzle
  // from Explore, fail it, and `attachWalkthrough` mounted the answer in the
  // rail — a puzzle nobody had solved, answered. The gallery of *other
  // people's* lines was already gated this way; the maker's own answer, which
  // is the bigger reveal, was not.
  const earned =
    maySeeSolution(session, puzzle.id) && store.hasCleared(session.player.id, puzzle.id);
  return c.json({
    puzzle: archive.prompt(puzzle, enforcingGoals()),
    // `?? null` for the same reason as `earnedSolution`: an absent
    // `data/solutions.json` must read as "no solution", not as no field.
    solution: earned ? (puzzle.solution ?? null) : null,
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

  // Each puzzle the rush actually solved, individually, and **before** the
  // unranked branch returns. A practice rush is still somebody solving a board:
  // it does not touch the rush leaderboard, and it has no business being
  // invisible to "have I solved #92". The same goes for a second ranked rush in
  // a day, whose `recordRushRun` is a DO NOTHING.
  //
  // The rush row itself records only how many were solved, which is the right
  // shape for its own board and no use at all for this question — and a rush is
  // where most players meet most of the archive.
  results.forEach((segment, index) => {
    if (!segment.solved) return;
    const puzzle = puzzles[index];
    if (puzzle) {
      store.recordClear({
        player: session.player,
        playerId: session.player.id,
        puzzleId: puzzle.id,
        durationMs: segment.durationMs,
      });
    }
  });

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
// The archive, for anybody. The one prefix in this server with CORS, and the
// one that serves answers — both explained in the module. It reads the same
// database the rest of the server writes, but through a handle that can only
// reach two tables' worth of queries.
registerPublicRoutes(app, store.archiveReader);

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
    // Said at startup because a restart that did not pick up an accepted
    // puzzle looks exactly like one that did. A reload through
    // `/api/bot/reload-archive` says the same thing in its own log line.
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
