/**
 * One submission, in front of the officer deciding on it.
 *
 * This is why the review tool is a bundle and not a server-rendered page. The
 * two things a reviewer cannot do without — see the board, and step the solve
 * — are `BoardRenderer` and `SolutionPlayer`, both already written, and
 * `SolutionPlayer` in particular touches no engine at all: it locks each stored
 * placement into a board copy and clears full rows itself. Reimplementing
 * either in HTML strings would put a second board renderer in this repo, which
 * is the last code in it that should exist twice.
 *
 * **The canvas is drawn by the caller.** This view owns which step is showing
 * and hands the resulting `BoardView` to `onView`; the page owns the renderer
 * and the pixel size. That is the same split `createWalkthroughPanel` and `App`
 * already use, and it is what lets every assertion in `tests/review-page.test.ts`
 * read the board out of a spy instead of out of a canvas nobody can query.
 *
 * Author-written text — `title`, `goal`, `author` — is set with `textContent`,
 * never `innerHTML`. See `queue.ts` for the whole of that rule.
 */

import { MAX_DIFFICULTY, MIN_DIFFICULTY } from "@shared/archive-filter";
import { dailyTierOf } from "@shared/daily";
import { BOARD_HEIGHT } from "@shared/puzzle";
import { SolutionPlayer } from "../src/game/solution-player";
import type { BoardView } from "../src/render/board";
import { pieceGlyph } from "../src/render/piece-glyph";
import { GOAL_LABELS } from "../src/ui/builder-state";
import { el, panel, replaceChildren, stat } from "../src/ui/dom";
import type { SubmissionDetail, Verdict } from "./api";
import { clearList, filedOn } from "./format";

/**
 * The note's cap, matching `MAX_NOTE_LENGTH` in `server/submission-input.ts`.
 *
 * Written out rather than imported, the same trade the builder's `MAX_TITLE`
 * makes: that constant lives in a module that imports Hono, and pulling the
 * request path into a browser bundle to check a textarea would be far worse
 * than one number in two places. The server is still the authority — this only
 * stops the field taking text it would refuse.
 */
const MAX_NOTE = 500;

/**
 * The scale the archive uses, and the one `readReviewedDifficulty` will accept.
 *
 * One predicate for the two places that ask, because they must agree: the tier
 * shown beside the box and the refusal that stops a bad rating being sent are
 * the same question, and a page that named a tier for a number the server would
 * turn away would be answering it twice, differently.
 */
function inScale(difficulty: number): boolean {
  return (
    Number.isInteger(difficulty) &&
    difficulty >= MIN_DIFFICULTY &&
    difficulty <= MAX_DIFFICULTY
  );
}

export interface DetailHandlers {
  /** The step to draw. Called once on build and after every move. */
  onView(view: BoardView): void;
  onBack(): void;
  onAccept(body: { difficulty: number; note: string | null }): Promise<Verdict>;
  onReject(body: { note: string }): Promise<Verdict>;
  onDecided(verdict: Verdict): void;
}

export interface DetailView {
  readonly element: HTMLElement;
  /** Handed back so the page can size it and paint it. */
  readonly canvas: HTMLCanvasElement;
}

/** Hold and queue, in the glyph vocabulary the activity's own bays use. */
function piecesStrip(submission: SubmissionDetail): HTMLElement {
  return el(
    "div",
    { class: "review__pieces" },
    el("span", { class: "label", text: "hold" }),
    submission.hold
      ? pieceGlyph(submission.hold, { cell: 10 })
      : el("span", { class: "review__note", text: "empty" }),
    el("span", { class: "label", text: "next" }),
    ...submission.queue.map((piece) => pieceGlyph(piece, { cell: 10 })),
  );
}

