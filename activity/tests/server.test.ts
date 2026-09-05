/**
 * Route-level tests.
 *
 * Everything else in this suite exercises `shared/`, which left the routes —
 * where the answer is withheld, the limits are applied, and the run is
 * recorded — covered only by a manual script. Each test here corresponds to a
 * defect that reached review.
 *
 * The server module is imported for its `fetch`, not started: Bun only listens
 * when a file is the entrypoint, so this drives the real handler stack in
 * process.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { archive, hasSolutions, solutionOf } from "./archive";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only, so nothing under `server/` is loaded before `beforeAll` has set the
// environment `config` reads once at import.
import { Store, type StoredRushRun } from "../server/db";
import {
  decodeBoard,
  ENGINE_ROWS,
  meetsTarget,
  pieceBudget,
  type Puzzle,
  type PuzzlePrompt,
} from "../shared/puzzle";
import { RUSH_DURATION_MS, RUSH_SEQUENCE_LENGTH, RUSH_SKIPS } from "../shared/rush";
import { createPuzzleEngine, toLetter } from "../shared/tetris/engine";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { findPaths } from "../shared/tetris/pathfinder";
import { MAX_FRAMES, type GameKey, type InputEvent, verifyRun } from "../shared/tetris/verify";

const DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);

let fetchApp: (request: Request) => Response | Promise<Response>;

beforeAll(async () => {
  process.env.DATABASE_PATH = DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  const server = (await import("../server/index")).default;
  fetchApp = server.fetch;
});

/**
 * Nothing deletes this run's database, and no test file may.
 *
 * Six files share it — `grep -rn puzzle-routes- tests/` — and `bun test` gives
 * no order between them, so an `afterAll` here was deleting a file five other
 * files were still using. The failure it produced is a quiet one and it does
 * not look like a teardown bug: the app's store keeps its open handle and goes
 * on writing to the now-unlinked inode, while any later `new Store(path)` —
 * `openStore()` in `submissions.test.ts` is one — finds no file, *creates* it
 * (the constructor is `create: true` plus `CREATE TABLE IF NOT EXISTS`), and
 * reads an empty database. The assertion then fails with a count of 0 or a null
 * row, which reads as "the route did not store it" rather than "the file moved
 * under us". It reached production as four failures in `submissions.test.ts` on
 * a Linux box while macOS ran the same commit green, because the two order the
 * files differently.
 *
 * So the file is left for the OS to reclaim — it is in `tmpdir()` and keyed by
 * pid, so runs cannot collide — and tidiness is handled below instead, by
 * sweeping what *earlier* runs left rather than what this one is using.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

for (const name of readdirSync(tmpdir())) {
  const owner = /^puzzle-routes-(\d+)\.sqlite(?:-wal|-shm)?$/.exec(name);
  // Never this run's, and never a live one: another `bun test` may be running
  // on this box right now, and its database is not ours to remove. An hour is
  // far longer than the suite takes and far shorter than anyone would keep a
  // temp file on purpose.
  if (!owner || Number(owner[1]) === process.pid) continue;
  const path = join(tmpdir(), name);
  try {
    if (Date.now() - statSync(path).mtimeMs > STALE_AFTER_MS) rmSync(path, { force: true });
  } catch {
    // Raced with another run's own sweep, or gone already. Either is fine.
  }
}

const BASE = "http://localhost";

function get(path: string, token?: string): Promise<Response> {
  return Promise.resolve(
    fetchApp(new Request(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })),
  );
}

function post(path: string, body: unknown, token?: string): Promise<Response> {
  return Promise.resolve(
    fetchApp(
      new Request(BASE + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function guestToken(): Promise<string> {
  const response = await post("/api/session", {});
  return ((await response.json()) as { token: string }).token;
}

describe("the answer is withheld until it is earned", () => {
  test("GET /api/daily sends no solution to a player who has not solved it", async () => {
    const body = (await (await get("/api/daily", await guestToken())).json()) as {
      puzzles: { tier: string; solution: unknown; puzzle: { id: number } }[];
    };
    // All three of them. The gate is per tier now, and a day where one of the
    // three leaked its answer would be a day the other two vouched for.
    expect(body.puzzles.map((entry) => entry.tier)).toEqual(["easy", "medium", "hard"]);
    for (const entry of body.puzzles) {
      expect(entry.solution).toBeNull();
      expect(entry.puzzle.id).toBeGreaterThan(0);
    }
  });

  test("the practice archive withholds today's puzzle", async () => {
    const token = await guestToken();
    const daily = (await (await get("/api/daily", token)).json()) as {
      puzzles: { puzzle: { id: number } }[];
    };
    // Every one of today's three, not just the first. Solving none of them and
    // asking the archive for any of them must come back empty.
    for (const entry of daily.puzzles) {
      const practice = (await (await get(`/api/archive/${entry.puzzle.id}`, token)).json()) as {
        solution: unknown;
      };
      expect(practice.solution).toBeNull();
    }
  });

  test("filing an empty run does not buy the solution", async () => {
    const token = await guestToken();
    for (const tier of ["easy", "medium", "hard"]) {
      const body = (await (
        await post("/api/daily/run", { tier, events: [], resets: 0 }, token)
      ).json()) as { run: { solved: boolean }; solution: unknown };
      expect(body.run.solved).toBe(false);
      expect(body.solution).toBeNull();
    }
  });
});

describe("request handling", () => {
  test("a malformed input log is the caller's fault, not a server fault", async () => {
    const response = await post(
      "/api/daily/run",
      { events: [{ frame: 0, type: "keydown", data: { key: "selfDestruct", subframe: 0 } }] },
      await guestToken(),
    );
    expect(response.status).toBe(400);
  });

  test("an unknown API route is a 404, not the single-page app", async () => {
    const response = await get("/api/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("json");
  });

  test("the bot endpoint refuses a wrong key", async () => {
    const response = await fetchApp(
      new Request(`${BASE}/api/standings?guild=1`, { headers: { "X-Api-Key": "wrong" } }),
    );
    expect([401, 404]).toContain(response.status);
  });

  test("the same caller is rate limited on sign-in", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const response = await fetchApp(
        new Request(`${BASE}/api/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cf-Connecting-Ip": "203.0.113.7" },
          body: "{}",
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });

  test("rotating the Authorization header does not mint a fresh allowance", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const response = await fetchApp(
        new Request(`${BASE}/api/session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cf-Connecting-Ip": "203.0.113.9",
            Authorization: `Bearer rotating-${i}`,
          },
          body: "{}",
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });
});

// ── Puzzle rush ──────────────────────────────────────────────────────────────

/**
 * The archive as it sits on disk, answers and all.
 *
 * Reading it here is the whole shape of these tests: the rush routes hand out
 * prompts with the solution stripped, so a segment that solves anything has to
 * be reconstructed from the answer on disk and sent as keystrokes, exactly as
 * `tools/e2e-submit.ts` does against a running server.
 */
