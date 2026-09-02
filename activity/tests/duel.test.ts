/**
 * The duel referee, over a real socket.
 *
 * A duel is the only thing in this server that decides a winner, and it decides
 * one over a WebSocket — which `server.fetch` cannot drive. So unlike
 * `tests/server.test.ts`, which calls the handler stack in process, these tests
 * put the real entrypoint on a real port and talk to it the way a browser
 * would. `resetDuels()` between cases stands in for the process restart the
 * in-memory registry would otherwise need.
 *
 * Claims are rebuilt from the archive on disk, the way `tools/e2e-submit.ts`
 * does against a running server: a round prompt has the answer stripped out of
 * it, so the only way to send a log that solves one is to look the puzzle up
 * and play it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DUEL_SETTINGS,
  DUEL_CLAIM_GRACE_MS,
  DUEL_REMATCH_TTL_MS,
  DUEL_ROUND_MS_MIN,
  DUEL_MIN_POOL,
  DUEL_RUSH_MS_MAX,
  DUEL_RUSH_MS_MIN,
  type DuelCommand,
  type DuelEvent,
  type DuelPlayerView,
  type DuelProgress,
  type DuelSettings,
  type DuelView,
  roundsToWin,
} from "../shared/duel";
import { MAX_DIFFICULTY, MIN_DIFFICULTY } from "../shared/archive-filter";
import {
  decodeBoard,
  ENGINE_ROWS,
  pieceBudget,
  type Puzzle,
  type PuzzlePrompt,
} from "../shared/puzzle";
import { isRushEligible, RUSH_SKIPS } from "../shared/rush";
import { createPuzzleEngine, toLetter } from "../shared/tetris/engine";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { findPaths } from "../shared/tetris/pathfinder";
import { type GameKey, type InputEvent, MAX_FRAMES } from "../shared/tetris/verify";

// ── The server under test ────────────────────────────────────────────────────

/**
 * The database `tests/server.test.ts` names, asked for on exactly its terms and
 * left for it to delete.
 *
 * `bun test` gives every test file one module registry, and `server/config`
 * reads the environment once at import — so whichever file imports anything
 * under `server/` first settles the configuration for the whole run, and every
 * other file's `beforeAll` arrives too late to change any of it. Both files
 * therefore have to ask for the same four things, or whichever of them loses
 * the race is left running against an environment it did not choose.
 *
 * The store this file's import opens is the one answering that file's routes as
 * well, and it outlives both `afterAll`s, so only one of us can own removing
 * the file — and it is not this one. Deleting it here left every later query
 * raising `SQLITE_IOERR_VNODE` against the unlinked vnode. The cost is that
 * running this file on its own leaves one sqlite file in the temp directory;
 * running the suite, which is how it runs, does not.
 */
const DATABASE = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);

type Entrypoint = (typeof import("../server/index"))["default"];
type AuthModule = typeof import("../server/auth");
type DuelModule = typeof import("../server/duel");

/**
 * Port 0 rather than the configured one: a developer's own server is usually
 * already on it, and a fixed port is a flake waiting for a parallel run.
 */
function serveDuels(entry: Entrypoint) {
  return Bun.serve({ ...entry, port: 0 });
}

let server: ReturnType<typeof serveDuels>;
let httpBase: string;
let socketBase: string;
let mintSession: AuthModule["mintSession"];
/** The claim budget, read from the referee rather than repeated here. */
let claimLimit: DuelModule["CLAIM_LIMIT"];
let resetDuels: DuelModule["resetDuels"];
/** Pins the pool a duel deals from, so a repeat is a certainty and not a wait. */
let useArchive: DuelModule["useArchive"];
let useIntermission: DuelModule["useIntermission"];
/** Called with a time rather than waited for: the offer's TTL is two minutes. */
let sweepDuels: DuelModule["sweepDuels"];

