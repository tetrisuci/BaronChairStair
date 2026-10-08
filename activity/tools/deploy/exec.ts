/**
 * The one door every external command goes through.
 *
 * Three rules are enforced here rather than trusted to each caller, so no
 * future command can skip them:
 *
 * - **Never by pattern, never "all".** `pkill -f` has already taken down the
 *   wrong server on this box, and `pm2 stop all` would take DIAYN with it. pm2
 *   gets only the verbs the deploy needs, and SIGUSR1/SIGUSR2 are refused
 *   because Bun 1.3.13 dies on them before a handler runs.
 * - **A dry run sends nothing that changes anything.** A command marked
 *   `mutates` is printed as "would run: …" and answered with success; a read
 *   still runs, so the plan a dry run prints is computed from the real box.
 * - **Everything that changes something is echoed**, so the operator's
 *   terminal is a log of exactly what was done.
 */

import { basename } from "node:path";
import { DeployError } from "./errors";
import type { Command, CommandResult, Context } from "./host";

const FORBIDDEN_PROGRAMS = new Set(["pkill", "killall"]);

/** The pm2 verbs the deploy uses. Anything else — restart, reload, kill, flush — is refused. */
const PM2_VERBS = new Set(["jlist", "start", "stop", "delete", "sendSignal", "save"]);

const FORBIDDEN_SIGNALS = new Set(["SIGUSR1", "SIGUSR2"]);

/** How much of a failed command's output is shown: enough to see the error. */
const FAILURE_TAIL_LINES = 40;

/** Throws for a command the deploy must never run, whoever asked for it. */
export function assertSafeCommand(argv: readonly string[]): void {
  const program = basename(argv[0] ?? "");
  if (FORBIDDEN_PROGRAMS.has(program)) {
    throw new DeployError(`the deploy never runs ${program}: kill a process by its exact pid, or through pm2 by name`);
  }
  if (program !== "pm2") return;
  const verb = argv[1] ?? "";
  if (!PM2_VERBS.has(verb)) {
    throw new DeployError(`the deploy never runs "pm2 ${verb}": it uses only ${[...PM2_VERBS].join(", ")}`);
  }
  if (argv.slice(2).includes("all")) {
    throw new DeployError(`the deploy never sends pm2 a command for "all": DIAYN runs under the same pm2`);
  }
  const signal = argv.slice(2).find((arg) => FORBIDDEN_SIGNALS.has(arg));
  if (signal) {
    throw new DeployError(`the deploy never sends ${signal}: Bun 1.3.13 ends or crashes before any handler sees it`);
  }
}

function quote(arg: string): string {
  return /^[\w@%+=:,./^{}-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/** A command as an operator could paste it: its extra environment, argv, and where it runs. */
export function describeCommand(command: Command): string {
  const env = Object.entries(command.env ?? {}).map(([key, value]) => `${key}=${quote(value)} `);
  const where = command.cwd ? `   (in ${command.cwd})` : "";
  return `${env.join("")}${command.argv.map(quote).join(" ")}${where}`;
}

export async function exec(ctx: Context, command: Command): Promise<CommandResult> {
  assertSafeCommand(command.argv);
  if (command.mutates) {
    if (ctx.dryRun) {
      ctx.host.out(`would run: ${describeCommand(command)}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    ctx.host.out(`$ ${describeCommand(command)}`);
  }
  return ctx.host.run(command);
}

/** A step's closing line: said as done, or in a dry run, as what would have been. */
export function reportDone(ctx: Context, line: string): void {
  ctx.host.out(ctx.dryRun ? `(dry run, not done) ${line}` : line);
}

/** The last lines of a command's output, for a failure message. */
export function outputTail(result: CommandResult): string {
  const lines = `${result.stdout}\n${result.stderr}`.split("\n").filter((line) => line.trim() !== "");
  return lines.slice(-FAILURE_TAIL_LINES).join("\n");
}

/** Run a command that must succeed; a failure names `what` and shows the end of its output. */
export async function execOk(ctx: Context, command: Command, what: string): Promise<CommandResult> {
  const result = await exec(ctx, command);
  if (result.code !== 0) {
    const tail = outputTail(result);
    throw new DeployError(`${what} failed (exit ${result.code}): ${describeCommand(command)}${tail ? `\n${tail}` : ""}`);
  }
  return result;
}
