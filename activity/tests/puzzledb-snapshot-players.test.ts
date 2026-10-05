/**
 * What the puzzle database reads about players, and where each read stops.
 *
 * `snapshot-players.ts` is the only code on the site that touches a player
 * table, so every promise the site makes about people starts here: a hidden
 * player, the guest, a player the game has not keyed and a name holding a
 * Discord-shaped number are all unlabelled *in SQL*, before any of it is a JS
 * value; nothing filed today, or on any later day, is read at all; and the
 * millisecond columns are cut at the game's own midnight, read from the game's
 * own record of its zone.
 *
 * The fixture is a real game database built by the game's writers, so these
 * read what production would hold. Where a case needs a row the fixture does
 * not have, the test edits a copy with plain SQL and says why.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { dayNumber, startOfDay } from "../shared/daily";
import { FIRST_EXTREME_DAY, FIRST_TIERED_DAY } from "../puzzledb/server/policy";
import { openGameDatabase, readSnapshot } from "../puzzledb/server/snapshot";
import { DIGITS17, LINE_DAY } from "../puzzledb/server/snapshot-players";
import type { PlayerSnapshot, SnapshotPlayer } from "../puzzledb/server/types";
import { ALL_SERVERS } from "../puzzledb/wire";
import {
  COMMUNITY_ID,
  CORRECTED_ID,
  type FixtureOptions,
  gameFixture,
  type GameFixture,
  LA,
  LINES,
  PLANTED,
  PLAYERS,
  SERVERS,
  TODAY,
  TODAY_MARKS,
} from "./puzzledb-fixture";

const built: GameFixture[] = [];

afterAll(() => {
  for (const fixture of built) fixture.cleanup();
});

function fixture(options?: FixtureOptions): GameFixture {
  const made = gameFixture({ journal: "delete", ...options });
  built.push(made);
  return made;
}

function playersOf(path: string, clockToday = TODAY): PlayerSnapshot {
  const db = openGameDatabase(path);
  try {
    return readSnapshot(db, clockToday, FIRST_TIERED_DAY).players;
  } finally {
    db.close();
  }
}

/** Edits a fixture's database as the game, or an older game, might have left it. */
function edit(game: GameFixture, sql: string, ...values: (string | number | null)[]): void {
  const db = new Database(game.databasePath, { readwrite: true });
  try {
    db.run(sql, values);
  } finally {
    db.close();
  }
}

const SHOWN = (role: "visible" | "unchosen"): SnapshotPlayer => ({
  playerKey: PLAYERS[role].key,
  name: PLAYERS[role].name,
});
const NOBODY: SnapshotPlayer = { playerKey: null, name: null };

function who(row: SnapshotPlayer): SnapshotPlayer {
  return { playerKey: row.playerKey, name: row.name };
}

const defaultGame = fixture();
const players = playersOf(defaultGame.databasePath);

describe("the cut", () => {
  test("is the earlier of the site's today and the newest pinned day, and nothing reaches it", () => {
    expect(players.cut).toBe(TODAY);
    for (const row of [...players.tierRuns, ...players.dayBoards, ...players.rushRuns, ...players.rushRecords]) {
      expect(row.day).toBeLessThan(TODAY);
    }
    for (const row of players.dailyDays) expect(Math.max(...row.days)).toBeLessThan(TODAY);
    const text = JSON.stringify(players);
    for (const mark of Object.values(TODAY_MARKS)) expect(text).not.toContain(String(mark));
  });

  test("falls to yesterday while nothing has pinned today, and takes yesterday's lines and clears with it", () => {
    const early = playersOf(fixture({ withoutToday: true }).databasePath);

    expect(early.cut).toBe(TODAY - 1);
    expect(early.tierRuns.map((run) => run.day).filter((day) => day >= TODAY - 1)).toEqual([]);
    expect(early.rushRuns).toEqual([]);
    expect(early.lines).toEqual([]);
    expect(early.cleared).toEqual([]);
    expect(early.clearedPuzzles).toEqual([]);
    expect(early.discoveries).toEqual([]);
  });

  test("cannot be pushed past the newest pinned day by a site clock running ahead", () => {
    const game = fixture({ withoutToday: true });

    expect(playersOf(game.databasePath, TODAY + 5).cut).toBe(TODAY - 1);
  });
});

