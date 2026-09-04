/**
 * The route that takes a puzzle a player wrote.
 *
 * Every guarantee the archive makes about a puzzle — that its target is a
 * number somebody earned, that its reference solution is a list of placements
 * the engine itself produced, that its author is who it says — arrives here as
 * a claim typed into a browser. So each test below pins one thing the server
 * has to work out for itself rather than read off the body, and the bug it
 * would have caught is named where it is not obvious.
 *
 * The server module is imported for its `fetch`, not started, exactly as
 * `tests/server.test.ts` does it.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeBoard,
  ENGINE_ROWS,
  type Mino,
  type RowCode,
  type SolutionStep,
} from "../shared/puzzle";
import { createPuzzleEngine, toLetter } from "../shared/tetris/engine";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { findPaths } from "../shared/tetris/pathfinder";
import type { GameKey, InputEvent } from "../shared/tetris/verify";
// Type-only, so nothing under `server/` is loaded before `beforeAll` has set the
// environment `config` reads once at import.
import type { PlayerProfile, Store } from "../server/db";

/**
 * The same file `tests/server.test.ts` and `tests/duel.test.ts` name, and for
 * the reason spelt out at the top of the second of those: one module registry
 * per run means the first file to import anything under `server/` settles the
 * configuration for every other one, so a file asking for a database of its own
 * either gets ignored or quietly takes the whole suite's.
 *
 * There is deliberately no `afterAll` here. The store this import opens answers
 * the other files' routes too and outlives every one of their hooks, so exactly
 * one file may remove it — and that file is `tests/server.test.ts`. Deleting it
 * here left every later query raising SQLITE_IOERR_VNODE against the unlinked
 * vnode, which is the same bug duel.test.ts's header records.
 */
const DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);
const BASE = "http://localhost";

let fetchApp: (request: Request) => Response | Promise<Response>;
let mintSession: typeof import("../server/auth").mintSession;
let openStore: () => Store;

beforeAll(async () => {
  process.env.DATABASE_PATH = DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  fetchApp = (await import("../server/index")).default.fetch;
  mintSession = (await import("../server/auth")).mintSession;

  // The path `config` settled on, not the one set above. Every test file in a
  // run shares one module registry, so whichever of them imported the server
  // first is the one whose DATABASE_PATH took — and a test that read back the
  // wrong file would pass by finding nothing.
  const { config } = await import("../server/config");
  const { Store } = await import("../server/db");
  openStore = () => new Store(config.paths.database);
});

// ── The fixture ──────────────────────────────────────────────────────────────

/**
 * A T-slot with one T to fill it.
 *
 * Row 1 is open at 3, 4 and 5, row 0 only at 4, and the overhang on row 2
 * leaves columns 3 and 4 as the only way down — so the T has to be rotated into
 * place rather than dropped there, which is what makes the clear a TSD worth
 * four attack. Row 2 survives, or an empty board would make this a perfect
 * clear and hide the spin behind it.
 *
 * Written out as rows rather than compiled from a builder draft, the way
 * `tests/pipeline.test.ts` does it: this suite is about what the server makes
 * of a board it is handed, and the builder is the next step's problem.
 */
const TSD_BOARD: readonly RowCode[] = ["GGGG.GGGGG", "GGG...GGGG", "GGG..GGGGG"];
const TSD_QUEUE: readonly Mino[] = ["T"];
const TSD_ATTACK = 4;

/** Where the T has to end up for the spin. */
const TSD_PLACEMENT: Pick<SolutionStep, "piece" | "cells"> = {
  piece: "T",
  cells: [
    [3, 1],
    [4, 1],
    [5, 1],
    [4, 0],
  ],
};

/** The same T dropped flat on the overhang: legal play, nothing cleared. */
const FLAT_PLACEMENT: Pick<SolutionStep, "piece" | "cells"> = {
  piece: "T",
  cells: [
    [3, 3],
    [4, 3],
    [5, 3],
    [4, 4],
  ],
};

/**
 * A board with nowhere to put anything: twenty rows one cell short of full, so
 * the piece locks in the spawn buffer. Not full rows — those clear the instant
 * play starts, which is a different bug and not this one.
 */
const CEILING_BOARD: readonly RowCode[] = Array.from({ length: 20 }, () => "GGGGGGGGG.");

function setupOf(board: readonly RowCode[], queue: readonly Mino[], hold: Mino | null = null) {
  return { board: decodeBoard(board, ENGINE_ROWS), queue, hold };
}

