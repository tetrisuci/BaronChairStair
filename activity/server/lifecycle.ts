/**
 * The game process from start to exit: what it tells the deploy, and what it
 * does when the deploy signals it. The contract it keeps is
 * `shared/runtime-status.ts`; this is the game's half of it.
 *
 * **States.** `starting` from the moment the module loads, `serving` once Bun
 * is listening, `draining` after `SIGHUP`, `stopping` after `SIGINT` or
 * `SIGTERM`. Each change is written to the status file at once, and the file
 * is rewritten every {@link STATUS_INTERVAL_MS} so its counts stay current and
 * its age says the process is alive.
 *
 * **Drain is a handover.** A newer process is already listening on the same
 * port (both bind it with `reusePort`), so this one stops listening — after
 * which every new connection reaches the newer one — sends away every duel
 * socket that is not in a match, since the player loses nothing by reopening,
 * and keeps every match it is refereeing until that match is over. What still
 * arrives on a connection opened earlier is answered with `Connection: close`,
 * so a proxy holding a keep-alive connection to this process lets it go and
 * opens its next one to the new process. A drain never ends by itself: the
 * deploy watches the counts and sends `SIGTERM` once they reach nothing, or
 * once it stops waiting.
 *
 * **Stop is an exit.** Stop listening, give the requests already in flight a
 * few seconds — a hand-in is a replay of somebody's run, and cutting it off is
 * losing it — close every duel socket with 1012 "restart", write the last
 * status, exit 0. A second stop signal exits at once, still closing the duel
 * sockets on the way out; one that arrives within
 * {@link STOP_REPEAT_WINDOW_MS} of the first is not a second stop but the same
 * one delivered twice, and changes nothing.
 *
 * Nothing in here reads the environment or imports the server's
 * configuration: `server/index.ts` hands it everything, so the tests can drive
 * every transition with a fake listener, a fake registry and a clock.
 */

import type { Server } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  BUILD_ID_HEADER,
  SIGNALS,
  STATUS_INTERVAL_MS,
  type GameState,
  type GameStatus,
} from "../shared/runtime-status";
import { Activity } from "./activity";
import { StatusFile, type StatusLog } from "./status-file";

/** How long a stop waits for requests in flight before it ends the duels and exits. */
const STOP_GRACE_MS = 8_000;
/**
 * How soon after a stop another stop signal is that same stop arriving twice,
 * rather than somebody asking for an exit now.
 *
 * `bun run start` puts Bun's script runner between the process manager and the
 * game, and the runner forwards SIGINT and SIGTERM to the game. pm2 signals
 * the whole process tree on a stop or restart (its `treekill` default),
 * systemd's default `KillMode=control-group` signals every process in the
 * unit, and a Ctrl-C in a terminal signals the whole foreground group — so the
 * game is sent one stop twice, once directly and once forwarded, measured on
 * Bun 1.3.13 at well under a millisecond apart. Read as a person's second
 * Ctrl-C, it skipped the grace and the 1012 closes on every ordinary restart.
 *
 * Two seconds is thousands of times that gap, and still less time than a
 * person takes to decide the first Ctrl-C is not working.
 */
export const STOP_REPEAT_WINDOW_MS = 2_000;
const INFLIGHT_POLL_MS = 25;
/**
 * A beat between closing the duel sockets and exiting, for the close frames to
 * leave. Measured unnecessary on loopback; a far end on a slow link is not
 * loopback, and a tenth of a second is nothing at the end of a stop.
 */
const CLOSE_FLUSH_MS = 100;
/** Any period does; the timer exists only to be pending. See {@link Lifecycle.drain}. */
const KEEP_ALIVE_MS = 60_000;

/** What the lifecycle needs from the duel registry (`server/duel.ts`). */
export interface DuelControl {
  counts(): { readonly duelsInMatch: number; readonly lobbies: number };
  /** Send away every socket not in a match; refuse rematches from now on. */
  drain(): void;
  /** Close every socket that is left, matches included. */
  closeAll(): void;
}

/** The part of Bun's server the lifecycle uses. */
export interface Listener {
  stop(): unknown;
  readonly port?: number;
}

export type LifecycleLog = StatusLog;

export interface LifecycleOptions {
  /** The server process's startup identity, retained in its status file. */
  readonly buildId: string;
  /** The bundle on disk now; a manual rebuild can change it before a restart. */
  readonly servedBuildId?: () => string;
  /** The configured port, until the listener says which one it got. */
  readonly port: number;
  /** Absolute path of the status file, or null to write none. */
  readonly statusFile: string | null;
  readonly duels: DuelControl;
  readonly now?: () => number;
  readonly pid?: number;
  /** `process.exit`, unless a test would rather watch it be called. */
  readonly exit?: (code: number) => void;
  readonly log?: LifecycleLog;
  readonly stopGraceMs?: number;
  readonly flushMs?: number;
}

