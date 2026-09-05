/**
 * Sending a draft to the club: a title, a rating, one button, and one line.
 *
 * Split out of `builder.ts` for the reason `builder-goal.ts` gives — it is a
 * control of its own and that file is the largest on the client — but the seam
 * is drawn somewhere else. The goal's counters hand back a sentence and know
 * nothing about what happens to it; this card owns the whole of a submission,
 * the round trip included, because every part of that round trip shows up here
 * and nowhere else: the button that has to stay pressed once, the line that has
 * to survive the next redraw, and the answer that has to be readable when it
 * lands. Left in the builder they would be three fields on a screen that has
 * enough of them.
 *
 * What it still does not own: the draft. Every edit goes back through the
 * builder's one funnel, and the run it files is read at the moment of the
 * click rather than held — because whether a run still belongs to the board on
 * screen is a question only the builder can answer.
 *
 * Why a panel of its own on the screen, and not two fields under Goal and a
 * button beside Copy: the rail's rule is that a panel's caption labels the
 * control under it, and "Goal" is not the label for a title. A blueprint code
 * carries neither of these fields, so they exist for a submission and nothing
 * else — which is exactly one card's worth of one idea.
 */

import { MAX_DIFFICULTY, MIN_DIFFICULTY } from "@shared/archive-filter";
import {
  type BuilderSolve,
  type BuilderState,
  type SubmissionBody,
  clampDifficulty,
  MAX_TITLE,
  sanitizeTitle,
  submitBlocker,
  toSubmission,
} from "./builder-state";
import { el, panel, writeBackOnBlur } from "./dom";

/**
 * How long the button wears its own result, matching Copy's.
 *
 * The same number and the same gesture on purpose: two buttons in the same
 * rails that answer a click by renaming themselves should not do it at two
 * different speeds.
 */
const SENT_MESSAGE_MS = 1600;

/**
 * The route's own refusal, near enough.
 *
 * Every guest is the same player, so a guest submission has no author to credit
 * and shares one quota with every other guest — which is why the server answers
 * one with a 403. Said here rather than repeated back from there, because a
 * refusal that arrives once the puzzle is written and played is a refusal in
 * the wrong place.
 */
const GUEST_REFUSAL =
  "A guest has no name to put on a puzzle. Sign in through Discord to submit one.";

/** What a failure with nothing to say gets, so a click never looks ignored. */
const UNSAID = "That could not be sent. Try again in a moment.";

/** What the server made of a submitted solve. */
export interface SubmissionVerdict {
  /**
   * The attack the server read out of the log.
   *
   * Its number, not the browser's, and the reason the route answers with one at
   * all: this is the target every later player is scored against, and the two
   * sides disagreeing about it is the one failure an author cannot investigate
   * from their side of the wire. So it is said out loud rather than assumed.
   */
  readonly attack: number;
}

export interface SubmitHooks {
  /** The draft as it stands and the run it still stands on. Never cached. */
  readonly read: () => { readonly state: BuilderState; readonly solve: BuilderSolve | null };
  /** A title the author typed, already folded to what the route will take. */
  readonly writeTitle: (title: string) => void;
  /** A rating the author dialled, already held to the archive's own scale. */
  readonly writeDifficulty: (difficulty: number) => void;
  /**
   * File it.
   *
   * The builder passes this through to the app, which owns the network — so
   * nothing in here has ever seen an `Api`. It resolves with what the server
   * saw and rejects with the sentence the server wrote, and it is the caller's
   * job to have spent the run by the time it resolves.
   */
  readonly send: (draft: SubmissionBody) => Promise<SubmissionVerdict>;
}

export interface SubmitPanel {
  /** The card, for the rail to mount and for `applyMode` to put away. */
  readonly element: HTMLElement;
  /** Redraw from the draft as it stands. */
  readonly render: () => void;
  /**
   * Drop what the last submission said.
   *
   * "Sent for review" is true about a puzzle, not about a screen: once the
   * board moves it is describing something nobody filed, so the builder calls
   * this from the one funnel every edit goes through.
   *
   * It does not redraw, and must not: the funnel calls this on the way past and
   * renders once at the end, by which time the draft it renders from is the new
   * one rather than the one being left behind.
   */
  readonly forget: () => void;
}

/** Unique per panel, so two of them could share a document without colliding. */
let submitSerial = 0;

/**
 * @param guest Whether this session has no Discord identity behind it. A fact
 *   about who is signed in rather than about the draft, which is why
 *   `submitBlocker` knows nothing about it and this does.
 */