/**
 * Keystrokes that put each piece where the step says, the way a player would.
 *
 * The same five lines `tests/pipeline.test.ts` and `tests/server.test.ts` each
 * keep their own specialised copy of — one drives it from the archive's
 * answers, one from a builder draft. Unifying the three is a change to two
 * suites this step has no business touching.
 */
function logFor(
  setup: ReturnType<typeof setupOf>,
  steps: readonly Pick<SolutionStep, "piece" | "cells">[],
): InputEvent[] {
  const { engine } = createPuzzleEngine(setup, DEFAULT_HANDLING);
  const events: InputEvent[] = [];
  let frame = 0;
  const tap = (key: GameKey) => {
    events.push({ frame, type: "keydown", data: { key, subframe: 0 } });
    events.push({ frame: frame + 1, type: "keyup", data: { key, subframe: 0 } });
    frame += 2;
  };

  for (const step of steps) {
    if (toLetter(engine.falling.symbol) !== step.piece) {
      tap("hold");
      engine.hold(false, true);
    }
    const route = findPaths(engine, step.cells)[0];
    if (!route) throw new Error(`unreachable placement: ${JSON.stringify(step)}`);
    for (const key of route) {
      tap(key);
      engine.press(key);
    }
    tap("hardDrop");
    engine.press("hardDrop");
  }
  return events;
}

const solvingLog = () => logFor(setupOf(TSD_BOARD, TSD_QUEUE), [TSD_PLACEMENT]);

/** Four squares as a set, since a piece's blocks have no meaningful order. */
function sortedCells(cells: readonly (readonly [number, number])[]): string[] {
  return cells.map(([x, y]) => `${x},${y}`).sort();
}

/** A body the route accepts, before a test spoils one field of it. */
function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Tuck the T",
    goal: "Clear 1 TSD",
    claimedDifficulty: 4,
    board: TSD_BOARD,
    queue: TSD_QUEUE,
    hold: null,
    handling: DEFAULT_HANDLING,
    events: solvingLog(),
    ...overrides,
  };
}

// ── Driving the route ────────────────────────────────────────────────────────

let players = 0;
let callers = 0;

async function tokenFor(id = `author-${++players}`): Promise<string> {
  const player: PlayerProfile = { id, username: `Author ${id}`, avatarUrl: null };
  return (await mintSession(player, null)).token;
}

/**
 * One submission attempt.
 *
 * Each call gets its own caller address by default. The limiter on this route
 * is deliberately tight and its buckets outlive a test file, so tests that
 * shared one address would start failing each other in whatever order the
 * runner happened to pick.
 */
