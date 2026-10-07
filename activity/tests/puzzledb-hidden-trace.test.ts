/**
 * What a player who chose "Hide me on db.tetrisatuci.org" leaves on the site.
 *
 * The owner's decision is that their results stay — a board with a hole in it
 * would misstate everybody else's rank — but say "a player", and that nothing
 * identifies them: not their name, not a stable public id, not a page. The
 * honest test of "nothing identifies them" is a comparison, so this builds the
 * site twice from one database that differs in a single cell, the hidden
 * player's `site_hidden`, and checks that the difference is exactly their
 * label: every row of theirs is still there with the value and rank it
 * earned, unlabelled, and no other byte the site serves moved except where a
 * rank follows from the name sort.
 *
 * Then the things a comparison cannot see on its own. Their rows must carry no
 * column that ties them together — the fixture gives their two hand-ins
 * different values in every column but the player, so any column the site
 * added to link them would show up equal — and an all-time row of theirs has
 * no `detail`. A name holding a Discord-shaped number is hidden the same way.
 * A hide must reach the site at its next rebuild, which the refresher starts
 * only when the snapshot's hash moves. And the order of rows nobody can tell
 * apart must not follow the Discord ids SQLite groups by, which a build over
 * the same people with their ids handed out in reverse proves byte for byte.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { buildDataset } from "../puzzledb/server/dataset";
import { FIRST_TIERED_DAY, POLICY } from "../puzzledb/server/policy";
import { openGameDatabase, readSnapshot } from "../puzzledb/server/snapshot";
import type { Dataset, GameSnapshot } from "../puzzledb/server/types";
import {
  bodyPathFor,
  type PlayerRef,
  type SiteDayBody,
  type SiteLeaderboardsBody,
  type SitePlayerBody,
  type SitePuzzleBody,
  STANDING_BOARDS,
} from "../puzzledb/wire";
import type { SiteAlternatesBody } from "../puzzledb/wire-alternates";
import type { SitePlayersBody } from "../puzzledb/wire-profiles";
import { fixtureSources, gameFixture, type GameFixture, LINES, NOW, PLAYERS, SERVERS, TODAY } from "./puzzledb-fixture";

const PRIVATE = { ...POLICY, hiddenServerKeys: new Set([SERVERS.quiet.key]) };
const HIDDEN = PLAYERS.hidden;

interface Build {
  readonly snapshot: GameSnapshot;
  readonly dataset: Dataset;
}

const fixtures: GameFixture[] = [];
let hidden: Build;
let shown: Build;

function buildFrom(game: GameFixture, path = game.databasePath): Build {
  const db = openGameDatabase(path);
  try {
    const snapshot = readSnapshot(db, TODAY, FIRST_TIERED_DAY);
    return { snapshot, dataset: buildDataset(snapshot, fixtureSources(game), NOW, PRIVATE) };
  } finally {
    db.close();
  }
}

function fixture(reversedIds = false): GameFixture {
  const made = gameFixture({ journal: "delete", reversedIds });
  fixtures.push(made);
  return made;
}

beforeAll(() => {
  const game = fixture();
  hidden = buildFrom(game);
  // The same database with one cell changed: the hidden player chose to be shown.
  const flipped = join(game.dir, "flipped.sqlite");
  copyFileSync(game.databasePath, flipped);
  const db = new Database(flipped, { readwrite: true });
  try {
    db.run("UPDATE players SET site_hidden = 0 WHERE id = ?1", [HIDDEN.id]);
  } finally {
    db.close();
  }
  shown = buildFrom(game, flipped);
});

afterAll(() => {
  for (const made of fixtures) made.cleanup();
});

function decoded(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function served(dataset: Dataset): string[] {
  return [decoded(dataset.json), Buffer.from(dataset.sqlite).toString("latin1"), ...[...dataset.bodies.values()].map(decoded)];
}

function body<T>(dataset: Dataset, path: string): T {
  const bytes = dataset.bodies.get(path);
  if (!bytes) throw new Error(`no body at ${path}`);
  return JSON.parse(decoded(bytes)) as T;
}

/** A row as the hidden build should hold it: the hidden player's label gone, and their detail with it. */
function unlabelled<T extends { player: PlayerRef; detail?: number | null }>(row: T): T {
  if (row.player?.key !== HIDDEN.key) return row;
  return "detail" in row ? { ...row, player: null, detail: null } : { ...row, player: null };
}

