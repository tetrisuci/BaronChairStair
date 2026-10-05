/**
 * The game's half of db.tetrisatuci.org's identity: the opaque keys, the
 * server names, the opt-out and the zone fact, and the boot migration that
 * puts them on a database that has been taking real runs for months.
 *
 * The migration is the part that has to be proven against an *old* database
 * rather than reasoned about, because the live one is exactly that: players
 * with no key, servers known only by an id in `runs`, and no `site_facts` at
 * all. Every case below that says "old" seeds that shape by hand and then
 * opens a Store on it, the way a deploy does.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type RunResult, type RushResult } from "../server/db";
import { newPublicKey, withFreshKey } from "../server/site-identity";
import { dayNumber, startOfDay } from "../shared/daily";
import { GUEST_ID, PUBLIC_KEY_PATTERN } from "../shared/site";

const ZONE = "America/Los_Angeles";
/** Noon in Irvine on an ordinary day: far from either midnight. */
const NOW = Date.UTC(2026, 8, 15, 19, 0, 0);
const TODAY = dayNumber(NOW, { timeZone: ZONE });

let dir: string;
let path: string;

/**
 * The tables the migration reads, in the shape the live database has before
 * this deploy: no `site_hidden`, no `public_key`, no `guilds`, no `site_facts`.
 */
const OLD_SCHEMA = `
CREATE TABLE players (
  id TEXT PRIMARY KEY, username TEXT NOT NULL, avatar_url TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE runs (
  day INTEGER NOT NULL, player_id TEXT NOT NULL REFERENCES players(id), guild_id TEXT,
  puzzle_id INTEGER NOT NULL, solved INTEGER NOT NULL, attack INTEGER NOT NULL,
  target_attack INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
  total_ms INTEGER NOT NULL DEFAULT 0, resets INTEGER NOT NULL,
  pieces_placed INTEGER NOT NULL, clears TEXT NOT NULL, created_at INTEGER NOT NULL,
  slot TEXT NOT NULL DEFAULT 'legacy',
  PRIMARY KEY (day, player_id, slot)
);
CREATE TABLE rush_runs (
  day INTEGER NOT NULL, player_id TEXT NOT NULL REFERENCES players(id), guild_id TEXT,
  solved INTEGER NOT NULL, attempted INTEGER NOT NULL, skips_used INTEGER NOT NULL,
  time_to_last_ms INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (day, player_id)
);
`;

function seedOld(): void {
  const db = new Database(path, { create: true });
  db.run(OLD_SCHEMA);
  const oldPlayers: readonly (readonly [string, string])[] = [
    ["p-ada", "Ada"],
    ["p-bo", "Bo"],
    ["p-cy", "Cy"],
  ];
  for (const [id, name] of oldPlayers) {
    db.run("INSERT INTO players (id, username, avatar_url, updated_at) VALUES (?, ?, NULL, 1)", [
      id,
      name,
    ]);
  }
  const run = `INSERT INTO runs (day, player_id, guild_id, puzzle_id, solved, attack, target_attack,
                 duration_ms, total_ms, resets, pieces_placed, clears, created_at, slot)
               VALUES (?, ?, ?, 7, 1, 4, 4, 500, 1000, 0, 4, '[]', 1, 'easy')`;
  db.run(run, [10, "p-ada", "g-runs"]);
  db.run(run, [11, "p-ada", "g-both"]);
  db.run(run, [11, "p-bo", null]);
  const rush = `INSERT INTO rush_runs (day, player_id, guild_id, solved, attempted, skips_used,
                  time_to_last_ms, elapsed_ms, created_at)
                VALUES (?, ?, ?, 3, 4, 0, 9000, 10000, 1)`;
  db.run(rush, [10, "p-bo", "g-rush"]);
  db.run(rush, [11, "p-cy", "g-both"]);
  db.close();
}

