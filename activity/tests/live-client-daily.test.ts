/**
 * The day's sheets and a practice solve, handed in across a deploy.
 *
 * - A daily hand-in sent into the restart is asked again, says
 *   "Reconnecting…" while it waits, and names the day it was dealt on — so a
 *   sheet solved across midnight is refused (409) rather than replayed against
 *   the next day's puzzle, and the client then reads the new day.
 * - The retries hold a filing open for up to fifteen seconds, which is long
 *   enough to go and play something else. A late answer must not put its
 *   result over whatever the player went to, and a second tier solved in that
 *   time is filed as well rather than silently dropped.
 * - A practice clear rides out the same restart without a word.
 *
 * The harness is `live-client.ts`; the rush, the duel and the update chip are
 * in `live-client-app.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  boot,
  DAY,
  dailyBody,
  filedBody,
  finishEasy,
  finishTier,
  gate,
  type Internals,
  internals,
  panelCaptions,
  posts,
  PROMPTS,
  proxyDown,
  reply,
  settle,
  tierPuzzle,
  usePage,
} from "./live-client";
import type { DailyTier } from "../shared/daily";

usePage();

/** The verdict's two panels, which `presentVerdict` mounts into the left rail. */
function verdictShowing(root: HTMLElement): boolean {
  const captions = panelCaptions(root);
  return captions.includes("Result") || captions.includes("Leaderboard");
}

/** Whether the deck still has the play layout a verdict drops. */
function deckInPlay(root: HTMLElement): boolean {
  return root.querySelector(".deck")?.classList.contains("deck--play") ?? false;
}

function filedRun(inner: Internals, tier: DailyTier): unknown {
  return inner.daily?.puzzles.find((entry) => entry.tier === tier)?.run ?? null;
}

describe("the daily hand-in", () => {
  test("names the day the sheet was dealt on", async () => {
    const booted = await boot((request) =>
      request.path === "/api/daily/run" ? reply(200, filedBody()) : reply(404, {}),
    );

    await finishEasy(booted);

    const [filing] = posts(booted.sent, "/api/daily/run");
    expect(filing?.body?.day).toBe(DAY);
    expect(filing?.body?.tier).toBe("easy");
  });

  test("rides out a restart, saying Reconnecting… while it waits, and files", async () => {
    let attempts = 0;
    const booted = await boot((request) => {
      if (request.path !== "/api/daily/run") return reply(404, {});
      attempts += 1;
      return attempts < 3 ? proxyDown(attempts === 1 ? 502 : 503) : reply(200, filedBody());
    });

    await finishEasy(booted);

    expect(posts(booted.sent, "/api/daily/run")).toHaveLength(3);
    expect(booted.toasts.filter((message) => message === "Reconnecting…")).toHaveLength(2);
    expect(booted.toasts.some((message) => message.startsWith("Request failed"))).toBe(false);
    expect(internals(booted.app).daily).toMatchObject({ day: DAY });
  });

  test("a retry that lands on its own first attempt is not called a second filing", async () => {
    // The first attempt was filed and its answer lost on the way back: the
    // retry is told `isFirst: false`, which is about the retry, not the player.
    let attempts = 0;
    const booted = await boot((request) => {
      if (request.path !== "/api/daily/run") return reply(404, {});
      attempts += 1;
      return attempts === 1 ? proxyDown() : reply(200, filedBody(false));
    });

    await finishEasy(booted);

    expect(booted.toasts).not.toContain("Today's sheet was already filed");
  });

  test("a sheet from a day that has ended is refused with the server's sentence, and the day is read again", async () => {
    const refusal = "That was yesterday's sheet — today's is ready.";
    let dailies = 0;
    const booted = await boot((request) => {
      if (request.path === "/api/daily/run") return reply(409, { error: refusal });
      if (request.path === "/api/daily") {
        dailies += 1;
        return reply(200, dailyBody(dailies === 1 ? DAY : DAY + 1));
      }
      return reply(404, {});
    });

    await finishEasy(booted);
    await settle();

    expect(posts(booted.sent, "/api/daily/run")).toHaveLength(1);
    expect(booted.toasts).toContain(refusal);
    expect(dailies).toBe(2);
    expect(internals(booted.app).daily?.day).toBe(DAY + 1);
  });

  test("when the server never comes back, it says so as it always did", async () => {
    const booted = await boot((request) =>
      request.path === "/api/daily/run" ? proxyDown(503) : reply(404, {}),
    );

    await finishEasy(booted);

    expect(posts(booted.sent, "/api/daily/run")).toHaveLength(7);
    expect(booted.toasts.at(-1)).toBe("Request failed (503)");
  });
});

