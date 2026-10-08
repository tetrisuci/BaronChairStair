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
import { rollback } from "../tools/deploy/deploy";
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

/**
 * After a switch from blue on OLD to green on NEW, as far as state.json goes:
 * green serves NEW and state names it. Blue is in pm2 as `blue` says: absent,
 * stopped, or still online (draining, with `duelLastsMs` of match left from
 * the start of the test, or forever if null).
 */
function servingBox(blue: "absent" | "stopped" | "online" = "absent", duelLastsMs: number | null = 60_000): FakeBox {
  const box = new FakeBox();
  box.prepareRelease(OLD);
  box.prepareRelease(NEW);
  box.writeState({ game: { activeSlot: GREEN, release: NEW, previous: OLD } });
  const green = box.addProcess(GREEN, join(box.layout.releases, NEW, "activity"));
  box.setStatus(slotStatusFile(box.layout, GREEN), (now) => gameStatus({ pid: green.pid, buildId: NEW, updatedAt: now }));
  if (blue === "absent") return box;
  const old = box.addProcess(BLUE, join(box.layout.releases, OLD, "activity"), blue);
  if (blue === "online") {
    const started = box.now;
    box.setStatus(slotStatusFile(box.layout, BLUE), (now) =>
      gameStatus({
        pid: old.pid,
        buildId: OLD,
        updatedAt: now,
        state: "draining",
        duelsInMatch: duelLastsMs !== null && now - started >= duelLastsMs ? 0 : 1,
      }),
    );
  }
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
    // Serving, then still serving from the same pid 5 s later, before the drain.
    expect(signalledAt - startedAt).toBeGreaterThanOrEqual(3_000 + 5_000);
    expect(box.readState().game).toEqual({ activeSlot: GREEN, release: NEW, previous: OLD });
    expect(ecosystemNames(box)).toEqual([GREEN]);
    expect(box.output()).not.toContain("warning");
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

  test("a release already being served is not switched again without --force; pm2's list is saved", async () => {
    const box = servingBox();
    await switchGame(box.context(), NEW, OPTIONS);
    // Only the save: a run interrupted between the handover and its `pm2 save` left pm2's saved list on the old slot.
    expect(box.pm2Mutations()).toEqual([["save"]]);
    expect(box.output()).toContain("already serves");
    expect(box.readState().game).toEqual({ activeSlot: GREEN, release: NEW, previous: OLD });
    expect(ecosystemNames(box)).toEqual([GREEN]);
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

  /*
   * Found in the rehearsal on a real box layout: the refusal used to say only
   * "stop it with `pm2 stop <name>` and run this again". Done that way, the
   * stopped slot stays in pm2's table and the run again answers "nothing to
   * do" without a `pm2 save`, so pm2's saved list is still the one from before
   * the interrupted switch — a reboot resurrects the old slot on old code and
   * not the new one. The README's recovery is stop, delete, save.
   */
  test("the refusal names the slot to take out, and the whole recovery: stop, delete, save", async () => {
    // Green, which state names, writes no status: the switch cannot finish the drain, so it refuses.
    const box = liveBox();
    box.writeState({ game: { activeSlot: GREEN, release: NEW, previous: OLD } });
    box.addProcess(GREEN, join(box.layout.releases, NEW, "activity"));
    const refusal = await switchGame(box.context(), NEW, OPTIONS).then(
      () => null,
      (error: Error) => error.message,
    );
    expect(refusal).toContain(`state.json names ${GREEN}`);
    expect(refusal).toContain(`pm2 stop ${BLUE}`);
    expect(refusal).toContain(`pm2 delete ${BLUE}`);
    expect(refusal).toContain("pm2 save");
    expect(box.pm2Mutations()).toEqual([]);
  });

  test("with state.json naming neither running slot, the refusal says so rather than guessing which to take out", async () => {
    const box = liveBox();
    box.writeState({});
    box.addProcess(GREEN, join(box.layout.releases, NEW, "activity"));
    const refusal = await switchGame(box.context(), NEW, OPTIONS).then(
      () => null,
      (error: Error) => error.message,
    );
    expect(refusal).toMatch(/names neither/);
    expect(refusal).not.toContain(`pm2 delete ${BLUE}`);
    expect(refusal).not.toContain(`pm2 delete ${GREEN}`);
    expect(refusal).toContain("pm2 save");
  });

  test("nothing running at all starts the first slot, with nothing to drain", async () => {
    const box = liveBox();
    box.processes.clear();
    box.writeState({});
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([["start", box.layout.ecosystem, "--only", BLUE], ["save"]]);
  });
});

/*
 * A new slot can report serving and still not last: a release whose game
 * crashes a few seconds after it binds the port, on a timer or its first duel
 * socket, and that pm2 restarts in a loop. The drain cannot be undone — told
 * once, the old slot stops listening for good — so the new slot must stay up
 * before it is sent, and is watched while it runs.
 */
describe("a new slot that serves, then does not stay up", () => {
  /** Green serves 3 s after its start and its process dies `diesAfterMs` after that start. */
  function dyingBox(diesAfterMs: (startedAt: number, signalledAt: number | null) => number): {
    box: FakeBox;
    signalled: () => number | null;
  } {
    const box = liveBox(null);
    let signalledAt: number | null = null;
    const onSignal = box.onSignal;
    box.onSignal = (name, signal) => {
      signalledAt = box.now;
      onSignal(name, signal);
    };
    box.onStart = (name, app, pid) => {
      const startedAt = box.now;
      box.setStatus(slotStatusFile(box.layout, name), (now) => {
        if (now - startedAt >= diesAfterMs(startedAt, signalledAt)) box.alive.delete(pid);
        return gameStatus({ pid, buildId: app.env.BUILD_ID!, updatedAt: now, startedAt, state: now - startedAt >= 3_000 ? "serving" : "starting" });
      });
    };
    return { box, signalled: () => signalledAt };
  }

  test("dying within seconds of serving: it is stopped before the live slot is told anything", async () => {
    const { box } = dyingBox(() => 5_000);
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/did not stay up[\s\S]*bcs-game-blue was not touched/);
    expect(box.pm2Mutations()).toEqual([
      ["start", box.layout.ecosystem, "--only", GREEN],
      ["stop", GREEN],
      ["delete", GREEN],
    ]);
    expect(box.processes.get(BLUE)!.status).toBe("online");
    expect(box.readState().game).toEqual({ activeSlot: BLUE, release: OLD, previous: null });
    expect(ecosystemNames(box)).toEqual([BLUE]);
  });

  test("restarted by pm2 within seconds of serving (a new pid): the same", async () => {
    const box = liveBox(null);
    box.onStart = (name, app, firstPid) => {
      const startedAt = box.now;
      box.setStatus(slotStatusFile(box.layout, name), (now) => {
        // pm2 restarts it every 4 s: a new pid, serving again 3 s later.
        const restarts = Math.floor((now - startedAt) / 4_000);
        const pid = firstPid + restarts * 1_000;
        box.alive.add(pid);
        const since = now - startedAt - restarts * 4_000;
        return gameStatus({ pid, buildId: app.env.BUILD_ID!, updatedAt: now, state: since >= 3_000 ? "serving" : "starting" });
      });
    };
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/did not stay up/);
    expect(box.pm2Mutations().some((argv) => argv[0] === "sendSignal")).toBe(false);
    expect(box.processes.get(BLUE)!.status).toBe("online");
  });

  test("dying mid-drain: the wait ends at once, the old slot is not stopped, and the error says how to recover", async () => {
    const { box, signalled } = dyingBox((_startedAt, signalledAt) => (signalledAt === null ? Infinity : signalledAt - _startedAt + 60_000));
    const error = (await switchGame(box.context(), NEW, OPTIONS).catch((caught: unknown) => caught)) as Error;
    expect(error.message).toMatch(/bcs-game-green, the new slot on 2222222, stopped serving while bcs-game-blue drained/);
    expect(error.message).toMatch(/no longer listens/);
    expect(error.message).toMatch(/still holds its matches/);
    expect(error.message).toContain("bun run deploy switch game 2222222");
    expect(error.message).toContain(`pm2 stop ${GREEN}`);
    expect(error.message).toContain("bun run deploy rollback game");
    expect(box.now - signalled()!).toBeLessThan(2 * 60_000);
    expect(box.pm2Mutations()).toEqual([
      ["start", box.layout.ecosystem, "--only", GREEN],
      ["sendSignal", "SIGHUP", BLUE],
    ]);
    expect(box.processes.get(BLUE)!.status).toBe("online");
    expect(box.readState().game).toEqual({ activeSlot: GREEN, release: NEW, previous: OLD });
  });

  test("restarted by pm2 mid-drain: the same, without stopping the old slot", async () => {
    const box = liveBox(null);
    let signalledAt: number | null = null;
    const onSignal = box.onSignal;
    box.onSignal = (name, signal) => {
      signalledAt = box.now;
      onSignal(name, signal);
    };
    box.onStart = (name, app, pid) => {
      box.setStatus(slotStatusFile(box.layout, name), (now) => {
        const restarted = signalledAt !== null && now - signalledAt >= 30_000;
        const current = restarted ? pid + 1_000 : pid;
        box.alive.add(current);
        return gameStatus({ pid: current, buildId: app.env.BUILD_ID!, updatedAt: now });
      });
    };
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/pm2 restarted bcs-game-green/);
    expect(box.pm2Mutations().map((argv) => argv[0])).toEqual(["start", "sendSignal"]);
  });

  test("a new slot whose status goes stale at the end of the drain, and stays so, keeps the old slot from being stopped", async () => {
    const box = liveBox(60_000);
    let signalledAt: number | null = null;
    const onSignal = box.onSignal;
    box.onSignal = (name, signal) => {
      signalledAt = box.now;
      onSignal(name, signal);
    };
    box.onStart = (name, app, pid) => {
      box.setStatus(slotStatusFile(box.layout, name), (now) => {
        // Frozen 30 s before the duel ends: stale (over 20 s old) when the drain finishes, and from then on.
        const frozenAt = signalledAt === null ? null : signalledAt + 30_000;
        return gameStatus({ pid, buildId: app.env.BUILD_ID!, updatedAt: frozenAt !== null && now > frozenAt ? frozenAt : now });
      });
    };
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/stopped serving while bcs-game-blue drained: status stale/);
    expect(box.pm2Mutations().map((argv) => argv[0])).toEqual(["start", "sendSignal"]);
  });

  test("a status that goes stale for a moment at the end of the drain is waited for, and the switch finishes", async () => {
    const box = liveBox(60_000);
    let signalledAt: number | null = null;
    const onSignal = box.onSignal;
    box.onSignal = (name, signal) => {
      signalledAt = box.now;
      onSignal(name, signal);
    };
    box.onStart = (name, app, pid) => {
      box.setStatus(slotStatusFile(box.layout, name), (now) => {
        // Stale when the drain finishes 60 s in, fresh again 15 s later.
        const stalled = signalledAt !== null && now - signalledAt >= 30_000 && now - signalledAt < 75_000;
        return gameStatus({ pid, buildId: app.env.BUILD_ID!, updatedAt: stalled ? signalledAt! + 30_000 : now });
      });
    };
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations().map((argv) => argv[0])).toEqual(["start", "sendSignal", "stop", "delete", "save"]);
  });
});

