/**
 * The archive table's two promises: a synced row is not playable until somebody
 * publishes it, and an edit to a published puzzle is applied but never silent.
 *
 * A creator may go back and edit their own puzzle, so the content moves. What
 * that costs is recorded rather than prevented: `runs` and `day_puzzles`
 * reference a puzzle by id and keep no copy of the board, so after the UPDATE
 * `archive_content_log` is the only thing that can say what a finished score
 * was set on. Rebuilding today's sheet edits twelve published puzzles, and #8 is
 * a different puzzle outright — same id, new board, new queue, new title.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveCounts,
  archiveEntry,
  contentHash,
  contentHistory,
  pendingArchive,
  publishArchive,
  readPublishedArchive,
  upsertArchive,
} from "../server/archive-rows";
import { Store } from "../server/db";
import { seedReferenceSolutions } from "../server/discoveries";
import { shapeKey } from "../server/puzzles";
import { COMMUNITY_ID_BASE, type ClearRequirement, type Puzzle } from "../shared/puzzle";

let dir: string;
let store: Store;
let db: Database;

const NOW = 1_700_000_000_000;

function puzzle(over: Partial<Puzzle> = {}): Puzzle {
  return {
    id: 1,
    title: "a puzzle",
    author: "someone",
    difficulty: 4,
    goal: "Send a TSD",
    set: "spring",
    board: ["....xxxxxx", "....xxxxxx"],
    queue: ["T", "I", "O"],
    hold: null,
    targetAttack: 4,
    // A real ClearName, not a line count: `clearShortfall` matches on the name,
    // and a number here silently fails every requirement check.
    solution: [{ piece: "T", cells: [[0, 0], [1, 0], [2, 0], [1, 1]], clear: "tsd", attack: 4 }],
    source: { puzzle: "code-a", solution: "code-b" },
    ...over,
  } as Puzzle;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "archive-rows-"));
  store = new Store(join(dir, "t.sqlite"));
  db = new Database(join(dir, "t.sqlite"));
});

afterEach(() => {
  db.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("syncing", () => {
  test("a new puzzle is written unpublished, and is not served", () => {
    expect(upsertArchive(db, puzzle(), NOW)).toEqual({ kind: "added" });

    expect(readPublishedArchive(db)).toEqual([]);
    expect(pendingArchive(db).map((e) => e.puzzle.id)).toEqual([1]);
    expect(archiveCounts(db)).toEqual({ published: 0, pending: 1 });
  });

  test("re-syncing an identical puzzle writes nothing", () => {
    upsertArchive(db, puzzle(), NOW);
    expect(upsertArchive(db, puzzle(), NOW + 5000)).toEqual({ kind: "unchanged" });
    expect(archiveEntry(db, 1)?.syncedAt).toBe(NOW);
  });

  test("a corrected title on a published puzzle flows through", () => {
    upsertArchive(db, puzzle(), NOW);
    publishArchive(db, [1], "officer", NOW);

    const outcome = upsertArchive(db, puzzle({ title: "the real title" }), NOW + 1);

    expect(outcome).toEqual({ kind: "amended", fields: ["title"] });
    expect(readPublishedArchive(db)[0]?.title).toBe("the real title");
  });

  test("an unpublished puzzle's content may be replaced outright", () => {
    upsertArchive(db, puzzle(), NOW);
    const moved = puzzle({ queue: ["S", "Z", "L"], targetAttack: 9 });

    const outcome = upsertArchive(db, moved, NOW + 1);

    expect(outcome.kind).toBe("amended");
    expect(archiveEntry(db, 1)?.puzzle.queue).toEqual(["S", "Z", "L"]);
    expect(archiveEntry(db, 1)?.contentHash).toBe(contentHash(moved));
  });
});

describe("a creator editing a published puzzle", () => {
  /** The shape of what the sheet did to puzzle #8. */
  const REPLACED = { queue: ["S", "Z", "L"], title: "misplaced heart" } as const;

  beforeEach(() => {
    upsertArchive(db, puzzle(), NOW);
    publishArchive(db, [1], "officer", NOW);
  });

  test("the edit is applied, and reported as its own outcome", () => {
    const outcome = upsertArchive(db, puzzle(REPLACED), NOW + 1, "a creator");

    expect(outcome.kind).toBe("edited");
    if (outcome.kind !== "edited") throw new Error("unreachable");
    expect(outcome.from).toBe(contentHash(puzzle()));
    expect(outcome.to).toBe(contentHash(puzzle(REPLACED)));
    // The metadata that moved alongside the content, which the sync prints.
    expect(outcome.fields).toEqual(["title"]);
    expect(readPublishedArchive(db)[0]?.queue).toEqual(["S", "Z", "L"]);
  });

  test("records who made the change, defaulting to the tool", () => {
    upsertArchive(db, puzzle(REPLACED), NOW + 1);

    expect(contentHistory(db, 1)[0]?.by).toBe("sync-archive");
  });

  test("it stays published, and stays published by whoever published it", () => {
    upsertArchive(db, puzzle(REPLACED), NOW + 1);

    expect(archiveEntry(db, 1)?.publishedBy).toBe("officer");
    expect(archiveEntry(db, 1)?.publishedAt).toBe(NOW);
    expect(readPublishedArchive(db)).toHaveLength(1);
  });

  test("the puzzle it used to be is recoverable afterwards", () => {
    // The whole reason the log exists: the UPDATE is what destroys this, and
    // runs and day_puzzles keep no copy of the board a score was set on.
    upsertArchive(db, puzzle(REPLACED), NOW + 1, "a creator");

    const history = contentHistory(db, 1);
    expect(history).toHaveLength(1);
    expect(history[0]?.wasHash).toBe(contentHash(puzzle()));
    expect(history[0]?.becameHash).toBe(contentHash(puzzle(REPLACED)));
    expect(history[0]?.wasPublished).toBe(true);
    expect(history[0]?.by).toBe("a creator");
    // Pinned because a log that cannot say when or who is a log nobody can act
    // on: both survived a mutation pass that blanked them.
    expect(history[0]?.at).toBe(NOW + 1);

    const row = db
      .query<{ was_queue: string; was_target: number }, [number]>(
        "SELECT was_queue, was_target FROM archive_content_log WHERE puzzle_id = ?1",
      )
      .get(1);
    expect(JSON.parse(row!.was_queue)).toEqual(["T", "I", "O"]);
    expect(row!.was_target).toBe(4);
  });

  test("editing twice keeps both entries, oldest first", () => {
    upsertArchive(db, puzzle(REPLACED), NOW + 1);
    upsertArchive(db, puzzle({ queue: ["J", "L", "T"] }), NOW + 2);

    const history = contentHistory(db, 1);
    expect(history).toHaveLength(2);
    expect(history[0]!.entryId).toBeLessThan(history[1]!.entryId);
    expect(history[1]?.wasHash).toBe(contentHash(puzzle(REPLACED)));
  });

  test("a metadata-only correction is not logged as a content change", () => {
    const outcome = upsertArchive(db, puzzle({ title: "renamed" }), NOW + 1);

    expect(outcome.kind).toBe("amended");
    expect(contentHistory(db, 1)).toEqual([]);
  });
});

