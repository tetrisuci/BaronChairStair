/**
 * What the puzzle database lists, built from one snapshot of the game.
 *
 * The site lists what players are dealt — not the published record
 * `/api/public` serves — so the oracle here is the game's own loader:
 * `PuzzleArchive.load` over the same six inputs, compared field by field, with
 * only the puzzles players wrote set aside. Corrections applied, unpublished
 * rows absent, the committed puzzles and the published synced rows both there.
 *
 * Then the mapping into the public shape, where three distinctions are easy to
 * flatten by accident and each tells a reader something different: unrated is
 * null, not 0; nobody-decided is not decided-none; no answer is null, not an
 * empty list. Then the Blueprint codes, borrowed from the tracked archive by
 * shape and only where they play the answer being served. Then history: which
 * tiers a day shows, a player's deal named by its tier alone, a departed club
 * puzzle kept by its number.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { trackedAnswers } from "../server/archive-solutions";
import { PuzzleArchive, shapeKey } from "../server/puzzles";
import { blueprintLink } from "../shared/blueprint/viewer";
import { DAILY_TIERS, dailyTierOf } from "../shared/daily";
import { COMMUNITY_ID_BASE, pieceBudget, type Puzzle, type SolutionStep } from "../shared/puzzle";
import { trackedCodes } from "../puzzledb/server/codes";
import { buildDataset } from "../puzzledb/server/dataset";
import { FIRST_EXTREME_DAY, FIRST_TIERED_DAY, POLICY } from "../puzzledb/server/policy";
import { openGameDatabase, readSnapshot } from "../puzzledb/server/snapshot";
import type { Dataset, DatasetSources, DayPin, GameSnapshot, Policy } from "../puzzledb/server/types";
import { dateOfDay, SCHEMA_VERSION, type SiteDay, type SitePuzzle } from "../puzzledb/wire";
import {
  COMMUNITY_AUTHOR,
  COMMUNITY_ID,
  COMMUNITY_TITLE,
  CORRECTED_ID,
  CORRECTED_TITLE,
  DEFAULT_PINS,
  DEPARTED_ID,
  type FixtureOptions,
  fixtureSources,
  gameFixture,
  type GameFixture,
  NOW,
  PLANTED,
  PUBLISHED_ID,
  TODAY,
  UNPUBLISHED_ID,
} from "./puzzledb-fixture";

const COMMITTED_PUZZLES = resolve(import.meta.dir, "../data/puzzles.json");
const TRACKED_ARCHIVE = resolve(import.meta.dir, "../data/archive/puzzles.sqlite");

/**
 * The committed puzzles a deploy box can give no Blueprint code, measured on
 * the committed files (134 of 138 get one). The tracked archive has no row of
 * their shape, so they arrive with no answer — and it does have rows with
 * their *ids*, which are other puzzles. If `bun run puzzles` or a sync moves
 * these, re-measure rather than loosen: the list is the evidence.
 */
const UNCODED = [7, 8, 109, 115];
const CODED_COUNT = 134;

/** The id `server/puzzles.ts` names: "fourtris mogs" in the file, "misplaced heart" in the archive. */
const DRIFTED_ID = 8;

const LISTING_COMMUNITY: Policy = { ...POLICY, publishCommunity: true };

const built: GameFixture[] = [];

afterAll(() => {
  for (const fixture of built) fixture.cleanup();
});

function fixture(options?: FixtureOptions): GameFixture {
  const made = gameFixture(options);
  built.push(made);
  return made;
}

function snapshotOf(game: GameFixture, clockToday = TODAY): GameSnapshot {
  const db = openGameDatabase(game.databasePath);
  try {
    return readSnapshot(db, clockToday, FIRST_TIERED_DAY);
  } finally {
    db.close();
  }
}

/** The game's own load, over exactly what a build is handed. */
function loadLikeTheGame(sources: DatasetSources, snapshot: GameSnapshot): PuzzleArchive {
  return PuzzleArchive.load(
    sources.puzzlesPath,
    { timeZone: sources.timeZone },
    snapshot.accepted,
    snapshot.overrides,
    trackedAnswers(sources.trackedArchivePath),
    snapshot.published,
  );
}

function listed(dataset: Dataset, id: number): SitePuzzle {
  const puzzle = dataset.puzzleById.get(id);
  if (!puzzle) throw new Error(`puzzle ${id} is not listed`);
  return puzzle;
}

