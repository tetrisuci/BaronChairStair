/**
 * The activity riding out a deploy: the rush, the duel and the update chip,
 * with the whole `App` booted in happy-dom against a scripted network.
 *
 * - A rush hand-in keeps its ticket until the server answers, gives up when
 *   the server's own grace would, never pulls a player who has moved on back
 *   to its result, and does not call its own lost first attempt somebody
 *   else's filing.
 * - A duel closed by the server says why, once, and leaves duel mode — so
 *   pressing Duel again opens a new lobby instead of doing nothing.
 * - A match that is already over keeps its result through the close that
 *   follows it — a handover sends `matchOver`, its notice and the close in one
 *   breath — with the rematch withdrawn and one quiet line on the card.
 * - A newer build on the server shows a quiet chip, never while the player is
 *   in the middle of a run, a rush or a duel, nor while a hand-in is still on
 *   its way — a reload then would throw away the very thing the retries are
 *   there to save.
 *
 * The parts are tested on their own elsewhere (`hand-in-retry`, `duel-close`,
 * `update-offer`), and the daily's hand-in in `live-client-daily.test.ts`.
 * This file pins the wiring between them, which is where each of these broke:
 * the pieces were right and `app.ts` did not use them. The harness is
 * `live-client.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { HandInOptions } from "../client/src/api";
import { DEFAULT_DUEL_SETTINGS, type DuelEvent, type DuelView } from "../shared/duel";
import { RUSH_DURATION_MS } from "../shared/rush";
import { RUSH_GRACE_MS, RUSH_HAND_IN_MARGIN_MS } from "../client/src/game/rush";
import {
  boot,
  type Booted,
  chip,
  FakeSocket,
  filedBody,
  finishEasy,
  gate,
  type Internals,
  internals,
  panelCaptions,
  PLAYER,
  posts,
  proxyDown,
  reply,
  RUSH_TICKET,
  rushFiled,
  settle,
  startRush,
  usePage,
} from "./live-client";

usePage();

/** The sentence under a rush's result: filed, already on the board, or practice. */
function rushNote(root: HTMLElement): string | null {
  const card = [...root.querySelectorAll(".panel")].find(
    (panel) => panel.querySelector(".panel__caption")?.textContent === "Rush over",
  );
  return card?.querySelector(".note")?.textContent ?? null;
}

// ── The rush ─────────────────────────────────────────────────────────────────

