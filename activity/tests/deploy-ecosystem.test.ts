/**
 * The pm2 ecosystem file the deploy writes: the only description pm2 gets of
 * how to start each app, so every app's working directory, environment and
 * stop timeout is pinned here. It lists only what should be running — a
 * stopped game slot left in it would start beside the live one on the same
 * port the next time anybody ran `pm2 start` on the file.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assignmentsOf, ecosystemApps, renderEcosystem, writeEcosystem } from "../tools/deploy/ecosystem";
import { BLUE, BOT, FakeBox, GREEN, NEW, OLD, SITE, cleanUpBoxes } from "./deploy-harness";

afterEach(cleanUpBoxes);

describe("the apps", () => {
  test("the bot, a game slot and the site, each from its own release", () => {
    const box = new FakeBox();
    const ctx = box.context();
    const shared = box.layout.shared;
    const apps = ecosystemApps(ctx, { bot: OLD, games: [{ slot: GREEN, release: NEW }], site: NEW });

    expect(apps).toEqual([
      {
        name: BOT,
        script: "/opt/bcs/venv/bin/python",
        args: ["client/discord_bot.py"],
        cwd: join(box.layout.releases, OLD),
        interpreter: "none",
        exec_mode: "fork",
        autorestart: true,
        watch: false,
        kill_timeout: 30_000,
        env: {
          BUILD_ID: OLD,
          STATUS_FILE: join(shared, "run", "bot.json"),
          STATS_DB: join(shared, "stats.db"),
          DATABASE_PATH: join(shared, "daily.sqlite"),
          PYTHONUNBUFFERED: "1",
          PATH: "/opt/bun/bin:/usr/bin:/bin",
        },
      },
      {
        name: GREEN,
        script: "/opt/bun/bin/bun",
        args: ["run", "server/index.ts"],
        cwd: join(box.layout.releases, NEW, "activity"),
        interpreter: "none",
        exec_mode: "fork",
        autorestart: true,
        watch: false,
        kill_timeout: 15_000,
        env: {
          NODE_ENV: "production",
          PORT: "3001",
          BUILD_ID: NEW,
          STATUS_FILE: join(shared, "run", `${GREEN}.json`),
          DATABASE_PATH: join(shared, "daily.sqlite"),
          PATH: "/opt/bun/bin:/usr/bin:/bin",
        },
      },
      {
        name: SITE,
        script: "/opt/bun/bin/bun",
        args: [`--env-file=${join(shared, "puzzledb.env")}`, "puzzledb/server/main.ts"],
        cwd: join(box.layout.releases, NEW, "activity"),
        interpreter: "none",
        exec_mode: "fork",
        autorestart: true,
        watch: false,
        env: {
          PUZZLEDB_PORT: "3002",
          BUILD_ID: NEW,
          DATABASE_PATH: join(shared, "daily.sqlite"),
          PATH: "/opt/bun/bin:/usr/bin:/bin",
        },
      },
    ]);
  });

  test("an app with no release recorded is left out", () => {
    const box = new FakeBox();
    expect(ecosystemApps(box.context(), { bot: null, games: [], site: null })).toEqual([]);
  });

  test("state gives the bot, the site and only the active game slot", () => {
    const assignments = assignmentsOf({
      version: 1,
      game: { activeSlot: BLUE, release: NEW, previous: OLD },
      site: { release: NEW, previous: null },
      bot: { release: OLD, previous: null },
      updatedAt: null,
    });
    expect(assignments).toEqual({ bot: OLD, games: [{ slot: BLUE, release: NEW }], site: NEW });
  });

  test("a game slot with no release (the old checkout, before the first switch) is not listed", () => {
    const assignments = assignmentsOf({
      version: 1,
      game: { activeSlot: BLUE, release: null, previous: null },
      site: { release: null, previous: null },
      bot: { release: null, previous: null },
      updatedAt: null,
    });
    expect(assignments.games).toEqual([]);
  });
});

describe("the file", () => {
  test("is a CommonJS module pm2 can load, and says it is generated", () => {
    const box = new FakeBox();
    const ctx = box.context();
    writeEcosystem(ctx, { bot: OLD, games: [{ slot: BLUE, release: OLD }], site: OLD });
    const text = readFileSync(box.layout.ecosystem, "utf8");
    expect(text).toContain("Written by the deploy tool");
    const loaded = createRequire(import.meta.url)(box.layout.ecosystem) as { apps: { name: string }[] };
    expect(loaded.apps.map((app) => app.name)).toEqual([BOT, BLUE, SITE]);
  });

  test("renders the same apps it was given", () => {
    const box = new FakeBox();
    const apps = ecosystemApps(box.context(), { bot: OLD, games: [], site: null });
    expect(renderEcosystem(apps)).toContain(JSON.stringify(apps, null, 2));
  });
});