describe("who a row belongs to", () => {
  test("labels a shown player's runs, including one who never chose, and nobody else's", () => {
    const labels = new Set(players.tierRuns.map((run) => JSON.stringify(who(run))));

    expect(labels).toEqual(
      new Set([SHOWN("visible"), SHOWN("unchosen"), NOBODY].map((player) => JSON.stringify(player))),
    );
    // The hidden player, the digit-run player and the guest each filed yesterday's easy.
    const unlabelledEasy = players.tierRuns.filter(
      (run) => run.day === TODAY - 1 && run.tier === "easy" && run.playerKey === null,
    );
    expect(unlabelledEasy.map((run) => run.timeMs).sort()).toEqual([58_730, 77_310, 99_990]);
  });

  test("unlabels a player the game never keyed, as an older build's insert leaves them", () => {
    const game = fixture();
    edit(game, "UPDATE players SET public_key = NULL WHERE id = ?1", PLAYERS.unchosen.id);

    const read = playersOf(game.databasePath);

    expect(read.tierRuns.filter((run) => run.name === PLAYERS.unchosen.name)).toEqual([]);
    expect(JSON.stringify(read)).not.toContain(PLAYERS.unchosen.name);
  });

  test("hides a name holding seventeen digits in a row, and shows one holding sixteen", () => {
    const game = fixture();
    const sixteen = "fixture-1234567890123456";
    const seventeen = "fixture-12345678901234567";
    edit(game, "UPDATE players SET username = ?1 WHERE id = ?2", sixteen, PLAYERS.visible.id);
    edit(game, "UPDATE players SET username = ?1 WHERE id = ?2", seventeen, PLAYERS.unchosen.id);

    const text = JSON.stringify(playersOf(game.databasePath));

    expect(text).toContain(sixteen);
    expect(text).not.toContain(seventeen);
    expect(text).not.toContain(PLAYERS.unchosen.key);
  });

  test("writes the seventeen-digit rule as one GLOB", () => {
    expect(DIGITS17).toBe(`*${"[0-9]".repeat(17)}*`);
  });

  test("lets no id, avatar, hidden name or hidden key reach JS", () => {
    const text = JSON.stringify(players);

    for (const value of PLANTED.filter((planted) => planted !== SERVERS.quiet.name)) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toMatch(/[0-9]{17}/);
  });
});

describe("the boards", () => {
  test("hands each tier run over with its attack, its server key, and a time only when solved", () => {
    const visible = players.tierRuns
      .filter((run) => run.playerKey === PLAYERS.visible.key && run.day === TODAY - 1)
      .map((run) => [run.tier, run.solved, run.timeMs, run.attack, run.targetAttack, run.serverKey]);

    expect(visible.sort()).toEqual(
      [
        ["easy", true, 64_250, 6, 6, SERVERS.club.key],
        ["hard", true, 131_500, 10, 10, SERVERS.unnamed.key],
        ["medium", false, null, 9, 8, SERVERS.club.key],
      ].sort(),
    );
    const outside = players.tierRuns.find((run) => run.playerKey === PLAYERS.unchosen.key && run.tier === "easy");
    expect(outside?.serverKey).toBeNull();
  });

  test("groups a day board in SQL, once across every server and once per server", () => {
    const boards = players.dayBoards.filter((row) => row.day === TODAY - 1 && row.playerKey === PLAYERS.visible.key);
    const byScope = Object.fromEntries(boards.map((row) => [row.scope, row]));

    expect(Object.keys(byScope).sort()).toEqual([ALL_SERVERS, SERVERS.club.key, SERVERS.unnamed.key].sort());
    expect(byScope[ALL_SERVERS]).toMatchObject({
      solved: 2,
      timeMs: 64_250 + 131_500,
      marks: { easy: 2, medium: 1, hard: 2, extreme: 0 },
    });
    expect(byScope[SERVERS.club.key]).toMatchObject({ solved: 1, timeMs: 64_250, marks: { easy: 2, medium: 1, hard: 0 } });
    expect(byScope[SERVERS.unnamed.key]).toMatchObject({ solved: 1, timeMs: 131_500, marks: { easy: 0, hard: 2 } });
    // A hand-in outside any server is on the all-servers board and on no server's.
    const outside = players.dayBoards.filter((row) => row.playerKey === PLAYERS.unchosen.key && row.day === TODAY - 1);
    expect(outside.map((row) => row.scope).sort()).toEqual([ALL_SERVERS, SERVERS.unnamed.key].sort());
  });

  test("keeps two hidden players' day rows apart, though neither is labelled", () => {
    const easyOnly = players.dayBoards.filter(
      (row) => row.scope === ALL_SERVERS && row.day === TODAY - 1 && row.playerKey === null,
    );
    expect(easyOnly.map((row) => row.timeMs).sort()).toEqual([58_730, 77_310, 99_990]);
  });

  test("reads yesterday's rushes and each player's best before the cut, per scope", () => {
    expect(players.rushRuns.map((run) => [run.solved, run.timeMs, run.serverKey]).sort()).toEqual(
      [[5, 141_200, SERVERS.unnamed.key], [6, 155_550, SERVERS.club.key], [7, 170_000, SERVERS.club.key]].sort(),
    );
    const visible = players.rushRecords.filter((row) => row.playerKey === PLAYERS.visible.key);
    expect(visible.map((row) => [row.scope, row.solved, row.timeMs, row.day]).sort()).toEqual(
      [[ALL_SERVERS, 7, 170_000, TODAY - 1], [SERVERS.club.key, 7, 170_000, TODAY - 1]].sort(),
    );
    expect(players.rushRecords.filter((row) => row.playerKey === null).map((row) => row.scope).sort()).toEqual(
      [ALL_SERVERS, SERVERS.club.key].sort(),
    );
  });
});