describe("the rush hand-in", () => {
  test("keeps its ticket until the server answers, and sends the same one every time", async () => {
    let attempts = 0;
    const heldDuring: (string | null)[] = [];
    let inner: Internals | null = null;
    const booted = await boot((request) => {
      if (request.path !== "/api/rush/run") return reply(404, {});
      attempts += 1;
      heldDuring.push(inner?.rushTicket?.token ?? null);
      return attempts < 3 ? proxyDown() : reply(200, rushFiled());
    });
    inner = await startRush(booted);

    inner.rush!.giveUp();
    await settle();

    const handIns = posts(booted.sent, "/api/rush/run");
    expect(handIns).toHaveLength(3);
    expect(handIns.map((request) => request.body?.ticket)).toEqual([RUSH_TICKET, RUSH_TICKET, RUSH_TICKET]);
    expect(heldDuring).toEqual([RUSH_TICKET, RUSH_TICKET, RUSH_TICKET]);
    expect(inner.rushTicket).toBeNull();
    expect(inner.rush).toBeNull();
    expect(booted.toasts).toContain("Reconnecting…");
  });

  test("stops retrying where the server would stop accepting: its start, five minutes, the grace, less a margin", async () => {
    const booted = await boot((request) =>
      request.path === "/api/rush/run" ? reply(200, rushFiled()) : reply(404, {}),
    );
    const seen: HandInOptions[] = [];
    const submit = booted.api.submitRush.bind(booted.api);
    booted.api.submitRush = (body, options) => {
      seen.push(options ?? {});
      return submit(body, options);
    };

    const before = Date.now();
    const inner = await startRush(booted);
    const after = Date.now();
    inner.rush!.giveUp();
    await settle();

    const deadline = seen[0]?.deadline;
    const allowance = RUSH_DURATION_MS + RUSH_GRACE_MS - RUSH_HAND_IN_MARGIN_MS;
    expect(deadline).toBeGreaterThanOrEqual(before + allowance);
    expect(deadline).toBeLessThanOrEqual(after + allowance);
  });

  test("when the server never comes back, the player still sees what they did", async () => {
    const booted = await boot((request) => (request.path === "/api/rush/run" ? proxyDown() : reply(404, {})));
    const inner = await startRush(booted);

    inner.rush!.giveUp();
    await settle();

    expect(posts(booted.sent, "/api/rush/run")).toHaveLength(7);
    expect(booted.toasts.at(-1)).toBe("Request failed (502)");
    expect(inner.rushTicket).toBeNull();
    // The local result card, from what the client counted itself.
    expect(booted.root.querySelector(".rush__headline")).not.toBeNull();
  });

  test("a player who leaves while it retries is not pulled back to its result", async () => {
    let attempts = 0;
    let inner: Internals | null = null;
    const booted = await boot((request) => {
      if (request.path !== "/api/rush/run") return reply(404, {});
      attempts += 1;
      // Pressed Home between the first attempt and the second.
      if (attempts === 1) inner?.showHome();
      return attempts === 1 ? proxyDown() : reply(200, rushFiled());
    });
    inner = await startRush(booted);

    inner.rush!.giveUp();
    await settle();

    expect(posts(booted.sent, "/api/rush/run")).toHaveLength(2);
    expect(inner.mode).toBe("daily");
    expect(booted.root.querySelector(".home")).not.toBeNull();
  });

  test("a retry that finds its own first attempt filed says it was filed", async () => {
    // The server knows the accepted ticket. Its retry still gets `isFirst:
    // true`, so the page can show the exact receipt it got back.
    let attempts = 0;
    const booted = await boot((request) => {
      if (request.path !== "/api/rush/run") return reply(404, {});
      attempts += 1;
      return attempts === 1 ? proxyDown() : reply(200, rushFiled(true));
    });
    const inner = await startRush(booted);

    inner.rush!.giveUp();
    await settle();

    expect(attempts).toBe(2);
    expect(rushNote(booted.root)).toBe("Filed for today.");
  });

  test("a retry whose first request never arrived respects another device's filed ticket", async () => {
    let attempts = 0;
    const booted = await boot((request) => {
      if (request.path !== "/api/rush/run") return reply(404, {});
      attempts += 1;
      // The first request failed at the proxy. Another device files its ticket
      // before this request is retried; this ticket is correctly not first.
      return attempts === 1 ? proxyDown() : reply(200, rushFiled(false));
    });
    const inner = await startRush(booted);
    inner.rush!.giveUp();
    await settle();

    expect(attempts).toBe(2);
    expect(rushNote(booted.root)).toBe("Today's rush was already on the board, so this one was not filed.");
  });

  test("a first attempt told the rush was already filed still says so", async () => {
    // No retry, so nothing of this hand-in was lost on the wire: the server's
    // word stands — two rushes started side by side, the other one won.
    const booted = await boot((request) =>
      request.path === "/api/rush/run" ? reply(200, rushFiled(false)) : reply(404, {}),
    );
    const inner = await startRush(booted);

    inner.rush!.giveUp();
    await settle();

    expect(rushNote(booted.root)).toBe("Today's rush was already on the board, so this one was not filed.");
  });
});

// ── The duel ─────────────────────────────────────────────────────────────────

describe("a duel the server closes", () => {
  test("for a handover: one message, duel mode left, and Duel opens a new lobby", async () => {
    const booted = await boot();
    const inner = internals(booted.app);
    const before = FakeSocket.opened.length;

    inner.enterDuel();
    FakeSocket.opened.at(-1)!.drop(1012, "handover");

    expect(booted.toasts).toEqual(["The server is updating — open the lobby again"]);
    expect(inner.mode).toBe("daily");
    expect(inner.duel).toBeNull();

    inner.enterDuel();
    expect(FakeSocket.opened.length).toBe(before + 2);
    expect(inner.mode).toBe("duel");
  });

  test("for a restart: the duel is over, and said so once", async () => {
    const booted = await boot();
    const inner = internals(booted.app);

    inner.enterDuel();
    FakeSocket.opened.at(-1)!.drop(1012, "restart");

    expect(booted.toasts).toEqual(["The server restarted, so the duel ended."]);
    expect(inner.mode).toBe("daily");
  });

  test("an abrupt close is one message, not an error and a close", async () => {
    const booted = await boot();
    const inner = internals(booted.app);

    inner.enterDuel();
    FakeSocket.opened.at(-1)!.drop(1006, "", { error: true });

    expect(booted.toasts).toEqual(["Lost the connection to the duel"]);
    expect(inner.mode).toBe("daily");
  });

  test("leaving the duel ourselves says nothing", async () => {
    const booted = await boot();
    const inner = internals(booted.app);

    inner.enterDuel();
    inner.showHome();

    expect(booted.toasts).toEqual([]);
    expect(inner.mode).toBe("daily");
  });
});