describe("a daily hand-in the player walks away from", () => {
  test("files, and keeps what it filed, without pulling them back to its result", async () => {
    let attempts = 0;
    let inner: Internals | null = null;
    const booted = await boot((request) => {
      if (request.path !== "/api/daily/run") return reply(404, {});
      attempts += 1;
      // Home, then the next tier, between the first attempt and the second.
      if (attempts === 1) {
        inner?.showHome();
        inner?.showDailyTier("medium");
      }
      return attempts === 1 ? proxyDown() : reply(200, filedBody());
    });
    inner = internals(booted.app);

    await finishEasy(booted);
    await settle();

    expect(attempts).toBe(2);
    // The medium run is untouched: no result card, no leaderboard, and the
    // play layout the verdict would have dropped.
    expect(inner.run?.snapshot().phase).toBe("ready");
    expect(verdictShowing(booted.root)).toBe(false);
    expect(deckInPlay(booted.root)).toBe(true);
    // What the server said is still kept, for when they go back to it.
    expect(filedRun(inner, "easy")).not.toBeNull();
    expect(inner.cleared.has(tierPuzzle("easy").id)).toBe(true);
    expect(booted.toasts).not.toContain("Today's sheet was already filed");
  });

  test("that never lands does not put a result over the next run, and still says it failed", async () => {
    let attempts = 0;
    let inner: Internals | null = null;
    const booted = await boot((request) => {
      if (request.path !== "/api/daily/run") return reply(404, {});
      attempts += 1;
      if (attempts === 1) {
        inner?.showHome();
        inner?.showDailyTier("medium");
      }
      return proxyDown(503);
    });
    inner = internals(booted.app);

    await finishEasy(booted);
    await settle();

    expect(attempts).toBe(7);
    expect(inner.run?.snapshot().phase).toBe("ready");
    expect(verdictShowing(booted.root)).toBe(false);
    expect(deckInPlay(booted.root)).toBe(true);
    // The one thing still worth saying: the solve they walked away from did
    // not reach the board.
    expect(booted.toasts.at(-1)).toBe("Request failed (503)");
  });

  test("a second tier solved while the first is still retrying is filed too", async () => {
    const restart = gate();
    let easyAttempts = 0;
    const booted = await boot(async (request) => {
      if (request.path !== "/api/daily/run") return reply(404, {});
      const tier = request.body?.tier as DailyTier;
      if (tier === "easy") {
        easyAttempts += 1;
        // The first easy attempt is lost in a restart that outlasts the
        // medium sheet being played and filed.
        if (easyAttempts === 1) {
          await restart.opened;
          return proxyDown();
        }
      }
      return reply(200, filedBody(true, tier));
    });
    const inner = internals(booted.app);

    const easy = finishEasy(booted);
    await settle();
    inner.showHome();
    await finishTier(booted, "medium");
    restart.open();
    await easy;
    await settle();

    const filings = posts(booted.sent, "/api/daily/run").map((request) => request.body?.tier);
    expect(filings).toEqual(["easy", "medium", "easy"]);
    expect(filedRun(inner, "easy")).not.toBeNull();
    expect(filedRun(inner, "medium")).not.toBeNull();
    // Medium is the sheet on screen, so its result is what is showing.
    expect(panelCaptions(booted.root)).toContain("Result");
  });
});

// ── A practice clear ─────────────────────────────────────────────────────────

describe("a practice clear", () => {
  const practice = PROMPTS[4]!;

  /** The verdict card, which a practice run captions "Practice" (`ui/results.ts`). */
  function resultCardShowing(root: HTMLElement): boolean {
    return panelCaptions(root).includes("Practice");
  }

  test("rides out a restart without a word", async () => {
    let attempts = 0;
    const booted = await boot((request) => {
      if (request.path === `/api/archive/${practice.id}`) return reply(200, { puzzle: practice, solution: null });
      if (request.path !== `/api/puzzles/${practice.id}/clear`) return reply(404, {});
      attempts += 1;
      return attempts === 1 ? proxyDown(503) : reply(200, { solved: true, solution: null });
    });
    const inner = internals(booted.app);
    await inner.openArchivePuzzle(practice.id);

    await inner.finishRun({ ...inner.run!.snapshot(), phase: "solved" }, []);
    await settle();

    expect(posts(booted.sent, `/api/puzzles/${practice.id}/clear`)).toHaveLength(2);
    expect(booted.toasts).not.toContain("Reconnecting…");
  });

  test("that lands after Try again does not put the result card over the new run", async () => {
    let attempts = 0;
    let inner: Internals | null = null;
    const booted = await boot((request) => {
      if (request.path === `/api/archive/${practice.id}`) return reply(200, { puzzle: practice, solution: null });
      if (request.path !== `/api/puzzles/${practice.id}/clear`) return reply(404, {});
      attempts += 1;
      // "Try again" pressed while the first attempt was lost in the restart.
      if (attempts === 1) inner?.startRun();
      return attempts === 1 ? proxyDown(502) : reply(200, { solved: true, solution: null });
    });
    inner = internals(booted.app);
    await inner.openArchivePuzzle(practice.id);

    await inner.finishRun({ ...inner.run!.snapshot(), phase: "solved" }, []);
    // The card is up before the clear has landed — what is pinned is that the
    // late answer does not bring it back.
    expect(attempts).toBe(1);
    await settle();

    expect(attempts).toBe(2);
    expect(inner.run?.snapshot().phase).toBe("ready");
    expect(resultCardShowing(booted.root)).toBe(false);
  });
});
