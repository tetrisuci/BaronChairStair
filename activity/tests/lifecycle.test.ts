/**
 * The game's process lifecycle: what it tells the deploy, and what it does
 * when the deploy signals it.
 *
 * Driven without a real port or a real signal. The lifecycle is handed a fake
 * listener, a fake duel registry, a hand-turned clock and an `exit` it may not
 * actually call, so every transition can be watched from outside.
 * `tests/handover.test.ts` does the same thing for real, with two processes on
 * one port.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILD_ID_FILE,
  BUILD_ID_HEADER,
  isFresh,
  readStatus,
  STATUS_INTERVAL_MS,
  STATUS_STALE_MS,
  type GameStatus,
} from "../shared/runtime-status";
import { readBuildId } from "../server/build-id";
import { Lifecycle, type DuelControl, type LifecycleLog } from "../server/lifecycle";

const START = 1_791_300_000_000;
/** Shaped like a Discord id, so finding it in a status file would mean one leaked. */
const PLAYER_ID = "412345678901234567";

const directories: string[] = [];
const lifecycles: Lifecycle[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "lifecycle-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  // Every lifecycle a test made is stopped, so no status timer or keep-alive
  // outlives the test that started it.
  for (const lifecycle of lifecycles.splice(0)) await lifecycle.stop();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Harness {
  readonly lifecycle: Lifecycle;
  readonly exits: number[];
  readonly duelCalls: string[];
  readonly warnings: string[];
  readonly listener: { stops: number; readonly port: number; stop(): void };
  setDuels(counts: ReturnType<DuelControl["counts"]>): void;
  advance(ms: number): void;
  now(): number;
}

function harness(options: { statusFile?: string | null; stopGraceMs?: number } = {}): Harness {
  let now = START;
  let duelCounts = { duelsInMatch: 0, lobbies: 0 };
  const exits: number[] = [];
  const duelCalls: string[] = [];
  const warnings: string[] = [];
  const log: LifecycleLog = {
    log: () => {},
    warn: (...parts: unknown[]) => warnings.push(parts.map(String).join(" ")),
  };
  const listener = {
    stops: 0,
    port: 3001,
    stop() {
      this.stops++;
    },
  };
  const lifecycle = new Lifecycle({
    buildId: "abc1234",
    port: 3001,
    statusFile: options.statusFile ?? null,
    duels: {
      counts: () => duelCounts,
      drain: () => duelCalls.push("drain"),
      closeAll: () => duelCalls.push("closeAll"),
    },
    now: () => now,
    pid: 4242,
    exit: (code) => exits.push(code),
    log,
    stopGraceMs: options.stopGraceMs ?? 200,
    flushMs: 0,
  });
  lifecycles.push(lifecycle);
  return {
    lifecycle,
    exits,
    duelCalls,
    warnings,
    listener,
    setDuels: (counts) => {
      duelCounts = counts;
    },
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
  };
}

function readGame(path: string): GameStatus {
  const status = readStatus(readFileSync(path, "utf8"));
  if (!status || status.app !== "game") throw new Error(`not a game status: ${readFileSync(path, "utf8")}`);
  return status;
}

const ok = () => new Response("ok");

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// ── The status file ──────────────────────────────────────────────────────────

describe("the status file", () => {
  test("says starting the moment the process is up, and serving once it listens", () => {
    const path = join(scratch(), "game.json");
    const { lifecycle, listener } = harness({ statusFile: path });
    expect(readGame(path).state).toBe("starting");

    lifecycle.listening(listener);
    const status = readGame(path);
    expect(status.state).toBe("serving");
    expect(status.pid).toBe(4242);
    expect(status.buildId).toBe("abc1234");
    expect(status.port).toBe(3001);
    expect(status.startedAt).toBe(START);
  });

  test("carries the counts, and nothing that names anybody", () => {
    const path = join(scratch(), "game.json");
    const { lifecycle, listener, setDuels, advance } = harness({ statusFile: path });
    lifecycle.listening(listener);
    lifecycle.activity.sawSession(PLAYER_ID);
    lifecycle.activity.mintedRushTicket();
    lifecycle.activity.requestStarted();
    setDuels({ duelsInMatch: 2, lobbies: 1 });
    advance(1_000);

    lifecycle.writeStatus();
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(PLAYER_ID);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      [
        "app",
        "pid",
        "buildId",
        "port",
        "state",
        "startedAt",
        "updatedAt",
        "duelsInMatch",
        "lobbies",
        "rushTicketsRecent",
        "sessionsRecent",
        "inflight",
      ].sort(),
    );
    expect(readGame(path)).toMatchObject({
      updatedAt: START + 1_000,
      duelsInMatch: 2,
      lobbies: 1,
      rushTicketsRecent: 1,
      sessionsRecent: 1,
      inflight: 1,
    });
  });

  test("is replaced whole by a rename, never rewritten in place", () => {
    const directory = scratch();
    const path = join(directory, "game.json");
    const { lifecycle } = harness({ statusFile: path });
    const before = statSync(path).ino;
    lifecycle.writeStatus();
    // A new inode is what a rename leaves behind; truncating and rewriting the
    // same file — which a reader can catch half-written — keeps the old one.
    expect(statSync(path).ino).not.toBe(before);
    // And the temporary it was written to is gone, not left beside it.
    expect(readdirSync(directory)).toEqual(["game.json"]);
  });

  test("is fresh when written and reads as stale once the process stops writing", () => {
    const path = join(scratch(), "game.json");
    const { lifecycle, listener, now } = harness({ statusFile: path });
    lifecycle.listening(listener);
    const status = readGame(path);
    expect(isFresh(status, now())).toBe(true);
    expect(isFresh(status, now() + STATUS_STALE_MS + 1)).toBe(false);
    // Rewritten well inside the window the deploy believes, so a live process
    // never reads as a dead one between two writes.
    expect(STATUS_INTERVAL_MS * 3).toBeLessThan(STATUS_STALE_MS);
  });

  test("a write that fails is logged once and never stops the game", () => {
    const directory = scratch();
    const path = join(directory, "missing", "game.json");
    const { lifecycle, listener, warnings } = harness({ statusFile: path });
    expect(() => lifecycle.listening(listener)).not.toThrow();
    lifecycle.writeStatus();
    lifecycle.writeStatus();
    expect(warnings.filter((line) => line.includes("status file"))).toHaveLength(1);

    // And it picks up again once the directory is there.
    mkdirSync(join(directory, "missing"));
    lifecycle.writeStatus();
    expect(readGame(path).state).toBe("serving");
  });

  test("writes nothing at all when no path is configured", () => {
    const directory = scratch();
    const { lifecycle, listener } = harness({ statusFile: null });
    lifecycle.listening(listener);
    lifecycle.writeStatus();
    expect(readdirSync(directory)).toEqual([]);
  });
});

