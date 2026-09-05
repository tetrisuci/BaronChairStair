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
  readonly goal: HTMLElement;
  readonly meter: HTMLElement;
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

const QUEUE_PREVIEW_LIMIT = 7;

/** Names players actually say, for the "so far" line. */
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

  const statsBody = el("div");
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
    el("div", { class: "btnrow" }, undoButton, redoButton),
  );

  const left = el("div", { class: "rail rail--left" }, holdPanel, progressPanel);

  /** The clears the puzzle on the board demands. Set by `setPuzzle`. */
  let required: readonly ClearRequirement[] = [];

  // ── Right rail ─────────────────────────────────────────────────────────────
  const goalText = el("p", { class: "goal__text", text: "—" });
  const goalSub = el("p", { class: "goal__sub", text: "" });
  const goalPanel = panel("Goal", { class: "panel--tinted" }, goalText, goalSub);

  const meterValue = el("span", { class: "meter__value", text: "0" });
  const meterOf = el("span", { class: "meter__of", text: "of 0 sent" });
  const meterFill = el("div", { class: "meter__fill" });
  const meter = el(
    "div",
    { class: "meter" },
    el("div", { class: "meter__numbers" }, meterValue, meterOf),
    el("div", { class: "meter__track" }, meterFill),
  );
  const meterPanel = panel("Attack", {}, meter);

  const queueList = el("div", { class: "queue" });
  const queuePanel = panel("Next", {}, queueList);

  const right = el("div", { class: "rail" }, goalPanel, meterPanel, queuePanel);

  /** The clears this puzzle still owes, as a phrase. Empty when it owes none. */
  function owed(clears: readonly ClearName[]): string {
    return clearShortfall(clears, required)
      .map((entry) => `${entry.count} more ${CLEAR_LABELS[entry.clear] ?? entry.clear}`)
      .join(", ");
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
    meter.classList.toggle("meter--met", attack >= target && target > 0 && still === "");
    meterOf.textContent = still === "" ? `of ${target} sent` : `still needs ${still}`;
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
    const rows = upcoming.slice(0, QUEUE_PREVIEW_LIMIT).map((piece, index) =>
      el(
        "div",
        { class: `queue__row${index === 0 ? " queue__row--current" : ""}` },
        el("span", { class: "queue__index", text: String(placed + index + 2) }),
        pieceGlyph(piece, { cell: 9 }),
      ),
    );
    const remaining = upcoming.length - rows.length;
    if (remaining > 0) {
      rows.push(
        el(
          "div",
          { class: "queue__row" },
          el("span", { class: "queue__index", text: "+" }),
          el("span", { class: "label", text: String(remaining) }),
        ),
      );
    }
    replaceChildren(queueList, ...rows);
  }

  return {
    left,
    right,
    panels: {
      hold: holdPanel,
      progress: progressPanel,
      goal: goalPanel,
      meter: meterPanel,
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
      goalText.textContent = puzzle.goal || "Send as much as the reference line";
      goalSub.textContent = `${puzzle.targetAttack} attack · ${pieces} pieces`;
      paintMeter(0, puzzle.targetAttack);
    },
    update(snapshot) {
      renderHold(snapshot.hold, snapshot.holdLocked);
      renderQueue(snapshot.upcoming, snapshot.piecesPlaced);
      paintMeter(snapshot.attack, snapshot.targetAttack, owed(snapshot.clears));

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
    },
  };
}
