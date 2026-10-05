/**
 * How the puzzle database orders the rows of a board, and why it is not the
 * obvious way.
 *
 * The obvious way is to sort by the board's measure and let ties fall where
 * they fall. Where they fall is SQLite's choice: a `GROUP BY player_id` hands
 * its groups back in id order, and a stable sort keeps it. So two players tied
 * on a board would be published in the order of their Discord ids — which is
 * the order they joined Discord — and two hidden players' rows, each labelled
 * only "a player", would carry that order across every board they share. Rank
 * would become a quiet channel for the very thing the site never publishes.
 *
 * The rule instead is a **total order over published columns only**: the
 * board's own keys, then the name as a reader sees it (case-folded, and a
 * player who hid after every shown one), then every remaining published column
 * of the row in a fixed order. Two rows that still compare equal are equal in
 * every column the site prints, so whichever comes first, the bytes are the
 * same. `tests/puzzledb-players-dataset.test.ts` builds a board forwards and
 * backwards and compares the downloads byte for byte.
 *
 * The rank stored is the row's place in that order — every board's key is
 * `(…, rank)`, so it must be unique. Equal measures showing an equal rank is
 * the page's job, which can see the measures beside it.
 *
 * Text compares by UTF-16 code unit, never `localeCompare`: an ICU update is
 * allowed to reorder two names, and an order that changes under a runtime
 * upgrade would move ranks on a board nobody played.
 */

import type { SnapshotPlayer } from "./types";

/** Negative when `a` goes first, as `Array.prototype.sort` takes. */
export type Order<T> = (a: T, b: T) => number;

/** Code-unit order: the same in every runtime and every year. */
export function textOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Smaller first, a null after every number. */
export function ascending<T>(of: (row: T) => number | null): Order<T> {
  return (a, b) => {
    const x = of(a);
    const y = of(b);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return x - y;
  };
}

/** Larger first, a null after every number. */
export function descending<T>(of: (row: T) => number | null): Order<T> {
  const up = ascending(of);
  return (a, b) => {
    const x = of(a);
    const y = of(b);
    if (x === null || y === null) return up(a, b);
    return y - x;
  };
}

/** By text, a null after every string. */
export function byText<T>(of: (row: T) => string | null): Order<T> {
  return (a, b) => {
    const x = of(a);
    const y = of(b);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return textOrder(x, y);
  };
}

/**
 * By the name a reader sees: case-folded first, so `alice` and `Bob` read in
 * the order a person would put them, then exactly, then by key, which two
 * shown players never share. A player who hid comes after every shown one.
 */
export function byPlayer<T extends SnapshotPlayer>(): Order<T> {
  return then(
    byText((row: T) => row.name?.toLowerCase() ?? null),
    byText((row: T) => row.name),
    byText((row: T) => row.playerKey),
  );
}

/** The first order that tells two rows apart. */
export function then<T>(...orders: readonly Order<T>[]): Order<T> {
  return (a, b) => {
    for (const order of orders) {
      const found = order(a, b);
      if (found !== 0) return found;
    }
    return 0;
  };
}

/** A sorted copy, each row paired with its 1-based place. */
export function ranked<T>(rows: readonly T[], order: Order<T>): { readonly rank: number; readonly row: T }[] {
  return rows.toSorted(order).map((row, at) => ({ rank: at + 1, row }));
}

/** Rows grouped by a key, in the order the keys first appear; each group keeps its rows' order. */
export function groupedBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}
