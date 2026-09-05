/**
 * The puzzle data model shared by the build pipeline, the server, and the
 * client. Everything here is plain JSON so a puzzle can be shipped as a static
 * file and re-read without a decoder on the hot path.
 */

/** Piece letters, uppercase everywhere outside the engine. */
export type Mino = "I" | "J" | "L" | "O" | "S" | "T" | "Z";

/** `G` is unclearable-looking garbage from the puzzle author, not real garbage. */
export type BoardCell = Mino | "G" | null;

export const BOARD_WIDTH = 10;
/** Visible rows. Twenty, as on every other Tetris board. */
export const BOARD_HEIGHT = 20;
/**
 * Rows a decoded board is expanded to. Comfortably above `BOARD_HEIGHT` plus
 * the engine's spawn buffer, so a board is never truncated on its way in.
 */
export const ENGINE_ROWS = 40;

/** A named line clear, matching how players talk about them. */
export type ClearName =
  | "single"
  | "double"
  | "triple"
  | "quad"
  | "tss"
  | "tsd"
  | "tst"
  | "tsmini"
  | "spin"
  | "perfect clear";

/**
 * A clear a solve has to make, and how many of it.
 *
 * Lives here rather than in `shared/goal.ts` so that `Puzzle` can name it
 * without importing the parser — the parser needs {@link ClearName} from this
 * file, and the two would otherwise import each other.
 */
export interface ClearRequirement {
  readonly clear: ClearName;
  readonly count: number;
}

/** A board row as ten characters: piece letters, `G` for garbage, `.` for empty. */
export type RowCode = string;

const EMPTY_CELL = ".";

export function encodeRow(cells: readonly BoardCell[]): RowCode {
  return cells.map((cell) => cell ?? EMPTY_CELL).join("");
}

export function decodeRow(row: RowCode): BoardCell[] {
  return Array.from(row, (char) => (char === EMPTY_CELL ? null : (char as BoardCell)));
}

/** Trailing empty rows are dropped; `decodeBoard` pads them back. */
export function encodeBoard(board: readonly (readonly BoardCell[])[]): RowCode[] {
  const rows = board.map(encodeRow);
  while (rows.length > 0 && rows[rows.length - 1] === EMPTY_CELL.repeat(BOARD_WIDTH)) rows.pop();
  return rows;
}

export function decodeBoard(rows: readonly RowCode[], height: number): BoardCell[][] {
  return Array.from({ length: height }, (_, y) =>
    y < rows.length ? decodeRow(rows[y]!) : Array<BoardCell>(BOARD_WIDTH).fill(null),
  );
}

export interface SolutionStep {
  readonly piece: Mino;
  /** The four squares the piece occupies, `[x, y]` with `y = 0` at the floor. */
  readonly cells: readonly (readonly [number, number])[];
  readonly clear: ClearName | null;
  readonly attack: number;
}

/**
 * The first id a puzzle a player wrote may take.
 *
 * The club's sheet runs 1–140 with gaps, and it keeps allocating; a band well
 * clear of it means the two allocators never have to know about each other.
 * The band *is* the record that a puzzle came from a player — there is no
 * column saying so, because the id is already the answer and a second field
 * would be a second thing to keep in step.
 *
 * A collision here would be silent and terrible rather than loud: the archive
 * keys puzzles by id into a Map, so a duplicate resolves cleanly for a lookup
 * while both copies stay in the array the rotation and the rush pool are drawn
 * from — and `runs.puzzle_id` has no foreign key, so two puzzles' play history
 * would merge with nothing to complain. `PuzzleArchive` checks for it at the
 * merge, which is the one place both sources are in the same list.
 */
export const COMMUNITY_ID_BASE = 100_000;

export interface Puzzle {
  readonly id: number;
  readonly title: string;
  readonly author: string;
  /** Author-assigned 1–10+ vibe scale; 0 when the archive has no rating. */
  readonly difficulty: number;
  /** The author's own objective text, e.g. "Clear 2 TSDs". */
  readonly goal: string;
  readonly set: string | null;
  /** Rows bottom-up; `board[0]` is the floor. Trailing empty rows are omitted. */
  readonly board: readonly RowCode[];
  /** Playable pieces in order. The first one starts as the falling piece. */
  readonly queue: readonly Mino[];
  readonly hold: Mino | null;
  /** Garbage the reference solution sends — the score to match. */
  readonly targetAttack: number;
  /**
   * Clears a solve must make, on top of reaching {@link targetAttack}.
   *
   * The bug this exists for: attack alone does not say *how*. A puzzle meaning
   * "3 TSDs" is worth 12, and so are three quads — so the intended line was
   * never the only line, and the archive's own builder already warned authors
   * about it ("The attack target was reached without every clear the goal
   * names", `client/src/ui/builder-test.ts`) with no way to hold them to it.
   *
   * A floor, not an exact multiset: four TSDs satisfy a requirement of three.
   * That is the rule the builder has always shown authors, and a reference
   * solution that happens to make an incidental extra clear stays valid.
   *
   * **Absent and empty mean different things.** `undefined` is "nobody has
   * decided yet" — every puzzle before this field existed. `[]` is "somebody
   * read the goal and no count can hold it", which is the honest answer for
   * "c spin", for orderings, and for the combo and B2B goals the vocabulary
   * cannot express. Both score on attack alone; only one of them is a question
   * still open.
   */
  readonly requiredClears?: readonly ClearRequirement[];
  /**
   * The reference solution, used for the reveal.
   *
   * Optional because it is not shipped in `data/puzzles.json`, which is a file
   * in a public repository: an answer key next to the puzzles is an answer key
   * for anybody. The build writes them to `data/solutions.json`, which is not
   * tracked, and the server merges that in at load if it is there. A checkout
   * without it serves and scores every puzzle exactly as before and simply has
   * no reveal to give.
   */
  readonly solution?: readonly SolutionStep[];
  /** Original blueprint codes, so a puzzle can always be traced to the archive. */
  readonly source?: {
    readonly puzzle: string;
    readonly solution: string;
  };
}

