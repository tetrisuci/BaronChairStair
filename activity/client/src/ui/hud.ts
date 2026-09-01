/**
 * The two rails flanking the board: what you are holding and how you are doing
 * on the left, what the puzzle wants and what is coming on the right.
 */

import type { Mino, PuzzlePrompt } from "@shared/puzzle";
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
  update(snapshot: RunSnapshot): void;
  /** Freezes the meter at a finished run's total. */
  showFinal(attack: number, targetAttack: number): void;
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

export function createHud(): Hud {
  // ── Left rail ──────────────────────────────────────────────────────────────
  const holdBay = el("div", { class: "bay" }, el("span", { class: "label", text: "empty" }));
  const holdPanel = panel("Hold", {}, holdBay);

  const statsBody = el("div");
  const progressPanel = panel("Progress", {}, statsBody);

  const left = el("div", { class: "rail rail--left" }, holdPanel, progressPanel);

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

  const right = el("div", { class: "rail rail--right" }, goalPanel, meterPanel, queuePanel);

  function paintMeter(attack: number, target: number): void {
    const ratio = target === 0 ? 0 : Math.min(1, attack / target);
    meterValue.textContent = String(attack);
    meterFill.style.width = `${ratio * 100}%`;
    meter.classList.toggle("meter--met", attack >= target && target > 0);
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
    setPuzzle(puzzle) {
      const pieces = puzzle.queue.length + (puzzle.hold ? 1 : 0);
      goalText.textContent = puzzle.goal || "Send as much as the reference line";
      goalSub.textContent = `${puzzle.targetAttack} attack · ${pieces} pieces`;
      meterOf.textContent = `of ${puzzle.targetAttack} sent`;
      paintMeter(0, puzzle.targetAttack);
    },
    update(snapshot) {
      renderHold(snapshot.hold, snapshot.holdLocked);
      renderQueue(snapshot.upcoming, snapshot.piecesPlaced);
      paintMeter(snapshot.attack, snapshot.targetAttack);

      const line = snapshot.clears.map((clear) => CLEAR_LABELS[clear] ?? clear).join(" + ");
      replaceChildren(
        statsBody,
        stat("Pieces", `${snapshot.piecesPlaced} / ${snapshot.pieceBudget}`),
        stat("Time", formatDuration(snapshot.elapsedMs)),
        stat("Restarts", snapshot.resets),
        stat("So far", line || "—"),
      );
    },
    showFinal(attack, targetAttack) {
      paintMeter(attack, targetAttack);
    },
  };
}
