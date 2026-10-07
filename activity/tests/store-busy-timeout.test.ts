/**
 * The game's store waits for another writer instead of failing.
 *
 * During a handover two game processes have `daily.sqlite` open at once, and
 * the new one migrates and pins while the old one is still filing runs; the
 * archive sync is a third writer. SQLite's default is to fail a statement the
 * instant the write lock is held — `SQLITE_BUSY`, a crashed boot or a 500 on a
 * hand-in — so the store sets a busy timeout, before its first migration.
 *
 * The second test holds the lock from another process for real, because a
 * single process cannot block itself: while this thread waits on the lock,
 * nothing in it could let the lock go.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, STORE_BUSY_TIMEOUT_MS } from "../server/db";

const directories: string[] = [];

function scratchDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "store-busy-"));
  directories.push(directory);
  return join(directory, "daily.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** How long the other process keeps the write lock: well inside the timeout, well past zero. */
const HOLD_MS = 400;

describe("a store opened beside another writer", () => {
  test("sets a busy timeout of several seconds", () => {
    const store = new Store(scratchDatabase());
    const row = store.archiveReader.query("PRAGMA busy_timeout").get() as Record<string, number>;
    expect(Object.values(row)[0]).toBe(STORE_BUSY_TIMEOUT_MS);
    expect(STORE_BUSY_TIMEOUT_MS).toBeGreaterThanOrEqual(HOLD_MS * 5);
  });

  test("opens and migrates while another process holds the write lock, once it lets go", async () => {
    const path = scratchDatabase();
    // Built once first, so the other process is holding a lock on a real
    // database rather than racing this one to create it.
    new Store(path).archiveReader.close();

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
    const reader = holder.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("locked");

    const started = Date.now();
    // Every boot writes — the clear backfill alone is an INSERT — so without a
    // timeout this throws "database is locked" at once.
    expect(() => new Store(path)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(STORE_BUSY_TIMEOUT_MS);
    expect(await holder.exited).toBe(0);
  });
});
