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

import type { RushRun, StoredRun } from "../api";
import { DAILY_TIERS, type DailyTier } from "@shared/daily";
import { el, formatDuration, panel, replaceChildren } from "./dom";

export interface DailyBoard {
  readonly element: HTMLElement;
  update(
    boards: readonly { tier: DailyTier; entries: readonly StoredRun[] }[],
    rush: readonly RushRun[],
    selfId: string,
  ): void;
}

interface Row {
  readonly id: string;
  readonly username: string;
  readonly marks: Partial<Record<DailyTier, boolean>>;
  solved: number;
  totalMs: number;
  /** Puzzles cleared in today's rush, or null if they never ran one. */
  rush: number | null;
}

/** Everybody once, best first. Exported for the tests that pin the ordering. */
export function mergeBoards(
  boards: readonly { tier: DailyTier; entries: readonly StoredRun[] }[],
  rush: readonly RushRun[] = [],
): Row[] {
  const rows = new Map<string, Row>();
  for (const board of boards) {
    for (const run of board.entries) {
      // Keyed on the id, never the name: two guests can share a display name
      // and would otherwise be folded into one person.
      const id = run.player.id;
      const row = rows.get(id) ?? {
        id,
        username: run.player.username,
        marks: {},
        solved: 0,
        totalMs: 0,
        rush: null,
      };
      row.marks[board.tier] = run.solved;
      if (run.solved) {
        row.solved += 1;
        row.totalMs += run.totalMs;
      }
      rows.set(id, row);
    }
  }

  // Rush can put somebody on the board who filed no daily at all, so this adds
  // rows as well as filling them in.
  for (const run of rush) {
    const row = rows.get(run.player.id) ?? {
      id: run.player.id,
      username: run.player.username,
      marks: {},
      solved: 0,
      totalMs: 0,
      rush: null,
    };
    row.rush = Math.max(row.rush ?? 0, run.solved);
    rows.set(run.player.id, row);
  }

  // The daily decides the order and rush breaks ties, rather than the two being
  // added together: three puzzles chosen for you and as many as you can take in
  // five minutes are not the same unit, and summing them would say they are.
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
    update(boards, rush, selfId) {
      const merged = mergeBoards(boards, rush);
      note.textContent = merged.length
        ? "Solved, then fastest. Squares are easy, medium, hard; ⚡ is today's rush."
        : "Nobody has played yet today. Be first.";
      replaceChildren(
        rows,
        ...merged.map((row, index) =>
          el(
            "div",
            { class: `board-list__row${row.id === selfId ? " board-list__row--self" : ""}` },
            el("span", { class: "board-list__rank", text: `${index + 1}` }),
            el("span", { class: "board__marks" }, ...DAILY_TIERS.map((tier) => mark(row, tier))),
            el("span", { class: "board-list__name", text: row.username }),
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