describe("discovered solutions, when content is edited", () => {
  /** One discovered line, as `recordDiscovery` would file it. */
  function discovery(key: string) {
    return {
      puzzleId: 1,
      canonicalKey: key,
      keyVersion: 1,
      placements: [],
      events: null,
      handling: null,
      attack: 4,
      targetAttack: 4,
      clears: ["tsd"] as const,
      solvedStrict: true,
      source: "player" as const,
      foundBy: "p1",
      guildId: null,
    };
  }

  beforeEach(() => {
    store.upsertPlayer({ id: "p1", username: "someone", avatarUrl: null });
    upsertArchive(db, puzzle(), NOW);
    publishArchive(db, [1], "officer", NOW);
    store.recordSolution(discovery("line-a"));
    store.recordSolution(discovery("line-b"));
  });

  test("are voided, and the count is reported and logged", () => {
    const outcome = upsertArchive(db, puzzle({ queue: ["S", "Z", "L"] }), NOW + 1);

    expect(outcome.kind).toBe("edited");
    if (outcome.kind !== "edited") throw new Error("unreachable");
    expect(outcome.solutionsVoided).toBe(2);
    expect(store.countSolutions(1)).toBe(0);
    expect(contentHistory(db, 1)[0]?.solutionsVoided).toBe(2);
    const tagged = db
      .query<{ content_hash: string; puzzle_shape: string; voided_at: number }, []>(
        "SELECT content_hash, puzzle_shape, voided_at FROM puzzle_solutions ORDER BY solution_id LIMIT 1",
      )
      .get();
    expect(tagged).toEqual({
      content_hash: contentHash(puzzle()),
      puzzle_shape: shapeKey(puzzle()),
      voided_at: NOW + 1,
    });
    expect(store.historicalGallery(1, contentHash(puzzle()))).toHaveLength(2);
  });

  test("keeps a published maker answer for the previous-version gallery", () => {
    const original = puzzle();
    store.recordSolution({
      puzzleId: original.id,
      canonicalKey: "reference-old",
      keyVersion: 1,
      placements: original.solution!,
      events: null,
      handling: null,
      attack: 4,
      targetAttack: original.targetAttack,
      clears: ["tsd"],
      solvedStrict: true,
      source: "reference",
      foundBy: null,
      guildId: null,
      contentHash: contentHash(original),
      puzzleShape: shapeKey(original),
    });

    upsertArchive(db, puzzle({ queue: ["S", "Z", "L"] }), NOW + 1);

    // The new answer is what the next boot seeds. The old row was voided by
    // the published edit and must remain available to the history route.
    const edited = puzzle({ queue: ["S", "Z", "L"] });
    seedReferenceSolutions(store, [edited]);

    const references = db
      .query<{ content_hash: string; voided_at: number | null }, []>(
        "SELECT content_hash, voided_at FROM puzzle_solutions WHERE source = 'reference' ORDER BY solution_id",
      )
      .all();
    expect(references).toHaveLength(2);
    expect(references[0]).toEqual({ content_hash: contentHash(original), voided_at: NOW + 1 });
    expect(store.historicalGallery(1, contentHash(original))).toHaveLength(3);
  });

  test("the next player to find one of those lines is credited for it", () => {
    // The whole reason to void rather than keep. The unique index on
    // (puzzle_id, canonical_key) means a surviving row would have made this
    // rediscovery a duplicate, on a board where it is a genuine first.
    upsertArchive(db, puzzle({ queue: ["S", "Z", "L"] }), NOW + 1);

    expect(store.recordSolution(discovery("line-a")).discovered).toBe(true);
  });

  test("a metadata correction leaves them alone", () => {
    upsertArchive(db, puzzle({ title: "renamed" }), NOW + 1);

    expect(store.countSolutions(1)).toBe(2);
  });

  test("another puzzle's discoveries are untouched", () => {
    upsertArchive(db, puzzle({ id: 2 }), NOW);
    store.recordSolution({ ...discovery("line-a"), puzzleId: 2 });

    upsertArchive(db, puzzle({ queue: ["S", "Z", "L"] }), NOW + 1);

    expect(store.countSolutions(2)).toBe(1);
  });
});

