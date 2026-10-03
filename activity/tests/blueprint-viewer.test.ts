/**
 * Where a Blueprint code becomes a link, now that two servers build them.
 *
 * The URL used to be private to `server/public-routes.ts`. The puzzle database
 * builds the same links and must not import a route module to do it — its
 * privacy boundary would then load the game's routing to learn one string — so
 * the string moved to `shared/blueprint/viewer.ts`. These pin that the move
 * changed nothing a consumer can see: the links `/api/public` hands out are the
 * links this builds, byte for byte.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { publishArchive, upsertArchive } from "../server/archive-rows";
import { migrateArchive } from "../server/db";
import { registerPublicRoutes } from "../server/public-routes";
import type { Puzzle } from "../shared/puzzle";
import { BLUEPRINT_VIEWER, blueprintLink } from "../shared/blueprint/viewer";

describe("a Blueprint link", () => {
  test("is built from a code", () => {
    expect(blueprintLink("v115@9gB8DeA8BeB8BeA8AeA8")).toBe(
      "https://bp.tali.software/?v115@9gB8DeA8BeB8BeA8AeA8",
    );
  });

  test("is absent for an empty or missing code", () => {
    // A puzzle a player wrote has no code at all, and a club puzzle synced
    // before its answer was recorded has an empty one. Neither is a link.
    expect(blueprintLink("")).toBeNull();
    expect(blueprintLink(null)).toBeNull();
    expect(blueprintLink(undefined)).toBeNull();
  });

  test("uses the viewer /api/public has always used", async () => {
    expect(BLUEPRINT_VIEWER).toBe("https://bp.tali.software/?");

    const db = new Database(":memory:");
    try {
      migrateArchive(db);
      const puzzle: Puzzle = {
        id: 9201,
        title: "linked",
        author: "satilea",
        difficulty: 6,
        goal: "Clear a TSD",
        set: null,
        board: ["GGGG..GGGG"],
        queue: ["T", "I"],
        hold: null,
        targetAttack: 4,
        solution: [{ piece: "T", cells: [[4, 0], [5, 0], [4, 1], [5, 1]], clear: "tsd", attack: 4 }],
        source: { puzzle: "code-a", solution: "code-b" },
      };
      upsertArchive(db, puzzle, Date.now());
      publishArchive(db, [puzzle.id], "an officer", Date.now());
      const app = new Hono() as unknown as Parameters<typeof registerPublicRoutes>[0];
      registerPublicRoutes(app, db);

      const response = await app.request(`/api/public/${puzzle.id}`);
      const body = (await response.json()) as { puzzle: { puzzleUrl: string; solutionUrl: string } };

      expect(response.status).toBe(200);
      expect(body.puzzle.puzzleUrl).toBe(blueprintLink("code-a")!);
      expect(body.puzzle.solutionUrl).toBe(blueprintLink("code-b")!);
    } finally {
      db.close();
    }
  });
});