/*
 * state.json names the new slot as soon as it serves, before the drain, and
 * pm2's list is saved only at the very end. A run that stops anywhere between
 * — Ctrl-C, a dropped SSH session, a pm2 command that failed — used to leave a
 * re-run answering "nothing to do": the old slot stayed in pm2's table and
 * pm2's saved list still named it, so a reboot brought the old code back.
 * Running the same switch again finishes the job instead.
 */
describe("running a switch again after it was interrupted", () => {
  test("a stopped old slot left in pm2's table is taken out, and pm2's list is saved", async () => {
    const box = servingBox("stopped");
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([["delete", BLUE], ["save"]]);
    expect(box.processes.has(BLUE)).toBe(false);
    expect(box.processes.get(GREEN)!.status).toBe("online");
    expect(box.readState().game).toEqual({ activeSlot: GREEN, release: NEW, previous: OLD });
    expect(ecosystemNames(box)).toEqual([GREEN]);
    expect(box.output()).not.toContain("nothing to do");
  });

  test("the reviewer's case: pm2 delete failed after the drain, and the re-run finishes", async () => {
    const box = liveBox(0);
    let failDelete = true;
    box.respond = (command) =>
      failDelete && command.argv.join(" ") === `pm2 delete ${BLUE}` ? { code: 1, stdout: "", stderr: "[PM2][ERROR] boom" } : undefined;
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/pm2 delete bcs-game-blue failed/);
    expect(box.readState().game).toEqual({ activeSlot: GREEN, release: NEW, previous: OLD });
    expect(box.processes.get(BLUE)!.status).toBe("stopped");

    failDelete = false;
    box.calls.length = 0;
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([["delete", BLUE], ["save"]]);
    expect(box.processes.has(BLUE)).toBe(false);
  });

  test("an old slot still running mid-drain is drained to its end, stopped and taken out", async () => {
    const box = servingBox("online", 3 * 60_000);
    const started = box.now;
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([["sendSignal", "SIGHUP", BLUE], ["stop", BLUE], ["delete", BLUE], ["save"]]);
    expect(box.now - started).toBeGreaterThanOrEqual(3 * 60_000);
    expect(box.output()).toMatch(/interrupted/);
    expect(box.readState().game).toEqual({ activeSlot: GREEN, release: NEW, previous: OLD });
  });

  test("an old slot still running is drained only to the usual limit", async () => {
    const box = servingBox("online", null);
    const started = box.now;
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.now - started).toBeGreaterThanOrEqual(20 * 60_000);
    expect(box.now - started).toBeLessThan(21 * 60_000);
    expect(box.output()).toMatch(/drain limit/);
    expect(box.pm2Mutations().slice(-3)).toEqual([["stop", BLUE], ["delete", BLUE], ["save"]]);
  });

  test("an old slot still running that cannot be told to drain is refused, nothing touched", async () => {
    const box = servingBox("online");
    box.statuses.delete(slotStatusFile(box.layout, BLUE));
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/both game slots[\s\S]*pm2 delete bcs-game-blue/);
    expect(box.pm2Mutations()).toEqual([]);
  });

  test("the slot state names is never the one taken out, even when it is not serving", async () => {
    const box = servingBox("online");
    box.statuses.delete(slotStatusFile(box.layout, GREEN));
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/both game slots/);
    expect(box.pm2Mutations()).toEqual([]);
  });

  test("a recorded slot that serves another build is switched again, not answered 'already serves'", async () => {
    const box = servingBox();
    const green = box.processes.get(GREEN)!;
    box.setStatus(slotStatusFile(box.layout, GREEN), (now) => gameStatus({ pid: green.pid, buildId: OLD, updatedAt: now }));
    box.onStart = (name, app, pid) => {
      box.setStatus(slotStatusFile(box.layout, name), (now) => gameStatus({ pid, buildId: app.env.BUILD_ID!, updatedAt: now }));
    };
    box.onSignal = (name) => {
      if (name === GREEN) box.alive.delete(green.pid);
    };
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.output()).toMatch(/does not serve 2222222/);
    expect(box.pm2Mutations()[0]).toEqual(["start", box.layout.ecosystem, "--only", BLUE]);
    expect(box.readState().game.activeSlot).toBe(BLUE);
  });
});

