/**
 * The three hand-ins ask again when the server was briefly not there.
 *
 * A deploy restarts the game, and for the second or two it takes a hand-in
 * sent into that gap used to be lost: the daily said "Request failed (502)"
 * and kept nothing, the rush threw its ticket away, and a practice clear
 * vanished without a word. Every one of those routes is safe to send twice
 * (the daily upserts, the rush is first-write-wins, a clear only counts up),
 * so the client now asks again for about fifteen seconds — but only when
 * nobody answered, or a proxy answered for a server that was not there.
 *
 * What is pinned here is the line between the two kinds of failure. A 4xx is
 * the server's considered answer and asking again cannot change it; a 500 is
 * a bug, and a bug answered six times is six copies of the same log line. A
 * retry of either would also hold the player in front of "Reconnecting…" for
 * fifteen seconds before telling them the thing the first response said.
 *
 * No real time passes: the helper takes a clock, and the clock here moves only
 * when something sleeps on it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  Api,
  ApiError,
  DAILY_STALE_STATUS,
  HAND_IN_RETRY_DELAYS_MS,
  type HandInOptions,
  isRetryableStatus,
  type RetryClock,
  type RetryNotice,
  withHandInRetries,
} from "../client/src/api";
import { BUILD_ID_HEADER } from "../shared/runtime-status";
import { RUSH_GRACE_MS, rushHandInDeadline, RUSH_HAND_IN_MARGIN_MS } from "../client/src/game/rush";
import { RUSH_DURATION_MS } from "../shared/rush";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";

/** A clock that moves only when slept on, and remembers every wait. */
function fakeClock(start = 1_000_000): RetryClock & { readonly waits: number[]; time: number } {
  const clock = {
    time: start,
    waits: [] as number[],
    now: () => clock.time,
    sleep: (ms: number) => {
      clock.waits.push(ms);
      clock.time += ms;
      return Promise.resolve();
    },
  };
  return clock;
}

/** Fails with each status in turn, then answers `value`. */
function failingThen<T>(statuses: readonly number[], value: T): { send: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    send: () => {
      const status = statuses[calls];
      calls += 1;
      return status === undefined
        ? Promise.resolve(value)
        : Promise.reject(new ApiError(`failed with ${status}`, status));
    },
    calls: () => calls,
  };
}

