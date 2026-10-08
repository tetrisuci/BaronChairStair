/**
 * `deploy <ref>` and `rollback`, end to end on the fake box, and the dry run
 * that has to be trustworthy enough to read before doing the real thing:
 * every command that would change something is printed, and none is sent.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deployRef, rollback } from "../tools/deploy/deploy";
import { botStatusFile, slotStatusFile } from "../tools/deploy/layout";
import { isPrepared } from "../tools/deploy/release";
import {
  BLUE,
  BOT,
  FakeBox,
  GREEN,
  NEW,
  OLD,
  SITE,
  START,
  botStatus,
  cleanUpBoxes,
  gameStatus,
} from "./deploy-harness";

afterEach(cleanUpBoxes);

const OPTIONS = { allowCold: false, now: false, force: false };

/**
 * A box running OLD everywhere, with databases in shared/, whose fake apps
 * come up healthy on whatever build pm2 starts them with.
 */
function productionBox(): FakeBox {
  const box = new FakeBox();
  for (const name of ["daily.sqlite", "stats.db"]) {
    const db = new Database(join(box.layout.shared, name), { create: true });
    db.run("CREATE TABLE t (x)");
    db.close();
  }
  box.prepareRelease(OLD);
  box.writeState({
    game: { activeSlot: BLUE, release: OLD, previous: null },
    site: { release: OLD, previous: null },
    bot: { release: OLD, previous: null },
  });
  box.diff = ["client/discord_bot.py"];
  const blue = box.addProcess(BLUE, join(box.layout.releases, OLD, "activity"));
  const bot = box.addProcess(BOT, join(box.layout.releases, OLD));
  box.addProcess(SITE, join(box.layout.releases, OLD, "activity"));
  let blueDraining = false;
  box.setStatus(slotStatusFile(box.layout, BLUE), (now) =>
    gameStatus({ pid: blue.pid, buildId: OLD, updatedAt: now, state: blueDraining ? "draining" : "serving" }),
  );
  box.setStatus(botStatusFile(box.layout), (now) =>
    botStatus({ pid: bot.pid, buildId: OLD, updatedAt: now, lastInteractionAt: START - 30 * 60_000 }),
  );
  box.onSignal = (name) => {
    if (name === BLUE) blueDraining = true;
  };
  box.onStart = (name, app, pid) => {
    const buildId = app.env.BUILD_ID!;
    if (name === BOT) box.setStatus(botStatusFile(box.layout), (now) => botStatus({ pid, buildId, updatedAt: now }));
    if (name === BLUE || name === GREEN) {
      box.setStatus(slotStatusFile(box.layout, name), (now) => gameStatus({ pid, buildId, updatedAt: now }));
    }
  };
  // The site's port answers only while pm2 runs the site; the game's /api/health is only logged.
  box.probe = (url) => {
    const siteDown = url.endsWith(`:${box.config.sitePort}/health`) && box.processes.get(SITE)?.status !== "online";
    return url.endsWith("/health") && !siteDown ? { status: 200, buildId: null, body: '{"ok":true}' } : null;
  };
  const build = box.respond;
  box.respond = (command) => {
    if (command.argv.join(" ").endsWith("run build")) box.writeBuildId(command.env?.BUILD_ID ?? "");
    return build(command);
  };
  return box;
}

describe("a full deploy", () => {
  test("prepares, backs up, then switches the game, the site and the bot, in that order", async () => {
    const box = productionBox();
    await deployRef(box.context(), "main", OPTIONS);

    expect(isPrepared(box.layout, NEW)).toBe(true);
    const state = box.readState();
    expect(state.game).toEqual({ activeSlot: GREEN, release: NEW, previous: OLD });
    expect(state.site).toEqual({ release: NEW, previous: OLD });
    expect(state.bot).toEqual({ release: NEW, previous: OLD });

    const starts = box.pm2Mutations().filter((argv) => argv[0] === "start").map((argv) => argv[3]);
    expect(starts).toEqual([GREEN, SITE, BOT]);
    expect(existsSync(box.layout.backups)).toBe(true);
  });

  test("a failure part-way stops there, and says what already moved and how to move it back", async () => {
    const box = productionBox();
    box.probe = () => null;
    await expect(deployRef(box.context(), "main", OPTIONS)).rejects.toThrow(/site[\s\S]*rollback game/);
    expect(box.readState().game.release).toBe(NEW);
    expect(box.readState().bot.release).toBe(OLD);
    expect(box.pm2Mutations().some((argv) => argv.includes(BOT))).toBe(false);
  });
});

describe("rollback", () => {
  test("switches an app back to the release it ran before", async () => {
    const box = productionBox();
    await deployRef(box.context(), "main", OPTIONS);
    const green = box.processes.get(GREEN)!;
    let greenDraining = false;
    box.setStatus(slotStatusFile(box.layout, GREEN), (now) =>
      gameStatus({ pid: green.pid, buildId: NEW, updatedAt: now, state: greenDraining ? "draining" : "serving" }),
    );
    box.onSignal = (name) => {
      if (name === GREEN) greenDraining = true;
    };
    await rollback(box.context(), "game", OPTIONS);
    expect(box.readState().game).toEqual({ activeSlot: BLUE, release: OLD, previous: NEW });
  });

  test("with nothing recorded to go back to, says so", async () => {
    const box = productionBox();
    await expect(rollback(box.context(), "site", OPTIONS)).rejects.toThrow(/no previous release/);
  });
});

describe("a dry run of the whole deploy", () => {
  test("sends no command that changes anything, writes nothing, and prints the plan", async () => {
    const box = productionBox();
    const stateBefore = readFileSync(box.layout.state, "utf8");
    await deployRef(box.context({ dryRun: true }), "main", OPTIONS);

    expect(box.calls.filter((call) => call.mutates)).toEqual([]);
    expect(readFileSync(box.layout.state, "utf8")).toBe(stateBefore);
    expect(existsSync(box.layout.ecosystem)).toBe(false);
    expect(existsSync(box.layout.backups)).toBe(false);
    expect(existsSync(join(box.layout.releases, NEW))).toBe(false);
    const output = box.output();
    expect(output).toContain("would run: git -C");
    expect(output).toContain(`would run: pm2 start ${box.layout.ecosystem} --only ${GREEN}`);
    expect(output).toContain(`would run: pm2 sendSignal SIGHUP ${BLUE}`);
    expect(output).toContain("would back up");
    expect(output).toContain(`would write ${box.layout.state}`);
  });
});
