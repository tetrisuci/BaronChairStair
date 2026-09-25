/**
 * A published puzzle reaches players without a restart, and nobody mid-game
 * can tell it happened.
 *
 * The second half is the one that matters. A restart would drop every duel's
 * socket, so the pool is swapped inside the running process instead — and a
 * running process has players holding today's prompts, ranked rush tickets that
 * re-derive their forty puzzles when handed in, and boards they are halfway
 * through. Every block below is one of those, checked after a reload.
 *
 * Against a database and a copy of the club's file of its own, never the shared
 * server's: growing that store's pool would change what every later test file
 * is dealt.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishArchive, upsertArchive } from "../server/archive-rows";
import { reloadInPlace } from "../server/archive-reload";
import { Store } from "../server/db";
import { PuzzleArchive } from "../server/puzzles";
import { DaySchedule, pastDaysOf } from "../server/schedule";
import { DAILY_TIERS, dailyTierOf, type DailyTier } from "../shared/daily";
import type { Puzzle } from "../shared/puzzle";

let dir: string;
let clubPath: string;
let club: Puzzle[];
let store: Store;
let archive: PuzzleArchive;
let schedule: DaySchedule;

/** The archive as `server/index.ts` loads it, from this test's own sources. */
function loadFrom(from: Store, path = clubPath): PuzzleArchive {
  return PuzzleArchive.load(
    path,
    {},
    from.acceptedPuzzles(),
    from.overridesFor(),
    new Map(),
    from.publishedArchive(),
  );
}

/** A server start, in the order `server/index.ts` does it. */
function start(): void {
  store = new Store(join(dir, "daily.sqlite"));
  archive = loadFrom(store);
  store.pinPastDays(pastDaysOf(archive));
  schedule = new DaySchedule(archive, store);
}

function reload(load = () => loadFrom(store)) {
  return reloadInPlace({ archive, schedule, store, load });
}

/** A new puzzle for a tier: a real board from the file under an id it never had. */
function fresh(id: number, tier: DailyTier, over: Partial<Puzzle> = {}): Puzzle {
  const model = club.find((puzzle) => dailyTierOf(puzzle) === tier)!;
  return { ...model, id, title: `new ${tier} ${id}`, solution: [], ...over };
}

function publish(...puzzles: Puzzle[]): void {
  for (const puzzle of puzzles) upsertArchive(store.archiveReader, puzzle, Date.now(), "a test");
  publishArchive(store.archiveReader, puzzles.map((puzzle) => puzzle.id), "a test", Date.now());
}

/** Several new puzzles in every tier: enough to move any derivation that reads the pool. */
function aBatchInEveryTier(): Puzzle[] {
  return DAILY_TIERS.flatMap((tier, t) =>
    [0, 1, 2, 3, 4].map((n) => fresh(5000 + t * 10 + n, tier)),
  );
}

const today = () => archive.currentDay();
/** What the archive's own rotation deals for a day, ignoring anything pinned. */
const derived = (day: number): Record<DailyTier, number> => ({
  easy: archive.forTier(day, "easy").id,
  medium: archive.forTier(day, "medium").id,
  hard: archive.forTier(day, "hard").id,
  extreme: archive.forTier(day, "extreme").id,
});
const idsOf = (day: number) =>
  Object.fromEntries(DAILY_TIERS.map((tier) => [tier, schedule.forDay(day).puzzles[tier].id]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "archive-reload-"));
  clubPath = join(dir, "puzzles.json");
  club = JSON.parse(readFileSync("data/puzzles.json", "utf8")).puzzles as Puzzle[];
  writeFileSync(clubPath, JSON.stringify({ puzzles: club }));
  start();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a published puzzle", () => {
  test("is served after a reload, by the same archive object every route holds", () => {
    const before = archive.puzzles.length;
    publish(fresh(5001, "easy"));

    const result = reload();

    expect(result.added).toEqual([5001]);
    expect(archive.get(5001)?.title).toBe("new easy 5001");
    expect(archive.puzzles).toHaveLength(before + 1);
    expect(result.puzzles).toBe(before + 1);
  });

  test("is served at the next start too, laid over the file", () => {
    publish(fresh(5001, "easy"));
    store.close();

    start();

    expect(archive.get(5001)?.title).toBe("new easy 5001");
  });

  test("replaces the file's entry for its id at the next start", () => {
    const model = club[0]!;
    publish({ ...model, title: "renamed on the sheet", solution: [] });
    store.close();

    start();

    expect(archive.get(model.id)?.title).toBe("renamed on the sheet");
  });

  test("one the engine cannot play is skipped, not fatal, at a reload or a start", () => {
    const broken = fresh(5002, "easy", { board: ["not a row"] });
    publish(broken);

    expect(() => reload()).not.toThrow();
    expect(archive.get(5002)).toBeUndefined();

    store.close();
    expect(() => start()).not.toThrow();
    expect(archive.get(5002)).toBeUndefined();
  });

  test("is not played until it is published", () => {
    upsertArchive(store.archiveReader, fresh(5003, "easy"), Date.now(), "a test");

    reload();

    expect(archive.get(5003)).toBeUndefined();
  });
});

