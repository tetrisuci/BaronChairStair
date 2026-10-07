/**
 * The game's store waits for another writer instead of failing.
 *
 * During a handover two game processes have `daily.sqlite` open at once, and
 * the new one migrates and pins while the old one is still filing runs; the
 * archive sync is a third writer. SQLite's default is to fail a statement the
 * instant the write lock is held — `SQLITE_BUSY`, a crashed boot or a 500 on a
 * hand-in — so the store sets a busy timeout, before its first migration.
 *
 * The timeout alone is not the whole of it. A transaction that reads before it
 * writes holds a read lock by the time it asks for the write lock, and SQLite
 * does not wait at that upgrade: it fails at once, timeout or none. So every
 * transaction that reads first and then writes is begun IMMEDIATE, taking the
 * write lock — and with it the wait — at its first statement.
 *
 * These tests hold the lock from another process for real, because a single
 * process cannot block itself: while this thread waits on the lock, nothing in
 * it could let the lock go.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, STORE_BUSY_TIMEOUT_MS, type PastDays } from "../server/db";
import { migrateSiteIdentity } from "../server/site-identity";
import type { SubmissionDraft } from "../server/submissions";
import { COMMUNITY_ID_BASE } from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";

const directories: string[] = [];
const stores: Store[] = [];

function scratchDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "store-busy-"));
  directories.push(directory);
  return join(directory, "daily.sqlite");
}

function openStore(path: string): Store {
  const store = new Store(path);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** How long the other process keeps the write lock: well inside the timeout, well past zero. */
const HOLD_MS = 400;
/**
 * What a call that waited for the lock must have spent waiting, at least. A
 * fraction of {@link HOLD_MS}, because the hold starts a moment before this
 * process hears it has; enough that a call which never met the lock — the
 * holder already gone — cannot pass for one that waited.
 */
const WAITED_AT_LEAST_MS = HOLD_MS / 4;

/**
 * Another process takes the write lock on `path` and keeps it for
 * {@link HOLD_MS}. Resolves once the lock is held, with the holder's exit.
 */
async function holdWriteLock(path: string): Promise<{ readonly released: Promise<number> }> {
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
        const { Database } = require("bun:sqlite");
        const db = new Database(${JSON.stringify(path)});
        db.exec("BEGIN IMMEDIATE");
        db.exec("CREATE TABLE IF NOT EXISTS held (x)");
        console.log("locked");
        setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${HOLD_MS});
      `,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const first = await holder.stdout.getReader().read();
  expect(new TextDecoder().decode(first.value)).toContain("locked");
  return { released: holder.exited };
}

/** Runs `write` against a lock held elsewhere, and checks it waited rather than failed. */
async function writeWhileLocked<T>(path: string, write: () => T): Promise<T> {
  const lock = await holdWriteLock(path);
  const started = Date.now();
  let outcome: { readonly value: T } | { readonly error: unknown };
  try {
    outcome = { value: write() };
  } catch (error) {
    outcome = { error };
  }
  const waited = Date.now() - started;
  // Either way, so a write that failed never leaves the holder committing
  // into a directory the cleanup is about to delete.
  expect(await lock.released).toBe(0);
  if ("error" in outcome) throw outcome.error;
  expect(waited).toBeGreaterThanOrEqual(WAITED_AT_LEAST_MS);
  expect(waited).toBeLessThan(STORE_BUSY_TIMEOUT_MS);
  return outcome.value;
}

describe("a store opened beside another writer", () => {
  test("sets a busy timeout of several seconds", () => {
    const store = openStore(scratchDatabase());
    const row = store.archiveReader.query("PRAGMA busy_timeout").get() as Record<string, number>;
    expect(Object.values(row)[0]).toBe(STORE_BUSY_TIMEOUT_MS);
    expect(STORE_BUSY_TIMEOUT_MS).toBeGreaterThanOrEqual(HOLD_MS * 5);
  });

  test("opens and migrates while another process holds the write lock, once it lets go", async () => {
    const path = scratchDatabase();
    // Built once first, so the other process is holding a lock on a real
    // database rather than racing this one to create it.
    new Store(path).close();

    // Every boot writes — the clear backfill alone is an INSERT — so without a
    // timeout this throws "database is locked" at once.
    stores.push(await writeWhileLocked(path, () => new Store(path)));
  });
});

/**
 * Each of these reads inside its transaction before it writes, which is the
 * shape a busy timeout does not cover unless the transaction is IMMEDIATE.
 * Every one failed at once with "database is locked" while it was DEFERRED.
 */
describe("a transaction that reads before it writes, while another process holds the write lock", () => {
  const author = { id: "author-1", username: "Ada", avatarUrl: null };
  const draft: SubmissionDraft = {
    player: author,
    guildId: "g1",
    title: "Tuck the T",
    goal: "Clear 1 TSD",
    claimedDifficulty: 4,
    board: ["GGGG.GGGGG"],
    queue: ["T"],
    hold: null,
    targetAttack: 4,
    solution: [{ piece: "T", cells: [[3, 1], [4, 1], [5, 1], [4, 0]], clear: "tsd", attack: 4 }],
    events: [{ frame: 0, type: "keydown", data: { key: "hardDrop", subframe: 0 } }],
    handling: DEFAULT_HANDLING,
    piecesPlaced: 1,
    clears: ["tsd"],
    requiredClears: null,
  };

  test("an officer's Accept waits for it, and takes the next community id", async () => {
    const path = scratchDatabase();
    const store = openStore(path);
    const { submissionId } = store.recordSubmission(draft);

    const decided = await writeWhileLocked(path, () =>
      store.acceptSubmission(submissionId, { reviewedBy: "officer", difficulty: 4, note: null }),
    );
    expect(decided.submission).toMatchObject({ status: "accepted", puzzleId: COMMUNITY_ID_BASE });
  });

  test("saving a correction waits for it", async () => {
    const path = scratchDatabase();
    const store = openStore(path);

    const written = await writeWhileLocked(path, () =>
      store.setOverride(1, { title: "Corrected" }, "officer"),
    );
    expect(written?.title).toBe("Corrected");
  });

  test("reverting a correction waits for it", async () => {
    const path = scratchDatabase();
    const store = openStore(path);
    store.setOverride(1, { title: "Corrected" }, "officer");

    expect(await writeWhileLocked(path, () => store.clearOverride(1, "officer"))).toBe(true);
    expect(store.overridesFor()).toEqual([]);
  });

  test("keying the players a boot finds unkeyed waits for it", async () => {
    const path = scratchDatabase();
    const store = openStore(path);
    store.upsertPlayer(author);
    const db = store.archiveReader;
    // What a database written before the site existed looks like.
    db.run("UPDATE players SET public_key = NULL WHERE id = ?1", [author.id]);

    await writeWhileLocked(path, () => migrateSiteIdentity(db));
    const row = db
      .query<{ public_key: string | null }, [string]>("SELECT public_key FROM players WHERE id = ?1")
      .get(author.id);
    expect(row?.public_key).toBeString();
  });

  test("writing down the days already dealt waits for it", async () => {
    const path = scratchDatabase();
    const store = openStore(path);
    const pastDays: PastDays = {
      throughDay: 2,
      puzzleIdsFor: (day) => ({ easy: day * 10 + 1, medium: day * 10 + 2, hard: day * 10 + 3, extreme: day * 10 + 4 }),
    };

    await writeWhileLocked(path, () => store.pinPastDays(pastDays));
    expect(store.pinnedDay(2)).toEqual({ easy: 21, medium: 22, hard: 23, extreme: 24 });
  });
});
