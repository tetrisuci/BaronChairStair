/**
 * How a list of alternate solutions is ordered, for both places that list
 * them: the activity's Explore tab and db.tetrisatuci.org's Alternates page.
 *
 * An *alternate* is a line a player found that the game credits — it solved
 * the puzzle, or sent more attack than it asked for — and that still describes
 * the board (`CREDITED` and `LIVE` in `server/discovery-sql.ts`). The maker's
 * own answer and the batch search's lines are never in these lists.
 *
 * Pure and importing nothing, so the game's client, its server and the site's
 * page may all load it (`tests/puzzledb-isolation.test.ts`).
 */

export type AlternateSort = "found" | "difficulty" | "title" | "number" | "attack" | "pieces";
export type SortDirection = "asc" | "desc";

export interface AlternateOrder {
  readonly sort: AlternateSort;
  readonly direction: SortDirection;
}

/** In the order a select offers them. */
export const ALTERNATE_SORTS: readonly AlternateSort[] = [
  "found",
  "difficulty",
  "title",
  "number",
  "attack",
  "pieces",
];

export const ALTERNATE_SORT_LABELS: Readonly<Record<AlternateSort, string>> = {
  found: "Date found",
  difficulty: "Difficulty",
  title: "Puzzle name",
  number: "Puzzle number",
  attack: "Attack",
  pieces: "Pieces",
};

/**
 * The direction a reader expects first: the newest find, the hardest puzzle,
 * the most attack, the shortest line, and names and numbers from the top.
 */
const NATURAL: Readonly<Record<AlternateSort, SortDirection>> = {
  found: "desc",
  difficulty: "desc",
  title: "asc",
  number: "asc",
  attack: "desc",
  pieces: "asc",
};

export function defaultDirection(sort: AlternateSort): SortDirection {
  return NATURAL[sort];
}

export const DEFAULT_ALTERNATE_ORDER: AlternateOrder = { sort: "found", direction: "desc" };

/**
 * What a row must carry to be sorted. Each browser maps its own row onto this.
 *
 * `null` is "not there": an unrated puzzle's difficulty, or the attack and
 * length of a line on a puzzle the reader has not solved, which the activity
 * withholds. Such rows sort last whichever way the list runs, because a
 * missing value is not the smallest one.
 */
export interface SortableAlternate {
  readonly puzzleId: number;
  readonly title: string;
  readonly difficulty: number | null;
  /** When it was found, in any unit that grows with time: a timestamp, a day number. */
  readonly found: number;
  readonly attack: number | null;
  readonly pieces: number | null;
  /** Unique per line and growing with filing order, so equal rows still sort the same way every time. */
  readonly tiebreak: number;
}

function metric(row: SortableAlternate, sort: AlternateSort): number | string | null {
  switch (sort) {
    case "found":
      return row.found;
    case "difficulty":
      return row.difficulty;
    case "title":
      return row.title;
    case "number":
      return row.puzzleId;
    case "attack":
      return row.attack;
    case "pieces":
      return row.pieces;
  }
}

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  }
  return (a as number) - (b as number);
}

function compare(a: SortableAlternate, b: SortableAlternate, order: AlternateOrder): number {
  const x = metric(a, order.sort);
  const y = metric(b, order.sort);
  if (x === null || y === null) {
    if (x !== y) return x === null ? 1 : -1;
  } else {
    const by = compareValues(x, y);
    if (by !== 0) return order.direction === "asc" ? by : -by;
  }
  // A puzzle's lines stay together under a name or number sort, and every tie
  // falls back to the newest find, then the newest filing.
  if (a.puzzleId !== b.puzzleId && (order.sort === "title" || order.sort === "number")) {
    return order.direction === "asc" ? a.puzzleId - b.puzzleId : b.puzzleId - a.puzzleId;
  }
  return b.found - a.found || b.tiebreak - a.tiebreak;
}

/** The rows in `order`. The input is left alone. */
export function sortAlternates<T extends SortableAlternate>(rows: readonly T[], order: AlternateOrder): T[] {
  return rows.toSorted((a, b) => compare(a, b, order));
}

function isSort(value: unknown): value is AlternateSort {
  return typeof value === "string" && (ALTERNATE_SORTS as readonly string[]).includes(value);
}

/**
 * An order read from untrusted text — a query string, a select's value. An
 * unknown sort is the default order; a missing or unknown direction is the
 * sort's natural one.
 */
export function readAlternateOrder(sort: unknown, direction: unknown): AlternateOrder {
  if (!isSort(sort)) return DEFAULT_ALTERNATE_ORDER;
  const dir = direction === "asc" || direction === "desc" ? direction : NATURAL[sort];
  return { sort, direction: dir };
}
