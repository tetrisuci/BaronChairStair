/**
 * How the puzzle database turns what it read about players into public rows.
 *
 * Built from hand-written player snapshots laid over the fixture's puzzles and
 * days, so each case says exactly which rows went in. The snapshot's own SQL is
 * `puzzledb-snapshot-players.test.ts`'s business; this is the build: which
 * rows a finished day keeps, how they are ranked, what a player who hid still
 * contributes, and how every page's body is cut from the read-back database.
 *
 * Ranking is the part most easily got subtly wrong. The game breaks no ties
 * the site could repeat, and SQLite hands groups back in id order, so a stable
 * sort over the snapshot would publish snowflake order as rank. The rule is a
 * total order over published columns only — a board's own keys, then the name
 * (case-folded, a player who hid last), then every other column — so rows it
 * still cannot separate are byte-identical, and their order says nothing. The
 * test that builds the same rows in reverse and compares bytes is what holds it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildDataset } from "../puzzledb/server/dataset";
import { playerRows } from "../puzzledb/server/dataset-players";
import { FIRST_EXTREME_DAY, FIRST_TIERED_DAY, POLICY } from "../puzzledb/server/policy";
import { openGameDatabase, readSnapshot } from "../puzzledb/server/snapshot";
import type {
  Dataset,
  DatasetSources,
  GameSnapshot,
  PlayerSnapshot,
  Policy,
  SnapshotPlayer,
  SnapshotTierRun,
} from "../puzzledb/server/types";
import {
  ALL_SERVERS,
  type PlayerRef,
  STANDING_BOARDS,
  type SiteDayBody,
  type SiteLeaderboardsBody,
  type SitePlayerBody,
  type SitePuzzleBody,
} from "../puzzledb/wire";
import { COMMUNITY_ID, CORRECTED_ID, fixtureSources, gameFixture, type GameFixture, NOW, TODAY } from "./puzzledb-fixture";

const ALICE: SnapshotPlayer = { playerKey: "aaaaaaaaa2", name: "alice" };
const BOB: SnapshotPlayer = { playerKey: "bbbbbbbbb2", name: "Bob" };
const HIDDEN: SnapshotPlayer = { playerKey: null, name: null };
const CLUB = "sssssssss2";
const OTHER = "ttttttttt2";
const YESTERDAY = TODAY - 1;

const EMPTY: PlayerSnapshot = {
  cut: TODAY,
  tierRuns: [],
  dayBoards: [],
  rushRuns: [],
  rushRecords: [],
  dailyDays: [],
  cleared: [],
  clearedPuzzles: [],
  discoveries: [],
  lines: [],
  servers: [
    { key: CLUB, name: "Club" },
    { key: OTHER, name: "Quiet Other Server" },
  ],
};

let game: GameFixture;
let sources: DatasetSources;
let base: GameSnapshot;

beforeAll(() => {
  game = gameFixture({ journal: "delete" });
  sources = fixtureSources(game);
  const db = openGameDatabase(game.databasePath);
  try {
    base = readSnapshot(db, TODAY, FIRST_TIERED_DAY);
  } finally {
    db.close();
  }
});

afterAll(() => game.cleanup());

function build(players: Partial<PlayerSnapshot>, policy: Policy = POLICY): Dataset {
  return buildDataset({ ...base, players: { ...EMPTY, ...players } }, sources, NOW, policy);
}

function body<T>(dataset: Dataset, path: string): T {
  const bytes = dataset.bodies.get(path);
  if (!bytes) throw new Error(`no body at ${path}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function run(player: SnapshotPlayer, overrides: Partial<SnapshotTierRun>): SnapshotTierRun {
  return {
    ...player,
    day: YESTERDAY,
    tier: "easy",
    puzzleId: 50,
    solved: true,
    timeMs: 60_000,
    attack: 6,
    targetAttack: 6,
    serverKey: CLUB,
    ...overrides,
  };
}

const ref = (player: SnapshotPlayer): PlayerRef =>
  player.playerKey === null || player.name === null ? null : { key: player.playerKey, name: player.name };

describe("a finished day's tier boards", () => {
  test("rank solved first, then fastest, then the unsolved by attack, and publish attack on every row", () => {
    const dataset = build({
      tierRuns: [
        run(ALICE, { solved: false, timeMs: null, attack: 5, targetAttack: 8 }),
        run(BOB, { timeMs: 70_000 }),
        run(HIDDEN, { timeMs: 50_000 }),
        run(HIDDEN, { solved: false, timeMs: null, attack: 7, targetAttack: 8, serverKey: OTHER }),
      ],
    });

    const day = body<SiteDayBody>(dataset, `/data/day/${YESTERDAY}.json`);

    expect(day.tiers.map((row) => [row.rank, row.player, row.solved, row.timeMs, row.attack, row.targetAttack])).toEqual([
      [1, null, true, 50_000, 6, 6],
      [2, ref(BOB), true, 70_000, 6, 6],
      [3, null, false, null, 7, 8],
      [4, ref(ALICE), false, null, 5, 8],
    ]);
  });

  test("keep only the tiers the day showed, on the days the site shows", () => {
    const dataset = build({
      tierRuns: [
        run(ALICE, { day: FIRST_TIERED_DAY + 1, tier: "extreme", puzzleId: 3 }),
        run(ALICE, { day: FIRST_TIERED_DAY - 1, puzzleId: 37 }),
        run(ALICE, { day: FIRST_TIERED_DAY + 1, tier: "easy", puzzleId: 47 }),
      ],
    });

    const day = body<SiteDayBody>(dataset, `/data/day/${FIRST_TIERED_DAY + 1}.json`);

    expect(day.tiers.map((row) => row.tier)).toEqual(["easy"]);
    expect(dataset.bodies.has(`/data/day/${FIRST_TIERED_DAY - 1}.json`)).toBe(false);
  });

  test("blank a puzzle a player wrote, and give it no stats", () => {
    const dataset = build({ tierRuns: [run(ALICE, { day: TODAY - 2, tier: "hard", puzzleId: COMMUNITY_ID })] });

    expect(body<SiteDayBody>(dataset, `/data/day/${TODAY - 2}.json`).tiers[0]?.puzzleId).toBeNull();
    expect(body<SitePlayerBody>(dataset, `/data/player/${ALICE.playerKey}.json`).runs[0]?.puzzleId).toBeNull();
    expect(dataset.bodies.has(`/data/puzzle/${COMMUNITY_ID}.json`)).toBe(false);
  });

  test("name no server for a hand-in made outside any", () => {
    const dataset = build({ tierRuns: [run(ALICE, { serverKey: null })] });

    expect(body<SiteDayBody>(dataset, `/data/day/${YESTERDAY}.json`).tiers[0]?.serverKey).toBeNull();
    expect(dataset.data.servers).toEqual([]);
  });
});

describe("the order of rows a board cannot tell apart", () => {
  test("goes by case-folded name, then puts the players who hid last", () => {
    const dataset = build({
      tierRuns: [run(HIDDEN, {}), run(BOB, {}), run(ALICE, {})],
    });

    const tiers = body<SiteDayBody>(dataset, `/data/day/${YESTERDAY}.json`).tiers;

    expect(tiers.map((row) => row.player?.name ?? null)).toEqual(["alice", "Bob", null]);
  });

  test("separates two hidden rows by their other columns, so input order cannot show", () => {
    const rows = [
      run(HIDDEN, { serverKey: OTHER }),
      run(HIDDEN, { serverKey: CLUB }),
      run(HIDDEN, { serverKey: null }),
      run(ALICE, { timeMs: 50_000 }),
    ];
    const forward = build({ tierRuns: rows });
    const backward = build({ tierRuns: rows.toReversed() });

    expect(body<SiteDayBody>(forward, `/data/day/${YESTERDAY}.json`).tiers.map((row) => row.serverKey)).toEqual([
      CLUB,
      CLUB,
      OTHER,
      null,
    ]);
    expect(forward.sqlite).toEqual(backward.sqlite);
    expect(forward.bodies).toEqual(backward.bodies);
  });
});

describe("day boards", () => {
  test("rank each scope on its own, and mark a tier the day did not show as not dealt", () => {
    const marks = { easy: 2, medium: 1, hard: 0, extreme: 0 } as const;
    const dataset = build({
      dayBoards: [
        { ...ALICE, scope: ALL_SERVERS, day: FIRST_TIERED_DAY + 1, solved: 1, timeMs: 60_000, marks },
        { ...BOB, scope: ALL_SERVERS, day: FIRST_TIERED_DAY + 1, solved: 1, timeMs: 40_000, marks },
        { ...ALICE, scope: CLUB, day: FIRST_TIERED_DAY + 1, solved: 1, timeMs: 60_000, marks },
      ],
    });

    const day = body<SiteDayBody>(dataset, `/data/day/${FIRST_TIERED_DAY + 1}.json`);

    expect(Object.keys(day.boards).sort()).toEqual([ALL_SERVERS, CLUB].sort());
    expect(day.boards[ALL_SERVERS]!.map((row) => [row.rank, row.player?.name])).toEqual([[1, "Bob"], [2, "alice"]]);
    expect(day.boards[CLUB]!.map((row) => row.rank)).toEqual([1]);
    expect(day.boards[CLUB]![0]!.marks).toEqual({ easy: 2, medium: 1, hard: 0, extreme: null });
  });

  test("give every finished day a body, an empty one included", () => {
    const dataset = build({});

    for (const day of dataset.data.days) {
      const shown = body<SiteDayBody>(dataset, `/data/day/${day.day}.json`);
      expect(shown).toEqual({ builtAt: new Date(NOW).toISOString(), day: day.day, boards: { [ALL_SERVERS]: [] }, tiers: [], rush: [] });
    }
  });
});

describe("rush", () => {
  test("ranks a day's rushes by puzzles solved, then by time", () => {
    const dataset = build({
      rushRuns: [
        { ...ALICE, day: YESTERDAY, serverKey: CLUB, solved: 6, timeMs: 150_000 },
        { ...HIDDEN, day: YESTERDAY, serverKey: OTHER, solved: 7, timeMs: 170_000 },
        { ...BOB, day: YESTERDAY, serverKey: CLUB, solved: 6, timeMs: 140_000 },
      ],
    });

    const rush = body<SiteDayBody>(dataset, `/data/day/${YESTERDAY}.json`).rush;

    expect(rush.map((row) => [row.rank, row.player?.name ?? null, row.serverKey])).toEqual([
      [1, null, OTHER],
      [2, "Bob", CLUB],
      [3, "alice", CLUB],
    ]);
  });
});

describe("the all-time boards", () => {
  const snapshot: Partial<PlayerSnapshot> = {
    dailyDays: [
      { ...ALICE, days: [YESTERDAY, TODAY - 2, TODAY - 4], dailies: 5 },
      { ...HIDDEN, days: [TODAY - 3], dailies: 1 },
    ],
    cleared: [{ ...ALICE, count: 3 }, { ...HIDDEN, count: 0 }],
    discoveries: [{ ...BOB, count: 2 }, { ...HIDDEN, count: 1 }],
    rushRecords: [
      { ...ALICE, scope: ALL_SERVERS, solved: 7, timeMs: 170_000, day: YESTERDAY },
      { ...ALICE, scope: CLUB, solved: 7, timeMs: 170_000, day: YESTERDAY },
      { ...HIDDEN, scope: ALL_SERVERS, solved: 0, timeMs: 0, day: YESTERDAY },
    ],
  };

  test("carry each measure, with a detail only on a shown player's row and no zero", () => {
    const boards = body<SiteLeaderboardsBody>(build(snapshot), "/data/leaderboards.json").boards;
    const all = (board: keyof typeof boards) => boards[board][ALL_SERVERS]!.map((row) => [row.player?.name ?? null, row.value, row.detail]);

    expect(Object.keys(boards)).toEqual([...STANDING_BOARDS]);
    expect(all("dailies")).toEqual([["alice", 5, 3], [null, 1, null]]);
    // Alice's streak stands as of the newest finished day; the hidden player's ended days ago.
    expect(all("streak")).toEqual([["alice", 2, 2]]);
    expect(all("best_streak")).toEqual([["alice", 2, null], [null, 1, null]]);
    expect(all("cleared")).toEqual([["alice", 3, null]]);
    expect(all("discoveries")).toEqual([["Bob", 2, null], [null, 1, null]]);
    expect(boards.rush[ALL_SERVERS]!.map((row) => [row.value, row.timeMs, row.day])).toEqual([[7, 170_000, YESTERDAY]]);
    expect(Object.keys(boards.rush).sort()).toEqual([ALL_SERVERS, CLUB].sort());
  });

  test("keep fifty rows each", () => {
    const many = Array.from({ length: 60 }, (_, at) => ({ ...HIDDEN, count: at + 1 }));

    const boards = body<SiteLeaderboardsBody>(build({ cleared: many }), "/data/leaderboards.json").boards;

    expect(boards.cleared[ALL_SERVERS]!.length).toBe(50);
    expect(boards.cleared[ALL_SERVERS]![0]!.value).toBe(60);
  });

  test("give each shown player totals that agree with the boards", () => {
    const dataset = build({
      ...snapshot,
      rushRuns: [{ ...ALICE, day: YESTERDAY, serverKey: CLUB, solved: 7, timeMs: 170_000 }],
    });

    expect(body<SitePlayerBody>(dataset, `/data/player/${ALICE.playerKey}.json`).totals).toEqual({
      daysSolved: 3,
      dailies: 5,
      currentStreak: 2,
      bestStreak: 2,
      puzzlesCleared: 3,
      linesFound: 0,
      rushRuns: 1,
      rushBest: 7,
      rushBestMs: 170_000,
      rushBestDay: YESTERDAY,
    });
    expect(body<SitePlayerBody>(dataset, `/data/player/${BOB.playerKey}.json`).totals).toMatchObject({
      daysSolved: 0,
      linesFound: 2,
      rushBest: null,
      rushBestMs: null,
      rushBestDay: null,
    });
  });
});

/**
 * A player's page prints each hand-in's rank as a place — "2nd" — so it has to
 * be the rank the day's own board shows, where equal results share the better
 * one. The stored rank is a place in a total order that breaks ties by name,
 * which would give one of two tied players "3rd" for being later in the
 * alphabet, and change it when the other renamed or hid.
 */