/** Prev / Next / Restart over the stored solve, and what the current step did. */
function solutionPanel(submission: SubmissionDetail, onView: DetailHandlers["onView"]): HTMLElement {
  const player = new SolutionPlayer(submission, submission.solution, BOARD_HEIGHT);
  const position = el("span", { class: "readout" });
  const caption = el("div", { class: "review__caption" });

  const show = () => {
    const step = player.current;
    position.textContent = `${Math.min(player.position + 1, player.stepCount)} / ${player.stepCount}`;
    replaceChildren(
      caption,
      step ? pieceGlyph(step.piece, { cell: 10 }) : el("span", { class: "label", text: "end" }),
      step?.clear
        ? el("span", {
            class: "review__clear",
            text: `${GOAL_LABELS[step.clear]} +${step.attack}`,
          })
        : null,
    );
    onView(player.view());
  };

  const control = (label: string, move: () => void) =>
    el("button", {
      class: "btn btn--small",
      text: label,
      attrs: { type: "button" },
      on: {
        click: () => {
          move();
          show();
        },
      },
    });

  const element = panel(
    "Solution",
    {},
    el("div", { class: "review__step" }, el("span", { class: "label", text: "step" }), position),
    caption,
    el(
      "div",
      { class: "btnrow" },
      control("Prev", () => player.previous()),
      control("Next", () => player.next()),
      control("Restart", () => player.reset()),
    ),
  );

  show();
  return element;
}

/**
 * The goal, and the clears the solve actually made, one under the other.
 *
 * This pair is the only way the goal gets checked at all. There is no goal
 * checker on the server and there is not going to be one: `parseGoal` lives in
 * the builder's UI, it returns null on prose, and most goals ever written are
 * prose. The reviewer is the checker, so the two things they compare have to be
 * in the same place, in the same words.
 */
function goalPanel(submission: SubmissionDetail): HTMLElement {
  return panel(
    "Goal",
    {},
    el("p", { class: "goal__text", text: submission.goal }),
    el("p", { class: "review__clears", text: clearList(submission.clears) }),
    el("p", {
      class: "review__note",
      text:
        "Those are the clears the author's solve made, in order. Nothing on the server " +
        "reads the goal — you are the check. Step the solution above if the list and the " +
        "sentence do not obviously agree.",
    }),
  );
}

/** The numbers this server derived by replaying the author's own keystrokes. */
function solvePanel(submission: SubmissionDetail): HTMLElement {
  return panel(
    "The author's solve",
    {},
    stat("Attack sent", `+${submission.playedAttack}`),
    stat("Pieces placed", submission.piecesPlaced),
    el("p", {
      class: "review__note",
      text:
        "Accepting makes that attack the puzzle's target, and it is a different kind of " +
        "number from an archive puzzle's. This one is what a person actually did, so it is " +
        "reachable and beatable. An archive target comes from the pathfinder trying every " +
        "kick route and keeping the best line, which is usually past what anyone reproduced.",
    }),
  );
}

/**
 * The rating, the note, and the two buttons.
 *
 * Reject needs a note and Accept does not, which is the server's rule and also
 * the only guard on the destructive direction: a rejection is terminal and is
 * the one thing the author ever hears back, so having to type a reason first is
 * what stops a stray click ending somebody's puzzle. A confirm dialog on top of
 * that would be a second answer to a question already answered.
 */