function shown(dataset: Dataset, day: number): SiteDay {
  const found = dataset.dayByNumber.get(day);
  if (!found) throw new Error(`day ${day} is not shown`);
  return found;
}

function tiersOf(day: SiteDay): string[] {
  return day.deals.map((deal) => deal.tier);
}

function committedPuzzles(): Puzzle[] {
  return (JSON.parse(readFileSync(COMMITTED_PUZZLES, "utf8")) as { puzzles: Puzzle[] }).puzzles;
}

interface TrackedRow {
  id: number;
  title: string;
  board: string;
  queue: string;
  hold: string | null;
  target_attack: number;
  solution: string;
  source_puzzle: string;
  source_solution: string;
}

function trackedRows(): TrackedRow[] {
  const db = new Database(TRACKED_ARCHIVE, { readonly: true });
  try {
    return db
      .query<TrackedRow, []>(
        `SELECT id, title, board, queue, hold, target_attack, solution, source_puzzle, source_solution
           FROM archive_puzzles ORDER BY id`,
      )
      .all();
  } finally {
    db.close();
  }
}

function shapeOfRow(row: TrackedRow): string {
  return shapeKey({
    board: JSON.parse(row.board) as Puzzle["board"],
    queue: JSON.parse(row.queue) as Puzzle["queue"],
    hold: row.hold as Puzzle["hold"],
    targetAttack: row.target_attack,
  });
}

/** The snapshot with one published row rewritten, the way a different sync would have left it. */
function withPublished(snapshot: GameSnapshot, change: (puzzle: Puzzle) => Puzzle): GameSnapshot {
  return {
    ...snapshot,
    published: snapshot.published.map((puzzle) => (puzzle.id === PUBLISHED_ID ? change(puzzle) : puzzle)),
  };
}

function withoutRequirement(puzzle: Puzzle): Puzzle {
  const { requiredClears: _undecided, ...rest } = puzzle;
  return rest;
}

/** One cell of the download, straight from the file rather than from the JSON. */
function cellOf(dataset: Dataset, id: number, column: string): unknown {
  const db = Database.deserialize(dataset.sqlite, { readonly: true });
  try {
    const cell = db.query<{ value: unknown }, [number]>(
      `SELECT "${column}" AS value FROM puzzles WHERE id = ?1`,
    );
    return cell.get(id)?.value;
  } finally {
    db.close();
  }
}

interface AnswerEntry {
  readonly id: number;
  readonly solution: readonly SolutionStep[];
}

/** A box with its own `data/solutions.json`, which wins over the tracked archive's answers. */
function writeSolutions(game: GameFixture, entries: readonly AnswerEntry[]): void {
  const beside = join(dirname(game.puzzlesPath), "solutions.json");
  writeFileSync(beside, JSON.stringify({ solutions: entries }));
}

let game: GameFixture;
let sources: DatasetSources;
let snapshot: GameSnapshot;
let dataset: Dataset;

beforeAll(() => {
  game = fixture();
  sources = fixtureSources(game);
  snapshot = snapshotOf(game);
  dataset = buildDataset(snapshot, sources, NOW);
});

/** The shared snapshot, built again with its published row changed. */
function rebuiltWith(change: (puzzle: Puzzle) => Puzzle): Dataset {
  return buildDataset(withPublished(snapshot, change), sources, NOW);
}

