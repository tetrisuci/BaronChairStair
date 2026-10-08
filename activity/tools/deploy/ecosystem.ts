/**
 * `shared/ecosystem.config.cjs`: how pm2 starts each app, generated from
 * deploy.json and state.json and rewritten before every start.
 *
 * It lists only what should be running: the bot, the site, and the live game
 * slot (plus, for the length of a switch, the slot being started). A stopped
 * slot left in it would start beside the live one, on the same port, the next
 * time anybody ran `pm2 start` on the file — and a reusePort pair splits new
 * connections between old code and new.
 *
 * Every app runs from its own release by absolute path, with:
 *
 * - `DATABASE_PATH` set to shared/daily.sqlite. Bun lets an inherited variable
 *   beat a `.env`, and so does the site's settings loader, so the file the
 *   game writes, the site reads, the bot's `/archive sync` writes and
 *   `backup` copies is one file by construction, whatever the env files say.
 * - `STATUS_FILE` and `BUILD_ID` from the runtime-status contract.
 * - `interpreter: "none"`: pm2 otherwise guesses, and shows an app "online"
 *   while nothing listens.
 * - the game's `.env` found by Bun in its working directory, `activity/`,
 *   where prepare linked shared/activity.env; the bot's through its own path,
 *   the release root's `.env` -> shared/bot.env; the site's by `--env-file`.
 */

import { join } from "node:path";
import { writeFileAtomic } from "./effects";
import type { Context } from "./host";
import { botStatusFile, releaseDir, sharedFile, slotStatusFile } from "./layout";
import type { DeployState } from "./state";

/** Game slots must outlast a duel's last request and its "restarting" notice. */
const GAME_KILL_TIMEOUT_MS = 15_000;
/** The bot may be answering a command; give it longer to finish. */
const BOT_KILL_TIMEOUT_MS = 30_000;

export interface GameAssignment {
  readonly slot: string;
  readonly release: string;
}

/** Which release each app should be started from. Null or absent: not in the file. */
export interface Assignments {
  readonly bot: string | null;
  readonly games: readonly GameAssignment[];
  readonly site: string | null;
}

export interface Pm2App {
  readonly name: string;
  readonly script: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly interpreter: "none";
  readonly exec_mode: "fork";
  readonly autorestart: true;
  readonly watch: false;
  readonly kill_timeout?: number;
  /**
   * pm2 signals the whole process tree by default. The bot's polite stop
   * waits for commands in flight, but `/archive sync` and `/highlights` run a
   * child process, and a tree-wide SIGINT would end the child under the
   * command the bot is waiting for. Off for the bot only: the game runs Bun on
   * its file and starts no children.
   */
  readonly treekill?: false;
  readonly env: Readonly<Record<string, string>>;
}

const COMMON = { interpreter: "none", exec_mode: "fork", autorestart: true, watch: false } as const;

function botApp(ctx: Context, release: string): Pm2App {
  const { layout, config } = ctx;
  return {
    name: config.pm2.bot,
    script: config.botPython,
    args: ["client/discord_bot.py"],
    cwd: releaseDir(layout, release),
    ...COMMON,
    kill_timeout: BOT_KILL_TIMEOUT_MS,
    treekill: false,
    env: {
      BUILD_ID: release,
      STATUS_FILE: botStatusFile(layout),
      STATS_DB: sharedFile(layout, "stats"),
      DATABASE_PATH: sharedFile(layout, "daily"),
      PYTHONUNBUFFERED: "1",
      PATH: ctx.path,
    },
  };
}

function gameApp(ctx: Context, { slot, release }: GameAssignment): Pm2App {
  const { layout, config } = ctx;
  return {
    name: slot,
    script: ctx.bun,
    args: ["run", "server/index.ts"],
    cwd: join(releaseDir(layout, release), "activity"),
    ...COMMON,
    kill_timeout: GAME_KILL_TIMEOUT_MS,
    env: {
      NODE_ENV: "production",
      PORT: String(config.gamePort),
      BUILD_ID: release,
      STATUS_FILE: slotStatusFile(layout, slot),
      DATABASE_PATH: sharedFile(layout, "daily"),
      PATH: ctx.path,
    },
  };
}

function siteApp(ctx: Context, release: string): Pm2App {
  const { layout, config } = ctx;
  return {
    name: config.pm2.site,
    script: ctx.bun,
    args: [`--env-file=${sharedFile(layout, "puzzledbEnv")}`, "puzzledb/server/main.ts"],
    cwd: join(releaseDir(layout, release), "activity"),
    ...COMMON,
    env: {
      PUZZLEDB_PORT: String(config.sitePort),
      BUILD_ID: release,
      DATABASE_PATH: sharedFile(layout, "daily"),
      PATH: ctx.path,
    },
  };
}

export function ecosystemApps(ctx: Context, assignments: Assignments): readonly Pm2App[] {
  return [
    ...(assignments.bot ? [botApp(ctx, assignments.bot)] : []),
    ...assignments.games.map((game) => gameApp(ctx, game)),
    ...(assignments.site ? [siteApp(ctx, assignments.site)] : []),
  ];
}

/** What state says runs: the bot, the site, and only the live slot. */
export function assignmentsOf(state: DeployState): Assignments {
  const { activeSlot, release } = state.game;
  return {
    bot: state.bot.release,
    games: activeSlot && release ? [{ slot: activeSlot, release }] : [],
    site: state.site.release,
  };
}

export function renderEcosystem(apps: readonly Pm2App[]): string {
  return [
    "// Written by the deploy tool (activity/tools/deploy) from deploy.json and state.json.",
    "// Do not edit: every switch rewrites it. Regenerate with `bun run deploy ecosystem`.",
    "// It lists only what should be running; never `pm2 start` it without --only.",
    `module.exports = { apps: ${JSON.stringify(apps, null, 2)} };`,
    "",
  ].join("\n");
}

export function writeEcosystem(ctx: Context, assignments: Assignments): void {
  writeFileAtomic(ctx, ctx.layout.ecosystem, renderEcosystem(ecosystemApps(ctx, assignments)));
}