// ── Every response ───────────────────────────────────────────────────────────

describe("every response", () => {
  test("names the build that answered it", async () => {
    const { lifecycle } = harness();
    const response = await lifecycle.handle(new Request("http://game/api/config"), undefined, ok);
    expect(response.headers.get(BUILD_ID_HEADER)).toBe("abc1234");
    expect(response.headers.get("Connection")).toBeNull();
  });

  test("names it even on a response whose headers cannot be changed", async () => {
    const { lifecycle } = harness();
    const frozen = () => Response.redirect("http://game/elsewhere", 302);
    const response = await lifecycle.handle(new Request("http://game/"), undefined, frozen);
    expect(response.status).toBe(302);
    expect(response.headers.get(BUILD_ID_HEADER)).toBe("abc1234");
  });

  test("is counted while it is being answered", async () => {
    const { lifecycle } = harness();
    const pending = deferred();
    const answered = lifecycle.handle(new Request("http://game/api/daily"), undefined, () => pending.promise);
    expect(lifecycle.status().inflight).toBe(1);
    pending.resolve(ok());
    await answered;
    expect(lifecycle.status().inflight).toBe(0);
  });

  test("health says which build and which state, without touching the database", () => {
    const { lifecycle, listener } = harness();
    expect(lifecycle.health()).toEqual({ ok: true, buildId: "abc1234", state: "starting" });
    lifecycle.listening(listener);
    expect(lifecycle.health().state).toBe("serving");
  });
});

// ── Drain (SIGHUP) ───────────────────────────────────────────────────────────

