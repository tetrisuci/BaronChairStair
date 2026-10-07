/**
 * The activity riding out a deploy: the whole `App`, booted in happy-dom
 * against a scripted network, doing the four things a server restart used to
 * break.
 *
 * - A daily hand-in sent into the restart is asked again, says
 *   "Reconnecting…" while it waits, and names the day it was dealt on — so a
 *   sheet solved across midnight is refused (409) rather than replayed against
 *   the next day's puzzle, and the client then reads the new day.
 * - A rush hand-in keeps its ticket until the server answers, gives up when
 *   the server's own grace would, and never pulls a player who has moved on
 *   back to its result.
 * - A duel closed by the server says why, once, and leaves duel mode — so
 *   pressing Duel again opens a new lobby instead of doing nothing.
 * - A newer build on the server shows a quiet chip, never while the player is
 *   in the middle of a run, a rush or a duel.
 *
 * The parts are tested on their own elsewhere (`hand-in-retry`, `duel-close`,
 * `update-offer`). This file pins the wiring between them, which is where each
 * of these broke: the pieces were right and `app.ts` did not use them.
 *
 * Private members are reached through {@link Internals}, the way
 * `duel-client.test.ts` reaches `receive`: playing a puzzle to a solve by
 * keystrokes would test the engine, and the engine has its own suites.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { App } from "../client/src/app";
import { Api, type HandInOptions, type RetryClock } from "../client/src/api";
import type { Connection } from "../client/src/discord";
import type { RunSnapshot } from "../client/src/game/runner";
import type { GameKey } from "../shared/tetris/verify";
import type { RushSession } from "../client/src/game/rush";
import type { PlayMode } from "../client/src/game/active-run";
import { SettingsStore } from "../client/src/settings";
import { BUILD_ID_HEADER } from "../shared/runtime-status";
import { type Puzzle, toPrompt } from "../shared/puzzle";
import { DAILY_TIERS } from "../shared/daily";
import { RUSH_DURATION_MS } from "../shared/rush";
import { RUSH_GRACE_MS, RUSH_HAND_IN_MARGIN_MS } from "../client/src/game/rush";

// ── The page ─────────────────────────────────────────────────────────────────

/** A 2D context that takes every call and draws nothing; see puzzledb-page.test.ts. */
function silentContext(): unknown {
  return new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

/** A duel socket that never touches the network; the test closes it from the server's side. */
class FakeSocket {
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
  // Scoped to this file, for the reason render.test.ts gives: `bun test` shares
  // one process, and the server suites lean on Bun's own globals.
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

afterAll(async () => {
  Object.assign(globalThis, saved);
  await window.happyDOM.close();
});

// ── The data ─────────────────────────────────────────────────────────────────

const archive: Puzzle[] = JSON.parse(readFileSync("data/puzzles.json", "utf8")).puzzles;
const PROMPTS = archive.slice(0, 6).map((puzzle) => toPrompt(puzzle));
const PLAYER = { id: "player-1", username: "Tester", avatarUrl: null };
const DAY = 412;
const RUSH_TICKET = "payload.signature";

function dailyBody(day: number) {
  return {
    day,
    resetsAt: Date.now() + 3_600_000,
    puzzles: DAILY_TIERS.map((tier, index) => ({ tier, puzzle: PROMPTS[index]!, run: null, solution: null })),
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

function filedBody(isFirst = true) {
  return {
    tier: "easy",
    run: storedRun(PROMPTS[0]!.id),
    isFirst,
    discovery: null,
    streak: 1,
    totalSolved: 1,
    solution: null,
    leaderboard: [],
  };
}

const rushRun = { day: DAY, player: PLAYER, solved: 2, attempted: 3, skipsUsed: 0, timeToLastSolveMs: 90_000, elapsedMs: 300_000, createdAt: 1 };

// ── The network ──────────────────────────────────────────────────────────────

interface Request {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

type Route = (request: Request) => Response;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const proxyDown = (status = 502): Response =>
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

interface Booted {
  readonly app: App;
  readonly api: Api;
  readonly root: HTMLElement;
  readonly sent: Request[];
  readonly toasts: string[];
}

const running: App[] = [];

afterEach(() => {
  for (const app of running.splice(0)) app.dispose();
  window.document.body.replaceChildren();
  window.localStorage.clear();
});

async function boot(
  route: Route = () => reply(404, {}),
  { clientBuild = "dev", serverBuild = null as string | null } = {},
): Promise<Booted> {
  const sent: Request[] = [];
  const network = (url: string, init: RequestInit): Promise<Response> => {
    const request: Request = {
      method: init.method ?? "GET",
      path: url,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    };
    sent.push(request);
    // A route the test did not script falls through to the background reads.
    const own = route(request);
    const answer = own.status === 404 ? background(request) : own;
    if (serverBuild) answer.headers.set(BUILD_ID_HEADER, serverBuild);
    return Promise.resolve(answer);
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
interface Internals {
  mode: PlayMode;
  daily: { day: number } | null;
  run: { snapshot(): RunSnapshot; tap(key: GameKey): void } | null;
  rush: RushSession | null;
  rushTicket: { readonly token: string; readonly handInBy: number } | null;
  duel: unknown;
  toast(message: string, holdMs?: number): void;
  showHome(): void;
  showDailyTier(tier: string): void;
  openArchivePuzzle(id: number): Promise<void>;
  startRun(): void;
  finishRun(snapshot: RunSnapshot, events: readonly unknown[]): Promise<void>;
  enterRush(): void;
  beginRush(practice: boolean): Promise<void>;
  enterDuel(): void;
  tickChrome(): void;
}

function internals(app: App): Internals {
  return app as unknown as Internals;
}

/** Lets every promise already queued settle, a few times over. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((done) => setTimeout(done, 0));
}

function posts(sent: readonly Request[], path: string): Request[] {
  return sent.filter((request) => request.method === "POST" && request.path === path);
}

/** Plays the easy tier to a finish without pressing a key. */
async function finishEasy(booted: Booted, phase: "solved" | "failed" = "solved"): Promise<void> {
  const inner = internals(booted.app);
  inner.showDailyTier("easy");
  const snapshot = { ...inner.run!.snapshot(), phase };
  await inner.finishRun(snapshot, []);
}

function chip(root: HTMLElement): HTMLElement {
  const found = root.querySelector<HTMLElement>(".update-chip");
  if (!found) throw new Error("No update chip in the chrome");
  return found;
}

// ── The daily ────────────────────────────────────────────────────────────────

describe("the daily hand-in", () => {
  test("names the day the sheet was dealt on", async () => {
    const booted = await boot((request) =>
      request.path === "/api/daily/run" ? reply(200, filedBody()) : reply(404, {}),
    );

    await finishEasy(booted);

    const [filing] = posts(booted.sent, "/api/daily/run");
    expect(filing?.body?.day).toBe(DAY);
    expect(filing?.body?.tier).toBe("easy");
  });

  test("rides out a restart, saying Reconnecting… while it waits, and files", async () => {
    let attempts = 0;
    const booted = await boot((request) => {
      if (request.path !== "/api/daily/run") return reply(404, {});
      attempts += 1;
      return attempts < 3 ? proxyDown(attempts === 1 ? 502 : 503) : reply(200, filedBody());
    });

    await finishEasy(booted);

    expect(posts(booted.sent, "/api/daily/run")).toHaveLength(3);
    expect(booted.toasts.filter((message) => message === "Reconnecting…")).toHaveLength(2);
    expect(booted.toasts.some((message) => message.startsWith("Request failed"))).toBe(false);
    expect(internals(booted.app).daily).toMatchObject({ day: DAY });
  });

  test("a retry that lands on its own first attempt is not called a second filing", async () => {
    // The first attempt was filed and its answer lost on the way back: the
    // retry is told `isFirst: false`, which is about the retry, not the player.
    let attempts = 0;
    const booted = await boot((request) => {
      if (request.path !== "/api/daily/run") return reply(404, {});
      attempts += 1;
      return attempts === 1 ? proxyDown() : reply(200, filedBody(false));
    });

    await finishEasy(booted);

    expect(booted.toasts).not.toContain("Today's sheet was already filed");
  });

  test("a sheet from a day that has ended is refused with the server's sentence, and the day is read again", async () => {
    const refusal = "That was yesterday's sheet — today's is ready.";
    let dailies = 0;
    const booted = await boot((request) => {
      if (request.path === "/api/daily/run") return reply(409, { error: refusal });
      if (request.path === "/api/daily") {
        dailies += 1;
        return reply(200, dailyBody(dailies === 1 ? DAY : DAY + 1));
      }
      return reply(404, {});
    });

    await finishEasy(booted);
    await settle();

    expect(posts(booted.sent, "/api/daily/run")).toHaveLength(1);
    expect(booted.toasts).toContain(refusal);
    expect(dailies).toBe(2);
    expect(internals(booted.app).daily?.day).toBe(DAY + 1);
  });

  test("when the server never comes back, it says so as it always did", async () => {
    const booted = await boot((request) =>
      request.path === "/api/daily/run" ? proxyDown(503) : reply(404, {}),
    );

    await finishEasy(booted);

    expect(posts(booted.sent, "/api/daily/run")).toHaveLength(7);
    expect(booted.toasts.at(-1)).toBe("Request failed (503)");
  });
});

// ── A practice clear ─────────────────────────────────────────────────────────

describe("a practice clear", () => {
  const practice = PROMPTS[4]!;

  /** The verdict card, which a practice run captions "Practice" (`ui/results.ts`). */
  function resultCardShowing(root: HTMLElement): boolean {
    return [...root.querySelectorAll(".panel__caption")].some((caption) => caption.textContent === "Practice");
  }

  test("rides out a restart without a word", async () => {
    let attempts = 0;
    const booted = await boot((request) => {
      if (request.path === `/api/archive/${practice.id}`) return reply(200, { puzzle: practice, solution: null });
      if (request.path !== `/api/puzzles/${practice.id}/clear`) return reply(404, {});
      attempts += 1;
      return attempts === 1 ? proxyDown(503) : reply(200, { solved: true, solution: null });
    });
    const inner = internals(booted.app);
    await inner.openArchivePuzzle(practice.id);

    await inner.finishRun({ ...inner.run!.snapshot(), phase: "solved" }, []);
    await settle();

    expect(posts(booted.sent, `/api/puzzles/${practice.id}/clear`)).toHaveLength(2);
    expect(booted.toasts).not.toContain("Reconnecting…");
  });

  test("that lands after Try again does not put the result card over the new run", async () => {
    let attempts = 0;
    let inner: Internals | null = null;
    const booted = await boot((request) => {
      if (request.path === `/api/archive/${practice.id}`) return reply(200, { puzzle: practice, solution: null });
      if (request.path !== `/api/puzzles/${practice.id}/clear`) return reply(404, {});
      attempts += 1;
      // "Try again" pressed while the first attempt was lost in the restart.
      if (attempts === 1) inner?.startRun();
      return attempts === 1 ? proxyDown(502) : reply(200, { solved: true, solution: null });
    });
    inner = internals(booted.app);
    await inner.openArchivePuzzle(practice.id);

    await inner.finishRun({ ...inner.run!.snapshot(), phase: "solved" }, []);
    // The card is up before the clear has landed — what is pinned is that the
    // late answer does not bring it back.
    expect(attempts).toBe(1);
    await settle();

    expect(attempts).toBe(2);
    expect(inner.run?.snapshot().phase).toBe("ready");
    expect(resultCardShowing(booted.root)).toBe(false);
  });
});

// ── The rush ─────────────────────────────────────────────────────────────────

async function startRush(booted: Booted): Promise<Internals> {
  const inner = internals(booted.app);
  inner.enterRush();
  await settle();
  await inner.beginRush(false);
  return inner;
}

describe("the rush hand-in", () => {
  test("keeps its ticket until the server answers, and sends the same one every time", async () => {
    let attempts = 0;
    const heldDuring: (string | null)[] = [];
    let inner: Internals | null = null;
    const booted = await boot((request) => {
      if (request.path !== "/api/rush/run") return reply(404, {});
      attempts += 1;
      heldDuring.push(inner?.rushTicket?.token ?? null);
      return attempts < 3 ? proxyDown() : reply(200, { ranked: true, played: [], run: rushRun, isFirst: true, best: 2, leaderboard: [] });
    });
    inner = await startRush(booted);

    inner.rush!.giveUp();
    await settle();

    const handIns = posts(booted.sent, "/api/rush/run");
    expect(handIns).toHaveLength(3);
    expect(handIns.map((request) => request.body?.ticket)).toEqual([RUSH_TICKET, RUSH_TICKET, RUSH_TICKET]);
    expect(heldDuring).toEqual([RUSH_TICKET, RUSH_TICKET, RUSH_TICKET]);
    expect(inner.rushTicket).toBeNull();
    expect(inner.rush).toBeNull();
    expect(booted.toasts).toContain("Reconnecting…");
  });

  test("stops retrying where the server would stop accepting: its start, five minutes, the grace, less a margin", async () => {
    const booted = await boot((request) =>
      request.path === "/api/rush/run" ? reply(200, { ranked: true, played: [], run: rushRun, isFirst: true, best: 2, leaderboard: [] }) : reply(404, {}),
    );
    const seen: HandInOptions[] = [];
    const submit = booted.api.submitRush.bind(booted.api);
    booted.api.submitRush = (body, options) => {
      seen.push(options ?? {});
      return submit(body, options);
    };

    const before = Date.now();
    const inner = await startRush(booted);
    const after = Date.now();
    inner.rush!.giveUp();
    await settle();

    const deadline = seen[0]?.deadline;
    const allowance = RUSH_DURATION_MS + RUSH_GRACE_MS - RUSH_HAND_IN_MARGIN_MS;
    expect(deadline).toBeGreaterThanOrEqual(before + allowance);
    expect(deadline).toBeLessThanOrEqual(after + allowance);
  });

  test("when the server never comes back, the player still sees what they did", async () => {
    const booted = await boot((request) => (request.path === "/api/rush/run" ? proxyDown() : reply(404, {})));
    const inner = await startRush(booted);

    inner.rush!.giveUp();
    await settle();

    expect(posts(booted.sent, "/api/rush/run")).toHaveLength(7);
    expect(booted.toasts.at(-1)).toBe("Request failed (502)");
    expect(inner.rushTicket).toBeNull();
    // The local result card, from what the client counted itself.
    expect(booted.root.querySelector(".rush__headline")).not.toBeNull();
  });

  test("a player who leaves while it retries is not pulled back to its result", async () => {
    let attempts = 0;
    let inner: Internals | null = null;
    const booted = await boot((request) => {
      if (request.path !== "/api/rush/run") return reply(404, {});
      attempts += 1;
      // Pressed Home between the first attempt and the second.
      if (attempts === 1) inner?.showHome();
      return attempts === 1 ? proxyDown() : reply(200, { ranked: true, played: [], run: rushRun, isFirst: true, best: 2, leaderboard: [] });
    });
    inner = await startRush(booted);

    inner.rush!.giveUp();
    await settle();

    expect(posts(booted.sent, "/api/rush/run")).toHaveLength(2);
    expect(inner.mode).toBe("daily");
    expect(booted.root.querySelector(".home")).not.toBeNull();
  });
});

// ── The duel ─────────────────────────────────────────────────────────────────

describe("a duel the server closes", () => {
  test("for a handover: one message, duel mode left, and Duel opens a new lobby", async () => {
    const booted = await boot();
    const inner = internals(booted.app);
    const before = FakeSocket.opened.length;

    inner.enterDuel();
    FakeSocket.opened.at(-1)!.drop(1012, "handover");

    expect(booted.toasts).toEqual(["The server is updating — open the lobby again"]);
    expect(inner.mode).toBe("daily");
    expect(inner.duel).toBeNull();

    inner.enterDuel();
    expect(FakeSocket.opened.length).toBe(before + 2);
    expect(inner.mode).toBe("duel");
  });

  test("for a restart: the duel is over, and said so once", async () => {
    const booted = await boot();
    const inner = internals(booted.app);

    inner.enterDuel();
    FakeSocket.opened.at(-1)!.drop(1012, "restart");

    expect(booted.toasts).toEqual(["The server restarted, so the duel ended."]);
    expect(inner.mode).toBe("daily");
  });

  test("an abrupt close is one message, not an error and a close", async () => {
    const booted = await boot();
    const inner = internals(booted.app);

    inner.enterDuel();
    FakeSocket.opened.at(-1)!.drop(1006, "", { error: true });

    expect(booted.toasts).toEqual(["Lost the connection to the duel"]);
    expect(inner.mode).toBe("daily");
  });

  test("leaving the duel ourselves says nothing", async () => {
    const booted = await boot();
    const inner = internals(booted.app);

    inner.enterDuel();
    inner.showHome();

    expect(booted.toasts).toEqual([]);
    expect(inner.mode).toBe("daily");
  });
});

// ── The update chip ──────────────────────────────────────────────────────────

describe("the update chip", () => {
  const builds = { clientBuild: "a1b2c3d", serverBuild: "e4f5a6b" };

  test("shows on the front door once the server names a newer build", async () => {
    const booted = await boot(undefined, builds);

    expect(chip(booted.root).hidden).toBe(false);
  });

  test("stays hidden when the server is on the same build", async () => {
    const booted = await boot(undefined, { clientBuild: "a1b2c3d", serverBuild: "a1b2c3d" });

    expect(chip(booted.root).hidden).toBe(true);
  });

  test("hides for a run and comes back once it is over", async () => {
    const booted = await boot(undefined, builds);
    const inner = internals(booted.app);

    inner.showDailyTier("easy");
    expect(chip(booted.root).hidden).toBe(true);
    inner.tickChrome();
    expect(chip(booted.root).hidden).toBe(true);

    // Played to its real end — the chip reads the run's own phase, so a
    // made-up snapshot would leave the run itself still "ready".
    const run = inner.run!;
    for (let piece = 0; piece < 80 && ["ready", "playing"].includes(run.snapshot().phase); piece += 1) {
      run.tap("hardDrop");
    }
    await settle();
    expect(["solved", "failed"]).toContain(run.snapshot().phase);
    inner.tickChrome();
    expect(chip(booted.root).hidden).toBe(false);
  });

  test("hides for a rush and for a duel", async () => {
    const booted = await boot(
      (request) => (request.path === "/api/rush/run" ? reply(200, { ranked: true, played: [], run: rushRun, isFirst: true, best: 2, leaderboard: [] }) : reply(404, {})),
      builds,
    );
    const inner = await startRush(booted);
    expect(chip(booted.root).hidden).toBe(true);
    inner.tickChrome();
    expect(chip(booted.root).hidden).toBe(true);

    inner.rush!.giveUp();
    await settle();
    inner.tickChrome();
    expect(chip(booted.root).hidden).toBe(false);

    inner.enterDuel();
    expect(chip(booted.root).hidden).toBe(true);
    inner.tickChrome();
    expect(chip(booted.root).hidden).toBe(true);
  });
});
