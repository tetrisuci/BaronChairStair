/**
 * How a duel socket is closed when the process is leaving, rather than the
 * player.
 *
 * Two parts, in this order. A notice first, as the protocol's existing `error`
 * frame: an activity opened before the client learned to read close codes still
 * shows it, which is the difference between "the server is updating — open it
 * again" and an unexplained "the duel connection closed". Then the close
 * itself, with 1012 and a reason naming which kind of leaving this is
 * (`SERVER_GOING_AWAY` in `shared/runtime-status.ts`), for a client that does
 * read them.
 *
 * Kept out of `server/duel.ts`, which decides *when* a socket is sent away;
 * this is only what it is told on the way.
 */

import type { ServerWebSocket } from "bun";
import type { DuelEvent } from "../shared/duel";
import { SERVER_GOING_AWAY } from "../shared/runtime-status";

export type GoingAway = typeof SERVER_GOING_AWAY.handover | typeof SERVER_GOING_AWAY.restart;

/**
 * What the player reads. A handover loses them nothing — the newer process is
 * already listening — so it says to reopen; a restart may have ended a match,
 * so it says that, and that nobody won it.
 */
const NOTICES: Record<GoingAway, string> = {
  handover: "The server is updating. Open Duel again to carry on.",
  restart: "The server is restarting, so this duel ended without a result.",
};

export function sendAway(socket: ServerWebSocket<unknown>, why: GoingAway): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const notice: DuelEvent = { type: "error", message: NOTICES[why] };
  socket.send(JSON.stringify(notice));
  socket.close(SERVER_GOING_AWAY.code, why);
}