describe("a player's ranks", () => {
  const CAROL: SnapshotPlayer = { playerKey: "ccccccccc2", name: "carol" };

  test("are the day board's ranks, with a tie shared and the next result after it", () => {
    const dataset = build({
      tierRuns: [
        run(HIDDEN, { timeMs: 50_000 }),
        run(BOB, {}),
        run(ALICE, {}),
        run(CAROL, { timeMs: 70_000 }),
        run(ALICE, { tier: "medium", puzzleId: 51, solved: false, timeMs: null, attack: 4, targetAttack: 8 }),
        run(BOB, { tier: "medium", puzzleId: 51, solved: false, timeMs: null, attack: 4, targetAttack: 8 }),
        run(CAROL, { tier: "medium", puzzleId: 51, solved: false, timeMs: null, attack: 3, targetAttack: 8 }),
      ],
      rushRuns: [
        { ...CAROL, day: YESTERDAY, serverKey: CLUB, solved: 6, timeMs: 150_000 },
        { ...BOB, day: YESTERDAY, serverKey: CLUB, solved: 6, timeMs: 150_000 },
        { ...ALICE, day: YESTERDAY, serverKey: OTHER, solved: 5, timeMs: 100_000 },
      ],
    });
    const ranks = (player: SnapshotPlayer) => {
      const page = body<SitePlayerBody>(dataset, `/data/player/${player.playerKey}.json`);
      return { runs: page.runs.map((row) => [row.tier, row.rank]), rush: page.rush.map((row) => row.rank) };
    };

    expect(ranks(ALICE)).toEqual({ runs: [["easy", 2], ["medium", 1]], rush: [3] });
    expect(ranks(BOB)).toEqual({ runs: [["easy", 2], ["medium", 1]], rush: [1] });
    expect(ranks(CAROL)).toEqual({ runs: [["easy", 4], ["medium", 3]], rush: [1] });
  });

  test("do not move when a tied player renames", () => {
    const tied = (bob: SnapshotPlayer) =>
      body<SitePlayerBody>(build({ tierRuns: [run(ALICE, {}), run(bob, {})] }), `/data/player/${ALICE.playerKey}.json`)
        .runs[0]?.rank;

    expect(tied(BOB)).toBe(1);
    expect(tied({ ...BOB, name: "Aaron" })).toBe(1);
  });
});

