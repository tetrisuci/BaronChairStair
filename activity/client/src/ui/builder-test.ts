/**
 * Playing the draft, on the board it was painted on.
 *
 * A test does not open the game's playfield. The builder's grid is already ten
 * cells by twenty with row 0 on the floor — the same shape and the same
 * direction a `BoardView` comes in — so the cheapest honest thing to do is
 * paint the run into the cells the author has been clicking on, and leave the
 * rails where they are. Nothing is mounted, nothing is measured, and the draft
 * is exactly where it was left when the run is put away.
 *
 * What a test can and cannot tell the author:
 *
 * - **It proves a solve exists**, because the author just played one. That is
 *   the question a puzzle sheet cannot answer on its own, and the reason
 *   `warningFor` has never claimed a board is solvable.
 * - **It checks the goal by name.** The run reports every clear it made, so
 *   "Clear 2 TSDs and 1 TST" is verified clear by clear rather than by the one
 *   number underneath it. A goal written as prose cannot be checked, and says
 *   so instead of quietly passing.
 * - **It cannot check what the author has not written down.** A goal naming no
 *   attack has no target — see `NO_TARGET` — so the run plays its queue out and
 *   the panel offers the attack it sent as the figure to adopt.
 */

import { COLUMNS } from "@shared/blueprint/playfield";
import type { ClearName } from "@shared/puzzle";
import type { RunSnapshot } from "../game/runner";
import type { BoardView } from "../render/board";
import { inkFor, PAPER } from "../render/skin";
import { GOAL_LABELS, MAX_ROWS, type GoalSpec } from "./builder-state";
import { el, panel, replaceChildren } from "./dom";

/** One line of the goal, as the run left it. */
export interface GoalLine {
  readonly label: string;
  readonly want: number;
  readonly got: number;
  readonly met: boolean;
}

/** What the run managed, as the checker reads it. */
export interface TestResult {
  readonly clears: readonly ClearName[];
  readonly attack: number;
}

/**
 * The goal, line by line, against what the run actually did.
 *
 * Empty for a prose goal and for a goal that asks for nothing — two different
 * situations that both mean "there is nothing here to check", and the panel
 * says which.
 *
 * `got >= want` rather than `===`: a goal is a floor. Somebody who asked for
 * two TSDs and found a line with three has met it, and telling them otherwise
 * would be the tool arguing with the puzzle.
 */
export function goalReport(spec: GoalSpec | null, result: TestResult): GoalLine[] {
  if (!spec) return [];
  const counts = new Map<ClearName, number>();
  for (const clear of result.clears) counts.set(clear, (counts.get(clear) ?? 0) + 1);

  const lines = spec.clears
    .filter((entry) => entry.count > 0)
    .map((entry) => {
      const got = counts.get(entry.clear) ?? 0;
      return { label: GOAL_LABELS[entry.clear], want: entry.count, got, met: got >= entry.count };
    });

  if (spec.attack > 0) {
    lines.push({
      label: "Attack",
      want: spec.attack,
      got: result.attack,
      met: result.attack >= spec.attack,
    });
  }
  return lines;
}

/**
 * The clears the run made that the goal never asked for, as a sentence.
 *
 * Not decoration — it is the answer to the commonest confusing result. A quad
 * that empties the board is reported by the engine as a perfect clear and by
 * nothing else, so a goal asking for a quad reads `✗ 1 Quad 0` beside a run
 * that plainly cleared four lines. One clear has one name, and this is where
 * the name it got is said out loud.
 */