/**
 * What the server sends a seat it is letting go of, as `server/going-away.ts`
 * words it: a notice frame, then the 1012 close. Both, always — a test that
 * drops the socket without the notice is testing a server that does not exist.
 */
const NOTICE = {
  handover: "The server is updating. Open Duel again to carry on.",
  restart: "The server is restarting, so this duel ended without a result.",
} as const;

const RIVAL = { id: "player-2", username: "Rival", avatarUrl: null };

/** A two-seat duel as the server describes it; the match is over unless told otherwise. */
function duelView(overrides: Partial<DuelView> = {}): DuelView {
  return {
    id: "duel-1",
    phase: "over",
    settings: DEFAULT_DUEL_SETTINGS,
    hostId: PLAYER.id,
    players: [
      { ...PLAYER, connected: true, score: 2, wantsRematch: false },
      { ...RIVAL, connected: true, score: 1, wantsRematch: false },
    ],
    round: 3,
    rematchEndsAt: null,
    poolSize: 40,
    poolNeeded: 3,
    ...overrides,
  };
}

function frame(socket: FakeSocket, event: DuelEvent): void {
  socket.onmessage?.({ data: JSON.stringify(event) });
}

/** Into a duel, signed in as {@link PLAYER}, with the match just won. */
function wonMatch(booted: Booted, view: DuelView = duelView()): { inner: Internals; socket: FakeSocket } {
  const inner = internals(booted.app);
  inner.enterDuel();
  const socket = FakeSocket.opened.at(-1)!;
  frame(socket, { type: "welcome", playerId: PLAYER.id, open: [] });
  frame(socket, { type: "matchOver", winnerId: PLAYER.id, reason: "solved", duel: view });
  return { inner, socket };
}

/** The duel's result card, if it is on the page. */
function resultCard(root: HTMLElement): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>(".panel")].find(
      (panel) => panel.querySelector(".panel__caption")?.textContent === "Match over",
    ) ?? null
  );
}

function cardButton(card: HTMLElement, label: RegExp): HTMLButtonElement {
  const found = [...card.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    label.test(button.textContent ?? ""),
  );
  if (!found) throw new Error(`No ${label} button on the result card`);
  return found;
}