describe("players and servers", () => {
  test("list every shown player by name, with a body each, and nobody who hid", () => {
    const dataset = build({ tierRuns: [run(BOB, {}), run(ALICE, {}), run(HIDDEN, {})] });

    expect(dataset.data.players.map((player) => player.key)).toEqual([ALICE.playerKey!, BOB.playerKey!]);
    expect([...dataset.bodies.keys()].filter((path) => path.startsWith("/data/player/")).sort()).toEqual(
      [`/data/player/${ALICE.playerKey}.json`, `/data/player/${BOB.playerKey}.json`],
    );
  });

  test("list the servers some row names, by name, with the unnamed last", () => {
    const dataset = build({
      tierRuns: [run(ALICE, { serverKey: OTHER }), run(BOB, { serverKey: CLUB }), run(HIDDEN, { serverKey: "uuuuuuuuu2" })],
      servers: [...EMPTY.servers, { key: "uuuuuuuuu2", name: null }, { key: "vvvvvvvvv2", name: "Nobody played here" }],
    });

    expect(dataset.data.servers).toEqual([
      { key: CLUB, name: "Club" },
      { key: OTHER, name: "Quiet Other Server" },
      { key: "uuuuuuuuu2", name: null },
    ]);
  });

  test("print no name for a server on the hide list, and leave the others alone", () => {
    const dataset = build(
      { tierRuns: [run(ALICE, { serverKey: OTHER }), run(BOB, { serverKey: CLUB })] },
      { ...POLICY, hiddenServerKeys: new Set([OTHER]) },
    );

    expect(dataset.data.servers).toEqual([
      { key: CLUB, name: "Club" },
      { key: OTHER, name: null },
    ]);
    expect(new TextDecoder("latin1").decode(dataset.sqlite)).not.toContain("Quiet Other Server");
  });

  test("refuses to build when a seventeen-digit run reaches a name, whatever SQL let through", () => {
    const leaked = { playerKey: "ccccccccc2", name: "x12345678901234567" };

    expect(() => build({ tierRuns: [run(leaked, {})] })).toThrow(/seventeen/);
    expect(() => build({ tierRuns: [run(ALICE, {})], servers: [{ key: CLUB, name: "12345678901234567" }] })).toThrow(
      /seventeen/,
    );
  });

  test("refuses a key that is not shaped like one, which no page could be found by", () => {
    expect(() => build({ tierRuns: [run({ playerKey: "112233445566778899", name: "eve" }, {})] })).toThrow(/key/);
  });
});

