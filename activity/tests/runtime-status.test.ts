/**
 * The status-file contract every long-running app and the deploy share. A
 * deploy that misreads a status acts on a guess — stops a game mid-duel, or
 * restarts a bot mid-sync — so anything that is not exactly a status reads as
 * unknown, never as idle.
 */

import { describe, expect, test } from "bun:test";
import {
  STATUS_STALE_MS,
  isDrained,
  isFresh,
  readStatus,
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
