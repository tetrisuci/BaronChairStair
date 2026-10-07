/**
 * A daily hand-in names the day it was played on, and a different day is
 * refused.
 *
 * Without it, a client that retries a hand-in across midnight — because the
 * first attempt met a restart — would have its log replayed against the *next*
 * day's puzzle, and either fail it or file a run on a board the player never
 * saw. `day` is optional so a client from before it keeps working exactly as
 * it did.
 *
 * Every run here is filed by a player and a server of this file's own, so
 * nothing it writes lands on a board another file reads.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_IS_OVER } from "../server/hand-in-day";

/** The shared database every server-importing file names; see `tests/server.test.ts`. */
const DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);

type AuthModule = typeof import("../server/auth");

let fetchApp: (request: Request) => Response | Promise<Response>;
let mintSession: AuthModule["mintSession"];

beforeAll(async () => {
  process.env.DATABASE_PATH = DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  fetchApp = (await import("../server/index")).entrypoint.fetch;
  ({ mintSession } = await import("../server/auth"));
});

let minted = 0;

async function tokenFor(name: string): Promise<string> {
  const id = `hand-in-day-${name}-${++minted}`;
  const { token } = await mintSession({ id, username: name, avatarUrl: null }, "hand-in-day-guild");
  return token;
}

async function today(token: string): Promise<number> {
  const response = await fetchApp(
    new Request("http://localhost/api/daily", { headers: { Authorization: `Bearer ${token}` } }),
  );
  return ((await response.json()) as { day: number }).day;
}

function handIn(token: string, body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(
    fetchApp(
      new Request("http://localhost/api/daily/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tier: "easy", events: [], ...body }),
      }),
    ),
  );
}

describe("POST /api/daily/run and the day it names", () => {
  test("a hand-in for another day is refused with 409 and says why", async () => {
    const token = await tokenFor("late");
    const day = await today(token);
    for (const named of [day - 1, day + 1]) {
      const response = await handIn(token, { day: named });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe(DAY_IS_OVER);
    }
    // Nothing was filed by either refusal.
    const daily = await fetchApp(
      new Request("http://localhost/api/daily", { headers: { Authorization: `Bearer ${token}` } }),
    );
    const sheet = (await daily.json()) as { puzzles: { tier: string; run: unknown }[] };
    expect(sheet.puzzles.find((entry) => entry.tier === "easy")?.run).toBeNull();
  });

  test("the message is the one the player is shown", () => {
    expect(DAY_IS_OVER).toBe("That day is over — today's puzzles are new. Open the daily again.");
  });

  test("a hand-in for today is filed as before", async () => {
    const token = await tokenFor("on-time");
    const response = await handIn(token, { day: await today(token) });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { tier: string }).tier).toBe("easy");
  });

  test("a hand-in that names no day is filed as before, for older clients", async () => {
    const token = await tokenFor("older");
    const response = await handIn(token, {});
    expect(response.status).toBe(200);
    expect(((await response.json()) as { run: { solved: boolean } }).run.solved).toBe(false);
  });

  test("a day that is not a whole number is a bad request, not a guess", async () => {
    const token = await tokenFor("garbled");
    const day = await today(token);
    for (const named of [String(day), day + 0.5, true]) {
      const response = await handIn(token, { day: named });
      expect({ named, status: response.status }).toEqual({ named, status: 400 });
    }
  });
});