describe("puzzles", () => {
  test("say how a listed puzzle went on finished days, with the median of its solves", () => {
    const dataset = build({
      tierRuns: [
        run(ALICE, { timeMs: 40_000 }),
        run(BOB, { timeMs: 70_000 }),
        run(HIDDEN, { timeMs: 50_000 }),
        run(HIDDEN, { timeMs: 90_000, serverKey: OTHER }),
        run(BOB, { day: TODAY - 2, tier: "easy", puzzleId: 50, solved: false, timeMs: null, attack: 2 }),
      ],
    });

    expect(body<SitePuzzleBody>(dataset, "/data/puzzle/50.json").stats).toEqual({
      handIns: 5,
      solves: 4,
      fastestMs: 40_000,
      medianMs: 60_000,
      fastest: ref(ALICE),
    });
  });

  test("give a puzzle no finished day dealt null stats, and an odd count its middle solve", () => {
    const dataset = build({ tierRuns: [run(HIDDEN, { timeMs: 50_000 }), run(BOB, { timeMs: 30_000 }), run(ALICE, { timeMs: 90_000 })] });

    expect(body<SitePuzzleBody>(dataset, "/data/puzzle/50.json").stats).toMatchObject({ medianMs: 50_000, fastest: ref(BOB) });
    expect(body<SitePuzzleBody>(dataset, `/data/puzzle/${CORRECTED_ID}.json`)).toEqual({
      builtAt: new Date(NOW).toISOString(),
      stats: null,
      lines: [],
    });
  });

  test("number each listed puzzle's lines in the order the snapshot gave, and drop an unlisted one's", () => {
    const step = { piece: "T" as const, cells: [[0, 0], [1, 0], [2, 0], [1, 1]] as [number, number][], clear: "tsd" as const, attack: 4 };
    const dataset = build({
      lines: [
        { puzzleId: 6, attack: 10, clears: ["tsd"], steps: [step] },
        { puzzleId: 6, attack: 12, clears: [], steps: [step, step] },
        { puzzleId: COMMUNITY_ID, attack: 9, clears: ["tsd"], steps: [step] },
      ],
    });

    expect(body<SitePuzzleBody>(dataset, "/data/puzzle/6.json").lines).toEqual([
      { position: 1, attack: 10, clears: ["tsd"], steps: [step] },
      { position: 2, attack: 12, clears: [], steps: [step, step] },
    ]);
    expect(dataset.bodies.has(`/data/puzzle/${COMMUNITY_ID}.json`)).toBe(false);
    const db = Database.deserialize(dataset.sqlite, { readonly: true });
    try {
      expect(db.query("SELECT DISTINCT puzzle_id AS id FROM lines").all()).toEqual([{ id: 6 }]);
    } finally {
      db.close();
    }
  });
});

