/**
 * Filing what a player actually did, so the archive learns from being played.
 *
 * Every solved run already carries everything a solution row needs — the
 * placements the server derived, the log they were derived from, and the score
 * the engine gave them. This is the small decision of which of those to keep
 * and what to tell the player about it.
 *
 * The two readers pull in opposite directions and both are served by keeping
 * *more* than the leaderboard pays for. A player is credited for a line nobody
 * had recorded that either solved the puzzle or sent more attack than it asked
 * for — `countsAsAlternate`. A maker needs the rest as well: a line that met
 * the target exactly while missing the required clears is the exact evidence
 * that a condition says less than its sentence does. So both are filed, and
 * `solvedStrict` is the stored fact that tells them apart.
 */

import type { Store } from "./db";
import { SOLUTION_KEY_VERSION, solutionFingerprint } from "../shared/solution-key";
import { contentHash } from "./archive-rows";
import { shapeKey } from "./puzzles";
import type { ClearName } from "../shared/puzzle";
import {
  countsAsAlternate,
  meetsTarget,
  solvesPuzzle,
  type Puzzle,
  type SolutionStep,
} from "../shared/puzzle";
import type { InputEvent } from "../shared/tetris/verify";
import type { VerifiedRun } from "../shared/tetris/verify";
import type { Handling } from "../shared/tetris/handling";

/** What the player is told about the line they just played. */
export interface Discovery {
  /**
   * Nobody had recorded this line before **and** it will be credited.
   *
   * Both halves, because the board does not pay for everything that is filed.
   * A run that reached the target without the clears the goal names, and
   * without beating the target either, is still filed — it is the evidence a
   * maker needs — but telling that player "nobody had solved it this way" would
   * promise a place on a board that filters it out, and they would go looking
   * for a name that never appears. See `countsAsAlternate`.
   */
  readonly isNew: boolean;
  /** Distinct lines on record for this puzzle, including this one. */
  readonly known: number;
}

export interface Finder {
  readonly playerId: string;
  readonly guildId: string | null;
}

/**
 * Puts the archive's own answer on record, so nobody can discover it.
 *
 * `recordDiscovery` decides "nobody had found this line before" by fingerprint
 * novelty alone, and the intended solution was never written down. The first
 * player to solve a puzzle *the way its maker did* therefore collided with
 * nothing and was credited with finding an alternate — on every puzzle, once —
 * while the "N distinct lines" count they were shown was one too high.
 *
 * `SolutionSource` has carried a `reference` case since the table existed and
 * `discoveryBoard` already excludes it by name. This is the producer that was
 * missing. Filed with no `foundBy`, so no board can pay for it.
 *
 * Idempotent by construction: `recordSolution` is `ON CONFLICT DO NOTHING` over
 * `(puzzle_id, canonical_key)`, so this may run on every boot. That also makes it
 * self-healing after a creator edits a puzzle — the new answer keys differently
 * and is seeded on the next start, beside the old one, which is correct: the line
 * the previous answer described was still a real line on the previous board, and
 * `voidDiscoveries` is what settles the credit for it.
 *
 * **Only where the answers are.** `data/solutions.json` is untracked, so on an
 * ordinary deploy box every club puzzle arrives without its `solution` and there
 * is nothing to seed. Those are counted and skipped rather than throwing: a boot
 * that dies over a missing answer key would be a far worse failure than a
 * discovery credited to the wrong person.
 */
export function seedReferenceSolutions(
  store: Store,
  puzzles: readonly Puzzle[],
): { seeded: number; skipped: number } {
  let seeded = 0;
  let skipped = 0;

  for (const puzzle of puzzles) {
    const versionHash = contentHash(puzzle);
    const versionShape = shapeKey(puzzle);
    store.stampMissingSolutionVersions(puzzle.id, versionHash, versionShape);
    const answer = puzzle.solution;
    if (!answer?.length) {
      skipped += 1;
      continue;
    }

    const placements: SolutionStep[] = answer.map((step) => ({
      piece: step.piece,
      cells: step.cells,
      clear: step.clear,
      attack: step.attack,
    }));
    const clears = placements.flatMap((step) => (step.clear ? [step.clear] : []));
    const attack = placements.reduce((total, step) => total + (step.attack ?? 0), 0);

    try {
      const key = solutionFingerprint(placements, { attack, clears });
      const { discovered } = store.recordSolution({
        puzzleId: puzzle.id,
        canonicalKey: key,
        keyVersion: SOLUTION_KEY_VERSION,
        placements,
        // Nothing was played, so there are no keystrokes to re-prove it from —
        // the same shape the batch enumerator files under.
        events: null,
        handling: null,
        attack,
        targetAttack: puzzle.targetAttack,
        clears,
        // Computed rather than assumed. It is true for every puzzle the current
        // scheme builds, because the requirement is derived from this very
        // answer — but a row restored from before that scheme need not be, and a
        // seed that lied here would put a non-solve on the board.
        solvedStrict: solvesPuzzle(attack, clears, puzzle),
        source: "reference",
        foundBy: null,
        guildId: null,
        contentHash: versionHash,
        puzzleShape: versionShape,
      });
      store.stampSolutionVersion(puzzle.id, key, versionHash, versionShape);
      if (discovered) seeded += 1;
      // After the insert, never before: a delete that ran first would leave the
      // puzzle with no reference at all if the insert then threw.
      store.dropStaleReferences(puzzle.id, key);
    } catch (error) {
      // One unwritable row is not worth a boot. Reported, because a store that
      // cannot write is a real fault somebody has to be able to find.
      console.error(
        `[discovery] could not seed the reference solution for puzzle ${puzzle.id}: ${String(error)}`,
      );
    }
  }

  return { seeded, skipped };
}