beforeAll(async () => {
  process.env.DATABASE_PATH = DATABASE;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  const entry = (await import("../server/index")).default;
  ({ mintSession } = await import("../server/auth"));
  ({ CLAIM_LIMIT: claimLimit, resetDuels, sweepDuels, useArchive, useIntermission } = await import(
    "../server/duel"
  ));
  // Rounds run back to back here. The pause between them is real behaviour and
  // is tested on its own; making every other test sit through it would add
  // minutes of sleeping to a suite that otherwise runs in under a second.
  useIntermission(1);
  server = serveDuels(entry);
  httpBase = `http://127.0.0.1:${server.port}`;
  socketBase = `ws://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

// ── Talking to it ────────────────────────────────────────────────────────────

const GUILD = "guild-under-test";

/** An id no `open` can ever mint, so joining it always answers with an error. */
const NO_SUCH_LOBBY = "no-such-lobby";

/** How long a test waits for a frame the server owes it before giving up. */
const FRAME_TIMEOUT_MS = 5_000;

/**
 * The real timers, captured before the rush tests swap in fake ones.
 *
 * A rush's clock is only reachable through `jest.useFakeTimers`, and a waiter
 * armed with a faked timeout would never fire: a test owed a frame that never
 * came would hang the suite instead of failing it.
 */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

interface Duellist {
  readonly id: string;
  /** Every frame this socket has been sent, for asserting what did not arrive. */
  readonly received: readonly DuelEvent[];
  send(command: DuelCommand): void;
  take<T extends DuelEvent["type"]>(type: T): Promise<Extract<DuelEvent, { type: T }>>;
  settle(): Promise<void>;
  close(): void;
}

const live: Duellist[] = [];
let minted = 0;

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("the upgrade was refused")), {
      once: true,
    });
    socket.addEventListener("close", (event) => reject(new Error(`closed (${event.code})`)), {
      once: true,
    });
  });
}

async function connect(name: string, guildId: string | null = GUILD): Promise<Duellist> {
  // A fresh id per connection. The registry keeps one socket per player and
  // closes the older one, so a name reused across cases would reach back into
  // the previous one's match.
  const id = `${name}-${++minted}`;
  const { token } = await mintSession({ id, username: name, avatarUrl: null }, guildId);
  const socket = new WebSocket(`${socketBase}/api/duel?token=${encodeURIComponent(token)}`);

  const received: DuelEvent[] = [];
  const unread: DuelEvent[] = [];
  let wake: (() => void) | null = null;

  socket.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as DuelEvent;
    received.push(event);
    unread.push(event);
    wake?.();
  });
  await opened(socket);

  function waitFor(ready: () => boolean, what: string): Promise<void> {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = realSetTimeout(() => {
        wake = null;
        reject(new Error(`${id} waited ${FRAME_TIMEOUT_MS}ms for ${what}`));
      }, FRAME_TIMEOUT_MS);
      wake = () => {
        if (!ready()) return;
        wake = null;
        realClearTimeout(timer);
        resolve();
      };
    });
  }

  async function take<T extends DuelEvent["type"]>(type: T) {
    await waitFor(() => unread.some((event) => event.type === type), `a "${type}" frame`);
    const index = unread.findIndex((event) => event.type === type);
    return unread.splice(index, 1)[0] as Extract<DuelEvent, { type: T }>;
  }

  const errors = () => unread.filter((event) => event.type === "error");

  const client: Duellist = {
    id,
    received,
    send: (command) => socket.send(JSON.stringify(command)),
    take,
    /**
     * Resolves once the server has finished with everything sent before it.
     *
     * One socket's frames are handled in order, so a reply to a frame sent now
     * proves every earlier one is already through `handle` — the only honest
     * way to assert that something did *not* happen in response to them.
     */
    async settle() {
      const before = errors().length;
      socket.send(JSON.stringify({ type: "join", duelId: NO_SUCH_LOBBY } satisfies DuelCommand));
      await waitFor(() => errors().length > before, "the settling reply");
      const reply = errors().at(-1)!;
      unread.splice(unread.indexOf(reply), 1);
    },
    close: () => socket.close(),
  };
  live.push(client);
  return client;
}

afterEach(() => {
  jest.useRealTimers();
  for (const client of live) client.close();
  live.length = 0;
  resetDuels();
});

/** Whether the upgrade is granted at all, which is all a refusal test needs. */
async function upgrades(query: string): Promise<boolean> {
  const socket = new WebSocket(`${socketBase}/api/duel${query}`);
  try {
    await opened(socket);
    socket.close();
    return true;
  } catch {
    return false;
  }
}

async function statusOf(url: string): Promise<number> {
  const response = await fetch(url);
  await response.text();
  return response.status;
}

function framesOfType<T extends DuelEvent["type"]>(
  received: readonly DuelEvent[],
  type: T,
): Extract<DuelEvent, { type: T }>[] {
  return received.filter((event): event is Extract<DuelEvent, { type: T }> => event.type === type);
}

function playerIn(duel: DuelView, playerId: string): DuelPlayerView {
  const player = duel.players.find((entry) => entry.id === playerId);
  if (!player) throw new Error(`${playerId} has no seat in duel ${duel.id}`);
  return player;
}

function scoreOf(duel: DuelView, playerId: string): number {
  return playerIn(duel, playerId).score;
}

// ── The archive, answers and all ─────────────────────────────────────────────

const archive: Puzzle[] = JSON.parse(readFileSync("data/puzzles.json", "utf8")).puzzles;

function setupFor(puzzle: Puzzle) {
  return { board: decodeBoard(puzzle.board, ENGINE_ROWS), queue: puzzle.queue, hold: puzzle.hold };
}

/** The archived puzzle a prompt was cut from, answer included. */
function answerFor(prompt: PuzzlePrompt): Puzzle {
  const puzzle = archive.find((entry) => entry.id === prompt.id);
  if (!puzzle) throw new Error(`The server served puzzle ${prompt.id}, which is not in the archive`);
  return puzzle;
}

/**
 * Keystrokes that play a puzzle's archived solution.
 *
 * The archive records where each piece came to rest, not how it got there, so
 * the route back has to be searched for — a spin only counts if the last input
 * before the drop was a rotation. The same reconstruction `tests/server.test.ts`
 * and `tools/e2e-submit.ts` do, and for the same reason: nothing else can
 * produce a claim the referee will accept.
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

  for (const step of puzzle.solution.slice(0, pieceBudget(puzzle))) {
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

// ── Lobbies ──────────────────────────────────────────────────────────────────

const puzzleDuel = (rounds: number): DuelSettings => ({
  ...DEFAULT_DUEL_SETTINGS,
  mode: "puzzle",
  rounds,
  durationMs: DUEL_ROUND_MS_MIN,
});

const rushDuel = (): DuelSettings => ({
  ...DEFAULT_DUEL_SETTINGS,
  mode: "rush",
  rounds: 1,
  durationMs: DUEL_RUSH_MS_MIN,
});

interface Lobby {
  readonly host: Duellist;
  readonly guest: Duellist;
  readonly duelId: string;
}

async function lobby(settings: DuelSettings, guildId = GUILD): Promise<Lobby> {
  const host = await connect("alice", guildId);
  const guest = await connect("bob", guildId);
  await host.take("welcome");
  await guest.take("welcome");
  host.send({ type: "open", settings });
  const mine = await host.take("duel");
  guest.send({ type: "join", duelId: mine.duel.id });
  // The second seat is broadcast, so both ends see it arrive.
  await host.take("duel");
  await guest.take("duel");
  return { host, guest, duelId: mine.duel.id };
}

async function playPuzzleDuel(rounds: number): Promise<Lobby> {
  const seats = await lobby(puzzleDuel(rounds));
  seats.host.send({ type: "ready" });
  return seats;
}

type RoundFrame = Extract<DuelEvent, { type: "round" }>;

/**
 * Claims a round with the log that solves it.
 *
 * Sent against the round the prompt came in on, because that is what an honest
 * client does: the frame that deals a puzzle says which puzzle of the match it
 * is, and the claim hands that back so a log read late is refused rather than
 * spent on whatever has replaced it.
 */
function claim(player: Duellist, round: RoundFrame): void {
  player.send({
    type: "claim",
    position: round.round,
    events: solvingLog(answerFor(round.puzzle)),
  });
}

// ── The handshake ────────────────────────────────────────────────────────────

describe("identity comes from the handshake and nowhere else", () => {
  test("a socket with no token is refused", async () => {
    expect(await statusOf(`${httpBase}/api/duel`)).toBe(401);
    expect(await upgrades("")).toBe(false);
  });

  test("a forged token is refused", async () => {
    // A payload that says whatever it likes, signed by somebody who does not
    // have the key. If this is ever accepted, every seat is anybody's.
    const claimed = {
      player: { id: "somebody-else", username: "Somebody Else", avatarUrl: null },
      guildId: GUILD,
      expiresAt: Date.now() + 60_000,
    };
    const payload = Buffer.from(JSON.stringify(claimed)).toString("base64url");
    const forged = `${payload}.${Buffer.from("not the server's signature").toString("base64url")}`;

    expect(await statusOf(`${httpBase}/api/duel?token=${encodeURIComponent(forged)}`)).toBe(401);
    expect(await upgrades(`?token=${encodeURIComponent(forged)}`)).toBe(false);
  });

  test("a token the server signed opens a socket, and nothing else", async () => {
    const { token } = await mintSession(
      { id: "honest", username: "Honest", avatarUrl: null },
      GUILD,
    );
    // The same token without upgrade headers: a 400 rather than a 401 is how we
    // know the signature was read and it was only the handshake that failed.
    expect(await statusOf(`${httpBase}/api/duel?token=${encodeURIComponent(token)}`)).toBe(400);
    expect(await upgrades(`?token=${encodeURIComponent(token)}`)).toBe(true);
  });

  test("the Discord proxy prefix reaches the same socket", async () => {
    // `/.proxy` is stripped before Hono routing, not by a route, so a duel
    // upgrade under it has to land in the same place or it lands nowhere.
    expect(await statusOf(`${httpBase}/.proxy/api/duel`)).toBe(401);
  });
});

// ── Puzzle duels ─────────────────────────────────────────────────────────────

describe("a puzzle duel deals one puzzle to both players", () => {
  test("open, join, ready — and both are dealt the same round", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    const forHost = await host.take("round");
    const forGuest = await guest.take("round");

    expect(forGuest).toEqual(forHost);
    expect(forHost.round).toBe(1);
    expect(forHost.duel.phase).toBe("playing");
    expect(forHost.duel.players.map((player) => player.id)).toEqual([host.id, guest.id]);
    expect(forHost.endsAt).toBeGreaterThan(Date.now());
    expect(forHost.endsAt).toBeLessThanOrEqual(Date.now() + DUEL_ROUND_MS_MIN);
  });

  test("the prompt carries neither the solution nor its source", async () => {
    const { host } = await playPuzzleDuel(3);
    const round = await host.take("round");

    expect(Object.keys(round.puzzle)).not.toContain("solution");
    expect(Object.keys(round.puzzle)).not.toContain("source");
    // The archived puzzle has both, so this fails the day a prompt is sent raw
    // rather than passing because the field was renamed out from under it.
    expect(Object.keys(answerFor(round.puzzle))).toEqual(
      expect.arrayContaining(["solution", "source"]),
    );
  });

  test("progress reaches the opponent and carries no board", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    const round = await host.take("round");
    await guest.take("round");
    const progress: DuelProgress = {
      piecesPlaced: 2,
      pieceBudget: pieceBudget(round.puzzle),
      attack: 1,
      targetAttack: round.puzzle.targetAttack,
      solved: 0,
    };

    host.send({ type: "progress", progress });
    const seen = await guest.take("opponent");

    expect(seen.progress).toEqual(progress);
    // A board part-way through a puzzle is a partial solution to it.
    expect(JSON.stringify(seen)).not.toContain("board");
  });

  test("a progress frame is bounded before it is relayed", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    await host.take("round");
    await guest.take("round");

    // The one thing one client sends and another draws, and a socket frame
    // meets no middleware on the way through. Omitted entirely, it still has to
    // arrive as something the opponent's renderer can read.
    host.send({ type: "progress", progress: null } as unknown as DuelCommand);
    const empty = await guest.take("opponent");
    expect(empty.progress).toEqual({
      piecesPlaced: 0,
      pieceBudget: 0,
      attack: 0,
      targetAttack: 0,
      solved: 0,
    });

    host.send({
      type: "progress",
      progress: {
        piecesPlaced: -3,
        pieceBudget: 4.6,
        attack: Number.NaN,
        targetAttack: "9",
        solved: 1,
        board: "x".repeat(2_000),
      },
    } as unknown as DuelCommand);
    const bounded = await guest.take("opponent");

    // Five numbers, and only those five: not a negative count, not a NaN the
    // renderer would divide by, and not a payload the sender chose the size of.
    expect(bounded.progress).toEqual({
      piecesPlaced: 0,
      pieceBudget: 5,
      attack: 0,
      targetAttack: 0,
      solved: 1,
    });
    expect(Object.values(bounded.progress).every((value) => Number.isFinite(value))).toBe(true);
    expect(JSON.stringify(bounded)).not.toContain("board");
  });
});

describe("a round is won by a log that solves it", () => {
  test("a claim that does not solve it is refused, and takes no round", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    const round = await host.take("round");
    await guest.take("round");

    host.send({ type: "claim", position: round.round, events: [] });
    expect((await host.take("error")).message).toBe("That log does not solve this round");

    // Settled after the claim was answered, so a round it had somehow taken
    // would already be sitting in both inboxes.
    await guest.settle();
    expect(framesOfType(host.received, "roundOver")).toHaveLength(0);
    expect(framesOfType(guest.received, "roundOver")).toHaveLength(0);
  });

  test("a claim that names another puzzle is refused, and takes no round", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    const round = await host.take("round");
    await guest.take("round");

    // The answer to the round being played, filed under the round after it:
    // what a client that banks solved logs sends, and what two claims in the
    // same tick produce by accident once the first has dealt the next round.
    host.send({
      type: "claim",
      position: round.round + 1,
      events: solvingLog(answerFor(round.puzzle)),
    });
    expect((await host.take("error")).message).toBe("That log was played on another puzzle");

    await guest.settle();
    expect(framesOfType(guest.received, "roundOver")).toHaveLength(0);

    // And the same log, filed under the round it really was played on, still
    // takes it: the position refuses a log, it never awards one.
    claim(host, round);
    expect((await host.take("roundOver")).winnerId).toBe(host.id);
  });

  test("a claim longer than the round is refused before it is replayed", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    const round = await host.take("round");
    await guest.take("round");

    // A couple of hundred bytes with nothing in them to play. Nothing locks on
    // its own in a puzzle, so whatever reads this ticks the engine every frame
    // out to the far end — about ten milliseconds of a loop that is serving
    // everything else. The shape `tests/server.test.ts` pins on the rush route.
    const events: InputEvent[] = [
      { frame: MAX_FRAMES - 1, type: "keydown", data: { key: "moveLeft", subframe: 0 } },
      { frame: MAX_FRAMES - 1, type: "keyup", data: { key: "moveLeft", subframe: 0 } },
    ];

    const started = performance.now();
    for (let sent = 0; sent < claimLimit; sent++) {
      host.send({ type: "claim", position: round.round, events });
    }
    const refusals: string[] = [];
    while (refusals.length < claimLimit) refusals.push((await host.take("error")).message);
    const elapsed = performance.now() - started;

    expect(new Set(refusals)).toEqual(new Set(["That log is longer than the round"]));
    // Every one of them turned away before anything was replayed: a whole
    // claim budget of these costs less than one replay of a single one.
    expect(elapsed).toBeLessThan(100);

    await guest.settle();
    expect(framesOfType(guest.received, "roundOver")).toHaveLength(0);
  });

  test("claims are rationed apart from the messages that cost nothing", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    const round = await host.take("round");
    await guest.take("round");

    // A claim is the only frame that buys a replay, so it has a budget of its
    // own rather than sharing the message allowance, which is sized for the
    // `progress` chatter of two players mid-round.
    for (let sent = 0; sent <= claimLimit; sent++) {
      host.send({ type: "claim", position: round.round, events: [] });
    }
    const messages: string[] = [];
    while (messages.length <= claimLimit) messages.push((await host.take("error")).message);

    expect(messages.slice(0, claimLimit)).toEqual(
      Array.from({ length: claimLimit }, () => "That log does not solve this round"),
    );
    expect(messages.at(-1)).toBe("Too many claims at once");
    // Refused, not closed. A client sending too many is a bug far more often
    // than an attack, and closing the socket would forfeit the match over it.
    expect(framesOfType(guest.received, "matchOver")).toHaveLength(0);
  });

  test("a solve made in time is still taken a moment after the buzzer", async () => {
    const seats = await lobby(puzzleDuel(3));
    jest.useFakeTimers();
    try {
      seats.host.send({ type: "ready" });
      const first = await seats.host.take("round");
      await seats.guest.take("round");

      // Past the buzzer, inside the grace: the hop a player on a slow
      // connection pays for a solve they genuinely made in time. The round has
      // to outlive its own deadline to receive it, or the grace admits nothing.
      jest.advanceTimersByTime(DUEL_ROUND_MS_MIN + 1);
      expect(Date.now()).toBeGreaterThan(first.endsAt);
      expect(Date.now()).toBeLessThanOrEqual(first.endsAt + DUEL_CLAIM_GRACE_MS);

      // Asserted before the claim, and not by waiting for a frame that would
      // never come: a round torn down on its buzzer has already dealt its
      // replacement, and this is the cheap way to see that it has not.
      await seats.host.settle();
      expect(framesOfType(seats.host.received, "round")).toHaveLength(1);

      claim(seats.host, first);
      const over = await seats.host.take("roundOver");

      // The round it was played on, not the one that would otherwise have
      // replaced it by now.
      expect(over.round).toBe(first.round);
      expect(over.winnerId).toBe(seats.host.id);
      expect(over.reason).toBe("solved");
      expect(scoreOf(over.duel, seats.host.id)).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a claim that solves it takes the round, and both are told", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    const round = await host.take("round");
    await guest.take("round");

    claim(host, round);
    const forHost = await host.take("roundOver");
    const forGuest = await guest.take("roundOver");

    expect(forGuest).toEqual(forHost);
    expect(forHost.round).toBe(1);
    expect(forHost.winnerId).toBe(host.id);
    expect(forHost.reason).toBe("solved");
    expect(scoreOf(forHost.duel, host.id)).toBe(1);
    expect(scoreOf(forHost.duel, guest.id)).toBe(0);
    // Best of three is not over, so the next round follows straight away.
    expect((await host.take("round")).round).toBe(2);
  });

  test("a round nobody claims expires as a draw, and the next one starts", async () => {
    const seats = await lobby(puzzleDuel(3));
    // Faked from here, so the round timer armed by `ready` is the fake one and
    // the handshake above ran on the real clock.
    jest.useFakeTimers();
    try {
      seats.host.send({ type: "ready" });
      const first = await seats.host.take("round");
      await seats.guest.take("round");

      // The round outlives its buzzer by the grace, so this has to clear both.
      jest.advanceTimersByTime(DUEL_ROUND_MS_MIN + DUEL_CLAIM_GRACE_MS + 1);

      const over = await seats.host.take("roundOver");
      expect(await seats.guest.take("roundOver")).toEqual(over);
      expect(over.round).toBe(first.round);
      expect(over.winnerId).toBeNull();
      expect(over.reason).toBe("expired");
      expect(over.duel.players.map((player) => player.score)).toEqual([0, 0]);
      // A draw is still a round played, so best of three has two left.
      expect((await seats.host.take("round")).round).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("best of three ends the moment one player has taken two", async () => {
    const rounds = 3;
    const needed = roundsToWin(rounds);
    const { host, guest } = await playPuzzleDuel(rounds);

    for (let won = 0; won < needed; won++) {
      const round = await host.take("round");
      await guest.take("round");
      claim(host, round);
      await host.take("roundOver");
      await guest.take("roundOver");
    }

    const over = await host.take("matchOver");
    expect((await guest.take("matchOver")).winnerId).toBe(host.id);
    expect(over.winnerId).toBe(host.id);
    expect(scoreOf(over.duel, host.id)).toBe(needed);
    // The decided match stops early: a third round is never dealt, and no
    // roundOver arrives for one.
    expect(framesOfType(host.received, "roundOver")).toHaveLength(needed);
    expect(framesOfType(host.received, "round").map((round) => round.round)).toEqual([1, 2]);
  });

  test("two claims in the same tick award exactly one winner", async () => {
    // Best of three, not best of one. Winning a single-round match deletes the
    // duel out from under the loser's claim, and a claim the referee never
    // reads cannot show whether the referee would have awarded it too. Here it
    // is read while the duel is still live, so an award it should not have had
    // surfaces as a second round ending that nobody played.
    const { host, guest } = await playPuzzleDuel(3);
    const first = await host.take("round");
    await guest.take("round");
    const events = solvingLog(answerFor(first.puzzle));

    // Both frames leave before either reply is read — as close to one tick as a
    // socket client can arrange, and the arrangement the whole design turns on:
    // nothing in the claim path awaits, so the two are settled by the order the
    // socket delivered them and by nothing else.
    host.send({ type: "claim", position: first.round, events });
    guest.send({ type: "claim", position: first.round, events });

    const [forHost, forGuest] = await Promise.all([
      host.take("roundOver"),
      guest.take("roundOver"),
    ]);
    const second = await host.take("round");
    await guest.take("round");
    // The loser's claim is read after the round has been taken. Settling proves
    // it was read at all, so a second award would already have arrived.
    await Promise.all([host.settle(), guest.settle()]);

    // One of them, and only one. Null would mean the round expired rather than
    // being claimed, so it has to fail this rather than pass as a draw.
    const winnerId = String(forHost.winnerId);
    expect([host.id, guest.id]).toContain(winnerId);
    expect(forGuest).toEqual(forHost);
    expect(forHost.round).toBe(1);
    expect(forHost.reason).toBe("solved");
    expect(scoreOf(forHost.duel, winnerId)).toBe(1);
    expect(second.round).toBe(2);
    expect(framesOfType(host.received, "matchOver")).toHaveLength(0);

    // One claim, one round. Round two is a puzzle this duel has not dealt
    // before, and the loser's log names round one either way, so there is no
    // arrangement in which it also takes the round that has just started.
    expect(second.puzzle.id).not.toBe(first.puzzle.id);
    expect(framesOfType(host.received, "roundOver")).toHaveLength(1);
    expect(framesOfType(guest.received, "roundOver")).toHaveLength(1);

    // And the losing claim was refused by the referee rather than dropped on
    // the way in, which is what makes the count above worth anything: it was
    // read, after the round it names had ended, and turned down there before it
    // could be replayed against anything.
    const refused = "That round is over";
    const loser = winnerId === host.id ? guest : host;
    const winner = winnerId === host.id ? host : guest;
    expect(framesOfType(loser.received, "error").map((frame) => frame.message)).toContain(refused);
    expect(framesOfType(winner.received, "error").map((frame) => frame.message)).not.toContain(
      refused,
    );
  });
});

describe("a lobby belongs to one server", () => {
  test("another guild neither sees it nor can join it", async () => {
    const alice = await connect("alice", "guild-a");
    await alice.take("welcome");
    alice.send({ type: "open", settings: puzzleDuel(3) });
    const mine = await alice.take("duel");

    const outsider = await connect("mallory", "guild-b");
    const elsewhere = await outsider.take("welcome");
    expect(elsewhere.open.map((duel) => duel.id)).not.toContain(mine.duel.id);
    outsider.send({ type: "join", duelId: mine.duel.id });
    expect((await outsider.take("error")).message).toBe("That lobby is gone");

    const neighbour = await connect("carol", "guild-a");
    const listed = await neighbour.take("welcome");
    expect(listed.open.map((duel) => duel.id)).toContain(mine.duel.id);
    neighbour.send({ type: "join", duelId: mine.duel.id });
    expect((await neighbour.take("duel")).duel.players.map((player) => player.id)).toEqual([
      alice.id,
      neighbour.id,
    ]);
  });
});

describe("leaving mid-match forfeits", () => {
  test("saying so hands the match to whoever stayed", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    await host.take("round");
    await guest.take("round");

    host.send({ type: "leave" });
    const over = await guest.take("matchOver");

    expect(over.winnerId).toBe(guest.id);
    expect(over.reason).toBe("forfeit");
  });

  test("a dropped socket forfeits the same way", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    await host.take("round");
    await guest.take("round");

    guest.close();
    const over = await host.take("matchOver");

    expect(over.winnerId).toBe(host.id);
    expect(over.reason).toBe("forfeit");
  });
});

// ── Rush duels ───────────────────────────────────────────────────────────────

type RushFrame = Extract<DuelEvent, { type: "rush" }>;

/** Solves the puzzle a player is on and returns the one they are handed next. */
async function solveRush(player: Duellist, frame: RushFrame): Promise<RushFrame> {
  if (!frame.puzzle) throw new Error(`${player.id} was dealt no puzzle to solve`);
  player.send({
    type: "claim",
    position: frame.index,
    events: solvingLog(answerFor(frame.puzzle)),
  });
  return player.take("rush");
}

describe("a rush duel is one stack walked at two paces", () => {
  test("both players open on the same puzzle, one clock and a full hand of skips", async () => {
    const { host, guest } = await lobby(rushDuel());
    host.send({ type: "ready" });

    const forHost = await host.take("rush");
    const forGuest = await guest.take("rush");

    expect(forHost.puzzle?.id).toBe(forGuest.puzzle?.id);
    expect(forHost.index).toBe(0);
    expect(forGuest.index).toBe(0);
    expect(forHost.solved).toBe(0);
    expect(forHost.skipsLeft).toBe(RUSH_SKIPS);
    // One clock for the match, not one per puzzle.
    expect(forHost.endsAt).toBe(forGuest.endsAt);
    expect(forHost.endsAt).toBeGreaterThan(Date.now());
    // A round names the puzzle both are racing on, and a rush has no such thing.
    expect(framesOfType(host.received, "round")).toHaveLength(0);
    expect(Object.keys(forHost.puzzle ?? {})).not.toContain("solution");
  });

  test("a solve advances the player who made it and nobody else", async () => {
    const { host, guest } = await lobby(rushDuel());
    host.send({ type: "ready" });
    const first = await host.take("rush");
    await guest.take("rush");

    const second = await solveRush(host, first);
    expect(second.index).toBe(1);
    expect(second.solved).toBe(1);
    expect(second.puzzle?.id).not.toBe(first.puzzle?.id);

    // The opponent is owed the score and nothing more. The index would say what
    // is coming, and a board is never mirrored at all.
    const told = await guest.take("duel");
    expect(scoreOf(told.duel, host.id)).toBe(1);
    expect(scoreOf(told.duel, guest.id)).toBe(0);
    expect(JSON.stringify(told)).not.toContain("board");
    expect(JSON.stringify(told)).not.toContain("queue");

    await guest.settle();
    expect(framesOfType(guest.received, "rush")).toHaveLength(1);
  });

  test("a claim is read against the puzzle that player is on", async () => {
    const { host, guest } = await lobby(rushDuel());
    host.send({ type: "ready" });
    const first = await host.take("rush");
    await guest.take("rush");
    const second = await solveRush(host, first);

    // The log that just worked, replayed against the next puzzle in the stack.
    if (!first.puzzle) throw new Error("the stack was empty");
    const solvesTheFirst = solvingLog(answerFor(first.puzzle));
    host.send({ type: "claim", position: second.index, events: solvesTheFirst });
    expect((await host.take("error")).message).toBe("That log does not solve this puzzle");

    // And filed under the puzzle it really was played on, it is refused without
    // being replayed at all: the stack has moved on, and a log that says so is
    // a log from before a solve, a skip or a rematch.
    host.send({ type: "claim", position: first.index, events: solvesTheFirst });
    expect((await host.take("error")).message).toBe("That log was played on another puzzle");

    await host.settle();
    expect(framesOfType(host.received, "rush").at(-1)?.index).toBe(second.index);
  });

  test("a skip advances without a solve, and runs out", async () => {
    const { host, guest } = await lobby(rushDuel());
    host.send({ type: "ready" });
    const first = await host.take("rush");
    await guest.take("rush");

    for (let spent = 1; spent <= RUSH_SKIPS; spent++) {
      host.send({ type: "skip" });
      const next = await host.take("rush");
      expect(next.index).toBe(spent);
      expect(next.solved).toBe(0);
      expect(next.skipsLeft).toBe(RUSH_SKIPS - spent);
      expect(next.puzzle?.id).not.toBe(first.puzzle?.id);
    }

    host.send({ type: "skip" });
    expect((await host.take("error")).message).toBe(`A rush allows ${RUSH_SKIPS} skips`);

    await host.settle();
    expect(framesOfType(host.received, "rush")).toHaveLength(1 + RUSH_SKIPS);
    // A skip is not a score, so the opponent is never told about one.
    expect(framesOfType(guest.received, "duel")).toHaveLength(1);
  });

  test("when the one clock expires, the most solves wins", async () => {
    const { host, guest } = await lobby(rushDuel());
    // The shortest rush a host may buy is a minute, so the clock is wound
    // forward rather than waited out. Faked only from here, so that the match
    // timer is the fake one and the lobby handshake above was not.
    jest.useFakeTimers();
    try {
      host.send({ type: "ready" });
      const hostFirst = await host.take("rush");
      const guestFirst = await guest.take("rush");

      const hostSecond = await solveRush(host, hostFirst);
      await guest.take("duel");
      await solveRush(host, hostSecond);
      await guest.take("duel");
      await solveRush(guest, guestFirst);
      await host.take("duel");

      jest.advanceTimersByTime(DUEL_RUSH_MS_MIN + DUEL_CLAIM_GRACE_MS + 1);

      const over = await host.take("matchOver");
      const forGuest = await guest.take("matchOver");
      expect(over.reason).toBe("expired");
      expect(over.winnerId).toBe(host.id);
      expect(forGuest.winnerId).toBe(host.id);
      expect(scoreOf(over.duel, host.id)).toBe(2);
      expect(scoreOf(over.duel, guest.id)).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a solve made in time still counts a moment after the buzzer", async () => {
    const { host, guest } = await lobby(rushDuel());
    jest.useFakeTimers();
    try {
      host.send({ type: "ready" });
      const first = await host.take("rush");
      await guest.take("rush");
      if (!first.puzzle) throw new Error("the stack was empty");

      // Solved before the buzzer, read a hop after it. Solo rush admits the
      // same last-second solve at submit, and a duel is not the harsher clock.
      jest.advanceTimersByTime(DUEL_RUSH_MS_MIN + 1);
      expect(Date.now()).toBeGreaterThan(first.endsAt);
      // The match is still here to be claimed against, and said nothing when
      // the buzzer went: the final score is not out yet.
      await host.settle();
      expect(framesOfType(host.received, "matchOver")).toHaveLength(0);

      host.send({
        type: "claim",
        position: first.index,
        events: solvingLog(answerFor(first.puzzle)),
      });

      const told = await guest.take("duel");
      expect(scoreOf(told.duel, host.id)).toBe(1);
      // Counted, but nothing new dealt: the stack does not creep forward once
      // the clock both players are watching has run out. Settled first, because
      // a puzzle dealt to this player is a frame on this player's socket.
      await host.settle();
      expect(framesOfType(host.received, "rush")).toHaveLength(1);

      jest.advanceTimersByTime(DUEL_CLAIM_GRACE_MS);
      const over = await host.take("matchOver");
      expect(over.winnerId).toBe(host.id);
      expect(scoreOf(over.duel, host.id)).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("equal solve counts is a draw", async () => {
    const { host, guest } = await lobby(rushDuel());
    jest.useFakeTimers();
    try {
      host.send({ type: "ready" });
      const hostFirst = await host.take("rush");
      const guestFirst = await guest.take("rush");
      await solveRush(host, hostFirst);
      await guest.take("duel");
      await solveRush(guest, guestFirst);
      await host.take("duel");

      jest.advanceTimersByTime(DUEL_RUSH_MS_MIN + DUEL_CLAIM_GRACE_MS + 1);

      const over = await host.take("matchOver");
      expect(over.winnerId).toBeNull();
      expect(over.reason).toBe("expired");
      expect(scoreOf(over.duel, host.id)).toBe(1);
      expect(scoreOf(over.duel, guest.id)).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── Rematches ────────────────────────────────────────────────────────────────

/** Puzzles the duel that tests dealing without replacement may draw from. */
/**
 * The smallest pool a room may legally draw from.
 *
 * Was five, chosen to sit just above a best-of-7's four rounds. The referee now
 * refuses any rule set whose pool is smaller than DUEL_MIN_POOL, so five is no
 * longer a lobby anyone can open — the floor is the tightest this test can
 * squeeze the pool, and it still leaves the deal only three spare puzzles.
 */
const PINNED_POOL = DUEL_MIN_POOL;

/** Plays a best-of-`rounds` match out, the host taking every round of it. */
async function hostWinsMatch(rounds: number): Promise<Lobby> {
  const seats = await playPuzzleDuel(rounds);
  for (let won = 0; won < roundsToWin(rounds); won++) {
    const round = await seats.host.take("round");
    await seats.guest.take("round");
    claim(seats.host, round);
    await seats.host.take("roundOver");
    await seats.guest.take("roundOver");
  }
  await seats.host.take("matchOver");
  await seats.guest.take("matchOver");
  return seats;
}

describe("a finished match is played again only if both ask", () => {
  test("one player asking tells them both, and restarts nothing", async () => {
    const { host, guest } = await hostWinsMatch(1);

    host.send({ type: "rematch" });
    const forGuest = await guest.take("duel");
    const forHost = await host.take("duel");

    // The opponent has to learn of the offer, or the asker is left waiting on
    // somebody who was never told there was anything to accept.
    expect(forGuest).toEqual(forHost);
    expect(playerIn(forGuest.duel, host.id).wantsRematch).toBe(true);
    expect(playerIn(forGuest.duel, guest.id).wantsRematch).toBe(false);
    expect(forGuest.duel.phase).toBe("over");
    expect(forGuest.duel.rematchEndsAt).not.toBeNull();

    // Settled after the ask was answered, so a match it had somehow restarted
    // would already have dealt a second round into both inboxes.
    await Promise.all([host.settle(), guest.settle()]);
    expect(framesOfType(host.received, "round")).toHaveLength(1);
    expect(framesOfType(guest.received, "round")).toHaveLength(1);
  });

  test("asking twice is asking once", async () => {
    const { host, guest } = await hostWinsMatch(1);

    host.send({ type: "rematch" });
    await guest.take("duel");
    host.send({ type: "rematch" });

    await Promise.all([host.settle(), guest.settle()]);
    // The second ask is not the acceptance the first one is waiting for, and it
    // is not news either: one player, one offer, one frame about it.
    expect(framesOfType(guest.received, "duel").filter((frame) => frame.duel.phase === "over"))
      .toHaveLength(1);
    expect(framesOfType(host.received, "round")).toHaveLength(1);
  });

  test("both asking restarts the same duel, from zero", async () => {
    const rounds = 3;
    const { host, guest, duelId } = await hostWinsMatch(rounds);
    const over = framesOfType(host.received, "matchOver")[0]!;
    expect(scoreOf(over.duel, host.id)).toBe(roundsToWin(rounds));

    host.send({ type: "rematch" });
    await guest.take("duel");
    guest.send({ type: "rematch" });

    const forHost = await host.take("round");
    const forGuest = await guest.take("round");

    expect(forGuest).toEqual(forHost);
    // The same duel, so neither of them went looking for the other again.
    expect(forHost.duel.id).toBe(duelId);
    expect(forHost.duel.settings).toEqual(over.duel.settings);
    expect(forHost.duel.phase).toBe("playing");
    // Rounds played back to zero: this is round one, not round four.
    expect(forHost.round).toBe(1);
    expect(scoreOf(forHost.duel, host.id)).toBe(0);
    expect(scoreOf(forHost.duel, guest.id)).toBe(0);
    expect(forHost.duel.players.map((player) => player.wantsRematch)).toEqual([false, false]);
    expect(forHost.duel.rematchEndsAt).toBeNull();

    // And it is a match, not a screen: the round can be taken like any other.
    claim(guest, forHost);
    const round = await guest.take("roundOver");
    expect(round.winnerId).toBe(guest.id);
    expect(scoreOf(round.duel, guest.id)).toBe(1);
    expect(scoreOf(round.duel, host.id)).toBe(0);
  });

  test("a rush goes again on a fresh stack, with a full hand of skips", async () => {
    const { host, guest } = await lobby(rushDuel());
    jest.useFakeTimers();
    try {
      host.send({ type: "ready" });
      const first = await host.take("rush");
      await guest.take("rush");
      await solveRush(host, first);
      await guest.take("duel");

      jest.advanceTimersByTime(DUEL_RUSH_MS_MIN + DUEL_CLAIM_GRACE_MS + 1);
      const over = await host.take("matchOver");
      await guest.take("matchOver");
      expect(scoreOf(over.duel, host.id)).toBe(1);

      host.send({ type: "rematch" });
      await guest.take("duel");
      guest.send({ type: "rematch" });

      const again = await host.take("rush");
      const alsoAgain = await guest.take("rush");
      expect(again.index).toBe(0);
      expect(again.solved).toBe(0);
      expect(again.skipsLeft).toBe(RUSH_SKIPS);
      expect(scoreOf(again.duel, host.id)).toBe(0);
      // One stack, dealt fresh: both open on the same puzzle and a whole clock.
      expect(again.puzzle?.id).toBe(alsoAgain.puzzle?.id);
      expect(again.endsAt).toBe(alsoAgain.endsAt);
      expect(again.endsAt).toBeGreaterThan(Date.now());
    } finally {
      jest.useRealTimers();
    }
  });

  test("going again deals a puzzle neither of them has played", async () => {
    // Pinned to the smallest pool the referee will accept, because a repeat
    // drawn from the whole archive is a one-in-a-hundred wait: five puzzles
    // dealt from eight without one is unlikely by luck and certain by the
    // mechanism, which is the thing under test.
    const pinned = archive.filter(isRushEligible).slice(0, PINNED_POOL);
    useArchive(pinned);
    try {
      const rounds = 7;
      const { host, guest } = await hostWinsMatch(rounds);
      const played = framesOfType(host.received, "round").map((frame) => frame.puzzle.id);
      expect(played).toHaveLength(roundsToWin(rounds));
      // A puzzle one of them has already solved is not a round, it is a memory
      // test — and it is the one case in which a log banked on an earlier round
      // would verify against a later one.
      expect(new Set(played).size).toBe(played.length);

      host.send({ type: "rematch" });
      await guest.take("duel");
      guest.send({ type: "rematch" });

      // The one left over. A rematch keeps the dealt list rather than clearing
      // it, which is what makes `restart`'s "a fresh puzzle" true.
      const again = await host.take("round");
      expect(played).not.toContain(again.puzzle.id);
      expect(pinned.map((puzzle) => puzzle.id)).toContain(again.puzzle.id);
    } finally {
      useArchive(archive);
    }
  });

  test("there is nothing to ask for while the match is still on", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    await host.take("round");
    await guest.take("round");

    host.send({ type: "rematch" });
    expect((await host.take("error")).message).toBe("There is no match to play again");

    await guest.settle();
    expect(framesOfType(guest.received, "duel")).toHaveLength(1);
  });
});

describe("a rematch offer outlives neither the players nor the day", () => {
  test("a disconnect while an offer stands kills the offer", async () => {
    const { host, guest } = await hostWinsMatch(1);
    host.send({ type: "rematch" });
    await host.take("duel");
    await guest.take("duel");

    guest.close();
    const dead = await host.take("duel");

    // Whoever is left is told the offer is off rather than being left holding
    // it: nobody can accept it now.
    expect(dead.duel.rematchEndsAt).toBeNull();
    expect(playerIn(dead.duel, guest.id).connected).toBe(false);
    expect(playerIn(dead.duel, host.id).wantsRematch).toBe(false);
    // The match ended once, and it ended when it ended.
    expect(framesOfType(host.received, "matchOver")).toHaveLength(1);

    host.send({ type: "rematch" });
    expect((await host.take("error")).message).toBe("There is no match to play again");
    expect(framesOfType(host.received, "round")).toHaveLength(1);
  });

  test("the offer lapses, and the finished duel is swept with it", async () => {
    const { host, guest } = await hostWinsMatch(1);
    host.send({ type: "rematch" });
    await host.take("duel");
    await guest.take("duel");

    // Still inside the window, so nothing is swept and the offer still stands.
    expect(sweepDuels(Date.now())).toBe(0);
    expect(sweepDuels(Date.now() + DUEL_REMATCH_TTL_MS)).toBe(1);

    const gone = await guest.take("duel");
    expect(await host.take("duel")).toEqual(gone);
    expect(gone.duel.rematchEndsAt).toBeNull();

    guest.send({ type: "rematch" });
    expect((await guest.take("error")).message).toBe("There is no match to play again");
  });
});

// ── The host's rules ─────────────────────────────────────────────────────────

describe("the rules of a room are the host's, and only while it is a room", () => {
  /** A difficulty the archive actually has, so a band of it is not empty. */
  const ratedSample = () => {
    const rated = archive.filter(isRushEligible).filter((puzzle) => puzzle.difficulty > 0);
    const difficulty = rated[0]!.difficulty;
    return { difficulty, matching: rated.filter((p) => p.difficulty === difficulty) };
  };

  test("a rule the host changes reaches the guest too", async () => {
    const { host, guest } = await lobby(puzzleDuel(3));
    host.send({
      type: "configure",
      settings: { ...puzzleDuel(5), minDifficulty: 4, maxDifficulty: 9 },
    });
    const mine = await host.take("duel");
    expect(mine.duel.settings.rounds).toBe(5);
    expect(mine.duel.settings.minDifficulty).toBe(4);
    // The guest is not told the rules changed, they are told what the rules
    // are — the same frame, so the two sides cannot hold different ones.
    const theirs = await guest.take("duel");
    expect(theirs.duel.settings).toEqual(mine.duel.settings);
  });

  test("a guest cannot set them", async () => {
    const { guest } = await lobby(puzzleDuel(3));
    guest.send({ type: "configure", settings: puzzleDuel(7) });
    expect((await guest.take("error")).message).toBe("Only the host sets the rules");
  });

  test("not even the host can set them once the match is on", async () => {
    // Otherwise a host losing a best-of could shorten it to a best-of-one they
    // have already won, or widen the band the next round is drawn from.
    const { host } = await playPuzzleDuel(3);
    await host.take("round");
    host.send({ type: "configure", settings: puzzleDuel(7) });
    expect((await host.take("error")).message).toBe("It has already started");
  });

  test("a band no puzzle answers is refused, and nothing half-applies", async () => {
    const { difficulty, matching } = ratedSample();
    useArchive(matching);
    try {
      const { host } = await lobby({ ...puzzleDuel(3), minDifficulty: difficulty, maxDifficulty: difficulty });
      const elsewhere = difficulty === MAX_DIFFICULTY ? MIN_DIFFICULTY : MAX_DIFFICULTY;
      host.send({
        type: "configure",
        settings: {
          ...puzzleDuel(7),
          minDifficulty: elsewhere,
          maxDifficulty: elsewhere,
          includeUnrated: false,
        },
      });
      expect((await host.take("error")).message).toBe(
        "No puzzle in the archive matches those rules",
      );

      // The refused frame carried a new round count as well as the bad band.
      // If any of it had landed, this next view would show 7.
      host.send({ type: "configure", settings: { ...puzzleDuel(1), minDifficulty: difficulty, maxDifficulty: difficulty } });
      const after = await host.take("duel");
      expect(after.duel.settings.rounds).toBe(1);
      expect(after.duel.settings.minDifficulty).toBe(difficulty);
    } finally {
      useArchive(archive);
    }
  });

  /** A rating the archive has too few of to fill a match. */
  const scarceBand = () => {
    const rated = archive.filter(isRushEligible).filter((puzzle) => puzzle.difficulty > 0);
    const counts = new Map<number, number>();
    for (const puzzle of rated) {
      counts.set(puzzle.difficulty, (counts.get(puzzle.difficulty) ?? 0) + 1);
    }
    const scarce = [...counts.entries()].find(([, n]) => n < DUEL_MIN_POOL);
    if (!scarce) throw new Error("no rating in the archive is scarce enough for this test");
    return { difficulty: scarce[0], count: scarce[1] };
  };

  test("a band the match would run out of is refused, not dealt twice", async () => {
    // The whole point of the gate. A best-of-7 drawn from one puzzle deals that
    // puzzle seven times, and the log that solved it the first time solves it
    // every time — the match is won in six socket frames without playing.
    const { difficulty } = scarceBand();
    const host = await connect("alice", GUILD);
    await host.take("welcome");
    host.send({
      type: "open",
      settings: {
        ...puzzleDuel(7),
        minDifficulty: difficulty,
        maxDifficulty: difficulty,
        includeUnrated: false,
      },
    });
    const refusal = (await host.take("error")).message;
    expect(refusal).toContain("puzzles and leave");
    expect(refusal).toContain(String(DUEL_MIN_POOL));
  });

  test("a rush clock the band cannot fill is refused", async () => {
    // A stack shorter than the clock is not a shorter rush, it is a rush that
    // ends early and leaves both players staring at a running timer.
    const { difficulty } = scarceBand();
    const host = await connect("alice", GUILD);
    await host.take("welcome");
    host.send({
      type: "open",
      settings: {
        ...rushDuel(),
        durationMs: DUEL_RUSH_MS_MAX,
        minDifficulty: difficulty,
        maxDifficulty: difficulty,
        includeUnrated: false,
      },
    });
    expect((await host.take("error")).message).toContain("puzzles and leave");
  });

  test("the view says what the rules need as well as what they leave", async () => {
    const { host } = await lobby(puzzleDuel(3));
    const seen = framesOfType(host.received, "duel");
    const last = seen[seen.length - 1]!.duel;
    expect(last.poolNeeded).toBe(DUEL_MIN_POOL);
    expect(last.poolSize).toBeGreaterThanOrEqual(last.poolNeeded);
  });

  test("the pool count is the referee's, counted off what it deals", async () => {
    const { difficulty, matching } = ratedSample();
    const { host } = await lobby({
      ...puzzleDuel(3),
      minDifficulty: difficulty,
      maxDifficulty: difficulty,
      includeUnrated: false,
    });
    const seen = framesOfType(host.received, "duel");
    expect(seen[seen.length - 1]!.duel.poolSize).toBe(matching.length);
  });

  test("rounds are dealt from inside the band and nowhere else", async () => {
    const { difficulty } = ratedSample();
    const { host } = await lobby({
      ...puzzleDuel(3),
      minDifficulty: difficulty,
      maxDifficulty: difficulty,
      includeUnrated: false,
    });
    host.send({ type: "ready" });
    const round = await host.take("round");
    const dealt = archive.find((puzzle) => puzzle.id === round.puzzle.id);
    expect(dealt?.difficulty).toBe(difficulty);
  });
});

// ── The pause between rounds ─────────────────────────────────────────────────

describe("a puzzle duel rests between rounds", () => {
  test("the round that ended hands both players its solution", async () => {
    // The loser especially: it is the only look they get at a puzzle that just
    // beat them, and it costs nothing, because a duel never deals a puzzle it
    // has already dealt.
    const { host, guest } = await playPuzzleDuel(3);
    const round = await host.take("round");
    await guest.take("round");
    claim(host, round);

    const won = await host.take("roundOver");
    const lost = await guest.take("roundOver");
    expect(won.solution).not.toBeNull();
    expect(won.solution!.length).toBeGreaterThan(0);
    expect(lost.solution).toEqual(won.solution);
    expect(won.nextRoundAt).toBeGreaterThan(Date.now() - 1);
  });

  test("the last round of a match has nothing to wait for", async () => {
    const { host } = await hostWinsMatch(1);
    const overs = framesOfType(host.received, "roundOver");
    expect(overs[overs.length - 1]!.nextRoundAt).toBeNull();
  });

  test("the next round is not dealt until the pause is over", async () => {
    useIntermission(250);
    try {
      const { host, guest } = await playPuzzleDuel(3);
      const round = await host.take("round");
      await guest.take("round");
      claim(host, round);
      await host.take("roundOver");
      const waitedFrom = Date.now();
      await host.take("round");
      // Generous on the low side: this is asserting that a pause happened at
      // all, not that a timer is accurate to the millisecond.
      expect(Date.now() - waitedFrom).toBeGreaterThanOrEqual(150);
    } finally {
      useIntermission(1);
    }
  });

  test("a claim sent during the pause is turned down, not swallowed", async () => {
    useIntermission(250);
    try {
      const { host, guest } = await playPuzzleDuel(3);
      const round = await host.take("round");
      await guest.take("round");
      claim(host, round);
      await host.take("roundOver");
      await guest.take("roundOver");

      // The loser, finishing a moment late into a duel that has no round on.
      claim(guest, round);
      expect((await guest.take("error")).message).toBe("That round is over");
    } finally {
      useIntermission(1);
    }
  });

  test("a rush has no pause to have — it is one clock", async () => {
    const { host } = await lobby(rushDuel());
    host.send({ type: "ready" });
    await host.take("rush");
    expect(framesOfType(host.received, "roundOver")).toHaveLength(0);
  });
});