describe("when a write fails part-way through an edit", () => {
  /**
   * The deletion of discovered solutions is the one irreversible statement in
   * the edit path — the archive row can be re-synced from the sheet, a deleted
   * discovery exists nowhere. Run first, as it originally was, a later throw
   * committed the deletion while the edit that justified it rolled back.
   */
  test("the discoveries are not destroyed", () => {
    store.upsertPlayer({ id: "p1", username: "someone", avatarUrl: null });
    upsertArchive(db, puzzle(), NOW);
    publishArchive(db, [1], "officer", NOW);
    store.recordSolution({
      puzzleId: 1,
      canonicalKey: "line-a",
      keyVersion: 1,
      placements: [],
      events: null,
      handling: null,
      attack: 4,
      targetAttack: 4,
      clears: ["tsd"],
      solvedStrict: true,
      source: "player",
      foundBy: "p1",
      guildId: null,
    });

    // Make the log write fail, which is what a database upgraded from an
    // earlier version of this table did.
    db.run("DROP TABLE archive_content_log");

    expect(() => upsertArchive(db, puzzle({ queue: ["S", "Z", "L"] }), NOW + 1)).toThrow();

    // Nothing applied, and nothing lost.
    expect(store.countSolutions(1)).toBe(1);
    expect(archiveEntry(db, 1)?.puzzle.queue).toEqual(["T", "I", "O"]);
  });
});

