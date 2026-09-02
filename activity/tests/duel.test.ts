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
  DUEL_REMATCH_TTL_MS,
  DUEL_ROUND_MS_MIN,
  DUEL_RUSH_MS_MIN,
  type DuelCommand,
  type DuelEvent,
  type DuelPlayerView,
  type DuelProgress,
  type DuelSettings,
  type DuelView,
  roundsToWin,
} from "../shared/duel";
import {
  decodeBoard,
  ENGINE_ROWS,
  pieceBudget,
  type Puzzle,
  type PuzzlePrompt,
} from "../shared/puzzle";
import { RUSH_SKIPS } from "../shared/rush";
import { createPuzzleEngine, toLetter } from "../shared/tetris/engine";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { findPaths } from "../shared/tetris/pathfinder";
import type { GameKey, InputEvent } from "../shared/tetris/verify";

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
let resetDuels: DuelModule["resetDuels"];
/** Called with a time rather than waited for: the offer's TTL is two minutes. */
let sweepDuels: DuelModule["sweepDuels"];

beforeAll(async () => {
  process.env.DATABASE_PATH = DATABASE;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  const entry = (await import("../server/index")).default;
  ({ mintSession } = await import("../server/auth"));
  ({ resetDuels, sweepDuels } = await import("../server/duel"));
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
  mode: "puzzle",
  rounds,
  durationMs: DUEL_ROUND_MS_MIN,
});

const rushDuel = (): DuelSettings => ({ mode: "rush", rounds: 1, durationMs: DUEL_RUSH_MS_MIN });

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

function claim(player: Duellist, prompt: PuzzlePrompt): void {
  player.send({ type: "claim", events: solvingLog(answerFor(prompt)) });
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
});

describe("a round is won by a log that solves it", () => {
  test("a claim that does not solve it is refused, and takes no round", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    await host.take("round");
    await guest.take("round");

    host.send({ type: "claim", events: [] });
    expect((await host.take("error")).message).toBe("That log does not solve this round");

    // Settled after the claim was answered, so a round it had somehow taken
    // would already be sitting in both inboxes.
    await guest.settle();
    expect(framesOfType(host.received, "roundOver")).toHaveLength(0);
    expect(framesOfType(guest.received, "roundOver")).toHaveLength(0);
  });

  test("a claim that solves it takes the round, and both are told", async () => {
    const { host, guest } = await playPuzzleDuel(3);
    const round = await host.take("round");
    await guest.take("round");

    claim(host, round.puzzle);
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

      jest.advanceTimersByTime(DUEL_ROUND_MS_MIN + 1);

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
      claim(host, round.puzzle);
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
    host.send({ type: "claim", events });
    guest.send({ type: "claim", events });

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

    // One claim, one round — unless the draw served the same puzzle twice, in
    // which case the loser's log really is the answer to round two and taking
    // it is a second win rather than the same win counted twice.
    const decided = second.puzzle.id === first.puzzle.id ? 2 : 1;
    expect(framesOfType(host.received, "roundOver")).toHaveLength(decided);
    expect(framesOfType(guest.received, "roundOver")).toHaveLength(decided);
    if (decided > 1) return;

    // And the losing claim was refused by the referee rather than dropped on
    // the way in, which is what makes the count above worth anything: it was
    // read, against the round that had already started, and turned down there.
    const refused = "That log does not solve this round";
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
  player.send({ type: "claim", events: solvingLog(answerFor(frame.puzzle)) });
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
    host.send({ type: "claim", events: solvingLog(answerFor(first.puzzle)) });
    expect((await host.take("error")).message).toBe("That log does not solve this puzzle");

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

      jest.advanceTimersByTime(DUEL_RUSH_MS_MIN + 1);

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

      jest.advanceTimersByTime(DUEL_RUSH_MS_MIN + 1);

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

/** Plays a best-of-`rounds` match out, the host taking every round of it. */
async function hostWinsMatch(rounds: number): Promise<Lobby> {
  const seats = await playPuzzleDuel(rounds);
  for (let won = 0; won < roundsToWin(rounds); won++) {
    const round = await seats.host.take("round");
    await seats.guest.take("round");
    claim(seats.host, round.puzzle);
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
    claim(guest, forHost.puzzle);
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

      jest.advanceTimersByTime(DUEL_RUSH_MS_MIN + 1);
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