// Merged with the untracked answers; see tests/archive.ts.

/** Enough segments for a skip in the middle with solves on either side of it. */
const SEGMENTS_PLAYED = 5;
const SKIPPED_SEGMENT = 3;
/** Solves the ranked run files. Small: each is played out here and replayed there. */
const RANKED_SOLVES = 2;

interface RushStartBody {
  readonly ticket: string;
  readonly ranked: boolean;
  readonly day: number;
  readonly durationMs: number;
  readonly skips: number;
  readonly puzzles: readonly PuzzlePrompt[];
}

interface RushRunBody {
  readonly ranked: boolean;
  readonly played: readonly { id: number; title: string; solved: boolean }[];
  readonly run: StoredRushRun;
  readonly isFirst: boolean;
  readonly best: number;
  readonly leaderboard: readonly StoredRushRun[];
}

interface RushBoardBody {
  readonly day: number;
  readonly run: StoredRushRun | null;
  readonly best: number;
  readonly leaderboard: readonly StoredRushRun[];
}

interface RushSegment {
  readonly events: readonly InputEvent[];
}

function setupFor(puzzle: Puzzle) {
  return { board: decodeBoard(puzzle.board, ENGINE_ROWS), queue: puzzle.queue, hold: puzzle.hold };
}

/** The archived puzzle a served prompt was cut from, answer included. */
function answerFor(prompt: PuzzlePrompt): Puzzle {
  const puzzle = archive.find((entry) => entry.id === prompt.id);
  if (!puzzle) throw new Error(`A rush served puzzle ${prompt.id}, which is not in the archive`);
  return puzzle;
}

