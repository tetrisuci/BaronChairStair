/**
 * `state.json`: which release each app runs, which game slot is live, and the
 * release each ran before — the way back for `rollback`.
 *
 * Written only after pm2 has been told, and atomically, so it describes what
 * pm2 runs. A missing file is a box before its first switch; a file that does
 * not parse is an error, never a reason to start from nothing — starting from
 * nothing would forget the way back.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./effects";
import { DeployError } from "./errors";
import type { Context } from "./host";

export interface AppRecord {
  /** The release pm2 runs this app from; null before the deploy first switched it. */
  readonly release: string | null;
  /** What it ran before, for `rollback`; null when that was not a release. */
  readonly previous: string | null;
}

export interface GameRecord extends AppRecord {
  /** The slot serving the port. */
  readonly activeSlot: string | null;
}

export interface DeployState {
  readonly version: 1;
  readonly game: GameRecord;
  readonly site: AppRecord;
  readonly bot: AppRecord;
  /** ISO time of the last write. */
  readonly updatedAt: string | null;
}

export const EMPTY_STATE: DeployState = {
  version: 1,
  game: { activeSlot: null, release: null, previous: null },
  site: { release: null, previous: null },
  bot: { release: null, previous: null },
  updatedAt: null,
};

export type AppName = "game" | "site" | "bot";

const SHA = /^[0-9a-f]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && SHA.test(value)) return value;
  throw new DeployError(`state.json: ${field} must be a full commit sha or null`);
}

function appRecord(value: unknown, field: string): AppRecord {
  if (value === undefined) return { release: null, previous: null };
  if (!isRecord(value)) throw new DeployError(`state.json: ${field} must be an object`);
  return { release: sha(value.release, `${field}.release`), previous: sha(value.previous, `${field}.previous`) };
}

export function parseState(text: string, slots: readonly string[]): DeployState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DeployError(`state.json is not valid JSON (${(error as Error).message}); fix it by hand — it holds the way back`);
  }
  if (!isRecord(raw) || raw.version !== 1) throw new DeployError("state.json is not a version 1 deploy state");
  const game = isRecord(raw.game) ? raw.game : {};
  const activeSlot = game.activeSlot ?? null;
  if (activeSlot !== null && (typeof activeSlot !== "string" || !slots.includes(activeSlot))) {
    throw new DeployError(
      `state.json names game slot ${JSON.stringify(activeSlot)}, which deploy.json does not; make the two agree`,
    );
  }
  return {
    version: 1,
    game: { activeSlot, ...appRecord(raw.game, "game") },
    site: appRecord(raw.site, "site"),
    bot: appRecord(raw.bot, "bot"),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

export function loadState(ctx: Context): DeployState {
  if (!existsSync(ctx.layout.state)) return EMPTY_STATE;
  return parseState(readFileSync(ctx.layout.state, "utf8"), ctx.config.pm2.gameSlots);
}

export function saveState(ctx: Context, state: DeployState): void {
  const stamped = { ...state, updatedAt: new Date(ctx.host.clock.now()).toISOString() };
  writeFileAtomic(ctx, ctx.layout.state, `${JSON.stringify(stamped, null, 2)}\n`);
}

/** The record after an app moves to `release`: what it ran becomes the way back. */
export function moved<T extends AppRecord>(record: T, release: string): T {
  const previous = record.release !== null && record.release !== release ? record.release : record.previous;
  return { ...record, release, previous };
}
