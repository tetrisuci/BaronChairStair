/**
 * Turning two spreadsheet rows into a verified `Puzzle`.
 *
 * Extracted from `build-puzzles.ts` unchanged, because a second caller needs it:
 * `sync-archive.ts` writes the same puzzles into the database instead of into a
 * file, and the two must agree exactly. `build-puzzles.ts` calls `main()` at
 * module scope and exported nothing, so importing from it would have run a
 * whole build as a side effect of asking for one function.
 *
 * The important thing this module owns is the verification, not the decoding:
 * `buildPuzzle` replays the author's answer through the real engine and takes
 * what it actually sends as the puzzle's target. A puzzle whose answer will not
 * replay throws here, and a puzzle with no verified target is one nobody can be
 * scored against. Both callers depend on that throw.
 *
 * **Columns are read by position, not by header name.** That is inherited
 * rather than chosen — a column inserted into either tab shifts every field
 * after it, silently. The indices each function reads are named in its comment
 * so the damage is at least greppable.
 */

import { decodeBlueprint } from "../shared/blueprint/decode";
import { type CellType, pieceCells, type Playfield } from "../shared/blueprint/playfield";
import {
  type BoardCell,
  encodeBoard,
  type Mino,
  type Puzzle,
  requirementFromSolution,
  type SolutionStep,
} from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { replayPlacements } from "../shared/tetris/replay";
import { alignPlacements } from "./align-placements";

/** The tab holding the blueprint code pair. Columns: 0 id, 1 puzzle, 2 answer, 4 title. */
export const CODES_SHEET = "Copy of Puzzles Archive - blueprint urls.csv";
/**
 * The tab holding the metadata.
 * Columns: 0 id, 1 title, 2 difficulty, 3 creator, 4 creation date, 7 set,
 * 8 solve count.
 */
export const META_SHEET = "Copy of Puzzles Archive - Puzzles.csv";

/** Row lookup keyed by puzzle id, tolerating the archive's stray whitespace. */
export function indexById(rows: string[][]): Map<number, string[]> {
  const byId = new Map<number, string[]>();
  for (const row of rows) {
    const id = Number.parseInt(row[0]?.trim() ?? "", 10);
    if (Number.isFinite(id)) byId.set(id, row.map((cell) => cell.trim()));
  }
  return byId;
}

export function toBoardCells(playfield: Playfield): BoardCell[][] {
  return playfield.toRows(playfield.stackHeight).map((row) =>
    row.map((cell) => {
      if (cell === null) return null;
      // 'u' marks the wall outside the field and never appears inside a puzzle.
      return cell === "g" ? "G" : cell === "u" ? null : (cell as Mino);
    }),
  );
}

export interface DecodedPosition {
  board: BoardCell[][];
  queue: Mino[];
  hold: Mino | null;
  goal: string;
}

export function decodePosition(code: string): DecodedPosition {
  const page = decodeBlueprint(code).pages[0];
  if (!page) throw new Error("Blueprint decoded to no pages");
  if (!page.piece) throw new Error("Position has no active piece to start from");
  return {
    board: toBoardCells(page.playfield),
    queue: [page.piece.type, ...page.queue.previews],
    hold: page.queue.hold,
    goal: page.comment.trim(),
  };
}

/** Only locked pages are placements; the rest are editor snapshots. */
export function decodeAnswerPlacements(code: string) {
  return decodeBlueprint(code)
    .pages.filter((page) => page.locked && page.piece !== null)
    .map((page) => ({
      piece: page.piece!.type,
      cells: pieceCells(page.piece!).map(({ x, y }) => [x, y] as const),
    }));
}

/** Every cell the playfield holds on this page, keyed "x,y", with its type. */
function settled(playfield: Playfield): Map<string, CellType> {
  const cells = new Map<string, CellType>();
  playfield.toRows(playfield.stackHeight).forEach((row, y) =>
    row.forEach((cell, x) => {
      if (cell) cells.set(`${x},${y}`, cell as CellType);
    }),
  );
  return cells;
}