describe("the puzzles each player cleared", () => {
  const scope = { policy: POLICY, days: new Set<number>(), listed: new Set([6, 50]) };
  const clear = (player: SnapshotPlayer, puzzleId: number) => ({ ...player, puzzleId });

  test("keep listed puzzles only, while the count stays whole, as the game counts it", () => {
    const dataset = build({
      cleared: [{ ...ALICE, count: 3 }],
      clearedPuzzles: [clear(ALICE, 50), clear(ALICE, COMMUNITY_ID), clear(ALICE, 9_999)],
    });
    const db = Database.deserialize(dataset.sqlite, { readonly: true });
    try {
      expect(db.query("SELECT player_key, puzzle_id FROM player_clears").all()).toEqual([
        { player_key: ALICE.playerKey, puzzle_id: 50 },
      ]);
      expect(db.query("SELECT puzzles_cleared FROM players").all()).toEqual([{ puzzles_cleared: 3 }]);
    } finally {
      db.close();
    }
  });

  test("come out by key, then puzzle, whatever order they went in", () => {
    const rows = playerRows({ ...EMPTY, clearedPuzzles: [clear(BOB, 6), clear(ALICE, 50), clear(ALICE, 6)] }, scope);

    expect(rows.playerClears).toEqual([
      [ALICE.playerKey!, 6],
      [ALICE.playerKey!, 50],
      [BOB.playerKey!, 6],
    ]);
  });

  test("refuse a clear that reached the build without a shown player, which SQL should have made impossible", () => {
    expect(() => playerRows({ ...EMPTY, clearedPuzzles: [clear(HIDDEN, 6)] }, scope)).toThrow(
      "A cleared puzzle reached the build without a shown player; refusing to publish it",
    );
  });

  test("refuse a name holding seventeen digits that only a clear carries", () => {
    const digits = { playerKey: "ddddddddd2", name: "x-12345678901234567" };

    expect(() => playerRows({ ...EMPTY, clearedPuzzles: [clear(digits, 6)] }, scope)).toThrow(/seventeen digits/);
  });

  test("give a name found only on a clear a players row, so the key resolves", () => {
    const rows = playerRows({ ...EMPTY, clearedPuzzles: [clear(BOB, 6)] }, scope);

    expect(rows.players.map((row) => [row[0], row[1]])).toEqual([[BOB.playerKey!, BOB.name!]]);
  });
});

