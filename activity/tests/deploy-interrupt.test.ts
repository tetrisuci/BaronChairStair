/**
 * A real stop signal must free this run's deploy lock before Bun exits. The
 * worker never runs a deployment: it holds a scratch lock in an unfinished
 * promise, exactly as the CLI does while it waits for a game's drain.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FakeBox, NEW, BLUE, cleanUpBoxes } from "./deploy-harness";
import { withLock } from "../tools/deploy/lock";

afterEach(cleanUpBoxes);

async function heldLock(box: FakeBox, pendingCommand = false) {
  const configPath = join(box.layout.shared, "deploy.json");
  const ready = join(box.home, "held");
  writeFileSync(configPath, JSON.stringify(box.config));
  box.writeState({ game: { release: NEW, previous: null, activeSlot: BLUE } });
  const delayedCommand = `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(ready)}, "ready");
    await Bun.sleep(500);
    writeFileSync(${JSON.stringify(join(box.home, "command-finished"))}, "done");
  `;
  const work = pendingCommand
    ? `await withLock(ctx, () => ctx.host.run({
        argv: [process.execPath, "-e", ${JSON.stringify(delayedCommand)}],
        cwd: ${JSON.stringify(box.home)}, mutates: true
      }));
      writeFileSync(${JSON.stringify(join(box.home, "switch-resumed"))}, "unsafe");`
    : `await withLock(ctx, () => new Promise(() => writeFileSync(${JSON.stringify(ready)}, "ready")));`;
  const source = `
    import { writeFileSync } from "node:fs";
    import { contextFor } from ${JSON.stringify(resolve(import.meta.dir, "../tools/deploy/cli.ts"))};
    import { loadConfig } from ${JSON.stringify(resolve(import.meta.dir, "../tools/deploy/config.ts"))};
    import { withLock } from ${JSON.stringify(resolve(import.meta.dir, "../tools/deploy/lock.ts"))};
    import { realHost } from ${JSON.stringify(resolve(import.meta.dir, "../tools/deploy/real-host.ts"))};
    const ctx = contextFor(loadConfig(${JSON.stringify(configPath)}), realHost, false);
    const keepAlive = setInterval(() => {}, 1000);
    ${work}
    clearInterval(keepAlive);
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    cwd: box.home,
    env: { PATH: process.env.PATH ?? "" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const deadline = Date.now() + 5_000;
  while (!existsSync(ready)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      throw new Error(`lock worker never became ready: ${await output}${await errors}`);
    }
    await Bun.sleep(10);
  }
  return { child, output, errors };
}

describe("interrupting the deploy's lock holder", () => {
  test("an active command finishes under the lock, and the switch never resumes", async () => {
    const box = new FakeBox();
    const { child, output, errors } = await heldLock(box, true);
    try {
      box.alive.add(child.pid);
      child.kill("SIGTERM");
      await Bun.sleep(100);
      expect(child.exitCode).toBeNull();
      expect(existsSync(box.layout.lock)).toBe(true);
      await expect(withLock(box.context(), async () => "another deploy")).rejects.toThrow("another deploy");
      expect(await child.exited).toBe(143);
      expect(existsSync(join(box.home, "command-finished"))).toBe(true);
      expect(existsSync(join(box.home, "switch-resumed"))).toBe(false);
      expect(existsSync(box.layout.lock)).toBe(false);
      expect(await output).toContain("waiting for any active command");
      expect(await errors).toBe("");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    test(`${signal} frees the lock and reports the saved switch and recovery`, async () => {
      const box = new FakeBox();
      const { child, output, errors } = await heldLock(box);
      try {
        expect(readFileSync(box.layout.lock, "utf8")).toBe(String(child.pid));
        child.kill(signal);
        expect(await child.exited).toBe(code);
        expect(existsSync(box.layout.lock)).toBe(false);
        const text = await output;
        expect(text).toContain(signal);
        expect(text).toContain(box.layout.state);
        expect(text).toContain(BLUE);
        expect(text).toContain(NEW);
        expect(text).toContain("status");
        expect(text).toContain("same command");
        expect(await errors).toBe("");
        expect(box.readState().game.release).toBe(NEW);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    });
  }

  test("an interrupt never removes a replacement lock", async () => {
    const box = new FakeBox();
    const { child, output } = await heldLock(box);
    try {
      unlinkSync(box.layout.lock);
      writeFileSync(box.layout.lock, "replacement");
      child.kill("SIGINT");
      await child.exited;
      expect(readFileSync(box.layout.lock, "utf8")).toBe("replacement");
      expect(await output).toContain("replacement was left alone");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });
});