/*
 * The live slot crashed and pm2 shows it errored, or it was stopped by hand,
 * or it is gone from pm2: state.json still records the release. Running the
 * switch to that release again is the way to bring the game back, and must
 * start it rather than answer "already serves".
 */
describe("a release state.json already records, but that pm2 does not run", () => {
  function recordedBox(green: "stopped" | "errored" | "absent"): FakeBox {
    const box = liveBox();
    box.processes.clear();
    box.statuses.delete(slotStatusFile(box.layout, BLUE));
    box.writeState({ game: { activeSlot: GREEN, release: NEW, previous: OLD } });
    if (green !== "absent") box.addProcess(GREEN, join(box.layout.releases, NEW, "activity"), green);
    return box;
  }

  for (const green of ["stopped", "errored"] as const) {
    test(`${green} in pm2: a slot is started on it, and the ${green} entry taken out`, async () => {
      const box = recordedBox(green);
      await switchGame(box.context(), NEW, OPTIONS);
      expect(box.pm2Mutations()).toEqual([["start", box.layout.ecosystem, "--only", BLUE], ["delete", GREEN], ["save"]]);
      expect(box.output()).not.toContain("already serves");
      expect(box.readState().game).toEqual({ activeSlot: BLUE, release: NEW, previous: OLD });
      expect(ecosystemNames(box)).toEqual([BLUE]);
    });
  }

  test("stopped seconds ago, its last status still fresh and its pid taken by another process: pm2 decides, and it is started", async () => {
    const box = recordedBox("stopped");
    const reused = 4_242;
    box.alive.add(reused);
    box.setStatus(slotStatusFile(box.layout, GREEN), (now) => gameStatus({ pid: reused, buildId: NEW, updatedAt: now - 5_000 }));
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([["start", box.layout.ecosystem, "--only", BLUE], ["delete", GREEN], ["save"]]);
  });

  test("gone from pm2: a slot is started on it", async () => {
    const box = recordedBox("absent");
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([["start", box.layout.ecosystem, "--only", BLUE], ["save"]]);
    expect(box.readState().game).toEqual({ activeSlot: BLUE, release: NEW, previous: OLD });
  });
});