/** Rows as a multiset, without the rank: ranks may move where the name sort put the player. */
function rowsOf(rows: readonly { rank?: number }[]): string[] {
  return rows.map(({ rank: _rank, ...row }) => JSON.stringify(row)).sort();
}

describe("a player who hid", () => {
  test("is in no byte the site serves, by name or by key, though the same build with them shown is", () => {
    expect(served(hidden.dataset).filter((text) => text.includes(HIDDEN.name) || text.includes(HIDDEN.key))).toEqual([]);
    expect(served(shown.dataset).some((text) => text.includes(HIDDEN.name))).toBe(true);
    expect(served(shown.dataset).some((text) => text.includes(HIDDEN.key))).toBe(true);
  });

  test("has no entry in the index and no body, exactly like a key nobody holds", () => {
    const path = `/data/player/${HIDDEN.key}.json`;

    expect(hidden.dataset.data.players.map((player) => player.key)).not.toContain(HIDDEN.key);
    expect(hidden.dataset.bodies.has(path)).toBe(false);
    expect(shown.dataset.bodies.has(path)).toBe(true);
  });

  test("leaves every row they earned, unlabelled, and changes no other row", () => {
    for (const day of hidden.dataset.data.days) {
      const path = `/data/day/${day.day}.json`;
      const [was, now] = [body<SiteDayBody>(shown.dataset, path), body<SiteDayBody>(hidden.dataset, path)];
      expect(rowsOf(now.tiers)).toEqual(rowsOf(was.tiers.map(unlabelled)));
      expect(rowsOf(now.rush)).toEqual(rowsOf(was.rush.map(unlabelled)));
      expect(Object.keys(now.boards).sort()).toEqual(Object.keys(was.boards).sort());
      for (const scope of Object.keys(was.boards)) {
        expect(rowsOf(now.boards[scope]!)).toEqual(rowsOf(was.boards[scope]!.map(unlabelled)));
      }
    }
    const boardsOf = (build: Build) => body<SiteLeaderboardsBody>(build.dataset, "/data/leaderboards.json").boards;
    const [was, now] = [boardsOf(shown), boardsOf(hidden)];
    for (const board of STANDING_BOARDS) {
      for (const scope of Object.keys(was[board])) {
        expect(rowsOf(now[board][scope]!)).toEqual(rowsOf(was[board][scope]!.map(unlabelled)));
      }
    }
  });

  test("moves no other player's page, and no puzzle's but for the label on a fastest solve", () => {
    for (const player of hidden.dataset.data.players) {
      const path = `/data/player/${player.key}.json`;
      expect(decoded(hidden.dataset.bodies.get(path)!)).toBe(decoded(shown.dataset.bodies.get(path)!));
    }
    for (const puzzle of hidden.dataset.data.puzzles) {
      const path = `/data/puzzle/${puzzle.id}.json`;
      const [was, now] = [body<SitePuzzleBody>(shown.dataset, path), body<SitePuzzleBody>(hidden.dataset, path)];
      const fastest = was.stats?.fastest?.key === HIDDEN.key ? null : (was.stats?.fastest ?? null);
      expect(now.lines).toEqual(was.lines);
      expect(now.stats).toEqual(was.stats === null ? null : { ...was.stats, fastest });
    }
  });

  test("leaves rows that share no value but the server they were played in", () => {
    const theirs = body<SiteDayBody>(shown.dataset, `/data/day/${TODAY - 1}.json`).tiers
      .concat(body<SiteDayBody>(shown.dataset, `/data/day/${TODAY - 2}.json`).tiers)
      .filter((row) => row.player?.key === HIDDEN.key)
      .map(({ player: _player, rank: _rank, ...row }) => row);
    const [first, second] = theirs as unknown as [Record<string, unknown>, Record<string, unknown>];

    expect(theirs).toHaveLength(2);
    // Rank is a place on a board, not a value of theirs, and is left out.
    expect(Object.keys(first).filter((column) => first[column] === second[column])).toEqual([]);
  });

  test("has no detail on any all-time row, so no two of their rows can be matched by it", () => {
    const boards = body<SiteLeaderboardsBody>(hidden.dataset, "/data/leaderboards.json").boards;
    const anonymous = Object.values(boards).flatMap((scopes) => Object.values(scopes).flat()).filter((row) => row.player === null);

    expect(anonymous.length).toBeGreaterThan(0);
    expect(anonymous.filter((row) => row.detail !== null)).toEqual([]);
  });

  test("moves no byte of the solves feed's steering: their solves are counted either way, and named in neither", () => {
    const path = bodyPathFor({ kind: "solves" })!;

    expect(decoded(hidden.dataset.bodies.get(path)!)).toBe(decoded(shown.dataset.bodies.get(path)!));
  });

  test("moves no byte of the alternates list: a line carries no finder, so the line they found is listed either way", () => {
    const path = bodyPathFor({ kind: "alternates" })!;
    const listed = body<SiteAlternatesBody>(hidden.dataset, path).lines.map((line) => line.puzzleId);

    // The hidden player's own line is in it, so a list that dropped it would be caught here.
    expect(listed).toContain(LINES.hidden.puzzleId);
    expect(decoded(hidden.dataset.bodies.get(path)!)).toBe(decoded(shown.dataset.bodies.get(path)!));
  });

  test("takes exactly their own row out of the players table, and moves no other", () => {
    const rowsOf = (build: Build) => body<SitePlayersBody>(build.dataset, bodyPathFor({ kind: "players" })!).rows;
    const theirs = rowsOf(shown).filter((row) => row.key === HIDDEN.key);

    expect(theirs).toHaveLength(1);
    expect(rowsOf(hidden)).toEqual(rowsOf(shown).filter((row) => row.key !== HIDDEN.key));
  });

  test("leaves their cleared list nowhere, though the same build with them shown prints it on their page", () => {
    const clearedOf = (build: Build) =>
      build.dataset.data.players.map((player) => body<SitePlayerBody>(build.dataset, `/data/player/${player.key}.json`).cleared);

    // #6 is the one puzzle only the hidden player cleared.
    expect(clearedOf(hidden).flat()).not.toContain(6);
    expect(body<SitePlayerBody>(shown.dataset, `/data/player/${HIDDEN.key}.json`).cleared).toEqual([6]);
    const fromDownload = Database.deserialize(hidden.dataset.sqlite, { readonly: true });
    try {
      expect(fromDownload.query("SELECT puzzle_id FROM player_clears WHERE puzzle_id = 6").all()).toEqual([]);
    } finally {
      fromDownload.close();
    }
  });

  test("reaches the site at the next rebuild: the flip moves the snapshot the refresher hashes", () => {
    expect(Bun.hash(JSON.stringify(hidden.snapshot))).not.toBe(Bun.hash(JSON.stringify(shown.snapshot)));
  });
});

