/**
 * The rules the deploy must never break, whatever a caller asks of it: no pm2
 * command reaches an app the config does not name, nothing is sent to "all",
 * nothing is killed by pattern, a dry run changes nothing, and nothing it
 * reads from pm2 carries an app's environment into its output.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeCommand, exec } from "../tools/deploy/exec";
import { withLock } from "../tools/deploy/lock";
import { parseJlist, pm2Delete, pm2Drain, pm2List, pm2Start, pm2Stop } from "../tools/deploy/pm2";
import { cleanEnvironment, readStatusFile } from "../tools/deploy/real-host";
import { BOT, FakeBox, botStatus, cleanUpBoxes } from "./deploy-harness";

afterEach(cleanUpBoxes);

describe("commands the deploy will never run", () => {
  test("pkill and killall, in any form", () => {
    expect(() => assertSafeCommand(["pkill", "-f", "server/index.ts"])).toThrow(/never/);
    expect(() => assertSafeCommand(["/usr/bin/killall", "bun"])).toThrow(/never/);
  });

  test("pm2 against all, and pm2 verbs it has no use for", () => {
    expect(() => assertSafeCommand(["pm2", "stop", "all"])).toThrow(/all/);
    expect(() => assertSafeCommand(["pm2", "delete", "all"])).toThrow(/all/);
    expect(() => assertSafeCommand(["pm2", "restart", "bcs-bot"])).toThrow(/restart/);
    expect(() => assertSafeCommand(["pm2", "kill"])).toThrow(/kill/);
    expect(() => assertSafeCommand(["pm2", "jlist"])).not.toThrow();
    expect(() => assertSafeCommand(["pm2", "sendSignal", "SIGHUP", "bcs-game-blue"])).not.toThrow();
  });

  test("a SIGUSR signal, which kills Bun 1.3.13 before any handler runs", () => {
    expect(() => assertSafeCommand(["pm2", "sendSignal", "SIGUSR2", "bcs-game-blue"])).toThrow(/SIGUSR2/);
    expect(() => assertSafeCommand(["pm2", "sendSignal", "SIGUSR1", "bcs-game-blue"])).toThrow(/SIGUSR1/);
  });

  test("exec refuses before the runner ever sees the command", async () => {
    const box = new FakeBox();
    await expect(exec(box.context(), { argv: ["pm2", "stop", "all"], mutates: true })).rejects.toThrow();
    expect(box.calls).toEqual([]);
  });
});

describe("pm2 names outside the config", () => {
  test("every pm2 action refuses a name deploy.json does not hold", async () => {
    const box = new FakeBox();
    const ctx = box.context();
    await expect(pm2Delete(ctx, "diayn")).rejects.toThrow(/not named in deploy.json/);
    await expect(pm2Stop(ctx, "diayn")).rejects.toThrow(/not named in deploy.json/);
    await expect(pm2Start(ctx, "diayn")).rejects.toThrow(/not named in deploy.json/);
    await expect(pm2Drain(ctx, "diayn")).rejects.toThrow(/not named in deploy.json/);
    expect(box.calls).toEqual([]);
  });

  test("the process list holds only the config's apps, and no environment", async () => {
    const box = new FakeBox();
    box.addProcess("diayn", "/home/bcs/diayn");
    box.addProcess(BOT, "/home/bcs/bcs/releases/x");
    const list = await pm2List(box.context());
    expect(list.map((p) => p.name)).toEqual([BOT]);
    expect(JSON.stringify(list)).not.toContain("never-printed");
  });
});

describe("reading pm2 jlist", () => {
  test("finds the list past a warning pm2 printed first", () => {
    const text = '[PM2][WARN] Current process list is not synchronized with saved list.\n[{"name":"a","pid":12,"pm2_env":{"status":"online","pm_cwd":"/x"}}]\n';
    expect(parseJlist(text)).toEqual([{ name: "a", pid: 12, status: "online", cwd: "/x" }]);
  });

  test("an empty table is an empty list; garbage is an error", () => {
    expect(parseJlist("[]")).toEqual([]);
    expect(() => parseJlist("pm2: command not found")).toThrow(/pm2 jlist/);
  });
});

describe("a dry run", () => {
  test("prints a command that changes state and does not send it", async () => {
    const box = new FakeBox();
    const result = await exec(box.context({ dryRun: true }), { argv: ["pm2", "save"], mutates: true });
    expect(result.code).toBe(0);
    expect(box.calls).toEqual([]);
    expect(box.output()).toContain("would run: pm2 save");
  });

  test("still runs a read", async () => {
    const box = new FakeBox();
    await exec(box.context({ dryRun: true }), { argv: ["pm2", "jlist"], mutates: false });
    expect(box.calls.map((c) => c.argv)).toEqual([["pm2", "jlist"]]);
  });
});

describe("the environment a command runs with", () => {
  test("carries what a shell needs and none of the secrets Bun loaded from a .env", () => {
    const env = cleanEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/bcs",
      PM2_HOME: "/home/bcs/.pm2",
      LANG: "C.UTF-8",
      DISCORD_TOKEN: "secret",
      SESSION_SECRET: "secret",
      DATABASE_PATH: "/somewhere",
      BOT_API_KEY: "secret",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/bcs", PM2_HOME: "/home/bcs/.pm2", LANG: "C.UTF-8" });
  });
});

describe("one deploy at a time", () => {
  test("a second run is refused while the first holds the lock, and the lock goes when it ends", async () => {
    const box = new FakeBox();
    const ctx = box.context();
    box.alive.add(process.pid);
    await withLock(ctx, async () => {
      await expect(withLock(ctx, async () => "second")).rejects.toThrow(/another deploy/);
    });
    expect(existsSync(box.layout.lock)).toBe(false);
    expect(await withLock(ctx, async () => "after")).toBe("after");
  });

  test("a lock left by a run that died is taken over", async () => {
    const box = new FakeBox();
    mkdirSync(box.layout.run, { recursive: true });
    writeFileSync(box.layout.lock, "999999");
    expect(await withLock(box.context(), async () => "ran")).toBe("ran");
    expect(box.output()).toContain("taking over");
  });

  test("a dry run takes no lock", async () => {
    const box = new FakeBox();
    await withLock(box.context({ dryRun: true }), async () => {
      expect(existsSync(box.layout.lock)).toBe(false);
    });
  });
});

describe("reading a status file from disk", () => {
  test("missing, torn and whole files read as what they are", () => {
    const box = new FakeBox();
    mkdirSync(box.layout.run, { recursive: true });
    const path = join(box.layout.run, "bot.json");
    expect(readStatusFile(path)).toEqual({ present: false, status: null });
    writeFileSync(path, '{"app":"bot"');
    expect(readStatusFile(path)).toEqual({ present: true, status: null });
    const status = botStatus({ pid: 7, buildId: "abc", updatedAt: 1_791_300_000_000 });
    writeFileSync(path, JSON.stringify(status));
    expect(readStatusFile(path)).toEqual({ present: true, status });
  });
});
