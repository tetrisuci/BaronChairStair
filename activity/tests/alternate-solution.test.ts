/**
 * What counts as an alternate solution, spelled twice and checked against
 * itself.
 *
 * The rule is written once in TypeScript — `countsAsAlternate` — and once in
 * SQL, as `CREDITED` in `server/discovery-sql.ts`, because a leaderboard
 * cannot call a function per row. Two spellings of one rule is exactly the drift this
 * codebase keeps getting bitten by, so both are run here over one table of
 * cases and compared, rather than each being tested against its own idea of
 * what should happen.
 *
 * The rule itself: a line is an alternate solution if it **solves the puzzle**
 * — the attack target and every clear the goal names — **or sends more attack
 * than the puzzle asked for**, whatever it cleared getting there.
 *
 * The clause is checked twice over: through the game's own board, and as the
 * bare string db.tetrisatuci.org imports, run straight against the same rows.
 * The site cannot import `server/db.ts`, so it reads the clause from its own
 * module, and a test only of the board would not notice that module drifting
 * from what the board actually runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";
import { CREDITED, LIVE } from "../server/discovery-sql";
import { countsAsAlternate, solvesPuzzle, type ClearName } from "../shared/puzzle";

const DB = join(tmpdir(), `alternate-solution-${process.pid}.sqlite`);

/** Only the two fields either spelling of the rule reads. */
const PUZZLE = { targetAttack: 4, requiredClears: [{ clear: "tsd" as ClearName, count: 1 }] };

interface Case {
  readonly name: string;
  readonly attack: number;
  readonly clears: readonly ClearName[];
  readonly credited: boolean;
}

const CASES: readonly Case[] = [
  { name: "solves it exactly as asked", attack: 4, clears: ["tsd"], credited: true },
  // The near miss, and the one case the whole rule turns on: it reached the
  // number, but by a route the goal does not name, and it did not beat the
  // number either. Filed as evidence for the maker; not a point.
  { name: "hits the target without the clear", attack: 4, clears: ["quad"], credited: false },
  // Past the target, so it did something the reference answer did not.
  { name: "beats the target without the clear", attack: 5, clears: ["quad"], credited: true },
  { name: "beats the target with the clear", attack: 6, clears: ["tsd"], credited: true },
  { name: "beats the target having cleared nothing", attack: 5, clears: [], credited: true },
  { name: "falls short of the target", attack: 3, clears: ["tsd"], credited: false },
  { name: "falls short with extra clears", attack: 2, clears: ["tsd", "quad"], credited: false },
];

let store: Store;

beforeEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
  store = new Store(DB);
  store.upsertPlayer({ id: "ada", username: "Ada", avatarUrl: null });
});

afterEach(() => {
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
});

/** Files one line the way `recordDiscovery` does, and asks whether it paid. */
function creditedByTheBoard(one: Case): boolean {
  store.recordSolution({
    puzzleId: 1,
    canonicalKey: one.name,
    keyVersion: 1,
    placements: [],
    events: null,
    handling: null,
    attack: one.attack,
    targetAttack: PUZZLE.targetAttack,
    clears: one.clears,
    // Exactly what the producer stores: the solve, not the credit.
    solvedStrict: solvesPuzzle(one.attack, one.clears, PUZZLE),
    source: "player",
    foundBy: "ada",
    guildId: null,
  });
  return store.discoveryBoard().length === 1;
}

describe("countsAsAlternate", () => {
  for (const one of CASES) {
    test(`${one.name} — ${one.credited ? "counts" : "does not count"}`, () => {
      expect(countsAsAlternate(one.attack, one.clears, PUZZLE)).toBe(one.credited);
    });
  }
});

describe("the board's SQL agrees with it, case for case", () => {
  for (const one of CASES) {
    test(one.name, () => {
      expect(creditedByTheBoard(one)).toBe(countsAsAlternate(one.attack, one.clears, PUZZLE));
    });
  }
});

describe("a row filed before the target was recorded", () => {
  test("stands on its solve alone rather than on a backfilled guess", () => {
    // `attack > target_attack` is NULL on such a row, and `0 = 1 OR NULL` is
    // NULL, which is not true — so a line that missed the goal does not become
    // credited just because nobody wrote down what it was aiming at.
    store.recordSolution({
      puzzleId: 1, canonicalKey: "old-miss", keyVersion: 1, placements: [],
      events: null, handling: null, attack: 9, targetAttack: 4, clears: [],
      solvedStrict: false, source: "player", foundBy: "ada", guildId: null,
    });
    store.archiveReader.run("UPDATE puzzle_solutions SET target_attack = NULL");
    expect(store.discoveryBoard()).toEqual([]);

    // And one that did solve still pays, because `1 = 1 OR NULL` is true.
    store.recordSolution({
      puzzleId: 2, canonicalKey: "old-solve", keyVersion: 1, placements: [],
      events: null, handling: null, attack: 4, targetAttack: 4, clears: ["tsd"],
      solvedStrict: true, source: "player", foundBy: "ada", guildId: null,
    });
    store.archiveReader.run("UPDATE puzzle_solutions SET target_attack = NULL");
    expect(store.discoveryBoard().map((row) => [row.player.id, row.found])).toEqual([["ada", 1]]);
  });
});

/** Files one line as a player's, the way `recordDiscovery` does. */
function fileLine(one: Case, puzzleId = 1): void {
  store.recordSolution({
    puzzleId, canonicalKey: one.name, keyVersion: 1, placements: [],
    events: null, handling: null, attack: one.attack, targetAttack: PUZZLE.targetAttack,
    clears: one.clears, solvedStrict: solvesPuzzle(one.attack, one.clears, PUZZLE),
    source: "player", foundBy: "ada", guildId: null,
  });
}

/** How many filed rows a WHERE clause keeps, run as the site will run it. */
function kept(where: string): number {
  const row = store.archiveReader
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM puzzle_solutions s WHERE ${where}`)
    .get();
  return row?.n ?? 0;
}

describe("the clause the site imports agrees too, case for case", () => {
  for (const one of CASES) {
    test(one.name, () => {
      fileLine(one);

      expect(kept(CREDITED) === 1).toBe(countsAsAlternate(one.attack, one.clears, PUZZLE));
    });
  }

  test("keeps a voided line credited, and LIVE is what drops it", () => {
    // Credit outlives the board it was earned on; only the gallery asks LIVE.
    fileLine(CASES[0]!);
    store.archiveReader.run("UPDATE puzzle_solutions SET voided_at = 1");

    expect(kept(CREDITED)).toBe(1);
    expect(kept(`${CREDITED} AND s.${LIVE}`)).toBe(0);
    expect(store.discoveryBoard().map((row) => row.found)).toEqual([1]);
  });

  test("never credits a line nobody found", () => {
    store.recordSolution({
      puzzleId: 1, canonicalKey: "reference", keyVersion: 1, placements: [],
      events: null, handling: null, attack: 9, targetAttack: 4, clears: ["tsd"],
      solvedStrict: true, source: "reference", foundBy: null, guildId: null,
    });

    expect(kept(CREDITED)).toBe(0);
    expect(kept(LIVE)).toBe(1);
  });
});
