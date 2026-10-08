/**
 * The status-file contract every long-running app and the deploy share. A
 * deploy that misreads a status acts on a guess — stops a game mid-duel, or
 * restarts a bot mid-sync — so anything that is not exactly a status reads as
 * unknown, never as idle.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ENV,
  STATUS_STALE_MS,
  isDrained,
  isFresh,
  readStatus,
  type BotStatus,
  type GameStatus,
} from "../shared/runtime-status";

const GAME: GameStatus = {
  app: "game",
  pid: 4242,
  buildId: "8dd0c4d",
  port: 3002,
  state: "serving",
  startedAt: 1_791_300_000_000,
  updatedAt: 1_791_300_005_000,
  duelsInMatch: 1,
  lobbies: 0,
  rushTicketsRecent: 0,
  sessionsRecent: 3,
  inflight: 0,
};

const BOT = {
  app: "bot",
  pid: 777,
  buildId: "8dd0c4d",
  state: "ready",
  startedAt: 1_791_300_000_000,
  updatedAt: 1_791_300_005_000,
  lastInteractionAt: null,
  inflight: 0,
  syncRunning: false,
};

describe("reading a status file", () => {
  test("a game's and a bot's status read back as written", () => {
    expect(readStatus(JSON.stringify(GAME))).toEqual(GAME);
    expect(readStatus(JSON.stringify(BOT))).toEqual(BOT as never);
    expect(readStatus(JSON.stringify({ ...BOT, lastInteractionAt: 1_791_300_004_000 }))).not.toBeNull();
  });

  test("anything else is unknown: torn, foreign, or missing a field", () => {
    expect(readStatus("")).toBeNull();
    expect(readStatus('{"app":"game"')).toBeNull();
    expect(readStatus("null")).toBeNull();
    expect(readStatus(JSON.stringify({ ...GAME, app: "site" }))).toBeNull();
    expect(readStatus(JSON.stringify({ ...GAME, state: "sleeping" }))).toBeNull();
    expect(readStatus(JSON.stringify({ ...GAME, duelsInMatch: -1 }))).toBeNull();
    expect(readStatus(JSON.stringify({ ...GAME, inflight: 1.5 }))).toBeNull();
    const { lobbies: _dropped, ...noLobbies } = GAME;
    expect(readStatus(JSON.stringify(noLobbies))).toBeNull();
    expect(readStatus(JSON.stringify({ ...BOT, syncRunning: "no" }))).toBeNull();
    expect(readStatus(JSON.stringify({ ...BOT, state: "serving" }))).toBeNull();
  });
});

describe("what the deploy concludes from one", () => {
  test("a status stops being believed once it is older than the stale limit", () => {
    expect(isFresh(GAME, GAME.updatedAt + STATUS_STALE_MS)).toBe(true);
    expect(isFresh(GAME, GAME.updatedAt + STATUS_STALE_MS + 1)).toBe(false);
  });

  test("drained means draining, with no match and no request left", () => {
    expect(isDrained({ ...GAME, state: "draining", duelsInMatch: 0 })).toBe(true);
    expect(isDrained({ ...GAME, state: "draining" })).toBe(false);
    expect(isDrained({ ...GAME, state: "draining", duelsInMatch: 0, inflight: 2 })).toBe(false);
    expect(isDrained({ ...GAME, state: "serving", duelsInMatch: 0 })).toBe(false);
  });
});

/**
 * The bot writes its status from Python (`client/runtime_status.py`), so the
 * two halves of the contract are in two languages and nothing but this holds
 * them together. A field renamed on one side reads as "unknown" on the other,
 * and the deploy waits on a bot that is idle.
 *
 * Run with the bot's own interpreter: `BOT_PYTHON`, else the repository's
 * `.venv`. The writer is stdlib only, so any Python the bot runs on will do;
 * skipped, not failed, on a box with neither, as the archive tests skip
 * without `data/solutions.json`.
 */
const REPO = resolve(import.meta.dir, "../..");
const BOT_PYTHON = [process.env.BOT_PYTHON, join(REPO, ".venv", "bin", "python")].find(
  (candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string),
);

/** A snowflake the bot tracks a command under; it must never reach the file. */
const INTERACTION_ID = "1234567890123456789";

const WRITE_STATUS = `
import os, sys
sys.path.insert(0, sys.argv[1])
import lifecycle, runtime_status
life = lifecycle.Lifecycle()
busy = sys.argv[2] == "busy"
if busy:
    life.mark_ready()
    life.admit(("interaction", ${INTERACTION_ID}))
writer = runtime_status.StatusWriter.from_environ(
    os.environ, read=life.snapshot, sync_running=lambda: busy)
sys.exit(0 if writer.write() else 1)
`;

describe.skipIf(!BOT_PYTHON)("the bot's status file, written by the bot's own writer", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-status-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function written(mode: "busy" | "fresh"): string {
    const file = join(dir, `${mode}.json`);
    const run = Bun.spawnSync([BOT_PYTHON as string, "-I", "-c", WRITE_STATUS, join(REPO, "client"), mode], {
      env: { PATH: process.env.PATH ?? "", [ENV.statusFile]: file, [ENV.buildId]: "8dd0c4d" },
    });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    return readFileSync(file, "utf8");
  }

  test("a ready bot in the middle of a command and a sync reads back as one", () => {
    const text = written("busy");
    const status = readStatus(text) as BotStatus;
    expect(status).not.toBeNull();
    expect(status.app).toBe("bot");
    expect(status.buildId).toBe("8dd0c4d");
    expect(status.state).toBe("ready");
    expect(status.inflight).toBe(1);
    expect(status.syncRunning).toBe(true);
    expect(typeof status.lastInteractionAt).toBe("number");
    expect(isFresh(status, Date.now())).toBe(true);
    expect(text).not.toContain(INTERACTION_ID);
  });

  test("a bot that has handled nothing yet reads back too, with no last interaction", () => {
    const status = readStatus(written("fresh")) as BotStatus;
    expect(status).not.toBeNull();
    expect(status.state).toBe("starting");
    expect(status.lastInteractionAt).toBeNull();
    expect(status.inflight).toBe(0);
    expect(status.syncRunning).toBe(false);
  });

  test("it writes the contract's fields and nothing else", () => {
    expect(Object.keys(JSON.parse(written("busy"))).sort()).toEqual(Object.keys(BOT).sort());
  });
});
