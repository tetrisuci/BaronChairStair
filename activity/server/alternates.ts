/**
 * What the alternate solutions list may tell one reader about each line.
 *
 * The list is every alternate on file, across every puzzle (`liveAlternates`
 * in `server/db.ts`). This decides, per line, how much of it a given reader
 * gets — and the answer comes in three sizes, not two:
 *
 * - **Nothing at all**, for a puzzle `maySeeSolution` refuses: one of today's
 *   tiers this reader has not solved, or a duel round they are in. Even a shut
 *   row would say "somebody found another way through the board you are about
 *   to be scored on", and how many somebodies, which is a hint — so the puzzle
 *   is not in the list.
 * - **The fact of it**, for a puzzle they have not solved: which puzzle, who
 *   found the line and when. Not what it sent, how long it was or what it
 *   cleared: those are the line's content, and on a short puzzle they are most
 *   of the answer. This is the profile's rule (`profileLines` in
 *   `server/discoveries.ts`), applied for the same reason.
 * - **All of it**, once they have solved the puzzle — the gallery's own gate
 *   (`hasCleared`), so a row that shows its stats is a row whose click the
 *   gallery will honour.
 *
 * A pure function, like `profileLines`, so the rule can be checked without a
 * route and a seeded database (`tests/alternates.test.ts`).
 */

import type { ClearName } from "../shared/puzzle";
import type { AlternateLine, PlayerProfile } from "./db";

/** What the list needs to know about a puzzle; `null` when this box has no such puzzle. */
export interface AlternatePuzzle {
  readonly title: string;
  /** The archive's spelling: 0 is unrated. */
  readonly difficulty: number;
  readonly set: string | null;
}

/**
 * One row of `GET /api/alternates`. Mirrored as `AlternateRow` in
 * `client/src/api.ts`.
 *
 * `attack`, `pieces` and `clears` are null exactly when `locked` is true.
 * `solutionId` is sent either way: it is the row's key and its tiebreak, and it
 * says nothing about the line beyond that it exists, which the row already does.
 */
export interface AlternateRow {
  readonly solutionId: number;
  readonly puzzleId: number;
  readonly title: string;
  /** Null for an unrated puzzle, so a sort can put it last rather than easiest. */
  readonly difficulty: number | null;
  readonly set: string | null;
  readonly finder: PlayerProfile | null;
  readonly foundAt: number;
  /** The reader has not solved this puzzle, so the line's content is withheld. */
  readonly locked: boolean;
  readonly attack: number | null;
  readonly pieces: number | null;
  readonly clears: readonly ClearName[] | null;
}

/**
 * @param puzzleOf the archive's entry for an id, or null when there is none —
 *   a line on a puzzle this box does not have has no title and nothing to open.
 * @param maySee whether this reader may know anything about a puzzle's
 *   solutions today (`maySeeSolution`). Asked once per puzzle, not per line.
 * @param cleared puzzles the *reader* has solved — not the finder.
 * @returns the rows in the order the lines were given.
 */
export function alternateRows(
  lines: readonly AlternateLine[],
  puzzleOf: (puzzleId: number) => AlternatePuzzle | null,
  maySee: (puzzleId: number) => boolean,
  cleared: ReadonlySet<number>,
): AlternateRow[] {
  const seeable = new Map<number, boolean>();
  const mayList = (puzzleId: number): boolean => {
    const known = seeable.get(puzzleId);
    if (known !== undefined) return known;
    const answer = maySee(puzzleId);
    seeable.set(puzzleId, answer);
    return answer;
  };

  return lines.flatMap((line) => {
    const puzzle = puzzleOf(line.puzzleId);
    if (!puzzle || !mayList(line.puzzleId)) return [];
    const locked = !cleared.has(line.puzzleId);
    return [
      {
        solutionId: line.solutionId,
        puzzleId: line.puzzleId,
        title: puzzle.title,
        difficulty: puzzle.difficulty > 0 ? puzzle.difficulty : null,
        set: puzzle.set,
        finder: line.finder,
        foundAt: line.foundAt,
        locked,
        attack: locked ? null : line.attack,
        pieces: locked ? null : line.pieces,
        clears: locked ? null : line.clears,
      },
    ];
  });
}
