/**
 * The sitting: the queue, one submission, the archive, and getting back.
 *
 * One screen at a time and no router. A router would put a submission's id in
 * the address bar, and an address bar on this page is the thing the link was
 * scrubbed out of — see `grant.ts`. Nothing here is addressable, nothing here
 * is bookmarkable, and a refresh starts again from the link that no longer
 * exists, which is the intended lifetime of a review token.
 *
 * **Two tabs, one sitting.** The archive browser is a second screen of this
 * page rather than a page of its own, because a page of its own would need its
 * own link minted on the VPS and its own kind of token — two credentials for
 * one officer, expiring at different times. The tabs are two ordinary buttons
 * over the same `body`, switched exactly the way the queue and a submission
 * already are.
 *
 * The queue is where the tool lands and stays landing. A submission waiting is
 * time-sensitive in a way a typo in a title is not, and an officer who opened
 * their link to deal with the queue should not have to find it.
 */

import { el, replaceChildren } from "../src/ui/dom";
import type { ReviewApi, Verdict } from "./api";
import { createArchiveView } from "./archive";
import { BoardPainter } from "./board-paint";
import { createCorrectionView } from "./correction";
import { createDetailView } from "./detail";
import { createQueueView } from "./queue";
import { EXPIRED, isExpired, sentenceFor, stop } from "./refusal";

/**
 * Everything this page asks of the server, and nothing about how it asks.
 *
 * A `Pick` of the client rather than a hand-written interface, so the two
 * cannot drift: a route whose shape changes changes this with it, and a test
 * driving the page against a stand-in is held to the real signatures. The
 * alternative was a cast in the test, which compiles forever no matter what
 * the client does.
 */
export type ReviewCalls = Pick<
  ReviewApi,
  "queue" | "submission" | "accept" | "reject" | "puzzles" | "correct" | "revert"
>;

type Tab = "queue" | "archive";

export class ReviewPage {
  private readonly body = el("div", { class: "review__stack" });
  /** The open submission's painter, or null while a list is showing. */
  private painter: BoardPainter | null = null;
  private readonly tabs: Readonly<Record<Tab, HTMLButtonElement>>;

  constructor(
    private readonly root: HTMLElement,
    private readonly api: ReviewCalls,
    reviewer: string,
  ) {
    this.tabs = {
      queue: tabButton("Queue", () => void this.showQueue()),
      archive: tabButton("Archive", () => void this.showArchive()),
    };
    replaceChildren(
      root,
      el(
        "div",
        { class: "review__head" },
        el("h1", { class: "display review__mark", text: "Review" }),
        // The name on the link, which is what lands in `reviewed_by` and in
        // `puzzle_overrides.updated_by`. Shown because it is an attribution
        // somebody typed into a shell rather than an identity anything checked,
        // and an officer holding a link minted for somebody else should be able
        // to see that at a glance.
        el("span", { class: "label review__who", text: `signed in as ${reviewer}` }),
      ),
      el("div", { class: "review__tabs" }, this.tabs.queue, this.tabs.archive),
      this.body,
    );
    window.addEventListener("resize", () => this.painter?.draw());
  }

  async showQueue(flash?: string): Promise<void> {
    this.painter = null;
    this.select("queue");
    const answer = await this.guard(() => this.api.queue());
    if (!answer) return;
    replaceChildren(
      this.body,
      flash ? el("p", { class: "review__status review__status--good", text: flash }) : null,
      createQueueView(answer.queue, {
        onOpen: (id) => void this.openOne(id),
        onRefresh: () => void this.showQueue(),
      }),
    );
  }