describe("a duel the server closes after its match is over", () => {
  test("for a handover: the result stays, one quiet line, no toast, and the rematch is gone", async () => {
    const booted = await boot();
    const { inner, socket } = wonMatch(booted);
    expect(resultCard(booted.root)?.textContent).toContain("You win");

    frame(socket, { type: "error", message: NOTICE.handover });
    socket.drop(1012, "handover");

    const card = resultCard(booted.root);
    expect(card?.isConnected).toBe(true);
    expect(card?.textContent).toContain("You win");
    expect(card?.textContent).toContain("The server updated — open Duel again for a rematch.");
    expect(card?.textContent).not.toContain(NOTICE.handover);
    expect(cardButton(card!, /rematch/i).hidden).toBe(true);
    expect(booted.toasts).toEqual([]);
    // Left the way Back leaves it, bar the screen: Duel opens a new connection.
    expect(inner.mode).toBe("daily");
    expect(inner.duel).toBeNull();
    const before = FakeSocket.opened.length;
    inner.enterDuel();
    expect(FakeSocket.opened.length).toBe(before + 1);
    expect(inner.mode).toBe("duel");
  });

  test("a rematch already on offer is withdrawn when the server lets the result screen go", async () => {
    // A finished duel waiting on a rematch is not a match in play, so the
    // drain sends it away at once (`drainDuels`), notice and close.
    const booted = await boot();
    const { socket } = wonMatch(booted, duelView({ rematchEndsAt: Date.now() + 60_000 }));
    const rematch = cardButton(resultCard(booted.root)!, /rematch/i);
    expect(rematch.hidden).toBe(false);

    frame(socket, { type: "error", message: NOTICE.handover });
    socket.drop(1012, "handover");

    expect(resultCard(booted.root)?.isConnected).toBe(true);
    expect(rematch.hidden).toBe(true);
    expect(booted.toasts).toEqual([]);
  });

  test("any other close keeps the result too, and says which it was", async () => {
    const cases: { code: number; reason: string; notice: string | null; note: string }[] = [
      { code: 1012, reason: "restart", notice: NOTICE.restart, note: "The server restarted — open Duel again for a rematch." },
      { code: 1006, reason: "", notice: null, note: "Lost the connection — open Duel again for a rematch." },
      { code: 1000, reason: "Opened elsewhere", notice: null, note: "The duel connection closed — open Duel again for a rematch." },
    ];
    for (const { code, reason, notice, note } of cases) {
      const booted = await boot();
      const { inner, socket } = wonMatch(booted);

      if (notice) frame(socket, { type: "error", message: notice });
      socket.drop(code, reason);

      const card = resultCard(booted.root);
      expect(card?.textContent).toContain("You win");
      expect(card?.textContent).toContain(note);
      // The restart notice says the duel "ended without a result" — about a
      // match that has one on screen. It must not be left standing.
      if (notice) expect(card?.textContent).not.toContain(notice);
      expect(booted.toasts).toEqual([]);
      expect(inner.mode).toBe("daily");
    }
  });

  test("Back to 1v1 after the close opens a fresh connection rather than a dead lobby list", async () => {
    const booted = await boot();
    const { inner, socket } = wonMatch(booted);
    frame(socket, { type: "error", message: NOTICE.handover });
    socket.drop(1012, "handover");
    const before = FakeSocket.opened.length;

    cardButton(resultCard(booted.root)!, /^Back to 1v1$/).click();

    expect(FakeSocket.opened.length).toBe(before + 1);
    expect(inner.mode).toBe("duel");
    expect(inner.duel).not.toBeNull();
    expect(panelCaptions(booted.root)).toContain("1v1");
  });

  test("a refusal while the result is up is said on the card, and the rematch stays", async () => {
    const booted = await boot();
    const { socket } = wonMatch(booted, duelView({ rematchEndsAt: Date.now() + 60_000 }));

    frame(socket, { type: "error", message: "There is no match to play again" });

    const card = resultCard(booted.root)!;
    expect(card.textContent).toContain("There is no match to play again");
    expect(cardButton(card, /rematch/i).hidden).toBe(false);
    expect(booted.toasts).toEqual([]);
  });

  test("after Back to 1v1, a late frame for the finished match does not hide refusals or strand the intro", async () => {
    // The server sends a finished duel's frame whenever the rival asks for a
    // rematch or leaves (`dropRematch`), and one can cross the player's own
    // leave in flight. It describes a match the player has walked away from:
    // the card it is about is no longer on the page.
    const booted = await boot();
    const { inner, socket } = wonMatch(booted);
    cardButton(resultCard(booted.root)!, /^Back to 1v1$/).click();
    expect(panelCaptions(booted.root)).toContain("1v1");

    const rivalAsks = duelView().players.map((seat) => ({
      ...seat,
      wantsRematch: seat.id === RIVAL.id,
    }));
    frame(socket, { type: "duel", duel: duelView({ players: rivalAsks }) });
    frame(socket, { type: "error", message: "That lobby is full" });

    expect(booted.toasts).toEqual(["That lobby is full"]);

    frame(socket, { type: "error", message: NOTICE.handover });
    socket.drop(1012, "handover");

    // Left exactly as a close before the match is over leaves it: not a
    // 1v1 intro with no socket under Open and Join.
    expect(booted.toasts.at(-1)).toBe("The server is updating — open the lobby again");
    expect(inner.mode).toBe("daily");
    expect(inner.duel).toBeNull();
    expect(panelCaptions(booted.root)).not.toContain("1v1");
    expect(resultCard(booted.root)).toBeNull();
  });

  test("a close before the match is over still leaves duel mode, as before", async () => {
    const booted = await boot();
    const inner = internals(booted.app);
    inner.enterDuel();
    const socket = FakeSocket.opened.at(-1)!;
    frame(socket, { type: "welcome", playerId: PLAYER.id, open: [] });
    frame(socket, { type: "duel", duel: duelView({ phase: "playing" }) });

    frame(socket, { type: "error", message: NOTICE.restart });
    socket.drop(1012, "restart");

    expect(booted.toasts.at(-1)).toBe("The server restarted, so the duel ended.");
    expect(inner.mode).toBe("daily");
    expect(inner.duel).toBeNull();
    expect(resultCard(booted.root)).toBeNull();
  });
});

