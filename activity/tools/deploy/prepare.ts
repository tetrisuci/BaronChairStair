/**
 * `prepare <ref>`: build and check a release in its own directory while the
 * box keeps serving the old one. Nothing running is touched.
 *
 * The order is the guides' order, and load-bearing: both installs come before
 * any check, the checks before either build, and the marker last — written
 * only when every step passed, so a switch can never pick up a release that
 * failed halfway.
 *
 * **No check can reach the live database or a secret.** The links to the env
 * files (activity/.env -> shared/activity.env, .env -> shared/bot.env) are
 * made only once every check and build has passed, and a release checked
 * again in place loses the ones an earlier run left before anything runs. Bun
 * loads the `.env` of its working directory under `bun test`, and
 * activity.env names the live database as `DATABASE_PATH`: a test file that
 * loaded the server's config before any test set its own scratch path would
 * fix the live file for the whole run, and every later route test would write
 * players, runs and submissions into it — on whichever box orders its test
 * files that way (Linux and macOS differ). So `bun test` also gets
 * `DATABASE_PATH` set to a scratch file in the release ({@link TEST_DATABASE}),
 * which beats any `.env`. Only the answer keys are linked before the checks:
 * the tests read them, and nothing writes them. A release that fails keeps no
 * link into shared/ at all. Nothing in the builds reads either env file.
 *
 * Commands run with the clean environment `real-host.ts` gives every command:
 * in particular no `STATS_DB`, so the bot's tests open a scratch `stats.db`
 * inside the release, never the shared one — which is also why a bot.env
 * that sets it, or anything else the deploy owns, is refused first
 * (`bot-env.ts`): the bot loads that file over its environment, and does so
 * from the release once it is linked.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILD_ID_FILE } from "../../shared/runtime-status";
import { requireBotEnvLeavesDeployVariables } from "./bot-env";
import { linkFile, removeFile, unlinkIfLink, writeFileAtomic } from "./effects";
import { DeployError } from "./errors";
import { describeCommand, execOk, reportDone } from "./exec";
import type { Command, CommandResult, Context } from "./host";
import { releaseDir, sharedFile, type SharedFile } from "./layout";
import { isPrepared, markerPath, resolveRef, shortSha } from "./release";
import { requireSharedFiles } from "./shared-files";

/**
 * The database `bun test` is pointed at, in the release's `activity/data/`
 * (ignored by git, as `activity/data/*.sqlite`). Removed before the run and
 * after a pass; one a failed run leaves is there to look at until the next.
 */
const TEST_DATABASE = "prepare-test.sqlite";

const SQLITE_SUFFIXES = ["", "-wal", "-shm"];

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

type Link = readonly [file: SharedFile, path: string];

/** The env files' links: made only once every check has passed. */
function envLinks(dir: string): readonly Link[] {
  return [
    ["activityEnv", join(dir, "activity", ".env")],
    ["botEnv", join(dir, ".env")],
  ];
}

function solutionsLink(dir: string): Link {
  return ["solutions", join(dir, "activity", "data", "solutions.json")];
}

function testDatabase(dir: string): string {
  return join(dir, "activity", "data", TEST_DATABASE);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The answer keys, if the box has them: the tests read them. */
function linkSolutions(ctx: Context, dir: string): void {
  const [file, path] = solutionsLink(dir);
  const solutions = sharedFile(ctx.layout, file);
  if (existsSync(solutions)) linkFile(ctx, solutions, path);
}

function linkEnvFiles(ctx: Context, dir: string): void {
  for (const [file, path] of envLinks(dir)) linkFile(ctx, sharedFile(ctx.layout, file), path);
}

/**
 * Before a release is checked again in place: take out the env links an
 * earlier run left, and refuse a real file where one goes — the checks would
 * load it.
 */
function clearEnvLinks(ctx: Context, dir: string): void {
  for (const [, path] of envLinks(dir)) {
    if (isSymlink(path)) {
      removeFile(ctx, path);
    } else if (existsSync(path)) {
      throw new DeployError(
        `${path} is not a link into shared/, and the checks would load it: move it aside and prepare again`,
      );
    }
  }
}

/** A release that failed keeps no link into shared/. Never hides the failure it follows. */
function unlinkShared(ctx: Context, dir: string): void {
  for (const [, path] of [...envLinks(dir), solutionsLink(dir)]) {
    try {
      unlinkIfLink(ctx, path);
    } catch (error) {
      ctx.host.out(`warning: could not remove the link ${path} (${(error as Error).message}); remove it by hand`);
    }
  }
}

function removeTestDatabase(ctx: Context, dir: string): void {
  for (const suffix of SQLITE_SUFFIXES) removeFile(ctx, `${testDatabase(dir)}${suffix}`);
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
    {
      name: "bun test",
      // Set, so it beats any `.env`: an inherited variable wins in Bun.
      command: { argv: [bun, "test"], cwd: activity, env: { DATABASE_PATH: testDatabase(dir) }, mutates: true },
      verify: reportsZeroFail,
    },
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

/** Run every step, then link the env files; a failure takes out every link it made. */
async function checkAndLink(ctx: Context, dir: string, sha: string): Promise<readonly string[]> {
  const plan = steps(ctx, dir, sha);
  try {
    linkSolutions(ctx, dir);
    removeTestDatabase(ctx, dir);
    for (const step of plan) await runStep(ctx, step);
    verifyBuildId(ctx, dir, sha);
    removeTestDatabase(ctx, dir);
  } catch (error) {
    unlinkShared(ctx, dir);
    throw error;
  }
  linkEnvFiles(ctx, dir);
  return plan.map((step) => step.name);
}

/** Prepare `ref`; returns the release's full sha. Throws, naming the step, on the first failure. */
export async function prepare(ctx: Context, ref: string): Promise<string> {
  const { layout, host } = ctx;
  if (ctx.dryRun) host.out("(dry run: the fetch is skipped, so refs resolve to what was fetched last)");
  await execOk(ctx, { argv: ["git", "-C", layout.repo, "fetch", "--prune", "origin"], mutates: true }, "git fetch");
  const sha = await resolveRef(ctx, ref);
  // Before "already prepared", so a deploy of a prepared release still stops here, not at the bot switch.
  requireBotEnvLeavesDeployVariables(ctx);
  requireSharedFiles(ctx, ["activityEnv", "botEnv", "puzzledbEnv"], "a release");
  const dir = releaseDir(layout, sha);
  if (isPrepared(layout, sha)) {
    // Its checks passed already; a link that went missing since is put back, never anything else.
    linkSolutions(ctx, dir);
    linkEnvFiles(ctx, dir);
    host.out(`${shortSha(sha)} is already prepared`);
    return sha;
  }
  if (existsSync(dir)) {
    host.out(`${dir} exists without a marker: checking it again in place`);
    clearEnvLinks(ctx, dir);
  } else {
    await execOk(ctx, { argv: ["git", "-C", layout.repo, "worktree", "add", "--detach", dir, sha], mutates: true }, "git worktree add");
  }
  const checks = await checkAndLink(ctx, dir, sha);
  const marker = { sha, preparedAt: new Date(host.clock.now()).toISOString(), checks };
  writeFileAtomic(ctx, markerPath(layout, sha), `${JSON.stringify(marker, null, 2)}\n`);
  reportDone(ctx, `prepared ${shortSha(sha)} in ${dir}`);
  return sha;
}
