/**
 * A real handover: two game processes on one port, the old one told to drain.
 *
 * Everything the deploy relies on, end to end and with nothing faked: both
 * processes bind the same port (`reusePort`), the old one stops listening on
 * `SIGHUP` and every new connection reaches the new one, a match already under
 * way on the old one keeps working — which needs the old process to stay alive
 * once it has nothing left to listen on — and the old one exits 0 on
 * `SIGTERM`, closing the match it was still holding with 1012 "restart".
 *
 * Nothing is asserted about the overlap, while both processes are listening:
 * which one a new connection reaches then depends on the operating system
 * (Linux spreads them, macOS does not). Only after the old one has stopped
 * listening is the answer the same everywhere.
 *
 * The processes run from a scratch directory, so neither loads a `.env`: Bun
 * reads one from the working directory, and the checkout's is a real one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BUILD_ID_FILE,
  BUILD_ID_HEADER,
  readStatus,
  SERVER_GOING_AWAY,
  type GameStatus,
} from "../shared/runtime-status";
import { DEFAULT_DUEL_SETTINGS } from "../shared/duel";
import { base64url, signWith } from "../server/tokens";
import { type DuelSocket, openDuelSocket } from "./duel-socket";

const ACTIVITY = resolve(import.meta.dir, "..");
const ENTRY = join(ACTIVITY, "server/index.ts");
/** Shared by both processes, as a deploy's two releases share `SESSION_SECRET`. */
const SECRET = `handover-${crypto.randomUUID()}`;
/** Whether a client build is on disk, which would name both processes alike. */
const BUILT = existsSync(join(ACTIVITY, "dist", BUILD_ID_FILE));

const BOOT_TIMEOUT_MS = 10_000;
const POLL_MS = 25;
/** Long enough for a process with nothing keeping it alive to have exited. */
const STAYS_UP_MS = 1_000;
const FRESH_REQUESTS = 8;

interface Game {
  readonly name: string;
  readonly process: Subprocess<"ignore", "pipe", "pipe">;
  readonly statusFile: string;
  readonly output: () => string;
}

let work: string;
let port: number;
const games: Game[] = [];

/** A port nothing is listening on, found by asking the kernel for one. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? done(address.port) : fail()));
    });
  });
}

/** Everything a stream prints, kept for the message of a failed wait. */
function drain(stream: ReadableStream<Uint8Array>): () => string {
  let text = "";
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      text += decoder.decode(chunk.value);
    }
  })();
  return () => text;
}

function startGame(name: string, buildId: string): Game {
  const statusFile = join(work, `${name}.status.json`);
  const child = Bun.spawn([process.execPath, "run", ENTRY], {
    cwd: work,
    // Named one by one rather than inherited: the test runner's environment
    // carries whatever its own `.env` held, and none of that belongs here.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? work,
      TMPDIR: tmpdir(),
      NODE_ENV: "test",
      ALLOW_GUEST_PLAY: "true",
      PORT: String(port),
      DATABASE_PATH: join(work, "daily.sqlite"),
      STATUS_FILE: statusFile,
      BUILD_ID: buildId,
      SESSION_SECRET: SECRET,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = drain(child.stdout);
  const stderr = drain(child.stderr);
  const game = { name, process: child, statusFile, output: () => `${stdout()}${stderr()}` };
  games.push(game);
  return game;
}

function statusOf(game: Game): GameStatus | null {
  if (!existsSync(game.statusFile)) return null;
  const status = readStatus(readFileSync(game.statusFile, "utf8"));
  return status?.app === "game" ? status : null;
}

async function waitForStatus(
  game: Game,
  ready: (status: GameStatus) => boolean,
  what: string,
): Promise<GameStatus> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    const status = statusOf(game);
    if (status && ready(status)) return status;
    if (game.process.exitCode !== null || Date.now() > deadline) {
      throw new Error(
        `${game.name} never reported ${what} (exit ${game.process.exitCode}, last status ` +
          `${JSON.stringify(status)}):\n${game.output()}`,
      );
    }
    await Bun.sleep(POLL_MS);
  }
}

/** A session token for a player of the test's own, signed as the game signs one. */
async function tokenFor(id: string): Promise<string> {
  const session = { player: { id, username: id, avatarUrl: null }, guildId: null, expiresAt: Date.now() + 3_600_000 };
  const payload = base64url(new TextEncoder().encode(JSON.stringify(session)));
  return `${payload}.${await signWith(SECRET, payload, "")}`;
}

async function duelSocketFor(id: string): Promise<DuelSocket> {
  const url = `ws://127.0.0.1:${port}/api/duel?token=${encodeURIComponent(await tokenFor(id))}`;
  const socket = await openDuelSocket(url, id);
  await socket.take("welcome");
  return socket;
}

