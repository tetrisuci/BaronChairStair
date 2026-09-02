/**
 * 1v1 duels: the socket, the registry, and the referee.
 *
 * Three things here are load-bearing and easy to undo by accident.
 *
 * **The claim path must not await.** A round is won by whoever's claim arrives
 * first, and `verifyRun` is synchronous, so reading a claim and awarding the
 * point happen in one block the event loop cannot interleave. That is the
 * whole race resolution: no lock, no timestamp comparison, no trust in either
 * client's clock. One `await` between reading `round.winnerId` and setting it
 * — a signature check, a database write, anything — lets two claims in the
 * same tick both through. {@link awardClaim} says so where it matters, and
 * {@link awardRushClaim} carries the rule for the same reason.
 *
 * **Identity is resolved at the handshake, never from a message.** A frame
 * carries no id and is never asked for one; the socket knows who it belongs to
 * because the upgrade did.
 *
 * **Frames are unpoliced by everything else.** `limitBodySize`, all five rate
 * limiters and `maxRequestBodySize` are Hono HTTP middleware, and a WebSocket
 * frame meets none of them. Every bound a duel gets, it gets here.
 *
 * Two modes share all of it. A puzzle duel is rounds: one puzzle, both players,
 * first to solve takes the round. A rush is one clock over one shared stack of
 * puzzles that each player walks alone — see {@link RushMatch}.
 *
 * The registry is in memory, which makes it the first server state in this
 * codebase a restart destroys. That is unavoidable — a duel is two people
 * rendezvoused live, which SQLite cannot reconstruct — but it does mean a
 * deploy ends every match in flight.
 */

import type { Server, ServerWebSocket } from "bun";

/** Bun's server, typed with the data this module attaches to each socket. */
type DuelServer = Server<SocketData>;
import type { PlayerProfile } from "./db";
import { type Session, readSession } from "./auth";
import {
  DUEL_CLAIM_GRACE_MS,
  DUEL_LOBBY_TTL_MS,
  DUEL_PLAYERS,
  type DuelCommand,
  type DuelEvent,
  type DuelProgress,
  type DuelSettings,
  type DuelView,
  type RoundEnd,
  roundsToWin,
  rushDuelLength,
  sanitizeSettings,
} from "../shared/duel";
import { decodeBoard, ENGINE_ROWS, meetsTarget, type Puzzle, toPrompt } from "../shared/puzzle";
import { isRushEligible, RUSH_SKIPS, rushSequence } from "../shared/rush";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { InvalidRunError, parseInputLog, verifyRun } from "../shared/tetris/verify";

/** Frames larger than this never reach a handler. */
export const MAX_FRAME_BYTES = 64 * 1024;

/**
 * Bun pings a quiet socket at half this and closes at exactly this when no pong
 * comes back, so this value *is* the disconnect detector. Bun's own default is
 * two minutes, which would start a forfeit long after anybody cared.
 */
export const IDLE_TIMEOUT_S = 10;

/** Messages one socket may send inside {@link RATE_WINDOW_MS}. */
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 10_000;

/** Lobbies one player may have open at once. */
const MAX_OPEN_PER_PLAYER = 3;

/** How many lobbies a welcome lists. */
const LOBBY_LIST_SIZE = 20;

interface Seat {
  readonly player: PlayerProfile;
  socket: ServerWebSocket<SocketData> | null;
  /** Rounds won in a puzzle duel, puzzles solved in a rush. */
  score: number;
  /** Progress as last reported. Cosmetic; never trusted for anything. */
  progress: DuelProgress | null;
  /** Rush only: how far into the shared stack this player has got. */
  position: number;
  /** Rush only: skips still in hand. Dealt when the match starts. */
  skipsLeft: number;
}

function takeSeat(player: PlayerProfile, socket: ServerWebSocket<SocketData>): Seat {
  return { player, socket, score: 0, progress: null, position: 0, skipsLeft: 0 };
}

