/**
 * `backup`: copy daily.sqlite and stats.db into shared/backups before anything
 * switches.
 *
 * `VACUUM INTO` from a read-only connection: a consistent copy of a WAL
 * database that is being written to, which `cp` is not, and a connection that
 * cannot change the original. It redacts nothing — these copies hold real
 * Discord ids and run history, so they stay in shared/ and never go near git.
 *
 * Both targets are checked before either is written, and an existing backup
 * is never overwritten: the file in the way may be the last good copy.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDirectory } from "./effects";
import { DeployError } from "./errors";
import type { Context } from "./host";
import { sharedFile, type SharedFile } from "./layout";

const DATABASES: readonly { readonly name: string; readonly file: SharedFile }[] = [
  { name: "daily", file: "daily" },
  { name: "stats", file: "stats" },
];

/** How much of the release's sha a backup's name carries. */
const LABEL_LENGTH = 12;

/** "2026-10-06-152000", in UTC: sorts by time, and two backups a second apart differ. */
function stamp(now: number): string {
  const iso = new Date(now).toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

/** Back up both databases, labelled with `release`; returns the paths written. */
export function backup(ctx: Context, release: string): readonly string[] {
  const { layout, host } = ctx;
  const label = release.slice(0, LABEL_LENGTH);
  const when = stamp(host.clock.now());
  const plan = DATABASES.map(({ name, file }) => ({
    source: sharedFile(layout, file),
    target: join(layout.backups, `${name}-${when}-${label}.sqlite`),
  }));

  for (const { source } of plan) {
    if (!existsSync(source)) {
      throw new DeployError(`${source} is not there: move the live database into shared/ first (see tools/deploy/README.md)`);
    }
  }
  for (const { target } of plan) {
    if (existsSync(target)) throw new DeployError(`${target} already exists; a backup never overwrites another`);
  }
  if (ctx.dryRun) {
    for (const { source, target } of plan) host.out(`would back up ${source} -> ${target}`);
    return plan.map(({ target }) => target);
  }

  ensureDirectory(ctx, layout.backups);
  for (const { source, target } of plan) {
    const db = new Database(source, { readonly: true });
    try {
      db.run("VACUUM INTO ?", [target]);
    } finally {
      db.close();
    }
    host.out(`backed up ${source} -> ${target}`);
  }
  return plan.map(({ target }) => target);
}
