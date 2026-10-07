/**
 * What shared/bot.env must leave to the deploy.
 *
 * The bot loads its `.env` with `load_dotenv(..., override=True)`
 * (`client/discord_bot.py`), so whatever bot.env sets beats the environment
 * the ecosystem file gives it — unlike the Bun apps, where the inherited
 * variable wins. And `/archive sync` runs `bun run sync-archive` with the
 * bot's own environment, so it inherits the same values. A bot.env copied
 * from the old checkout that still names the old database or the old
 * activity directory sends the sync there, silently: `sync-archive` opens its
 * database with `create: true`, so a missing file is simply made anew.
 *
 * Prepare links this file as each release's `.env` and runs the bot's tests
 * with it, so a `STATS_DB` here would also point those tests at the live
 * `stats.db`. Hence both prepare and `switch bot` refuse such a file.
 *
 * Read for variable names only. Values are never kept, compared or printed.
 */

import { existsSync, readFileSync } from "node:fs";
import { DeployError } from "./errors";
import type { Context } from "./host";
import { sharedFile } from "./layout";

/**
 * Set by the ecosystem for the bot (the first five), or left unset so the
 * bot's `/archive sync` runs in the bot's own release (`PUZZLE_ACTIVITY_DIR`).
 */
export const DEPLOY_OWNED_BOT_VARIABLES = ["DATABASE_PATH", "BUILD_ID", "STATUS_FILE", "STATS_DB", "PATH", "PUZZLE_ACTIVITY_DIR"] as const;

/** `NAME=…` or `export NAME = …`; a comment or a bare `NAME` (which python-dotenv does not set) is not one. */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** The names a dotenv text assigns, in order, each once. */
export function assignedNames(text: string): readonly string[] {
  const names = text.split("\n").flatMap((line) => {
    const match = ASSIGNMENT.exec(line);
    return match ? [match[1]!] : [];
  });
  return [...new Set(names)];
}

/** Refuse a bot.env that sets anything in {@link DEPLOY_OWNED_BOT_VARIABLES}, naming the variables only. */
export function requireBotEnvLeavesDeployVariables(ctx: Context): void {
  const path = sharedFile(ctx.layout, "botEnv");
  if (!existsSync(path)) return; // requireSharedFiles reports a missing one
  const owned: ReadonlySet<string> = new Set(DEPLOY_OWNED_BOT_VARIABLES);
  const clashes = assignedNames(readFileSync(path, "utf8")).filter((name) => owned.has(name));
  if (clashes.length === 0) return;
  throw new DeployError(
    `${path} sets ${clashes.join(", ")}. The bot loads that file over its own environment, so it would beat what the ` +
      "deploy gives the bot and its /archive sync — the shared database, stats.db, status file, build id and PATH — " +
      "and PUZZLE_ACTIVITY_DIR would run the sync outside the bot's release. Delete those lines from bot.env and run this again.",
  );
}
