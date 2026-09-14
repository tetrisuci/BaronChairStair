/**
 * The tool that corrects what the flag alone cannot reach.
 *
 * `PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES` changes how a requirement is
 * *derived*. Every requirement a player meets is already written down — in
 * `data/puzzles.json`, in the tracked archive's row, and in this box's
 * untracked `data/solutions.json` — and none of those move on their own. The
 * tool replays each flagged puzzle's own blueprint through the current engine
 * and corrects all three.
 *
 * What is tested here is the part that makes it safe to point at tracked data:
 * it may rename a clear and it may do nothing else. A blueprint replayed
 * through a newer engine could in principle come back as a *different answer* —
 * a dropped placement, a different route — and writing that would silently
 * replace a maker's solution. So the substance of every step is compared and a
 * mismatch refuses the whole run.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { archiveEntry, type ArchiveEntry } from "../server/archive-rows";
import { PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES } from "../shared/puzzle";
import type { ClearRequirement, SolutionStep } from "../shared/puzzle";
import {
  driftBetween,
  isStale,
  plannedRewrite,
  rederive,
  renamesBetween,
  type Staleness,
} from "../tools/rederive-flagged-clears";

const ARCHIVE = resolve(import.meta.dir, "../data/archive/puzzles.sqlite");

const step = (
  piece: string,
  cells: readonly (readonly [number, number])[],
  clear: string | null,
  attack: number,
): SolutionStep => ({ piece, cells, clear, attack }) as unknown as SolutionStep;

/** The same placement, named twice — before the engine could name a spin that cleared nothing. */
const WAS = [step("T", [[1, 2]], null, 0), step("L", [[3, 4]], "spin", 1)];
const NOW = [step("T", [[1, 2]], "spin (no lines)", 0), step("L", [[3, 4]], "spin", 1)];

describe("driftBetween", () => {
  test("sees no drift when only the naming moved", () => {
    // The whole premise. If this reported drift the tool could never write.
    expect(driftBetween(WAS, NOW)).toBeNull();
  });

  test("reports an answer that gained or lost a placement", () => {
    const drift = driftBetween(WAS, [...NOW, step("J", [[0, 0]], null, 0)]);

    expect(drift).toContain("2 steps on file");
    expect(drift).toContain("3");
  });

  test("reports a placement that moved, naming the step", () => {
    const moved = [NOW[0]!, step("L", [[9, 9]], "spin", 1)];

    expect(driftBetween(WAS, moved)).toContain("step 2");
  });

  test("reports a step that now sends different attack", () => {
    // Attack is what a run is filed against, so a change here is never cosmetic.
    const harder = [NOW[0]!, step("L", [[3, 4]], "spin", 4)];

    expect(driftBetween(WAS, harder)).toContain("step 2");
  });
});

describe("renamesBetween", () => {
  test("lists only the steps whose clear changed, with the step number and piece", () => {
    const [line, ...rest] = renamesBetween(WAS, NOW);

    expect(rest).toEqual([]);
    expect(line).toContain("step 1 T");
    expect(line).toContain("spin (no lines)");
  });

  test("says nothing when every clear already reads as the engine names it", () => {
    expect(renamesBetween(NOW, NOW)).toEqual([]);
  });
});

