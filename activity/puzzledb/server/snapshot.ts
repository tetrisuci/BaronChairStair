/**
 * The SQL the puzzle database runs against the game's database, and the one
 * transaction it all runs in.
 *
 * Every other part of the site works from what this module hands back, and it
 * touches the game's file in exactly two ways: it opens it, read-only, and it
 * reads it in one short transaction. Both are what make the site safe to run
 * beside a game that is in the middle of somebody's duel.
 *
 * **Read-only by construction, not by care.** `{ readonly: true }` is SQLite's
 * own read-only open, so an INSERT is refused by SQLite rather than by a rule
 * somebody has to remember, and a missing file is an error rather than a new
 * empty database — which is what the game's own open makes of a wrong path,
 * silently. Nothing here constructs `Store` or `DaySchedule`: the first migrates
 * the file the moment it is made, and the second pins any day it is asked
 * about. Either would turn a reader into a writer.
 *
 * **The puzzles, read by the readers the game already has.** The accepted
 * puzzles, the corrections and the published rows come through the game's own
 * functions — `readAcceptedPuzzles`, `readOverrides`, `readPublishedArchive` —
 * so what the site lists cannot drift from how the game reads the same rows.
 * The days are a query of this module's own, {@link FINISHED_DAYS_SQL}.
 *
 * **The players, by an explicit list of columns.** Since schema 2 the site
 * publishes how finished days went, so it reads the player tables — through
 * `snapshot-players.ts` alone, which names every column it touches and decides
 * in SQL who may be named. Preferences, avatars, input logs and every log are
 * still never named anywhere, and `tests/puzzledb-snapshot.test.ts` strips each
 * column outside the list from a copy to prove a build does not need it.
 *
 * **One deferred transaction, and a short one.** The reads see a single
 * moment of the database, so a publish landing between two of them cannot
 * produce a dataset that is half before it and half after. A deferred BEGIN
 * takes no write lock, and the transaction is over before anything is built
 * from what it read — `PuzzleArchive.load` reads files and takes its time — so
 * a game checkpointing its write-ahead log waits on this reader for no longer
 * than its SELECTs take, and never on a build. A club-year of runs is a few
 * thousand rows, so that is milliseconds.
 */

import { Database } from "bun:sqlite";
import { readPublishedArchive } from "../../server/archive-rows";
import { readOverrides } from "../../server/puzzle-overrides";
import { readAcceptedPuzzles } from "../../server/submissions";
import { readPlayers } from "./snapshot-players";
import type { DayPin, GameSnapshot } from "./types";

/**
 * How long a read waits on a locked database before it gives up.
 *
 * Short, because `bun:sqlite` waits synchronously: the whole process, page
 * requests included, stands still while it does. A reader of a WAL database
 * almost never waits at all; this covers a checkpoint or a migration holding
 * the file for a moment, and a second is plenty for that. A read that still
 * fails is tried again at the next poll, with the last good dataset served in
 * the meantime.
 */
export const BUSY_TIMEOUT_MS = 1_000;

/**
 * The finished days: from the first tiered day up to, and not including, the
 * earlier of the club's today and the newest day the game has pinned.
 *
 * The second bound is the one that makes this safe. The game pins a day only
 * when something asks for it — a player, or the bot's recap — and nothing asks
 * for a day that has not begun, so `MAX(day)` is never past the game's own
 * today. Cutting below it means a site whose clock or zone runs ahead of the
 * game's cannot reveal today: the worst a drifted clock can do is hide a day,
 * never spoil one. The price is that yesterday appears only once something has
 * pinned today, which on any day somebody plays is minutes after midnight.
 *
 * `COALESCE(…, 0)` puts an empty table's cut at day 0, which keeps nothing.
 * Tiers come back raw and in byte order: which of them a day shows is
 * `tiersShownOn`'s decision, and the order is the public database's to set.
 */
export const FINISHED_DAYS_SQL = `
  SELECT day, tier, puzzle_id AS puzzleId FROM day_puzzles
   WHERE day >= ?1
     AND day <  MIN(?2, (SELECT COALESCE(MAX(day), 0) FROM day_puzzles))
   ORDER BY day, tier`;

/**
 * The game's database, opened so that it cannot be written through this handle.
 *
 * Throws SQLite's own "unable to open database file" for a path with nothing
 * at it, and leaves the path as empty as it found it.
 */
export function openGameDatabase(path: string): Database {
  const db = new Database(path, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * `PRAGMA data_version`: a number that moves whenever another connection commits.
 *
 * The refresher's cheap question, asked every poll. It reads no table, and it
 * moves on every commit the game makes — so an unchanged number means nothing
 * in the database can have changed. A moved one means only that something
 * did; whether it was anything public is for a fresh snapshot to say.
 */
export function dataVersion(db: Database): number {
  const row = db.query<{ data_version: number }, []>("PRAGMA data_version").get();
  if (!row) throw new Error("PRAGMA data_version returned no row");
  return row.data_version;
}

/**
 * Everything one rebuild reads from the game, as one moment of the database.
 *
 * `clockToday` is the club's day by the site's own clock, and `firstTieredDay`
 * where the policy starts history; together they bound
 * {@link FINISHED_DAYS_SQL} and every player read. What comes back is frozen,
 * plain data that holds no handle, so it outlives the transaction it was read
 * in — which is over before this returns.
 */
export function readSnapshot(
  db: Database,
  clockToday: number,
  firstTieredDay: number,
): GameSnapshot {
  const read = db.transaction(
    (): GameSnapshot =>
      Object.freeze({
        accepted: Object.freeze(readAcceptedPuzzles(db)),
        overrides: Object.freeze(readOverrides(db)),
        published: Object.freeze(readPublishedArchive(db)),
        pins: finishedDays(db, clockToday, firstTieredDay),
        newestPinnedDay: newestPinnedDay(db),
        players: readPlayers(db, clockToday, firstTieredDay),
      }),
  );
  return read.deferred();
}

function finishedDays(db: Database, clockToday: number, firstTieredDay: number): readonly DayPin[] {
  const rows = db
    .query<DayPin, [number, number]>(FINISHED_DAYS_SQL)
    .all(firstTieredDay, clockToday);
  return Object.freeze(rows.map((pin) => Object.freeze(pin)));
}

function newestPinnedDay(db: Database): number | null {
  const row = db.query<{ day: number | null }, []>("SELECT MAX(day) AS day FROM day_puzzles").get();
  return row?.day ?? null;
}