interface Round {
  readonly index: number;
  readonly puzzle: Puzzle;
  readonly endsAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set the instant a claim verifies, so a later one cannot take the round. */
  winnerId: string | null;
}

interface Duel {
  readonly id: string;
  readonly guildId: string | null;
  readonly settings: DuelSettings;
  readonly hostId: string;
  readonly createdAt: number;
  phase: "lobby" | "playing" | "over";
  seats: Seat[];
  /** Set for a puzzle duel only; a rush has no rounds. */
  round: Round | null;
  /** Set for a rush only; a puzzle duel has no shared stack. */
  rush: RushMatch | null;
  roundsPlayed: number;
}

export interface SocketData {
  readonly session: Session;
  duelId: string | null;
  /** Fixed-window message counter; see {@link RATE_LIMIT}. */
  windowStartedAt: number;
  windowCount: number;
}

const duels = new Map<string, Duel>();
const socketsByPlayer = new Map<string, ServerWebSocket<SocketData>>();

/** Set once at startup, so this module does not load the archive itself. */
let puzzlePool: readonly Puzzle[] = [];

export function useArchive(puzzles: readonly Puzzle[]): void {
  // Only puzzles short enough to lose a round to. The archive's longest runs to
  // seventy-four pieces, which is not a round, it is an evening.
  puzzlePool = puzzles.filter(isRushEligible);
}

// ── Views ────────────────────────────────────────────────────────────────────

function view(duel: Duel): DuelView {
  return {
    id: duel.id,
    phase: duel.phase,
    settings: duel.settings,
    hostId: duel.hostId,
    round: duel.round?.index ?? 0,
    players: duel.seats.map((seat) => ({
      id: seat.player.id,
      username: seat.player.username,
      avatarUrl: seat.player.avatarUrl,
      connected: seat.socket !== null,
      score: seat.score,
    })),
  };
}

function send(socket: ServerWebSocket<SocketData> | null, event: DuelEvent): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(event));
}

function broadcast(duel: Duel, event: DuelEvent): void {
  for (const seat of duel.seats) send(seat.socket, event);
}

function seatOf(duel: Duel, playerId: string): Seat | undefined {
  return duel.seats.find((seat) => seat.player.id === playerId);
}

function opponentOf(duel: Duel, playerId: string): Seat | undefined {
  return duel.seats.find((seat) => seat.player.id !== playerId);
}

/** Lobbies a player could join: open, in their server, not already theirs. */
function openLobbies(session: Session): DuelView[] {
  const out: DuelView[] = [];
  for (const duel of duels.values()) {
    if (duel.phase !== "lobby" || duel.seats.length >= DUEL_PLAYERS) continue;
    // A lobby belongs to a server. Without this every guild sees every other
    // guild's lobbies, which is both a leak and a nonsense.
    if (duel.guildId !== session.guildId) continue;
    if (seatOf(duel, session.player.id)) continue;
    out.push(view(duel));
    if (out.length >= LOBBY_LIST_SIZE) break;
  }
  return out;
}

// ── Rounds ───────────────────────────────────────────────────────────────────

function pickPuzzle(): Puzzle {
  // Chosen here, and the prompt travels in the round message, so there is no
  // seed a client could derive the coming puzzles from ahead of time.
  return puzzlePool[Math.floor(Math.random() * puzzlePool.length)]!;
}

function startRound(duel: Duel): void {
  const puzzle = pickPuzzle();
  const endsAt = Date.now() + duel.settings.durationMs;
  const round: Round = { index: duel.roundsPlayed + 1, puzzle, endsAt, timer: null, winnerId: null };
  duel.round = round;
  duel.phase = "playing";
  for (const seat of duel.seats) seat.progress = null;

  round.timer = setTimeout(() => endRound(duel, null, "expired"), duel.settings.durationMs);
  broadcast(duel, {
    type: "round",
    round: round.index,
    puzzle: toPrompt(puzzle),
    endsAt,
    duel: view(duel),
  });
}