describe("rederive, against the committed archive", () => {
  const flagged = [...PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES];

  test("the archive is here to replay", () => {
    // Every checkout has it; the rest of this block is meaningless without it.
    expect(existsSync(ARCHIVE)).toBe(true);
  });

  const withEntry = (id: number, run: (entry: ArchiveEntry) => void) => {
    const db = new Database(ARCHIVE, { readonly: true });
    try {
      const entry = archiveEntry(db, id);
      expect(entry).not.toBeNull();
      run(entry!);
    } finally {
      db.close();
    }
  };

  for (const id of flagged) {
    test(`#${id}'s stored answer still replays to itself`, () => {
      // The invariant that keeps this tool re-runnable: the answer on file is
      // the answer its blueprint produces. If the engine ever changes what a
      // blueprint *does* rather than what it calls things, this goes red here
      // rather than by rewriting the archive.
      withEntry(id, (entry) => {
        const result = rederive(entry);

        expect(driftBetween(entry.puzzle.solution ?? [], result.solution)).toBeNull();
        expect(result.renames).toEqual([]);
      });
    });

    test(`#${id}'s derived requirement matches the one its archive row stores`, () => {
      // Independent data on either side: the left is replayed from the blueprint,
      // the right is the column a deploy box actually reads. An earlier version
      // of this test counted the derived requirement against the same replay it
      // came from, which held by construction and could not fail.
      withEntry(id, (entry) => {
        const { required } = rederive(entry);
        const key = (list: readonly ClearRequirement[]) =>
          JSON.stringify([...list].map((e) => [e.clear, e.count]).sort());

        expect(required.length).toBeGreaterThan(0);
        expect(key(entry.puzzle.requiredClears ?? [])).toEqual(key(required));
      });
    });
  }

  test("refuses a replay that is not the same answer", () => {
    // The guard that makes writing to tracked data defensible. A stored answer
    // whose placements do not match the blueprint is not a rename, and the tool
    // must decline rather than overwrite somebody's solution.
    withEntry(flagged[0]!, (entry) => {
      const tampered = {
        ...entry,
        puzzle: {
          ...entry.puzzle,
          solution: (entry.puzzle.solution ?? []).map((s, i) =>
            i === 0 ? step(s.piece, [[9, 9]], s.clear, s.attack) : s,
          ),
        },
      } as ArchiveEntry;

      expect(() => rederive(tampered)).toThrow(/different answer/);
    });
  });

  test("refuses a row with no blueprint to replay", () => {
    withEntry(flagged[0]!, (entry) => {
      const sourceless = {
        ...entry,
        puzzle: { ...entry.puzzle, source: undefined },
      } as ArchiveEntry;

      expect(() => rederive(sourceless)).toThrow(/blueprint/);
    });
  });
});

describe("isStale — what makes the tool write", () => {
  const settled: Staleness = {
    archiveAnswer: false,
    archiveClears: false,
    promptClears: false,
    localAnswer: false,
  };

  test("a store disagreeing is enough, with nothing renamed at all", () => {
    // The gate this replaced triggered only on a rename, so a flagged puzzle
    // whose answer was already current — what a re-sync of the tracked archive
    // leaves behind — was skipped with "Nothing to re-derive" while its
    // requirement stayed stale. Each of these three used to write nothing.
    expect(isStale({ ...settled, promptClears: true })).toBe(true);
    expect(isStale({ ...settled, archiveClears: true })).toBe(true);
    expect(isStale({ ...settled, localAnswer: true })).toBe(true);
  });

  test("a rename alone is still enough", () => {
    expect(isStale({ ...settled, archiveAnswer: true })).toBe(true);
  });

  test("and agreement everywhere writes nothing", () => {
    expect(isStale(settled)).toBe(false);
  });
});

describe("plannedRewrite, the guard that refuses to reformat", () => {
  const wrap = (rows: { id: number }[]) => ({ rows });
  const scratch: string[] = [];
  afterAll(() => {
    for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
  });

  function fileHolding(text: string): string {
    const directory = mkdtempSync(join(tmpdir(), "planned-rewrite-"));
    scratch.push(directory);
    const path = join(directory, "rows.json");
    writeFileSync(path, text);
    return path;
  }

  test("returns the updated bytes, and writes nothing itself", () => {
    // Computing the payload without writing it is what lets every refusal happen
    // before the first byte lands, which is what makes the write ORDER hold.
    const rows = [{ id: 1 }, { id: 2 }];
    const path = fileHolding(`${JSON.stringify(wrap(rows), null, 1)}\n`);

    const bytes = plannedRewrite(path, wrap, rows, [{ id: 1 }, { id: 3 }]);

    expect(bytes).toContain('"id": 3');
    expect(readFileSync(path, "utf8")).toContain('"id": 2');
  });

  test("refuses a file written in some other shape, and leaves it alone", () => {
    const rows = [{ id: 1 }];
    const compact = JSON.stringify(wrap(rows));
    const path = fileHolding(compact);

    expect(() => plannedRewrite(path, wrap, rows, [{ id: 9 }])).toThrow(/reformat/);
    expect(readFileSync(path, "utf8")).toBe(compact);
  });
});
