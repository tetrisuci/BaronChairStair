/**
 * What the duel registry does when the process is going away, over real
 * sockets.
 *
 * A handover (`SIGHUP`) has a newer process already listening on the same
 * port, so a player who is not in a match loses nothing by reopening: their
 * socket is closed with 1012 "handover" and the client opens it again — on the
 * new process. A match in progress is kept to its end, because nothing can move
 * it, and is not offered a rematch on a process that is leaving. A stop
 * (`SIGINT`/`SIGTERM`) ends everything with 1012 "restart", and ends a match
 * without handing anybody a win they did not earn.
 *
 * Driven through the real entrypoint on a real port, the way
 * `tests/duel.test.ts` is, with `resetDuels()` standing in for a restart
 * between cases.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DUEL_SETTINGS, DUEL_ROUND_MS_MIN, type DuelSettings } from "../shared/duel";
import type { PuzzlePrompt } from "../shared/puzzle";
import { SERVER_GOING_AWAY } from "../shared/runtime-status";
import { archive, hasSolutions } from "./archive";
import { type DuelSocket, openDuelSocket } from "./duel-socket";
import { solvingLog } from "./solving-log";

/**
 * The database every server-importing test file names — see the long note in
 * `tests/duel.test.ts`: whichever file imports `server/` first settles the
 * configuration for the whole run, so all of them ask for the same thing.
 */
const DATABASE = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);

type AuthModule = typeof import("../server/auth");
type DuelModule = typeof import("../server/duel");

let server: ReturnType<typeof Bun.serve>;
let socketBase: string;
let mintSession: AuthModule["mintSession"];
let duels: Pick<DuelModule, "closeEveryDuel" | "drainDuels" | "duelCounts" | "resetDuels" | "useIntermission">;

