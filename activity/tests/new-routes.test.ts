/**
 * The routes this release added, exercised as routes.
 *
 * Every gate below could be deleted with the whole suite green. The store layer
 * under them is well covered — `solutions-gallery.test.ts`, `puzzle-clears.test.ts`
 * — but a gate is not a query: it is a branch in a handler, and nothing was
 * asking the handler anything. So: delete `hasCleared`'s 403 and the suite
 * noticed nothing; delete every `recordClear` and the suite noticed nothing.
 *
 * The database is shared with `server.test.ts` deliberately — see the long note
 * there about why no file may delete it — and keyed by pid.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archive } from "./archive";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";

const DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);
let fetchApp: (request: Request) => Response | Promise<Response>;
let token = "";

const BASE = "https://local.test";

/*
 * Our own rate-limit bucket.
 *
 * `bun test` shares one process and one app, so this file's requests and
 * `server.test.ts`'s land in the same limiter. `/api/session` allows ten a
 * minute per caller, and the one extra session this file mints was enough to
 * push that file over — its `guestToken()` got a 429, and the empty token it
 * returned then 401'd on a route that expected 200. `config.ts` names this
 * exact remedy: the suite sets `Cf-Connecting-Ip` to hold two callers apart.
 */
const CALLER = { "Cf-Connecting-Ip": "203.0.113.66" };
const auth = () => ({ ...CALLER, Authorization: `Bearer ${token}` });

const get = (path: string) => fetchApp(new Request(`${BASE}${path}`, { headers: auth() }));
const post = (path: string, body: unknown) =>
  fetchApp(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  process.env.DATABASE_PATH = DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  const server = (await import("../server/index")).default;
  fetchApp = server.fetch;
  token = (await (await post("/api/session", {})).json()).token;
});

/**
 * A puzzle that is not one of today's, so only the solve gate is in play.
 *
 * Asked of the server, and with no requirement that the puzzle have a reference
 * answer — because neither caller needs one. One reads a gallery it has not
 * earned; the other files an empty log. Both are refused before anything looks
 * at an answer.
 *
 * It used to demand `solution.length > 0`, which made both tests throw on every
 * box without `data/solutions.json`. That file is gitignored and built, so it
 * is absent on exactly the machines the activity is deployed to, and present on
 * the machines the tests are written on. It cost a deploy: the suite went red on
 * the VPS, over two tests that had never needed the file.
 */
async function anArchivePuzzle(): Promise<number> {
  const today: number[] = (await (await get("/api/today")).json()).puzzles.map(
    (p: { id: number }) => p.id,
  );
  const puzzles: { id: number }[] = (await (await get("/api/archive")).json()).puzzles;
  const pick = puzzles.find((p) => !today.includes(p.id));
  if (!pick) throw new Error("the archive holds nothing that is not one of today's");
  return pick.id;
}

describe("the solutions gallery is gated", () => {
  test("a puzzle this player has not solved is refused", async () => {
    const id = await anArchivePuzzle();
    const response = await get(`/api/puzzles/${id}/solutions`);
    expect(response.status).toBe(403);
  });

  test("one of today's tiers is refused even before the solve gate", async () => {
    const today = (await (await get("/api/today")).json()).puzzles[0].id;
    const response = await get(`/api/puzzles/${today}/solutions`);
    expect(response.status).toBe(403);
  });

  test("a puzzle that does not exist is a 404, not a 403", async () => {
    expect((await get("/api/puzzles/999999/solutions")).status).toBe(404);
  });
});

describe("the maker's own answer is gated too", () => {
  test("a puzzle this player has not solved does not come with its answer", async () => {
    // The bug this pins. `maySeeSolution` returns true outright for anything
    // that is not one of today's tiers, so this route used to hand the maker's
    // answer to anyone signed in: open a puzzle from Explore, fail it, and the
    // walkthrough mounted in the rail for a board nobody had solved. The
    // gallery of other people's lines was already gated; the answer itself,
    // which is the bigger reveal, was not.
    const id = await anArchivePuzzle();
    const body = await (await get(`/api/archive/${id}`)).json();
    expect(body.solution).toBeNull();
    // The prompt still arrives — the puzzle is playable, it is only the answer
    // that is withheld.
    expect(body.puzzle.id).toBe(id);
  });

  test("a failed clear earns nothing", async () => {
    // The other half: the clear route hands back the answer on a solve, so a
    // first-ever solver still gets their walkthrough. An empty log solves
    // nothing, so it must come back with nothing.
    const id = await anArchivePuzzle();
    const filed = await post(`/api/puzzles/${id}/clear`, {
      handling: DEFAULT_HANDLING,
      events: [],
    });
    const body = await filed.json();
    expect(body.solved).toBe(false);
    expect(body.solution).toBeNull();
  });
});

describe("filing a practice clear", () => {
  test("an empty log solves nothing and unlocks nothing", async () => {
    // The whole reason the route replays rather than believes: a client that
    // could name a puzzle id would fill its own record with puzzles it never
    // played, and the Explore ticks and the Archive board both read that record.
    const id = await anArchivePuzzle();
    const filed = await post(`/api/puzzles/${id}/clear`, {
      handling: DEFAULT_HANDLING,
      events: [],
    });

    expect(filed.status).toBe(200);
    expect((await filed.json()).solved).toBe(false);
    expect((await get(`/api/puzzles/${id}/solutions`)).status).toBe(403);
  });

  test("today's puzzles are refused outright", async () => {
    // Otherwise it is a back door to the rehearsal `lockedPuzzleIds` prevents.
    const today = (await (await get("/api/today")).json()).puzzles[0].id;
    const filed = await post(`/api/puzzles/${today}/clear`, {
      handling: DEFAULT_HANDLING,
      events: [],
    });
    expect(filed.status).toBe(403);
  });
});

describe("a profile", () => {
  test("answers for the caller, and says so", async () => {
    const mine = await (await get("/api/profile")).json();
    expect(mine.isSelf).toBe(true);
    expect(typeof mine.puzzlesCleared).toBe("number");
    expect(mine.archiveSize).toBe(archive.length);
  });

  test("a player nobody has heard of is a 404", async () => {
    expect((await get("/api/profile/not-a-player")).status).toBe(404);
  });

});

describe("the leaderboards", () => {
  test("every category arrives in one shape", async () => {
    const body = await (await get("/api/leaderboards")).json();
    expect(body.categories.length).toBeGreaterThan(0);
    for (const category of body.categories) {
      expect(typeof category.key).toBe("string");
      expect(["server", "everyone"]).toContain(category.scope);
      expect(Array.isArray(category.entries)).toBe(true);
    }
    // Rush-today was removed; its absence is part of the contract now.
    expect(body.categories.map((c: { key: string }) => c.key)).not.toContain("rush-today");
  });

  test("the day rides along with the boards", async () => {
    const body = await (await get("/api/leaderboards")).json();
    expect(body.daily.tiers).toHaveLength(4);
    for (const tier of body.daily.tiers) {
      expect(tier.filed).toBeGreaterThanOrEqual(tier.solved);
    }
  });
});

describe("the archive listing", () => {
  test("carries this player's own clears and no line counts", async () => {
    const body = await (await get("/api/archive")).json();
    expect(Array.isArray(body.cleared)).toBe(true);
    // The count of a puzzle's known solutions is a reveal in its own right.
    expect(body.lines).toBeUndefined();
  });
});