/**
 * The same placements, plus any the author committed without locking the page.
 *
 * Puzzle #115 "twirl" records its first piece as a playfield commit on the page
 * after it lands, with no `locked` flag anywhere. Reading only locked pages
 * dropped it, so the puzzle shipped a one-piece answer clearing two rows instead
 * of the author's two-piece line clearing three — a `tsd` where the goal says
 * TST — and since `requiredClears` is derived from the answer, it froze the
 * wrong rule.
 *
 * A page that gains exactly four settled cells and loses none is read as a
 * commit, credited to the piece falling on the page before it. Losing none is
 * what keeps a line clear out of it: a clear rewrites the playfield, and
 * anything that both gains and loses is the board moving under itself.
 *
 * **This is a fallback and not the rule, and it is lossy.** On a puzzle that
 * clears rows repeatedly, a locked page's cells reappear *shifted* in a later
 * playfield, get claimed as a commit, and then suppress the locked page they
 * came from. Measured: it returns 68 placements for #112 where the locked pages
 * give 73, and is short by one on #24, #25, #127 and #133 too.
 *
 * So it is only ever consulted, never trusted. {@link buildPuzzle} takes it only
 * when it is *longer* than the locked-page reading — which is what a dropped
 * placement looks like and what losing one cannot — and then only when it
 * reproduces the blueprint's own final board. Both hold for #115 alone across
 * the archive.
 */
export function decodeCommittedPlacements(code: string) {
  const pages = decodeBlueprint(code).pages;
  const placements: { piece: Mino; cells: readonly (readonly [number, number])[] }[] = [];
  const claimed = new Set<string>();
  const key = (cells: readonly string[]) => [...cells].sort().join(" ");
  let previous = pages.length > 0 ? settled(pages[0]!.playfield) : new Set<string>();

  pages.forEach((page, index) => {
    if (index > 0) {
      const now = settled(page.playfield);
      const gained = [...now.keys()].filter((cell) => !previous.has(cell));
      const lost = [...previous.keys()].filter((cell) => !now.has(cell));
      const fell = pages[index - 1]?.piece?.type;
      // The four cells must all carry the falling piece's own type. Without it
      // any four cells an author paints — garbage, a hand-drawn wall — read as a
      // placement of whatever happened to be hovering, at a seat they never put
      // it, and that phantom step reaches the reveal and the frozen requirement.
      // The archive already stores the type; #115's four gained cells are all
      // "L" and the page before it is falling an L.
      const allFell = gained.length > 0 && gained.every((cell) => now.get(cell) === fell);
      if (gained.length === 4 && lost.length === 0 && fell && allFell && !claimed.has(key(gained))) {
        claimed.add(key(gained));
        placements.push({
          piece: fell,
          cells: gained.map((cell) => {
            const [x, y] = cell.split(",");
            return [Number(x), Number(y)] as const;
          }),
        });
      }
      previous = now;
    }
    if (page.locked && page.piece !== null) {
      const cells = pieceCells(page.piece).map(({ x, y }) => [x, y] as const);
      const seat = key(cells.map(([x, y]) => `${x},${y}`));
      if (!claimed.has(seat)) {
        claimed.add(seat);
        placements.push({ piece: page.piece.type, cells });
      }
    }
  });

  return placements;
}

/** The board the author's blueprint ends on, as a row count. */
export function terminalStackHeight(code: string): number | null {
  const pages = decodeBlueprint(code).pages;
  return pages.length > 0 ? pages[pages.length - 1]!.playfield.stackHeight : null;
}

export interface BuildFailure {
  id: number;
  reason: string;
}

/**
 * How tall the board stands once an answer has been replayed.
 *
 * Highest occupied row, exclusive — the same measure `Playfield.stackHeight`
 * reports, because the two are compared. Counting *non-empty rows* instead is
 * a different number the moment a board has a gap under an overhang, and the
 * archive has one such board today (#34 finishes four filled rows tall with its
 * highest at seven).
 */
function boardHeight(replay: { steps: readonly { board: BoardCell[][] }[] }): number {
  const last = replay.steps[replay.steps.length - 1]?.board;
  if (!last) return 0;
  let highest = 0;
  last.forEach((row, y) => {
    if (row.some((cell) => cell !== null)) highest = y + 1;
  });
  return highest;
}