/** Reads the database beside the Store, as the site would: a second handle. */
function peek<T>(read: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function open(timeZone: string | undefined = ZONE): Store {
  return new Store(path, undefined, timeZone === undefined ? {} : { timeZone });
}

const ada = { id: "p-ada", username: "Ada", avatarUrl: null };
const run = (solved = true): RunResult => ({
  solved,
  attack: 4,
  targetAttack: 4,
  durationMs: 500,
  totalMs: 1000,
  resets: 0,
  piecesPlaced: 4,
  clears: [],
});
const rush: RushResult = {
  solved: 3,
  attempted: 4,
  skipsUsed: 0,
  timeToLastSolveMs: 9000,
  elapsedMs: 10000,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "site-identity-"));
  path = join(dir, "daily.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("migrating a database from before the site", () => {
  test("an old database gains both columns, both tables and the key index", () => {
    seedOld();
    open().close();
    peek((db) => {
      const columns = db
        .query<{ name: string }, []>("PRAGMA table_info(players)")
        .all()
        .map((c) => c.name);
      expect(columns).toContain("site_hidden");
      expect(columns).toContain("public_key");
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((t) => t.name);
      expect(tables).toContain("guilds");
      expect(tables).toContain("site_facts");
      const index = db
        .query<{ unique: number }, []>("PRAGMA index_list(players)")
        .all()
        .find((i) => (i as unknown as { name: string }).name === "players_public_key");
      expect(index?.unique).toBe(1);
    });
  });

  test("every player is keyed, uniquely, in the public alphabet, and nobody is hidden", () => {
    seedOld();
    open().close();
    const rows = peek((db) =>
      db
        .query<{ public_key: string | null; site_hidden: number | null }, []>(
          "SELECT public_key, site_hidden FROM players",
        )
        .all(),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.public_key).toMatch(PUBLIC_KEY_PATTERN);
      // Deliberately no backfill: NULL is "never chose", which reads as shown.
      expect(row.site_hidden).toBeNull();
    }
    expect(new Set(rows.map((r) => r.public_key)).size).toBe(3);
  });

  test("the servers come from both runs and rush runs, keyed, and with no name yet", () => {
    seedOld();
    open().close();
    const guilds = peek((db) =>
      db
        .query<{ guild_id: string; public_key: string; name: string | null }, []>(
          "SELECT guild_id, public_key, name FROM guilds ORDER BY guild_id",
        )
        .all(),
    );
    expect(guilds.map((g) => g.guild_id)).toEqual(["g-both", "g-runs", "g-rush"]);
    for (const guild of guilds) {
      expect(guild.public_key).toMatch(PUBLIC_KEY_PATTERN);
      expect(guild.name).toBeNull();
    }
    expect(new Set(guilds.map((g) => g.public_key)).size).toBe(3);
  });

  test("the game's zone is written at boot, and rewritten when it changes", () => {
    seedOld();
    open(ZONE).close();
    const zone = () =>
      peek((db) =>
        db
          .query<{ value: string }, []>("SELECT value FROM site_facts WHERE name = 'time_zone'")
          .get(),
      );
    expect(zone()?.value).toBe(ZONE);
    open("America/New_York").close();
    expect(zone()?.value).toBe("America/New_York");
  });

  test("a store opened with no zone leaves the recorded one alone", () => {
    // A maintenance tool opens the Store bare. It knows nothing about the zone
    // the game runs in, and must not overwrite the game's answer with a guess.
    seedOld();
    open(ZONE).close();
    open(undefined).close();
    const zone = peek((db) =>
      db.query<{ value: string }, []>("SELECT value FROM site_facts WHERE name = 'time_zone'").get(),
    );
    expect(zone?.value).toBe(ZONE);
  });

  test("a second boot changes nothing", () => {
    seedOld();
    const everything = () =>
      peek((db) => ({
        players: db.query("SELECT id, public_key, site_hidden FROM players ORDER BY id").all(),
        guilds: db.query("SELECT * FROM guilds ORDER BY guild_id").all(),
        facts: db.query("SELECT * FROM site_facts ORDER BY name").all(),
        version: db.query("PRAGMA schema_version").get(),
      }));
    open().close();
    const first = everything();
    open().close();
    expect(everything()).toEqual(first);
  });

  test("a player written by older code after a rollback is keyed at the next boot", () => {
    seedOld();
    open().close();
    const db = new Database(path);
    db.run("INSERT INTO players (id, username, avatar_url, updated_at) VALUES ('p-dee','Dee',NULL,1)");
    db.close();
    open().close();
    const key = peek((d) =>
      d
        .query<{ public_key: string | null }, []>("SELECT public_key FROM players WHERE id = 'p-dee'")
        .get(),
    );
    expect(key?.public_key).toMatch(PUBLIC_KEY_PATTERN);
  });
});