describe("an unpublished puzzle's discoveries", () => {
  test("are left alone when its content changes", () => {
    // An unpublished row is not what the server serves, so a discovery filed
    // under its id belongs to whatever is being served under that id. Deleting
    // it would destroy somebody else's row on the strength of an id match —
    // and an unpublished change reports as a plain amendment, so silently.
    store.upsertPlayer({ id: "p1", username: "someone", avatarUrl: null });
    upsertArchive(db, puzzle(), NOW);
    store.recordSolution({
      puzzleId: 1,
      canonicalKey: "line-a",
      keyVersion: 1,
      placements: [],
      events: null,
      handling: null,
      attack: 4,
      targetAttack: 4,
      clears: ["tsd"],
      solvedStrict: true,
      source: "player",
      foundBy: "p1",
      guildId: null,
    });

    const outcome = upsertArchive(db, puzzle({ queue: ["S", "Z", "L"] }), NOW + 1);

    expect(outcome.kind).toBe("amended");
    expect(store.countSolutions(1)).toBe(1);
    expect(contentHistory(db, 1)[0]?.solutionsVoided).toBeNull();
  });

  test("player history excludes unpublished draft revisions", () => {
    upsertArchive(db, puzzle(), NOW);
    upsertArchive(db, puzzle({ queue: ["S", "Z", "L"] }), NOW + 1);
    expect(store.puzzleHistory(puzzle({ queue: ["S", "Z", "L"] }))).toEqual([]);

    publishArchive(db, [1], "officer", NOW + 2);
    upsertArchive(db, puzzle({ queue: ["Z", "L", "T"] }), NOW + 3);
    expect(store.puzzleHistory(puzzle({ queue: ["Z", "L", "T"] }))).toHaveLength(1);
  });
});

describe("legacy solution version backfill", () => {
  test("does not call a post-history unlogged line current", () => {
    upsertArchive(db, puzzle(), NOW);
    publishArchive(db, [1], "officer", NOW);
    upsertArchive(db, puzzle({ queue: ["S", "Z", "L"] }), NOW + 1);

    store.upsertPlayer({ id: "p1", username: "someone", avatarUrl: null });
    store.recordSolution({
      puzzleId: 1,
      canonicalKey: "legacy-after-edit",
      keyVersion: 1,
      placements: [],
      events: null,
      handling: null,
      attack: 4,
      targetAttack: 4,
      clears: ["tsd"],
      solvedStrict: true,
      source: "player",
      foundBy: "p1",
      guildId: null,
    });

    const current = puzzle({ queue: ["Z", "L", "T"] });
    store.stampMissingSolutionVersions(1, contentHash(current), shapeKey(current));

    const row = db
      .query<{ content_hash: string | null; puzzle_shape: string | null }, []>(
        "SELECT content_hash, puzzle_shape FROM puzzle_solutions WHERE canonical_key = 'legacy-after-edit'",
      )
      .get();
    expect(row).toEqual({ content_hash: null, puzzle_shape: null });
    expect(store.solutionGallery(1, shapeKey(current))).toEqual([]);
  });

});

describe("the frozen clear requirement, when content is edited", () => {
  const TSD: readonly ClearRequirement[] = [{ clear: "tsd", count: 1 }];
  /** A solution that clears nothing, so the frozen requirement cannot be met. */
  const NO_CLEARS = {
    solution: [{ piece: "T", cells: [[0, 0], [1, 0], [2, 0], [1, 1]], clear: null, attack: 4 }],
  } as Partial<Puzzle>;

  beforeEach(() => {
    upsertArchive(db, puzzle({ requiredClears: TSD }), NOW);
    publishArchive(db, [1], "officer", NOW);
  });

  test("goes away when the new answer clears nothing to require", () => {
    // Left in place it would demand a clear the puzzle's own answer never makes,
    // which is an unsolvable published puzzle. The rule is re-derived from the
    // new answer rather than dropped; this answer's derivation is empty.
    const outcome = upsertArchive(db, puzzle({ ...NO_CLEARS, queue: ["S", "Z", "L"] }), NOW + 1);

    expect(outcome.kind).toBe("edited");
    if (outcome.kind !== "edited") throw new Error("unreachable");
    expect(outcome.replacedClears).toEqual(TSD);
    expect(outcome.nowRequires).toEqual([]);
    expect(archiveEntry(db, 1)?.puzzle.requiredClears).toBeUndefined();
  });

  test("follows the new answer to whatever that one clears", () => {
    // The case the old scheme had no answer for: the edit is solvable, but by
    // *different* clears. The rule moves with the answer instead of being
    // dropped for disagreeing with a sentence nobody consults any more.
    const QUAD = {
      solution: [
        { piece: "I", cells: [[0, 0], [1, 0], [2, 0], [3, 0]], clear: "quad", attack: 4 },
      ],
    } as Partial<Puzzle>;

    const outcome = upsertArchive(db, puzzle({ ...QUAD, queue: ["S", "Z", "L"] }), NOW + 1);

    expect(outcome.kind).toBe("edited");
    if (outcome.kind !== "edited") throw new Error("unreachable");
    expect(outcome.nowRequires).toEqual([{ clear: "quad", count: 1 }]);
    expect(archiveEntry(db, 1)?.puzzle.requiredClears).toEqual([{ clear: "quad", count: 1 }]);
  });

  test("is kept when the new answer still meets it", () => {
    const outcome = upsertArchive(db, puzzle({ queue: ["S", "Z", "L"] }), NOW + 1);

    expect(outcome.kind).toBe("edited");
    if (outcome.kind !== "edited") throw new Error("unreachable");
    expect(outcome.replacedClears).toBeNull();
    expect(archiveEntry(db, 1)?.puzzle.requiredClears).toEqual(TSD);
  });

  test("the dropped requirement survives in the log", () => {
    upsertArchive(db, puzzle({ ...NO_CLEARS, queue: ["S", "Z", "L"] }), NOW + 1);

    expect(contentHistory(db, 1)[0]?.wasClears).toEqual(TSD);
  });
});