/**
 * A puzzle as it appears in a list, with no board and no answer.
 *
 * Small enough that the whole archive travels in one response, which is what
 * lets the explorer and its filters run entirely in the browser.
 */
export interface ArchiveListing {
  readonly id: number;
  readonly title: string;
  readonly author: string;
  readonly difficulty: number;
  readonly goal: string;
  readonly set: string | null;
  /**
   * Pieces the player actually places, so a filter for short puzzles does not
   * turn up ones that are a piece longer than they claim. The queue alone
   * undercounts every puzzle that starts with something in hold.
   */
  readonly pieces: number;
  readonly targetAttack: number;
  /**
   * Whether a player wrote this one and an officer accepted it.
   *
   * Said out loud rather than left to be re-derived from {@link
   * COMMUNITY_ID_BASE} at each place that cares. It is one boolean against a
   * band check spreading through the explorer, the filter and whatever comes
   * next — and it is the whole player-facing surface of the feature, because
   * `author` already carries the name.
   *
   * It also marks a target that means something different. A club puzzle's
   * `targetAttack` comes from `replayPlacements`, which tries every kick route
   * and keeps the best line; a community one comes from replaying the author's
   * own keystrokes, so it is what a person actually did — provably reachable,
   * and beatable.
   */
  readonly community: boolean;
}

export function toListing(puzzle: Puzzle): ArchiveListing {
  return {
    id: puzzle.id,
    title: puzzle.title,
    author: puzzle.author,
    difficulty: puzzle.difficulty,
    goal: puzzle.goal,
    set: puzzle.set,
    pieces: pieceBudget(puzzle),
    targetAttack: puzzle.targetAttack,
    community: puzzle.id >= COMMUNITY_ID_BASE,
  };
}

/** What the client needs to play. Withholds the answer until the run is over. */
export type PuzzlePrompt = Omit<Puzzle, "solution" | "source">;

export function toPrompt(puzzle: Puzzle): PuzzlePrompt {
  const { solution: _solution, source: _source, ...prompt } = puzzle;
  return prompt;
}

/**
 * Whether a run cleared the puzzle's bar.
 *
 * One definition, imported by the client that shows the verdict and the server
 * that records it. Rush counts solves, so a rush and a daily disagreeing about
 * whether the same replayed run counted would be a scoring bug, not a rounding
 * one.
 */
export function meetsTarget(attack: number, targetAttack: number): boolean {
  return attack >= targetAttack;
}

/**
 * How far each required clear still has to go. Empty when the goal is met.
 *
 * Returns the shortfall rather than a boolean because every caller that needs
 * the boolean also needs the reason: the runner decides whether to end the run,
 * the results panel has to say which clear is missing, and a bare `false` sends
 * both of them back to recount it.
 *
 * A floor — `made >= wanted` — so extra clears never fail a solve. Counting is
 * by name only: a `tsmini` is not a `tsd`, which is the engine's own
 * distinction and the one place this disagrees with how some authors write.
 */
export function clearShortfall(
  made: readonly ClearName[],
  required: readonly ClearRequirement[] = [],
): ClearRequirement[] {
  if (required.length === 0) return [];
  const counted = new Map<ClearName, number>();
  for (const clear of made) counted.set(clear, (counted.get(clear) ?? 0) + 1);
  return required
    .map((entry) => ({ clear: entry.clear, count: entry.count - (counted.get(entry.clear) ?? 0) }))
    .filter((entry) => entry.count > 0);
}

/**
 * The whole solve condition: the attack target *and* every clear the goal names.
 *
 * The single place that answers "is this solved", so the client's run loop and
 * the four server verdicts cannot drift apart. They did drift, in a smaller
 * way, before this existed: the client ended a run on attack alone, which is
 * why enforcing clears on the server without this function would have made the
 * affected puzzles unsolvable rather than stricter — the run finished before
 * the player could make the clear being demanded.
 */
export function solvesPuzzle(
  attack: number,
  clears: readonly ClearName[],
  puzzle: Pick<Puzzle, "targetAttack" | "requiredClears">,
): boolean {
  return (
    meetsTarget(attack, puzzle.targetAttack) &&
    clearShortfall(clears, puzzle.requiredClears).length === 0
  );
}

/** Total pieces a player may place — the queue, plus anything pre-held. */
export function pieceBudget(puzzle: Pick<Puzzle, "queue" | "hold">): number {
  return puzzle.queue.length + (puzzle.hold ? 1 : 0);
}
