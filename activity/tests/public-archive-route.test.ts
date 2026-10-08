/**
 * The public archive endpoints — the routes that make the archive a data layer
 * rather than a private table.
 *
 * Two properties matter more than the rest, and both are here because getting
 * either wrong is not a bug you notice from the outside.
 *
 * An unpublished row must be invisible. Nothing has approved it, and the ids
 * waiting in the queue are not a stranger's business either, so a pending
 * puzzle answers exactly as one that does not exist.
 *
 * CORS must stay on this prefix. The rest of the server has none, deliberately
 * — that absence is the whole CSRF argument in `review-routes.ts`, and a
 * wildcard on `/api/*` would hand every authenticated route the ingredient that
 * argument depends on being missing.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishArchive, upsertArchive } from "../server/archive-rows";
import type { ClearRequirement, Puzzle } from "../shared/puzzle";

const DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);
const PUBLIC = "http://localhost/api/public";

let fetchApp: (request: Request) => Response | Promise<Response>;

/** Ids well clear of anything another file in this shared database uses. */
const PUBLISHED = 9101;
const PENDING = 9102;

function puzzle(id: number, over: Partial<Puzzle> = {}): Puzzle {
  return {
    id,
    title: `puzzle ${id}`,
    author: "satilea",
    difficulty: 6,
    goal: "Clear a TSD",
    set: "spring",
    board: ["....xxxxxx", "....xxxxxx"],
    queue: ["T", "I", "O"],
    hold: null,
    targetAttack: 4,
    requiredClears: [{ clear: "tsd", count: 1 }] as ClearRequirement[],
    solution: [{ piece: "T", cells: [[0, 0], [1, 0], [2, 0], [1, 1]], clear: "tsd", attack: 4 }],
    source: { puzzle: "code-a", solution: "code-b" },
    ...over,
  } as Puzzle;
}

beforeAll(async () => {
  process.env.DATABASE_PATH = DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  const server = (await import("../server/index")).entrypoint;
  fetchApp = server.fetch;

  const db = new Database(DB);
  try {
    upsertArchive(db, puzzle(PUBLISHED), Date.now());
    upsertArchive(db, puzzle(PENDING, { title: "not approved yet" }), Date.now());
    publishArchive(db, [PUBLISHED], "an officer", Date.now());
  } finally {
    db.close();
  }
});

const get = (path: string, init?: RequestInit) =>
  Promise.resolve(fetchApp(new Request(`${PUBLIC}${path}`, init)));

describe("the whole archive", () => {
  test("is readable with no session and no key", async () => {
    const response = await get("");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { puzzles: { id: number }[]; count: number };
    expect(body.count).toBe(body.puzzles.length);
    expect(body.puzzles.some((p) => p.id === PUBLISHED)).toBe(true);
  });

  test("carries the answer, because the club publishes it", async () => {
    const body = (await (await get("")).json()) as {
      puzzles: { id: number; solution: unknown[] | null; source: unknown }[];
    };
    const found = body.puzzles.find((p) => p.id === PUBLISHED);

    expect(found?.solution).toBeTruthy();
    expect(found?.source).toBeTruthy();
  });

  test("does not list a puzzle nobody has published", async () => {
    const body = (await (await get("")).json()) as { puzzles: { id: number }[] };

    expect(body.puzzles.some((p) => p.id === PENDING)).toBe(false);
  });

  test("may be cached, because publishing is a deliberate act", async () => {
    const response = await get("");

    expect(response.headers.get("Cache-Control")).toContain("max-age=");
  });

  test("links each published puzzle to the Blueprint viewer, built from its codes", async () => {
    // Spelled out rather than built with `blueprintLink`. The viewer's address
    // moved to `shared/blueprint/viewer.ts` so the puzzle database could share
    // it, and a check that asked that module would agree with any change made
    // there. This pins what a downstream project actually receives.
    const viewer = (code: string | undefined) => (code ? `https://bp.tali.software/?${code}` : null);
    const body = (await (await get("")).json()) as {
      puzzles: {
        id: number;
        source: { puzzle: string; solution: string } | null;
        puzzleUrl: string | null;
        solutionUrl: string | null;
      }[];
    };
    const found = body.puzzles.find((p) => p.id === PUBLISHED);

    expect(found?.puzzleUrl).toBe("https://bp.tali.software/?code-a");
    expect(found?.solutionUrl).toBe("https://bp.tali.software/?code-b");
    for (const listed of body.puzzles) {
      expect(listed.puzzleUrl).toBe(viewer(listed.source?.puzzle));
      expect(listed.solutionUrl).toBe(viewer(listed.source?.solution));
    }
  });
});

describe("an unrated puzzle", () => {
  test("reports no difficulty rather than a difficulty of zero", async () => {
    // The sheet leaves the cell blank for a couple of puzzles, and buildPuzzle
    // coerces that to 0 because the game's type needs a number. Zero is not a
    // point on a scale that starts at one, and the website's schema declares
    // ge=1 — so publishing 0 hands a consumer a value it considers invalid.
    const db = new Database(DB);
    try {
      upsertArchive(db, puzzle(9103, { difficulty: 0, title: "unrated" }), Date.now());
      publishArchive(db, [9103], "an officer", Date.now());
    } finally {
      db.close();
    }

    const body = (await (await get("/9103")).json()) as { puzzle: { difficulty: number | null } };
    expect(body.puzzle.difficulty).toBeNull();
  });

  test("a real difficulty still comes through", async () => {
    const body = (await (await get(`/${PUBLISHED}`)).json()) as {
      puzzle: { difficulty: number | null };
    };
    expect(body.puzzle.difficulty).toBe(6);
  });
});

describe("one puzzle", () => {
  test("comes back by its id", async () => {
    const response = await get(`/${PUBLISHED}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { puzzle: { id: number; title: string } };
    expect(body.puzzle.id).toBe(PUBLISHED);
  });

  test("an unpublished id is a 404, not a 403", async () => {
    // A 403 would confirm the row exists, which tells a stranger what is in the
    // review queue. Absent and unapproved answer the same way.
    const pending = await get(`/${PENDING}`);
    const missing = await get("/999999");

    expect(pending.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  test("a nonsense id is refused rather than looked up", async () => {
    expect((await get("/banana")).status).toBe(400);
  });
});

describe("cross-origin access", () => {
  test("a browser on another site may read it", async () => {
    const response = await get("", { headers: { Origin: "https://tetrisatuci.org" } });

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

  test("the preflight is answered rather than falling through to the 404", async () => {
    const response = await get("", {
      method: "OPTIONS",
      headers: { Origin: "https://tetrisatuci.org", "Access-Control-Request-Method": "GET" },
    });

    expect(response.status).toBeLessThan(300);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

  test("and no other route gained CORS with it", async () => {
    // The rest of the server has none on purpose. If this starts passing a
    // header back, the CSRF argument in review-routes.ts has quietly stopped
    // being true.
    //
    // Probed through the `/api/*` catch-all rather than a real route, and that
    // detail is the test. Hono applies middleware in registration order, so a
    // widened `app.use("/api/*", cors())` mounted where the public routes are
    // mounted cannot reach anything declared above it — `/api/today` is
    // declared hundreds of lines earlier and would answer without the header
    // either way. The catch-all is registered *after* the public routes, so it
    // is the one path that actually reveals the widening.
    for (const path of ["/api/nope", "/api/today"]) {
      const response = await fetchApp(
        new Request(`http://localhost${path}`, { headers: { Origin: "https://evil.example" } }),
      );
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });
});