export function buildPuzzle(
  id: number,
  codes: string[],
  meta: string[] | undefined,
): Puzzle {
  const position = decodePosition(codes[1] ?? "");
  const answerCode = codes[2] ?? "";
  if (!answerCode) throw new Error("No answer blueprint on file");

  const recorded = decodeAnswerPlacements(answerCode);
  if (recorded.length === 0) throw new Error("Answer blueprint places no pieces");
  const placements = alignPlacements(recorded, position.queue, position.hold);
  if (placements.length === 0) {
    throw new Error("No placement in the answer can be reached with the puzzle's pieces");
  }

  const setup = { board: position.board, queue: position.queue, hold: position.hold };
  let replay = replayPlacements(setup, DEFAULT_HANDLING, placements);

  /*
   * The blueprint's own last page is the oracle for whether the reading above is
   * complete. A locked-page reading that leaves the board taller than the author
   * left it has dropped a placement — #115 "twirl" drops its first piece and
   * ships a `tsd` where the goal says TST.
   *
   * Two conditions, because the fallback is lossy in the other direction: on a
   * clear-heavy blueprint it *drops* placements (68 against 73 on #112). So it
   * must be longer than the locked-page reading — a recovered drop can only add
   * — and it must land on the author's own final board. Across the archive that
   * pair selects exactly one puzzle, which is #115.
   */
  const ended = terminalStackHeight(answerCode);
  if (ended !== null && boardHeight(replay) !== ended) {
    try {
      const withCommits = alignPlacements(
        decodeCommittedPlacements(answerCode),
        position.queue,
        position.hold,
      );
      if (withCommits.length > placements.length) {
        const better = replayPlacements(setup, DEFAULT_HANDLING, withCommits);
        if (boardHeight(better) === ended) replay = better;
      }
    } catch {
      // A reading that will not replay is simply not the better one. The
      // locked-page answer stands, exactly as it did before this existed.
    }
  }

  if (replay.totalAttack === 0) throw new Error("Answer sends no attack — nothing to score");

  const solution: SolutionStep[] = replay.steps.map((step) => ({
    piece: step.piece,
    cells: step.cells.map(([x, y]) => [x, y] as const),
    clear: step.clear,
    attack: step.attack,
  }));

  const difficulty = Number.parseFloat(meta?.[2] ?? "");
  return {
    id,
    title: (meta?.[1] || codes[4] || `Puzzle ${id}`).trim(),
    author: (meta?.[3] || "unknown").trim(),
    difficulty: Number.isFinite(difficulty) ? difficulty : 0,
    goal: position.goal,
    set: meta?.[7]?.trim() || null,
    board: encodeBoard(position.board),
    queue: position.queue,
    hold: position.hold,
    targetAttack: replay.totalAttack,
    // Read off the replay that just happened, which is the club's rule: the
    // maker's title and goal stay as written, and what is enforced is what their
    // own answer does. Derived here rather than by a later pass so every
    // consumer of a built puzzle — the sheet sync, the JSON build, the audit —
    // sees the same rule without joining across files by id.
    requiredClears: requirementFromSolution(solution, id),
    solution,
    source: { puzzle: codes[1] ?? "", solution: answerCode },
  };
}

/** Archive bookkeeping off the metadata tab: not gameplay, but the club's record. */
export interface ArchiveMeta {
  /** The sheet's creation date, as written. Null when the cell is empty. */
  readonly addedOn: string | null;
  /** The club's recorded solve count. Null when absent or unparseable. */
  readonly solveCount: number | null;
}

/**
 * The sheet writes dates as `M/D/YY`. Everything downstream wants one format,
 * and the website already stores ISO, so the normalising happens once here
 * rather than in each consumer. Anything that does not parse is passed through
 * untouched rather than guessed at — a date nobody can read is better than a
 * date read wrongly.
 */
function toIsoDate(raw: string): string {
  const parts = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw);
  if (!parts) return raw;
  const [, month, day, year] = parts;
  const full = year!.length === 2 ? `20${year}` : year!;
  return `${full}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
}

/** Reads columns 4 and 8, which `buildPuzzle` has no use for. */
export function archiveMetaOf(meta: string[] | undefined): ArchiveMeta {
  const added = meta?.[4]?.trim();
  const solves = Number.parseInt(meta?.[8]?.trim() ?? "", 10);
  return {
    addedOn: added ? toIsoDate(added) : null,
    solveCount: Number.isFinite(solves) ? solves : null,
  };
}
