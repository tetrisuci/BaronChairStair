/**
 * The goal's counters: a sentence, written by dialling numbers.
 *
 * Split out of `builder.ts` because it is a control of its own — text in, text
 * out — and because the file it came from is the largest on the client. It owns
 * every node under the goal's text field and nothing else: it never touches the
 * board, the queue or the code, and the only way it changes anything is by
 * handing back a whole goal sentence.
 *
 * Why the structure lives inside a sentence at all is explained in
 * `builder-state.ts`, above `GoalSpec`. The short of it: a blueprint code
 * carries exactly one free-text comment and that comment *is* the goal, so
 * there is nowhere else for counts to live. The two rules that follow from it
 * are enforced here — parsing is all-or-nothing, and nothing rewrites the text
 * unless a control moved.
 */

import type { ClearName } from "@shared/puzzle";
import {
  type GoalSpec,
  EMPTY_GOAL,
  formatGoal,
  GOAL_LABELS,
  goalFits,
  MAX_GOAL_ATTACK,
  MAX_GOAL_COUNT,
  parseGoal,
  unusedClears,
  withGoalAttack,
  withGoalEntry,
} from "./builder-state";
import { el, replaceChildren, writeBackOnBlur } from "./dom";

export interface GoalControlHooks {
  /** The goal as it stands. Read when a control moves, never cached. */
  readonly read: () => string;
  /** A new goal. Only ever a sentence that fits the comment's budget. */
  readonly write: (goal: string) => void;
  /** Redraw when nothing was written — a refusal still has to show. */
  readonly redraw: () => void;
}

export interface GoalControls {
  /** The controls, in the order they sit under the goal's own text field. */
  readonly nodes: readonly HTMLElement[];
  /** Redraw from the goal as it stands. */
  readonly render: () => void;
  /** Put them away wholesale — the goal is not editable while a test plays. */
  readonly setHidden: (hidden: boolean) => void;
  /** Set the attack figure, as the box would. Ignored on a prose goal. */
  readonly setAttack: (attack: number) => void;
  /** What to say instead of the board's own warnings, or null. */
  readonly refusal: () => string | null;
}

/**
 * A small whole-number box, the explorer's.
 *
 * On `change` rather than `input` for the same reason the explorer's are: the
 * value is read whole, so the "1" on the way to "12" never becomes the goal and
 * the row does not vanish under the caret when the field is briefly empty.
 */
function numberBox(max: number, label: string, onChange: (value: number) => void): HTMLInputElement {
  const input = el("input", {
    class: "explore__number",
    attrs: { type: "number", min: 0, max, inputmode: "numeric", "aria-label": label },
  });
  input.addEventListener("change", () => {
    const value = Number(input.value);
    if (Number.isFinite(value)) onChange(value);
  });
  return input;
}

/**
 * The counters, and the one rule that keeps them out of the author's way.
 *
 * Only the clears a goal already names get a row. Ten rows of mostly zeroes
 * would be the whole rail, and a zero is not part of a goal anyway — so a clear
 * enters through the picker below and leaves through its own ×.
 */