/** How a request reaches the routes, in the shape Bun's `fetch` has. */
type Route<S> = (request: Request, server: S | undefined) => Response | Promise<Response>;

export interface Health {
  readonly ok: true;
  readonly buildId: string;
  readonly state: GameState;
}

export class Lifecycle {
  readonly activity: Activity;
  readonly buildId: string;
  private readonly readServedBuildId: () => string;
  private readonly requestBuild = new AsyncLocalStorage<string>();
  private current: GameState = "starting";
  private port: number;
  private readonly startedAt: number;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly duels: DuelControl;
  private readonly exit: (code: number) => void;
  private readonly log: LifecycleLog;
  private readonly stopGraceMs: number;
  private readonly flushMs: number;
  private readonly file: StatusFile | null;
  private listener: Listener | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  /** When the first stop signal arrived, and the stop it started. */
  private stopping: { readonly at: number; readonly done: Promise<void> } | null = null;

  constructor(options: LifecycleOptions) {
    this.buildId = options.buildId;
    this.readServedBuildId = options.servedBuildId ?? (() => this.buildId);
    this.port = options.port;
    this.duels = options.duels;
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.log = options.log ?? console;
    this.stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
    this.flushMs = options.flushMs ?? CLOSE_FLUSH_MS;
    this.activity = new Activity(this.now);
    this.startedAt = this.now();
    this.file = options.statusFile ? new StatusFile(options.statusFile, this.pid, this.log) : null;
    // At once, so a deploy waiting on a new process sees it is up and booting
    // rather than a stale file from whatever ran before it.
    this.writeStatus();
  }

  get state(): GameState {
    return this.current;
  }

  /**
   * The bundle served by this request, or the current one outside a request.
   * Take it once per request: an async route may straddle a rebuild, but its
   * JSON body and its response header must still tell the page the same id.
   * The process's status keeps `buildId`, because new client files are not
   * new server code and must not masquerade as a newly started release.
   */
  get servedBuildId(): string {
    return this.requestBuild.getStore() ?? this.readServedBuildId();
  }

  /** Whether this process is on its way out, and should say so on every response. */
  private get goingAway(): boolean {
    return this.current === "draining" || this.current === "stopping";
  }

  status(): GameStatus {
    return {
      app: "game",
      pid: this.pid,
      buildId: this.buildId,
      port: this.port,
      state: this.current,
      startedAt: this.startedAt,
      updatedAt: this.now(),
      ...this.duels.counts(),
      ...this.activity.counts(),
    };
  }

  /** `GET /api/health`: cheap enough to poll, and touches no database. */
  health(): Health {
    return { ok: true, buildId: this.servedBuildId, state: this.current };
  }

  /** Rewrites the status file now. A no-op without one; never throws. */
  writeStatus(): void {
    this.file?.write(this.status());
  }

  /**
   * Every request, around whatever answers it: counted while in flight, and
   * stamped with the build that answered.
   *
   * A duel upgrade that arrives while going away is refused before it reaches
   * the duel module: a socket opened now would be one more thing to close, and
   * the player's next try lands on the new process.
   */
  async handle<S>(request: Request, server: S | undefined, route: Route<S>): Promise<Response> {
    this.activity.requestStarted();
    try {
      return await this.requestBuild.run(this.readServedBuildId(), async () => {
        if (this.goingAway && isUpgrade(request)) return this.stamp(refusedUpgrade());
        return this.stamp(await route(request, server));
      });
    } finally {
      this.activity.requestFinished();
    }
  }

  /** Bun is listening: the process is serving. */
  listening(listener: Listener): void {
    if (this.current !== "starting") return;
    this.listener = listener;
    if (typeof listener.port === "number") this.port = listener.port;
    if (this.file) {
      // Unref'd: serving, the listener keeps the process alive; draining, the
      // keep-alive does; stopping, nothing should.
      this.statusTimer = setInterval(() => this.writeStatus(), STATUS_INTERVAL_MS);
      this.statusTimer.unref?.();
    }
    this.current = "serving";
    this.writeStatus();
  }

  /** `SIGHUP`: hand over to the process that is already listening beside this one. */
  drain(): void {
    if (this.goingAway) {
      this.log.log(`[lifecycle] already ${this.current}; ignoring a drain`);
      return;
    }
    this.current = "draining";
    // Listening first, sockets second: a player sent away reconnects at once,
    // and must find nothing here to reconnect to.
    this.listener?.stop();
    // Bun ends a process once its server has stopped listening and nothing
    // else is pending, and an open WebSocket does not count: measured on Bun
    // 1.3.13, its sockets then die with 1006. A match's own round timer holds
    // the process only while that match lasts; this holds it until the
    // deploy's SIGTERM, as the contract promises, matches or none.
    this.keepAlive = setInterval(() => {}, KEEP_ALIVE_MS);
    this.duels.drain();
    // After the duels, so the first status the deploy reads already counts
    // the lobbies as gone.
    this.writeStatus();
    const { duelsInMatch } = this.duels.counts();
    this.log.log(`[lifecycle] draining: no longer listening, ${duelsInMatch} match(es) still being played`);
  }

