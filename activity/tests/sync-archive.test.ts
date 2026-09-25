/**
 * The sync tool, run as the command it actually is.
 *
 * A subprocess rather than an import, because the things worth checking here
 * are the ones a unit test of `upsertArchive` cannot see: that `--dry-run`
 * really rolls its transaction back, that a puzzle which will not replay is
 * skipped rather than written half-formed, and that a drift exits non-zero so a
 * scheduled run cannot report success while quietly refusing to apply the
 * sheet.
 *
 * The fixture is three real rows off the club's sheet: two that build, and #13,
 * whose recorded answer has a step the router cannot reach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  archiveCounts,
  archiveEntry,
  contentHistory,
  publishArchive,
} from "../server/archive-rows";
import { ARCHIVE_SCHEMA } from "../server/db";

const TOOL = resolve(import.meta.dir, "../tools/sync-archive.ts");
const SHEET = resolve(import.meta.dir, "fixtures/archive-sheet");
const CODES = "Copy of Puzzles Archive - blueprint urls.csv";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sync-archive-"));
  dbPath = join(dir, "daily.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function sync(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", TOOL, "--db", dbPath, "--from", SHEET, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: out + err };
}

/** The fixture, with #1 and #2's blueprints swapped: an id kept, its puzzle replaced. */
function sheetWithSwappedPuzzles(): string {
  const swapped = join(dir, "swapped");
  cpSync(SHEET, swapped, { recursive: true });
  const path = join(swapped, CODES);
  const rows = readFileSync(path, "utf8").split("\n");
  // The fixture is minimally quoted, so an id is a bare leading field.
  const at = (id: string) => rows.findIndex((row) => row.split(",")[0]?.trim() === id);
  const [one, two] = [at("1"), at("2")];
  if (one < 0 || two < 0) throw new Error("fixture lost puzzle 1 or 2");
  const body = (row: string) => row.slice(row.indexOf(",") + 1);
  [rows[one], rows[two]] = [`1,${body(rows[two]!)}`, `2,${body(rows[one]!)}`];
  writeFileSync(path, rows.join("\n"));
  return swapped;
}