function submit(
  body: unknown,
  token: string | undefined,
  ip = `198.51.100.${++callers}`,
): Promise<Response> {
  return Promise.resolve(
    fetchApp(
      new Request(`${BASE}/api/submissions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cf-Connecting-Ip": ip,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

interface AcceptedBody {
  readonly ok: true;
  readonly submissionId: number;
  readonly verified: { attack: number; clears: string[]; piecesPlaced: number };
}

// ── The tests ────────────────────────────────────────────────────────────────

describe("filing a puzzle a player wrote", () => {
  test("takes a solve, and derives the target and the answer key from it", async () => {
    const token = await tokenFor("author-happy");
    const response = await submit(draft(), token);
    expect(response.status).toBe(200);

    const body = (await response.json()) as AcceptedBody;
    expect(body.ok).toBe(true);
    expect(body.verified.attack).toBe(TSD_ATTACK);
    expect(body.verified.clears).toEqual(["tsd"]);
    expect(body.verified.piecesPlaced).toBe(1);

    const store = openStore();
    try {
      const stored = store.submission(body.submissionId);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe("pending");
      // The two fields the client is never asked for and never believed about.
      expect(stored!.targetAttack).toBe(TSD_ATTACK);
      expect(stored!.solution.length).toBe(1);
      expect(stored!.solution[0]!.piece).toBe("T");
      expect(stored!.solution[0]!.clear).toBe("tsd");
      expect(stored!.solution[0]!.attack).toBe(TSD_ATTACK);
      // The four squares, in whatever order the engine lists a piece's blocks
      // in. That order is the engine's business — `SolutionPlayer` locks the
      // cells into a board copy and never reads them in sequence — so pinning
      // it here would be a test of the library rather than of this route.
      expect(sortedCells(stored!.solution[0]!.cells)).toEqual(sortedCells(TSD_PLACEMENT.cells));
      // `frame` belongs to the replay, not to a solution step: `SolutionStep`
      // has no such field, and a reveal that carried one would be shipping the
      // author's timing to every player who solved the puzzle.
      expect(stored!.solution[0]).not.toHaveProperty("frame");
      // Kept, because accepting re-derives from the log rather than trusting
      // the solution column beside it.
      expect(stored!.events.length).toBe(solvingLog().length);
      expect(stored!.playerId).toBe("author-happy");
      expect(stored!.authorName).toBe("Author author-happy");
      expect(stored!.claimedDifficulty).toBe(4);
    } finally {
      store.close();
    }
  });

  test("takes the author and the target from the session, never from the body", async () => {
    // The exact body a hostile client would send: its own answer key, its own
    // target, and somebody else's name on the puzzle. `assertValid` waves a
    // `targetAttack` of MAX_SAFE_INTEGER straight through, so a route that
    // stored the claimed one would have written a permanently unsolvable
    // puzzle that every gate in the codebase agrees is fine.
    const token = await tokenFor("author-honest");
    const response = await submit(
      draft({
        id: 99,
        author: "someone-else",
        playerId: "someone-else",
        targetAttack: Number.MAX_SAFE_INTEGER,
        solution: [],
        status: "accepted",
        puzzleId: 100_001,
      }),
      token,
    );
    expect(response.status).toBe(200);

    const store = openStore();
    try {
      const stored = store.submission(((await response.json()) as AcceptedBody).submissionId)!;
      expect(stored.targetAttack).toBe(TSD_ATTACK);
      expect(stored.solution.length).toBe(1);
      expect(stored.playerId).toBe("author-honest");
      expect(stored.authorName).toBe("Author author-honest");
      expect(stored.status).toBe("pending");
      expect(stored.puzzleId).toBeNull();
    } finally {
      store.close();
    }
  });

  test("refuses a submission with no solve on it", async () => {
    const response = await submit(draft({ events: [] }), await tokenFor());
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain("Play your own puzzle first");
  });

  test("refuses a solve that sends no attack", async () => {
    // A legal play that clears nothing. There is nothing honest to put in
    // `targetAttack` for a puzzle whose author never made it do anything, and
    // a target of zero is one `meetsTarget` calls solved before the first
    // piece lands.
    const events = logFor(setupOf(TSD_BOARD, TSD_QUEUE), [FLAT_PLACEMENT]);
    const response = await submit(draft({ events }), await tokenFor());
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain("no attack");
  });

  test("replays the log against the board in the body, not the one it was recorded on", async () => {
    // This log solves the T-slot. Sent with a different board it places the
    // same piece somewhere useless, and the server has to notice — the whole
    // trust model of this route is that a submission proves "this log solves
    // *this* board", and the board is the client's to choose.
    const token = await tokenFor("author-stale");
    const response = await submit(
      draft({ board: ["..........", "..........", ".........."], events: solvingLog() }),
      token,
    );
    expect(response.status).toBe(400);

    const store = openStore();
    try {
      expect(store.pendingSubmissionCount("author-stale")).toBe(0);
    } finally {
      store.close();
    }
  });

  test("refuses a solve that topped out, and blames the topout rather than the attack", async () => {
    // Both refusals fire on this body, and the order is the point: a player
    // told "your solve sends no attack" about a board with no room in it would
    // go looking for a bigger clear.
    const events: InputEvent[] = [
      { frame: 0, type: "keydown", data: { key: "hardDrop", subframe: 0 } },
      { frame: 1, type: "keyup", data: { key: "hardDrop", subframe: 0 } },
    ];
    const response = await submit(
      draft({ board: CEILING_BOARD, queue: ["O"], events }),
      await tokenFor(),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain("topped out");
  });
});

describe("what the route refuses to believe", () => {
  const spoiled: readonly (readonly [string, Record<string, unknown>])[] = [
    ["no title", { title: "" }],
    ["a title that is not text", { title: 42 }],
    ["no goal", { goal: "   " }],
    ["a difficulty below the scale", { claimedDifficulty: 0 }],
    ["a difficulty above the scale", { claimedDifficulty: 21 }],
    ["a difficulty that is not a number", { claimedDifficulty: "hard" }],
    // The archive's own board rule, reached through the same function
    // `PuzzleArchive.load` calls — so a puzzle written into the database can
    // never be shaped differently from one built into the file.
    ["a short board row", { board: ["GGGG.GGGG"] }],
    ["a board row holding something that is not a piece", { board: ["GGGG?GGGGG"] }],
    ["an empty queue", { queue: [] }],
    ["a queue holding something that is not a piece", { queue: ["T", "X"] }],
    ["a hold that is not a piece", { hold: "X" }],
    ["a missing hold", { hold: undefined }],
    ["an input log that is not a list", { events: "hardDrop" }],
    ["an input log with a key the engine has no name for", {
      events: [{ frame: 0, type: "keydown", data: { key: "selfDestruct", subframe: 0 } }],
    }],
  ];

  test.each(spoiled.map(([name, override]) => [name, override] as const))(
    "refuses %s",
    async (_name, override) => {
      const response = await submit(draft(override), await tokenFor());
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("json");
    },
  );

  test("refuses a body that is not JSON at all", async () => {
    const response = await fetchApp(
      new Request(`${BASE}/api/submissions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cf-Connecting-Ip": "198.51.100.200",
          Authorization: `Bearer ${await tokenFor()}`,
        },
        body: "{ not json",
      }),
    );
    expect(response.status).toBe(400);
  });

  test("needs a session", async () => {
    const response = await submit(draft(), undefined);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("json");
  });

  test("refuses a guest", async () => {
    // Every guest is the same player, so a guest submission has no author to
    // credit, no quota that means anything, and a `player_id` that collides
    // with everyone else's. Guest play is off in production by construction —
    // but local and end-to-end is exactly where this feature gets exercised.
    const response = await submit(draft(), await tokenFor("guest"));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toContain("guest");
  });
});