describe("the totals", () => {
  test("lists each player's solved days newest first, with every daily they solved", () => {
    const visible = players.dailyDays.find((row) => row.playerKey === PLAYERS.visible.key);

    expect(visible?.days).toEqual([TODAY - 1, TODAY - 2, FIRST_EXTREME_DAY]);
    expect(visible?.dailies).toBe(4 + 1 + 2);
  });

  test("counts first clears before the game's midnight, not the one just after it", () => {
    const count = (key: string | null) => players.cleared.filter((row) => row.playerKey === key).map((row) => row.count);

    // The visible player first cleared #51 61 seconds into today: not counted.
    // Their player-written puzzle is: the game counts any puzzle, listed or not.
    expect(count(PLAYERS.visible.key)).toEqual([2]);
    expect(count(PLAYERS.unchosen.key)).toEqual([1]);
    expect(count(null)).toEqual([1]);
  });

  test("counts discoveries as the game does, voided included, today's and the uncredited left out", () => {
    const counts = players.discoveries.map((row) => [row.playerKey, row.count]);

    expect(counts.sort()).toEqual(
      [[PLAYERS.visible.key, 1], [PLAYERS.unchosen.key, 1], [null, 1]].sort(),
    );
  });
});

describe("the puzzles each player cleared", () => {
  const listOf = (read: PlayerSnapshot, key: string | null) =>
    read.clearedPuzzles.filter((row) => row.playerKey === key).map((row) => row.puzzleId);

  test("lists each shown player's first clears before the game's midnight, by key then puzzle", () => {
    expect(listOf(players, PLAYERS.visible.key)).toEqual([CORRECTED_ID, COMMUNITY_ID]);
    expect(listOf(players, PLAYERS.unchosen.key)).toEqual([50]);
    // #51 was first cleared 61 seconds into today.
    expect(players.clearedPuzzles.map((row) => row.puzzleId)).not.toContain(51);
    const keys = players.clearedPuzzles.map((row) => row.playerKey!);
    expect(keys).toEqual(keys.toSorted());
    for (const row of players.clearedPuzzles) {
      expect(Object.keys(row).sort()).toEqual(["name", "playerKey", "puzzleId"]);
    }
  });

  test("never lists a hidden player's clears, not even unlabelled: no row of theirs, and no row for #6", () => {
    const withheld = [PLAYERS.hidden, PLAYERS.digitRun, PLAYERS.guest].map((player) => player.key);

    expect(players.clearedPuzzles.filter((row) => row.playerKey === null)).toEqual([]);
    expect(players.clearedPuzzles.filter((row) => withheld.includes(row.playerKey!))).toEqual([]);
    expect(players.clearedPuzzles.map((row) => row.puzzleId)).not.toContain(6);
    // The positive control: their clear is still counted, unlabelled.
    expect(players.cleared.filter((row) => row.playerKey === null).map((row) => row.count)).toEqual([1]);
  });

  test("lists nothing for a player the game never keyed", () => {
    const game = fixture();
    edit(game, "UPDATE players SET public_key = NULL WHERE id = ?1", PLAYERS.unchosen.id);

    const read = playersOf(game.databasePath);

    expect(read.clearedPuzzles.map((row) => row.puzzleId)).not.toContain(50);
    expect(read.clearedPuzzles.every((row) => row.playerKey === PLAYERS.visible.key)).toBe(true);
  });
});