describe("the download", () => {
  test("holds the boards it serves, read back from the same tables", () => {
    const dataset = build({ tierRuns: [run(ALICE, {}), run(HIDDEN, { timeMs: 10 })] });
    const db = Database.deserialize(dataset.sqlite, { readonly: true });
    try {
      const rows = db.query("SELECT rank, player_key, time_ms FROM tier_boards ORDER BY rank").all();
      expect(rows).toEqual([
        { rank: 1, player_key: null, time_ms: 10 },
        { rank: 2, player_key: ALICE.playerKey, time_ms: 60_000 },
      ]);
      expect(db.query("SELECT key, name FROM players").all()).toEqual([{ key: ALICE.playerKey, name: "alice" }]);
    } finally {
      db.close();
    }
  });

  test("is the leaderboards body even with nothing on any board", () => {
    const boards = body<SiteLeaderboardsBody>(build({}), "/data/leaderboards.json").boards;

    for (const board of STANDING_BOARDS) expect(boards[board]).toEqual({ [ALL_SERVERS]: [] });
  });

  test("starts extreme on the first extreme day", () => {
    const dataset = build({ tierRuns: [run(ALICE, { day: FIRST_EXTREME_DAY, tier: "extreme", puzzleId: 16 })] });

    expect(body<SiteDayBody>(dataset, `/data/day/${FIRST_EXTREME_DAY}.json`).tiers.map((row) => row.tier)).toEqual(["extreme"]);
  });
});