function decisionPanel(submission: SubmissionDetail, handlers: DetailHandlers): HTMLElement {
  const rating = el("input", {
    class: "explore__number",
    attrs: {
      type: "number",
      min: MIN_DIFFICULTY,
      max: MAX_DIFFICULTY,
      step: 1,
      value: submission.claimedDifficulty,
      "aria-label": "Final difficulty",
    },
  });
  // Derived live rather than printed as a table of bands, so the page cannot
  // drift from `dailyTierOf`. Accepted puzzles do enter the daily rotation, so
  // this number decides which of the day's three a player meets it as.
  const tier = el("span", { class: "review__tier" });
  const note = el("textarea", {
    class: "review__reason",
    attrs: {
      rows: 3,
      maxlength: MAX_NOTE,
      placeholder: "Why? A rejection needs one — it is all the author hears back.",
      "aria-label": "Note to the author",
    },
  });
  const status = el("p", {
    class: "review__status",
    attrs: { role: "status", "aria-live": "polite" },
  });
  const accept = el("button", {
    class: "btn btn--primary",
    text: "Accept",
    attrs: { type: "button" },
  });
  const reject = el("button", { class: "btn", text: "Reject", attrs: { type: "button" } });

  const noteText = () => note.value.trim();
  const refresh = () => {
    const difficulty = Number(rating.value);
    // Blank rather than a guess while the field holds something the server
    // would refuse. `Number("")` is 0 and 0 is a tier — "hard", as it happens —
    // so an emptied box would otherwise sit there naming one.
    tier.textContent = inScale(difficulty) ? dailyTierOf({ difficulty }) : "";
    reject.disabled = noteText().length === 0;
  };
  const say = (message: string, tone: "bad" | "good") => {
    status.textContent = message;
    status.className = `review__status review__status--${tone}`;
  };

  /**
   * Both decisions, with the buttons shut while one is in flight.
   *
   * Not a nicety: two clicks send two decisions, and the second one loses to
   * the `WHERE status = 'pending'` guard and comes back as a 409 naming the
   * officer's own name — a refusal that reads exactly like somebody else got
   * there first.
   */
  const send = async (decide: () => Promise<Verdict>) => {
    accept.disabled = true;
    reject.disabled = true;
    say("Sending…", "good");
    try {
      handlers.onDecided(await decide());
    } catch (error) {
      say(error instanceof Error ? error.message : "That did not go through.", "bad");
      accept.disabled = false;
      refresh();
    }
  };

  rating.addEventListener("input", refresh);
  note.addEventListener("input", refresh);
  accept.addEventListener("click", () => {
    const difficulty = Number(rating.value);
    if (!inScale(difficulty)) {
      say(`Give it a difficulty between ${MIN_DIFFICULTY} and ${MAX_DIFFICULTY} first.`, "bad");
      return;
    }
    void send(() => handlers.onAccept({ difficulty, note: noteText() || null }));
  });
  reject.addEventListener("click", () => void send(() => handlers.onReject({ note: noteText() })));

  refresh();
  return panel(
    "Decision",
    {},
    stat("Author's rating", submission.claimedDifficulty),
    el(
      "div",
      { class: "review__field" },
      el("span", { class: "explore__label", text: "difficulty" }),
      rating,
      tier,
    ),
    note,
    el("div", { class: "btnrow" }, accept, reject),
    status,
  );
}

export function createDetailView(
  submission: SubmissionDetail,
  handlers: DetailHandlers,
): DetailView {
  const canvas = el("canvas");

  return {
    canvas,
    element: el(
      "div",
      { class: "review__stack" },
      el(
        "div",
        { class: "review__head" },
        el("button", {
          class: "btn btn--small",
          text: "Queue",
          attrs: { type: "button" },
          on: { click: () => handlers.onBack() },
        }),
        el("h1", { class: "display review__mark", text: submission.title }),
        el("span", {
          class: "label review__who",
          text: `by ${submission.author} · filed ${filedOn(submission.createdAt)}`,
        }),
      ),
      el(
        "div",
        { class: "review__detail" },
        el(
          "div",
          { class: "review__stack" },
          panel("Board", {}, el("div", { class: "review__board" }, canvas), piecesStrip(submission)),
          // Wrapped rather than passed by reference: a handler written as a method
          // shorthand would lose its receiver, and the failure would be a board that
          // never redraws rather than anything the compiler could see.
          solutionPanel(submission, (view) => handlers.onView(view)),
        ),
        el(
          "div",
          { class: "review__stack" },
          goalPanel(submission),
          solvePanel(submission),
          decisionPanel(submission, handlers),
        ),
      ),
    ),
  };
}