describe("what players are dealt", () => {
  test("lists exactly what PuzzleArchive.load serves from the same inputs, community puzzles aside", () => {
    const served = loadLikeTheGame(sources, snapshot)
      .puzzles.filter((puzzle) => puzzle.id < COMMUNITY_ID_BASE)
      .toSorted((a, b) => a.id - b.id);

    expect(dataset.data.puzzles.map((puzzle) => puzzle.id)).toEqual(served.map((puzzle) => puzzle.id));
    for (const puzzle of served) {
      const site = listed(dataset, puzzle.id);
      expect({
        id: site.id,
        title: site.title,
        author: site.author,
        difficulty: site.difficulty,
        tier: site.tier,
        goal: site.goal,
        set: site.set,
        board: site.board,
        queue: site.queue,
        hold: site.hold,
        pieces: site.pieces,
        targetAttack: site.targetAttack,
        requiredClears: site.requiredClears,
        solution: site.solution,
      }).toEqual({
        id: puzzle.id,
        title: puzzle.title,
        author: puzzle.author,
        difficulty: puzzle.difficulty === 0 ? null : puzzle.difficulty,
        tier: dailyTierOf(puzzle),
        goal: puzzle.goal,
        set: puzzle.set,
        board: puzzle.board,
        queue: puzzle.queue,
        hold: puzzle.hold,
        pieces: pieceBudget(puzzle),
        targetAttack: puzzle.targetAttack,
        requiredClears: puzzle.requiredClears ?? null,
        solution: puzzle.solution?.length ? puzzle.solution : null,
      });
    }
  });

  test("applies officers' corrections", () => {
    const original = committedPuzzles().find((puzzle) => puzzle.id === CORRECTED_ID);

    expect(original?.title).not.toBe(CORRECTED_TITLE);
    expect(listed(dataset, CORRECTED_ID).title).toBe(CORRECTED_TITLE);
  });

  test("never lists an unpublished archive row, or a pending or rejected submission", () => {
    // With community puzzles listed, so the pending and rejected rows — which
    // share the accepted one's board — would have every chance to appear.
    const listing = buildDataset(snapshot, sources, NOW, LISTING_COMMUNITY);
    const written = listing.data.puzzles.filter((puzzle) => puzzle.id >= COMMUNITY_ID_BASE);
    const everything = JSON.stringify(listing.data);

    expect(listing.puzzleById.has(UNPUBLISHED_ID)).toBe(false);
    expect(written.map((puzzle) => puzzle.id)).toEqual([COMMUNITY_ID]);
    expect(PLANTED.filter((value) => everything.includes(value))).toEqual([]);
  });

  test("lists a published row with its own Blueprint codes", () => {
    const own = { puzzle: "own-puzzle-code", solution: "own-answer-code" };
    const site = listed(rebuiltWith((puzzle) => ({ ...puzzle, source: own })), PUBLISHED_ID);

    expect(site.source).toEqual(own);
    expect(site.puzzleUrl).toBe(blueprintLink(own.puzzle));
    expect(site.solutionUrl).toBe(blueprintLink(own.solution));
    // And as the fixture published it, with the sync's codes for the row.
    expect(listed(dataset, PUBLISHED_ID).source).toEqual(snapshot.published[0]?.source ?? null);
  });

  test("passes community puzzles into load and then leaves them out", () => {
    // load's checks run over the whole accepted list: two accepted puzzles
    // claiming one id stop the build, under a policy that lists neither.
    const twin = snapshot.accepted[0];
    expect(twin?.id).toBe(COMMUNITY_ID);
    const clashing: GameSnapshot = { ...snapshot, accepted: [...snapshot.accepted, twin!] };

    expect(() => buildDataset(clashing, sources, NOW)).toThrow(/Two puzzles claim id/);
    expect(dataset.puzzleById.has(COMMUNITY_ID)).toBe(false);
    expect(dataset.data.puzzles.every((puzzle) => puzzle.id < COMMUNITY_ID_BASE)).toBe(true);
  });

  test("lists community puzzles, and shows their ids in history, when the policy is on", () => {
    const listing = buildDataset(snapshot, sources, NOW, LISTING_COMMUNITY);

    expect(listed(listing, COMMUNITY_ID)).toMatchObject({ title: COMMUNITY_TITLE, author: COMMUNITY_AUTHOR });
    expect(shown(listing, TODAY - 2).deals).toContainEqual({ tier: "hard", puzzleId: COMMUNITY_ID });
  });

  test("lends a player's puzzle none of the club's Blueprint codes, though it has a club puzzle's shape", () => {
    // The fixture copied #141's board, queue, hold, target and answer, so a
    // lookup by shape alone would hand the player's puzzle the club's codes.
    const listing = buildDataset(snapshot, sources, NOW, LISTING_COMMUNITY);
    const community = listed(listing, COMMUNITY_ID);
    const club = listed(listing, PUBLISHED_ID);

    expect(shapeKey(community)).toBe(shapeKey(club));
    expect(community.solution).toEqual(club.solution);
    expect(club.puzzleUrl).not.toBeNull();
    expect(community.source).toBeNull();
    expect(community.puzzleUrl).toBeNull();
    expect(community.solutionUrl).toBeNull();
  });

  test("throws on a malformed puzzles.json, so the refresher keeps the last good dataset", () => {
    const broken = fixture();
    const read = snapshotOf(broken);

    writeFileSync(broken.puzzlesPath, "{ this is not json");
    expect(() => buildDataset(read, fixtureSources(broken), NOW)).toThrow(/Could not read/);

    writeFileSync(broken.puzzlesPath, JSON.stringify({ puzzles: [] }));
    expect(() => buildDataset(read, fixtureSources(broken), NOW)).toThrow(/contains no puzzles/);
  });
});