  /**
   * `SIGINT` or `SIGTERM`: finish what is in flight, end the duels, exit 0.
   *
   * A repeat within {@link STOP_REPEAT_WINDOW_MS} of the first is answered
   * with the stop already under way; one after it exits at once.
   */
  stop(): Promise<void> {
    if (!this.stopping) {
      const at = this.now();
      const done = this.stopGracefully();
      this.stopping = { at, done };
      return done;
    }
    const since = this.now() - this.stopping.at;
    if (since < STOP_REPEAT_WINDOW_MS) {
      this.log.log(`[lifecycle] the same stop signal again, ${since} ms later: still stopping`);
      return this.stopping.done;
    }
    this.exitNow();
    return Promise.resolve();
  }

  private async stopGracefully(): Promise<void> {
    const stillListening = this.current !== "draining";
    this.current = "stopping";
    if (stillListening) this.listener?.stop();
    this.writeStatus();

    await this.settle();
    this.duels.closeAll();
    if (this.flushMs > 0) await Bun.sleep(this.flushMs);
    this.clearTimers();
    this.writeStatus();
    this.log.log("[lifecycle] stopped");
    this.exit(0);
  }

  /**
   * A second stop: no more waiting, so whatever is still in flight is cut off.
   *
   * The duel sockets are still closed with 1012 "restart" on the way out,
   * because it costs nothing: `closeAll` is synchronous, and a close frame
   * written just before `process.exit` still reaches the far end — measured on
   * Bun 1.3.13 over loopback, 1012 for every socket, where exiting without it
   * gives 1006, which a player is shown as a lost connection.
   */
  private exitNow(): void {
    this.log.warn("[lifecycle] a second stop signal: exiting now");
    this.duels.closeAll();
    this.writeStatus();
    this.exit(0);
  }

  /**
   * Waits for the requests in flight, for at most the grace.
   *
   * Counted in polls rather than read off a clock, so a test's frozen clock —
   * `tests/harness.ts` freezes `performance` for the whole run — cannot make
   * it wait forever.
   */
  private async settle(): Promise<void> {
    for (let waited = 0; waited < this.stopGraceMs; waited += INFLIGHT_POLL_MS) {
      if (this.activity.counts().inflight === 0) return;
      await Bun.sleep(INFLIGHT_POLL_MS);
    }
    this.log.warn(`[lifecycle] stopping with ${this.activity.counts().inflight} request(s) unanswered`);
  }

  private clearTimers(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.statusTimer = null;
    this.keepAlive = null;
  }

  private stamp(response: Response): Response {
    const headers: [string, string][] = [[BUILD_ID_HEADER, this.servedBuildId]];
    if (this.goingAway) headers.push(["Connection", "close"]);
    return withHeaders(response, headers);
  }
}

function isUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function refusedUpgrade(): Response {
  return Response.json(
    { error: "The server is updating. Open Duel again in a moment." },
    { status: 503, headers: { "Retry-After": "1" } },
  );
}

/**
 * The response with these headers set.
 *
 * In place where the headers allow it, which is nearly always; a response
 * whose headers are immutable — `Response.redirect` builds one — is copied
 * rather than left without them.
 */
function withHeaders(response: Response, headers: readonly [string, string][]): Response {
  try {
    for (const [name, value] of headers) response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    for (const [name, value] of headers) copy.headers.set(name, value);
    return copy;
  }
}

/**
 * Starts listening and hands the process to the lifecycle: the status file
 * says `serving`, and the signals in `SIGNALS` mean what the contract says.
 */
export function serveWithLifecycle<T>(
  lifecycle: Lifecycle,
  options: Parameters<typeof Bun.serve<T>>[0],
): Server<T> {
  const server = Bun.serve<T>(options);
  lifecycle.listening(server);
  listenForSignals(lifecycle);
  return server;
}

/**
 * Where the handlers of the previous evaluation are kept, so they can be
 * taken off again. `bun --hot` re-runs this module on every save in the same
 * process, and without this each save would add another set of handlers, each
 * driving a lifecycle that no longer serves anything.
 */
const INSTALLED = Symbol.for("baronchairstair.game.signal-handlers");

type Installed = readonly (readonly [NodeJS.Signals, () => void])[];

function listenForSignals(lifecycle: Lifecycle): void {
  const registry = globalThis as unknown as Record<symbol, Installed | undefined>;
  for (const [signal, handler] of registry[INSTALLED] ?? []) process.off(signal, handler);
  const installed: Installed = [
    [SIGNALS.drain, () => lifecycle.drain()],
    ...SIGNALS.stop.map((signal) => [signal, () => void lifecycle.stop()] as const),
  ];
  for (const [signal, handler] of installed) process.on(signal, handler);
  registry[INSTALLED] = installed;
}