describe("the lines", () => {
  test("publishes the live credited lines of finished days, by puzzle, with nothing about who or when", () => {
    expect(players.lines.map((line) => line.puzzleId)).toEqual([LINES.hidden.puzzleId, LINES.visible.puzzleId]);
    for (const line of players.lines) {
      expect(Object.keys(line).sort()).toEqual(["attack", "clears", "puzzleId", "steps"]);
      expect(line.clears).toEqual(["tsd", "tsd"]);
      for (const step of line.steps) expect(Object.keys(step).sort()).toEqual(["attack", "cells", "clear", "piece"]);
    }
    expect(JSON.stringify(players.lines)).not.toContain("planted");
  });

  test("orders a puzzle's lines by the day they were filed before the order they were filed in", () => {
    const game = fixture();
    // The enumerator's line on #6 was filed after the hidden player's. Credit it
    // to a player and move it two days earlier: it must now come first.
    const earlier = startOfDay(TODAY - 2, { timeZone: LA }) + 3_000;
    edit(
      game,
      "UPDATE puzzle_solutions SET source = 'player', found_by = ?1, found_at = ?2, attack = 13 WHERE source = 'enumerated'",
      PLAYERS.visible.id,
      earlier,
    );

    const lines = playersOf(game.databasePath).lines.filter((line) => line.puzzleId === LINES.hidden.puzzleId);

    expect(lines.map((line) => line.attack)).toEqual([13, LINES.hidden.attack]);
  });

  test("drops a clear name the game does not know, from the line and from its steps", () => {
    const game = fixture();
    edit(
      game,
      `UPDATE puzzle_solutions SET clears = '["tsd","bogus"]',
              placements = '[{"piece":"T","cells":[[0,0],[1,0],[2,0],[1,1]],"clear":"bogus","attack":2}]'
        WHERE puzzle_id = ?1 AND source = 'player'`,
      CORRECTED_ID,
    );

    const line = playersOf(game.databasePath).lines.find((one) => one.puzzleId === CORRECTED_ID);

    expect(line?.clears).toEqual(["tsd"]);
    expect(line?.steps[0]?.clear).toBeNull();
  });
});

describe("servers", () => {
  test("reads every server by its key, with no name for a long number or for one never signed in from", () => {
    expect(players.servers.toSorted((a, b) => a.key.localeCompare(b.key))).toEqual(
      [
        { key: SERVERS.club.key, name: SERVERS.club.name },
        { key: SERVERS.unnamed.key, name: null },
        { key: SERVERS.digitRun.key, name: null },
        { key: SERVERS.quiet.key, name: SERVERS.quiet.name },
      ].toSorted((a, b) => a.key.localeCompare(b.key)),
    );
  });
});

describe("the game's zone", () => {
  /** What LINE_DAY makes of one moment, in SQL, as the snapshot binds it. */
  function lineDay(foundAt: number, lo: number, last: number): number {
    const db = new Database(":memory:");
    try {
      const starts = JSON.stringify(Array.from({ length: last - lo + 1 }, (_, at) => startOfDay(lo + at, { timeZone: LA })));
      const row = db
        .query<{ day: number }, Record<string, string | number>>(`SELECT ${LINE_DAY} AS day FROM (SELECT $found AS found_at) s`)
        .get({ $found: foundAt, $starts: starts, $lo: lo });
      return row!.day;
    } finally {
      db.close();
    }
  }

  test("names a moment's day as the game's calendar does, across the night the clocks go back", () => {
    // 2026-11-01 is when Los Angeles leaves daylight time: day 305.
    const lo = 300;
    for (const day of [303, 304, 305, 306]) {
      const start = startOfDay(day, { timeZone: LA });
      expect(lineDay(start, lo, 310)).toBe(day);
      expect(lineDay(start - 1, lo, 310)).toBe(day - 1);
      expect(lineDay(start + 23 * 3_600_000, lo, 310)).toBe(dayNumber(start + 23 * 3_600_000, { timeZone: LA }));
    }
  });

  test("puts a line filed before history started before its first day", () => {
    expect(lineDay(startOfDay(250, { timeZone: LA }), 260, 270)).toBeLessThan(260);
  });

  test("refuses a database with no recorded zone, saying how to fix it", () => {
    const game = fixture();
    edit(game, "DELETE FROM site_facts WHERE name = 'time_zone'");

    expect(() => playersOf(game.databasePath)).toThrow(
      "the game has not recorded its time zone; start the game on this code first",
    );
  });

  test("lets SQLite's own 'no such table' through for a game not yet on this code", () => {
    const game = fixture();
    edit(game, "DROP TABLE site_facts");

    expect(() => playersOf(game.databasePath)).toThrow(/no such table/);
  });

  test("hands back a snapshot nobody can edit", () => {
    expect(Object.isFrozen(players)).toBe(true);
    expect(Object.isFrozen(players.tierRuns[0])).toBe(true);
    expect(Object.isFrozen(players.dayBoards[0]?.marks)).toBe(true);
    expect(Object.isFrozen(players.lines[0]?.steps[0])).toBe(true);
  });
});
