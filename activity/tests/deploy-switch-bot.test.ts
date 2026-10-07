/**
 * `switch bot <sha>`: one Discord token, so there is no overlap — two copies
 * would answer every command twice. The bot is restarted only when its own
 * files changed, only once it is quiet (nobody mid-command, no sync running,
 * nothing for a minute), and the old process is gone before the new one starts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { botStatusFile } from "../tools/deploy/layout";
import { switchBot } from "../tools/deploy/switch-bot";
import { BOT, FakeBox, NEW, OLD, START, botStatus, cleanUpBoxes } from "./deploy-harness";

afterEach(cleanUpBoxes);

const OPTIONS = { force: false, now: false };

/** The bot on OLD, last used `idleForMs` before the test starts. */
function botBox(fields: { idleForMs?: number; inflightUntil?: number; syncUntil?: number } = {}): FakeBox {
  const box = new FakeBox();
  box.prepareRelease(OLD);
  box.prepareRelease(NEW);
  box.writeState({ bot: { release: OLD, previous: null } });
  box.diff = ["client/puzzle_commands.py", "activity/server/index.ts"];
  const bot = box.addProcess(BOT, join(box.layout.releases, OLD));
  box.setStatus(botStatusFile(box.layout), (now) =>
    botStatus({
      pid: bot.pid,
      buildId: OLD,
      updatedAt: now,
      lastInteractionAt: START - (fields.idleForMs ?? 10 * 60_000),
      inflight: now < (fields.inflightUntil ?? 0) ? 1 : 0,
      syncRunning: now < (fields.syncUntil ?? 0),
    }),
  );
  box.onStart = (_name, app, pid) => {
    const startedAt = box.now;
    box.setStatus(botStatusFile(box.layout), (now) =>
      botStatus({ pid, buildId: app.env.BUILD_ID!, updatedAt: now, startedAt, state: now - startedAt >= 8_000 ? "ready" : "starting" }),
    );
  };
  return box;
}

/** When the old bot was deleted, read after the switch; -1 if it never was. */
function watchDelete(box: FakeBox): { at: number } {
  const seen = { at: -1 };
  const run = box.run.bind(box);
  box.run = async (command) => {
    if (command.argv[0] === "pm2" && command.argv[1] === "delete") seen.at = box.now;
    return run(command);
  };
  return seen;
}

