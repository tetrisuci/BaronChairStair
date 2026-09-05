/**
 * When the verdict badge gets out of the way.
 *
 * The badge lands on the board when a run ends, which is right for a result and
 * wrong the moment the board becomes something to read. Reported from play: the
 * "Solved!" badge sat over the board while the player stepped through the
 * solution it was covering.
 *
 * The fix is one bit — whether a redraw came from the player moving the
 * walkthrough or from the panel drawing itself for the first time — so that is
 * what these pin. Hiding on *every* redraw would take the badge away the instant
 * the run ended, which is the celebration this feature is not supposed to cost.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { BOARD_HEIGHT, type RowCode, type SolutionStep } from "../shared/puzzle";
import { SolutionPlayer } from "../client/src/game/solution-player";
import { createWalkthroughPanel } from "../client/src/ui/results";

let window: Window;
const saved = { document: globalThis.document };

beforeAll(() => {
  // Scoped to this file, for the reason render.test.ts gives: `bun test` shares
  // one process and the server suite leans on Bun's own fetch/Request.
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
});

afterAll(() => {
  globalThis.document = saved.document;
});

const BOARD: readonly RowCode[] = ["GGG...GGGG"];

const STEPS: readonly SolutionStep[] = [
  { piece: "T", cells: [[3, 0], [4, 0], [5, 0], [4, 1]], clear: "tsd", attack: 4 },
  { piece: "I", cells: [[0, 1], [1, 1], [2, 1], [3, 1]], clear: null, attack: 0 },
];

/** The panel, bound, with every `stepped` flag it has reported so far. */
function bound() {
  const player = new SolutionPlayer({ board: BOARD }, STEPS, BOARD_HEIGHT);
  const seen: boolean[] = [];
  const panel = createWalkthroughPanel();
  panel.bind(player, (stepped) => void seen.push(stepped));
  return { panel, player, seen };
}

/** The walkthrough's controls, in the order the panel builds them. */
function buttons(panel: { element: HTMLElement }): HTMLButtonElement[] {
  return [...panel.element.querySelectorAll("button")] as unknown as HTMLButtonElement[];
}

describe("stepping the solution", () => {
  test("binding is not a step, so a result survives being shown", () => {
    const { seen } = bound();
    expect(seen).toEqual([false]);
  });

  test("every control reports a step", () => {
    const { panel, seen } = bound();
    const [previous, next, restart] = buttons(panel);

    next?.click();
    previous?.click();
    restart?.click();

    // The first is the bind; the three after it are the presses.
    expect(seen).toEqual([false, true, true, true]);
  });

  test("the board really moves, so the flag is not all that changed", () => {
    const { panel, player } = bound();
    const [, next] = buttons(panel);

    expect(player.position).toBe(0);
    next?.click();
    expect(player.position).toBe(1);
  });
});
