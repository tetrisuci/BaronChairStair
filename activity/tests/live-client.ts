/**
 * The whole `App`, booted in happy-dom against a scripted network, for the
 * suites that pin how the activity rides out a deploy
 * (`live-client-app.test.ts`, `live-client-daily.test.ts`).
 *
 * One copy, because the page, the network and the reach into the app's
 * private members have to agree across both: a suite that booted the app its
 * own way would be testing a different wiring from the one it claims to.
 *
 * Private members are reached through {@link Internals}, the way
 * `duel-client.test.ts` reaches `receive`: playing a puzzle to a solve by
 * keystrokes would test the engine, and the engine has its own suites.
 */

import { afterAll, afterEach, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { App } from "../client/src/app";
import { Api, type RetryClock } from "../client/src/api";
import type { Connection } from "../client/src/discord";
import type { RunSnapshot } from "../client/src/game/runner";
import type { GameKey } from "../shared/tetris/verify";
import type { RushSession } from "../client/src/game/rush";
import type { PlayMode } from "../client/src/game/active-run";
import { SettingsStore } from "../client/src/settings";
import { BUILD_ID_HEADER } from "../shared/runtime-status";
import { type Puzzle, toPrompt } from "../shared/puzzle";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";
import { RUSH_DURATION_MS } from "../shared/rush";

// ── The page ─────────────────────────────────────────────────────────────────

/** A 2D context that takes every call and draws nothing; see puzzledb-page.test.ts. */
function silentContext(): unknown {
  return new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

/** A duel socket that never touches the network; the test closes it from the server's side. */
export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly opened: FakeSocket[] = [];

  readyState = FakeSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1005, reason: "" });
  }

  drop(code: number, reason: string, { error = false } = {}): void {
    this.readyState = FakeSocket.CLOSED;
    if (error) this.onerror?.({});
    this.onclose?.({ code, reason });
  }
}

let window: Window;
const running: App[] = [];

/**
 * Installs the page for the calling suite, and takes it down after.
 *
 * Scoped to the suite, for the reason render.test.ts gives: `bun test` shares
 * one process, and the server suites lean on Bun's own globals. Call it once,
 * at the top level of the test file.
 */
export function usePage(): void {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    ResizeObserver: globalThis.ResizeObserver,
    WebSocket: globalThis.WebSocket,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };

  beforeAll(() => {
    window = new Window({
      url: "https://local.test/",
      settings: {
        canvasAdapter: {
          getContext: () => silentContext(),
          toDataURL: () => "",
          toBlob: (_caller: unknown, done: (blob: null) => void) => done(null),
        } as never,
      },
    });
    globalThis.document = window.document as unknown as Document;
    globalThis.window = window as unknown as typeof globalThis.window;
    globalThis.localStorage = window.localStorage as unknown as Storage;
    globalThis.ResizeObserver = window.ResizeObserver as unknown as typeof ResizeObserver;
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    // Frames never arrive: a run waits for input, a rush's clock never reaches
    // its buzzer, and nothing animates behind the test's back.
    globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    for (const app of running.splice(0)) app.dispose();
    window.document.body.replaceChildren();
    window.localStorage.clear();
  });

  afterAll(async () => {
    Object.assign(globalThis, saved);
    await window.happyDOM.close();
  });
}

// ── The data ─────────────────────────────────────────────────────────────────

const archive: Puzzle[] = JSON.parse(readFileSync("data/puzzles.json", "utf8")).puzzles;
export const PROMPTS = archive.slice(0, 6).map((puzzle) => toPrompt(puzzle));
export const PLAYER = { id: "player-1", username: "Tester", avatarUrl: null };
export const DAY = 412;
export const RUSH_TICKET = "payload.signature";

/** The puzzle each tier deals in {@link dailyBody}. */
export function tierPuzzle(tier: DailyTier) {
  return PROMPTS[DAILY_TIERS.indexOf(tier)]!;
}

export function dailyBody(day: number) {
  return {
    day,
    resetsAt: Date.now() + 3_600_000,
    puzzles: DAILY_TIERS.map((tier) => ({ tier, puzzle: tierPuzzle(tier), run: null, solution: null })),
    streak: 0,
    totalSolved: 0,
  };
}

function storedRun(puzzleId: number) {
  return {
    day: DAY,
    puzzleId,
    player: PLAYER,
    solved: true,
    attack: 4,
    targetAttack: 4,
    durationMs: 9_000,
    totalMs: 12_000,
    resets: 0,
    piecesPlaced: 3,
    clears: [],
    createdAt: Date.now(),
  };
}

/** The server's answer to a daily filing of `tier`. */
export function filedBody(isFirst = true, tier: DailyTier = "easy") {
  return {
    tier,
    run: storedRun(tierPuzzle(tier).id),
    isFirst,
    discovery: null,
    streak: 1,
    totalSolved: 1,
    solution: null,
    leaderboard: [],
  };
}

export const rushRun = { day: DAY, player: PLAYER, solved: 2, attempted: 3, skipsUsed: 0, timeToLastSolveMs: 90_000, elapsedMs: 300_000, createdAt: 1 };

/** The server's answer to a rush hand-in. */
export function rushFiled(isFirst = true) {
  return { ranked: true, played: [], run: rushRun, isFirst, best: 2, leaderboard: [] };
}

// ── The network ──────────────────────────────────────────────────────────────

