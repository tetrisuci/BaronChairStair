/**
 * One board for the whole day, not one per difficulty.
 *
 * Three boards meant clicking between three, which asks the reader to hold two
 * of them in their head to answer the only question they came with: how did my
 * server do today, and where am I in it. So everybody appears once, with what
 * they did to each of the three beside their name.
 *
 * Ranked by how many they solved and then by how long it took, which is the
 * order rush already uses. Time alone would put somebody who solved nothing at
 * the very top, on a total of zero.
 */

import type { DayBoardRow, RushRun } from "../api";
import { DAILY_TIERS, type DailyTier } from "@shared/daily";
import { el, formatDuration, panel, replaceChildren } from "./dom";

export interface DailyBoard {
  readonly element: HTMLElement;
  update(board: readonly DayBoardRow[], rush: readonly RushRun[], selfId: string): void;
}

interface Row extends DayBoardRow {
  /** Puzzles cleared in today's rush, or null if they never ran one. */
  readonly rush: number | null;
}

/**
 * Attaches today's rush to the day's board.
 *
 * The daily merge is the server's — one grouping, one limit — and this only
 * folds rush in beside it, because rush lives in another table with a limit of
 * its own. It can add rows as well as fill them in: somebody who spent their
 * day on rush has no daily row at all, and is not somebody who did nothing.
 *
 * The daily still decides the order and rush only breaks ties. Three puzzles
 * chosen for you and as many as you can take in five minutes are not the same
 * unit, and summing them would say they are.
 */
export function withRush(
  board: readonly DayBoardRow[],
  rush: readonly RushRun[] = [],
): Row[] {
  const rows = new Map<string, Row>(
    board.map((entry) => [entry.player.id, { ...entry, rush: null }]),
  );
  for (const run of rush) {
    const found = rows.get(run.player.id);
    const best = Math.max(found?.rush ?? 0, run.solved);
    rows.set(
      run.player.id,
      found
        ? { ...found, rush: best }
        : { player: run.player, solved: 0, totalMs: 0, marks: {}, rush: best },
    );
  }
  return [...rows.values()].sort(
    (a, b) => b.solved - a.solved || a.totalMs - b.totalMs || (b.rush ?? -1) - (a.rush ?? -1),
  );
}

/** Solved, tried and failed, and never opened are three different days. */
function mark(row: Row, tier: DailyTier): HTMLElement {
  const state = tier in row.marks ? (row.marks[tier] ? "on" : "off") : "none";
  return el("span", {
    class: `board__mark board__mark--${state}`,
    title: `${tier}: ${state === "on" ? "solved" : state === "off" ? "not solved" : "not played"}`,
  });
}

export function createDailyBoard(): DailyBoard {
  const note = el("p", { class: "note", text: "" });
  // `board-list` is what caps the height and scrolls; without it every row
  // renders inline and pushes the rest of the card off the bottom.
  const rows = el("div", { class: "board-list" });
  const element = panel("Leaderboard", {}, note, rows);

  return {
    element,
    update(board, rush, selfId) {
      const merged = withRush(board, rush);
      note.textContent = merged.length
        ? "Solved, then fastest. Squares are easy, medium, hard; ⚡ is today's rush."
        : "Nobody has played yet today. Be first.";
      replaceChildren(
        rows,
        ...merged.map((row, index) =>
          el(
            "div",
            {
              // `--marks` because this row has a fourth column the shared one
              // does not: the three tier squares, which sit with the score.
              class:
                `board-list__row board-list__row--marks` +
                (row.player.id === selfId ? " board-list__row--self" : ""),
            },
            el("span", { class: "board-list__rank", text: `${index + 1}` }),
            el("span", { class: "board-list__name", text: row.player.username }),
            // Beside the score rather than beside the name: the squares are
            // three of that row's results, and every other result on the row
            // is at this end. In front of the name they read as a prefix to
            // it, and pushed every name to a different starting column.
            el("span", { class: "board__marks" }, ...DAILY_TIERS.map((tier) => mark(row, tier))),
            el("span", {
              class: "board-list__score",
              // A rush of zero solves is a rush that happened, and reads
              // differently from never having run one — so null is the blank,
              // not zero.
              text:
                (row.solved > 0 ? `${row.solved}/${DAILY_TIERS.length} · ${formatDuration(row.totalMs)}` : `0/${DAILY_TIERS.length}`) +
                (row.rush === null ? "" : ` · ⚡${row.rush}`),
            }),
          ),
        ),
      );
    },
  };
}
