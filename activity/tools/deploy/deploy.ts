/**
 * `deploy <ref>` and `rollback <app>`.
 *
 * A deploy is prepare, backup, then the three switches in the guides' order:
 * the game first (it migrates the database the site reads), the site next
 * (a site newer than the database serves 503 until the game has migrated),
 * the bot last (it only talks to the game, and is the one switch with a gap).
 * It stops at the first failure and says what already moved and how to move
 * it back; nothing after the failure is attempted.
 *
 * Rollback is a switch to the release state.json recorded as the app's
 * previous one, with the same waits and checks as any switch. Code goes back;
 * data does not — that is what the backups are for.
 */

import { existsSync } from "node:fs";
import { backup } from "./backup";
import { DeployError } from "./errors";
import { reportDone } from "./exec";
import type { Context } from "./host";
import { releaseDir } from "./layout";
import { prepare } from "./prepare";
import { shortSha } from "./release";
import { loadState, type AppName } from "./state";
import { switchBot } from "./switch-bot";
import { switchGame } from "./switch-game";
import { switchSite } from "./switch-site";

export interface RunOptions {
  readonly allowCold: boolean;
  readonly now: boolean;
  readonly force: boolean;
}

export function switchApp(ctx: Context, app: AppName, sha: string, options: RunOptions, assumePrepared = false): Promise<void> {
  if (app === "game") return switchGame(ctx, sha, { allowCold: options.allowCold, force: options.force, assumePrepared });
  if (app === "site") return switchSite(ctx, sha, { force: options.force, assumePrepared });
  return switchBot(ctx, sha, { force: options.force, now: options.now, assumePrepared });
}

function stoppedAt(app: AppName, error: DeployError, done: readonly AppName[], backups: readonly string[]): string {
  const lines = [`deploy stopped at the ${app} switch: ${error.message}`];
  lines.push(
    done.length === 0
      ? "Nothing before it was switched."
      : `Already switched: ${done.join(", ")}. To go back: ${done.map((name) => `bun run deploy rollback ${name}`).join("; ")}.`,
  );
  lines.push(`Backups taken before any switch (data rolls back only from these): ${backups.join(", ")}`);
  return lines.join("\n");
}

export async function deployRef(ctx: Context, ref: string, options: RunOptions): Promise<void> {
  const sha = await prepare(ctx, ref);
  const backups = backup(ctx, sha);
  const done: AppName[] = [];
  for (const app of ["game", "site", "bot"] as const) {
    try {
      await switchApp(ctx, app, sha, options, ctx.dryRun);
    } catch (error) {
      if (error instanceof DeployError) throw new DeployError(stoppedAt(app, error, done, backups));
      throw error;
    }
    done.push(app);
  }
  reportDone(ctx, `deployed ${shortSha(sha)}. Verify with the guides' checks; \`bun run deploy rollback <app>\` goes back.`);
}

export async function rollback(ctx: Context, app: AppName, options: RunOptions): Promise<void> {
  const previous = loadState(ctx)[app].previous;
  if (previous === null) throw new DeployError(`state.json records no previous release for the ${app}; nothing to roll back to`);
  if (!existsSync(releaseDir(ctx.layout, previous))) {
    throw new DeployError(
      `the ${app}'s previous release ${shortSha(previous)} has been pruned; prepare it again with \`bun run deploy prepare ${previous}\``,
    );
  }
  ctx.host.out(`rolling the ${app} back to ${shortSha(previous)}`);
  await switchApp(ctx, app, previous, { ...options, force: false });
}
