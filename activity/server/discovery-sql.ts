/**
 * The two SQL clauses that say which alternate lines count, for every reader
 * that counts them.
 *
 * Moved out of `server/db.ts` so that db.tetrisatuci.org runs the very string
 * the game's Discoveries board runs. The site may not import `server/db.ts` —
 * `tests/puzzledb-isolation.test.ts` forbids it, because constructing `Store`
 * migrates the file it opens — and a site with its own spelling of the rule
 * would publish counts the game's board contradicts on the first row the two
 * spellings disagreed about.
 *
 * Strings and nothing else: no import, no handle, nothing that runs. That is
 * what lets the isolation test allow this file into the site's runtime.
 */

/**
 * What a row has to be for its finder to be paid for it, as one clause.
 *
 * Written once because the board and a player's own standing must agree
 * exactly: a rank counted under a different predicate from the board it is a
 * rank *in* is not wrong in some rare case, it is wrong whenever they differ.
 * Every query using it aliases `puzzle_solutions` as `s`.
 *
 * The last clause is `countsAsAlternate` in SQL — solved it, *or* sent more
 * attack than it was asked for. `tests/alternate-solution.test.ts` runs the
 * function and this string against one table of cases, because a board cannot
 * call the function per row and two spellings of one rule drift.
 *
 * `attack > target_attack` is NULL, and so false, on a row filed before that
 * column existed. Those fall back to the solve, which is what they were
 * credited on when they were written — the honest answer rather than a
 * backfilled guess at a target that may since have moved.
 *
 * Note what is absent: `voided_at`. Credit outlives the board it was earned on
 * — see the column.
 */
export const CREDITED =
  "s.source = 'player' AND s.found_by IS NOT NULL " +
  "AND (s.solved_strict = 1 OR s.attack > s.target_attack)";

/**
 * The live rows: the ones still describing a board that exists.
 *
 * Unaliased, so a reader writes `s.${LIVE}` where it aliases the table and the
 * bare clause where it does not — which is how every query in `server/db.ts`
 * already uses it.
 */
export const LIVE = "voided_at IS NULL";
