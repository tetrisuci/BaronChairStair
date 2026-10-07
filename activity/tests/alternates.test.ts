/**
 * The alternate solutions browser: which lines it lists, and what it may say
 * about each one to the player reading it.
 *
 * Two layers, pinned apart. **The query** — `Store.liveAlternates` — decides
 * which rows are alternates at all, and it has to be the rule the Discoveries
 * board pays on (`CREDITED`) narrowed to the lines that still describe a board
 * (`LIVE`). A browser of "alternate solutions" that listed the maker's answer,
 * the batch search's output, a line on a board that was edited away, or a line
 * that beat nothing would be listing something else under that name.
 *
 * **The gate** — `alternateRows` — decides what a reader is told. A line is an
 * answer, so a puzzle the reader has not solved shows only that the line
 * exists, who found it and when: the profile's rule (`profileLines`), for the
 * same reason. And a puzzle they must not even rehearse — one of today's tiers
 * still unsolved, or a duel round in play — is not listed at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type AlternateLine, type NewSolution } from "../server/db";
import { voidDiscoveries } from "../server/archive-rows";
import { alternateRows } from "../server/alternates";
import type { SolutionStep } from "../shared/puzzle";

const DB = join(tmpdir(), `alternates-${process.pid}.sqlite`);

const PLACEMENTS: SolutionStep[] = [
  { piece: "T", cells: [[3, 0], [4, 0], [5, 0], [4, 1]], clear: null, attack: 0 },
  { piece: "O", cells: [[0, 0], [1, 0], [0, 1], [1, 1]], clear: null, attack: 0 },
  { piece: "I", cells: [[6, 0], [7, 0], [8, 0], [9, 0]], clear: "tsd", attack: 4 },
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
  store.upsertPlayer({ id: "bo", username: "Bo", avatarUrl: "https://cdn.test/bo.png" });
});

afterEach(() => {
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
});

describe("which lines are alternates", () => {
  test("a credited player line is listed, with who found it and how long it is", () => {
    const { solutionId } = store.recordSolution(line({ foundBy: "bo" }));

    const [only, ...rest] = store.liveAlternates();
    expect(rest).toEqual([]);
    expect(only!.solutionId).toBe(solutionId!);
    expect(only!.puzzleId).toBe(93);
    expect(only!.attack).toBe(4);
    expect(only!.clears).toEqual(["tsd"]);
    // The length, counted in the database rather than by shipping the
    // placements: the list never draws a board, and three hundred lines of
    // placements is a lot of JSON to send for a number.
    expect(only!.pieces).toBe(PLACEMENTS.length);
    expect(only!.finder).toEqual({ id: "bo", username: "Bo", avatarUrl: "https://cdn.test/bo.png" });
    expect(typeof only!.foundAt).toBe("number");
    expect("placements" in only!).toBe(false);
  });

  test("a line that beat the target without the named clears still counts", () => {
    // `countsAsAlternate`: solved it, *or* sent more than it asked for.
    store.recordSolution(line({ canonicalKey: "over", solvedStrict: false, attack: 6, clears: [] }));
    expect(store.liveAlternates()).toHaveLength(1);
  });

  test("the maker's answer, the batch search and lines that beat nothing are not", () => {
    store.recordSolution(line({ canonicalKey: "ref", source: "reference", foundBy: null }));
    store.recordSolution(line({ canonicalKey: "enum", source: "enumerated", foundBy: null }));
    // Off the goal and no more attack than asked: filed, but not an alternate.
    store.recordSolution(line({ canonicalKey: "flat", solvedStrict: false, attack: 4, clears: [] }));
    expect(store.liveAlternates()).toEqual([]);
  });

  test("a line on a board that was edited away is not", () => {
    // Its finder keeps the credit — the board pays on the finding — but there
    // is nothing left to step through, and this is a list of lines to open.
    store.recordSolution(line());
    voidDiscoveries(store.archiveReader, 93);
    expect(store.liveAlternates()).toEqual([]);
  });

  test("every puzzle's lines, newest first", () => {
    store.recordSolution(line({ canonicalKey: "a", puzzleId: 93 }));
    store.recordSolution(line({ canonicalKey: "b", puzzleId: 94, foundBy: "bo" }));
    store.recordSolution(line({ canonicalKey: "c", puzzleId: 95 }));
    store.archiveReader.run("UPDATE puzzle_solutions SET found_at = 30 WHERE puzzle_id = 93");
    store.archiveReader.run("UPDATE puzzle_solutions SET found_at = 10 WHERE puzzle_id = 94");
    store.archiveReader.run("UPDATE puzzle_solutions SET found_at = 20 WHERE puzzle_id = 95");

    expect(store.liveAlternates().map((row) => row.puzzleId)).toEqual([93, 95, 94]);
  });
});

describe("what a reader is told about each line", () => {
  const found = (over: Partial<AlternateLine> = {}): AlternateLine => ({
    solutionId: 7,
    puzzleId: 92,
    foundAt: 1_000,
    attack: 18,
    clears: ["tsd", "tst"],
    pieces: 9,
    finder: { id: "bo", username: "Bo", avatarUrl: null },
    ...over,
  });
  const puzzles: Record<number, { title: string; difficulty: number; set: string | null }> = {
    92: { title: "nah sli'd win", difficulty: 7, set: "Season 2" },
    93: { title: "unrated thing", difficulty: 0, set: null },
  };
  const puzzleOf = (id: number) => puzzles[id] ?? null;
  const always = () => true;

  test("a puzzle the reader has solved shows the whole line", () => {
    const [row] = alternateRows([found()], puzzleOf, always, new Set([92]));
    expect(row).toEqual({
      solutionId: 7,
      puzzleId: 92,
      title: "nah sli'd win",
      difficulty: 7,
      set: "Season 2",
      finder: { id: "bo", username: "Bo", avatarUrl: null },
      foundAt: 1_000,
      locked: false,
      attack: 18,
      pieces: 9,
      clears: ["tsd", "tst"],
    });
  });

  test("one they have not solved names the puzzle, the finder and the day, and nothing of the line", () => {
    // Attack, length and clears are the line's content — enough, on a short
    // puzzle, to give the answer away — and the profile already withholds them
    // from a reader who has not solved the puzzle. Same rule, same reason.
    const [row] = alternateRows([found()], puzzleOf, always, new Set());
    expect(row!.locked).toBe(true);
    expect(row!.attack).toBeNull();
    expect(row!.pieces).toBeNull();
    expect(row!.clears).toBeNull();
    expect(row!.title).toBe("nah sli'd win");
    expect(row!.finder?.username).toBe("Bo");
    expect(row!.foundAt).toBe(1_000);
  });

  test("an unrated puzzle's difficulty is absent, not zero", () => {
    // Zero is how the archive spells "unrated", and a sort that read it as the
    // easiest puzzle there is would file every unrated line under the easy end.
    const [row] = alternateRows([found({ puzzleId: 93 })], puzzleOf, always, new Set([93]));
    expect(row!.difficulty).toBeNull();
  });

  test("a puzzle the reader may not see yet is left out entirely", () => {
    // Today's unsolved tier, or a duel round in play. A locked row would still
    // say "somebody found another way through the puzzle you are about to be
    // scored on", and how many times — which is a hint, so it is not a row.
    const rows = alternateRows(
      [found({ solutionId: 1, puzzleId: 92 }), found({ solutionId: 2, puzzleId: 93 })],
      puzzleOf,
      (id) => id !== 92,
      new Set([92, 93]),
    );
    expect(rows.map((row) => row.solutionId)).toEqual([2]);
  });

  test("a line on a puzzle this box does not have is left out", () => {
    // There is no title to show and nothing to open it on.
    expect(alternateRows([found({ puzzleId: 999 })], puzzleOf, always, new Set([999]))).toEqual([]);
  });

  test("asks whether a puzzle may be seen once per puzzle, not once per line", () => {
    // The question reads the day's schedule and a run; a popular puzzle with
    // forty lines should not ask it forty times.
    const asked: number[] = [];
    alternateRows(
      [found({ solutionId: 1 }), found({ solutionId: 2 }), found({ solutionId: 3, puzzleId: 93 })],
      puzzleOf,
      (id) => {
        asked.push(id);
        return true;
      },
      new Set(),
    );
    expect(asked).toEqual([92, 93]);
  });

  test("keeps the order it was given", () => {
    const rows = alternateRows(
      [found({ solutionId: 3 }), found({ solutionId: 1 }), found({ solutionId: 2 })],
      puzzleOf,
      always,
      new Set([92]),
    );
    expect(rows.map((row) => row.solutionId)).toEqual([3, 1, 2]);
  });
});
