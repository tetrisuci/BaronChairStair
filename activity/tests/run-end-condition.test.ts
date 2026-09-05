/**
 * Every run-ending decision goes through `solvesPuzzle`, not `meetsTarget`.
 *
 * `meetsTarget` answers "is the attack target reached", which used to be the
 * whole solve condition and is now half of it. A run that ends on that half
 * ends before a required clear can be made — which does not score a puzzle
 * wrongly, it makes it **unsolvable**, and the player is simply stopped with
 * pieces left and the goal unmet.
 *
 * `client/src/game/runner.ts` is where that decision lives, in three places
 * today. The risk is not that those three regress; it is that a *fourth* is
 * added. That is not hypothetical — PR #37 (touch placement) adds a `placeAt()`
 * whose log-full branch ends the run, and merging the two produces a tree that
 * git resolves without conflict and `tsc` then rejects. This test is what makes
 * that collision loud in the right place, and names the fix.
 *
 * A source check rather than a behavioural one, deliberately. The failure mode
 * is a call site that does not exist yet, in a method nobody has written, and no
 * fixture can exercise code that is not there.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNNER = join(import.meta.dir, "..", "client", "src", "game", "runner.ts");

describe("the run's end condition", () => {
  test("no run-ending decision in the runner is made on attack alone", () => {
    const source = readFileSync(RUNNER, "utf8");
    // Comments may name it — this file's own docblocks do. Only a call counts.
    const calls = [...source.matchAll(/^(?!\s*(?:\/\/|\*|\/\*)).*\bmeetsTarget\s*\(/gm)];

    expect(
      calls.map((m) => m[0].trim()),
      "A run-ending decision is being made on the attack target alone. Use\n" +
        "`solvesPuzzle(this.attack, this.clears, this.puzzle)` instead — the run\n" +
        "must continue past the attack target while a required clear is still\n" +
        "outstanding, or the puzzle cannot be solved at all.",
    ).toEqual([]);
  });

  test("and the three that exist all use the full condition", () => {
    const source = readFileSync(RUNNER, "utf8");
    const full = [...source.matchAll(/\bsolvesPuzzle\s*\(/g)];
    // Three today: checkForEnd, the ledger overrun, and the log-full branch. A
    // bare count so adding a fourth end point is a deliberate act, not a
    // silent one.
    expect(full.length).toBeGreaterThanOrEqual(3);
  });
});