/**
 * Records a run as a solution, if it is one worth recording.
 *
 * The bar is the *attack* target rather than the whole goal, deliberately. A
 * run that hits the number but misses the required clears is not a solve and is
 * never credited — but it is precisely what a maker is looking for, and
 * throwing it away here would mean the only way to find those is to go looking
 * with the enumerator. Filed either way; `solvedStrict` decides who gets paid.
 *
 * Returns null when there is nothing to file, so the caller can leave the
 * response shape alone rather than reporting a discovery of nothing.
 */
export function recordDiscovery(
  store: Store,
  puzzle: Puzzle,
  verified: VerifiedRun,
  events: readonly InputEvent[],
  handling: Handling,
  finder: Finder,
): Discovery | null {
  if (verified.placements.length === 0) return null;
  if (!meetsTarget(verified.attack, puzzle.targetAttack)) return null;

  const placements: SolutionStep[] = verified.placements.map((placement) => ({
    piece: placement.piece,
    cells: placement.cells,
    clear: placement.clear,
    attack: placement.attack,
  }));
  const outcome = { attack: verified.attack, clears: verified.clears };
  // Stored as the fact it is: did this line make the clears the goal named.
  // `solutionCounts` reports the ones that did not, which is a maker's view of
  // whether a condition says less than its sentence does.
  const meetsGoal = solvesPuzzle(verified.attack, verified.clears, puzzle);
  // What the *board* will pay for, which is a wider bar than the solve: a line
  // that sent more attack than the puzzle asked for is a find too. This is the
  // one the player is told about, so `isNew` promises exactly the credit
  // `discoveryBoard` is about to hand out.
  const credited = countsAsAlternate(verified.attack, verified.clears, puzzle);

  // Nothing here may cost a player the run they just earned. The run is already
  // recorded by the time this is called, so a throw would take the *response*
  // down while the row stands — the player sees an error, loses the verdict,
  // the solution and the leaderboard that came with it, and is told nothing
  // about a run that in fact counted. A discovery is a nicety on top of that;
  // it is never worth the run.
  //
  // Caught here rather than at the call site so every future caller inherits
  // it, and reported rather than swallowed: a store that cannot write is a real
  // fault and somebody has to be able to find it.
  let discovered = false;
  try {
    discovered = store.recordSolution({
      puzzleId: puzzle.id,
      canonicalKey: solutionFingerprint(placements, outcome),
      keyVersion: SOLUTION_KEY_VERSION,
      placements,
      // The log, so the line can be re-proved later through `verifyRun` — the
      // same path that trusted it in the first place. Replaying the placements
      // instead would reject the cleverest discoveries, which is why
      // `server/review-routes.ts` already refuses to do that.
      events,
      handling,
      attack: verified.attack,
      targetAttack: puzzle.targetAttack,
      clears: verified.clears,
      solvedStrict: meetsGoal,
      source: "player",
      foundBy: finder.playerId,
      guildId: finder.guildId,
      contentHash: contentHash(puzzle),
      puzzleShape: shapeKey(puzzle),
    }).discovered;
  } catch (error) {
    console.error(
      `[discovery] could not record a solution to puzzle ${puzzle.id}: ${String(error)}`,
    );
    return null;
  }

  try {
    return {
      isNew: discovered && credited,
      known: store.countSolutions(puzzle.id, shapeKey(puzzle)),
    };
  } catch (error) {
    // The row is written; only the count failed. Say what is true rather than
    // discarding a discovery that happened.
    console.error(`[discovery] could not count solutions for puzzle ${puzzle.id}: ${String(error)}`);
    return { isNew: discovered && credited, known: 0 };
  }
}

/** One line as a profile lists it. */
export interface ProfileLine {
  readonly puzzleId: number;
  readonly title: string;
  readonly attack: number | null;
  readonly clears: readonly ClearName[];
  readonly foundAt: number;
  readonly voided: boolean;
  readonly openable: boolean;
}

/**
 * What a profile may say about the lines its subject found.
 *
 * Two different questions, and conflating them is how the first version of this
 * leaked. `openable` is about the *click*: may this reader step this line on a
 * board. `attack` and `clears` are the line's **content** — what it sent and
 * what it made — and shipping those to somebody who has not solved the puzzle
 * is precisely the disclosure the click is gated against. So a shut row carries
 * neither.
 *
 * A pure function, and exported, because the rule was previously inline in the
 * route: seeding a discovery for a route test means opening a second Store on
 * the database the app already holds, so the invariant had nowhere it could be
 * checked and was checked nowhere.
 *
 * @param cleared puzzles the *reader* has solved — not the finder.
 */
export function profileLines(
  rows: readonly {
    puzzleId: number;
    attack: number;
    clears: ClearName[];
    foundAt: number;
    voided: boolean;
  }[],
  titleOf: (puzzleId: number) => string | null,
  cleared: ReadonlySet<number>,
): ProfileLine[] {
  return rows.map((row) => {
    const title = titleOf(row.puzzleId);
    const openable = !row.voided && title !== null && cleared.has(row.puzzleId);
    return {
      puzzleId: row.puzzleId,
      title: title ?? "",
      attack: openable ? row.attack : null,
      clears: openable ? row.clears : [],
      foundAt: row.foundAt,
      voided: row.voided,
      openable,
    };
  });
}
