/**
 * What is waiting: one row per pending submission, oldest first.
 *
 * A list and nothing more. It carries no board, no queue and no solution — the
 * route does not send them and this screen would have nowhere to put them; the
 * decision is taken on the detail screen, in front of the puzzle.
 *
 * **Every author-written string on this page is set with `textContent`.**
 * `title`, `goal` and `author` are typed by players, and this is a plain web
 * page outside Discord's sandbox with no CSP, no `frame-ancestors` and nothing
 * else behind it. The server refuses control characters and over-length on the
 * way in; it does not escape HTML, because escaping is the renderer's job and
 * this is the renderer. There is no `innerHTML` anywhere in this directory and
 * there must not be one.
 */

import { el, panel } from "../src/ui/dom";
import type { QueueRow } from "./api";
import { filedOn } from "./format";

export interface QueueHandlers {
  onOpen(submissionId: number): void;
  onRefresh(): void;
}

/** One row: who, when, what they called it, what it asks for, and the numbers. */
function queueRow(row: QueueRow, handlers: QueueHandlers): HTMLElement {
  return el(
    "button",
    {
      // `.explore__item` for the fill, the border, the hover and the press —
      // the behaviour every list in this codebase already has. `.review__row`
      // replaces only its three-column grid, because a queue row stacks.
      class: "explore__item review__row",
      attrs: { type: "button" },
      on: { click: () => handlers.onOpen(row.submissionId) },
    },
    el("span", { class: "review__row-title", text: row.title }),
    el("span", { class: "review__row-by", text: `by ${row.author} · filed ${filedOn(row.createdAt)}` }),
    el("span", { class: "review__row-goal", text: row.goal }),
    el(
      "span",
      { class: "review__row-meta" },
      // "Rated" and not "difficulty": this is the author's own number, and the
      // reviewer's is the one that ends up on the puzzle.
      el("span", { text: `rated ${row.claimedDifficulty}` }),
      el("span", { text: `${row.piecesPlaced} ${row.piecesPlaced === 1 ? "piece" : "pieces"}` }),
      el("span", { text: `+${row.playedAttack} attack` }),
    ),
  );
}

export function createQueueView(
  rows: readonly QueueRow[],
  handlers: QueueHandlers,
): HTMLElement {
  const count =
    rows.length === 0
      ? "nothing waiting"
      : `${rows.length} ${rows.length === 1 ? "puzzle" : "puzzles"} waiting`;

  return panel(
    "Queue",
    {},
    el(
      "div",
      { class: "review__step" },
      el("span", { class: "label", text: count }),
      el("button", {
        class: "btn btn--small",
        text: "Refresh",
        attrs: { type: "button" },
        // Two officers can hold links at once and nothing coordinates them, so
        // a queue that was fetched once is a queue that can be wrong by the
        // time it is read.
        on: { click: () => handlers.onRefresh() },
      }),
    ),
    rows.length === 0
      ? el("p", {
          class: "review__note",
          text: "Every puzzle players have sent has been decided. Nothing to do.",
        })
      : el("div", { class: "review__rows" }, ...rows.map((row) => queueRow(row, handlers))),
  );
}
