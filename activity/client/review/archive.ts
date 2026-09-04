/**
 * Every puzzle in the archive, searchable, with the corrected ones marked.
 *
 * The list side of the archive tab. It draws rows and nothing else: opening one
 * is the page's business, and correcting it is `correction.ts`'s.
 *
 * **The rows scroll inside this card, not the page.** `review.css` gives
 * `.review__list` a bounded height and its own `overflow-y`, and the reason is
 * the whole reason this is a list and not a table: 139 rows is already three
 * screens, the archive only grows, and a form beside a list that pushes the
 * page down is a form the officer has to scroll back up to. The game client got
 * this wrong twice in the other direction — see `.explore__list--flow` in
 * `client/src/styles/panels.css` — so the trade-off is written down at both
 * ends.
 *
 * **Every string on a row is set with `textContent`.** `title`, `author`, `goal`
 * and `set` are typed by players and by officers, and this is a plain page
 * outside Discord's sandbox with no CSP behind it. See `queue.ts` for the whole
 * of that rule; there is no `innerHTML` in this directory and there must not be.
 */

import { el, panel, replaceChildren } from "../src/ui/dom";
import type { ReviewPuzzle } from "./api";

export interface ArchiveHandlers {
  onOpen(puzzleId: number): void;
  onRefresh(): void;
}

export interface ArchiveView {
  readonly element: HTMLElement;
  /**
   * Re-paints the rows from a new list, keeping the search box and the scroll.
   *
   * Called after a correction, because the row is where the officer sees that
   * the title they just fixed is fixed. Handing the page a whole new view
   * instead would throw away the search they typed to find the row with.
   */
  update(puzzles: readonly ReviewPuzzle[]): void;
}

/**
 * Whether a row answers what was typed in the box.
 *
 * Title, author and number — the three things somebody knows about a puzzle
 * they have been told to go and fix. Deliberately narrower than
 * `filterArchive`, which also matches the goal and the set: an officer arrives
 * here from a report about *a puzzle*, and the goal is one of the five fields
 * most likely to be the thing that is wrong, so matching against it would be
 * searching the text that is under suspicion.
 */
function matches(puzzle: ReviewPuzzle, needle: string): boolean {
  return (
    puzzle.title.toLowerCase().includes(needle) ||
    puzzle.author.toLowerCase().includes(needle) ||
    String(puzzle.id).includes(needle)
  );
}

/**
 * One row: the seven facts, in the queue row's own three-line shape.
 *
 * `.review__row` and `.explore__item` unchanged from the queue, because a row
 * in this tool should look like a row in this tool — the fill, the border, the
 * hover and the press are the behaviour every list in this codebase has, and
 * the stacked grid is the one already written for a row carrying prose and
 * numbers at once.
 */
function archiveRow(
  puzzle: ReviewPuzzle,
  open: boolean,
  handlers: ArchiveHandlers,
): HTMLElement {
  // "unrated" rather than d0: zero is not a rating, it is nobody having got
  // round to it, and `dailyTierOf` reads it as hard for exactly that reason.
  const rating = puzzle.difficulty > 0 ? `d${puzzle.difficulty}` : "unrated";
  return el(
    "button",
    {
      class: `explore__item review__row${open ? " review__row--open" : ""}`,
      attrs: { type: "button", "aria-current": open ? "true" : null },
      on: { click: () => handlers.onOpen(puzzle.id) },
    },
    el(
      "span",
      { class: "review__row-title" },
      el("span", { class: "review__row-name", text: puzzle.title }),
      // Only that a correction exists, never which field — the row has no room
      // for it and the form is one click away, where every field says so.
      puzzle.overridden ? el("span", { class: "review__flag", text: "corrected" }) : null,
    ),
    el("span", {
      class: "review__row-by",
      // Where it came from, said out loud rather than left to the id band. It
      // decides what "source" means on the form beside this list: the club's
      // sheet for one, the row the author filed for the other.
      text: `by ${puzzle.author} · ${puzzle.community ? "player" : "club"}`,
    }),
    el("span", { class: "review__row-goal", text: puzzle.goal }),
    el(
      "span",
      { class: "review__row-meta" },
      el("span", { text: `#${puzzle.id}` }),
      el("span", { text: rating }),
      el("span", { text: `${puzzle.pieces} ${puzzle.pieces === 1 ? "piece" : "pieces"}` }),
    ),
  );
}

export function createArchiveView(
  puzzles: readonly ReviewPuzzle[],
  handlers: ArchiveHandlers,
): ArchiveView {
  // Both reassigned, never written into: `update` is handed a fresh array and
  // the rows on screen were drawn from the one it replaces.
  let all = puzzles;
  let openId: number | null = null;

  /**
   * The row handlers the rows are actually built with.
   *
   * Opening a row is also what marks it, and the mark has to survive the next
   * keystroke in the search box — so the selection is this module's state and
   * the page's handler is called on the way out of it, rather than the page
   * having to reach back in and say which row it opened.
   */
  const rowHandlers: ArchiveHandlers = {
    onRefresh: () => handlers.onRefresh(),
    onOpen: (id) => {
      openId = id;
      paint();
      handlers.onOpen(id);
    },
  };

  const search = el("input", {
    class: "build__field",
    attrs: {
      type: "search",
      placeholder: "title, author or #id…",
      "aria-label": "Search the archive",
    },
  });
  const count = el("span", { class: "label" });
  const list = el("div", { class: "review__list" });
  const refresh = el("button", {
    class: "btn btn--small",
    text: "Refresh",
    attrs: { type: "button" },
    // Two officers can hold links at once and nothing coordinates them, so a
    // list fetched once is a list that can be wrong by the time it is read.
    on: { click: () => handlers.onRefresh() },
  });

  function paint(): void {
    const typed = search.value.trim();
    // A leading # dropped so that "#12" and "12" find the same puzzle: the row
    // prints the number with one and an officer copying it back in should not
    // be answered with nothing.
    const needle = typed.replace(/^#/, "").toLowerCase();
    const shown = needle ? all.filter((puzzle) => matches(puzzle, needle)) : all;

    count.textContent =
      shown.length === all.length
        ? `all ${all.length} puzzles`
        : `${shown.length} of ${all.length} puzzles`;

    // Put back by hand, because `replaceChildren` empties the container first
    // and a container with nothing in it has no height to be scrolled within —
    // so the browser takes `scrollTop` to zero on the way past. Without this,
    // saving a correction from row 97 threw the officer back to row 1.
    const wasAt = list.scrollTop;
    if (shown.length === 0) {
      replaceChildren(
        list,
        el("p", { class: "review__note", text: `Nothing in the archive matches “${typed}”.` }),
      );
    } else {
      replaceChildren(
        list,
        ...shown.map((puzzle) => archiveRow(puzzle, puzzle.id === openId, rowHandlers)),
      );
    }
    list.scrollTop = wasAt;
  }

  search.addEventListener("input", paint);

  const element = panel(
    "Archive",
    {},
    el(
      "div",
      { class: "review__field" },
      el("span", { class: "explore__label", text: "search" }),
      search,
    ),
    el("div", { class: "review__step" }, count, refresh),
    list,
  );

  paint();

  return {
    element,
    update(next) {
      all = next;
      paint();
    },
  };
}

