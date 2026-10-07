/**
 * `switch game <sha>`: the same-port handover. The idle slot starts on the
 * new release beside the live one (both bind the port with reusePort), and
 * only once it reports serving that exact build is the live one told to
 * drain: stop listening, finish its matches, and wait to be stopped.
 *
 * What must never happen: the old process stopped before the new one serves,
 * a duel cut while there is still time to let it finish, or a stale status
 * file mistaken for a healthy new process.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GameStatus } from "../shared/runtime-status";
import { slotStatusFile } from "../tools/deploy/layout";
import { isOnline } from "../tools/deploy/pm2";
import { switchGame } from "../tools/deploy/switch-game";
import { BLUE, FakeBox, GREEN, NEW, NEWER, OLD, cleanUpBoxes, gameStatus } from "./deploy-harness";

afterEach(cleanUpBoxes);

const OPTIONS = { allowCold: false, force: false };

/**
 * Blue serving OLD with one duel in progress; on SIGHUP it drains, and its
 * duel ends `duelLastsMs` later (never, if null). A slot started by pm2
 * reports `starting` for three seconds, then serves the build it was given.
 */
function liveBox(duelLastsMs: number | null = 60_000): FakeBox {
  const box = new FakeBox();
  box.prepareRelease(OLD);
  box.prepareRelease(NEW);
  box.writeState({ game: { activeSlot: BLUE, release: OLD, previous: null } });
  const blue = box.addProcess(BLUE, join(box.layout.releases, OLD, "activity"));
  let drainingSince: number | null = null;
  box.setStatus(slotStatusFile(box.layout, BLUE), (now) =>
    gameStatus({
      pid: blue.pid,
      buildId: OLD,
      updatedAt: now,
      state: drainingSince === null ? "serving" : "draining",
      duelsInMatch:
        drainingSince !== null && duelLastsMs !== null && now - drainingSince >= duelLastsMs ? 0 : 1,
    }),
  );
  box.onSignal = (name, signal) => {
    if (name === BLUE && signal === "SIGHUP") drainingSince = box.now;
  };
  box.onStart = (name, app, pid) => {
    const startedAt = box.now;
    box.setStatus(slotStatusFile(box.layout, name), (now) =>
      gameStatus({
        pid,
        buildId: app.env.BUILD_ID!,
        updatedAt: now,
        startedAt,
        state: now - startedAt >= 3_000 ? "serving" : "starting",
      }),
    );
  };
  return box;
}

function ecosystemNames(box: FakeBox): string[] {
  const text = readFileSync(box.layout.ecosystem, "utf8");
  return [...text.matchAll(/"name": "([^"]+)"/g)].map((match) => match[1]!);
}

describe("a handover", () => {
  test("starts the idle slot, drains the live one once the new one serves, then stops it", async () => {
    const box = liveBox();
    let signalledAt = 0;
    const onStart = box.onStart;
    let startedAt = 0;
    box.onStart = (name, app, pid) => {
      startedAt = box.now;
      onStart(name, app, pid);
    };
    const onSignal = box.onSignal;
    box.onSignal = (name, signal) => {
      signalledAt = box.now;
      onSignal(name, signal);
    };

    await switchGame(box.context(), NEW, OPTIONS);

    expect(box.pm2Mutations()).toEqual([
      ["start", box.layout.ecosystem, "--only", GREEN],
      ["sendSignal", "SIGHUP", BLUE],
      ["stop", BLUE],
      ["delete", BLUE],
      ["save"],
    ]);
    expect(signalledAt - startedAt).toBeGreaterThanOrEqual(3_000);
    expect(box.readState().game).toEqual({ activeSlot: GREEN, release: NEW, previous: OLD });
    expect(ecosystemNames(box)).toEqual([GREEN]);
  });

  test("waits for the drain before stopping, and reports progress while it waits", async () => {
    const box = liveBox(5 * 60_000);
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.output()).toMatch(/draining bcs-game-blue: 1 duel, 0 in flight/);
    expect(box.output()).toContain("bcs-game-blue has drained");
  });

  test("deletes a leftover idle slot before starting it again", async () => {
    const box = liveBox();
    box.addProcess(GREEN, join(box.layout.releases, OLD, "activity"), "stopped");
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations().slice(0, 2)).toEqual([
      ["delete", GREEN],
      ["start", box.layout.ecosystem, "--only", GREEN],
    ]);
  });

  test("the next switch goes back the other way", async () => {
    const box = liveBox(0);
    box.prepareRelease(NEWER);
    await switchGame(box.context(), NEW, OPTIONS);
    const green = box.processes.get(GREEN)!;
    let drainingSince: number | null = null;
    box.setStatus(slotStatusFile(box.layout, GREEN), (now) =>
      gameStatus({ pid: green.pid, buildId: NEW, updatedAt: now, state: drainingSince === null ? "serving" : "draining" }),
    );
    box.onSignal = (name) => {
      if (name === GREEN) drainingSince = box.now;
    };
    box.calls.length = 0;
    await switchGame(box.context(), NEWER, OPTIONS);
    expect(box.pm2Mutations()[0]).toEqual(["start", box.layout.ecosystem, "--only", BLUE]);
    expect(box.readState().game).toEqual({ activeSlot: BLUE, release: NEWER, previous: NEW });
  });

  test("a release already being served is not switched again without --force", async () => {
    const box = liveBox();
    box.writeState({ game: { activeSlot: BLUE, release: NEW, previous: OLD } });
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([]);
    expect(box.output()).toContain("already serves");
  });

  test("a missing shared/daily.sqlite is refused: the game would quietly create an empty one", async () => {
    const box = liveBox();
    rmSync(join(box.layout.shared, "daily.sqlite"));
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/daily\.sqlite/);
    expect(box.pm2Mutations()).toEqual([]);
  });

  test("an unprepared release is refused before anything runs", async () => {
    const box = liveBox();
    await expect(switchGame(box.context(), NEWER, OPTIONS)).rejects.toThrow(/not prepared/);
    expect(box.pm2Mutations()).toEqual([]);
  });
});

