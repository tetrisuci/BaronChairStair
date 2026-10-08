/**
 * Everything the deploy does to the world outside its own memory, as one
 * object it is handed: run a command, read the clock and wait, read a status
 * file, ask an HTTP port, check a pid, print a line.
 *
 * Handed in rather than imported so the tests can replace all of it with a
 * fake box — a pm2 that keeps a table, a clock that moves only when the deploy
 * sleeps — and assert the exact commands a switch sends, in order. The real
 * one is `real-host.ts`. Files under the deploy's own home are the exception:
 * they are read and written directly, and the tests point the home at a
 * temporary directory.
 */

import type { RuntimeStatus } from "../../shared/runtime-status";
import type { DeployConfig } from "./config";
import type { Layout } from "./layout";

export interface Command {
  readonly argv: readonly string[];
  readonly cwd?: string;
  /** Added to the clean environment every command gets; never the tool's own. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Whether the command changes anything: pm2's process table, the repository,
   * or a release (an install or a build writes into it). A dry run prints such
   * a command instead of running it; a read runs either way.
   */
  readonly mutates: boolean;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Runner = (command: Command) => Promise<CommandResult>;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** A status file read back: whether it exists, and its contents if they are a status. */
export interface StatusReading {
  readonly present: boolean;
  readonly status: RuntimeStatus | null;
}

export interface HttpReply {
  readonly status: number;
  /** The `X-Build-Id` header, if the reply carried one. */
  readonly buildId: string | null;
  readonly body: string;
}

export interface Host {
  readonly run: Runner;
  readonly clock: Clock;
  readonly readStatus: (path: string) => StatusReading;
  /** A GET with a short timeout; null when nothing answered. */
  readonly probe: (url: string) => Promise<HttpReply | null>;
  readonly pidAlive: (pid: number) => boolean;
  readonly out: (line: string) => void;
}

/** One run of the tool: what it was configured with, and how it reaches the box. */
export interface Context {
  readonly config: DeployConfig;
  readonly layout: Layout;
  readonly host: Host;
  readonly dryRun: boolean;
  /** Absolute path of bun, for every check and every Bun app. */
  readonly bun: string;
  /** PATH for the apps: bun's directory first, so the bot's `/archive sync` finds it. */
  readonly path: string;
  /** The release this tool is running from, if it runs from one: never pruned. */
  readonly selfRelease: string | null;
}
