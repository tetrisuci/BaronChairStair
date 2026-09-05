/**
 * The rule that keeps six test files able to share one database.
 *
 * `grep -rn puzzle-routes- tests/` finds six files naming the same path, because
 * `bun test` gives them one module registry and one process: the first file to
 * import anything under `server/` settles `config` for all of them, so a file
 * asking for a database of its own is either ignored or quietly takes the
 * suite's. That part is deliberate and documented at the top of `duel.test.ts`.
 *
 * What is not safe is any file *removing* it. Nothing orders the files, so a
 * teardown that unlinks the shared database can pull it out from under a file
 * still running — and the failure does not look like a teardown bug. The app's
 * store keeps its open handle and goes on writing to the unlinked inode, while
 * any later `new Store(path)` finds no file and creates one: the constructor is
 * `create: true` plus `CREATE TABLE IF NOT EXISTS`, so it opens clean rather
 * than erroring. The assertion then fails with a count of 0 or a null row,
 * which reads as "the route never stored it".
 *
 * That is not hypothetical. `server.test.ts` had exactly such an `afterAll`, and
 * it surfaced as four failures in `submissions.test.ts` on a Linux box while
 * macOS ran the same commit green — the two order the files differently. A
 * comment did not stop it being written, so this is a test.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TESTS = import.meta.dir;
const SHARED = "puzzle-routes-";

/** Every test file, so a new one is covered the day it is added. */
function testFiles(): string[] {
  return readdirSync(TESTS).filter((name) => name.endsWith(".test.ts"));
}

describe("the database six test files share", () => {
  test("is named by more than one file, or this rule guards nothing", () => {
    const sharers = testFiles().filter((name) =>
      readFileSync(join(TESTS, name), "utf8").includes(SHARED),
    );
    // Not a fixed count: files come and go, and pinning the number would make
    // this fail for the wrong reason. Two is where "shared" starts to mean
    // anything.
    expect(sharers.length).toBeGreaterThan(1);
  });

  test("is deleted by no test file", () => {
    const offenders = testFiles().filter((name) => {
      const source = readFileSync(join(TESTS, name), "utf8");

      // The local name this file gave the shared path — DB, SHARED_DB,
      // DATABASE, whatever the next one picks. Without this the check reduces
      // to "does the file both delete something and mention the path", which
      // two files satisfy innocently: they remove a `mkdtempSync` directory.
      // `[^;]*` and not `[^)]*`: the path is built with `join(tmpdir(), ...)`,
      // and a class excluding `)` stops dead at `tmpdir()`'s own bracket, so it
      // matched nothing and this test passed on everything.
      const declared = new RegExp(`const\\s+(\\w+)\\s*=\\s*join\\([^;]*${SHARED}`).exec(source);
      const held = declared?.[1];
      if (!held) return false;

      // A removal whose argument mentions that name. The suffix forms count:
      // deleting only `-wal` is the same hazard with a smaller blast radius.
      const removals = source.matchAll(/\b(?:rmSync|unlinkSync)\s*\(([^)]*)\)/g);
      // No file-level exemption: an earlier version of this test excused the
      // whole file if a sanctioned sweep appeared anywhere in it, which meant
      // re-adding the very `afterAll` this exists to catch went unnoticed —
      // the sweep sat in the same file. The argument is the discriminator and
      // needs no help: the sweep removes a path it built from `readdirSync`,
      // which is a different local name from the shared constant.
      return [...removals].some(([, argument]) => (argument ?? "").includes(held));
    });

    expect(offenders).toEqual([]);
  });
});