/**
 * Keystrokes that play a puzzle's archived solution.
 *
 * The archive records where each piece came to rest, not how it got there, so
 * the route back has to be searched for — a spin only counts if the last input
 * before the drop was a rotation.
 */
function solvingLog(puzzle: Puzzle): InputEvent[] {
  const { engine } = createPuzzleEngine(setupFor(puzzle), DEFAULT_HANDLING);
  const events: InputEvent[] = [];
  let frame = 0;
  const tap = (key: GameKey) => {
    events.push({ frame, type: "keydown", data: { key, subframe: 0 } });
    events.push({ frame: frame + 1, type: "keyup", data: { key, subframe: 0 } });
    frame += 2;
  };

  for (const step of solutionOf(puzzle).slice(0, pieceBudget(puzzle))) {
    if (toLetter(engine.falling.symbol) !== step.piece) {
      tap("hold");
      engine.hold(false, true);
    }
    const route = findPaths(engine, step.cells)[0];
    if (!route) throw new Error(`No route to the archived placement for puzzle ${puzzle.id}`);
    for (const key of route) {
      tap(key);
      engine.press(key);
    }
    tap("hardDrop");
    engine.press("hardDrop");
  }
  return events;
}

/** What the server should make of a segment, worked out independently of it. */
function solves(puzzle: Puzzle, events: readonly InputEvent[]): boolean {
  const verified = verifyRun(setupFor(puzzle), DEFAULT_HANDLING, events);
  return meetsTarget(verified.attack, puzzle.targetAttack);
}

function skips(count: number): RushSegment[] {
  return Array.from({ length: count }, () => ({ events: [] }));
}

function startRush(token: string, isPractice: boolean): Promise<Response> {
  return post("/api/rush/start", { practice: isPractice }, token);
}