describe("the mapping", () => {
  test("turns an unrated 0 into null, as /api/public does", () => {
    const unrated = committedPuzzles().filter((puzzle) => puzzle.difficulty === 0);
    const rated = committedPuzzles().find((puzzle) => puzzle.id === CORRECTED_ID);

    expect(unrated.length).toBeGreaterThan(0);
    for (const puzzle of unrated) {
      expect(listed(dataset, puzzle.id).difficulty).toBeNull();
      expect(cellOf(dataset, puzzle.id, "difficulty")).toBeNull();
    }
    expect(rated?.difficulty).toBeGreaterThan(0);
    expect(listed(dataset, CORRECTED_ID).difficulty).toBe(rated!.difficulty);
  });

  test("keeps undecided, decided-none and a real requirement apart", () => {
    const requirement = snapshot.published[0]?.requiredClears;
    const undecided = rebuiltWith(withoutRequirement);
    const none = rebuiltWith((puzzle) => ({ ...puzzle, requiredClears: [] }));

    expect(requirement?.length).toBeGreaterThan(0);
    expect(listed(undecided, PUBLISHED_ID).requiredClears).toBeNull();
    expect(listed(none, PUBLISHED_ID).requiredClears).toEqual([]);
    expect(listed(dataset, PUBLISHED_ID).requiredClears).toEqual(requirement!);
    // And so in the download: NULL, '[]' and the list.
    expect(cellOf(undecided, PUBLISHED_ID, "required_clears")).toBeNull();
    expect(cellOf(none, PUBLISHED_ID, "required_clears")).toBe("[]");
    expect(JSON.parse(String(cellOf(dataset, PUBLISHED_ID, "required_clears")))).toEqual(requirement!);
  });

  test("reports no answer as null rather than as an empty list", () => {
    // A deploy box has no answer for a puzzle whose shape the tracked archive lacks.
    for (const id of UNCODED) expect(listed(dataset, id).solution).toBeNull();

    // An empty list on a row is no answer either. The target moves, so the
    // tracked archive's answer for the row's old shape cannot fill it back in.
    const emptied = rebuiltWith((puzzle) => ({
      ...puzzle,
      solution: [],
      requiredClears: [],
      targetAttack: puzzle.targetAttack + 1,
    }));
    expect(listed(emptied, PUBLISHED_ID).solution).toBeNull();
    expect(cellOf(emptied, PUBLISHED_ID, "solution")).toBeNull();
  });

  test("gives the tier a puzzle is dealt in now, and pieces counting the held piece", () => {
    // A correction re-rates the first tiered day's easy puzzle: it is an
    // extreme now, and the day it was dealt still shows it as that day's easy.
    const easy = DEFAULT_PINS.find((pin) => pin.day === FIRST_TIERED_DAY && pin.tier === "easy")!;
    const rerating = { ...snapshot.overrides[0]!, puzzleId: easy.puzzleId, title: null, difficulty: 11 };
    const rerated: GameSnapshot = { ...snapshot, overrides: [...snapshot.overrides, rerating] };
    const moved = buildDataset(rerated, sources, NOW);

    expect(listed(dataset, easy.puzzleId).tier).toBe("easy");
    expect(listed(moved, easy.puzzleId).tier).toBe("extreme");
    expect(shown(moved, FIRST_TIERED_DAY).deals).toContainEqual({ tier: "easy", puzzleId: easy.puzzleId });

    expect(dataset.data.puzzles.some((puzzle) => puzzle.hold !== null)).toBe(true);
    for (const puzzle of dataset.data.puzzles) {
      expect(puzzle.pieces).toBe(puzzle.queue.length + (puzzle.hold === null ? 0 : 1));
    }
  });

  test("fills Blueprint codes from the tracked archive by shape, for the committed puzzles a deploy box serves", () => {
    // The tracked archive's rule, read independently: id order, first row of a shape wins.
    const byShape = new Map<string, TrackedRow>();
    for (const row of trackedRows()) {
      const shape = shapeOfRow(row);
      if (!byShape.has(shape)) byShape.set(shape, row);
    }
    const committed = committedPuzzles().map((puzzle) => listed(dataset, puzzle.id));
    const coded = committed.filter((puzzle) => puzzle.puzzleUrl !== null);
    const uncoded = committed.filter((puzzle) => puzzle.puzzleUrl === null);

    expect(uncoded.map((puzzle) => puzzle.id)).toEqual(UNCODED);
    expect(coded.length).toBe(CODED_COUNT);
    for (const puzzle of coded) {
      const row = byShape.get(shapeKey(puzzle));
      expect(row).toBeDefined();
      expect(puzzle.source).toEqual({ puzzle: row!.source_puzzle, solution: row!.source_solution });
      expect(puzzle.puzzleUrl).toBe(blueprintLink(row!.source_puzzle));
      expect(puzzle.solutionUrl).toBe(blueprintLink(row!.source_solution));
      // The answer the page steps through is the one the codes play.
      expect(puzzle.solution).toEqual(JSON.parse(row!.solution));
    }
  });

  test("fills them only when the tracked answer is the one served", () => {
    const box = fixture();
    const site = listed(dataset, CORRECTED_ID);
    const answer = site.solution!;
    expect(site.puzzleUrl).not.toBeNull();

    // This box's own solutions.json answers the puzzle differently, and wins.
    writeSolutions(box, [{ id: CORRECTED_ID, solution: answer.toReversed() }]);
    const other = listed(buildDataset(snapshotOf(box), fixtureSources(box), NOW), CORRECTED_ID);
    expect(other.solution).toEqual(answer.toReversed());
    expect(other.source).toBeNull();
    expect(other.puzzleUrl).toBeNull();
    expect(other.solutionUrl).toBeNull();

    // The same answer from that file keeps them.
    writeSolutions(box, [{ id: CORRECTED_ID, solution: answer }]);
    const same = listed(buildDataset(snapshotOf(box), fixtureSources(box), NOW), CORRECTED_ID);
    expect(same.puzzleUrl).toBe(site.puzzleUrl);
    expect(same.solutionUrl).toBe(site.solutionUrl);
  });

  test("never matches codes by id", () => {
    const rows = new Map(trackedRows().map((row) => [row.id, row]));

    for (const id of UNCODED) {
      // The tracked archive has a row with this id, codes and all: another puzzle.
      expect(rows.get(id)?.source_puzzle).toBeTruthy();
      expect(listed(dataset, id).source).toBeNull();
      expect(listed(dataset, id).puzzleUrl).toBeNull();
      expect(listed(dataset, id).solutionUrl).toBeNull();
    }
    expect(listed(dataset, DRIFTED_ID).title).not.toBe(rows.get(DRIFTED_ID)?.title);
  });

  test("costs only the links, said once, when the tracked archive cannot be read", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const notADatabase = join(game.dir, "not-a-database.sqlite");
      writeFileSync(notADatabase, "this is not a database");

      expect(trackedCodes(notADatabase).size).toBe(0);
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringMatching(/^\[puzzledb\] could not read Blueprint codes from .*not-a-database\.sqlite: /),
      ]);

      // A build goes on without them: nothing borrows a code, the published row keeps its own.
      const unlinked = buildDataset(snapshot, { ...sources, trackedArchivePath: notADatabase }, NOW);
      const borrowed = unlinked.data.puzzles.filter(
        (puzzle) => puzzle.id !== PUBLISHED_ID && puzzle.source !== null,
      );
      expect(borrowed).toEqual([]);
      expect(listed(unlinked, PUBLISHED_ID).source).toEqual(listed(dataset, PUBLISHED_ID).source);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("history", () => {
  test("shows three tiers before FIRST_EXTREME_DAY even when an extreme row was added later, and four after", () => {
    expect(game.pins.some((pin) => pin.day === FIRST_TIERED_DAY + 1 && pin.tier === "extreme")).toBe(true);
    expect(tiersOf(shown(dataset, FIRST_TIERED_DAY))).toEqual(["easy", "medium", "hard"]);
    expect(tiersOf(shown(dataset, FIRST_TIERED_DAY + 1))).toEqual(["easy", "medium", "hard"]);
    expect(tiersOf(shown(dataset, FIRST_EXTREME_DAY))).toEqual([...DAILY_TIERS]);
  });

  test("judges a day's tiers by the policy it is handed", () => {
    const earlier: Policy = { ...POLICY, firstExtremeDay: FIRST_TIERED_DAY + 1 };
    const judged = buildDataset(snapshot, sources, NOW, earlier);

    expect(tiersOf(shown(judged, FIRST_TIERED_DAY))).toEqual(["easy", "medium", "hard"]);
    expect(tiersOf(shown(judged, FIRST_TIERED_DAY + 1))).toEqual([...DAILY_TIERS]);
  });

  test("names a day's player-written deal by tier alone, with its id withheld", () => {
    const ids = dataset.data.days.flatMap((day) => day.deals.map((deal) => deal.puzzleId));

    expect(shown(dataset, TODAY - 2).deals).toContainEqual({ tier: "hard", puzzleId: null });
    expect(ids.filter((id) => id !== null && id >= COMMUNITY_ID_BASE)).toEqual([]);
  });

  test("keeps a club id that has left the archive", () => {
    expect(dataset.puzzleById.has(DEPARTED_ID)).toBe(false);
    expect(shown(dataset, TODAY - 1).deals).toContainEqual({ tier: "medium", puzzleId: DEPARTED_ID });
  });

  test("puts tiers in daily order and dates each day on the club's calendar", () => {
    // SQLite returns the rows in byte order — easy, extreme, hard, medium.
    expect(tiersOf(shown(dataset, FIRST_EXTREME_DAY))).toEqual(["easy", "medium", "hard", "extreme"]);
    expect(dataset.data.days.map((day) => day.day)).toEqual([
      FIRST_TIERED_DAY,
      FIRST_TIERED_DAY + 1,
      FIRST_EXTREME_DAY,
      TODAY - 2,
      TODAY - 1,
    ]);
    for (const day of dataset.data.days) {
      expect(day.date).toBe(dateOfDay(day.day));
      expect(tiersOf(day)).toEqual(DAILY_TIERS.filter((tier) => tiersOf(day).includes(tier)));
    }
  });

  test("omits a finished day with nothing shown", () => {
    const pins: DayPin[] = [
      { day: FIRST_TIERED_DAY, tier: "easy", puzzleId: CORRECTED_ID },
      // Only a top-up, on a day dealt before extreme began.
      { day: FIRST_TIERED_DAY + 1, tier: "extreme", puzzleId: CORRECTED_ID },
      // A slot that is no daily tier at all.
      { day: FIRST_EXTREME_DAY, tier: "legacy", puzzleId: CORRECTED_ID },
      // Today, so every day above has finished.
      { day: TODAY, tier: "easy", puzzleId: CORRECTED_ID },
    ];
    const quiet = fixture({ pins });
    const sparse = buildDataset(snapshotOf(quiet), fixtureSources(quiet), NOW);

    expect(sparse.data.days.map((day) => day.day)).toEqual([FIRST_TIERED_DAY]);
    expect(sparse.dayByNumber.has(FIRST_TIERED_DAY + 1)).toBe(false);
    expect(sparse.dayByNumber.has(FIRST_EXTREME_DAY)).toBe(false);
  });
});

describe("about", () => {
  test("says when it was built, where history starts and the newest finished day it shows", () => {
    expect(dataset.data.about).toEqual({
      schema: SCHEMA_VERSION,
      builtAt: new Date(NOW).toISOString(),
      firstDay: FIRST_TIERED_DAY,
      throughDay: TODAY - 1,
    });
    expect(dataset.builtAt).toBe(NOW);
  });

  test("has no newest day while no day has finished", () => {
    const empty = fixture({ pins: [] });
    const nothing = buildDataset(snapshotOf(empty), fixtureSources(empty), NOW);

    expect(nothing.data.days).toEqual([]);
    expect(nothing.data.about.throughDay).toBeNull();
  });
});

describe("the dataset", () => {
  test("is frozen, and its maps index exactly what it lists", () => {
    const corrected = dataset.data.puzzles.find((puzzle) => puzzle.id === CORRECTED_ID);

    expect(Object.isFrozen(dataset)).toBe(true);
    expect(Object.isFrozen(dataset.data)).toBe(true);
    expect(Object.isFrozen(dataset.data.puzzles)).toBe(true);
    expect(Object.isFrozen(corrected)).toBe(true);
    expect(Object.isFrozen(corrected?.board)).toBe(true);
    expect(Object.isFrozen(dataset.data.days[0]?.deals)).toBe(true);
    expect([...dataset.puzzleById.keys()]).toEqual(dataset.data.puzzles.map((puzzle) => puzzle.id));
    expect([...dataset.dayByNumber.keys()]).toEqual(dataset.data.days.map((day) => day.day));
    expect(dataset.puzzleById.get(CORRECTED_ID)).toBe(corrected!);
  });

  test("serves as JSON exactly the data it holds", () => {
    expect(JSON.parse(new TextDecoder().decode(dataset.json))).toEqual(dataset.data);
  });
});