export interface Request {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

/**
 * The test's own answer to a request; 404 falls through to {@link background}.
 * A promise holds the request open — the way a hand-in sits unanswered while
 * the server restarts — until the test lets it go.
 */
export type Route = (request: Request) => Response | Promise<Response>;

export function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const proxyDown = (status = 502): Response =>
  new Response("<html>Bad Gateway</html>", { status, headers: { "Content-Type": "text/html" } });

/** The reads every screen makes, answered plausibly, so a test names only the route it is about. */
function background(request: Request): Response {
  const key = `${request.method} ${request.path}`;
  switch (key) {
    case "GET /api/daily":
      return reply(200, dailyBody(DAY));
    case "GET /api/rush":
      return reply(200, { day: DAY, resetsAt: Date.now() + 3_600_000, durationMs: RUSH_DURATION_MS, skips: 2, run: null, best: 0, leaderboard: [] });
    case "GET /api/rush/records?scope=global":
      return reply(200, { scope: "global", entries: [] });
    case "POST /api/rush/start":
      return reply(200, { ticket: RUSH_TICKET, ranked: true, day: DAY, durationMs: RUSH_DURATION_MS, skips: 2, puzzles: PROMPTS.slice(0, 3) });
    default:
      return reply(404, { error: "No such endpoint" });
  }
}

/** A clock that never waits: every retry's sleep returns at once, so a fifteen-second schedule runs in a blink. */
const instant: RetryClock = { now: () => Date.now(), sleep: () => Promise.resolve() };

/** A promise the test keeps closed until it says otherwise. */
export function gate(): { readonly opened: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((done) => {
    open = done;
  });
  return { opened, open: () => open() };
}

// ── The app ──────────────────────────────────────────────────────────────────

export interface Booted {
  readonly app: App;
  readonly api: Api;
  readonly root: HTMLElement;
  readonly sent: Request[];
  readonly toasts: string[];
}

export async function boot(
  route: Route = () => reply(404, {}),
  { clientBuild = "dev", serverBuild = null as string | null } = {},
): Promise<Booted> {
  const sent: Request[] = [];
  const network = async (url: string, init: RequestInit): Promise<Response> => {
    const request: Request = {
      method: init.method ?? "GET",
      path: url,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    };
    sent.push(request);
    // A route the test did not script falls through to the background reads.
    const own = await route(request);
    const answer = own.status === 404 ? background(request) : own;
    if (serverBuild) answer.headers.set(BUILD_ID_HEADER, serverBuild);
    return answer;
  };
  const api = new Api("", { fetch: network, clock: instant });
  const settings = await SettingsStore.load(api, PLAYER.id);
  const root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(root as never);
  const connection: Connection = {
    api,
    player: PLAYER,
    guildId: null,
    inDiscord: false,
    guest: false,
    openLink: () => undefined,
  };
  const app = new App(root, connection, settings, clientBuild);
  running.push(app);
  const toasts: string[] = [];
  const inner = internals(app);
  const paint = inner.toast.bind(app);
  inner.toast = (message: string, holdMs?: number) => {
    toasts.push(message);
    paint(message, holdMs);
  };
  await app.start();
  return { app, api, root, sent, toasts };
}

/** What the tests reach for inside the app. */
export interface Internals {
  mode: PlayMode;
  daily: { day: number; puzzles: readonly { tier: DailyTier; run: unknown }[] } | null;
  cleared: ReadonlySet<number>;
  run: { snapshot(): RunSnapshot; tap(key: GameKey): void } | null;
  rush: RushSession | null;
  rushTicket: { readonly token: string; readonly handInBy: number } | null;
  duel: unknown;
  toast(message: string, holdMs?: number): void;
  showHome(): void;
  showDailyTier(tier: DailyTier): void;
  openArchivePuzzle(id: number): Promise<void>;
  startRun(): void;
  finishRun(snapshot: RunSnapshot, events: readonly unknown[]): Promise<void>;
  enterRush(): void;
  beginRush(practice: boolean): Promise<void>;
  enterDuel(): void;
  tickChrome(): void;
}

export function internals(app: App): Internals {
  return app as unknown as Internals;
}

/** Lets every promise already queued settle, a few times over. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((done) => setTimeout(done, 0));
}

export function posts(sent: readonly Request[], path: string): Request[] {
  return sent.filter((request) => request.method === "POST" && request.path === path);
}

/**
 * Plays one of the day's tiers to a finish without pressing a key.
 *
 * The snapshot is made up, so the run itself stays "ready" — a test about
 * what the chip reads off the run's own phase has to play it for real.
 */
export async function finishTier(booted: Booted, tier: DailyTier, phase: "solved" | "failed" = "solved"): Promise<void> {
  const inner = internals(booted.app);
  inner.showDailyTier(tier);
  const snapshot = { ...inner.run!.snapshot(), phase };
  await inner.finishRun(snapshot, []);
}

export function finishEasy(booted: Booted, phase: "solved" | "failed" = "solved"): Promise<void> {
  return finishTier(booted, "easy", phase);
}

export async function startRush(booted: Booted): Promise<Internals> {
  const inner = internals(booted.app);
  inner.enterRush();
  await settle();
  await inner.beginRush(false);
  return inner;
}

/** The captions of every panel on the page, in order: "Result", "Leaderboard", "Rush over"… */
export function panelCaptions(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".panel__caption")].map((caption) => caption.textContent ?? "");
}

export function chip(root: HTMLElement): HTMLElement {
  const found = root.querySelector<HTMLElement>(".update-chip");
  if (!found) throw new Error("No update chip in the chrome");
  return found;
}
