/**
 * The sitting: the queue, one submission, and getting back to the queue.
 *
 * One screen at a time and no router. A router would put a submission's id in
 * the address bar, and an address bar on this page is the thing the link was
 * scrubbed out of — see `grant.ts`. Nothing here is addressable, nothing here
 * is bookmarkable, and a refresh starts again from the link that no longer
 * exists, which is the intended lifetime of a review token.
 */

import { el, replaceChildren } from "../src/ui/dom";
import type { ReviewApi, Verdict } from "./api";
import { BoardPainter } from "./board-paint";
import { createDetailView } from "./detail";
import { createQueueView } from "./queue";
import { EXPIRED, isExpired, sentenceFor, stop } from "./refusal";

export class ReviewPage {
  private readonly body = el("div", { class: "review__stack" });
  /** The open submission's painter, or null while the queue is showing. */
  private painter: BoardPainter | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly api: ReviewApi,
    reviewer: string,
  ) {
    replaceChildren(
      root,
      el(
        "div",
        { class: "review__head" },
        el("h1", { class: "display review__mark", text: "Review" }),
        // The name on the link, which is what lands in `reviewed_by`. Shown
        // because it is an attribution somebody typed into a shell rather than
        // an identity anything checked, and an officer holding a link minted
        // for somebody else should be able to see that at a glance.
        el("span", { class: "label review__who", text: `signed in as ${reviewer}` }),
      ),
      this.body,
    );
    window.addEventListener("resize", () => this.painter?.draw());
  }

  async showQueue(flash?: string): Promise<void> {
    this.painter = null;
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

  /** A decision that failed. The panel prints it, unless there is no page left. */
  private async escalate(work: Promise<Verdict>): Promise<Verdict> {
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