function endRound(duel: Duel, winnerId: string | null, reason: RoundEnd): void {
  const round = duel.round;
  if (!round) return;
  if (round.timer) clearTimeout(round.timer);
  round.timer = null;
  duel.round = null;
  duel.roundsPlayed++;

  if (winnerId) {
    const seat = seatOf(duel, winnerId);
    if (seat) seat.score++;
  }
  broadcast(duel, { type: "roundOver", round: round.index, winnerId, reason, duel: view(duel) });

  const needed = roundsToWin(duel.settings.rounds);
  const decided = duel.seats.find((seat) => seat.score >= needed);
  if (decided || duel.roundsPlayed >= duel.settings.rounds) {
    finish(duel, decided?.player.id ?? null, reason);
    return;
  }
  startRound(duel);
}

function finish(duel: Duel, winnerId: string | null, reason: RoundEnd): void {
  duel.phase = "over";
  if (duel.round?.timer) clearTimeout(duel.round.timer);
  if (duel.rush?.timer) clearTimeout(duel.rush.timer);
  duel.round = null;
  duel.rush = null;
  broadcast(duel, { type: "matchOver", winnerId, reason, duel: view(duel) });
  duels.delete(duel.id);
  for (const seat of duel.seats) {
    if (seat.socket) seat.socket.data.duelId = null;
  }
}

/**
 * Reads a claim and, if it really solves the round, awards it.
 *
 * Nothing in here may await. `verifyRun` is synchronous, so this runs inside
 * one turn of the event loop and two claims arriving in the same tick are
 * decided by the order the socket delivered them — the only ordering either
 * player can be held to. An `await` between reading `round.winnerId` and
 * setting it lets both through, and no test or type will notice.
 */
function awardClaim(duel: Duel, playerId: string, rawEvents: unknown): void {
  const round = duel.round;
  if (!round || round.winnerId !== null) return;
  // Admitted late, never reordered: the check above means a claim inside the
  // grace can never take a round the opponent has already won.
  if (Date.now() > round.endsAt + DUEL_CLAIM_GRACE_MS) return;

  const verified = verifyRun(
    {
      board: decodeBoard(round.puzzle.board, ENGINE_ROWS),
      queue: round.puzzle.queue,
      hold: round.puzzle.hold,
    },
    DEFAULT_HANDLING,
    parseInputLog(rawEvents),
  );
  if (!meetsTarget(verified.attack, round.puzzle.targetAttack)) {
    throw new InvalidRunError("That log does not solve this round");
  }

  round.winnerId = playerId;
  endRound(duel, playerId, "solved");
}

// ── Rush ─────────────────────────────────────────────────────────────────────

/**
 * A rush duel: one stack of puzzles, one clock, two players moving through it
 * at their own pace.
 *
 * The stack is derived from a seed this process picks and never sends, and
 * puzzles leave it one at a time, so neither player can see what is coming —
 * the same property {@link pickPuzzle} gets from choosing late. Deriving it
 * with `rushSequence` is also what makes "the same puzzles for both" a fact
 * rather than an intention: there is one array, and two positions into it.
 */
