/**
 * `backup`: a faithful copy of both databases before anything switches, made
 * with `VACUUM INTO` from a read-only connection — never `cp`, which can copy
 * a WAL database torn. A backup never overwrites another: the one it would
 * replace may be the only good copy left.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backup } from "../tools/deploy/backup";
import { FakeBox, NEW, cleanUpBoxes } from "./deploy-harness";

afterEach(cleanUpBoxes);

function seed(path: string, rows: number): void {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE runs (id INTEGER PRIMARY KEY)");
  for (let i = 0; i < rows; i += 1) db.run("INSERT INTO runs DEFAULT VALUES");
  db.close();
}

function rowsIn(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT count(*) AS n FROM runs").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function boxWithDatabases(): FakeBox {
  const box = new FakeBox();
  seed(join(box.layout.shared, "daily.sqlite"), 5);
  seed(join(box.layout.shared, "stats.db"), 2);
  return box;
}

describe("a backup", () => {
  test("copies both databases into shared/backups, named by database, time and release", () => {
    const box = boxWithDatabases();
    const paths = backup(box.context(), NEW);
    const stamp = "2026-10-06-152000";
    expect(new Date(box.now).toISOString()).toBe("2026-10-06T15:20:00.000Z");
    expect(paths).toEqual([
      join(box.layout.backups, `daily-${stamp}-${NEW.slice(0, 12)}.sqlite`),
      join(box.layout.backups, `stats-${stamp}-${NEW.slice(0, 12)}.sqlite`),
    ]);
    expect(rowsIn(paths[0]!)).toBe(5);
    expect(rowsIn(paths[1]!)).toBe(2);
    expect(box.output()).toContain(paths[0]!);
  });

  test("refuses to overwrite an existing backup, and writes neither", () => {
    const box = boxWithDatabases();
    const [daily] = backup(box.context(), NEW);
    writeFileSync(daily!, "the only good copy");
    const before = readdirSync(box.layout.backups).length;
    expect(() => backup(box.context(), NEW)).toThrow(/already exists/);
    expect(readFileSync(daily!, "utf8")).toBe("the only good copy");
    expect(readdirSync(box.layout.backups).length).toBe(before);
  });

  test("refuses when a database is not in shared/, rather than backing up half", () => {
    const box = new FakeBox();
    seed(join(box.layout.shared, "daily.sqlite"), 1);
    rmSync(join(box.layout.shared, "stats.db"));
    expect(() => backup(box.context(), NEW)).toThrow(/stats\.db/);
    expect(existsSync(box.layout.backups)).toBe(false);
  });

  test("a dry run names the files and writes nothing", () => {
    const box = boxWithDatabases();
    const paths = backup(box.context({ dryRun: true }), NEW);
    expect(paths).toHaveLength(2);
    expect(existsSync(box.layout.backups)).toBe(false);
    expect(box.output()).toContain("would back up");
  });
});