describe("a new slot that never comes up", () => {
  test("is stopped after the timeout, and the live slot is never touched", async () => {
    const box = liveBox();
    box.onStart = (name, app, pid) => {
      box.setStatus(slotStatusFile(box.layout, name), (now) =>
        gameStatus({ pid, buildId: app.env.BUILD_ID!, updatedAt: now, state: "starting" }),
      );
    };
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/did not report serving/);
    expect(box.pm2Mutations()).toEqual([
      ["start", box.layout.ecosystem, "--only", GREEN],
      ["stop", GREEN],
      ["delete", GREEN],
    ]);
    expect(box.readState().game).toEqual({ activeSlot: BLUE, release: OLD, previous: null });
    expect(box.processes.get(BLUE)!.status).toBe("online");
  });

  test("a status naming another build does not count as serving this one", async () => {
    const box = liveBox();
    box.onStart = (name, _app, pid) => {
      box.setStatus(slotStatusFile(box.layout, name), (now) => gameStatus({ pid, buildId: OLD, updatedAt: now }));
    };
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/did not report serving/);
  });

  test("a stale status left by an earlier process does not count either", async () => {
    const box = liveBox();
    const writtenAt = box.now;
    box.onStart = (name, _app, pid) => {
      box.setStatus(slotStatusFile(box.layout, name), () =>
        gameStatus({ pid, buildId: NEW, updatedAt: writtenAt - 60_000 }),
      );
    };
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/did not report serving/);
  });

  test("a status whose process is dead does not count", async () => {
    const box = liveBox();
    box.onStart = (name, _app, _pid) => {
      box.setStatus(slotStatusFile(box.layout, name), (now) => gameStatus({ pid: 99_999, buildId: NEW, updatedAt: now }));
    };
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/did not report serving/);
  });
});

describe("pm2 refusing to start the new slot", () => {
  test("leaves the live slot alone and the ecosystem listing only it", async () => {
    const box = liveBox();
    box.respond = (command) =>
      command.argv[1] === "start" ? { code: 1, stdout: "", stderr: "[PM2][ERROR] File ecosystem.config.cjs malformed" } : undefined;
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/pm2 start/);
    expect(ecosystemNames(box)).toEqual([BLUE]);
    expect(box.processes.get(BLUE)!.status).toBe("online");
    expect(box.readState().game).toEqual({ activeSlot: BLUE, release: OLD, previous: null });
  });
});

