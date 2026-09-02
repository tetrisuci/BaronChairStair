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
 * A finished match is not deleted where it stands. It stays in the registry,
 * phase `over`, for as long as a rematch is worth offering: that window is the
 * whole of the feature, because the pairing it holds — two seats, two sockets
 * and the settings already agreed — is exactly what going back to the lobby
 * list would make the two of them rebuild by hand. {@link sweepDuels} ends it.
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
  DUEL_REMATCH_TTL_MS,
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
import { type Handling, sanitizeHandling } from "../shared/tetris/handling";
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
  /**
   * The handling this seat is judged under, agreed when they sat down.
   *
   * A log is replayed under this, so it has to be the handling the player
   * actually played with — judging a tuned player's log under the defaults
   * fails every one of them. Frozen at seat time so a mid-match change cannot
   * re-judge a round already lost.
   */
  readonly handling: Handling;
  /** Rush only: how far into the shared stack this player has got. */
  position: number;
  /** Rush only: skips still in hand. Dealt when the match starts. */
  skipsLeft: number;
  /** Has asked to play the finished match again. Cleared by every start. */
  wantsRematch: boolean;
}

function takeSeat(
  player: PlayerProfile,
  socket: ServerWebSocket<SocketData>,
  handling: Handling,
): Seat {
  return {
    player,
    socket,
    score: 0,
    progress: null,
    handling,
    position: 0,
    skipsLeft: 0,
    wantsRematch: false,
  };
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
  /**
   * When the match ended, if it ended with a rematch still worth offering.
   *
   * Null covers three different things on purpose — not finished, finished
   * with nobody left to ask, and restarted since — because they all mean the
   * same to everything downstream: there is no offer standing.
   */
  finishedAt: number | null;
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
    rematchEndsAt: duel.finishedAt === null ? null : duel.finishedAt + DUEL_REMATCH_TTL_MS,
    players: duel.seats.map((seat) => ({
      id: seat.player.id,
      username: seat.player.username,
      avatarUrl: seat.player.avatarUrl,
      connected: seat.socket !== null,
      score: seat.score,
      wantsRematch: seat.wantsRematch,
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

/**
 * Ends the match, and keeps the duel for as long as a rematch is plausible.
 *
 * The registry entry outliving the match *is* the rematch: the seats, the
 * settings and both sockets are already here, and hunting each other down in
 * the lobby list again is the thing a rematch exists to avoid. It is kept only
 * when both players are still on the end of a socket — a match that ended
 * because one of them went away has nobody left to offer anything to — and only
 * until {@link sweepDuels} comes for it.
 */
function finish(duel: Duel, winnerId: string | null, reason: RoundEnd): void {
  duel.phase = "over";
  if (duel.round?.timer) clearTimeout(duel.round.timer);
  if (duel.rush?.timer) clearTimeout(duel.rush.timer);
  duel.round = null;
  duel.rush = null;
  for (const seat of duel.seats) seat.wantsRematch = false;
  duel.finishedAt = bothSeated(duel) ? Date.now() : null;
  // Sent after that, so the view inside it already says whether there is
  // anything to ask for.
  broadcast(duel, { type: "matchOver", winnerId, reason, duel: view(duel) });
  if (duel.finishedAt === null) discard(duel);
}

/** Two seats, both still on a socket: everything a rematch needs. */
function bothSeated(duel: Duel): boolean {
  return duel.seats.length === DUEL_PLAYERS && duel.seats.every((seat) => seat.socket !== null);
}

/** Drops a duel from the registry and unpins the sockets that were in it. */
function discard(duel: Duel): void {
  duels.delete(duel.id);
  for (const seat of duel.seats) {
    if (seat.socket) seat.socket.data.duelId = null;
  }
}

/**
 * Takes the offer off the table and drops the duel.
 *
 * Whoever is still here is told with a `duel` view and not a second
 * `matchOver`: the match ended once, and it ended when it ended. What has
 * changed is only that there is nothing left to ask for, which is exactly what
 * a null `rematchEndsAt` says.
 */
function dropRematch(duel: Duel): void {
  duel.finishedAt = null;
  for (const seat of duel.seats) seat.wantsRematch = false;
  broadcast(duel, { type: "duel", duel: view(duel) });
  discard(duel);
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
  // Judged under the handling this player sat down with. Replaying a tuned
  // player's log under the defaults fails every one of them, which is a player
  // who can never win a round rather than a player who was beaten.
  const seat = seatOf(duel, playerId);
  if (!seat) return;
  // Admitted late, never reordered: the check above means a claim inside the
  // grace can never take a round the opponent has already won.
  if (Date.now() > round.endsAt + DUEL_CLAIM_GRACE_MS) return;

  const verified = verifyRun(
    {
      board: decodeBoard(round.puzzle.board, ENGINE_ROWS),
      queue: round.puzzle.queue,
      hold: round.puzzle.hold,
    },
    seat.handling,
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
    seat.handling,
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

// ── Rematches ────────────────────────────────────────────────────────────────

/** Deals the first round, or the whole stack. The one place the modes fork. */
function startMatch(duel: Duel): void {
  if (duel.settings.mode === "rush") startRushMatch(duel);
  else startRound(duel);
}

/** Whether asking to go again would still mean anything. */
function rematchStands(duel: Duel | undefined, now = Date.now()): duel is Duel {
  if (!duel || duel.phase !== "over" || duel.finishedAt === null) return false;
  return now - duel.finishedAt < DUEL_REMATCH_TTL_MS;
}

/** Both of them have asked, and both are still here to play it. */
function bothWantRematch(duel: Duel): boolean {
  return bothSeated(duel) && duel.seats.every((seat) => seat.wantsRematch);
}

/**
 * Notes that a player wants to go again, and starts the match if that was the
 * second of them.
 *
 * An offer, never an order: one player asking changes nothing except what the
 * other is told. That is also why asking twice is asking once — it says "I am
 * willing", which is not a thing that can be said harder.
 */
function offerRematch(duel: Duel, seat: Seat): void {
  if (seat.wantsRematch) return;
  seat.wantsRematch = true;
  // Both ends, always: the asker needs to see their ask land, and the opponent
  // needs to know they are being asked rather than staring at a dead button.
  broadcast(duel, { type: "duel", duel: view(duel) });
  if (bothWantRematch(duel)) restart(duel);
}

/**
 * Plays the finished match again: the same duel, from nothing.
 *
 * The same seats and the settings the host originally chose, because that is
 * what both players just agreed to; a fresh puzzle or a fresh stack, because
 * one already solved is not a match. Progress, positions and skips are dealt
 * out by the start itself, so this only undoes what a match accumulates.
 */
function restart(duel: Duel): void {
  duel.finishedAt = null;
  duel.roundsPlayed = 0;
  for (const seat of duel.seats) {
    seat.score = 0;
    seat.wantsRematch = false;
  }
  startMatch(duel);
}

// ── Commands ─────────────────────────────────────────────────────────────────

function handle(socket: ServerWebSocket<SocketData>, command: DuelCommand): void {
  const { session } = socket.data;
  const current = socket.data.duelId ? duels.get(socket.data.duelId) : undefined;

  switch (command.type) {
    case "open": {
      if (isUnfinished(current)) throw new InvalidRunError("You are already in a duel");
      const mine = [...duels.values()].filter((duel) => duel.hostId === session.player.id);
      if (mine.length >= MAX_OPEN_PER_PLAYER) {
        throw new InvalidRunError("You already have too many lobbies open");
      }
      releaseFinished(socket, current);
      const duel: Duel = {
        id: crypto.randomUUID().slice(0, 8),
        guildId: session.guildId,
        settings: sanitizeSettings(command.settings),
        hostId: session.player.id,
        createdAt: Date.now(),
        phase: "lobby",
        seats: [takeSeat(session.player, socket, sanitizeHandling(command.handling))],
        round: null,
        rush: null,
        roundsPlayed: 0,
        finishedAt: null,
      };
      duels.set(duel.id, duel);
      socket.data.duelId = duel.id;
      send(socket, { type: "duel", duel: view(duel) });
      return;
    }

    case "join": {
      if (isUnfinished(current)) throw new InvalidRunError("You are already in a duel");
      const duel = duels.get(String(command.duelId));
      if (!duel || duel.phase !== "lobby") throw new InvalidRunError("That lobby is gone");
      if (duel.guildId !== session.guildId) throw new InvalidRunError("That lobby is gone");
      if (duel.seats.length >= DUEL_PLAYERS) throw new InvalidRunError("That lobby is full");
      if (seatOf(duel, session.player.id)) throw new InvalidRunError("You are already in it");

      releaseFinished(socket, current);
      duel.seats.push(takeSeat(session.player, socket, sanitizeHandling(command.handling)));
      socket.data.duelId = duel.id;
      broadcast(duel, { type: "duel", duel: view(duel) });
      return;
    }

    case "ready": {
      if (!current) throw new InvalidRunError("You are not in a duel");
      if (current.hostId !== session.player.id) throw new InvalidRunError("Only the host starts it");
      if (current.phase !== "lobby") throw new InvalidRunError("It has already started");
      if (current.seats.length < DUEL_PLAYERS) throw new InvalidRunError("Nobody has joined yet");
      startMatch(current);
      return;
    }

    case "rematch": {
      // One message for a duel that is gone, an offer that has lapsed and a
      // match still being played: what the player asked for is not on offer,
      // and which of the three it is is not theirs to act on. Refused here as
      // well as swept on a timer, so the deadline the view hands the client is
      // the one the referee actually keeps.
      if (!rematchStands(current)) throw new InvalidRunError("There is no match to play again");
      const seat = seatOf(current, session.player.id);
      if (seat) offerRematch(current, seat);
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

/** A duel a player cannot walk out of just by opening or joining another. */
function isUnfinished(duel: Duel | undefined): duel is Duel {
  return duel !== undefined && duel.phase !== "over";
}

/**
 * Walks a player out of the match they have already finished.
 *
 * Opening or joining another duel is how a player declines a rematch, so it
 * cannot be refused as "you are already in a duel". It happens only once the
 * new duel is certain: a refused open must not cost somebody an offer that was
 * standing when they asked.
 */
function releaseFinished(socket: ServerWebSocket<SocketData>, duel: Duel | undefined): void {
  if (!duel || duel.phase !== "over") return;
  depart(duel, socket.data.session.player.id);
  // `depart` unseats this socket before dropping the duel, so it is the one
  // socket `discard` cannot reach.
  socket.data.duelId = null;
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
  const seat = seatOf(duel, playerId);
  if (seat) seat.socket = null;
  if (duel.phase === "over") {
    // Nothing left to forfeit — only an offer to withdraw. It dies with the
    // player who left, so the one still here is never sat waiting on somebody
    // who is already gone.
    dropRematch(duel);
    return;
  }
  // Mid-match, leaving hands the match to whoever stayed. A grace period for a
  // dropped connection is the next slice; until it exists this is correct, just
  // unkind to bad wifi.
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

/**
 * Drops what nobody is in: lobbies nobody joined, and finished matches nobody
 * went back into. Called on a timer by the server.
 *
 * A rematch offer needs no timer of its own precisely because this exists. The
 * cost is that the offer outlives its deadline by up to one sweep, which is why
 * {@link rematchStands} checks the clock rather than trusting the registry.
 */
export function sweepDuels(now = Date.now()): number {
  let swept = 0;
  for (const duel of [...duels.values()]) {
    if (duel.phase === "lobby" && now - duel.createdAt >= DUEL_LOBBY_TTL_MS) {
      broadcast(duel, { type: "matchOver", winnerId: null, reason: "forfeit", duel: view(duel) });
      discard(duel);
      swept++;
      continue;
    }
    if (duel.finishedAt !== null && now - duel.finishedAt >= DUEL_REMATCH_TTL_MS) {
      dropRematch(duel);
      swept++;
    }
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