describe("nobody mid-game can tell", () => {
  test("today's four puzzles do not move", () => {
    const held = idsOf(today());
    publish(...aBatchInEveryTier());

    reload();

    expect(idsOf(today())).toEqual(held);
  });

  test("today's rush pool does not move, so a ticket in flight is scored on what it was dealt", () => {
    const pool = schedule.rushPoolFor(today()).map((puzzle) => puzzle.id);
    const batch = aBatchInEveryTier();
    publish(...batch);

    reload();

    expect(schedule.rushPoolFor(today()).map((puzzle) => puzzle.id)).toEqual(pool);
    // The control: the new puzzles really are rush material, so a pool derived
    // afresh would have taken them.
    expect(batch.some((puzzle) => pool.includes(puzzle.id))).toBe(false);
    expect(archive.puzzles.some((puzzle) => puzzle.id === batch[0]!.id)).toBe(true);
  });

  test("a day nobody had asked for yet is pinned from the pool it was live under", () => {
    // Today, unasked: what a quiet day looks like to a server that has been up
    // since before it began.
    store.archiveReader.run("DELETE FROM day_puzzles WHERE day = ?1", [today()]);
    store.archiveReader.run("DELETE FROM day_rush WHERE day = ?1", [today()]);
    schedule.forget();
    const underOldPool = derived(today());
    publish(...aBatchInEveryTier());

    reload();

    expect(store.pinnedDay(today())).toEqual(underOldPool);
    // The control: left to derive from the grown pool, the day would have moved.
    expect(derived(today())).not.toEqual(underOldPool);
  });

  test("a board that changed on file is served as it was, title and all, until the next start", () => {
    publish(fresh(5004, "medium"));
    reload();
    const served = archive.get(5004)!;
    const otherBoard = club.find((puzzle) => puzzle.board.join() !== served.board.join())!;

    publish({ ...served, board: otherBoard.board, title: "a different puzzle now", solution: [] });
    const result = reload();

    expect(result.held).toEqual([5004]);
    expect(archive.get(5004)?.board).toEqual(served.board);
    expect(archive.get(5004)?.title).toBe(served.title);

    store.close();
    start();
    expect(archive.get(5004)?.board).toEqual(otherBoard.board);
    expect(archive.get(5004)?.title).toBe("a different puzzle now");
  });

  test("a corrected title on an unchanged board goes live at once", () => {
    publish(fresh(5005, "hard"));
    reload();

    publish({ ...archive.get(5005)!, title: "spelt properly", solution: [] });
    const result = reload();

    expect(result.held).toEqual([]);
    expect(archive.get(5005)?.title).toBe("spelt properly");
  });

  test("nothing being served is dropped, even when a source loses it", () => {
    const dropped = club.find((puzzle) => !Object.values(idsOf(today())).includes(puzzle.id))!;
    const trimmed = join(dir, "trimmed.json");
    writeFileSync(
      trimmed,
      JSON.stringify({ puzzles: club.filter((puzzle) => puzzle.id !== dropped.id) }),
    );

    const result = reload(() => loadFrom(store, trimmed));

    expect(result.kept).toEqual([dropped.id]);
    expect(archive.get(dropped.id)).toEqual(dropped);
  });

  test("a reload whose sources do not load leaves the running archive exactly as it was", () => {
    const before = archive.puzzles;

    expect(() =>
      reload(() => {
        throw new Error("the file is half-written");
      }),
    ).toThrow("half-written");
    expect(archive.puzzles).toBe(before);
  });
});