/**
 * A request on a connection of its own.
 *
 * A pooled connection opened before the drain would still reach the old
 * process — that is what `Connection: close` exists to wind down — and would
 * prove nothing about where a *new* connection goes.
 */
async function freshGet(path: string): Promise<{ buildId: string | null; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    keepalive: false,
    headers: { Connection: "close" },
  });
  return { buildId: response.headers.get(BUILD_ID_HEADER), body: await response.json() };
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "handover-"));
  port = await freePort();
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  for (const game of games) {
    if (game.process.exitCode === null) game.process.kill("SIGKILL");
    await game.process.exited;
  }
  rmSync(work, { recursive: true, force: true });
});

describe("a handover on one port", () => {
  let old: Game;
  let next: Game;
  let host: DuelSocket;
  let guest: DuelSocket;
  let waiting: DuelSocket;

  test("the old process serves, and holds a match and a lobby", async () => {
    old = startGame("old", "build-old");
    const status = await waitForStatus(old, (s) => s.state === "serving", "serving");
    expect(status).toMatchObject({ pid: old.process.pid, port, buildId: BUILT ? status.buildId : "build-old" });

    host = await duelSocketFor("handover-host");
    guest = await duelSocketFor("handover-guest");
    waiting = await duelSocketFor("handover-waiting");
    host.send({ type: "open", settings: DEFAULT_DUEL_SETTINGS });
    const { duel } = await host.take("duel");
    guest.send({ type: "join", duelId: duel.id });
    await guest.take("duel");
    host.send({ type: "ready" });
    await host.take("round");
    await guest.take("round");
    waiting.send({ type: "open", settings: DEFAULT_DUEL_SETTINGS });
    await waiting.take("duel");
  }, BOOT_TIMEOUT_MS);

  test("the new process starts beside it, on the same port", async () => {
    next = startGame("next", "build-next");
    const status = await waitForStatus(next, (s) => s.state === "serving", "serving");
    expect(status.port).toBe(port);
    expect(old.process.exitCode).toBeNull();
  }, BOOT_TIMEOUT_MS);

  test("SIGHUP: the old one drains, sends the lobby away and keeps the match", async () => {
    old.process.kill("SIGHUP");
    const status = await waitForStatus(old, (s) => s.state === "draining", "draining");
    expect(status).toMatchObject({ duelsInMatch: 1, lobbies: 0 });
    expect(await waiting.closed).toEqual({ code: SERVER_GOING_AWAY.code, reason: SERVER_GOING_AWAY.handover });

    // Still alive with nothing to listen on, and still refereeing.
    await Bun.sleep(STAYS_UP_MS);
    expect(old.process.exitCode).toBeNull();
    expect(host.isOpen() && guest.isOpen()).toBe(true);
    host.send({
      type: "progress",
      progress: { piecesPlaced: 1, pieceBudget: 5, attack: 0, targetAttack: 4, solved: 0 },
    });
    await guest.take("opponent");
  }, BOOT_TIMEOUT_MS);

  test("every new connection reaches the new process", async () => {
    const serving = statusOf(next)!;
    if (!BUILT) expect(serving.buildId).toBe("build-next");
    for (let request = 0; request < FRESH_REQUESTS; request++) {
      const { buildId, body } = await freshGet("/api/health");
      expect({ request, buildId, body }).toEqual({
        request,
        buildId: serving.buildId,
        body: { ok: true, buildId: serving.buildId, state: "serving" },
      });
    }
    // And a player sent away reopens there: the old process would refuse it.
    const reopened = await duelSocketFor("handover-waiting");
    reopened.close();
  }, BOOT_TIMEOUT_MS);

  test("SIGTERM: the old one ends the match with 1012 restart and exits 0", async () => {
    old.process.kill("SIGTERM");
    const restart = { code: SERVER_GOING_AWAY.code, reason: SERVER_GOING_AWAY.restart };
    expect(await host.closed).toEqual(restart);
    expect(await guest.closed).toEqual(restart);
    expect(await old.process.exited).toBe(0);
    expect(statusOf(old)?.state).toBe("stopping");

    // The new one never noticed.
    expect((await freshGet("/api/health")).body).toMatchObject({ ok: true, state: "serving" });
  }, BOOT_TIMEOUT_MS);

  test("a drain with nothing left to keep still waits for its stop", async () => {
    // The new one, drained in its turn with no match on it: no round timer, no
    // listener, nothing of Bun's own holding the process — only the drain's
    // keep-alive stands between it and an exit nobody asked for.
    next.process.kill("SIGHUP");
    await waitForStatus(next, (s) => s.state === "draining", "draining");
    await Bun.sleep(STAYS_UP_MS);
    expect(next.process.exitCode).toBeNull();

    next.process.kill("SIGTERM");
    expect(await next.process.exited).toBe(0);
  }, BOOT_TIMEOUT_MS);
});