describe("the two ways back that error names, after a new slot died mid-drain", () => {
  /** Green on NEW dies a minute into blue's drain; blue's duel ends three minutes after it is told to drain. */
  async function diedMidDrain(): Promise<FakeBox> {
    const box = liveBox(3 * 60_000);
    let crashing = true;
    let signalledAt: number | null = null;
    const onSignal = box.onSignal;
    box.onSignal = (name, signal) => {
      signalledAt = box.now;
      onSignal(name, signal);
    };
    box.onStart = (name, app, pid) => {
      const mortal = crashing;
      box.setStatus(slotStatusFile(box.layout, name), (now) => {
        if (mortal && signalledAt !== null && now - signalledAt >= 60_000) box.alive.delete(pid);
        return gameStatus({ pid, buildId: app.env.BUILD_ID!, updatedAt: now });
      });
    };
    await expect(switchGame(box.context(), NEW, OPTIONS)).rejects.toThrow(/stopped serving while/);
    crashing = false;
    box.calls.length = 0;
    return box;
  }

  test("roll back: pm2 stop the new slot, then rollback game starts it on the old release and finishes the drain", async () => {
    const box = await diedMidDrain();
    Object.assign(box.processes.get(GREEN)!, { status: "stopped", pid: 0 });
    await rollback(box.context(), "game", { allowCold: false, now: false, force: false });
    expect(box.pm2Mutations()).toEqual([
      ["delete", GREEN],
      ["start", box.layout.ecosystem, "--only", GREEN],
      ["sendSignal", "SIGHUP", BLUE],
      ["stop", BLUE],
      ["delete", BLUE],
      ["save"],
    ]);
    expect(box.readState().game).toEqual({ activeSlot: GREEN, release: OLD, previous: NEW });
    expect(box.processes.get(GREEN)!.cwd).toBe(join(box.layout.releases, OLD, "activity"));
    expect(box.processes.has(BLUE)).toBe(false);
  });

  test("start it again: once the new slot serves, the same switch finishes the drain", async () => {
    const box = await diedMidDrain();
    const green = box.processes.get(GREEN)!;
    green.pid = 9_999;
    box.alive.add(green.pid);
    box.setStatus(slotStatusFile(box.layout, GREEN), (now) => gameStatus({ pid: green.pid, buildId: NEW, updatedAt: now }));
    await switchGame(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([["sendSignal", "SIGHUP", BLUE], ["stop", BLUE], ["delete", BLUE], ["save"]]);
    expect(box.readState().game).toEqual({ activeSlot: GREEN, release: NEW, previous: OLD });
    expect(ecosystemNames(box)).toEqual([GREEN]);
  });
});
