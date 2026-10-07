/**
 * What a player is told when the duel socket closes.
 *
 * It used to be two things at once. An abrupt close fires `error` and then
 * `close`, and the client toasted on both — "Lost the connection to the duel"
 * and, a breath later, "The duel connection closed" — about one event. And it
 * never read the close code, so a deploy looked exactly like bad wifi.
 *
 * The game now says why it is closing (`SERVER_GOING_AWAY` in
 * `shared/runtime-status.ts`): code 1012 with `handover` when it closes a
 * lobby because a new server is already up — open it again and you are on the
 * new one — and `restart` when it stops, ending whatever was left. One close,
 * one sentence, and the sentence says what to do.
 *
 * A close the client asked for itself — leaving duel mode — says nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { describeDuelClose, DuelClient, type DuelClosure } from "../client/src/game/duel";
import { SERVER_GOING_AWAY } from "../shared/runtime-status";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";

/** A socket that never touches the network; the test closes it from the server's side. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly opened: FakeSocket[] = [];

  readyState = FakeSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  send(): void {}

  /** Like a browser: closing your own socket still fires `close`, with 1005. */
  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1005, reason: "" });
  }

  /** The server, or the network, ending it. */
  drop(code: number, reason: string, { error = false } = {}): void {
    this.readyState = FakeSocket.CLOSED;
    if (error) this.onerror?.({});
    this.onclose?.({ code, reason });
  }
}

const saved = { WebSocket: globalThis.WebSocket };

beforeAll(() => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});

afterAll(() => {
  globalThis.WebSocket = saved.WebSocket;
});

/** A connected client, and everything it reported. */
function connected(): { client: DuelClient; socket: FakeSocket; closures: DuelClosure[]; errors: string[] } {
  const closures: DuelClosure[] = [];
  const errors: string[] = [];
  const ignore = () => undefined;
  const client = new DuelClient("ws://not-connected", DEFAULT_HANDLING, {
    onFrame: ignore,
    onState: ignore,
    onRound: ignore,
    onRushPuzzle: ignore,
    onOpponent: ignore,
    onRoundOver: ignore,
    onMatchOver: ignore,
    onLobbies: ignore,
    onError: (message) => errors.push(message),
    onClosed: (closure) => closures.push(closure),
  });
  client.connect();
  return { client, socket: FakeSocket.opened.at(-1)!, closures, errors };
}

describe("describeDuelClose", () => {
  test("a handover says the lobby can be opened again", () => {
    expect(describeDuelClose(SERVER_GOING_AWAY.code, SERVER_GOING_AWAY.handover, false)).toEqual({
      kind: "handover",
      message: "The server is updating — open the lobby again",
    });
  });

  test("a restart says the duel is over", () => {
    expect(describeDuelClose(SERVER_GOING_AWAY.code, SERVER_GOING_AWAY.restart, false)).toEqual({
      kind: "restart",
      message: "The server restarted, so the duel ended.",
    });
  });

  test("a 1012 with no reason it knows is still a restart", () => {
    expect(describeDuelClose(1012, "", false).kind).toBe("restart");
  });

  test("an abrupt close is a lost connection", () => {
    expect(describeDuelClose(1006, "", false)).toEqual({
      kind: "lost",
      message: "Lost the connection to the duel",
    });
    expect(describeDuelClose(1000, "", true).kind).toBe("lost");
  });

  test("any other clean close is just closed", () => {
    expect(describeDuelClose(1000, "Opened elsewhere", false)).toEqual({
      kind: "closed",
      message: "The duel connection closed",
    });
  });
});

describe("the client reports one closure per close", () => {
  test("an error and then a close are one message, not two", () => {
    const { socket, closures, errors } = connected();

    socket.drop(1006, "", { error: true });

    expect(errors).toEqual([]);
    expect(closures).toHaveLength(1);
    expect(closures[0]!.message).toBe("Lost the connection to the duel");
  });

  test("a handover close is reported as one", () => {
    const { socket, closures } = connected();

    socket.drop(1012, "handover");

    expect(closures.map((closure) => closure.kind)).toEqual(["handover"]);
  });

  test("a restart close is reported as one", () => {
    const { socket, closures } = connected();

    socket.drop(1012, "restart");

    expect(closures.map((closure) => closure.kind)).toEqual(["restart"]);
  });

  test("closing it ourselves reports nothing", () => {
    const { client, closures, errors } = connected();

    client.close();

    expect(closures).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a server error frame is still an error, and not a closure", () => {
    const { socket, closures, errors } = connected();

    socket.onmessage?.({ data: JSON.stringify({ type: "error", message: "That lobby is full" }) });

    expect(errors).toEqual(["That lobby is full"]);
    expect(closures).toEqual([]);
  });
});
