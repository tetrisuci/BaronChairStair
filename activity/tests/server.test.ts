/**
 * Route-level tests.
 *
 * Everything else in this suite exercises `shared/`, which left the routes —
 * where the answer is withheld, the limits are applied, and the run is
 * recorded — covered only by a manual script. Each test here corresponds to a
 * defect that reached review.
 *
 * The server module is imported for its `fetch`, not started: Bun only listens
 * when a file is the entrypoint, so this drives the real handler stack in
 * process.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);

let fetchApp: (request: Request) => Response | Promise<Response>;

beforeAll(async () => {
  process.env.DATABASE_PATH = DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  const server = (await import("../server/index")).default;
  fetchApp = server.fetch;
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
});

const BASE = "http://localhost";

function get(path: string, token?: string): Promise<Response> {
  return Promise.resolve(
    fetchApp(new Request(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })),
  );
}

function post(path: string, body: unknown, token?: string): Promise<Response> {
  return Promise.resolve(
    fetchApp(
      new Request(BASE + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function guestToken(): Promise<string> {
  const response = await post("/api/session", {});
  return ((await response.json()) as { token: string }).token;
}

describe("the answer is withheld until it is earned", () => {
  test("GET /api/daily sends no solution to a player who has not solved it", async () => {
    const body = (await (await get("/api/daily", await guestToken())).json()) as {
      solution: unknown;
      puzzle: { id: number };
    };
    expect(body.solution).toBeNull();
    expect(body.puzzle.id).toBeGreaterThan(0);
  });

  test("the practice archive withholds today's puzzle", async () => {
    const token = await guestToken();
    const daily = (await (await get("/api/daily", token)).json()) as { puzzle: { id: number } };
    const practice = (await (await get(`/api/archive/${daily.puzzle.id}`, token)).json()) as {
      solution: unknown;
    };
    expect(practice.solution).toBeNull();
  });

  test("filing an empty run does not buy the solution", async () => {
    const token = await guestToken();
    const body = (await (await post("/api/daily/run", { events: [], resets: 0 }, token)).json()) as {
      run: { solved: boolean };
      solution: unknown;
    };
    expect(body.run.solved).toBe(false);
    expect(body.solution).toBeNull();
  });
});

describe("request handling", () => {
  test("a malformed input log is the caller's fault, not a server fault", async () => {
    const response = await post(
      "/api/daily/run",
      { events: [{ frame: 0, type: "keydown", data: { key: "selfDestruct", subframe: 0 } }] },
      await guestToken(),
    );
    expect(response.status).toBe(400);
  });

  test("an unknown API route is a 404, not the single-page app", async () => {
    const response = await get("/api/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("json");
  });

  test("the bot endpoint refuses a wrong key", async () => {
    const response = await fetchApp(
      new Request(`${BASE}/api/standings?guild=1`, { headers: { "X-Api-Key": "wrong" } }),
    );
    expect([401, 404]).toContain(response.status);
  });

  test("the same caller is rate limited on sign-in", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const response = await fetchApp(
        new Request(`${BASE}/api/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cf-Connecting-Ip": "203.0.113.7" },
          body: "{}",
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });

  test("rotating the Authorization header does not mint a fresh allowance", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const response = await fetchApp(
        new Request(`${BASE}/api/session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cf-Connecting-Ip": "203.0.113.9",
            Authorization: `Bearer rotating-${i}`,
          },
          body: "{}",
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });
});