describe("drain", () => {
  test("stops listening, sends the lobbies away, reports draining and does not exit", () => {
    const path = join(scratch(), "game.json");
    const { lifecycle, listener, duelCalls, exits } = harness({ statusFile: path });
    lifecycle.listening(listener);
    lifecycle.drain();
    expect(listener.stops).toBe(1);
    expect(duelCalls).toEqual(["drain"]);
    expect(readGame(path).state).toBe("draining");
    expect(exits).toEqual([]);
  });

  test("answers what still arrives with Connection: close, and refuses a new duel socket", async () => {
    const { lifecycle, listener } = harness();
    lifecycle.listening(listener);
    lifecycle.drain();

    const page = await lifecycle.handle(new Request("http://game/api/daily"), undefined, ok);
    expect(page.status).toBe(200);
    expect(page.headers.get("Connection")).toBe("close");
    expect(page.headers.get(BUILD_ID_HEADER)).toBe("abc1234");

    let routed = false;
    const upgrade = new Request("http://game/api/duel?token=t", {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    const refused = await lifecycle.handle(upgrade, undefined, () => {
      routed = true;
      return ok();
    });
    expect(routed).toBe(false);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("Connection")).toBe("close");
  });

  test("a second drain changes nothing", () => {
    const { lifecycle, listener, duelCalls } = harness();
    lifecycle.listening(listener);
    lifecycle.drain();
    lifecycle.drain();
    expect(listener.stops).toBe(1);
    expect(duelCalls).toEqual(["drain"]);
  });
});

// ── Stop (SIGINT, SIGTERM) ───────────────────────────────────────────────────

describe("stop", () => {
  test("waits for requests in flight, then ends every duel, writes the last status and exits 0", async () => {
    const path = join(scratch(), "game.json");
    const { lifecycle, listener, duelCalls, exits } = harness({ statusFile: path, stopGraceMs: 2_000 });
    lifecycle.listening(listener);
    const pending = deferred();
    const answered = lifecycle.handle(new Request("http://game/api/rush/run"), undefined, () => pending.promise);

    const stopped = lifecycle.stop();
    expect(listener.stops).toBe(1);
    expect(readGame(path).state).toBe("stopping");
    await Bun.sleep(30);
    // Still waiting on the hand-in, so nobody's socket has been closed yet.
    expect(duelCalls).toEqual([]);
    expect(exits).toEqual([]);

    pending.resolve(ok());
    await answered;
    await stopped;
    expect(duelCalls).toEqual(["closeAll"]);
    expect(exits).toEqual([0]);
    expect(readGame(path)).toMatchObject({ state: "stopping", inflight: 0 });
  });

  test("stops waiting once the grace is spent", async () => {
    const { lifecycle, listener, duelCalls, exits } = harness({ stopGraceMs: 50 });
    lifecycle.listening(listener);
    void lifecycle.handle(new Request("http://game/api/daily/run"), undefined, () => new Promise(() => {}));
    await lifecycle.stop();
    expect(duelCalls).toEqual(["closeAll"]);
    expect(exits).toEqual([0]);
  });

  test("a second stop signal exits at once", async () => {
    const { lifecycle, listener, duelCalls, exits } = harness({ stopGraceMs: 5_000 });
    lifecycle.listening(listener);
    const pending = deferred();
    void lifecycle.handle(new Request("http://game/api/rush/run"), undefined, () => pending.promise);

    const first = lifecycle.stop();
    await lifecycle.stop();
    expect(exits).toEqual([0]);
    expect(duelCalls).toEqual([]);

    pending.resolve(ok());
    await first;
  });

  test("after a drain, stops the matches that were left", async () => {
    const path = join(scratch(), "game.json");
    const { lifecycle, listener, duelCalls, exits } = harness({ statusFile: path });
    lifecycle.listening(listener);
    lifecycle.drain();
    await lifecycle.stop();
    expect(duelCalls).toEqual(["drain", "closeAll"]);
    expect(exits).toEqual([0]);
    expect(readGame(path).state).toBe("stopping");
  });

  test("a drain after a stop has begun is ignored", async () => {
    const { lifecycle, listener, duelCalls } = harness();
    lifecycle.listening(listener);
    const stopped = lifecycle.stop();
    lifecycle.drain();
    await stopped;
    expect(duelCalls).toEqual(["closeAll"]);
    expect(lifecycle.state).toBe("stopping");
  });
});

// ── The build id ─────────────────────────────────────────────────────────────

describe("the build id", () => {
  test("is the one the client build recorded", () => {
    const build = scratch();
    writeFileSync(join(build, BUILD_ID_FILE), JSON.stringify({ buildId: "8dd0c4d" }));
    expect(readBuildId(build, "from-env")).toBe("8dd0c4d");
  });

  test("falls back to BUILD_ID when there is no build, then to dev", () => {
    const build = scratch();
    expect(readBuildId(build, "from-env")).toBe("from-env");
    expect(readBuildId(build, null)).toBe("dev");
    expect(readBuildId(join(build, "absent"), undefined)).toBe("dev");
  });

  test("ignores a build file that does not hold a usable id", () => {
    const build = scratch();
    for (const contents of ["not json", "{}", '{"buildId": 7}', '{"buildId": ""}', '{"buildId": "a\\nb"}']) {
      writeFileSync(join(build, BUILD_ID_FILE), contents);
      expect(readBuildId(build, "from-env")).toBe("from-env");
    }
  });
});
