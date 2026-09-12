/**
 * The two rails flanking the board: what you are holding and how you are doing
 * on the left, what the puzzle wants and what is coming on the right.
 */

import { clearShortfall, type ClearName, type ClearRequirement, type Mino, type PuzzlePrompt } from "@shared/puzzle";
import type { RunSnapshot } from "../game/runner";
import { pieceGlyph } from "../render/piece-glyph";
import { el, formatDuration, panel, replaceChildren, stat } from "./dom";

export interface HudPanels {
  readonly hold: HTMLElement;
  readonly progress: HTMLElement;
  // The attack meter is inside the goal panel — attack is progress toward
  // the goal — so there is no separate panel to compose.
  readonly goal: HTMLElement;
  readonly queue: HTMLElement;
}

export interface Hud {
  readonly left: HTMLElement;
  readonly right: HTMLElement;
  /** Exposed so the app can recompose the rails when the run ends. */
  readonly panels: HudPanels;
  setPuzzle(puzzle: PuzzlePrompt): void;
  /** Greys the undo and redo buttons when there is nothing to step to. */
  setHistory(canUndo: boolean, canRedo: boolean): void;
  update(snapshot: RunSnapshot): void;
  /** Freezes the meter at a finished run's total. */
  /** @param clears what the run actually made, so an unmet requirement still shows. */
  showFinal(attack: number, targetAttack: number, clears?: readonly ClearName[]): void;
}

/** Names players actually say, for the "so far" line. */
/** Pips drawn before a long requirement gives up and adds a "+". */
const MAX_PROGRESS_PIPS = 8;

const CLEAR_LABELS: Readonly<Record<string, string>> = {
  single: "single",
  double: "double",
  triple: "triple",
  quad: "quad",
  tss: "TSS",
  tsd: "TSD",
  tst: "TST",
  tsmini: "T mini",
  spin: "spin",
  "perfect clear": "PC",
};

