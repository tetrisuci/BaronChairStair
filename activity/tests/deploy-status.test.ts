/**
 * `status`: one line per app, from pm2's process table and the status files,
 * so "is anybody playing?" is read rather than guessed. Counts only — a status
 * file holds nothing else — and nothing from an app's environment.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { botStatusFile, slotStatusFile } from "../tools/deploy/layout";
import { statusLines, waitQuiet } from "../tools/deploy/status";
import { BLUE, BOT, FakeBox, GREEN, NEW, OLD, SITE, START, botStatus, cleanUpBoxes, gameStatus } from "./deploy-harness";

afterEach(cleanUpBoxes);

function runningBox(): FakeBox {
  const box = new FakeBox();
  box.writeState({
    game: { activeSlot: BLUE, release: NEW, previous: OLD },
    site: { release: NEW, previous: OLD },
    bot: { release: NEW, previous: OLD },
  });
  const blue = box.addProcess(BLUE, join(box.layout.releases, NEW, "activity"));
  const bot = box.addProcess(BOT, join(box.layout.releases, NEW));
  box.addProcess(SITE, join(box.layout.releases, NEW, "activity"));
  box.setStatus(slotStatusFile(box.layout, BLUE), (now) =>
    gameStatus({ pid: blue.pid, buildId: NEW, updatedAt: now, duelsInMatch: 1, sessionsRecent: 3 }),
  );
  box.setStatus(botStatusFile(box.layout), (now) =>
    botStatus({ pid: bot.pid, buildId: NEW, updatedAt: now, lastInteractionAt: START - 14 * 60_000 }),
  );
  return box;
}

describe("status lines", () => {
  test("one per app, with the counts a deploy decides on", async () => {
    const box = runningBox();
    expect(await statusLines(box.context())).toEqual([
      "game (bcs-game-blue, 2222222): serving · 1 duel, 0 lobbies, 0 rushes, 3 sessions, 0 in flight",
      "bot (bcs-bot, 2222222): ready · idle 14 min · no sync",
      "site (bcs-site, 2222222): online",
    ]);
  });

  test("a slot still draining beside the new one is shown too", async () => {
    const box = runningBox();
    const green = box.addProcess(GREEN, join(box.layout.releases, OLD, "activity"));
    box.setStatus(slotStatusFile(box.layout, GREEN), (now) =>
      gameStatus({ pid: green.pid, buildId: OLD, updatedAt: now, state: "draining", duelsInMatch: 2, lobbies: 1, rushTicketsRecent: 1, sessionsRecent: 1, inflight: 1 }),
    );
    const lines = await statusLines(box.context());
    expect(lines).toContain("game (bcs-game-green, 1111111): draining · 2 duels, 1 lobby, 1 rush, 1 session, 1 in flight");
  });

  test("a busy bot says what it is busy with", async () => {
    const box = runningBox();
    const bot = box.processes.get(BOT)!;
    box.setStatus(botStatusFile(box.layout), (now) =>
      botStatus({ pid: bot.pid, buildId: NEW, updatedAt: now, lastInteractionAt: now - 5_000, inflight: 2, syncRunning: true }),
    );
    const lines = await statusLines(box.context());
    expect(lines[1]).toBe("bot (bcs-bot, 2222222): ready · 2 in flight · idle 5 s · sync running");
  });

  test("what cannot be known is said, not guessed", async () => {
    const box = runningBox();
    box.statuses.delete(slotStatusFile(box.layout, BLUE));
    const bot = box.processes.get(BOT)!;
    box.setStatus(botStatusFile(box.layout), () => botStatus({ pid: bot.pid, buildId: NEW, updatedAt: START - 3 * 60_000 }));
    box.processes.get(SITE)!.status = "errored";
    expect(await statusLines(box.context())).toEqual([
      "game (bcs-game-blue, 2222222): online · no status file",
      "bot (bcs-bot, 2222222): online · status stale (written 3 min ago)",
      "site (bcs-site, 2222222): errored",
    ]);
  });

  test("apps that are not running say so", async () => {
    const box = runningBox();
    box.processes.clear();
    expect(await statusLines(box.context())).toEqual([
      "game (bcs-game-blue, 2222222): not running",
      "bot (bcs-bot, 2222222): not running",
      "site (bcs-site, 2222222): not running",
    ]);
  });

  test("never prints anything from an app's environment", async () => {
    const box = runningBox();
    const lines = await statusLines(box.context());
    expect(lines.join("\n")).not.toContain("never-printed");
  });
});

describe("waiting for quiet", () => {
  test("returns once no duel, no recent rush and a quiet bot", async () => {
    const box = runningBox();
    const blue = box.processes.get(BLUE)!;
    box.setStatus(slotStatusFile(box.layout, BLUE), (now) =>
      gameStatus({ pid: blue.pid, buildId: NEW, updatedAt: now, duelsInMatch: now < START + 90_000 ? 1 : 0 }),
    );
    expect(await waitQuiet(box.context(), 30)).toBe(true);
    expect(box.now).toBeGreaterThanOrEqual(START + 90_000);
    expect(box.now).toBeLessThan(START + 120_000);
  });

  test("gives up at the timeout", async () => {
    const box = runningBox();
    expect(await waitQuiet(box.context(), 2)).toBe(false);
    expect(box.now - START).toBeGreaterThanOrEqual(2 * 60_000);
  });

  test("a game with no status file is never called quiet", async () => {
    const box = runningBox();
    box.statuses.delete(slotStatusFile(box.layout, BLUE));
    expect(await waitQuiet(box.context(), 1)).toBe(false);
  });
});