describe("upsertPlayer", () => {
  test("a new player is keyed on first write", () => {
    const store = open();
    try {
      store.upsertPlayer(ada);
      expect(store.siteIdentity.visibility(ada.id, NOW).playerKey).toMatch(PUBLIC_KEY_PATTERN);
    } finally {
      store.close();
    }
  });

  test("a later sign-in keeps the key and the choice to hide", () => {
    const store = open();
    try {
      store.upsertPlayer(ada);
      const key = store.siteIdentity.visibility(ada.id, NOW).playerKey;
      store.siteIdentity.setHidden(ada.id, true);
      store.upsertPlayer({ ...ada, username: "Ada Lovelace" });
      const row = peek((db) =>
        db
          .query<{ public_key: string; site_hidden: number; username: string }, [string]>(
            "SELECT public_key, site_hidden, username FROM players WHERE id = ?1",
          )
          .get(ada.id),
      );
      expect(row).toEqual({ public_key: key!, site_hidden: 1, username: "Ada Lovelace" });
    } finally {
      store.close();
    }
  });
});

describe("recordGuild", () => {
  const updatedAt = () =>
    peek((db) =>
      db
        .query<{ name: string | null; updated_at: number; public_key: string }, []>(
          "SELECT name, updated_at, public_key FROM guilds WHERE guild_id = 'g-one'",
        )
        .get(),
    );

  test("a server first seen at sign-in is keyed and named", () => {
    const store = open();
    try {
      store.siteIdentity.recordGuild("g-one", "Fixture Club", 100);
      const row = updatedAt();
      expect(row?.name).toBe("Fixture Club");
      expect(row?.public_key).toMatch(PUBLIC_KEY_PATTERN);
      expect(store.siteIdentity.serverKey("g-one")).toBe(row!.public_key);
    } finally {
      store.close();
    }
  });

  test("the same name again writes nothing", () => {
    const store = open();
    try {
      store.siteIdentity.recordGuild("g-one", "Fixture Club", 100);
      store.siteIdentity.recordGuild("g-one", "Fixture Club", 200);
      expect(updatedAt()?.updated_at).toBe(100);
    } finally {
      store.close();
    }
  });

  test("a new name replaces the old one and keeps the key", () => {
    const store = open();
    try {
      store.siteIdentity.recordGuild("g-one", "Fixture Club", 100);
      const key = updatedAt()!.public_key;
      store.siteIdentity.recordGuild("g-one", "Renamed Club", 200);
      expect(updatedAt()).toEqual({ name: "Renamed Club", updated_at: 200, public_key: key });
    } finally {
      store.close();
    }
  });

  test("a sign-in that brought no name never erases a known one", () => {
    const store = open();
    try {
      store.siteIdentity.recordGuild("g-one", "Fixture Club", 100);
      store.siteIdentity.recordGuild("g-one", null, 200);
      expect(updatedAt()).toMatchObject({ name: "Fixture Club", updated_at: 100 });
    } finally {
      store.close();
    }
  });

  test("a server nobody has signed in from since the deploy has a key and no name", () => {
    seedOld();
    const store = open();
    try {
      expect(store.siteIdentity.serverKey("g-runs")).toMatch(PUBLIC_KEY_PATTERN);
      expect(store.siteIdentity.serverKey("g-never")).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("a run filed in a server the boot never saw", () => {
  test("a daily run keys its server on the spot", () => {
    const store = open();
    try {
      store.recordRun(TODAY, "easy", 7, ada, "g-new", run());
      expect(store.siteIdentity.serverKey("g-new")).toMatch(PUBLIC_KEY_PATTERN);
    } finally {
      store.close();
    }
  });

  test("a rush keys its server on the spot, and a run outside any server keys nothing", () => {
    const store = open();
    try {
      store.recordRushRun(TODAY, ada, "g-rushed", rush);
      store.recordRun(TODAY, "easy", 7, ada, null, run());
      expect(store.siteIdentity.serverKey("g-rushed")).toMatch(PUBLIC_KEY_PATTERN);
      expect(peek((db) => db.query("SELECT guild_id FROM guilds").all())).toEqual([
        { guild_id: "g-rushed" },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("visibility and the opt-out", () => {
  test("a player who never chose is shown, with their key", () => {
    const store = open();
    try {
      store.upsertPlayer(ada);
      const seen = store.siteIdentity.visibility(ada.id, NOW);
      expect(seen.hidden).toBe(false);
      expect(seen.playerKey).toMatch(PUBLIC_KEY_PATTERN);
      expect(seen.hasFinishedDay).toBe(false);
    } finally {
      store.close();
    }
  });

  test("hiding withholds the key, and showing again gives back the same one", () => {
    const store = open();
    try {
      store.upsertPlayer(ada);
      const key = store.siteIdentity.visibility(ada.id, NOW).playerKey;
      store.siteIdentity.setHidden(ada.id, true);
      expect(store.siteIdentity.visibility(ada.id, NOW)).toMatchObject({
        hidden: true,
        playerKey: null,
      });
      store.siteIdentity.setHidden(ada.id, false);
      expect(store.siteIdentity.visibility(ada.id, NOW)).toMatchObject({
        hidden: false,
        playerKey: key,
      });
      const stored = peek((db) =>
        db.query<{ site_hidden: number }, []>("SELECT site_hidden FROM players").get(),
      );
      expect(stored?.site_hidden).toBe(0);
    } finally {
      store.close();
    }
  });

  test("the guest has no page and cannot choose", () => {
    const store = open();
    try {
      store.upsertPlayer({ id: GUEST_ID, username: GUEST_ID, avatarUrl: null });
      expect(store.siteIdentity.visibility(GUEST_ID, NOW).playerKey).toBeNull();
      expect(() => store.siteIdentity.setHidden(GUEST_ID, true)).toThrow(/guest/);
    } finally {
      store.close();
    }
  });

  test("setting a choice for a player this box has never seen is an error, not a no-op", () => {
    const store = open();
    try {
      expect(() => store.siteIdentity.setHidden("p-nobody", true)).toThrow(/no player/);
    } finally {
      store.close();
    }
  });

  test("a name holding a seventeen-digit run gets no page, as the site rules", () => {
    const store = open();
    try {
      store.upsertPlayer({ id: "p-digits", username: "x12345678901234567", avatarUrl: null });
      expect(store.siteIdentity.visibility("p-digits", NOW)).toMatchObject({
        hidden: false,
        playerKey: null,
      });
    } finally {
      store.close();
    }
  });
});

describe("hasFinishedDay", () => {
  const finished = (store: Store) => store.siteIdentity.visibility(ada.id, NOW).hasFinishedDay;

  test("a run today is not a finished day, and one yesterday is", () => {
    const store = open();
    try {
      store.recordRun(TODAY, "easy", 7, ada, null, run(false));
      expect(finished(store)).toBe(false);
      store.recordRun(TODAY - 1, "easy", 7, ada, null, run(false));
      expect(finished(store)).toBe(true);
    } finally {
      store.close();
    }
  });

  test("a rush yesterday is a finished day", () => {
    const store = open();
    try {
      store.recordRushRun(TODAY, ada, null, rush);
      expect(finished(store)).toBe(false);
      store.recordRushRun(TODAY - 1, ada, null, rush);
      expect(finished(store)).toBe(true);
    } finally {
      store.close();
    }
  });

  test("a clear counts only from before today's midnight in the game's zone", () => {
    const store = open();
    try {
      store.upsertPlayer(ada);
      const midnight = startOfDay(TODAY, { timeZone: ZONE });
      const clear = (at: number, puzzle: number) => {
        const db = new Database(path);
        db.run(
          `INSERT INTO puzzle_clears (player_id, puzzle_id, first_at, last_at, times, best_ms)
           VALUES (?, ?, ?, ?, 1, 1000)`,
          [ada.id, puzzle, at, at],
        );
        db.close();
      };
      clear(midnight, 1);
      expect(finished(store)).toBe(false);
      clear(midnight - 1, 2);
      expect(finished(store)).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("keys", () => {
  test("a drawn key is in the public alphabet and the right length", () => {
    for (let i = 0; i < 500; i++) expect(newPublicKey()).toMatch(PUBLIC_KEY_PATTERN);
  });

  test("a collision on a key is drawn again, not shared and not lost", () => {
    const draws = ["aaaaaaaaaa", "aaaaaaaaaa", "bbbbbbbbbb"];
    const db = new Database(":memory:");
    db.run("CREATE TABLE t (id TEXT PRIMARY KEY, public_key TEXT UNIQUE)");
    const insert = (id: string) =>
      withFreshKey(
        (key) => db.run("INSERT INTO t (id, public_key) VALUES (?, ?)", [id, key]),
        () => draws.shift()!,
      );
    insert("one");
    insert("two");
    expect(db.query("SELECT id, public_key FROM t ORDER BY id").all()).toEqual([
      { id: "one", public_key: "aaaaaaaaaa" },
      { id: "two", public_key: "bbbbbbbbbb" },
    ]);
    db.close();
  });

  test("any other failure is not retried", () => {
    let calls = 0;
    expect(() =>
      withFreshKey(() => {
        calls++;
        throw new Error("UNIQUE constraint failed: t.id");
      }),
    ).toThrow(/t\.id/);
    expect(calls).toBe(1);
  });

  test("a key that collides every time gives up rather than looping", () => {
    let calls = 0;
    expect(() =>
      withFreshKey(() => {
        calls++;
        throw new Error("UNIQUE constraint failed: t.public_key");
      }),
    ).toThrow(/public_key/);
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(10);
  });
});
