/**
 * Every way a puzzle has been solved, and who is allowed to read them.
 *
 * The panel beside the board used to step one line and say "One solution on
 * file — there may well be others." There were others; the archive had been
 * recording them for weeks and nobody could look at them.
 *
 * Two things are pinned here. **What the gallery holds**: the maker's answer
 * first, then the people who found something, oldest first, and never a
 * machine's output. And **what it must not leak**: these are answers, several
 * of them, so the gate is the one the reveal already used rather than a second
 * rule that could drift from it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type NewSolution } from "../server/db";
import { voidDiscoveries } from "../server/archive-rows";
import { profileLines } from "../server/discoveries";
import type { SolutionStep } from "../shared/puzzle";

const DB = join(tmpdir(), `solutions-gallery-${process.pid}.sqlite`);

const PLACEMENTS: SolutionStep[] = [
  { piece: "T", cells: [[3, 0], [4, 0], [5, 0], [4, 1]], clear: "tsd", attack: 4 },
];

function line(over: Partial<NewSolution> = {}): NewSolution {
  return {
    puzzleId: 93, canonicalKey: "k", keyVersion: 1,
    placements: PLACEMENTS, events: null, handling: null,
    attack: 4, targetAttack: 4, clears: ["tsd"], solvedStrict: true,
    source: "player", foundBy: "ada", guildId: "g1", ...over,
  };
}

let store: Store;

beforeEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
  store = new Store(DB);
  store.upsertPlayer({ id: "ada", username: "Ada", avatarUrl: null });
  store.upsertPlayer({ id: "bo", username: "Bo", avatarUrl: null });
});

afterEach(() => {
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
});

describe("what the gallery holds", () => {
  test("the maker's answer comes first, however late it was seeded", () => {
    // `seedReferenceSolutions` runs at boot, which is after every line a player
    // filed on the previous boot — so ordering by time alone would bury the
    // one line that is always there and always worth comparing against.
    // Player line first, so ordering on time alone would put it on top.
    store.recordSolution(line({ canonicalKey: "player" }));
    store.recordSolution(
      line({ canonicalKey: "reference", source: "reference", foundBy: null, guildId: null }),
    );

    const gallery = store.solutionGallery(93);
    expect(gallery.map((row) => row.source)).toEqual(["reference", "player"]);
    expect(gallery[0]!.finder).toBeNull();
  });

  test("the current version excludes old and retired rows, while history keeps them", () => {
    store.recordSolution(
      line({ canonicalKey: "old", contentHash: "old-hash", puzzleShape: "old-shape" }),
    );
    store.recordSolution(
      line({ canonicalKey: "retired", contentHash: "new-hash", puzzleShape: "new-shape" }),
    );
    store.recordSolution(
      line({ canonicalKey: "current", contentHash: "new-hash", puzzleShape: "new-shape" }),
    );
    store.archiveReader.run(
      "UPDATE puzzle_solutions SET voided_at = 10 WHERE canonical_key IN ('old', 'retired')",
    );

    expect(store.solutionGallery(93, "new-shape").map((row) => row.solutionId)).toEqual([3]);
    expect(store.historicalGallery(93, "old-hash").map((row) => row.solutionId)).toEqual([1]);
  });

  test("a retired row with the current shape stays out of current reads", () => {
    store.recordSolution(
      line({ canonicalKey: "retired-same-shape", contentHash: "same-hash", puzzleShape: "same-shape" }),
    );
    store.recordSolution(
      line({ canonicalKey: "current-same-shape", contentHash: "same-hash", puzzleShape: "same-shape" }),
    );
    store.archiveReader.run(
      "UPDATE puzzle_solutions SET voided_at = 10 WHERE canonical_key = 'retired-same-shape'",
    );

    expect(store.solutionGallery(93, "same-shape").map((row) => row.solutionId)).toEqual([2]);
    expect(store.solutionsFor(93, "same-shape").map((row) => row.solutionId)).toEqual([2]);
    expect(store.countSolutions(93, "same-shape")).toBe(1);
  });

  test("finders arrive named, and in the order they found things", () => {
    store.recordSolution(line({ canonicalKey: "a", foundBy: "ada" }));
    store.recordSolution(line({ canonicalKey: "b", foundBy: "bo" }));

    expect(store.solutionGallery(93).map((row) => row.finder?.username)).toEqual(["Ada", "Bo"]);
  });

  test("a machine's lines are not what anyone came here to read", () => {
    // `find-alternates` turned up 31 distinct lines on #123 alone. A gallery of
    // "what other people came up with" that is mostly a search's output is not
    // the thing anybody asked to see — they stay in the table for the maker's
    // tools.
    store.recordSolution(line({ canonicalKey: "found", source: "enumerated", foundBy: null }));
    store.recordSolution(line({ canonicalKey: "played" }));

    expect(store.solutionGallery(93).map((row) => row.source)).toEqual(["player"]);
  });

  test("it carries the placements, because stepping them is the point", () => {
    store.recordSolution(line());
    expect(store.solutionGallery(93)[0]!.placements).toEqual(PLACEMENTS);
  });

  test("a line whose board was edited away is no longer one of this puzzle's", () => {
    // The finder keeps the credit — `discoveryBoard` still pays for it — but
    // the line described a position that no longer exists, and stepping it on
    // today's board would be nonsense.
    store.recordSolution(line());
    voidDiscoveries(store.archiveReader, 93);

    expect(store.solutionGallery(93)).toEqual([]);
    expect(store.discoveryBoard().map((row) => row.found)).toEqual([1]);
  });
});

describe("the count beside a row", () => {
  test("counts exactly what the gallery will show", () => {
    // A number that disagrees with the list it opens is worse than no number.
    store.recordSolution(line({ canonicalKey: "a" }));
    store.recordSolution(line({ canonicalKey: "b", foundBy: "bo" }));
    store.recordSolution(line({ canonicalKey: "machine", source: "enumerated", foundBy: null }));
    store.recordSolution(line({ puzzleId: 94, canonicalKey: "c" }));

    const counts = store.galleryCounts();
    expect(counts.get(93)).toBe(store.solutionGallery(93).length);
    expect(counts.get(93)).toBe(2);
    expect(counts.get(94)).toBe(1);
  });

  test("a puzzle nobody has opened up is absent rather than zero", () => {
    expect(store.galleryCounts().get(999)).toBeUndefined();
  });
});

describe("what one player found", () => {
  test("their own lines, newest first", () => {
    store.recordSolution(line({ canonicalKey: "a", puzzleId: 93 }));
    store.recordSolution(line({ canonicalKey: "b", puzzleId: 94 }));
    store.archiveReader.run("UPDATE puzzle_solutions SET found_at = 10 WHERE puzzle_id = 93");
    store.archiveReader.run("UPDATE puzzle_solutions SET found_at = 20 WHERE puzzle_id = 94");

    expect(store.discoveriesBy("ada").map((r) => r.puzzleId)).toEqual([94, 93]);
  });

  test("counted under exactly the rule the board pays on", () => {
    // A list that disagrees with the number above it is worse than no list.
    store.recordSolution(line({ canonicalKey: "good" }));
    store.recordSolution(line({ canonicalKey: "reference", source: "reference", foundBy: null }));
    store.recordSolution(line({ canonicalKey: "offgoal", puzzleId: 94, solvedStrict: false, attack: 4 }));

    expect(store.discoveriesBy("ada")).toHaveLength(store.profile("ada").discoveries);
  });

  test("a line whose board was edited away still belongs to them, and says so", () => {
    // The credit is permanent; the claim is not. There is nothing left to step
    // through, which is a difference the reader has to be told about.
    store.recordSolution(line({ canonicalKey: "a" }));
    voidDiscoveries(store.archiveReader, 93);

    const found = store.discoveriesBy("ada");
    expect(found).toHaveLength(1);
    expect(found[0]!.voided).toBe(true);
  });

  test("somebody else's lines are not theirs", () => {
    store.recordSolution(line({ canonicalKey: "a", foundBy: "bo" }));
    expect(store.discoveriesBy("ada")).toEqual([]);
  });
});

describe("what a profile may say about a line", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    puzzleId: 92, attack: 18, clears: ["tsd"] as never, foundAt: 1, voided: false, ...over,
  });
  const titles = (id: number) => (id === 92 ? "nah sli'd win" : null);

  test("a line on a puzzle the reader has not solved ships no content", () => {
    // `openable` gates the click; attack and clears are the line's content, and
    // sending those to somebody who has not solved the puzzle is the very
    // disclosure the click is gated against.
    const [line] = profileLines([row()], titles, new Set());
    expect(line!.openable).toBe(false);
    expect(line!.attack).toBeNull();
    expect(line!.clears).toEqual([]);
    // The puzzle is still named: that much is on the front page already.
    expect(line!.title).toBe("nah sli'd win");
  });

  test("a line on one they have solved ships all of it", () => {
    const [line] = profileLines([row()], titles, new Set([92]));
    expect(line!.openable).toBe(true);
    expect(line!.attack).toBe(18);
    expect(line!.clears).toEqual(["tsd"]);
  });

  test("a voided line is shut even to somebody who solved that puzzle", () => {
    // The board it describes no longer exists, so there is nothing to step.
    const [line] = profileLines([row({ voided: true })], titles, new Set([92]));
    expect(line!.openable).toBe(false);
    expect(line!.attack).toBeNull();
  });

  test("and so is one on a puzzle this box does not have", () => {
    const [line] = profileLines([row({ puzzleId: 999 })], titles, new Set([999]));
    expect(line!.openable).toBe(false);
    expect(line!.title).toBe("");
  });
});
