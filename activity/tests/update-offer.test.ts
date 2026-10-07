/**
 * The "update ready" chip: when an open activity is told a newer build is
 * being served, and when it says so.
 *
 * A Discord activity stays open for hours and never fetches a new bundle by
 * itself, so after a deploy a player can go on running the old client against
 * the new server indefinitely. The server names its build on every response;
 * the client was compiled with its own; when they differ, the page offers a
 * reload. It **offers** — it never reloads by itself, and it never shows
 * while the player is in the middle of something a reload would throw away.
 *
 * The decisions are pure and pinned here. The chip's markup is small and is
 * driven in happy-dom for the one thing that matters about it: the button
 * reloads only when pressed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  CLIENT_BUILD_ID,
  DEV_BUILD_ID,
  isBuildId,
  isMidPlay,
  type PlayState,
  shouldOfferUpdate,
} from "../client/src/build-id";
import { createUpdateChip, createUpdateNotice, UPDATE_CHIP_TEXT } from "../client/src/ui/update-chip";

describe("shouldOfferUpdate", () => {
  test("two known builds that differ are an update", () => {
    expect(shouldOfferUpdate("a1b2c3d", "e4f5a6b")).toBe(true);
  });

  test("the same build is not", () => {
    expect(shouldOfferUpdate("a1b2c3d", "a1b2c3d")).toBe(false);
  });

  test("nothing heard from the server yet is not", () => {
    expect(shouldOfferUpdate("a1b2c3d", null)).toBe(false);
    expect(shouldOfferUpdate("a1b2c3d", "")).toBe(false);
  });

  test("a development build on either side never is", () => {
    // A dev server rebuilds on every save and a box without git has no commit
    // to name; neither knows what it is, so neither can be out of date.
    expect(shouldOfferUpdate(DEV_BUILD_ID, "a1b2c3d")).toBe(false);
    expect(shouldOfferUpdate("a1b2c3d", DEV_BUILD_ID)).toBe(false);
    expect(shouldOfferUpdate(DEV_BUILD_ID, DEV_BUILD_ID)).toBe(false);
  });

  test("an unbuilt client — this test run included — calls itself dev", () => {
    expect(CLIENT_BUILD_ID).toBe(DEV_BUILD_ID);
  });
});

describe("isBuildId", () => {
  test.each(["a1b2c3d", "0fcedc3", "v1.2.3", "release_2026-10-07", "dev"])("%s is one", (value) => {
    expect(isBuildId(value)).toBe(true);
  });

  test.each(["", " a1b2c3d", "a b", "<b>", "a/b", "x".repeat(65)])("%j is not", (value) => {
    expect(isBuildId(value)).toBe(false);
  });
});

const idle: PlayState = { runPhase: null, rushLive: false, duelOpen: false, testing: false };

describe("isMidPlay", () => {
  test("a screen with nothing running is not", () => {
    expect(isMidPlay(idle)).toBe(false);
  });

  test.each(["ready", "playing"] as const)("a daily or practice run that is %s is", (phase) => {
    expect(isMidPlay({ ...idle, runPhase: phase })).toBe(true);
  });

  test.each(["solved", "failed"] as const)("a run that has %s is over, so it is not", (phase) => {
    expect(isMidPlay({ ...idle, runPhase: phase })).toBe(false);
  });

  test("a rush on the clock is", () => {
    expect(isMidPlay({ ...idle, rushLive: true })).toBe(true);
  });

  test("the rush intro, with no rush running, is not", () => {
    expect(isMidPlay(idle)).toBe(false);
  });

  test("an open duel connection is, lobby and result included", () => {
    expect(isMidPlay({ ...idle, duelOpen: true })).toBe(true);
  });

  test("a draft being played in the builder is", () => {
    expect(isMidPlay({ ...idle, testing: true })).toBe(true);
  });
});

// ── The chip ─────────────────────────────────────────────────────────────────

let window: Window;
const saved = { document: globalThis.document };

beforeAll(() => {
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
});

afterAll(async () => {
  globalThis.document = saved.document;
  await window.happyDOM.close();
});

describe("the chip", () => {
  test("starts hidden, and says what it is when shown", () => {
    const chip = createUpdateChip(() => undefined);

    expect(chip.element.hidden).toBe(true);
    chip.setVisible(true);
    expect(chip.element.hidden).toBe(false);
    expect(chip.element.textContent).toContain(UPDATE_CHIP_TEXT);
    expect(UPDATE_CHIP_TEXT).toBe("Update ready — reload when you're done");
  });

  test("reloads only when its button is pressed", () => {
    let reloads = 0;
    const chip = createUpdateChip(() => {
      reloads += 1;
    });
    chip.setVisible(true);
    chip.setVisible(false);
    chip.setVisible(true);
    expect(reloads).toBe(0);

    const button = chip.element.querySelector("button");
    expect(button?.textContent).toBe("Reload");
    button!.click();

    expect(reloads).toBe(1);
  });

  test("is announced politely, not as an alert", () => {
    const chip = createUpdateChip(() => undefined);

    expect(chip.element.getAttribute("role")).toBe("status");
  });
});

describe("the notice behind the chip", () => {
  /** An api that names builds when told to, the way responses arriving would. */
  function serverNaming(): { api: { onServerBuild(listener: (id: string) => void): () => void }; name(id: string): void } {
    const listeners = new Set<(id: string) => void>();
    let latest: string | null = null;
    return {
      api: {
        onServerBuild(listener) {
          listeners.add(listener);
          if (latest !== null) listener(latest);
          return () => listeners.delete(listener);
        },
      },
      name(id) {
        latest = id;
        for (const listener of listeners) listener(id);
      },
    };
  }

  test("shows as soon as the server names another build, if nothing is running", () => {
    const server = serverNaming();
    const notice = createUpdateNotice({ clientBuild: "a1b2c3d", api: server.api, playState: () => idle, reload: () => undefined });
    expect(notice.element.hidden).toBe(true);

    server.name("e4f5a6b");

    expect(notice.element.hidden).toBe(false);
  });

  test("hears a build named before it existed", () => {
    const server = serverNaming();
    server.name("e4f5a6b");

    const notice = createUpdateNotice({ clientBuild: "a1b2c3d", api: server.api, playState: () => idle, reload: () => undefined });

    expect(notice.element.hidden).toBe(false);
  });

  test("hides when play starts and shows again when it ends, on each look", () => {
    const server = serverNaming();
    let state: PlayState = idle;
    const notice = createUpdateNotice({ clientBuild: "a1b2c3d", api: server.api, playState: () => state, reload: () => undefined });
    server.name("e4f5a6b");

    state = { ...idle, runPhase: "playing" };
    notice.refresh();
    expect(notice.element.hidden).toBe(true);

    state = { ...idle, runPhase: "solved" };
    notice.refresh();
    expect(notice.element.hidden).toBe(false);
  });

  test("goes away again when the server comes back to this page's build", () => {
    // A page loaded from the new process can hear the old one once, during a
    // handover; the next answer from the new one has to take the offer back.
    const server = serverNaming();
    const notice = createUpdateNotice({ clientBuild: "e4f5a6b", api: server.api, playState: () => idle, reload: () => undefined });

    server.name("a1b2c3d");
    expect(notice.element.hidden).toBe(false);
    server.name("e4f5a6b");
    expect(notice.element.hidden).toBe(true);
  });

  test("never reloads by itself", () => {
    const server = serverNaming();
    let reloads = 0;
    const notice = createUpdateNotice({
      clientBuild: "a1b2c3d",
      api: server.api,
      playState: () => idle,
      reload: () => {
        reloads += 1;
      },
    });

    server.name("e4f5a6b");
    notice.refresh();
    server.name("0fcedc3");

    expect(reloads).toBe(0);
  });
});
