#!/usr/bin/env bun
/**
 * The deploy tool's command line. Reference: `tools/deploy/README.md`.
 *
 *     bun run deploy [--config <file>] [--dry-run] <command> [operands] [flags]
 *
 * Arguments are read strictly: an unknown flag is an error, never ignored —
 * `--dryrun` silently ignored would deploy for real. Exit codes: 0 done,
 * 1 the deploy stopped (the message says why and what to do), 2 the command
 * line was wrong.
 */

import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { loadConfig, type DeployConfig } from "./config";
import { backup } from "./backup";
import { deployRef, rollback, switchApp, type RunOptions } from "./deploy";
import { assignmentsOf, writeEcosystem } from "./ecosystem";
import { DeployError } from "./errors";
import type { Context, Host } from "./host";
import { layoutFor, type Layout } from "./layout";
import { withLock } from "./lock";
import { prepare } from "./prepare";
import { prune } from "./prune";
import { realHost } from "./real-host";
import { resolveRef } from "./release";
import { loadState, type AppName } from "./state";
import { statusLines, waitQuiet } from "./status";

export const USAGE = `Usage: bun run deploy [--config <file>] [--dry-run] <command>

  prepare <ref>                      fetch, check out releases/<sha>, install, check and build it
  backup [<ref>]                     VACUUM INTO shared/backups/ for daily.sqlite and stats.db
  switch game <ref> [--allow-cold] [--force]
  switch site <ref> [--force]
  switch bot <ref> [--now] [--force]
  deploy <ref> [--allow-cold] [--now] [--force]
                                     prepare, backup, then switch the game, the site and the bot
  rollback game|site|bot [--allow-cold] [--now]
  status [--wait-quiet] [--timeout <minutes>]
  ecosystem                          rewrite shared/ecosystem.config.cjs from state.json
  prune [--keep <n>]                 remove release worktrees nothing uses

  --config <file>   default: $BCS_DEPLOY_CONFIG, else ~/bcs/shared/deploy.json
  --dry-run         print every command that would change something; run none of them`;

class UsageError extends Error {}

export interface Flags {
  readonly dryRun: boolean;
  readonly allowCold: boolean;
  readonly force: boolean;
  readonly now: boolean;
  readonly waitQuiet: boolean;
  readonly timeoutMinutes: number | null;
  readonly keep: number | null;
  readonly config: string | null;
}

export interface ParsedArgs {
  readonly command: string | null;
  readonly operands: readonly string[];
  readonly flags: Flags;
}

const SWITCHES = { "--dry-run": "dryRun", "--allow-cold": "allowCold", "--force": "force", "--now": "now", "--wait-quiet": "waitQuiet" } as const;

/** Commands, with how many operands each takes. */
const ARITY: Readonly<Record<string, readonly [number, number]>> = {
  prepare: [1, 1],
  backup: [0, 1],
  switch: [2, 2],
  deploy: [1, 1],
  rollback: [1, 1],
  status: [0, 0],
  ecosystem: [0, 0],
  prune: [0, 0],
};

const APPS: readonly AppName[] = ["game", "site", "bot"];

function number(flag: string, value: string | undefined, positive: boolean): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  const valid = Number.isFinite(parsed) && (positive ? parsed > 0 : Number.isInteger(parsed) && parsed >= 0);
  if (!valid) throw new UsageError(`${flag} needs ${positive ? "a number of minutes above 0" : "a whole number, 0 or more"}`);
  return parsed;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = { dryRun: false, allowCold: false, force: false, now: false, waitQuiet: false, timeoutMinutes: null as number | null, keep: null as number | null, config: null as string | null };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg in SWITCHES) {
      flags[SWITCHES[arg as keyof typeof SWITCHES]] = true;
    } else if (arg === "--timeout") {
      flags.timeoutMinutes = number(arg, argv[(i += 1)], true);
    } else if (arg === "--keep") {
      flags.keep = number(arg, argv[(i += 1)], false);
    } else if (arg === "--config") {
      const value = argv[(i += 1)];
      if (!value) throw new UsageError("--config needs a file");
      flags.config = value;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] ?? null, operands: positional.slice(1), flags };
}