describe("a bot whose files did not change", () => {
  test("is not restarted; the new release is only recorded", async () => {
    const box = botBox();
    box.diff = ["activity/server/index.ts", "activity/client/src/app.ts"];
    await switchBot(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([]);
    expect(box.readState().bot).toEqual({ release: NEW, previous: OLD });
    expect(box.output()).toContain("without restarting");
    expect(box.calls.map((call) => call.argv.slice(3, 5))).toContainEqual(["diff", "--name-only"]);
  });

  test("is restarted anyway with --force", async () => {
    const box = botBox();
    box.diff = [];
    await switchBot(box.context(), NEW, { force: true, now: false });
    expect(box.pm2Mutations()).toEqual([["delete", BOT], ["start", box.layout.ecosystem, "--only", BOT], ["save"]]);
  });
});

describe("a bot whose files changed", () => {
  test("is replaced once quiet: delete first, then start, then wait for ready on the new build", async () => {
    const box = botBox();
    await switchBot(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([["delete", BOT], ["start", box.layout.ecosystem, "--only", BOT], ["save"]]);
    expect(box.readState().bot).toEqual({ release: NEW, previous: OLD });
    expect(box.processes.get(BOT)!.cwd).toBe(join(box.layout.releases, NEW));
  });

  test("waits for a command in flight and a running sync to finish, and a minute of quiet after", async () => {
    const box = botBox({ idleForMs: 0, inflightUntil: START + 45_000, syncUntil: START + 3 * 60_000 });
    const deleted = watchDelete(box);
    await switchBot(box.context(), NEW, OPTIONS);
    expect(deleted.at).toBeGreaterThanOrEqual(START + 3 * 60_000);
    expect(box.output()).toContain("sync running");
  });

  test("a recent interaction alone holds the restart until botQuietSeconds have passed", async () => {
    const box = botBox({ idleForMs: 20_000 });
    const deleted = watchDelete(box);
    await switchBot(box.context(), NEW, OPTIONS);
    expect(deleted.at).toBeGreaterThanOrEqual(START + 40_000);
  });

  test("--now skips the wait", async () => {
    const box = botBox({ idleForMs: 0, syncUntil: START + 60 * 60_000 });
    const deleted = watchDelete(box);
    await switchBot(box.context(), NEW, { force: false, now: true });
    expect(deleted.at).toBe(START);
  });

  test("a bot that never goes quiet is left running, and nothing is restarted", async () => {
    const box = botBox({ syncUntil: START + 24 * 60 * 60_000 });
    await expect(switchBot(box.context(), NEW, OPTIONS)).rejects.toThrow(/not quiet/);
    expect(box.pm2Mutations()).toEqual([]);
    expect(box.readState().bot).toEqual({ release: OLD, previous: null });
  });

  test("a running bot that writes no status file needs --now", async () => {
    const box = botBox();
    box.statuses.delete(botStatusFile(box.layout));
    await expect(switchBot(box.context(), NEW, OPTIONS)).rejects.toThrow(/--now/);
    expect(box.pm2Mutations()).toEqual([]);
  });

  test("an old bot still alive after pm2 delete stops the switch before a second copy starts", async () => {
    const box = botBox();
    const oldPid = box.processes.get(BOT)!.pid;
    const run = box.run.bind(box);
    box.run = async (command) => {
      const result = await run(command);
      if (command.argv[1] === "delete") box.alive.add(oldPid);
      return result;
    };
    await expect(switchBot(box.context(), NEW, OPTIONS)).rejects.toThrow(/second copy/);
    expect(box.pm2Mutations()).toEqual([["delete", BOT]]);
  });

  test("pm2 refusing to start the new bot still records the way back", async () => {
    const box = botBox();
    box.respond = (command) =>
      command.argv[1] === "start" ? { code: 1, stdout: "", stderr: "[PM2][ERROR] File ecosystem.config.cjs malformed" } : undefined;
    await expect(switchBot(box.context(), NEW, OPTIONS)).rejects.toThrow(/rollback bot/);
    expect(box.readState().bot).toEqual({ release: NEW, previous: OLD });
  });

  test("a new bot that never reports ready fails with the way back", async () => {
    const box = botBox();
    box.onStart = () => {};
    await expect(switchBot(box.context(), NEW, OPTIONS)).rejects.toThrow(/rollback bot/);
    expect(box.pm2Mutations()).toEqual([["delete", BOT], ["start", box.layout.ecosystem, "--only", BOT]]);
    expect(box.readState().bot).toEqual({ release: NEW, previous: OLD });
  });
});

describe("what the bot's restart depends on", () => {
  test("a missing shared/stats.db is refused: a fresh one would forget the recap claims", async () => {
    const box = botBox();
    rmSync(join(box.layout.shared, "stats.db"));
    await expect(switchBot(box.context(), NEW, OPTIONS)).rejects.toThrow(/stats\.db/);
    expect(box.pm2Mutations()).toEqual([]);
  });

  test("a stale status file's pid is not waited on: it may belong to another process by now", async () => {
    const box = botBox();
    const reused = 4242;
    box.alive.add(reused);
    box.setStatus(botStatusFile(box.layout), () =>
      botStatus({ pid: reused, buildId: OLD, updatedAt: START - 10 * 60_000, lastInteractionAt: START - 20 * 60_000 }),
    );
    await switchBot(box.context(), NEW, { force: false, now: true });
    expect(box.pm2Mutations()[1]).toEqual(["start", box.layout.ecosystem, "--only", BOT]);
  });
});

describe("a bot with no release recorded yet (the first switch)", () => {
  test("is treated as changed, since there is nothing to compare with", async () => {
    const box = botBox();
    box.writeState({});
    box.diff = [];
    await switchBot(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([["delete", BOT], ["start", box.layout.ecosystem, "--only", BOT], ["save"]]);
    expect(box.calls.some((call) => call.argv.includes("diff"))).toBe(false);
  });
});