/** `claims` are the numbers a client reports about its own run, which the server bounds. */
function submitRush(
  token: string,
  ticket: unknown,
  segments: readonly RushSegment[],
  claims: { timeToLastSolveMs?: number; skipsUsed?: number } = {},
): Promise<Response> {
  return post("/api/rush/run", { ticket, handling: DEFAULT_HANDLING, segments, ...claims }, token);
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

/**
 * Five minutes a run, forty puzzles a run, two skips a run — and a client that
 * is trusted with none of those numbers. Each of these pins one place where the
 * server has to work out for itself what happened: which puzzles it handed out,
 * which of them came back solved, and how many were left behind.
 *
 * The tests run in order and share one guest identity, because guest play
 * collapses every session onto a single player. That is load-bearing twice
 * over: the practice runs have to be shown not to reach the board before the
 * ranked one is filed, and the ranked one can only be filed once.
 *
 * They also share a rate-limit bucket — six starts a minute, twelve runs — and
 * open five rushes between them. Another start belongs in an existing test
 * rather than in a sixth call.
 */
/*
 * Guarded, like every other block that needs the club's reference answers:
 * `data/solutions.json` is untracked — an answer key beside the puzzles is an
 * answer key for everybody — so a fresh clone has boards and no solutions, and
 * `solutionOf` throws rather than returning one. `tests/archive.ts` states the
 * rule these blocks were missing: a test that builds a solving log skips, so
 * somebody cloning this repo sees a suite that passes rather than one that
 * looks broken by their own checkout.
 */
describe.skipIf(!hasSolutions)("puzzle rush", () => {
  let token = "";
  let practiceRush: RushStartBody;

  beforeAll(async () => {
    token = await guestToken();
    const response = await startRush(token, true);
    expect(response.status).toBe(200);
    practiceRush = (await response.json()) as RushStartBody;
  });

  test("starting a rush needs a session", async () => {
    const response = await post("/api/rush/start", {});
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("json");
  });

  test("a started rush hands out the sequence and not one answer", async () => {
    expect(practiceRush.ranked).toBe(false);
    expect(practiceRush.durationMs).toBe(RUSH_DURATION_MS);
    expect(practiceRush.skips).toBe(RUSH_SKIPS);
    expect(practiceRush.puzzles.length).toBe(RUSH_SEQUENCE_LENGTH);
    expect(new Set(practiceRush.puzzles.map((prompt) => prompt.id)).size).toBe(
      RUSH_SEQUENCE_LENGTH,
    );

    for (const prompt of practiceRush.puzzles) {
      // Everything the client needs to play is here, and the two fields that
      // would hand it every answer in the run are not.
      expect(prompt.board.length).toBeGreaterThan(0);
      expect(prompt.queue.length).toBeGreaterThan(0);
      expect(prompt.targetAttack).toBeGreaterThan(0);
      expect(prompt).not.toHaveProperty("solution");
      expect(prompt).not.toHaveProperty("source");
    }
    // Keys, not text: one puzzle's own goal reads "Clear 1 TSD (2 solutions)",
    // and searching the payload for the bare word turns that into a test that
    // fails on the days that puzzle is drawn. A solution nested anywhere under
    // a renamed field would still be forty answers on the wire, so the check is
    // worth keeping — spelt as the key it would arrive under.
    expect(JSON.stringify(practiceRush.puzzles)).not.toContain('"solution":');
    expect(JSON.stringify(practiceRush.puzzles)).not.toContain('"source":');
  });

  test("a rush is scored by replaying its segments in order", async () => {
    const played = practiceRush.puzzles.slice(0, SEGMENTS_PLAYED).map(answerFor);
    // A segment names no puzzle, so a skipped one still has to hold its place
    // or every segment after it is replayed against the wrong board.
    const segments: RushSegment[] = played.map((puzzle, index) => ({
      events: index === SKIPPED_SEGMENT ? [] : solvingLog(puzzle),
    }));
    const expected = segments.filter((segment, index) => solves(played[index]!, segment.events));
    expect(expected.length).toBe(SEGMENTS_PLAYED - 1);

    const response = await submitRush(token, practiceRush.ticket, segments, {
      timeToLastSolveMs: 45_000,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as RushRunBody;
    expect(body.ranked).toBe(false);
    expect(body.run.solved).toBe(expected.length);
    expect(body.run.attempted).toBe(SEGMENTS_PLAYED);
    // One puzzle was left behind between two solves, and no segment said so.
    expect(body.run.skipsUsed).toBe(1);

    // The end screen lists these, so they are the verifier's account of each
    // puzzle rather than the client's: one row per puzzle actually reached, in
    // play order, and the skipped one shows as unsolved.
    expect(body.played).toHaveLength(SEGMENTS_PLAYED);
    expect(body.played.map((puzzle) => puzzle.id)).toEqual(
      played.slice(0, SEGMENTS_PLAYED).map((puzzle) => puzzle.id),
    );
    expect(body.played[SKIPPED_SEGMENT]!.solved).toBe(false);
    expect(body.played.filter((puzzle) => puzzle.solved)).toHaveLength(expected.length);
    // Forty-five seconds claimed inside a run the server timed in milliseconds:
    // the claim gets cut down to the run, never the run stretched to the claim.
    expect(body.run.timeToLastSolveMs).toBe(body.run.elapsedMs);
  });

  test("a practice rush is never recorded", async () => {
    const board = (await (await get("/api/rush", token)).json()) as RushBoardBody;
    expect(board.run).toBeNull();
    expect(board.best).toBe(0);
    expect(board.leaderboard).toEqual([]);

    const day = (await (await get("/api/rush/leaderboard", token)).json()) as {
      entries: readonly StoredRushRun[];
    };
    expect(day.entries).toEqual([]);
  });

  test("the skips a run reports are the ones it can be shown to have spent", async () => {
    // The budget is the two skips plus the one puzzle the buzzer can catch
    // unfinished, so this many unsolved segments is the most a rush can leave.
    const response = await submitRush(token, practiceRush.ticket, skips(RUSH_SKIPS + 1), {
      skipsUsed: 99,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as RushRunBody;
    expect(body.run.solved).toBe(0);
    expect(body.run.attempted).toBe(RUSH_SKIPS + 1);
    // Ninety-nine skips claimed, and the run goes on the board with two: the
    // number is only ever allowed down to what the replay already showed.
    expect(body.run.skipsUsed).toBe(RUSH_SKIPS);
  });

  test("leaving more behind than the rush allows is refused", async () => {
    // Nothing on the wire says "skip" — these are unsolved segments, counted.
    const response = await submitRush(token, practiceRush.ticket, skips(RUSH_SKIPS + 2));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain(`allows ${RUSH_SKIPS} skips`);
  });

  /**
   * Both shapes of the same attack: a submission that says almost nothing but
   * costs everything to replay. The guard has to measure how far each segment
   * makes the engine REACH, not how far its events span — a keydown and a keyup
   * at the same far frame span nothing at all, and that shape once bought 386ms
   * of blocked event loop before any rule turned it away.
   */
  test.each([
    ["events spread across the segment", 0],
    ["events sharing one far frame", MAX_FRAMES - 1],
  ])("a submission that costs more to replay than a rush can hold is refused (%s)", async (
    _name,
    firstFrame,
  ) => {
    const events = [
      { frame: firstFrame, type: "keydown", data: { key: "moveLeft", subframe: 0 } },
      { frame: MAX_FRAMES - 1, type: "keyup", data: { key: "moveLeft", subframe: 0 } },
    ];
    const segments = Array.from({ length: RUSH_SEQUENCE_LENGTH }, () => ({ events })) as RushSegment[];

    const started = performance.now();
    const response = await submitRush(token, practiceRush.ticket, segments);
    const elapsed = performance.now() - started;

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain("longer than a rush");
    // Turned away before anything is replayed. Forty full replays are hundreds
    // of milliseconds, so this is a wide margin around a very cheap rejection.
    expect(elapsed).toBeLessThan(100);
  });

  test("a rush cannot be longer than the sequence it was given", async () => {
    const response = await submitRush(token, practiceRush.ticket, skips(RUSH_SEQUENCE_LENGTH + 1));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain(`only ${RUSH_SEQUENCE_LENGTH} puzzles`);
  });

  test("a session token is not a rush ticket", async () => {
    // Both are `payload.signature` signed with the same key, so only the domain
    // separation in `sign` stands between them.
    const response = await submitRush(token, token, []);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain("signature");
  });

  test("a ticket minted for another player is refused", async () => {
    // Guest play collapses every session onto one identity, so a second player
    // cannot sign in here. The ticket that player would have been handed is
    // minted directly instead — imported now rather than at the top of the file,
    // where it would read `config` before `beforeAll` has set the environment.
    const { mintRushTicket } = await import("../server/auth");
    const ticket = await mintRushTicket({
      playerId: "someone-else",
      guildId: null,
      day: practiceRush.day,
      seed: 1,
      ranked: false,
      startedAt: Date.now(),
    });

    const response = await submitRush(token, ticket, []);
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toContain("belongs to someone else");
  });

  test("a ranked rush goes on the board", async () => {
    const opened = await startRush(token, false);
    expect(opened.status).toBe(200);
    const ranked = (await opened.json()) as RushStartBody;
    expect(ranked.ranked).toBe(true);
    expect(ranked.day).toBe(practiceRush.day);
    expect(ranked.puzzles.length).toBe(RUSH_SEQUENCE_LENGTH);

    const played = ranked.puzzles.slice(0, RANKED_SOLVES).map(answerFor);
    const segments: RushSegment[] = played.map((puzzle) => ({ events: solvingLog(puzzle) }));
    const response = await submitRush(token, ranked.ticket, segments, {
      timeToLastSolveMs: 30_000,
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as RushRunBody;
    expect(body.ranked).toBe(true);
    expect(body.isFirst).toBe(true);
    expect(body.run.solved).toBe(RANKED_SOLVES);
    expect(body.best).toBe(RANKED_SOLVES);
    expect(body.leaderboard.map((entry) => entry.player.id)).toContain("guest");

    const board = (await (await get("/api/rush", token)).json()) as RushBoardBody;
    expect(board.run?.solved).toBe(RANKED_SOLVES);
  });

  test("the day's rush can be played again, and only the first one counts", async () => {
    // Replaying is allowed, unscored, and draws its own sequence. The day's
    // shared order belongs to the scored run — comparing two players depends on
    // it — and a replay that dealt the identical stack would be a memory test
    // rather than another go at the mode.
    const first = (await (await startRush(token, false)).json()) as RushStartBody;
    const second = await startRush(token, false);
    expect(second.status).toBe(200);
    const replay = (await second.json()) as RushStartBody;
    expect(replay.ranked).toBe(false);
    expect(replay.puzzles.map((puzzle) => puzzle.id)).not.toEqual(
      first.puzzles.map((puzzle) => puzzle.id),
    );

    // Practice is still its own thing: unranked, and a sequence of its own.
    const practice = await startRush(token, true);
    expect(practice.status).toBe(200);
    expect(((await practice.json()) as RushStartBody).ranked).toBe(false);
  });

  test("the bot rush board is closed to anyone without the right key", async () => {
    // `config` reads BOT_API_KEY once, at import, so only one side of this gate
    // is live in a given process: a checkout with no key has the bot routes
    // switched off entirely, and one with a key turns a wrong key away instead.
    const enabled = Boolean(process.env.BOT_API_KEY);
    const wrongKey = await fetchApp(
      new Request(`${BASE}/api/rush/standings?guild=1`, { headers: { "X-Api-Key": "wrong" } }),
    );
    expect(wrongKey.status).toBe(enabled ? 401 : 404);

    const noKey = await fetchApp(new Request(`${BASE}/api/rush/standings?guild=1`));
    expect(noKey.status).toBe(enabled ? 401 : 404);
  });

  test.skipIf(!process.env.BOT_API_KEY)("the bot rush board answers the right key", async () => {
    const response = await fetchApp(
      new Request(`${BASE}/api/rush/standings`, {
        headers: { "X-Api-Key": process.env.BOT_API_KEY ?? "" },
      }),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      durationMs: number;
      skips: number;
      entries: readonly StoredRushRun[];
    };
    expect(body.durationMs).toBe(RUSH_DURATION_MS);
    expect(body.skips).toBe(RUSH_SKIPS);
    expect(body.entries.map((entry) => entry.player.id)).toContain("guest");
  });
});

describe("the daily recap", () => {
  // Which refusal a bot route gives depends on whether a key is live in this
  // process, exactly as the rush board's own test explains.
  const enabled = Boolean(process.env.BOT_API_KEY);
  const key = { "X-Api-Key": process.env.BOT_API_KEY ?? "" };
  const recap = (query: string, headers: Record<string, string> = key) =>
    Promise.resolve(fetchApp(new Request(`${BASE}/api/recap?${query}`, { headers })));

  test("is gated on the bot key, not a session", async () => {
    const wrongKey = await recap("guild=g1&day=1", { "X-Api-Key": "wrong" });
    expect(wrongKey.status).toBe(enabled ? 401 : 404);
    const noKey = await recap("guild=g1&day=1", {});
    expect(noKey.status).toBe(enabled ? 401 : 404);
  });

  test.skipIf(!enabled)("refuses a day that is not a finished one", async () => {
    // SQLite binds every one of these without complaint and answers with no
    // rows, which a recap would go on to post as "nobody played" on a day
    // people played. Today is refused too: the streak counts a gap as a break,
    // which is only honest once the day is over.
    const today = Number(
      ((await (await get("/api/today")).json()) as { day: number }).day,
    );
    for (const day of ["0", "-5", "1.5", "12abc", "yesterday", "1e21", "", String(today)]) {
      const response = await recap(`guild=g1&day=${day}`);
      expect(response.status).toBe(400);
    }
    const ok = await recap(`guild=g1&day=${today - 1}`);
    expect(ok.status).toBe(200);
  });

  test.skipIf(!enabled)("will not answer without a server to answer about", async () => {
    // `leaderboard` reads a falsy guild as "every server at once", so a dropped
    // parameter would put strangers into one server's recap.
    const today = Number(
      ((await (await get("/api/today")).json()) as { day: number }).day,
    );
    const response = await recap(`day=${today - 1}`);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain("guild is required");
  });

  /** Every key name in a response, however deep, so a check can name one. */
  function keysDeep(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(keysDeep);
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]);
  }

  test.skipIf(!enabled)("names the puzzle, the streak and both boards", async () => {
    const today = Number(
      ((await (await get("/api/today")).json()) as { day: number }).day,
    );
    const body = (await (await recap(`guild=g1&day=${today - 1}`)).json()) as {
      day: number;
      puzzles: { tier: string; id: number; title: string }[];
      streak: number;
      daily: { rows: { player: { id: string }; marks: Record<string, boolean> }[]; total: number };
      rush: { entries: unknown[]; total: number };
    };
    expect(body.day).toBe(today - 1);
    expect(body.puzzles.map((puzzle) => puzzle.tier)).toEqual(["easy", "medium", "hard"]);
    expect(body.puzzles.every((puzzle) => Number.isInteger(puzzle.id))).toBe(true);
    expect(body.streak).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.daily.rows)).toBe(true);
    expect(Array.isArray(body.rush.entries)).toBe(true);
    // No solution or board anywhere in it — the bot never needs the answer.
    //
    // Checked by key and not by substring. `not.toContain("solution")` over the
    // serialised body reads the same and is wrong: archive puzzle 15 carries the
    // goal "Clear 1 TSD (2 solutions)", so the assertion failed on the prose the
    // recap is supposed to include, on whichever days that puzzle is dealt.
    expect(keysDeep(body)).not.toContain("solution");
    expect(keysDeep(body)).not.toContain("board");
  });
});

describe("Store.guildStreak", () => {
  const path = join(tmpdir(), `puzzle-streak-${process.pid}.sqlite`);
  const solve = (store: Store, day: number, playerId: string, guildId: string, solved = true) =>
    store.recordRun(day, "easy", 1, { id: playerId, username: playerId, avatarUrl: null }, guildId, {
      solved, attack: solved ? 10 : 1, targetAttack: 10, durationMs: 1000,
      totalMs: 1000, resets: 0, piecesPlaced: 3, clears: [],
    });

  test("counts consecutive days and stops at the first gap", () => {
    const store = new Store(path);
    try {
      for (const day of [10, 9, 8, 6, 5]) solve(store, day, "p1", "g1");
      expect(store.guildStreak("g1", 10)).toBe(3);
      // Unlike a player's streak, a missing anchor day is a break rather than
      // a not-played-yet: a finished day that nobody solved ends the run.
      expect(store.guildStreak("g1", 11)).toBe(0);
    } finally {
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });

  test("a day counts once however many people solved it", () => {
    const store = new Store(path);
    try {
      for (const player of ["a", "b", "c"]) solve(store, 20, player, "g2");
      solve(store, 19, "a", "g2");
      // Without DISTINCT the row limit would bound rows rather than days.
      expect(store.guildStreak("g2", 20)).toBe(2);
      expect(store.dayCount(20, "g2")).toBe(3);
    } finally {
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });

  test("an unsolved day breaks the streak even though it was played", () => {
    const store = new Store(path);
    try {
      solve(store, 31, "a", "g3");
      solve(store, 30, "a", "g3", false);
      solve(store, 29, "a", "g3");
      expect(store.guildStreak("g3", 31)).toBe(1);
      expect(store.dayCount(30, "g3")).toBe(1);
    } finally {
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });

  test("one server's days never count towards another's", () => {
    const store = new Store(path);
    try {
      solve(store, 40, "a", "gA");
      solve(store, 39, "a", "gB");
      expect(store.guildStreak("gA", 40)).toBe(1);
      expect(store.guildStreak("gB", 40)).toBe(0);
    } finally {
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });
});
