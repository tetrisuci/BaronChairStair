/**
 * Where everything lives under the deploy's home.
 *
 *     <home>/repo/                 a clone, used only to fetch and to add worktrees
 *     <home>/releases/<sha>/       one detached worktree per release, built in place
 *     <home>/shared/               everything that must outlive a release
 *         activity.env bot.env puzzledb.env    linked into, or passed to, each release
 *         daily.sqlite stats.db solutions.json
 *         backups/  run/  deploy.json  ecosystem.config.cjs
 *     <home>/state.json            which release each app runs, and the one before
 *
 * A release directory is named by its full commit, so the same commit is never
 * built twice and a name always says exactly what is inside.
 */

import { join } from "node:path";

export interface Layout {
  readonly home: string;
  readonly repo: string;
  readonly releases: string;
  readonly shared: string;
  readonly state: string;
  /** Status files the apps write, and the deploy's lock. */
  readonly run: string;
  readonly backups: string;
  readonly ecosystem: string;
  readonly lock: string;
}

/** The files in shared/ the deploy knows by name. */
export const SHARED_FILES = {
  activityEnv: "activity.env",
  botEnv: "bot.env",
  puzzledbEnv: "puzzledb.env",
  daily: "daily.sqlite",
  stats: "stats.db",
  solutions: "solutions.json",
} as const;

export type SharedFile = keyof typeof SHARED_FILES;

export function layoutFor(home: string): Layout {
  const shared = join(home, "shared");
  const run = join(shared, "run");
  return {
    home,
    repo: join(home, "repo"),
    releases: join(home, "releases"),
    shared,
    state: join(home, "state.json"),
    run,
    backups: join(shared, "backups"),
    ecosystem: join(shared, "ecosystem.config.cjs"),
    lock: join(run, "deploy.lock"),
  };
}

export function releaseDir(layout: Layout, sha: string): string {
  return join(layout.releases, sha);
}

export function sharedFile(layout: Layout, file: SharedFile): string {
  return join(layout.shared, SHARED_FILES[file]);
}

export function slotStatusFile(layout: Layout, slot: string): string {
  return join(layout.run, `${slot}.json`);
}

export function botStatusFile(layout: Layout): string {
  return join(layout.run, "bot.json");
}