  /**
   * The archive tab: every puzzle, and the one being corrected beside it.
   *
   * The list and the open form are held in this scope rather than in fields on
   * the page, because they are the whole of the screen's state and they die
   * with the screen — a field would outlive the tab it describes and be wrong
   * from the moment the officer went back to the queue.
   *
   * Nothing here rebuilds the screen after a write. The list is re-painted from
   * a new array and the form is re-built from what came back, so the search the
   * officer typed to find the row with, and their place in it, both survive the
   * correction they came here to make.
   */
  private async showArchive(): Promise<void> {
    this.painter = null;
    this.select("archive");
    const answer = await this.guard(() => this.api.puzzles());
    if (!answer) return;

    // Reassigned, never written into: the rows on screen were drawn from the
    // array this replaces, and `map` leaves that one exactly as it was.
    let puzzles = answer.puzzles;
    const form = el("div", { class: "review__stack" });

    const open = (id: number, flash?: string): void => {
      const puzzle = puzzles.find((entry) => entry.id === id);
      // Unreachable: the list is the only thing that opens a form, and it only
      // ever names a row it drew. A return rather than a throw all the same —
      // an empty column is a better answer than a dead page.
      if (!puzzle) return;
      replaceChildren(
        form,
        createCorrectionView(
          puzzle,
          {
            // Through `escalate`, so a refusal lands beside the buttons that
            // caused it — "A title is longer than 60 characters" is the answer
            // to the question that was asked — and only an expired token is
            // worth taking the whole page for.
            onSave: (changes) => this.escalate(this.api.correct(id, changes)),
            onRevert: () => this.escalate(this.api.revert(id)),
            onSaved: (saved, said) => {
              puzzles = puzzles.map((entry) => (entry.id === saved.id ? saved : entry));
              list.update(puzzles);
              open(saved.id, said);
            },
          },
          flash,
        ),
      );
    };

    const list = createArchiveView(puzzles, {
      onOpen: (id) => open(id),
      onRefresh: () => void this.showArchive(),
    });

    replaceChildren(this.body, el("div", { class: "review__archive" }, list.element, form));
  }

  /** Which tab the officer is on. The detail screen is part of the queue's. */
  private select(open: Tab): void {
    for (const name of ["queue", "archive"] as const) {
      const button = this.tabs[name];
      const current = name === open;
      button.classList.toggle("review__tab--on", current);
      // `aria-current` rather than `role="tab"` with `aria-selected`: a real
      // tablist comes with a keyboard contract — arrow keys between the tabs, a
      // roving tabindex, a labelled panel — and half a tablist reads worse to a
      // screen reader than two plain buttons do. These are two plain buttons,
      // and `aria-current` is exactly "the one in this set you are on".
      if (current) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  }

  private async openOne(id: number): Promise<void> {
    const submission = await this.guard(() => this.api.submission(id));
    if (!submission) return;

    const painter = new BoardPainter();
    const view = createDetailView(submission, {
      onView: (board) => painter.show(board),
      onBack: () => void this.showQueue(),
      // The decisions go out through `escalate` rather than `guard`: a refusal
      // belongs beside the buttons that caused it — "already accepted by
      // hannah" is the answer to the question that was asked — and only an
      // expired token is worth taking the whole page for.
      onAccept: (decision) => this.escalate(this.api.accept(id, decision)),
      onReject: (decision) => this.escalate(this.api.reject(id, decision)),
      onDecided: (verdict) => void this.showQueue(verdictLine(verdict)),
    });

    replaceChildren(this.body, view.element);
    painter.attach(view.canvas);
    this.painter = painter;
  }

  /** A read that failed. Nothing is on screen to put the reason beside. */
  private async guard<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      if (isExpired(error)) stop(this.root, EXPIRED);
      else {
        replaceChildren(
          this.body,
          el("p", { class: "review__status review__status--bad", text: sentenceFor(error) }),
        );
      }
      return null;
    }
  }

  /** A write that failed. The panel prints it, unless there is no page left. */
  private async escalate<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (error) {
      // Rethrown after the page has been replaced: the panel is detached by
      // then and its own status line goes nowhere, which is the intent.
      if (isExpired(error)) stop(this.root, EXPIRED);
      throw error;
    }
  }
}

/** One of the two ways in. Plain buttons; see {@link ReviewPage.select}. */
function tabButton(label: string, open: () => void): HTMLButtonElement {
  return el("button", {
    class: "btn btn--small review__tab",
    text: label,
    attrs: { type: "button" },
    on: { click: open },
  });
}

/** What the officer is told about a puzzle they have just decided. */
function verdictLine(verdict: Verdict): string {
  if (verdict.status === "rejected") {
    return `Rejected “${verdict.title}”. The author has your note.`;
  }
  // Said out loud because it is the one surprising thing about accepting: the
  // archive is built once at module scope and `forDay` memoises, so this
  // process cannot grow one. A live-mutating archive would reshuffle a day
  // under the players holding its prompt, which is the hazard the whole pinning
  // scheme exists to close.
  return (
    `Accepted “${verdict.title}” as puzzle ${verdict.puzzleId}. ` +
    "It joins the archive and the rotation when the server next restarts."
  );
}