interface RushMatch {
  readonly sequence: readonly Puzzle[];
  /** One deadline for the whole match. A rush has no per-puzzle clock. */
  readonly endsAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

function startRushMatch(duel: Duel): void {
  const seed = (Math.random() * 0x1_0000_0000) >>> 0;
  const rush: RushMatch = {
    sequence: rushSequence(puzzlePool, seed, rushDuelLength(duel.settings.durationMs)),
    endsAt: Date.now() + duel.settings.durationMs,
    timer: null,
  };
  duel.rush = rush;
  duel.phase = "playing";
  for (const seat of duel.seats) {
    seat.progress = null;
    seat.position = 0;
    seat.skipsLeft = RUSH_SKIPS;
  }

  rush.timer = setTimeout(() => endRushMatch(duel), duel.settings.durationMs);
  // Sent one seat at a time, not broadcast: from the second solve onwards the
  // two are on different puzzles, and this is the message that says which.
  for (const seat of duel.seats) sendRushPuzzle(duel, seat);
}

/** The puzzle this player is on, addressed to them and to nobody else. */
function sendRushPuzzle(duel: Duel, seat: Seat): void {
  const rush = duel.rush;
  if (!rush) return;
  const puzzle = rush.sequence[seat.position];
  send(seat.socket, {
    type: "rush",
    index: seat.position,
    // Null rather than an ending: the stack is spent but the clock is not, and
    // the opponent can still be catching up.
    puzzle: puzzle ? toPrompt(puzzle) : null,
    endsAt: rush.endsAt,
    solved: seat.score,
    skipsLeft: seat.skipsLeft,
    duel: view(duel),
  });
}

function advanceRush(duel: Duel, seat: Seat): void {
  seat.position++;
  seat.progress = null;
  sendRushPuzzle(duel, seat);
}

/**
 * Reads a rush claim against the puzzle that player is on, and moves them on.
 *
 * Nothing in here may await, for {@link awardClaim}'s reason and one of its
 * own: the deadline is checked here and enforced by a timer, so an await
 * between the check and the increment would let a solve be counted after
 * `matchOver` had already gone out with the final score in it.
 *
 * A rush claim never ends the match. Only the clock does.
 */
function awardRushClaim(duel: Duel, seat: Seat, rawEvents: unknown): void {
  const rush = duel.rush;
  if (!rush) return;
  if (Date.now() > rush.endsAt + DUEL_CLAIM_GRACE_MS) return;
  const puzzle = rush.sequence[seat.position];
  if (!puzzle) return;

  const verified = verifyRun(
    {
      board: decodeBoard(puzzle.board, ENGINE_ROWS),
      queue: puzzle.queue,
      hold: puzzle.hold,
    },
    DEFAULT_HANDLING,
    parseInputLog(rawEvents),
  );
  if (!meetsTarget(verified.attack, puzzle.targetAttack)) {
    throw new InvalidRunError("That log does not solve this puzzle");
  }

  seat.score++;
  advanceRush(duel, seat);
  // The opponent is owed the score and nothing more. Which puzzle this player
  // reached would tell them what is coming, and their board is never sent.
  send(opponentOf(duel, seat.player.id)?.socket ?? null, { type: "duel", duel: view(duel) });
}

/**
 * Gives up on a puzzle and takes the next one.
 *
 * Bounded, because it is the only way off a puzzle a player cannot see the
 * answer to, and unbounded it would be a way to riffle the stack for the easy
 * ones. {@link RUSH_SKIPS} is the same allowance a single-player rush gives,
 * for the same reason.
 */
function skipRushPuzzle(duel: Duel, seat: Seat): void {
  const rush = duel.rush;
  if (!rush || seat.position >= rush.sequence.length) return;
  if (seat.skipsLeft <= 0) throw new InvalidRunError(`A rush allows ${RUSH_SKIPS} skips`);
  seat.skipsLeft--;
  advanceRush(duel, seat);
}

/** Most solves takes it; equal counts is a draw. */
function rushLeader(duel: Duel): string | null {
  const [first, second] = [...duel.seats].sort((a, b) => b.score - a.score);
  if (!first) return null;
  return second && second.score === first.score ? null : first.player.id;
}

function endRushMatch(duel: Duel): void {
  finish(duel, rushLeader(duel), "expired");
}

// ── Commands ─────────────────────────────────────────────────────────────────

function handle(socket: ServerWebSocket<SocketData>, command: DuelCommand): void {
  const { session } = socket.data;
  const current = socket.data.duelId ? duels.get(socket.data.duelId) : undefined;

  switch (command.type) {
    case "open": {
      if (current) throw new InvalidRunError("You are already in a duel");
      const mine = [...duels.values()].filter((duel) => duel.hostId === session.player.id);
      if (mine.length >= MAX_OPEN_PER_PLAYER) {
        throw new InvalidRunError("You already have too many lobbies open");
      }
      const duel: Duel = {
        id: crypto.randomUUID().slice(0, 8),
        guildId: session.guildId,
        settings: sanitizeSettings(command.settings),
        hostId: session.player.id,
        createdAt: Date.now(),
        phase: "lobby",
        seats: [takeSeat(session.player, socket)],
        round: null,
        rush: null,
        roundsPlayed: 0,
      };
      duels.set(duel.id, duel);
      socket.data.duelId = duel.id;
      send(socket, { type: "duel", duel: view(duel) });
      return;
    }

    case "join": {
      if (current) throw new InvalidRunError("You are already in a duel");
      const duel = duels.get(String(command.duelId));
      if (!duel || duel.phase !== "lobby") throw new InvalidRunError("That lobby is gone");
      if (duel.guildId !== session.guildId) throw new InvalidRunError("That lobby is gone");
      if (duel.seats.length >= DUEL_PLAYERS) throw new InvalidRunError("That lobby is full");
      if (seatOf(duel, session.player.id)) throw new InvalidRunError("You are already in it");

      duel.seats.push(takeSeat(session.player, socket));
      socket.data.duelId = duel.id;
      broadcast(duel, { type: "duel", duel: view(duel) });
      return;
    }

    case "ready": {
      if (!current) throw new InvalidRunError("You are not in a duel");
      if (current.hostId !== session.player.id) throw new InvalidRunError("Only the host starts it");
      if (current.phase !== "lobby") throw new InvalidRunError("It has already started");
      if (current.seats.length < DUEL_PLAYERS) throw new InvalidRunError("Nobody has joined yet");
      if (current.settings.mode === "rush") startRushMatch(current);
      else startRound(current);
      return;
    }

    case "claim": {
      if (!current || current.phase !== "playing") return;
      if (current.settings.mode !== "rush") {
        awardClaim(current, session.player.id, command.events);
        return;
      }
      const seat = seatOf(current, session.player.id);
      if (seat) awardRushClaim(current, seat, command.events);
      return;
    }

    case "skip": {
      if (!current || current.phase !== "playing") return;
      if (current.settings.mode !== "rush") return;
      const seat = seatOf(current, session.player.id);
      if (seat) skipRushPuzzle(current, seat);
      return;
    }

    case "progress": {
      if (!current || current.phase !== "playing") return;
      const seat = seatOf(current, session.player.id);
      if (seat) seat.progress = command.progress;
      // How far along, never the board: a board part-way through a puzzle is a
      // partial solution to it, and losing must not come with a hint.
      send(opponentOf(current, session.player.id)?.socket ?? null, {
        type: "opponent",
        progress: command.progress,
      });
      return;
    }

    case "leave": {
      if (current) depart(current, session.player.id);
      socket.data.duelId = null;
      return;
    }
  }
}

/** A player left, on purpose or otherwise. */
function depart(duel: Duel, playerId: string): void {
  if (duel.phase === "lobby") {
    duel.seats = duel.seats.filter((seat) => seat.player.id !== playerId);
    if (duel.seats.length === 0 || duel.hostId === playerId) {
      duels.delete(duel.id);
      broadcast(duel, { type: "matchOver", winnerId: null, reason: "forfeit", duel: view(duel) });
      return;
    }
    broadcast(duel, { type: "duel", duel: view(duel) });
    return;
  }
  // Mid-match, leaving hands the match to whoever stayed. A grace period for a
  // dropped connection is the next slice; until it exists this is correct, just
  // unkind to bad wifi.
  const seat = seatOf(duel, playerId);
  if (seat) seat.socket = null;
  finish(duel, opponentOf(duel, playerId)?.player.id ?? null, "forfeit");
}

// ── The socket ───────────────────────────────────────────────────────────────

function withinRate(socket: ServerWebSocket<SocketData>): boolean {
  const now = Date.now();
  const data = socket.data;
  if (now - data.windowStartedAt > RATE_WINDOW_MS) {
    data.windowStartedAt = now;
    data.windowCount = 0;
  }
  data.windowCount++;
  return data.windowCount <= RATE_LIMIT;
}

export const duelSocket = {
  idleTimeout: IDLE_TIMEOUT_S,
  maxPayloadLength: MAX_FRAME_BYTES,

  open(socket: ServerWebSocket<SocketData>) {
    const playerId = socket.data.session.player.id;
    const previous = socketsByPlayer.get(playerId);
    // One socket per player: a second tab would otherwise hold both seats, or
    // race the first tab's claims.
    if (previous && previous !== socket) previous.close(1000, "Opened elsewhere");
    socketsByPlayer.set(playerId, socket);
    send(socket, { type: "welcome", playerId, open: openLobbies(socket.data.session) });
  },

  message(socket: ServerWebSocket<SocketData>, raw: string | Buffer) {
    if (!withinRate(socket)) {
      socket.close(1008, "Too many messages");
      return;
    }
    try {
      handle(socket, JSON.parse(String(raw)) as DuelCommand);
    } catch (error) {
      // A bad frame is one player's problem. It never ends the match, and it
      // never reaches the other player.
      const message =
        error instanceof InvalidRunError || error instanceof SyntaxError
          ? error.message
          : "That did not work";
      send(socket, { type: "error", message });
    }
  },

  close(socket: ServerWebSocket<SocketData>) {
    const playerId = socket.data.session.player.id;
    if (socketsByPlayer.get(playerId) === socket) socketsByPlayer.delete(playerId);
    const duel = socket.data.duelId ? duels.get(socket.data.duelId) : undefined;
    if (duel) depart(duel, playerId);
  },
};

/**
 * Answers the upgrade, before Hono ever sees the request.
 *
 * It has to happen here rather than in a route. Discord serves the activity
 * under `/.proxy`, and the middleware that strips that prefix re-dispatches
 * through a *copy* of the request — which Bun will not upgrade, because it
 * binds the socket to the object it was handed. Recognising the path here, on
 * the original request, works under either prefix. A second route registered
 * at `/.proxy/api/duel` would not, and would sit outside every rate limiter
 * besides, since `app.use("/api/*")` does not match a proxied path.
 *
 * The token travels as a query parameter because a browser cannot set headers
 * on a WebSocket handshake. It is the same signed session token every other
 * route takes, and `readSession` already accepts a bare string.
 */
export async function openDuelSocket(
  request: Request,
  server: DuelServer | undefined,
  url: URL,
): Promise<Response> {
  if (!server) {
    return Response.json({ error: "Expected a WebSocket upgrade" }, { status: 400 });
  }
  let session: Session;
  try {
    session = await readSession(url.searchParams.get("token") ?? undefined);
  } catch {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  const data: SocketData = { session, duelId: null, windowStartedAt: Date.now(), windowCount: 0 };
  if (server.upgrade(request, { data })) return new Response(null);
  return Response.json({ error: "Expected a WebSocket upgrade" }, { status: 400 });
}

/** Drops lobbies nobody joined. Called on a timer by the server. */
export function sweepLobbies(now = Date.now()): number {
  let swept = 0;
  for (const duel of [...duels.values()]) {
    if (duel.phase !== "lobby" || now - duel.createdAt < DUEL_LOBBY_TTL_MS) continue;
    duels.delete(duel.id);
    broadcast(duel, { type: "matchOver", winnerId: null, reason: "forfeit", duel: view(duel) });
    swept++;
  }
  return swept;
}

/** Test seam: the registry is process-local and otherwise unreachable. */
export function resetDuels(): void {
  for (const duel of duels.values()) {
    if (duel.round?.timer) clearTimeout(duel.round.timer);
    if (duel.rush?.timer) clearTimeout(duel.rush.timer);
  }
  duels.clear();
  socketsByPlayer.clear();
}
