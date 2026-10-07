/**
 * pm2, reached only through these functions, and only for the apps the config
 * names.
 *
 * Reading: `pm2 jlist` prints every app with its whole environment — the
 * bot's token, the game's secrets, DIAYN's. Only the name, pid, status and
 * working directory are kept, and only for the config's own apps, so nothing
 * else can reach a printed line.
 *
 * Acting: every action asserts the name is one of the config's, and the only
 * signal it can send is the contract's drain, so neither a typo nor a future
 * caller can aim pm2 at DIAYN or at a signal that kills Bun outright.
 */

import { SIGNALS } from "../../shared/runtime-status";
import { assertManaged, managedNames } from "./config";
import { DeployError } from "./errors";
import { exec, execOk } from "./exec";
import type { Context } from "./host";

export interface Pm2Process {
  readonly name: string;
  readonly pid: number;
  /** pm2's own word: online, launching, stopping, stopped, errored. */
  readonly status: string;
  readonly cwd: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toProcess(entry: unknown): Pm2Process[] {
  if (!isRecord(entry) || typeof entry.name !== "string") return [];
  const env = isRecord(entry.pm2_env) ? entry.pm2_env : {};
  return [
    {
      name: entry.name,
      pid: typeof entry.pid === "number" ? entry.pid : 0,
      status: typeof env.status === "string" ? env.status : "unknown",
      cwd: typeof env.pm_cwd === "string" ? env.pm_cwd : null,
    },
  ];
}

function parseList(text: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The process table from `pm2 jlist`'s output. pm2 can print a warning line
 * before the JSON (an out-of-date daemon, an unsaved list), so the last line
 * that parses as a list is the one used.
 */
export function parseJlist(text: string): readonly Pm2Process[] {
  const whole = parseList(text.trim());
  if (whole) return whole.flatMap(toProcess);
  const lines = text.split("\n").map((line) => line.trim()).reverse();
  for (const line of lines) {
    if (!line.startsWith("[") || !line.endsWith("]")) continue;
    const list = parseList(line);
    if (list) return list.flatMap(toProcess);
  }
  throw new DeployError(`pm2 jlist printed no process list:\n${text.slice(0, 500)}`);
}

/** The config's own apps as pm2 sees them. Apps it does not name are dropped unread. */
export async function pm2List(ctx: Context): Promise<readonly Pm2Process[]> {
  const result = await execOk(ctx, { argv: ["pm2", "jlist"], mutates: false }, "pm2 jlist");
  const names = managedNames(ctx.config);
  return parseJlist(result.stdout).filter((process) => names.has(process.name));
}

export function findProcess(processes: readonly Pm2Process[], name: string): Pm2Process | undefined {
  return processes.find((process) => process.name === name);
}

/** Running, or on its way to running. */
export function isOnline(process: Pm2Process | undefined): boolean {
  return process?.status === "online" || process?.status === "launching";
}

async function act(ctx: Context, name: string, args: readonly string[], what: string): Promise<void> {
  assertManaged(ctx.config, name);
  await execOk(ctx, { argv: ["pm2", ...args], mutates: true }, what);
}

/** Remove an app from pm2's table (stopping it first, if it runs). */
export function pm2Delete(ctx: Context, name: string): Promise<void> {
  return act(ctx, name, ["delete", name], `pm2 delete ${name}`);
}

/** Start one app from the deploy's ecosystem file. */
export function pm2Start(ctx: Context, name: string): Promise<void> {
  return act(ctx, name, ["start", ctx.layout.ecosystem, "--only", name], `pm2 start ${name}`);
}

/** pm2's graceful stop: SIGINT, then SIGKILL after the app's kill_timeout. */
export function pm2Stop(ctx: Context, name: string): Promise<void> {
  return act(ctx, name, ["stop", name], `pm2 stop ${name}`);
}

/** Tell a game slot to hand over: stop listening, finish its matches, wait to be stopped. */
export function pm2Drain(ctx: Context, name: string): Promise<void> {
  return act(ctx, name, ["sendSignal", SIGNALS.drain, name], `pm2 sendSignal ${SIGNALS.drain} ${name}`);
}

/** Record pm2's table so a reboot brings back what runs now. */
export async function pm2Save(ctx: Context): Promise<void> {
  const result = await exec(ctx, { argv: ["pm2", "save"], mutates: true });
  if (result.code !== 0) ctx.host.out(`warning: pm2 save failed (exit ${result.code}); run it by hand`);
}