export function createSubmitPanel(hooks: SubmitHooks, guest: boolean): SubmitPanel {
  const noteId = `submit${(submitSerial += 1)}-note`;
  /**
   * True from the click until the server answers, so a double press files once.
   *
   * The only thing between an impatient click and two identical rows in the
   * review queue: the route's own defence is a three-pending quota, so a second
   * request does not fail — it spends another of the author's slots on the
   * puzzle they already sent.
   */
  let sending = false;
  /**
   * What the last submission did, or null — outranking the blocker while it
   * stands.
   *
   * The same shape `goalControls.refusal()` has, and for the same reason: the
   * line is redrawn from the draft on every keystroke, so an answer that only
   * matters *after* an action needs somewhere to survive the next render.
   */
  let outcome: string | null = null;

  const titleField = el("input", {
    class: "build__field",
    attrs: {
      type: "text",
      maxlength: MAX_TITLE,
      placeholder: "Name your puzzle",
      "aria-label": "Title",
    },
  });

  const difficultyField = el("input", {
    class: "explore__number",
    attrs: {
      type: "number",
      min: MIN_DIFFICULTY,
      max: MAX_DIFFICULTY,
      step: 1,
      inputmode: "numeric",
      "aria-label": "Difficulty",
    },
  });

  const submit = el("button", { class: "btn btn--small build__submit", text: "Submit" });
  /*
   * One line for both the reason Submit is off and the answer it came back
   * with, rather than a slot each. They are never true at the same time — a
   * draft that has just been filed cannot also be missing something — and a
   * second paragraph that is empty most of the time is a gap in the rail that
   * reads as a layout bug.
   *
   * `role="status"` because the button beside it goes from disabled to enabled
   * with nothing else on the screen changing, and because "Sent for review" is
   * the whole of what a successful click looks like.
   */
  const note = el("p", {
    class: "note build__submit-note",
    attrs: { id: noteId, role: "status", "aria-live": "polite" },
  });
  submit.setAttribute("aria-describedby", noteId);

  const element = panel(
    "Submit",
    {},
    el("p", {
      class: "rush__blurb",
      text: "Send it to the club. An officer reviews it before anyone else plays it.",
    }),
    titleField,
    el(
      "div",
      { class: "build__goal" },
      difficultyField,
      el("span", {
        class: "explore__label",
        text: `Difficulty ${MIN_DIFFICULTY}–${MAX_DIFFICULTY}`,
      }),
    ),
    el("div", { class: "btnrow" }, submit),
    note,
  );

  /**
   * Why Submit is off, or null.
   *
   * The session's refusal outranks the draft's: no amount of painting lifts it,
   * so telling a guest to write a title first would be sending them off to do
   * work that changes nothing. Everything after it is `submitBlocker`'s, which
   * is pure and knows nothing about who is signed in.
   */
  function refusal(state: BuilderState, solve: BuilderSolve | null): string | null {
    return guest ? GUEST_REFUSAL : submitBlocker(state, solve);
  }

  function render(): void {
    const { state, solve } = hooks.read();
    // Written back only when the field is not the one being typed into — the
    // same guard the rest of the builder's fields are under, for the same
    // reason: the caret is not ours to move.
    if (document.activeElement !== titleField) titleField.value = state.title;
    if (document.activeElement !== difficultyField) {
      difficultyField.value = String(state.difficulty);
    }

    const blocked = refusal(state, solve);
    submit.disabled = blocked !== null || sending;
    // The blocker only while it stands; what the last submission answered when
    // one has been made and nothing has moved since.
    note.textContent = outcome ?? blocked ?? "";
    note.hidden = note.textContent === "";
  }

  titleField.addEventListener("input", () => hooks.writeTitle(sanitizeTitle(titleField.value)));
  // `change`, not `input`, for the reason the goal's counters give: the value is
  // read whole, so the "1" on the way to "12" never becomes the author's rating
  // and a briefly empty box does not snap to the bottom of the scale.
  difficultyField.addEventListener("change", () =>
    hooks.writeDifficulty(clampDifficulty(Number(difficultyField.value))),
  );
  writeBackOnBlur(titleField, () => hooks.read().state.title);
  writeBackOnBlur(difficultyField, () => String(hooks.read().state.difficulty));

  submit.addEventListener("click", async () => {
    const { state, solve } = hooks.read();
    const blocked = refusal(state, solve);
    // All three are already true of a disabled button. Checked anyway, because
    // a click that gets past them is one that arrived between a change and the
    // redraw answering it, and what it would file is a second row in an
    // officer's queue that nothing downstream can tell from a real one.
    if (sending || blocked !== null || !solve) return;

    // Compiled before the await, so the body is the draft that was on the
    // screen when the button was pressed rather than whatever it has become by
    // the time the server answers.
    const draft = toSubmission(state, solve);
    sending = true;
    outcome = null;
    render();

    try {
      const verdict = await hooks.send(draft);
      outcome =
        `Sent for review at ${verdict.attack} attack — that is the target other ` +
        "players will be set. An officer looks at it before anyone plays it.";
      // The same borrowed gesture Copy makes, for the same reason: the button
      // is where the eye already is, and the line below it is the detail.
      submit.textContent = "Submitted";
      setTimeout(() => {
        submit.textContent = "Submit";
      }, SENT_MESSAGE_MS);
    } catch (error) {
      // The app rejects with `ApiError`, which carries the server's own
      // sentence — the entire reason the API renders JSON errors rather than
      // Hono's plain text. Anything else reaching here is a bug, and its
      // message is at least a true statement about what happened; only a
      // failure with nothing to say gets words of ours.
      outcome = error instanceof Error && error.message !== "" ? error.message : UNSAID;
    } finally {
      // In `finally` because the button has to come back whichever way this
      // went: a refusal the author can fix is worth nothing behind a control
      // that stayed disabled.
      sending = false;
      render();
    }
  });

  render();
  return {
    element,
    render,
    forget: () => {
      outcome = null;
    },
  };
}