describe("a name holding a Discord-shaped number", () => {
  test("is hidden like a player who chose to be, and its server is unnamed", () => {
    for (const build of [hidden, shown]) {
      const text = served(build.dataset);
      expect(text.filter((each) => each.includes(PLAYERS.digitRun.name) || each.includes(PLAYERS.digitRun.key))).toEqual([]);
      expect(text.filter((each) => each.includes(SERVERS.digitRun.name!))).toEqual([]);
      expect(build.dataset.bodies.has(`/data/player/${PLAYERS.digitRun.key}.json`)).toBe(false);
      expect(build.dataset.data.servers).toContainEqual({ key: SERVERS.digitRun.key, name: null });
    }
  });
});

describe("rows nobody can tell apart", () => {
  test("come out in the same order whichever person holds the lowest Discord id", () => {
    const reversed = buildFrom(fixture(true)).dataset;

    expect(Buffer.from(reversed.sqlite).equals(Buffer.from(hidden.dataset.sqlite))).toBe(true);
    expect(decoded(reversed.json)).toBe(decoded(hidden.dataset.json));
    expect([...reversed.bodies.keys()]).toEqual([...hidden.dataset.bodies.keys()]);
    for (const [path, bytes] of reversed.bodies) expect(decoded(bytes)).toBe(decoded(hidden.dataset.bodies.get(path)!));
  });
});
