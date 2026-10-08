/**
 * The files in shared/ an action depends on, checked for — never read —
 * before anything is started.
 *
 * Missing is never harmless here. The game opens its database with
 * `create: true`, and the bot creates `stats.db` if it is not there, so an app
 * pointed at a database that was never moved into shared/ starts happily on
 * an empty one: every player's history gone from the boards, and the bot's
 * recap claims and sync window forgotten. The env files fail more loudly, but
 * later, inside a release. Either way it is cheaper to stop before.
 */

import { existsSync } from "node:fs";
import { DeployError } from "./errors";
import type { Context } from "./host";
import { sharedFile, type SharedFile } from "./layout";

export function requireSharedFiles(ctx: Context, files: readonly SharedFile[], purpose: string): void {
  const missing = files.map((file) => sharedFile(ctx.layout, file)).filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new DeployError(
      `${purpose} needs ${missing.join(", ")}, which is not there. ` +
        "Move it into shared/ first (tools/deploy/README.md, First-time migration); an app started without it would make an empty one.",
    );
  }
}