beforeAll(async () => {
  process.env.DATABASE_PATH = DATABASE;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  const { entrypoint } = await import("../server/index");
  ({ mintSession } = await import("../server/auth"));
  duels = await import("../server/duel");
  duels.useIntermission(1);
  server = Bun.serve({ ...entrypoint, port: 0 });
  socketBase = `ws://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

interface Player extends DuelSocket {
  readonly id: string;
}

const live: DuelSocket[] = [];
let minted = 0;

/** A socket for a player of its own, so no two cases share a seat. */
function connect(name: string): Promise<Player> {
  return connectAs(`${name}-${++minted}`, name);
}

/** A socket for this player: a second one for the same id is a second tab. */
async function connectAs(id: string, name: string): Promise<Player> {
  const { token } = await mintSession({ id, username: name, avatarUrl: null }, "drain-guild");
  const socket = await openDuelSocket(`${socketBase}/api/duel?token=${encodeURIComponent(token)}`, id);
  live.push(socket);
  return { ...socket, id };
}

afterEach(() => {
  for (const socket of live.splice(0)) socket.close();
  duels.resetDuels();
});

const oneRound: DuelSettings = {
  ...DEFAULT_DUEL_SETTINGS,
  mode: "puzzle",
  rounds: 1,
  durationMs: DUEL_ROUND_MS_MIN,
};

/** Two players seated, the host's lobby open, the guest joined. */
async function seated(settings: DuelSettings = oneRound) {
  const host = await connect("host");
  const guest = await connect("guest");
  await host.take("welcome");
  await guest.take("welcome");
  host.send({ type: "open", settings });
  const { duel } = await host.take("duel");
  guest.send({ type: "join", duelId: duel.id });
  await host.take("duel");
  await guest.take("duel");
  return { host, guest };
}

/** A match under way: the first round has been dealt to both. */
async function inMatch() {
  const seats = await seated();
  seats.host.send({ type: "ready" });
  const round = await seats.host.take("round");
  await seats.guest.take("round");
  return { ...seats, round };
}

/** A player with a lobby of their own and nobody in it. */
async function alone() {
  const player = await connect("waiting");
  await player.take("welcome");
  player.send({ type: "open", settings: oneRound });
  await player.take("duel");
  return player;
}

const handover = { code: SERVER_GOING_AWAY.code, reason: SERVER_GOING_AWAY.handover };
const restart = { code: SERVER_GOING_AWAY.code, reason: SERVER_GOING_AWAY.restart };

/** Whatever the socket was told last before it closed: the notice an old client shows. */
function lastNotice(player: Player): string | undefined {
  const last = player.received.at(-1);
  return last?.type === "error" ? last.message : undefined;
}

/** The archived answer for a round, for a claim the referee will accept. */
function answerFor(prompt: PuzzlePrompt) {
  const puzzle = archive.find((entry) => entry.id === prompt.id);
  if (!puzzle) throw new Error(`puzzle ${prompt.id} is not in the archive`);
  return puzzle;
}

describe("a handover", () => {
  test("counts what it would cut short: matches under way and lobbies open", async () => {
    await inMatch();
    await alone();
    expect(duels.duelCounts()).toEqual({ duelsInMatch: 1, lobbies: 1 });
  });

  test("sends a lobby away with 1012 handover, after a notice an old client can show", async () => {
    const waiting = await alone();
    const browsing = await connect("browsing");
    await browsing.take("welcome");

    duels.drainDuels();

    expect(await waiting.closed).toEqual(handover);
    expect(await browsing.closed).toEqual(handover);
    expect(lastNotice(waiting)).toMatch(/open duel again/i);
    // Closed, not forfeited: nobody was told a match was lost.
    expect(waiting.received.some((event) => event.type === "matchOver")).toBe(false);
    expect(duels.duelCounts()).toEqual({ duelsInMatch: 0, lobbies: 0 });
  });

  test("closes a guest's lobby without a forfeit going round first", async () => {
    const { host, guest } = await seated();
    duels.drainDuels();
    expect(await host.closed).toEqual(handover);
    expect(await guest.closed).toEqual(handover);
    expect(guest.received.some((event) => event.type === "matchOver")).toBe(false);
  });

  test("keeps a match in progress, and both players can still reach each other", async () => {
    const { host, guest } = await inMatch();
    duels.drainDuels();

    host.send({
      type: "progress",
      progress: { piecesPlaced: 1, pieceBudget: 5, attack: 0, targetAttack: 4, solved: 0 },
    });
    await guest.take("opponent");
    expect(host.isOpen() && guest.isOpen()).toBe(true);
    expect(duels.duelCounts()).toEqual({ duelsInMatch: 1, lobbies: 0 });
  });

  test("once the match ends, offers no rematch and sends both players away", async () => {
    const { host, guest } = await inMatch();
    duels.drainDuels();

    host.send({ type: "leave" });
    const over = await guest.take("matchOver");
    expect(over.reason).toBe("forfeit");
    expect(over.duel.rematchEndsAt).toBeNull();
    expect(await guest.closed).toEqual(handover);
    expect(await host.closed).toEqual(handover);
    expect(duels.duelCounts()).toEqual({ duelsInMatch: 0, lobbies: 0 });
  });

  // The lifecycle refuses an upgrade that arrives once the drain has begun,
  // but one that arrived a moment earlier is still verifying its token when
  // the drain runs, and is upgraded after it. Calling `drainDuels` directly,
  // with the lifecycle still serving, is exactly that moment.
  test("sends away a socket that opens after the drain began, without a welcome", async () => {
    duels.drainDuels();

    const late = await connect("late");

    expect(await late.closed).toEqual(handover);
    expect(lastNotice(late)).toMatch(/open duel again/i);
    // No lobby list from a process nobody should be opening a lobby on.
    expect(late.received.some((event) => event.type === "welcome")).toBe(false);
  });

  test("a second tab that reaches the leaving process does not cut the first one's match short", async () => {
    const { host, guest } = await inMatch();
    duels.drainDuels();

    const secondTab = await connectAs(host.id, "host");

    expect(await secondTab.closed).toEqual(handover);
    host.send({
      type: "progress",
      progress: { piecesPlaced: 1, pieceBudget: 5, attack: 0, targetAttack: 4, solved: 0 },
    });
    await guest.take("opponent");
    expect(host.isOpen() && guest.isOpen()).toBe(true);
    expect(guest.received.some((event) => event.type === "matchOver")).toBe(false);
  });

  test.skipIf(!hasSolutions)("a match won while handing over is not offered again", async () => {
    const { host, guest, round } = await inMatch();
    duels.drainDuels();

    host.send({ type: "claim", position: round.round, events: solvingLog(answerFor(round.puzzle)) });
    const over = await guest.take("matchOver");
    expect(over.winnerId).toBe(host.id);
    // Both still seated, which would ordinarily hold the pair for a rematch.
    expect(over.duel.rematchEndsAt).toBeNull();
    expect(await host.closed).toEqual(handover);
    expect(await guest.closed).toEqual(handover);
  });
});

describe("a stop", () => {
  test("closes every socket with 1012 restart and ends a match without a winner", async () => {
    const { host, guest } = await inMatch();
    const waiting = await alone();

    duels.closeEveryDuel();

    expect(await host.closed).toEqual(restart);
    expect(await guest.closed).toEqual(restart);
    expect(await waiting.closed).toEqual(restart);
    // A restart is nobody's forfeit: the one left last must not be told they won.
    expect(guest.received.some((event) => event.type === "matchOver")).toBe(false);
    expect(host.received.some((event) => event.type === "matchOver")).toBe(false);
    expect(lastNotice(guest)).toMatch(/restarting/i);
    expect(duels.duelCounts()).toEqual({ duelsInMatch: 0, lobbies: 0 });
  });

  test("sends away with 1012 restart a socket that opens after the rest were closed", async () => {
    duels.closeEveryDuel();

    const late = await connect("late");

    expect(await late.closed).toEqual(restart);
    expect(late.received.some((event) => event.type === "welcome")).toBe(false);
  });

  test("after a handover, ends the matches that were still being played", async () => {
    const { host, guest } = await inMatch();
    duels.drainDuels();
    duels.closeEveryDuel();
    expect(await host.closed).toEqual(restart);
    expect(await guest.closed).toEqual(restart);
  });
});