describe("which failures are worth asking again", () => {
  test.each([0, 502, 503, 504])("%i is a server that was not there", (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  test.each([400, 401, 403, 404, 408, 409, 413, 429, 500, 501])(
    "%i is an answer, and asking again cannot change it",
    (status) => {
      expect(isRetryableStatus(status)).toBe(false);
    },
  );
});

describe("withHandInRetries", () => {
  test("an answer on the first try is returned without waiting", async () => {
    const clock = fakeClock();
    const { send, calls } = failingThen([], "filed");

    expect(await withHandInRetries(send, {}, clock)).toBe("filed");
    expect(calls()).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  test.each([0, 502, 503, 504])("a %i is asked again until it lands", async (status) => {
    const clock = fakeClock();
    const { send, calls } = failingThen([status, status], "filed");

    expect(await withHandInRetries(send, {}, clock)).toBe("filed");
    expect(calls()).toBe(3);
    expect(clock.waits).toEqual(HAND_IN_RETRY_DELAYS_MS.slice(0, 2));
  });

  test.each([400, 403, 404, 408, 409, 429, 500])("a %i is never asked again", async (status) => {
    const clock = fakeClock();
    const { send, calls } = failingThen([status], "filed");

    const failure = await withHandInRetries(send, {}, clock).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(status);
    expect(calls()).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  test("something that is not an ApiError is thrown at once", async () => {
    const clock = fakeClock();
    let calls = 0;
    const send = () => {
      calls += 1;
      return Promise.reject(new SyntaxError("Unexpected token < in JSON"));
    };

    await expect(withHandInRetries(send, {}, clock)).rejects.toBeInstanceOf(SyntaxError);
    expect(calls).toBe(1);
  });

  test("it gives up after the schedule, about fifteen seconds in all, with the last failure", async () => {
    const clock = fakeClock();
    const { send, calls } = failingThen(Array(20).fill(503), "never");

    const failure = await withHandInRetries(send, {}, clock).catch((error: unknown) => error);

    expect((failure as ApiError).status).toBe(503);
    expect(calls()).toBe(HAND_IN_RETRY_DELAYS_MS.length + 1);
    expect(clock.waits).toEqual([...HAND_IN_RETRY_DELAYS_MS]);
    const total = HAND_IN_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThanOrEqual(12_000);
    expect(total).toBeLessThanOrEqual(16_000);
  });

  test("the schedule backs off and never waits longer than four seconds", () => {
    expect(HAND_IN_RETRY_DELAYS_MS[0]).toBe(500);
    for (let index = 1; index < HAND_IN_RETRY_DELAYS_MS.length; index += 1) {
      expect(HAND_IN_RETRY_DELAYS_MS[index]!).toBeGreaterThanOrEqual(HAND_IN_RETRY_DELAYS_MS[index - 1]!);
    }
    expect(Math.max(...HAND_IN_RETRY_DELAYS_MS)).toBe(4_000);
  });

  test("no attempt starts after the deadline, and the last wait stops at it", async () => {
    const clock = fakeClock(0);
    const { send, calls } = failingThen(Array(20).fill(502), "never");

    const failure = await withHandInRetries(send, { deadline: 2_800 }, clock).catch((error: unknown) => error);

    expect((failure as ApiError).status).toBe(502);
    // 500 and 1,000 fit; the 2,000 is cut to the 1,300 left, and that is the last.
    expect(clock.waits).toEqual([500, 1_000, 1_300]);
    expect(calls()).toBe(4);
    expect(clock.time).toBe(2_800);
  });

  test("a deadline already past means one attempt and no retry", async () => {
    const clock = fakeClock(10_000);
    const { send, calls } = failingThen([0, 0], "never");

    await expect(withHandInRetries(send, { deadline: 9_000 }, clock)).rejects.toBeInstanceOf(ApiError);
    expect(calls()).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  test("onRetrying is told before each wait, with the attempt coming and how long until it", async () => {
    const clock = fakeClock();
    const notices: RetryNotice[] = [];
    const { send } = failingThen([0, 504], "filed");

    await withHandInRetries(send, { onRetrying: (notice) => notices.push(notice) }, clock);

    expect(notices).toEqual([
      { attempt: 2, delayMs: 500, status: 0 },
      { attempt: 3, delayMs: 1_000, status: 504 },
    ]);
  });
});

// ── Through the Api ──────────────────────────────────────────────────────────

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

/** A network that answers from a script, one response per request, and keeps what was sent. */
function scriptedNetwork(script: readonly (() => Response)[]): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: (url, init) => {
      sent.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : null });
      const next = script[sent.length - 1];
      if (!next) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(next());
    },
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const proxyPage = (status: number) => () =>
  new Response(`<html><body>${status} Bad Gateway</body></html>`, { status, headers: { "Content-Type": "text/html" } });
const refused = () => {
  throw new TypeError("Failed to fetch");
};

function quietly<T>(run: () => Promise<T>): Promise<T> {
  // `request` logs every refused connection to the console, which is right in a
  // browser and noise in a test that refuses on purpose.
  const original = console.error;
  console.error = () => undefined;
  return run().finally(() => {
    console.error = original;
  });
}

const RUN_BODY = {
  tier: "easy" as const,
  day: 412,
  handling: DEFAULT_HANDLING,
  events: [],
  resets: 0,
  totalMs: 1234,
};

describe("the daily filing", () => {
  test("is asked again through a proxy's 502 and a refused connection, with the same body", async () => {
    const network = scriptedNetwork([proxyPage(502), refused, json(200, { ok: true })]);
    const api = new Api("", { fetch: network.fetch, clock: fakeClock() });

    await quietly(() => api.submitRun(RUN_BODY));

    expect(network.sent.map((request) => request.url)).toEqual([
      "/api/daily/run",
      "/api/daily/run",
      "/api/daily/run",
    ]);
    expect(new Set(network.sent.map((request) => request.body)).size).toBe(1);
  });

  test("sends the day of the sheet it was played on", async () => {
    const network = scriptedNetwork([json(200, { ok: true })]);
    const api = new Api("", { fetch: network.fetch, clock: fakeClock() });

    await api.submitRun(RUN_BODY);

    expect(JSON.parse(network.sent[0]!.body!).day).toBe(412);
  });

  test("a refusal for a stale day is the server's sentence, at once", async () => {
    const message = "That sheet was yesterday's. Today's is waiting.";
    const network = scriptedNetwork([json(DAILY_STALE_STATUS, { error: message })]);
    const api = new Api("", { fetch: network.fetch, clock: fakeClock() });

    const failure = await api.submitRun(RUN_BODY).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).message).toBe(message);
    expect(network.sent).toHaveLength(1);
  });

  test("passes the caller's onRetrying through", async () => {
    const network = scriptedNetwork([proxyPage(503), json(200, { ok: true })]);
    const api = new Api("", { fetch: network.fetch, clock: fakeClock() });
    const notices: RetryNotice[] = [];
    const options: HandInOptions = { onRetrying: (notice) => notices.push(notice) };

    await api.submitRun(RUN_BODY, options);

    expect(notices).toEqual([{ attempt: 2, delayMs: 500, status: 503 }]);
  });
});

describe("the other two hand-ins", () => {
  test("the rush hand-in keeps the same ticket across every retry", async () => {
    const network = scriptedNetwork([proxyPage(502), proxyPage(504), json(200, { ok: true })]);
    const api = new Api("", { fetch: network.fetch, clock: fakeClock() });

    await api.submitRush({
      ticket: "payload.signature",
      handling: DEFAULT_HANDLING,
      segments: [],
      timeToLastSolveMs: 0,
      skipsUsed: 0,
    });

    expect(network.sent).toHaveLength(3);
    expect(network.sent.every((request) => request.url === "/api/rush/run")).toBe(true);
    expect(network.sent.map((request) => JSON.parse(request.body!).ticket)).toEqual([
      "payload.signature",
      "payload.signature",
      "payload.signature",
    ]);
  });

  test("the rush hand-in stops at its deadline", async () => {
    const clock = fakeClock(0);
    const network = scriptedNetwork(Array(10).fill(proxyPage(502)));
    const api = new Api("", { fetch: network.fetch, clock });

    const failure = await api
      .submitRush(
        { ticket: "t.s", handling: DEFAULT_HANDLING, segments: [], timeToLastSolveMs: 0, skipsUsed: 0 },
        { deadline: 1_200 },
      )
      .catch((error: unknown) => error);

    expect((failure as ApiError).status).toBe(502);
    expect(clock.waits).toEqual([500, 700]);
    expect(network.sent).toHaveLength(3);
  });

  test("the practice clear is asked again too", async () => {
    const network = scriptedNetwork([refused, json(200, { solved: true, solution: null })]);
    const api = new Api("", { fetch: network.fetch, clock: fakeClock() });

    const answer = await quietly(() => api.clearPuzzle(92, { handling: DEFAULT_HANDLING, events: [] }));

    expect(answer).toEqual({ solved: true, solution: null });
    expect(network.sent.map((request) => request.url)).toEqual(["/api/puzzles/92/clear", "/api/puzzles/92/clear"]);
  });

  test("everything else behaves as it did: one request, and its failure", async () => {
    const network = scriptedNetwork([proxyPage(503), json(200, {})]);
    const api = new Api("", { fetch: network.fetch, clock: fakeClock() });

    const failure = await api.daily().catch((error: unknown) => error);

    expect((failure as ApiError).status).toBe(503);
    expect((failure as ApiError).message).toBe("Request failed (503)");
    expect(network.sent).toHaveLength(1);
  });
});

describe("the build the server is on", () => {
  test("is read from every response, a refusal included, and told once per change", async () => {
    const network = scriptedNetwork([
      json(200, {}, { [BUILD_ID_HEADER]: "a1b2c3d" }),
      json(200, {}, { [BUILD_ID_HEADER]: "a1b2c3d" }),
      json(404, { error: "No such endpoint" }, { [BUILD_ID_HEADER]: "e4f5a6b" }),
    ]);
    const api = new Api("", { fetch: network.fetch, clock: fakeClock() });
    const seen: string[] = [];
    api.onServerBuild((buildId) => seen.push(buildId));

    await api.daily();
    await api.daily();
    await api.daily().catch(() => undefined);

    expect(seen).toEqual(["a1b2c3d", "e4f5a6b"]);
    expect(api.serverBuild).toBe("e4f5a6b");
  });

  test("a listener that arrives late is told what is already known", async () => {
    const network = scriptedNetwork([json(200, {}, { [BUILD_ID_HEADER]: "a1b2c3d" })]);
    const api = new Api("", { fetch: network.fetch, clock: fakeClock() });
    await api.daily();

    const seen: string[] = [];
    api.onServerBuild((buildId) => seen.push(buildId));

    expect(seen).toEqual(["a1b2c3d"]);
  });

  test("a missing or malformed header changes nothing", async () => {
    const network = scriptedNetwork([
      json(200, {}, { [BUILD_ID_HEADER]: "a1b2c3d" }),
      json(200, {}),
      json(200, {}, { [BUILD_ID_HEADER]: "<script>alert(1)</script>" }),
      json(200, {}, { [BUILD_ID_HEADER]: "x".repeat(200) }),
    ]);
    const api = new Api("", { fetch: network.fetch, clock: fakeClock() });
    const seen: string[] = [];
    api.onServerBuild((buildId) => seen.push(buildId));

    for (let index = 0; index < 4; index += 1) await api.daily();

    expect(seen).toEqual(["a1b2c3d"]);
    expect(api.serverBuild).toBe("a1b2c3d");
  });
});

describe("the rush hand-in's deadline", () => {
  test("is the rush's start, its five minutes and the server's grace, less a margin for the trip", () => {
    const startedAt = 5_000_000;

    expect(rushHandInDeadline(startedAt, RUSH_DURATION_MS)).toBe(
      startedAt + RUSH_DURATION_MS + RUSH_GRACE_MS - RUSH_HAND_IN_MARGIN_MS,
    );
    expect(RUSH_HAND_IN_MARGIN_MS).toBeGreaterThan(0);
    expect(RUSH_HAND_IN_MARGIN_MS).toBeLessThan(RUSH_GRACE_MS / 2);
  });

  test("the client's grace is the server's", () => {
    // Mirrored, not imported: the server's constant lives in server/index.ts,
    // which the client bundle must not pull in. Read from wherever it is
    // declared — the server file today, shared/rush.ts if it moves there — so
    // the two cannot drift without this failing.
    const sources = ["server/index.ts", "shared/rush.ts"].map((path) => readFileSync(path, "utf8"));
    const declared = sources
      .map((source) => /RUSH_GRACE_MS\s*=\s*([\d_]+)\s*;/.exec(source)?.[1])
      .find((value) => value !== undefined);

    expect(declared).toBeDefined();
    expect(Number(declared!.replaceAll("_", ""))).toBe(RUSH_GRACE_MS);
  });
});