describe("what one player may leave waiting", () => {
  test("caps the queue a single author can build up", async () => {
    const token = await tokenFor("author-prolific");
    for (let n = 1; n <= 3; n++) {
      const response = await submit(draft({ title: `Tuck the T ${n}` }), token);
      expect(response.status).toBe(200);
    }

    const over = await submit(draft({ title: "One too many" }), token);
    expect(over.status).toBe(409);
    expect(await errorOf(over)).toContain("waiting for review");

    const store = openStore();
    try {
      expect(store.pendingSubmissionCount("author-prolific")).toBe(3);
    } finally {
      store.close();
    }
  });

  test("the cap counts pending rows only, so a decision frees a slot", async () => {
    // The cap is a queue depth, not a lifetime allowance. Reading it off every
    // row a player has ever filed would retire an author after three puzzles.
    const token = await tokenFor("author-decided");
    const filed = (await (await submit(draft(), token)).json()) as AcceptedBody;

    const store = openStore();
    try {
      expect(store.pendingSubmissionCount("author-decided")).toBe(1);
      const { submission, isFirst } = store.decideSubmission(filed.submissionId, {
        status: "rejected",
        reviewedBy: "an officer",
        note: "Nice, but we have three of these.",
        puzzleId: null,
        difficulty: null,
      });
      expect(isFirst).toBe(true);
      expect(submission.status).toBe("rejected");
      expect(submission.reviewedBy).toBe("an officer");
      expect(store.pendingSubmissionCount("author-decided")).toBe(0);

      // Terminal means terminal: a second officer reaching the same row must
      // not overwrite the first one's verdict, and has to be able to tell that
      // they did not decide it.
      const again = store.decideSubmission(filed.submissionId, {
        status: "accepted",
        reviewedBy: "somebody else",
        note: null,
        puzzleId: 100_001,
        difficulty: 5,
      });
      expect(again.isFirst).toBe(false);
      expect(again.submission.status).toBe("rejected");
      expect(again.submission.reviewedBy).toBe("an officer");
      expect(again.submission.puzzleId).toBeNull();
    } finally {
      store.close();
    }
  });

  test("the review queue is oldest first, and holds only what is pending", async () => {
    // Reads the queue the tests above left behind — they run in order, and the
    // rejected row from the previous one is the whole point of the last
    // assertion here.
    const store = openStore();
    try {
      const queue = store.pendingSubmissions();
      expect(queue.every((entry) => entry.status === "pending")).toBe(true);
      expect(queue.map((entry) => entry.submissionId)).toEqual(
        [...queue].sort((a, b) => a.submissionId - b.submissionId).map((e) => e.submissionId),
      );
      expect(queue.some((entry) => entry.playerId === "author-decided")).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("the cost of a submission", () => {
  test("one caller cannot loop the verifier", async () => {
    // Replaying is the expensive part of this route, and the board it replays
    // against is the caller's to choose — so the limit here is far tighter than
    // the catch-all. The bodies are rejected on shape, before any replay: what
    // is being pinned is that the limiter counts attempts rather than work.
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const response = await submit(draft({ title: "" }), await tokenFor(), "198.51.100.250");
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });
});

// ── Review findings: both of these FAIL against the route as written ─────────

/**
 * A board whose rows are already full is attack lying in wait.
 *
 * `createPuzzleEngine` writes the author's cells in without clearing anything,
 * so a full row survives into play and clears on the first lock — whoever's
 * lock it is, wherever the piece went. `builder-state.ts:485-491` says exactly
 * this and calls it "attack nobody designed"; design §4 makes it a
 * `submitBlocker` rule. But the blocker runs in the browser, and this route's
 * whole premise is that the browser is not believed: the board is the one thing
 * a submission gets to choose, so the rule has to be here too or it is not a
 * rule.
 */
describe("a board that solves itself", () => {
  /** One arbitrary hard drop; no route-finding, because none is needed. */
  const oneHardDrop: readonly InputEvent[] = [
    { frame: 0, type: "keydown", data: { key: "hardDrop", subframe: 0 } },
    { frame: 1, type: "keyup", data: { key: "hardDrop", subframe: 0 } },
  ];

  test("refuses a board with a row that is already full", async () => {
    // Four full rows and a landing strip above them. The O goes wherever it
    // falls and the four rows clear underneath it, so the stored target is
    // four attack the author's play had nothing to do with — which makes the
    // route's own doc comment ("the attack the author's own solve sent — what
    // they *did*") untrue for this row, and hands every later player a puzzle
    // whose bar is met by dropping a piece anywhere at all.
    const board = [...Array.from({ length: 4 }, () => "GGGGGGGGGG"), ".........."];
    const response = await submit(
      draft({ title: "Free attack", board, queue: ["O"], events: oneHardDrop }),
      await tokenFor(),
    );
    expect(response.status).toBe(400);
  });

  test("refuses a board with no room left in it at all", async () => {
    // The same defect at its limit: twenty solid rows is a puzzle nothing can
    // be placed on, and it is accepted with a target of twenty. The topout
    // guard does not catch it because the rows clear on the same lock that
    // would have topped the piece out.
    const response = await submit(
      draft({
        title: "Twenty for nothing",
        board: Array.from({ length: 20 }, () => "GGGGGGGGGG"),
        queue: ["O"],
        events: oneHardDrop,
      }),
      await tokenFor(),
    );
    expect(response.status).toBe(400);
  });
});

/**
 * `null` is valid JSON, and `body.title` on it throws.
 *
 * The route reads the body with `.catch()` on the parse and then goes straight
 * at its fields, so the one JSON document that parses to a non-object turns a
 * bad request into a 500 and a `console.error` stack. `app.onError` already
 * takes the opposite position in writing — it maps `InvalidRunError` to 400 so
 * that "real faults stay visible in the log instead of drowning in client
 * bugs" — and this is a client bug drowning them one line earlier.
 */
describe("a body that is not an object", () => {
  test("answers 400 rather than 500 for a literal null body", async () => {
    const response = await fetchApp(
      new Request(`${BASE}/api/submissions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cf-Connecting-Ip": "198.51.100.201",
          Authorization: `Bearer ${await tokenFor()}`,
        },
        body: "null",
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("the length a queue may be", () => {
  test("counts the queue, not the queue plus the hold", async () => {
    // The builder caps the queue at 80 and fills a hold beside it, so a budget
    // bound refused a draft the builder had just shown as legal — at the one
    // moment the author can do nothing about it, and with a message that told
    // them a queue of exactly 80 held more than 80 pieces. Nothing trips it
    // today (the archive's longest queue is 74), so it would first have shown
    // up as an unexplained refusal that cost somebody their board.
    const eighty = Array.from({ length: 80 }, () => "T");
    expect((await submit(draft({ queue: eighty, hold: "T" }), await tokenFor())).status).toBe(200);

    const tooLong = await submit(draft({ queue: [...eighty, "T"], hold: null }), await tokenFor());
    expect(tooLong.status).toBe(400);
    expect(await errorOf(tooLong)).toContain("at most");
  });
});