// ── The update chip ──────────────────────────────────────────────────────────

describe("the update chip", () => {
  const builds = { clientBuild: "a1b2c3d", serverBuild: "e4f5a6b" };

  test("shows on the front door once the server names a newer build", async () => {
    const booted = await boot(undefined, builds);

    expect(chip(booted.root).hidden).toBe(false);
  });

  test("stays hidden when the server is on the same build", async () => {
    const booted = await boot(undefined, { clientBuild: "a1b2c3d", serverBuild: "a1b2c3d" });

    expect(chip(booted.root).hidden).toBe(true);
  });

  test("hides for a run and comes back once it is over", async () => {
    const booted = await boot(undefined, builds);
    const inner = internals(booted.app);

    inner.showDailyTier("easy");
    expect(chip(booted.root).hidden).toBe(true);
    inner.tickChrome();
    expect(chip(booted.root).hidden).toBe(true);

    // Played to its real end — the chip reads the run's own phase, so a
    // made-up snapshot would leave the run itself still "ready".
    const run = inner.run!;
    for (let piece = 0; piece < 80 && ["ready", "playing"].includes(run.snapshot().phase); piece += 1) {
      run.tap("hardDrop");
    }
    await settle();
    expect(["solved", "failed"]).toContain(run.snapshot().phase);
    inner.tickChrome();
    expect(chip(booted.root).hidden).toBe(false);
  });

  test("hides for a rush and for a duel", async () => {
    const booted = await boot(
      (request) => (request.path === "/api/rush/run" ? reply(200, rushFiled()) : reply(404, {})),
      builds,
    );
    const inner = await startRush(booted);
    expect(chip(booted.root).hidden).toBe(true);
    inner.tickChrome();
    expect(chip(booted.root).hidden).toBe(true);

    inner.rush!.giveUp();
    await settle();
    inner.tickChrome();
    expect(chip(booted.root).hidden).toBe(false);

    inner.enterDuel();
    expect(chip(booted.root).hidden).toBe(true);
    inner.tickChrome();
    expect(chip(booted.root).hidden).toBe(true);
  });

  /**
   * Goes Home while a hand-in is held in the restart, ticks the chrome, lets
   * the restart end and ticks it again: whether the chip was hidden during,
   * and after.
   */
  async function chipAcross(booted: Booted, restart: { open(): void }, pending: Promise<unknown> = Promise.resolve()) {
    const inner = internals(booted.app);
    // Home: nothing is on the board, so only the hand-in can keep it down.
    inner.showHome();
    inner.tickChrome();
    const during = chip(booted.root).hidden;
    restart.open();
    await pending;
    await settle();
    inner.tickChrome();
    return { during, after: chip(booted.root).hidden };
  }

  test("stays hidden while a daily filing is still on its way", async () => {
    const restart = gate();
    let attempts = 0;
    const booted = await boot(async (request) => {
      if (request.path !== "/api/daily/run") return reply(404, {});
      attempts += 1;
      if (attempts === 1) {
        await restart.opened;
        return proxyDown();
      }
      return reply(200, filedBody());
    }, builds);

    const filing = finishEasy(booted);
    await settle();
    const seen = await chipAcross(booted, restart, filing);

    expect(seen).toEqual({ during: true, after: false });
  });

  test("stays hidden while a rush the player has left is still being handed in", async () => {
    const restart = gate();
    let attempts = 0;
    const booted = await boot(async (request) => {
      if (request.path !== "/api/rush/run") return reply(404, {});
      attempts += 1;
      if (attempts === 1) {
        await restart.opened;
        return proxyDown();
      }
      return reply(200, rushFiled());
    }, builds);
    const inner = await startRush(booted);

    inner.rush!.giveUp();
    await settle();
    const seen = await chipAcross(booted, restart);

    expect(attempts).toBe(2);
    expect(seen).toEqual({ during: true, after: false });
    expect(panelCaptions(booted.root)).not.toContain("Rush over");
  });
});