function checkOperands(command: string, operands: readonly string[]): void {
  const arity = ARITY[command];
  if (!arity) throw new UsageError(`unknown command "${command}"`);
  const [min, max] = arity;
  if (operands.length < min || operands.length > max) throw new UsageError(`wrong number of operands for ${command}`);
  if ((command === "switch" || command === "rollback") && !APPS.includes(operands[0] as AppName)) {
    throw new UsageError(`"${operands[0]}" is not an app: use game, site or bot`);
  }
}

/** The release directory this tool runs from, if it runs from one. */
function releaseContaining(layout: Layout, dir: string): string | null {
  const inside = relative(layout.releases, dir);
  if (inside === "" || inside.startsWith("..")) return null;
  return join(layout.releases, inside.split(sep)[0]!);
}

function contextFor(config: DeployConfig, host: Host, dryRun: boolean): Context {
  const bun = config.bun ?? process.execPath;
  const dirs = [dirname(bun), ...(process.env.PATH ?? "").split(":")];
  const path = dirs.filter((dir, index) => dir !== "" && dirs.indexOf(dir) === index).join(":");
  const layout = layoutFor(config.home);
  return { config, layout, host, dryRun, bun, path, selfRelease: releaseContaining(layout, import.meta.dir) };
}

async function dispatch(ctx: Context, command: string, operands: readonly string[], flags: Flags): Promise<number> {
  const options: RunOptions = { allowCold: flags.allowCold, now: flags.now, force: flags.force };
  switch (command) {
    case "prepare":
      await withLock(ctx, () => prepare(ctx, operands[0]!));
      return 0;
    case "backup": {
      const label = operands[0] ? await resolveRef(ctx, operands[0]) : (loadState(ctx).game.release ?? "manual");
      await withLock(ctx, async () => backup(ctx, label));
      return 0;
    }
    case "switch": {
      const sha = await resolveRef(ctx, operands[1]!);
      await withLock(ctx, () => switchApp(ctx, operands[0] as AppName, sha, options));
      return 0;
    }
    case "deploy":
      await withLock(ctx, () => deployRef(ctx, operands[0]!, options));
      return 0;
    case "rollback":
      await withLock(ctx, () => rollback(ctx, operands[0] as AppName, options));
      return 0;
    case "ecosystem":
      await withLock(ctx, async () => writeEcosystem(ctx, assignmentsOf(loadState(ctx))));
      return 0;
    case "prune":
      await withLock(ctx, () => prune(ctx, flags.keep ?? ctx.config.keepReleases));
      return 0;
    case "status": {
      if (flags.waitQuiet) return (await waitQuiet(ctx, flags.timeoutMinutes ?? ctx.config.botQuietLimitMinutes)) ? 0 : 1;
      for (const line of await statusLines(ctx)) ctx.host.out(line);
      return 0;
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

export interface Io {
  readonly out: (line: string) => void;
  /** Replaces the real host (tests); its `out` is replaced by the one above. */
  readonly host?: Host;
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
    if (parsed.command === null) throw new UsageError("no command given");
    checkOperands(parsed.command, parsed.operands);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.out(`deploy: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { command, operands, flags } = parsed;
  try {
    const configPath = flags.config ?? process.env.BCS_DEPLOY_CONFIG ?? join(homedir(), "bcs", "shared", "deploy.json");
    const config = loadConfig(configPath);
    const ctx = contextFor(config, { ...(io.host ?? realHost()), out: io.out }, flags.dryRun);
    if (ctx.dryRun) io.out("dry run: nothing below is done; reads still run");
    return await dispatch(ctx, command!, operands, flags);
  } catch (error) {
    if (!(error instanceof DeployError)) throw error;
    io.out(`deploy: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2), { out: (line) => console.log(line) }));
}