export interface HudCallbacks {
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

export function createHud(callbacks: HudCallbacks): Hud {
  // ── Left rail ──────────────────────────────────────────────────────────────
  const holdBay = el("div", { class: "bay" }, el("span", { class: "label", text: "empty" }));
  const holdPanel = panel("Hold", {}, holdBay);

  // `progress__stats` so a layout can trim the between-attempts stats without
  // guessing — the duel and rush panels build their own `.stat` rows into this
  // same rail, and an unscoped `nth-child` rule would hide those instead. The
  // phone column hides the third onward; desktop keeps every row.
  const statsBody = el("div", { class: "progress__stats" });
  // Beside the count of pieces placed, because that is the number they change.
  const undoButton = el("button", {
    class: "btn btn--small",
    text: "↶ Undo",
    title: "Take back the last placement",
    on: { click: () => callbacks.onUndo() },
  });
  const redoButton = el("button", {
    class: "btn btn--small",
    text: "↷ Redo",
    title: "Put it back",
    on: { click: () => callbacks.onRedo() },
  });
  undoButton.disabled = true;
  redoButton.disabled = true;
  const progressPanel = panel(
    "Progress",
    {},
    statsBody,
    // `btnrow--history` so a layout can drop the row without guessing: the
    // rush panel's own `.btnrow` (Hand it in) must survive any such rule.
    // The phone column hides it — the two-finger/three-finger chords and the
    // keyboard keys are the same `stepHistory` path — while desktop keeps
    // the buttons.
    el("div", { class: "btnrow btnrow--history" }, undoButton, redoButton),
  );

  const left = el("div", { class: "rail rail--left" }, holdPanel, progressPanel);

  /** The clears the puzzle on the board demands. Set by `setPuzzle`. */
  let required: readonly ClearRequirement[] = [];

  // ── Right rail ─────────────────────────────────────────────────────────────
  const goalText = el("p", { class: "goal__text", text: "—" });
  const goalSub = el("p", { class: "goal__sub", text: "" });
  /**
   * How the required clears are going, one row each.
   *
   * In the goal panel rather than beside the attack meter, because it is the
   * goal that is being tracked — "2 of 3 TSDs" answers the sentence directly
   * above it, and the attack bar answers a different question that a puzzle
   * with a clear requirement no longer decides on its own.
   *
   * Absent entirely on a puzzle that requires nothing, which is every puzzle
   * when `GOAL_ENFORCEMENT` is not `on`: the prompt withholds the requirement,
   * so the panel is exactly what it always was.
   */
  const goalProgress = el("div", { class: "goal__progress", attrs: { hidden: true } });

  const meterValue = el("span", { class: "meter__value", text: "0" });
  const meterOf = el("span", { class: "meter__of", text: "of 0 sent" });
  const meterFill = el("div", { class: "meter__fill" });
  /*
   * The attack meter lives inside the goal panel, not beside it in a panel of
   * its own. Attack is progress toward the goal — the bar fills toward the
   * target the goal sentence names — so the panel captions were saying the
   * same thing twice with a border between them. One panel reads as one
   * number, one bar, one sentence; on the phone column it also buys back the
   * two panels' padding and caption, which is rows of board.
   */
  const meter = el(
    "div",
    { class: "goal__meter meter" },
    el("div", { class: "meter__numbers" }, meterValue, meterOf),
    el("div", { class: "meter__track" }, meterFill),
  );
  const goalPanel = panel(
    "Goal",
    { class: "panel--tinted" },
    goalText,
    goalProgress,
    meter,
    goalSub,
  );

  const queueList = el("div", { class: "queue" });
  const queuePanel = panel("Next", {}, queueList);

  const right = el("div", { class: "rail rail--right" }, goalPanel, queuePanel);

  /** The clears this puzzle still owes, as a phrase. Empty when it owes none. */
  function owed(clears: readonly ClearName[]): string {
    return clearShortfall(clears, required)
      .map((entry) => `${entry.count} more ${CLEAR_LABELS[entry.clear] ?? entry.clear}`)
      .join(", ");
  }

  /**
   * One row per required clear: what it is, how many, and how far.
   *
   * Counted from the run's own `clears` rather than from the shortfall, because
   * a player wants "2 of 3", not "1 to go" — the same number the goal sentence
   * used, moving. Overshoot is clamped in the readout: a fourth TSD on a goal of
   * three still reads 3 of 3 rather than 4 of 3, which would look like a fault.
   *
   * Pips as well as the count, because the count is read and the pips are
   * *seen* — mid-run, with a piece falling, the row has to be legible at a
   * glance rather than parsed.
   */
  function paintProgress(clears: readonly ClearName[]): void {
    if (required.length === 0) {
      goalProgress.hidden = true;
      replaceChildren(goalProgress);
      return;
    }
    const made = new Map<ClearName, number>();
    for (const clear of clears) made.set(clear, (made.get(clear) ?? 0) + 1);

    goalProgress.hidden = false;
    replaceChildren(
      goalProgress,
      ...required.map((entry) => {
        const done = Math.min(made.get(entry.clear) ?? 0, entry.count);
        const met = done >= entry.count;
        return el(
          "div",
          {
            class: `goal__need${met ? " goal__need--met" : ""}`,
            // The row is three separate scraps of text on screen; read one by
            // one that is not a sentence. Said once, properly, for a reader who
            // is not looking at it.
            attrs: {
              role: "status",
              "aria-label": `${done} of ${entry.count} ${CLEAR_LABELS[entry.clear] ?? entry.clear}${met ? ", done" : ""}`,
            },
          },
          el("span", { class: "goal__need-name", text: CLEAR_LABELS[entry.clear] ?? entry.clear }),
          el(
            "span",
            { class: "pips", attrs: { "aria-hidden": "true" } },
            // Capped so a goal of thirty does not draw thirty pips across a
            // 200px rail; the count beside it stays exact either way.
            // The archive's own difficulty pips, reused rather than reinvented —
            // same shape, same weight, and a reader who has learnt one has
            // learnt the other.
            ...Array.from({ length: Math.min(entry.count, MAX_PROGRESS_PIPS) }, (_, i) =>
              el("span", { class: `pips__dot${i < done ? " pips__dot--on" : ""}` }),
            ),
            entry.count > MAX_PROGRESS_PIPS ? el("span", { class: "pips__plus", text: "+" }) : null,
          ),
          el("span", {
            class: "goal__need-count",
            attrs: { "aria-hidden": "true" },
            text: `${done} / ${entry.count}`,
          }),
        );
      }),
    );
  }

  /**
   * The bar, and whether the target is actually *met*.
   *
   * Attack alone used to light it green, which under a clear requirement is the
   * meter telling the player they are done while the run carries on and the
   * server disagrees. The caption carries the reason, because a full bar that
   * is not green is a puzzle, not an answer.
   */
  function paintMeter(attack: number, target: number, still = ""): void {
    const ratio = target === 0 ? 0 : Math.min(1, attack / target);
    meterValue.textContent = String(attack);
    meterFill.style.width = `${ratio * 100}%`;
    // Still gated on the clears — a full bar that is not a solve must not read
    // as one — but the caption goes back to answering the attack question. What
    // is outstanding is now a row in the goal panel, said properly.
    meter.classList.toggle("meter--met", attack >= target && target > 0 && still === "");
    meterOf.textContent = `of ${target} sent`;
  }

  function renderHold(piece: Mino | null, locked: boolean): void {
    replaceChildren(
      holdBay,
      piece
        ? pieceGlyph(piece, { cell: 13, muted: locked })
        : el("span", { class: "label", text: "empty" }),
    );
  }

  function renderQueue(upcoming: readonly Mino[], placed: number): void {
    // Every piece, not a preview: the queue panel scrolls on the desktop and
    // flex-fills the phone column, so a long puzzle's whole order is reachable
    // — a "+17 more" teaser made the length visible but never the pieces,
    // which is the one thing a queue is for.
    const rows = upcoming.map((piece, index) =>
      el(
        "div",
        { class: `queue__row${index === 0 ? " queue__row--current" : ""}` },
        el("span", { class: "queue__index", text: String(placed + index + 2) }),
        pieceGlyph(piece, { cell: 9 }),
      ),
    );
    replaceChildren(queueList, ...rows);
  }

  return {
    left,
    right,
    panels: {
      hold: holdPanel,
      progress: progressPanel,
      // The meter is inside the goal panel now — see its construction above.
      goal: goalPanel,
      queue: queuePanel,
    },
    setHistory(canUndo, canRedo) {
      undoButton.disabled = !canUndo;
      redoButton.disabled = !canRedo;
    },

    setPuzzle(puzzle) {
      const pieces = puzzle.queue.length + (puzzle.hold ? 1 : 0);
      // Held for the meter, which has to know what is still owed on every
      // update. Absent on a puzzle with no requirement, and on every puzzle
      // while `GOAL_ENFORCEMENT` is not `on` — the prompt withholds it, so the
      // meter reads exactly as it always did.
      required = puzzle.requiredClears ?? [];
      paintProgress([]);
      goalText.textContent = puzzle.goal || "Send as much as the reference line";
      goalSub.textContent = `${puzzle.targetAttack} attack · ${pieces} pieces`;
      paintMeter(0, puzzle.targetAttack);
    },
    update(snapshot) {
      renderHold(snapshot.hold, snapshot.holdLocked);
      renderQueue(snapshot.upcoming, snapshot.piecesPlaced);
      paintMeter(snapshot.attack, snapshot.targetAttack, owed(snapshot.clears));
      paintProgress(snapshot.clears);

      const line = snapshot.clears.map((clear) => CLEAR_LABELS[clear] ?? clear).join(" + ");
      replaceChildren(
        statsBody,
        stat("Pieces", `${snapshot.piecesPlaced} / ${snapshot.pieceBudget}`),
        stat("Time", formatDuration(snapshot.elapsedMs)),
        stat("Restarts", snapshot.resets),
        stat("So far", line || "—"),
      );
    },
    showFinal(attack, targetAttack, clears = []) {
      paintMeter(attack, targetAttack, owed(clears));
      paintProgress(clears);
    },
  };
}