describe("publishing", () => {
  beforeEach(() => {
    upsertArchive(db, puzzle({ id: 1 }), NOW);
    upsertArchive(db, puzzle({ id: 2 }), NOW);
  });

  test("makes rows readable and records who did it", () => {
    expect(publishArchive(db, [1, 2], "officer", NOW)).toEqual([1, 2]);

    expect(readPublishedArchive(db).map((p) => p.id)).toEqual([1, 2]);
    expect(archiveEntry(db, 1)?.publishedBy).toBe("officer");
    expect(archiveEntry(db, 1)?.publishedAt).toBe(NOW);
  });

  test("a second officer publishing the same rows changes nothing", () => {
    publishArchive(db, [1, 2], "first", NOW);

    expect(publishArchive(db, [1, 2], "second", NOW + 1)).toEqual([]);
    expect(archiveEntry(db, 1)?.publishedBy).toBe("first");
  });

  test("publishes only the rows named", () => {
    expect(publishArchive(db, [2], "officer", NOW)).toEqual([2]);
    expect(readPublishedArchive(db).map((p) => p.id)).toEqual([2]);
  });
});

describe("the community band", () => {
  test("a sheet id inside it is refused", () => {
    expect(() => upsertArchive(db, puzzle({ id: COMMUNITY_ID_BASE }), NOW)).toThrow(
      /outside the club band/,
    );
  });

  test("the id below it is fine", () => {
    expect(upsertArchive(db, puzzle({ id: COMMUNITY_ID_BASE - 1 }), NOW).kind).toBe("added");
  });
});

describe("the clear requirement", () => {
  test("survives a re-sync that does not carry one", () => {
    const clears: readonly ClearRequirement[] = [{ clear: "tsd", count: 1 }];
    upsertArchive(db, puzzle({ requiredClears: clears }), NOW);

    upsertArchive(db, puzzle({ title: "renamed" }), NOW + 1);

    expect(archiveEntry(db, 1)?.puzzle.requiredClears).toEqual(clears);
  });
});

describe("the archive's own bookkeeping", () => {
  const META = { addedOn: "2026-04-03", solveCount: 7 } as const;

  test("is stored beside the puzzle without touching the Puzzle type", () => {
    upsertArchive(db, puzzle(), NOW, "sync-archive", META);

    const entry = archiveEntry(db, 1);
    expect(entry?.addedOn).toBe("2026-04-03");
    expect(entry?.solveCount).toBe(7);
  });

  test("backfills onto a row that predates the columns", () => {
    // The bug this pins: a row inserted before added_on existed matched on
    // hash and on all five metadata fields, so the `unchanged` early return
    // skipped the UPDATE and it stayed NULL through every future sync. An
    // upgraded database reported 153 unchanged and 0 with a date.
    upsertArchive(db, puzzle(), NOW);
    expect(archiveEntry(db, 1)?.addedOn).toBeNull();

    const outcome = upsertArchive(db, puzzle(), NOW + 1, "sync-archive", META);

    expect(outcome.kind).toBe("amended");
    expect(archiveEntry(db, 1)?.addedOn).toBe("2026-04-03");
  });

  test("an unchanged sheet is still unchanged", () => {
    upsertArchive(db, puzzle(), NOW, "sync-archive", META);

    expect(upsertArchive(db, puzzle(), NOW + 1, "sync-archive", META).kind).toBe("unchanged");
  });
});