describe("while the old slot drains", () => {
  test("stops the old slot at the limit anyway, and says how many duels it cut", async () => {
    const box = liveBox(null);
    const started = box.now;
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.now - started).toBeGreaterThanOrEqual(20 * 60_000);
    expect(box.now - started).toBeLessThan(21 * 60_000);
    expect(box.pm2Mutations().slice(1)).toEqual([["sendSignal", "SIGHUP", BLUE], ["stop", BLUE], ["delete", BLUE], ["save"]]);
    expect(box.output()).toMatch(/drain limit .*1 duel/);
  });

  test("a status that goes stale mid-drain is waited out, not taken for a process that is gone", async () => {
    // A long synchronous write stalls blue's event loop for 90 s: its status
    // stops being rewritten, but the process, and its duel, are still there.
    const box = liveBox(3 * 60_000);
    const file = slotStatusFile(box.layout, BLUE);
    const written = box.statuses.get(file)!;
    let signalledAt: number | null = null;
    const onSignal = box.onSignal;
    box.onSignal = (name, signal) => {
      signalledAt = box.now;
      onSignal(name, signal);
    };
    box.setStatus(file, (now) => {
      const status = written(now) as GameStatus;
      const stalled = signalledAt !== null && now - signalledAt >= 10_000 && now - signalledAt < 100_000;
      return stalled ? { ...status, updatedAt: signalledAt! + 10_000 } : status;
    });
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.output()).toMatch(/draining bcs-game-blue: status stale/);
    expect(box.output()).toContain("bcs-game-blue has drained");
    expect(box.now - signalledAt!).toBeGreaterThanOrEqual(3 * 60_000);
  });

  test("a status file that disappears while the process lives is waited on to the limit", async () => {
    const box = liveBox(null);
    box.onSignal = () => {
      box.statuses.delete(slotStatusFile(box.layout, BLUE));
    };
    const started = box.now;
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.now - started).toBeGreaterThanOrEqual(20 * 60_000);
    expect(box.output()).toMatch(/draining bcs-game-blue: no status file/);
    expect(box.output()).toMatch(/drain limit/);
  });

  test("an old slot whose process exits mid-drain is stopped without waiting out the limit", async () => {
    const box = liveBox(null);
    const blue = box.processes.get(BLUE)!;
    box.onSignal = (name) => {
      if (name !== BLUE) return;
      box.alive.delete(blue.pid);
      box.statuses.delete(slotStatusFile(box.layout, BLUE));
    };
    const started = box.now;
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.now - started).toBeLessThan(2 * 60_000);
    expect(box.output()).toMatch(/bcs-game-blue's process .* is gone/);
    expect(box.pm2Mutations().slice(-3)).toEqual([["stop", BLUE], ["delete", BLUE], ["save"]]);
  });

  test("an old slot pm2 restarted mid-drain (a new pid, on the old code) is stopped at once", async () => {
    const box = liveBox(null);
    box.onSignal = (name) => {
      if (name !== BLUE) return;
      const restarted = 7_777;
      box.alive.add(restarted);
      box.setStatus(slotStatusFile(box.layout, BLUE), (now) => gameStatus({ pid: restarted, buildId: OLD, updatedAt: now }));
    };
    const started = box.now;
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.now - started).toBeLessThan(2 * 60_000);
    expect(box.output()).toMatch(/restarted/);
    expect(box.pm2Mutations().slice(-3)).toEqual([["stop", BLUE], ["delete", BLUE], ["save"]]);
  });
});

describe("the first switch from code that writes no status file", () => {
  /**
   * Blue runs code from before the contract: it writes no status file, and it
   * bound the port without reusePort, so nothing else can bind it while blue
   * is up (Bun 1.3.13 and Linux both refuse). The fake pm2 brings green up
   * only if blue was not running when green started.
   */
  function coldBox(): FakeBox {
    const box = liveBox();
    box.statuses.delete(slotStatusFile(box.layout, BLUE));
    box.writeState({});
    const onStart = box.onStart;
    box.onStart = (name, app, pid) => {
      if (name === GREEN && isOnline(box.processes.get(BLUE))) return;
      onStart(name, app, pid);
    };
    return box;
  }

  test("is refused without --allow-cold, before anything starts", async () => {
    const box = coldBox();
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/--allow-cold/);
    expect(box.pm2Mutations()).toEqual([]);
  });

  test("with --allow-cold, stops the old process first: the new one cannot bind the port beside it", async () => {
    const box = coldBox();
    await switchGame(box.context(), NEW, { allowCold: true, force: false });
    expect(box.pm2Mutations()).toEqual([
      ["stop", BLUE],
      ["start", box.layout.ecosystem, "--only", GREEN],
      ["delete", BLUE],
      ["save"],
    ]);
    expect(box.output()).toContain("like a restart");
    expect(box.readState().game).toEqual({ activeSlot: GREEN, release: NEW, previous: null });
  });

  test("with --allow-cold, a new slot that never serves says the game is down and how to bring the old one back", async () => {
    const box = coldBox();
    box.onStart = () => {};
    await expect(switchGame(box.context(), NEW, { allowCold: true, force: false })).rejects.toThrow(
      /game is down[\s\S]*pm2 start bcs-game-blue/,
    );
    expect(box.processes.get(BLUE)!.status).toBe("stopped");
    expect(box.processes.has(GREEN)).toBe(false);
    expect(box.readState().game).toEqual({ activeSlot: null, release: null, previous: null });
  });
});

describe("a box in a state the switch cannot reason about", () => {
  test("both slots running is refused", async () => {
    const box = liveBox();
    box.addProcess(GREEN, join(box.layout.releases, NEW, "activity"));
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/both game slots/i);
    expect(box.pm2Mutations()).toEqual([]);
  });

  test("nothing running at all starts the first slot, with nothing to drain", async () => {
    const box = liveBox();
    box.processes.clear();
    box.writeState({});
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([["start", box.layout.ecosystem, "--only", BLUE], ["save"]]);
  });
});
