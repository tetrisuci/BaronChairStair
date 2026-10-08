/**
 * A fake production box for the deploy tool's tests: a temporary home laid
 * out the way the tool expects, a fake pm2 that keeps a process table, a fake
 * git, a clock that only moves when the tool sleeps, and status files the test
 * scripts as functions of that clock.
 *
 * Everything the tool does to the outside world goes through the `Host` this
 * builds, so a test can assert the exact commands, in order, and that a dry run
 * never sent one that changes anything.
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotStatus, GameStatus, RuntimeStatus } from "../shared/runtime-status";
import { parseConfig, type DeployConfig } from "../tools/deploy/config";
import type { Command, CommandResult, Context, Host, HttpReply, StatusReading } from "../tools/deploy/host";
import { layoutFor, releaseDir, type Layout } from "../tools/deploy/layout";
import { markerPath } from "../tools/deploy/release";
import type { DeployState } from "../tools/deploy/state";

export const OLD = "1111111111111111111111111111111111111111";
export const NEW = "2222222222222222222222222222222222222222";
export const NEWER = "3333333333333333333333333333333333333333";

export const BLUE = "bcs-game-blue";
export const GREEN = "bcs-game-green";
export const BOT = "bcs-bot";
export const SITE = "bcs-site";

export const START = 1_791_300_000_000;

export interface FakeProcess {
  readonly name: string;
  pid: number;
  status: string;
  readonly cwd: string;
}

interface EcosystemApp {
  readonly name: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

const requireFresh = createRequire(import.meta.url);

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

function failed(stderr: string): CommandResult {
  return { code: 1, stdout: "", stderr };
}

const directories: string[] = [];

/** Remove every home a test made. Call from `afterEach`. */
export function cleanUpBoxes(): void {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export class FakeBox {
  readonly home: string;
  readonly config: DeployConfig;
  readonly layout: Layout;
  readonly calls: Command[] = [];
  readonly lines: string[] = [];
  readonly processes = new Map<string, FakeProcess>();
  readonly alive = new Set<number>();
  readonly statuses = new Map<string, (now: number) => RuntimeStatus | null>();
  /** Refs the fake git resolves, beside any full sha, which resolves to itself. */
  readonly refs: Record<string, string> = { "refs/remotes/origin/main": NEW };
  /** What `git diff --name-only` prints. */
  diff: string[] = [];
  now = START;
  private nextPid = 5000;
  onStart: (name: string, app: EcosystemApp, pid: number) => void = () => {};
  onSignal: (name: string, signal: string) => void = () => {};
  /** Answer a command before the fakes do; undefined lets them. */
  respond: (command: Command) => CommandResult | undefined = () => undefined;
  probe: (url: string, now: number) => HttpReply | null = () => null;

  constructor(overrides: Record<string, unknown> = {}) {
    this.home = mkdtempSync(join(tmpdir(), "bcs-deploy-"));
    directories.push(this.home);
    const config = {
      home: this.home,
      pm2: { bot: BOT, gameSlots: [BLUE, GREEN], site: SITE },
      gamePort: 3001,
      sitePort: 3002,
      botPython: "/opt/bcs/venv/bin/python",
      bun: "/opt/bun/bin/bun",
      ...overrides,
    };
    this.config = parseConfig(JSON.stringify(config), "deploy.json");
    this.layout = layoutFor(this.home);
    for (const dir of [this.layout.repo, this.layout.releases, this.layout.shared]) mkdirSync(dir, { recursive: true });
    for (const file of ["activity.env", "bot.env", "puzzledb.env"]) {
      writeFileSync(join(this.layout.shared, file), "# placeholder\n");
    }
    // Empty files are valid empty SQLite databases; tests that need rows seed them.
    for (const file of ["daily.sqlite", "stats.db"]) writeFileSync(join(this.layout.shared, file), "");
  }

  context(options: { dryRun?: boolean; selfRelease?: string | null } = {}): Context {
    return {
      config: this.config,
      layout: this.layout,
      host: this.host(),
      dryRun: options.dryRun ?? false,
      bun: "/opt/bun/bin/bun",
      path: "/opt/bun/bin:/usr/bin:/bin",
      selfRelease: options.selfRelease ?? null,
    };
  }

  host(): Host {
    return {
      run: (command) => this.run(command),
      clock: {
        now: () => this.now,
        sleep: async (ms) => {
          this.now += ms;
        },
      },
      readStatus: (path) => this.readStatus(path),
      probe: async (url) => this.probe(url, this.now),
      pidAlive: (pid) => this.alive.has(pid),
      out: (line) => {
        this.lines.push(line);
      },
    };
  }

  /** Every command that reached the runner and changes state, as argv. */
  mutations(): string[][] {
    return this.calls.filter((call) => call.mutates).map((call) => [...call.argv]);
  }

  /** The pm2 commands that change state, without the leading `pm2`. */
  pm2Mutations(): string[][] {
    return this.mutations().filter((argv) => argv[0] === "pm2").map((argv) => argv.slice(1));
  }

  output(): string {
    return this.lines.join("\n");
  }

  addProcess(name: string, cwd: string, status = "online"): FakeProcess {
    const pid = this.nextPid++;
    const process = { name, pid, status, cwd };
    this.processes.set(name, process);
    if (status === "online") this.alive.add(pid);
    return process;
  }

  /** A release that has been through prepare: a directory and, beside it, its marker. */
  prepareRelease(sha: string, preparedAt = START): string {
    const dir = releaseDir(this.layout, sha);
    mkdirSync(join(dir, "activity", "data"), { recursive: true });
    mkdirSync(join(dir, "client"), { recursive: true });
    writeFileSync(
      markerPath(this.layout, sha),
      JSON.stringify({ sha, preparedAt: new Date(preparedAt).toISOString(), checks: [] }),
    );
    return dir;
  }

  writeState(state: Partial<DeployState>): void {
    const full = {
      version: 1,
      game: { activeSlot: null, release: null, previous: null },
      site: { release: null, previous: null },
      bot: { release: null, previous: null },
      updatedAt: null,
      ...state,
    };
    writeFileSync(this.layout.state, JSON.stringify(full));
  }

  readState(): DeployState {
    return JSON.parse(readFileSync(this.layout.state, "utf8")) as DeployState;
  }

  setStatus(path: string, provider: (now: number) => RuntimeStatus | null): void {
    this.statuses.set(path, provider);
  }

  private readStatus(path: string): StatusReading {
    const provider = this.statuses.get(path);
    if (!provider) return { present: false, status: null };
    return { present: true, status: provider(this.now) };
  }

  async run(command: Command): Promise<CommandResult> {
    this.calls.push(command);
    const answer = this.respond(command);
    if (answer) return answer;
    const [program, ...args] = command.argv;
    if (program === "pm2") return this.pm2(args);
    if (program === "git") return this.git(args);
    // A real `bun test` reports its counts on stderr; prepare insists on "0 fail".
    if (args[0] === "test") return { code: 0, stdout: "", stderr: " 1290 pass\n 104 skip\n 0 fail\n" };
    return ok();
  }

  private pm2(args: readonly string[]): CommandResult {
    const [verb] = args;
    if (verb === "jlist") {
      const list = [...this.processes.values()].map((p) => ({
        name: p.name,
        pid: p.pid,
        pm2_env: { status: p.status, pm_cwd: p.cwd, DISCORD_TOKEN: "never-printed" },
      }));
      return ok(JSON.stringify(list));
    }
    if (verb === "save") return ok();
    if (verb === "start") return this.pm2Start(args[1]!, args[3]!);
    if (verb === "sendSignal") {
      this.onSignal(args[2]!, args[1]!);
      return ok();
    }
    const process = this.processes.get(args[1]!);
    if (!process) return failed(`[PM2][ERROR] Process or Namespace ${args[1]} not found`);
    this.alive.delete(process.pid);
    if (verb === "delete") this.processes.delete(process.name);
    if (verb === "stop") {
      process.status = "stopped";
      process.pid = 0;
    }
    return ok();
  }

  private pm2Start(ecosystem: string, name: string): CommandResult {
    // The cache is keyed by the real path: on macOS the temporary home sits
    // under /var, a link to /private/var, so the path as given misses it and
    // every start would read the first ecosystem file ever loaded.
    delete requireFresh.cache[requireFresh.resolve(ecosystem)];
    const { apps } = requireFresh(ecosystem) as { apps: EcosystemApp[] };
    const app = apps.find((candidate) => candidate.name === name);
    if (!app) return failed(`[PM2][ERROR] app ${name} is not in ${ecosystem}`);
    const process = this.addProcess(name, app.cwd);
    this.onStart(name, app, process.pid);
    return ok();
  }

  private git(args: readonly string[]): CommandResult {
    const verb = args[2];
    if (verb === "rev-parse") {
      const ref = args[args.length - 1]!.replace(/\^\{commit\}$/, "");
      if (/^[0-9a-f]{40}$/.test(ref)) return ok(`${ref}\n`);
      const sha = this.refs[ref];
      return sha ? ok(`${sha}\n`) : failed(`fatal: bad revision '${ref}'`);
    }
    if (verb === "worktree" && args[3] === "add") {
      const dir = args[5]!;
      mkdirSync(join(dir, "activity", "data"), { recursive: true });
      mkdirSync(join(dir, "client"), { recursive: true });
      writeFileSync(join(dir, "client", "discord_bot.py"), "");
      writeFileSync(join(dir, "client", "changelog.py"), "");
      return ok();
    }
    if (verb === "worktree" && args[3] === "remove") {
      rmSync(args[5]!, { recursive: true, force: true });
      return ok();
    }
    if (verb === "worktree" && args[3] === "list") {
      // Every release directory still there is a worktree, as it is on the box.
      const releases = existsSync(this.layout.releases) ? readdirSync(this.layout.releases) : [];
      const dirs = releases.map((name) => join(this.layout.releases, name)).filter((dir) => statSync(dir).isDirectory());
      return ok([this.layout.repo, ...dirs].map((dir) => `worktree ${dir}\n`).join(""));
    }
    if (verb === "diff") return ok(this.diff.map((path) => `${path}\n`).join(""));
    return ok();
  }

  /** Make the client build write its id, the way the real build does. */
  writeBuildId(sha: string): void {
    const dist = join(releaseDir(this.layout, sha), "activity", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "build.json"), JSON.stringify({ buildId: sha }));
  }

  exists(path: string): boolean {
    return existsSync(path);
  }
}

export function gameStatus(fields: Partial<GameStatus> & { pid: number; buildId: string; updatedAt: number }): GameStatus {
  return {
    app: "game",
    port: 3001,
    state: "serving",
    startedAt: START - 60_000,
    duelsInMatch: 0,
    lobbies: 0,
    rushTicketsRecent: 0,
    sessionsRecent: 0,
    inflight: 0,
    ...fields,
  };
}

export function botStatus(fields: Partial<BotStatus> & { pid: number; buildId: string; updatedAt: number }): BotStatus {
  return {
    app: "bot",
    state: "ready",
    startedAt: START - 60_000,
    lastInteractionAt: null,
    inflight: 0,
    syncRunning: false,
    ...fields,
  };
}
