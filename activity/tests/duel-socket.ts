/**
 * A duel socket as a test holds it: every frame kept in order, the close
 * remembered with its code and reason, and a way to wait for a frame.
 *
 * Shared by the two suites that watch a socket being sent away —
 * `duel-drain.test.ts` in process and `handover.test.ts` across two real
 * processes — because what they assert is the same thing seen from the
 * player's side: which frames arrived, and how the socket ended.
 */

import type { DuelCommand, DuelEvent } from "../shared/duel";

/** How long a test waits for a frame the server owes it before giving up. */
const FRAME_TIMEOUT_MS = 5_000;
const POLL_MS = 25;

export interface Closed {
  readonly code: number;
  readonly reason: string;
}

export interface DuelSocket {
  /** Every frame the server has sent, oldest first. */
  readonly received: readonly DuelEvent[];
  /** Settles when the socket closes, however it closes. */
  readonly closed: Promise<Closed>;
  isOpen(): boolean;
  send(command: DuelCommand): void;
  /** The oldest frame of this type not already taken, waiting for one if need be. */
  take<T extends DuelEvent["type"]>(type: T): Promise<Extract<DuelEvent, { type: T }>>;
  close(): void;
}

/**
 * Opens a socket and resolves once the upgrade is through.
 *
 * @param label names the socket in a timeout's message.
 */
export async function openDuelSocket(url: string, label: string): Promise<DuelSocket> {
  const socket = new WebSocket(url);
  const received: DuelEvent[] = [];
  const unread: DuelEvent[] = [];
  socket.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as DuelEvent;
    received.push(event);
    unread.push(event);
  });
  const closed = new Promise<Closed>((resolve) =>
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), {
      once: true,
    }),
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`${label}: the upgrade was refused`)), {
      once: true,
    });
  });

  async function take<T extends DuelEvent["type"]>(type: T) {
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    while (!unread.some((event) => event.type === type)) {
      if (Date.now() > deadline) throw new Error(`${label} waited ${FRAME_TIMEOUT_MS}ms for a "${type}" frame`);
      await Bun.sleep(POLL_MS);
    }
    const index = unread.findIndex((event) => event.type === type);
    return unread.splice(index, 1)[0] as Extract<DuelEvent, { type: T }>;
  }

  return {
    received,
    closed,
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (command) => socket.send(JSON.stringify(command)),
    take,
    close: () => socket.close(),
  };
}
