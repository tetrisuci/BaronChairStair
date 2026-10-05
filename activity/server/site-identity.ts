/**
 * Who a player and a server are on db.tetrisatuci.org, written down by the game.
 *
 * The site publishes boards, and a board needs a name for every row and an
 * address for every player's page. The game's database names both by Discord
 * id, and a Discord id is the one thing the site must never print: it is
 * permanent, it is searchable, and it is the key to everything else a person
 * has ever done on Discord. So each player and each server gets a second name
 * here — ten random characters, drawn once and never changed — and the site
 * reads that instead. The game draws them, not the site, for two reasons: the
 * site is meant to hold no secret at all (`puzzledb/.env.example` says so),
 * and a key derived from the id would need one; and the game is what hands a
 * player the link to their own page, which it can only do if it already knows
 * the key.
 *
 * Three more facts live here because the site cannot learn them any other way:
 *
 * - **A server's name**, as Discord gave it at the last sign-in from there.
 *   The bot is not in every server that has a board, and the sign-in already
 *   asks Discord for the player's servers, so it costs no new permission.
 * - **The opt-out**, `players.site_hidden`: NULL never chose, 0 shown, 1
 *   hidden. A column rather than a preference, because every path that writes
 *   preferences rebuilds them from the fields it knows, and the client's copy
 *   wins on load and Reset replaces it — any one of those would quietly un-hide
 *   somebody who asked not to be shown.
 * - **The game's zone**, in `site_facts`. Two of the columns the site cuts at
 *   a finished day are milliseconds with no day beside them, and the site's
 *   own zone setting may differ from the game's. A cut taken at the wrong
 *   midnight would publish an hour of today.
 *
 * **Everything here is additive.** Columns are added nullable, tables with
 * `IF NOT EXISTS`, and nothing is dropped or rebuilt, so older game code runs
 * on a migrated database unchanged — that is what makes a rollback safe. A
 * player that older code inserts in the meantime has no key; the site treats a
 * keyless player as hidden, and the next boot of this code keys them.
 *
 * This module owns no connection. The Store opens the database and hands its
 * handle over, the way it does for `archive-rows.ts`, so every write here
 * shares the Store's WAL and foreign-key settings and its transactions.
 */

import type { Database } from "bun:sqlite";
import { DEFAULT_TIME_ZONE, dayNumber, startOfDay } from "../shared/daily";
import { GUEST_ID, PUBLIC_KEY_ALPHABET, PUBLIC_KEY_LENGTH } from "../shared/site";

/*
 * Created after the two `players` columns, and never in `SCHEMA`: the index
 * names `public_key`, and SCHEMA runs against databases that do not have it yet.
 *
 * Comments sit inside the parentheses so that `sqlite_master` keeps them —
 * whoever opens the live file with the sqlite3 shell reads them there.
 */
