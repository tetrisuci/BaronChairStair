/** A lost reply must not turn one solved board into two solves. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type PlayerProfile } from "../server/db";
import { Api, type RetryClock } from "../client/src/api";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { archive, hasSolutions } from "./archive";
import { solvingLog } from "./solving-log";
import type { PuzzlePrompt } from "../shared/puzzle";
import { gameFixture } from "./puzzledb-fixture";

const PLAYER: PlayerProfile = { id: "retry-test-player", username: "Retry Tester", avatarUrl: null };
const RUSH = { solved: 2, attempted: 3, skipsUsed: 0, timeToLastSolveMs: 5_000, elapsedMs: 10_000 };

describe("a clear's receipt", () => {
  let store: Store;
  afterEach(() => store?.close());

  test("the same player, puzzle and attempt counts once, without changing either time", () => {
    store = new Store(":memory:");
    const clear = { player: PLAYER, playerId: PLAYER.id, puzzleId: 93, durationMs: 9_000, attemptId: "practice:one" };
    store.recordClear(clear);
    const before = store.archiveReader.query("SELECT * FROM puzzle_clears").get();
    store.recordClear({ ...clear, durationMs: 1_000 });
    expect(store.archiveReader.query("SELECT * FROM puzzle_clears").get()).toEqual(before);
    expect(store.profile(PLAYER.id).clearsTotal).toBe(1);
  });

  test("new attempts count, and the receipt belongs to one player and puzzle", () => {
    store = new Store(":memory:");
    const clear = { player: PLAYER, playerId: PLAYER.id, puzzleId: 93, durationMs: 9_000, attemptId: "practice:one" };
    store.recordClear(clear);
    store.recordClear({ ...clear, attemptId: "practice:two", durationMs: 2_000 });
    store.recordClear({ ...clear, puzzleId: 94 });
    const other = { ...PLAYER, id: "another-retry-test-player" };
    store.recordClear({ ...clear, player: other, playerId: other.id });
    expect(store.profile(PLAYER.id).clearsTotal).toBe(3);
    expect(store.profile(PLAYER.id).bestMsTotal).toBe(11_000);
    expect(store.profile(other.id).clearsTotal).toBe(1);
  });

  test("a failed count rolls its receipt back, so the attempt can still be filed", () => {
    store = new Store(":memory:");
    const clear = { player: PLAYER, playerId: PLAYER.id, puzzleId: 93, durationMs: 9_000, attemptId: "practice:one" };
    store.archiveReader.run(`CREATE TRIGGER refuse_clear BEFORE INSERT ON puzzle_clears
      BEGIN SELECT RAISE(ABORT, 'deliberate write failure'); END`);
    expect(() => store.recordClear(clear)).toThrow("deliberate write failure");
    store.archiveReader.run("DROP TRIGGER refuse_clear");
    store.recordClear(clear);
    expect(store.profile(PLAYER.id).clearsTotal).toBe(1);
  });

  test("callers without a receipt keep counting separate solves", () => {
    store = new Store(":memory:");
    const clear = { player: PLAYER, playerId: PLAYER.id, puzzleId: 93, durationMs: 9_000 };
    store.recordClear(clear);
    store.recordClear(clear);
    expect(store.profile(PLAYER.id).clearsTotal).toBe(2);
  });

  test("the first ranked ticket stays first on retry, but a competing ticket does not", () => {
    store = new Store(":memory:");
    expect(store.recordRushRun(412, PLAYER, null, RUSH, "ticket-one").isFirst).toBe(true);
    expect(store.recordRushRun(412, PLAYER, null, RUSH, "ticket-one").isFirst).toBe(true);
    const other = store.recordRushRun(412, PLAYER, null, { ...RUSH, solved: 8 }, "ticket-two");
    expect(other.isFirst).toBe(false);
    expect(other.run.solved).toBe(RUSH.solved);
  });

  test("an additive upgrade preserves old counts and rows and receipts survive another boot", () => {
    const directory = mkdtempSync(join(tmpdir(), "hand-in-upgrade-"));
    const path = join(directory, "fixture.sqlite");
    const old = new Database(path);
    old.run(`CREATE TABLE players (id TEXT PRIMARY KEY, username TEXT NOT NULL, avatar_url TEXT, updated_at INTEGER NOT NULL);
      INSERT INTO players VALUES ('retry-test-player', 'Retry Tester', NULL, 1);
      CREATE TABLE puzzle_clears (player_id TEXT NOT NULL REFERENCES players(id), puzzle_id INTEGER NOT NULL,
        first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, times INTEGER NOT NULL, best_ms INTEGER NOT NULL,
        PRIMARY KEY (player_id, puzzle_id));
      INSERT INTO puzzle_clears VALUES ('retry-test-player', 93, 1, 2, 4, 3000);
      CREATE TABLE rush_runs (day INTEGER NOT NULL, player_id TEXT NOT NULL REFERENCES players(id), guild_id TEXT,
        solved INTEGER NOT NULL, attempted INTEGER NOT NULL, skips_used INTEGER NOT NULL, time_to_last_ms INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (day, player_id));
      INSERT INTO rush_runs VALUES (411, 'retry-test-player', NULL, 1, 1, 0, 1000, 1000, 1);`);
    old.close();
    try {
      store = new Store(path);
      expect(store.profile(PLAYER.id).clearsTotal).toBe(4);
      expect(store.recordRushRun(411, PLAYER, null, RUSH, "ticket-one").isFirst).toBe(false);
      const clear = { playerId: PLAYER.id, puzzleId: 93, durationMs: 2_000, attemptId: "practice:one" };
      store.recordClear(clear);
      store.recordRushRun(412, PLAYER, null, RUSH, "ticket-one");
      store.close();
      store = new Store(path);
      store.recordClear(clear);
      expect(store.profile(PLAYER.id).clearsTotal).toBe(5);
      expect(store.recordRushRun(412, PLAYER, null, RUSH, "ticket-one").isFirst).toBe(true);
      // The old four-argument writer still works after the migration.
      expect(store.recordRushRun(413, PLAYER, null, RUSH).isFirst).toBe(true);
      expect(store.recordRushRun(413, PLAYER, null, RUSH).isFirst).toBe(false);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("boot metadata and receipt reads leave the closed database free to switch journals", () => {
    // The fixture exercises enough distinct writers to exhaust Bun's query
    // cache if one-shot migration reads occupy its slots. Its final pinned
    // pool lookup then used to keep the closed connection holding WAL open.
    const game = gameFixture();
    try {
      store = new Store(game.databasePath);
      store.recordClear({ player: PLAYER, playerId: PLAYER.id, puzzleId: 93,
        durationMs: 9_000, attemptId: "practice:close" });
      store.recordRushRun(412, PLAYER, null, RUSH, "ticket-close");
      store.recordRushRun(412, PLAYER, null, RUSH, "ticket-close");
      store.close();
      const db = new Database(game.databasePath);
      try {
        expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE").all())
          .toEqual([{ journal_mode: "delete" }]);
      } finally { db.close(); }
    } finally { game.cleanup(); }
  });
});

// The handler is imported, never started, and uses the route suite's synthetic
// database. Each scenario has its own synthetic signed player and rate bucket.
const DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);
let fetchApp: (request: Request) => Response | Promise<Response>;
let mintSession: typeof import("../server/auth").mintSession;
let mintRushTicket: typeof import("../server/auth").mintRushTicket;
const callers = new Set<string>();
beforeAll(async () => {
  process.env.DATABASE_PATH = DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  fetchApp = (await import("../server/index")).entrypoint.fetch;
  mintSession = (await import("../server/auth")).mintSession;
  mintRushTicket = (await import("../server/auth")).mintRushTicket;
});

afterAll(() => {
  // Route suites share this synthetic database. Return only our callers'
  // rows so later suites can still assert that the global board starts empty.
  const db = new Database(DB);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.transaction(() => {
      for (const id of callers) {
        db.run("DELETE FROM puzzle_solutions WHERE found_by = ?1", [id]);
        for (const table of ["puzzle_clear_attempts", "puzzle_clears", "runs", "rush_runs"]) {
          db.run(`DELETE FROM ${table} WHERE player_id = ?1`, [id]);
        }
        db.run("DELETE FROM players WHERE id = ?1", [id]);
      }
    })();
  } finally { db.close(); }
});

function clock(): RetryClock {
  let now = Date.now();
  return { now: () => now, sleep: async (ms) => { now += ms; } };
}

async function caller(name: string, loseFirstReply = false) {
  const player = { ...PLAYER, id: `hand-in-${name}` };
  callers.add(player.id);
  const { token } = await mintSession(player, null);
  let attempts = 0;
  const bodies: Record<string, unknown>[] = [];
  const api = new Api("https://local.test", {
    clock: clock(),
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      headers.set("Cf-Connecting-Ip", `hand-in-${name}`);
      const response = await fetchApp(new Request(url, { ...init, headers }));
      if (init.method === "POST" && !url.endsWith("/start")) {
        bodies.push(JSON.parse(init.body as string));
        attempts += 1;
        if (loseFirstReply && attempts === 1 && response.ok) {
          // The handler has committed. Only the answer's stream is lost.
          return new Response(new ReadableStream({
            start(controller) { controller.error(new TypeError("reply lost after commit")); },
          }), { status: 200 });
        }
      }
      return response;
    },
  });
  api.setToken(token);
  return { api, player, bodies };
}

function clearTimes(playerId: string, puzzleId: number): number {
  const db = new Database(DB);
  try {
    return db.query<{ times: number }, [string, number]>(
      "SELECT times FROM puzzle_clears WHERE player_id = ?1 AND puzzle_id = ?2",
    ).get(playerId, puzzleId)?.times ?? 0;
  } finally { db.close(); }
}

function answerFor(prompt: PuzzlePrompt) {
  const puzzle = archive.find((p) => p.id === prompt.id);
  if (!puzzle) throw new Error(`Missing test puzzle ${prompt.id}`);
  return solvingLog(puzzle);
}

describe.skipIf(!hasSolutions)("retries through the real hand-in routes", () => {
  test("a lost practice reply counts once, and a separate replay gets a new receipt", async () => {
    const { api, player, bodies } = await caller("practice", true);
    const daily = await api.daily();
    const today = new Set(daily.puzzles.map((p) => p.puzzle.id));
    const puzzle = archive.find((p) => !today.has(p.id))!;
    const body = { handling: DEFAULT_HANDLING, events: solvingLog(puzzle) };
    expect((await api.clearPuzzle(puzzle.id, body)).solved).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(typeof bodies[0]!.attemptId).toBe("string");
    expect(bodies[1]).toEqual(bodies[0]);
    expect(clearTimes(player.id, puzzle.id)).toBe(1);
    expect((await api.clearPuzzle(puzzle.id, body)).solved).toBe(true);
    expect(bodies[2]!.attemptId).not.toBe(bodies[0]!.attemptId);
    expect(clearTimes(player.id, puzzle.id)).toBe(2);
  });

  test("a lost daily reply still counts its tier once", async () => {
    const { api, player, bodies } = await caller("daily", true);
    const daily = await api.daily();
    const sheet = daily.puzzles[0]!;
    const reply = await api.submitRun({ day: daily.day, tier: sheet.tier, handling: DEFAULT_HANDLING,
      events: answerFor(sheet.puzzle), totalMs: 10_000, resets: 0 });
    expect(reply.run.solved).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(clearTimes(player.id, sheet.puzzle.id)).toBe(1);
  });

  test.each([false, true])("a lost rush reply counts each board once (practice %p)", async (practice) => {
    const { api, player, bodies } = await caller(`rush-${practice}`, true);
    const start = await api.startRush(practice);
    const puzzles = start.puzzles.slice(0, 2);
    const body = { ticket: start.ticket, handling: DEFAULT_HANDLING,
      segments: puzzles.map((p) => ({ events: answerFor(p) })), timeToLastSolveMs: 10_000, skipsUsed: 0 };
    const reply = await api.submitRush(body);
    expect(reply.run.solved).toBe(2);
    expect(reply.isFirst).toBe(!practice);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    for (const puzzle of puzzles) expect(clearTimes(player.id, puzzle.id)).toBe(1);
  });
});

describe("ranked ticket ownership through the route", () => {
  test("an in-flight signed ticket from an older build still files and retries exactly", async () => {
    const { api, player } = await caller("legacy-ticket");
    const start = await api.startRush(false);
    const ticket = await mintRushTicket({ playerId: player.id, guildId: null, day: start.day,
      seed: 1, ranked: true, startedAt: Date.now() });
    const body = { ticket, handling: DEFAULT_HANDLING, segments: [], timeToLastSolveMs: 0, skipsUsed: 0 };
    expect((await api.submitRush(body)).isFirst).toBe(true);
    expect((await api.submitRush(body)).isFirst).toBe(true);
  });

  test("a competing device keeps the first place, including after this ticket is retried", async () => {
    const { api } = await caller("two-devices");
    const first = await api.startRush(false);
    const second = await api.startRush(false);
    expect(first.ranked).toBe(true);
    expect(second.ranked).toBe(true);
    const body = { handling: DEFAULT_HANDLING, segments: [], timeToLastSolveMs: 0, skipsUsed: 0 };
    expect((await api.submitRush({ ...body, ticket: second.ticket })).isFirst).toBe(true);
    expect((await api.submitRush({ ...body, ticket: first.ticket })).isFirst).toBe(false);
    expect((await api.submitRush({ ...body, ticket: first.ticket })).isFirst).toBe(false);
    expect((await api.submitRush({ ...body, ticket: second.ticket })).isFirst).toBe(true);
  });

  test("two devices starting in the same millisecond get different signed tickets", async () => {
    const { api } = await caller("same-millisecond");
    const realNow = Date.now;
    const now = Date.now();
    Date.now = () => now;
    try {
      const first = await api.startRush(false);
      const second = await api.startRush(false);
      expect(first.ticket).not.toBe(second.ticket);
    } finally { Date.now = realNow; }
  });
});