export function createGoalControls(hooks: GoalControlHooks): GoalControls {
  /** The live count boxes, by clear, so a redraw refills them instead of
   *  replacing them — a rebuilt input is one the caret has just been thrown out
   *  of, and every keystroke here redraws. */
  let counts = new Map<ClearName, HTMLInputElement>();
  /** The clears the rows on screen were built for, and the picker's options. */
  let rowShape = "";
  let pickShape = "";
  /** Set when the last edit was too long to fit the comment. */
  let refused = false;
  /** True while a test is playing; the prose case is decided per render. */
  let away = false;
  let prose = false;

  const rows = el("div", { class: "build__goals" });
  const attackBox = numberBox(MAX_GOAL_ATTACK, "Attack", (value) => setAttack(value));
  // An empty box is a goal that does not name a figure, not a goal of zero
  // attack, and the word is the difference.
  attackBox.placeholder = "none";
  const attackRow = el(
    "div",
    { class: "build__goal" },
    attackBox,
    el("span", { class: "explore__label", text: "Attack" }),
  );
  const pick = el("select", {
    class: "spec__select build__goal-pick",
    attrs: { "aria-label": "Clear type to add" },
  });
  const add = el("button", { class: "btn btn--small", text: "Add" });
  const picker = el("div", { class: "explore__controls build__goal-add" }, pick, add);
  const note = el("p", { class: "note build__goal-note" });

  /** The counts behind the goal as it stands. Empty when it is prose. */
  function spec(): GoalSpec {
    return parseGoal(hooks.read()) ?? EMPTY_GOAL;
  }

  /**
   * The only place the counters write the goal text — and the only place they
   * are allowed to. A load never comes through here, which is what leaves a
   * pasted goal worded exactly as its author wrote it.
   *
   * An overflow is dropped rather than truncated: half a sentence would stop
   * parsing, and the author would be left holding text the counters disown. The
   * controls are disabled ahead of it, so this is the belt to that braces.
   */
  function setGoal(next: GoalSpec): void {
    if (!goalFits(next)) {
      // Refused, not ignored. Returning here without a redraw left the box
      // showing a number the goal and the code did not carry, and said
      // nothing — the author's edit was gone and the screen claimed it landed.
      refused = true;
      hooks.redraw();
      return;
    }
    refused = false;
    hooks.write(formatGoal(next));
  }

  function setAttack(attack: number): void {
    // Guarded rather than folded through `spec()`: on a prose goal that would
    // hand back an empty spec with an attack on it, and rewrite somebody's
    // sentence as "Send 12 attack". The box is hidden for prose, so this is
    // only reachable through `setAttack` from outside.
    if (parseGoal(hooks.read()) === null) return;
    setGoal(withGoalAttack(spec(), attack));
  }

  /** One row per clear the goal names: how many, which, and a way out. */
  function buildRows(current: GoalSpec): void {
    counts = new Map();
    const built = current.clears.map((entry) => {
      const label = GOAL_LABELS[entry.clear];
      const box = numberBox(MAX_GOAL_COUNT, `${label} count`, (value) =>
        setGoal(withGoalEntry(spec(), entry.clear, value)),
      );
      // Registered here rather than once at construction, which is where it
      // was: the boxes are rebuilt every time the goal names a different set of
      // clears, so a listener attached to the ones that existed at start-up is
      // attached to nothing for the rest of the session.
      writeBackOnBlur(box, () => {
        const found = parseGoal(hooks.read())?.clears.find((row) => row.clear === entry.clear);
        return found ? String(found.count) : "";
      });
      counts.set(entry.clear, box);
      const drop = el("button", {
        class: "btn btn--small build__goal-drop",
        text: "×",
        attrs: { type: "button", "aria-label": `Remove ${label}` },
      });
      drop.addEventListener("click", () => setGoal(withGoalEntry(spec(), entry.clear, 0)));
      return el(
        "div",
        { class: "build__goal" },
        box,
        el("span", { class: "explore__label", text: label }),
        drop,
      );
    });
    replaceChildren(rows, ...built);
  }

  function applyVisibility(): void {
    for (const node of [rows, attackRow, picker]) node.hidden = away || prose;
    note.hidden = away || !prose;
  }

  function render(): void {
    const current = parseGoal(hooks.read());
    // Prose is the common case for a goal brought in from anywhere else, and it
    // is not an error: the counters step aside and the text field stays the
    // whole control. Nothing rewrites what is in it.
    prose = current === null;
    applyVisibility();
    if (current === null) {
      note.textContent =
        "This goal is written out in full, so the counters cannot show it. " +
        "Empty the field to build one from the list.";
      rowShape = "";
      pickShape = "";
      counts = new Map();
      replaceChildren(rows);
      return;
    }

    const shape = current.clears.map((entry) => entry.clear).join("|");
    if (shape !== rowShape) {
      rowShape = shape;
      buildRows(current);
    }
    // Same guard as the text fields: the caret in a focused box is not ours.
    for (const entry of current.clears) {
      const box = counts.get(entry.clear);
      if (box && document.activeElement !== box) box.value = String(entry.count);
    }
    if (document.activeElement !== attackBox) {
      // Blank rather than "0": no attack stated is not an attack of zero, and
      // the placeholder says which it is.
      attackBox.value = current.attack > 0 ? String(current.attack) : "";
    }

    const spare = unusedClears(current);
    const picks = spare.join("|");
    if (picks !== pickShape) {
      pickShape = picks;
      replaceChildren(
        pick,
        ...spare.map((clear) => el("option", { text: GOAL_LABELS[clear], attrs: { value: clear } })),
      );
    }
    const picked = pick.value as ClearName | "";
    pick.disabled = spare.length === 0;
    // The cap is the comment's, not ours: a goal naming every clear runs past
    // the length a code can carry, and Add going grey is where that shows.
    add.disabled = picked === "" || !goalFits(withGoalEntry(current, picked, 1));
  }

  // A clear enters the goal at 1, which is the count anybody adding one means.
  add.addEventListener("click", () => {
    const picked = pick.value as ClearName | "";
    if (picked !== "") setGoal(withGoalEntry(spec(), picked, 1));
  });
  // Re-run only to settle whether Add can afford the newly picked clear.
  pick.addEventListener("change", render);
  // The number boxes need a write-back for the same reason the text fields do:
  // `change` fires while the box is still focused, so `render`'s focus guard
  // skips it, and a clamped or refused value would otherwise sit on screen —
  // disagreeing with the goal and the code — until some unrelated redraw.
  writeBackOnBlur(attackBox, () => {
    const attack = parseGoal(hooks.read())?.attack ?? 0;
    return attack > 0 ? String(attack) : "";
  });

  return {
    nodes: [rows, attackRow, picker, note],
    render,
    setHidden(hidden: boolean): void {
      away = hidden;
      applyVisibility();
    },
    setAttack,
    refusal: () =>
      refused
        ? "That goal is longer than a blueprint comment holds, so the change was not made."
        : null,
  };
}