describe("syncing from a sheet", () => {
  test("writes the puzzles that replay, and skips the one that does not", async () => {
    const { code, out } = await sync();

    expect(code).toBe(0);
    expect(out).toContain("added 2");
    expect(out).toContain("#13:");

    const db = new Database(dbPath);
    try {
      expect(archiveCounts(db)).toEqual({ published: 0, pending: 2 });
      expect(archiveEntry(db, 13)).toBeNull();
      // The target is the engine's reading of the answer, not a sheet column.
      expect(archiveEntry(db, 1)!.puzzle.targetAttack).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("a second run changes nothing", async () => {
    await sync();
    const { out } = await sync();

    expect(out).toContain("added 0, amended 0, unchanged 2");
  });

  test("--dry-run rolls back everything it did", async () => {
    const { code, out } = await sync("--dry-run");

    expect(code).toBe(0);
    expect(out).toContain("would add 2");
    expect(out).toContain("nothing was written");

    const db = new Database(dbPath);
    try {
      expect(archiveCounts(db)).toEqual({ published: 0, pending: 0 });
    } finally {
      db.close();
    }
  });
});

describe("--publish, which Discord's /archive sync passes", () => {
  const counts = () => {
    const db = new Database(dbPath);
    try {
      return archiveCounts(db);
    } finally {
      db.close();
    }
  };

  test("publishes what the sync wrote, under the name it was run by", async () => {
    const { code, out } = await sync("--publish", "--by", "discord:an officer");

    expect(code).toBe(0);
    expect(out).toContain("published 2 that were waiting");
    expect(counts()).toEqual({ published: 2, pending: 0 });
    const db = new Database(dbPath);
    try {
      const row = db
        .query<{ published_by: string }, []>("SELECT published_by FROM archive_puzzles WHERE id = 1")
        .get();
      expect(row?.published_by).toBe("discord:an officer");
    } finally {
      db.close();
    }
  });

  test("also publishes rows an earlier, unpublished sync left waiting", async () => {
    await sync();
    expect(counts()).toEqual({ published: 0, pending: 2 });

    await sync("--publish");

    expect(counts()).toEqual({ published: 2, pending: 0 });
  });

  test("without it the sync is exactly as safe as it always was", async () => {
    await sync();

    expect(counts()).toEqual({ published: 0, pending: 2 });
  });

  test("a dry run publishes nothing, even when asked to", async () => {
    await sync();
    const { out } = await sync("--dry-run", "--publish");

    expect(out).not.toContain("that were waiting");
    expect(counts()).toEqual({ published: 0, pending: 2 });
  });
});

describe("when a creator edits a published puzzle", () => {
  test("the edit is applied, reported, and the old puzzle is recoverable", async () => {
    await sync();
    const db = new Database(dbPath);
    const before = archiveEntry(db, 1)!.contentHash;
    publishArchive(db, [1, 2], "an officer", Date.now());
    db.close();

    const proc = Bun.spawn(
      ["bun", "run", TOOL, "--db", dbPath, "--from", sheetWithSwappedPuzzles(), "--by", "a creator"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;

    expect(out).toContain("were EDITED");
    expect(out).toContain("Existing scores DO NOT change");
    // Not a failure — expected work — but the one thing somebody has to read.
    expect(code).toBe(2);

    const after = new Database(dbPath);
    try {
      // Applied, still published, and the previous puzzle still recoverable.
      expect(archiveEntry(after, 1)!.contentHash).not.toBe(before);
      expect(archiveEntry(after, 1)!.publishedBy).toBe("an officer");
      const history = contentHistory(after, 1);
      expect(history).toHaveLength(1);
      expect(history[0]?.wasHash).toBe(before);
      expect(history[0]?.by).toBe("a creator");
      expect(history[0]?.wasPublished).toBe(true);
    } finally {
      after.close();
    }
  });

  test("an unpublished puzzle changing is a plain amendment, not an edit", async () => {
    await sync();

    const proc = Bun.spawn(
      ["bun", "run", TOOL, "--db", dbPath, "--from", sheetWithSwappedPuzzles()],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;

    // Nobody could have played it, so there is nothing to warn anyone about.
    expect(out).not.toContain("were EDITED");
    expect(code).toBe(0);

    const db = new Database(dbPath);
    try {
      // Still logged — the history is worth having either way — but marked as
      // having happened while the puzzle was not playable.
      const history = contentHistory(db, 1);
      expect(history).toHaveLength(1);
      expect(history[0]?.wasPublished).toBe(false);
      // null, not 0, for both: the sync creates only the archive tables, so this
      // database has no `runs` and no `puzzle_solutions` at all. "Nobody played
      // it" and "there is nobody here to have played it" are different answers,
      // and these columns keep them apart.
      expect(history[0]?.runsBefore).toBeNull();
      expect(history[0]?.solutionsVoided).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("when the database is busy", () => {
  /**
   * The failure this guards is not the lost write — it is the *label* on it.
   * A first version funnelled every error into the same list as a puzzle whose
   * answer would not replay, so a locked database read as "these 148 puzzles
   * are broken", blamed the makers for the server being busy, and exited 0.
   */
  test("says the write failed, and does not call it a broken puzzle", async () => {
    // Create the schema, then take the write lock and hold it.
    const seed = new Database(dbPath, { create: true });
    seed.run(ARCHIVE_SCHEMA);
    seed.run("BEGIN IMMEDIATE");
    seed.run(
      `INSERT INTO archive_puzzles (id, title, author, difficulty, goal, set_name, board,
        queue, hold, target_attack, solution, required_clears, source_puzzle, source_solution,
        content_hash, synced_at, published_at, published_by)
       VALUES (9001,'x','x',1,'x',NULL,'[]','[]',NULL,1,'[]',NULL,'','','h',1,NULL,NULL)`,
    );

    try {
      const proc = Bun.spawn(
        ["bun", "run", TOOL, "--db", dbPath, "--from", SHEET],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, SYNC_BUSY_TIMEOUT_MS: "150" } },
      );
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;

      expect(out).toContain("could NOT BE WRITTEN");
      expect(out).toContain("database problem, not a puzzle problem");

      // The point of the test: which SECTION each id lands in. A lock error
      // must be under the write failures, and only the genuinely unreplayable
      // puzzle under "would not replay".
      const replaySection = out.slice(
        out.indexOf("would not replay"),
        out.indexOf("could NOT BE WRITTEN"),
      );
      const writeSection = out.slice(out.indexOf("could NOT BE WRITTEN"));
      expect(replaySection).not.toContain("database is locked");
      expect(replaySection).toContain("#13");
      expect(writeSection).toContain("#1: database is locked");
      expect(writeSection).toContain("#2: database is locked");
      expect(code).toBe(1);
    } finally {
      seed.run("ROLLBACK");
      seed.close();
    }
  });
});

describe("when the sheet cannot be read", () => {
  test("syncing nothing over a live archive is a failure, not a no-op", async () => {
    // A renamed tab answers 200 with another tab's CSV: well-formed, and
    // entirely the wrong data. Every id fails to parse, and without this guard
    // the sync reports a clean "added 0, amended 0, unchanged 0".
    const empty = join(dir, "wrong-tab");
    cpSync(SHEET, empty, { recursive: true });
    for (const name of [CODES, "Copy of Puzzles Archive - Puzzles.csv"]) {
      writeFileSync(join(empty, name), "notes,about\nthis sheet,is documentation\n");
    }

    const proc = Bun.spawn(["bun", "run", TOOL, "--db", dbPath, "--from", empty], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(await proc.exited).not.toBe(0);
    expect(out + err).toContain("no puzzles at all");
  });
});
