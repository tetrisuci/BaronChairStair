/**
 * The host the CLI runs with on the box: real processes, the real clock, the
 * real status files.
 *
 * **Every command gets a clean environment.** The tool is started with
 * `bun run deploy`, and Bun loads the `.env` of whatever directory it was
 * started in — from inside a release's `activity/`, that is the game's
 * secrets. pm2 hands the environment of the shell that ran `pm2 start` to
 * the app it starts, so passing the tool's own environment on would give the
 * bot the game's secrets and the site the very variables it refuses to start
 * with. Only what a shell needs is passed; each app's own settings come from
 * its env file and the ecosystem file.
 *
 * **PATH is the deploy's own** ({@link searchPath}), not the one the tool was
 * started with, for the same reason the ecosystem's is.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { BUILD_ID_HEADER, readStatus } from "../../shared/runtime-status";
import type { CommandResult, Host, StatusReading } from "./host";

/** What a command may inherit from the tool's environment. Nothing else. */
const INHERITED = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "PM2_HOME", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK"];

const PROBE_TIMEOUT_MS = 3_000;

/** No such process: `kill(pid, 0)` answers this only when the pid is gone. */
const NO_SUCH_PROCESS = "ESRCH";

/** A directory `bun run` adds for a package's binaries: `<dir>/node_modules/.bin`. */
const PACKAGE_BIN_DIR = /\/node_modules\/\.bin\/?$/;

type Environment = Readonly<Record<string, string | undefined>>;

export function cleanEnvironment(source: Environment): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * The PATH every command and every app gets: bun's own directory first, then
 * the PATH the tool inherited with every `node_modules/.bin` taken out.
 *
 * `bun run deploy` puts `<cwd>/node_modules/.bin` and the same for every
 * ancestor directory in front of the PATH it hands the tool (measured on Bun
 * 1.3.13). Run from a release, that is releases/<sha>/activity/node_modules/.bin,
 * releases/<sha>/node_modules/.bin, releases/node_modules/.bin and so on up.
 * Written into the ecosystem file, they would send every app, for as long as
 * it runs, to the binaries of whichever release the tool happened to run
 * from — one a later prune deletes. A command that needs a package's binary
 * gets it from `bun run` or `bun x` in its own directory.
 */
export function searchPath(bun: string, inherited: string): string {
  const dirs = [dirname(bun), ...inherited.split(":").filter((dir) => !PACKAGE_BIN_DIR.test(dir))];
  return dirs.filter((dir, index) => dir !== "" && dirs.indexOf(dir) === index).join(":");
}

/** What a command runs with: the clean environment, the deploy's PATH, and the command's own additions. */
export function commandEnvironment(
  source: Environment,
  path: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...cleanEnvironment(source), PATH: path, ...extra };
}

async function runCommand(
  argv: readonly string[],
  cwd: string | undefined,
  env: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  try {
    const child = Bun.spawn([...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    // Bun.spawn throws when the program is not there at all.
    return { code: 127, stdout: "", stderr: (error as Error).message };
  }
}

/** A status file read from disk: missing, not a status (torn, foreign), or a status. */
export function readStatusFile(path: string): StatusReading {
  if (!existsSync(path)) return { present: false, status: null };
  try {
    return { present: true, status: readStatus(readFileSync(path, "utf8")) };
  } catch {
    return { present: true, status: null };
  }
}

/** The box's host; every command it runs gets `path` ({@link searchPath}) as its PATH. */
export function realHost(path: string): Host {
  return {
    run: (command) => runCommand(command.argv, command.cwd, commandEnvironment(process.env, path, command.env)),
    clock: {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    readStatus: readStatusFile,
    probe: async (url) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return { status: response.status, buildId: response.headers.get(BUILD_ID_HEADER), body: await response.text() };
      } catch {
        return null;
      }
    },
    pidAlive: (pid) => {
      if (pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM: it exists, and belongs to somebody else. Alive.
        return (error as NodeJS.ErrnoException).code !== NO_SUCH_PROCESS;
      }
    },
    out: (line) => console.log(line),
  };
}