const SITE_IDENTITY_TABLES = `
CREATE UNIQUE INDEX IF NOT EXISTS players_public_key ON players (public_key);

CREATE TABLE IF NOT EXISTS guilds (
  -- Servers that have filed a run, and the name Discord gave at the last
  -- sign-in from there. db.tetrisatuci.org publishes public_key and name and
  -- never guild_id.
  guild_id   TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,  -- the site's name for it; random, never the id
  name       TEXT,                  -- NULL until a player signs in from it after this deploy
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS site_facts (
  -- What db.tetrisatuci.org must know about the game and cannot read from
  -- anywhere else. Today one row: 'time_zone', the zone whose midnight starts a
  -- day, rewritten at every start of the game.
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Bytes at or above this are thrown away rather than folded into the alphabet.
 *
 * 256 is not a multiple of the alphabet's 31 characters, so `byte % 31` alone
 * would make the first nine characters a little likelier than the rest. Keeping
 * only the largest multiple of 31 below 256 makes every character equally
 * likely, at the cost of drawing again about one time in thirty-two.
 */
const UNBIASED_BELOW = 256 - (256 % PUBLIC_KEY_ALPHABET.length);

/**
 * How many times a key is drawn again after colliding with one already in use.
 *
 * At about 49 bits a key, a second collision in a row means something other
 * than chance — a broken random source, or a draw function a test pinned — and
 * looping on it forever would hang a sign-in instead of failing it.
 */
const KEY_ATTEMPTS = 5;

/** What a player sees about themselves in the activity's "On the web" setting. */
export interface SiteVisibility {
  /** They chose "Hide me on db.tetrisatuci.org". False for "never chose". */
  readonly hidden: boolean;
  /**
   * The key of their page on the site, or null when the site shows them as "a
   * player": hidden, the guest, not yet keyed, or a name holding a run of
   * seventeen digits (the site's own rule, repeated so the game never links to
   * a page the site will not build).
   */
  readonly playerKey: string | null;
  /**
   * They have something on a day that is over, so the site has a row for them.
   * Without one, the site lists them nowhere yet and a link to their page
   * would 404.
   */
  readonly hasFinishedDay: boolean;
}

/** Ten characters from {@link PUBLIC_KEY_ALPHABET}, every one equally likely. */
export function newPublicKey(): string {
  let key = "";
  while (key.length < PUBLIC_KEY_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(PUBLIC_KEY_LENGTH * 2));
    for (const byte of bytes) {
      if (byte >= UNBIASED_BELOW) continue;
      key += PUBLIC_KEY_ALPHABET[byte % PUBLIC_KEY_ALPHABET.length];
      if (key.length === PUBLIC_KEY_LENGTH) break;
    }
  }
  return key;
}

/**
 * Runs a write that inserts a fresh key, drawing again if the key is taken.
 *
 * The UNIQUE index is what makes a shared key impossible; this is what keeps
 * the index from turning a one-in-a-quadrillion draw into a failed sign-in or
 * a lost run. Only a collision on a `public_key` is retried — any other
 * failure, a duplicate id included, is the caller's and goes straight up.
 * SQLite undoes just the failed statement, not the transaction around it, so
 * retrying inside the Store's transactions is safe.
 */
export function withFreshKey<T>(write: (key: string) => T, draw: () => string = newPublicKey): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return write(draw());
    } catch (error) {
      if (attempt >= KEY_ATTEMPTS || !isKeyCollision(error)) throw error;
    }
  }
}

function isKeyCollision(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed") &&
    error.message.includes(".public_key")
  );
}

/**
 * Seventeen ASCII digits in a row, anywhere: what a Discord id looks like.
 *
 * The site's SQL holds the same rule as a GLOB and is what actually keeps such
 * a name off the site; this copy only stops the game linking to a page the
 * site will refuse to build.
 */
const DIGIT_RUN = /[0-9]{17}/;

/**
 * Brings a database up to what the site reads, and records the game's zone.
 *
 * Idempotent and run at every boot, so a database restored from a backup, or
 * one older code wrote to after a rollback, is caught up the next time the game
 * starts. The column adds and the CREATEs are no-ops once done; the backfills
 * touch only rows still missing a key; the zone is written only when it
 * differs, so a plain restart does not wake the site's refresher for nothing.
 *
 * @param timeZone the zone the game deals days in. Omitted by a maintenance
 *   tool that opens the Store bare: it does not know the game's zone, and a
 *   guess written here would move the site's cut.
 */
export function migrateSiteIdentity(db: Database, timeZone?: string): void {
  // Deliberately no backfill. NULL is "never chose", which the site reads as
  // shown, because the owner chose opt-out; inventing a 0 for everybody would
  // erase the difference between "said show me" and "was never asked".
  addColumnIfMissing(db, "players", "site_hidden", "INTEGER");
  // Filled straight after, below, rather than with a DEFAULT: SQLite's ADD
  // COLUMN cannot default to a random value, and a constant default would
  // collide with itself on the UNIQUE index on the second row.
  addColumnIfMissing(db, "players", "public_key", "TEXT");
  db.run(SITE_IDENTITY_TABLES);
  db.transaction(() => {
    keyUnkeyedPlayers(db);
    keyServersWithRuns(db);
  })();
  if (timeZone !== undefined) recordTimeZone(db, timeZone);
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function keyUnkeyedPlayers(db: Database): void {
  const unkeyed = db
    .query<{ id: string }, []>("SELECT id FROM players WHERE public_key IS NULL")
    .all();
  const key = db.query<unknown, [string, string]>(
    "UPDATE players SET public_key = ?2 WHERE id = ?1",
  );
  for (const { id } of unkeyed) withFreshKey((fresh) => key.run(id, fresh));
}

/**
 * Every server a run or a rush was filed from, keyed, and named by nobody yet.
 *
 * Its name arrives with the next sign-in from it; until then the site shows
 * "Unnamed server", which is the truth rather than a guess.
 */
function keyServersWithRuns(db: Database): void {
  const missing = db
    .query<{ guild_id: string }, []>(
      `SELECT guild_id FROM runs WHERE guild_id IS NOT NULL
       UNION
       SELECT guild_id FROM rush_runs WHERE guild_id IS NOT NULL
       EXCEPT
       SELECT guild_id FROM guilds`,
    )
    .all();
  const now = Date.now();
  for (const { guild_id } of missing) insertGuild(db, guild_id, now);
}

/**
 * `ON CONFLICT(guild_id) DO NOTHING` and not `INSERT OR IGNORE`: the latter
 * would also swallow a collision on the key and silently leave the server out,
 * where this lets {@link withFreshKey} see it and draw again.
 */
function insertGuild(db: Database, guildId: string, now: number): void {
  withFreshKey((key) =>
    db.run(
      `INSERT INTO guilds (guild_id, public_key, name, updated_at) VALUES (?1, ?2, NULL, ?3)
       ON CONFLICT (guild_id) DO NOTHING`,
      [guildId, key, now],
    ),
  );
}

function recordTimeZone(db: Database, timeZone: string): void {
  db.run(
    `INSERT INTO site_facts (name, value) VALUES ('time_zone', ?1)
     ON CONFLICT (name) DO UPDATE SET value = excluded.value
     WHERE site_facts.value IS NOT excluded.value`,
    [timeZone],
  );
}

/**
 * The game's reads and writes of the site's identity facts, after migration.
 *
 * Reached as `store.siteIdentity`. A class over the Store's handle rather than
 * more methods on a Store that is already the longest file in the repository.
 */
export class SiteIdentity {
  private readonly timeZone: string;

  /**
   * @param timeZone the game's zone, for "is this day over". Defaults as the
   *   game's config does, so a Store opened bare still answers sensibly.
   */
  constructor(
    private readonly db: Database,
    timeZone: string = DEFAULT_TIME_ZONE,
  ) {
    this.timeZone = timeZone;
  }

  /**
   * What the "On the web" setting shows a player. Writes nothing.
   *
   * `hasFinishedDay` mirrors the rows the site builds a player from: a daily
   * or a rush on a day before today, or a puzzle first cleared before today's
   * midnight in the game's zone. The site's cut can sit a day behind the
   * game's today, never ahead of it, so this can only say "yes" a few hours
   * early, never "no" when the page exists.
   */
  visibility(playerId: string, now: number = Date.now()): SiteVisibility {
    const row = this.db
      .query<{ username: string; site_hidden: number | null; public_key: string | null }, [string]>(
        "SELECT username, site_hidden, public_key FROM players WHERE id = ?1",
      )
      .get(playerId);
    const hidden = row?.site_hidden === 1;
    const shown =
      row !== null && !hidden && playerId !== GUEST_ID && !DIGIT_RUN.test(row.username);
    return {
      hidden,
      playerKey: shown ? row.public_key : null,
      hasFinishedDay: this.hasFinishedDay(playerId, now),
    };
  }

  private hasFinishedDay(playerId: string, now: number): boolean {
    const today = dayNumber(now, { timeZone: this.timeZone });
    const todayStartsAt = startOfDay(today, { timeZone: this.timeZone });
    const row = this.db
      .query<{ finished: number }, [string, number, number]>(
        `SELECT EXISTS (SELECT 1 FROM runs WHERE player_id = ?1 AND day < ?2)
             OR EXISTS (SELECT 1 FROM rush_runs WHERE player_id = ?1 AND day < ?2)
             OR EXISTS (SELECT 1 FROM puzzle_clears WHERE player_id = ?1 AND first_at < ?3)
           AS finished`,
      )
      .get(playerId, today, todayStartsAt);
    return row?.finished === 1;
  }

  /**
   * Records a player's choice. The guest is refused outright: every guest is
   * one shared row, so one guest's choice would be every guest's. A player
   * this box has never written is an error rather than a silent no-op, so a
   * route that forgot to upsert finds out instead of telling the player their
   * choice was saved.
   */
  setHidden(playerId: string, hidden: boolean): void {
    if (playerId === GUEST_ID) throw new Error("The guest has no name on the site to hide");
    const result = this.db.run("UPDATE players SET site_hidden = ?1 WHERE id = ?2", [
      hidden ? 1 : 0,
      playerId,
    ]);
    if (result.changes === 0) throw new Error(`There is no player ${playerId} to hide or show`);
  }

  /**
   * Remembers what Discord calls a server, at a sign-in from it.
   *
   * Writes only on a change. Sign-ins are frequent and the name almost never
   * moves, and every write wakes the site's refresher into a rebuild. A sign-in
   * that brought no name (Discord left it out, or it was not a string) keeps
   * the one already known rather than erasing it.
   *
   * The name is stored as Discord gave it, already cleaned by the caller. The
   * seventeen-digit rule and the site's hide list are the site's to apply, at
   * publication, so that changing either never needs a game deploy.
   */
  recordGuild(guildId: string, name: string | null, now: number = Date.now()): void {
    withFreshKey((key) =>
      this.db.run(
        `INSERT INTO guilds (guild_id, public_key, name, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (guild_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
         WHERE excluded.name IS NOT NULL AND guilds.name IS NOT excluded.name`,
        [guildId, key, name, now],
      ),
    );
  }

  /**
   * Keys a server a run is being filed from, if the boot never saw it.
   *
   * A session minted before this deploy, or from a server whose sign-in
   * recorded nothing, can file a run from a server with no row here. Without
   * this its rows would sit on the site as "played outside any server" until
   * the game next restarted.
   */
  ensureGuild(guildId: string | null): void {
    // Read first: almost every run comes from a server already here, and the
    // read spares those a key drawn only to be thrown away.
    if (guildId === null || this.serverKey(guildId) !== null) return;
    insertGuild(this.db, guildId, Date.now());
  }

  /** The site's key for a server, or null for one no run or sign-in has named. */
  serverKey(guildId: string): string | null {
    const row = this.db
      .query<{ public_key: string }, [string]>("SELECT public_key FROM guilds WHERE guild_id = ?1")
      .get(guildId);
    return row?.public_key ?? null;
  }
}
