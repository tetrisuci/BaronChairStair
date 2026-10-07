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
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archive, hasSolutions } from "./archive";
import { solvingLog } from "./solving-log";
import { GUEST_ID } from "../shared/site";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
// `server/db.ts` does not load `server/config.ts`, so importing it before
// `beforeAll` has set the environment cannot point the app at another file.
import { Store, type NewSolution } from "../server/db";
import type { SolutionStep } from "../shared/puzzle";

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

  test("today's puzzles are refused until this player has solved them", async () => {
    // Otherwise it is a back door to the rehearsal `lockedPuzzleIds` prevents.
    // The last tier, because `server.test.ts` shares this database and this
    // guest, and solves today's easy one — which, solved, is let through.
    const puzzles: { id: number }[] = (await (await get("/api/today")).json()).puzzles;
    const today = puzzles.at(-1)!.id;
    const filed = await post(`/api/puzzles/${today}/clear`, {
      handling: DEFAULT_HANDLING,
      events: [],
    });
    expect(filed.status).toBe(403);
  });
});

describe.skipIf(!hasSolutions)("a line solved from Explore", () => {
  test("lands in that puzzle's solutions, credited to whoever played it", async () => {
    // The bug this pins: only the daily route filed a solve's line, so a line
    // found by replaying a puzzle from Explore never reached the Solutions menu
    // — whose own empty state says "Solve it another way and yours lands here".
    //
    // The only line this harness can play is the maker's own, which boot seeds
    // as the puzzle's reference row, and replaying it would collide with that
    // row and file nothing. Voiding the row first makes the same placements
    // arrive as a line nobody has on file — which is exactly what a player's
    // genuinely different line is to the store.
    const id = await anArchivePuzzle();
    const puzzle = archive.find((entry) => entry.id === id)!;
    const db = new Database(DB);
    try {
      db.run("UPDATE puzzle_solutions SET voided_at = 1 WHERE puzzle_id = ?1 AND voided_at IS NULL", [id]);
    } finally {
      db.close();
    }

    const filed = await post(`/api/puzzles/${id}/clear`, {
      handling: DEFAULT_HANDLING,
      events: solvingLog(puzzle),
    });
    expect(filed.status).toBe(200);
    expect((await filed.json()).solved).toBe(true);

    const gallery = (await (await get(`/api/puzzles/${id}/solutions`)).json()) as {
      solutions: { source: string; finder: { id: string } | null }[];
    };
    expect(gallery.solutions.some((line) => line.source === "player" && line.finder?.id === GUEST_ID)).toBe(
      true,
    );
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

describe("the alternate solutions list", () => {
  /*
   * Seeded through a second `Store` on the app's own file, as `server.test.ts`
   * seeds a discovery: the only line this harness can *play* is the maker's,
   * and an alternate is by definition somebody else's.
   *
   * Two things are kept away from the state the other files lean on. The
   * guest's one new clear is on a puzzle picked from the far end of the
   * archive — never `anArchivePuzzle()`'s, which the gallery tests above need
   * unsolved — and never one of today's tiers, which `server.test.ts` plays.
   * And the lines belong to a player of their own, so no board that counts
   * the guest's finds moves.
   */
  const FINDER = { id: "alternates-finder", username: "Alternates Finder", avatarUrl: null };

  interface Row {
    solutionId: number;
    puzzleId: number;
    title: string;
    difficulty: number | null;
    finder: { id: string } | null;
    foundAt: number;
    locked: boolean;
    attack: number | null;
    pieces: number | null;
    clears: string[] | null;
  }

  const seeded = {
    todayTier: 0,
    locked: 0,
    unlocked: 0,
    credited: { today: 0, locked: 0, unlocked: 0 },
    excluded: [] as number[],
  };

  const placements: SolutionStep[] = [
    { piece: "T", cells: [[3, 0], [4, 0], [5, 0], [4, 1]], clear: null, attack: 0 },
  ];
  const filed = (store: Store, over: Partial<NewSolution>): number => {
    const { solutionId } = store.recordSolution({
      puzzleId: 0, canonicalKey: "", keyVersion: 1,
      placements, events: null, handling: null,
      attack: 999, targetAttack: 999, clears: [], solvedStrict: true,
      source: "player", foundBy: FINDER.id, guildId: null, ...over,
    });
    if (solutionId === null) throw new Error(`could not seed ${over.canonicalKey}`);
    return solutionId;
  };

  beforeAll(async () => {
    const today: number[] = (await (await get("/api/today")).json()).puzzles.map(
      (p: { id: number }) => p.id,
    );
    const first = await anArchivePuzzle();
    const far = archive
      .map((entry) => entry.id)
      .filter((id) => !today.includes(id) && id !== first)
      .slice(-2);
    if (far.length < 2) throw new Error("the archive is too small to seed two puzzles");
    // The last tier: `server.test.ts` solves today's easy as this guest, and
    // nothing solves the last one.
    seeded.todayTier = today.at(-1)!;
    [seeded.locked, seeded.unlocked] = far as [number, number];

    const store = new Store(DB);
    try {
      store.upsertPlayer(FINDER);
      const key = (what: string) => `alternates-route-${what}-${process.pid}`;
      seeded.credited.today = filed(store, { puzzleId: seeded.todayTier, canonicalKey: key("today") });
      seeded.credited.locked = filed(store, { puzzleId: seeded.locked, canonicalKey: key("locked") });
      seeded.credited.unlocked = filed(store, { puzzleId: seeded.unlocked, canonicalKey: key("unlocked") });
      seeded.excluded = [
        filed(store, { puzzleId: seeded.unlocked, canonicalKey: key("ref"), source: "reference", foundBy: null }),
        filed(store, { puzzleId: seeded.unlocked, canonicalKey: key("enum"), source: "enumerated", foundBy: null }),
        filed(store, { puzzleId: seeded.unlocked, canonicalKey: key("flat"), solvedStrict: false, attack: 999 }),
      ];
      const voided = filed(store, { puzzleId: seeded.unlocked, canonicalKey: key("voided") });
      store.archiveReader.run("UPDATE puzzle_solutions SET voided_at = 1 WHERE solution_id = ?1", [voided]);
      seeded.excluded.push(voided);
      store.recordClear({
        player: { id: GUEST_ID, username: "Guest", avatarUrl: null },
        playerId: GUEST_ID,
        puzzleId: seeded.unlocked,
        durationMs: 1000,
      });
    } finally {
      store.close();
    }
  });

  const rows = async (): Promise<Row[]> => {
    const response = await get("/api/alternates");
    expect(response.status).toBe(200);
    return ((await response.json()) as { alternates: Row[] }).alternates;
  };

  test("needs a session", async () => {
    const response = await fetchApp(new Request(`${BASE}/api/alternates`, { headers: CALLER }));
    expect(response.status).toBe(401);
  });

  test("a puzzle this player has solved shows its line in full", async () => {
    const row = (await rows()).find((one) => one.solutionId === seeded.credited.unlocked);
    expect(row).toBeDefined();
    expect(row!.locked).toBe(false);
    expect(row!.puzzleId).toBe(seeded.unlocked);
    expect(row!.attack).toBe(999);
    expect(row!.pieces).toBe(1);
    expect(row!.clears).toEqual([]);
    expect(row!.finder?.id).toBe(FINDER.id);
    expect(row!.title).toBe(archive.find((entry) => entry.id === seeded.unlocked)!.title);
  });

  test("one this player has not solved is listed, but says nothing about the line", async () => {
    const row = (await rows()).find((one) => one.solutionId === seeded.credited.locked);
    expect(row).toBeDefined();
    expect(row!.locked).toBe(true);
    expect(row!.attack).toBeNull();
    expect(row!.pieces).toBeNull();
    expect(row!.clears).toBeNull();
    expect(row!.finder?.id).toBe(FINDER.id);
  });

  test("today's tier, unsolved, is not listed at all", async () => {
    const listed = await rows();
    expect(listed.some((one) => one.puzzleId === seeded.todayTier)).toBe(false);
    expect(listed.some((one) => one.solutionId === seeded.credited.today)).toBe(false);
  });

  test("the maker's answer, the batch search, a line that beat nothing and a voided line are not alternates", async () => {
    const ids = new Set((await rows()).map((one) => one.solutionId));
    for (const id of seeded.excluded) expect(ids.has(id)).toBe(false);
  });

  test("never sends a line's placements, and every row has a finder", async () => {
    // Boot seeds a reference row for every puzzle with an answer, so a
    // predicate that let `reference` through would show up here as a row
    // with nobody's name on it.
    for (const row of await rows()) {
      expect("placements" in row).toBe(false);
      expect(row.finder).not.toBeNull();
    }
  });
});
