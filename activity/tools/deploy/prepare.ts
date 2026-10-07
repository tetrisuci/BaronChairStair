/**
 * `prepare <ref>`: build and check a release in its own directory while the
 * box keeps serving the old one. Nothing running is touched.
 *
 * The order is the guides' order, and load-bearing: shared files are linked
 * before anything runs (the bot's tests import code that loads `.env`), both
 * installs come before any check, the checks before either build, and the
 * marker last — written only when every step passed, so a switch can never
 * pick up a release that failed halfway.
 *
 * Commands run with the clean environment `real-host.ts` gives every command:
 * in particular no `STATS_DB`, so the bot's tests open a scratch `stats.db`
 * inside the release, never the shared one.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILD_ID_FILE } from "../../shared/runtime-status";
import { linkFile, writeFileAtomic } from "./effects";
import { DeployError } from "./errors";
import { describeCommand, execOk, reportDone } from "./exec";
import type { Command, CommandResult, Context } from "./host";
import { releaseDir, sharedFile } from "./layout";
import { MARKER_FILE, isPrepared, resolveRef, shortSha } from "./release";
import { requireSharedFiles } from "./shared-files";

interface Step {
  readonly name: string;
  readonly command: Command;
  /** A further check of a step that exited 0; returns why it failed, or null. */
  readonly verify?: (result: CommandResult) => string | null;
}

/** `bun test` must say so: an exit code of 0 alone has hidden failures before. */
function reportsZeroFail(result: CommandResult): string | null {
  return /(^|\s)0 fail(\s|$)/m.test(`${result.stdout}\n${result.stderr}`) ? null : 'bun test did not report "0 fail"';
}

function linkShared(ctx: Context, dir: string): void {
  const { layout } = ctx;
  linkFile(ctx, sharedFile(layout, "activityEnv"), join(dir, "activity", ".env"));
  linkFile(ctx, sharedFile(layout, "botEnv"), join(dir, ".env"));
  const solutions = sharedFile(layout, "solutions");
  if (existsSync(solutions)) linkFile(ctx, solutions, join(dir, "activity", "data", "solutions.json"));
}

/** client/*.py, relative to the release root; a placeholder in a dry run that never checked it out. */
function botSources(ctx: Context, dir: string): readonly string[] {
  const client = join(dir, "client");
  if (!existsSync(client)) {
    if (ctx.dryRun) return ["client/*.py"];
    throw new DeployError(`${client} is not there: is ${dir} a checkout of this repository?`);
  }
  return readdirSync(client)
    .filter((name) => name.endsWith(".py"))
    .sort()
    .map((name) => `client/${name}`);
}

function steps(ctx: Context, dir: string, sha: string): readonly Step[] {
  const activity = join(dir, "activity");
  const { bun } = ctx;
  const python = ctx.config.botPython;
  return [
    { name: "bun install (root)", command: { argv: [bun, "install", "--frozen-lockfile"], cwd: dir, mutates: true } },
    { name: "bun install (activity)", command: { argv: [bun, "install", "--frozen-lockfile"], cwd: activity, mutates: true } },
    { name: "bot py_compile", command: { argv: [python, "-m", "py_compile", ...botSources(ctx, dir)], cwd: dir, mutates: true } },
    {
      name: "bot unittest",
      command: { argv: [python, "-m", "unittest", "discover", "-p", "test_*.py"], cwd: join(dir, "client"), mutates: true },
    },
    { name: "tsc", command: { argv: [bun, "x", "tsc", "--noEmit"], cwd: activity, mutates: true } },
    { name: "bun test", command: { argv: [bun, "test"], cwd: activity, mutates: true }, verify: reportsZeroFail },
    { name: "build (game)", command: { argv: [bun, "run", "build"], cwd: activity, env: { BUILD_ID: sha }, mutates: true } },
    { name: "build (site)", command: { argv: [bun, "run", "build:puzzledb"], cwd: activity, mutates: true } },
  ];
}

async function runStep(ctx: Context, step: Step): Promise<void> {
  const { clock, out } = ctx.host;
  const started = clock.now();
  const result = await execOk(ctx, step.command, step.name);
  const problem = ctx.dryRun ? null : step.verify?.(result);
  if (problem) throw new DeployError(`${step.name} failed: ${problem}\n${describeCommand(step.command)}\n${result.stderr.slice(-2000)}`);
  if (!ctx.dryRun) out(`  ok: ${step.name} (${Math.round((clock.now() - started) / 1000)} s)`);
}

/**
 * The client build must have recorded this release's id where the game reads
 * it at boot: a build that ignored `BUILD_ID` would serve a header naming the
 * wrong bundle, and every open activity would be told an update is ready.
 */
function verifyBuildId(ctx: Context, dir: string, sha: string): void {
  if (ctx.dryRun) return;
  const path = join(dir, "activity", "dist", BUILD_ID_FILE);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (!text.includes(sha)) {
    throw new DeployError(`the client build did not record ${shortSha(sha)} in ${path}; was it built with BUILD_ID?`);
  }
}

/** Prepare `ref`; returns the release's full sha. Throws, naming the step, on the first failure. */
export async function prepare(ctx: Context, ref: string): Promise<string> {
  const { layout, host } = ctx;
  if (ctx.dryRun) host.out("(dry run: the fetch is skipped, so refs resolve to what was fetched last)");
  await execOk(ctx, { argv: ["git", "-C", layout.repo, "fetch", "--prune", "origin"], mutates: true }, "git fetch");
  const sha = await resolveRef(ctx, ref);
  if (isPrepared(layout, sha)) {
    host.out(`${shortSha(sha)} is already prepared`);
    return sha;
  }
  requireSharedFiles(ctx, ["activityEnv", "botEnv", "puzzledbEnv"], "a release");
  const dir = releaseDir(layout, sha);
  if (existsSync(dir)) {
    host.out(`${dir} exists without a marker: checking it again in place`);
  } else {
    await execOk(ctx, { argv: ["git", "-C", layout.repo, "worktree", "add", "--detach", dir, sha], mutates: true }, "git worktree add");
  }
  linkShared(ctx, dir);
  const plan = steps(ctx, dir, sha);
  for (const step of plan) await runStep(ctx, step);
  verifyBuildId(ctx, dir, sha);
  const marker = { sha, preparedAt: new Date(host.clock.now()).toISOString(), checks: plan.map((step) => step.name) };
  writeFileAtomic(ctx, join(dir, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
  reportDone(ctx, `prepared ${shortSha(sha)} in ${dir}`);
  return sha;
}
