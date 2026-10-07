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
    // A ranked ticket is minted only while no rush is filed for the day, so a
    // retry told `isFirst: false` is hearing about the attempt the restart
    // swallowed — this player's run, filed once.
    let attempts = 0;
    const booted = await boot((request) => {
      if (request.path !== "/api/rush/run") return reply(404, {});
      attempts += 1;
      return attempts === 1 ? proxyDown() : reply(200, rushFiled(false));
    });
    const inner = await startRush(booted);

    inner.rush!.giveUp();
    await settle();

    expect(attempts).toBe(2);
    expect(rushNote(booted.root)).toBe("Filed for today.");
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