export function extraClears(spec: GoalSpec | null, result: TestResult): string {
  const asked = new Set(spec?.clears.map((entry) => entry.clear) ?? []);
  const counts = new Map<ClearName, number>();
  for (const clear of result.clears) {
    if (!asked.has(clear)) counts.set(clear, (counts.get(clear) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  const phrases = [...counts].map(([clear, count]) => `${count} ${GOAL_LABELS[clear]}`);
  return `Also made ${phrases.join(", ")}.`;
}

/**
 * One frame of a run, onto the cells the author paints on.
 *
 * `nodes` is the grid in document order — top row first — and the view counts
 * up from the floor, which is the one flip in here and the same one
 * `builder.ts` does when it draws the stack.
 *
 * The ghost is drawn only where nothing else is: a ghost under the falling
 * piece or over the stack is a cell claiming to be two things, and the board is
 * small enough that the brighter of the two always wins the eye.
 */
export function paintFrame(nodes: readonly HTMLElement[], view: BoardView): void {
  const active = new Map<number, string>();
  if (view.activeInk) {
    for (const [x, y] of view.active) active.set(y * COLUMNS + x, view.activeInk);
  }
  const ghost = new Set(view.ghost.map(([x, y]) => y * COLUMNS + x));
  const flashing = view.flashStrength > 0 ? new Set(view.flashRows) : new Set<number>();

  for (let y = 0; y < MAX_ROWS; y++) {
    for (let x = 0; x < COLUMNS; x++) {
      const node = nodes[(MAX_ROWS - 1 - y) * COLUMNS + x];
      if (!node) continue;
      const index = y * COLUMNS + x;
      const ink = active.get(index) ?? inkFor(view.cells[y]?.[x] ?? null);
      const isGhost = ink === null && ghost.has(index);
      node.className = `build__cell${ink ? " build__cell--on" : ""}${
        isGhost ? " build__cell--ghost" : ""
      }`;
      node.style.background = flashing.has(y)
        ? PAPER.flash
        : (ink ?? (isGhost ? (view.activeInk ?? "") : ""));
    }
  }
}

export interface TestPanelCallbacks {
  readonly onStart: () => void;
  readonly onAgain: () => void;
  readonly onStop: () => void;
  /** Write the attack the run sent into the goal, since nothing else knows it. */
  readonly onAdopt: (attack: number) => void;
}

export interface TestPanel {
  /** The left rail's card: start it, watch it, leave it. */
  readonly element: HTMLElement;
  /** The goal's progress, shown where the counters are while a test runs. */
  readonly goalElement: HTMLElement;
  readonly update: (snapshot: RunSnapshot, spec: GoalSpec | null) => void;
  /** Back to offering a test rather than reporting one. */
  readonly reset: () => void;
}

function headline(snapshot: RunSnapshot, lines: readonly GoalLine[]): string {
  if (snapshot.phase === "ready") return "Press a key to start.";
  if (snapshot.phase === "playing") return "Playing.";
  if (lines.length === 0) {
    // No goal to judge it by, so the only true thing to say is what happened.
    return `Out of pieces — ${snapshot.attack} attack sent.`;
  }
  if (lines.every((line) => line.met)) return "The goal was met. This puzzle has an answer.";
  // Stricter than the game, and worth saying so. A shipped puzzle ends the
  // moment its attack target is reached, so this run is a solve by the rules
  // the player will actually be under — and the goal's own words were still
  // not all satisfied, which means the sentence asks for more than the number.
  if (snapshot.phase === "solved") {
    return "The attack target was reached without every clear the goal names.";
  }
  return "The goal was not met on this attempt.";
}

/**
 * The panel that starts a test and then reports on it.
 *
 * One card in two states rather than two cards, because they are the same
 * question at different times — "can this be played?" and "here is what
 * happened when it was" — and a second card would sit empty for whichever of
 * them was not happening.
 */
export function createTestPanel(callbacks: TestPanelCallbacks): TestPanel {
  const start = el("button", { class: "btn btn--small", text: "Test" });
  const again = el("button", { class: "btn btn--small", text: "Play again" });
  const stop = el("button", { class: "btn btn--small", text: "Back to editing" });
  const adopt = el("button", { class: "btn btn--small" });

  start.addEventListener("click", () => callbacks.onStart());
  again.addEventListener("click", () => callbacks.onAgain());
  stop.addEventListener("click", () => callbacks.onStop());

  const blurb = el("p", {
    class: "rush__blurb",
    text: "Play the draft yourself. Nothing is filed and nothing is scored.",
  });
  const idle = el("div", { class: "btnrow" }, start);
  // Polite and on the status line rather than on the board: the board is a
  // grid of unlabelled cells while a run is on it, so this is the only thing
  // that says out loud what the run just did.
  const status = el("p", { class: "note", attrs: { role: "status", "aria-live": "polite" } });
  const progress = el("p", { class: "explore__count" });
  const live = el("div", {}, status, progress, el("div", { class: "btnrow" }, again, stop), adopt);

  const extras = el("p", { class: "note build__check-extra" });
  const goalElement = el("div", { class: "build__check" }, extras);
  const element = panel("Test", {}, blurb, idle, live);

  function reset(): void {
    idle.hidden = false;
    blurb.hidden = false;
    live.hidden = true;
    extras.textContent = "";
    replaceChildren(goalElement, extras);
  }

  function update(snapshot: RunSnapshot, spec: GoalSpec | null): void {
    idle.hidden = true;
    blurb.hidden = true;
    live.hidden = false;

    const lines = goalReport(spec, snapshot);
    status.textContent = headline(snapshot, lines);
    progress.textContent =
      `${snapshot.piecesPlaced} / ${snapshot.pieceBudget} pieces · ` +
      `${snapshot.attack} attack`;

    const over = snapshot.phase === "solved" || snapshot.phase === "failed";
    // Offered only where it is the missing piece: the goal parses, it names no
    // attack, and the run sent some. Written into a prose goal it would rewrite
    // somebody's sentence, which nothing in the builder is allowed to do.
    const canAdopt = over && spec !== null && spec.attack === 0 && snapshot.attack > 0;
    adopt.hidden = !canAdopt;
    if (canAdopt) {
      adopt.textContent = `Set the goal to ${snapshot.attack} attack`;
      adopt.onclick = () => callbacks.onAdopt(snapshot.attack);
    }

    // Rebuilt every frame with the rest of the list, so it is appended rather
    // than left in place — one node, and the alternative is a second container
    // for it to survive in.
    const also = extraClears(spec, snapshot);
    extras.textContent = also;
    extras.hidden = also === "";

    replaceChildren(
      goalElement,
      ...(spec === null
        ? [
            el("p", {
              class: "note",
              text: "This goal is written out in full, so a test cannot check it.",
            }),
          ]
        : lines.map((line) =>
            el(
              "p",
              { class: `build__check-line${line.met ? " build__check-line--met" : ""}` },
              el("span", { text: `${line.met ? "✓" : "✗"} ${line.want} ${line.label}` }),
              el("span", { text: String(line.got) }),
            ),
          )),
      extras,
    );
  }

  reset();
  return { element, goalElement, update, reset };
}
