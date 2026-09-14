/**
 * Reading a solution back: a timeline, a transport, and the keyboard.
 *
 * What this replaces was three unlabelled buttons — ◀ ▶ ↺ — and the text
 * "2 / 3". It worked, in the sense that pressing ▶ enough times eventually
 * showed you the end. On a seventy-three placement solution that is not
 * reading, it is scrubbing by hand, and there was no way to go back to the
 * interesting bit once you had passed it.
 *
 * Three things change that, and they are all the same idea — **a solution is a
 * thing you read, not a thing you advance**:
 *
 * - **A timeline**, one tick per placement, with the ticks that clear lines
 *   marked. It is a picture of the whole solution before you have watched any
 *   of it, and you can click straight into the middle. On a long solve the
 *   marks are the shape of the answer: three quads in a row look like three
 *   quads in a row.
 * - **A transport with ends**, so ⏮ and ⏭ reach the start and the finish
 *   without walking there. There was an autoplay here for a while; it was cut
 *   because it earned a fifth control in a 214px rail and nobody wants a
 *   solution *played at* them — reading one is a thing you do at your own pace,
 *   which is what the timeline is for.
 * - **The keyboard**, because both hands are already there: ← → step, Home and
 *   End jump. Every one of them is what the same key does in any video player,
 *   which is the point — nobody should have to learn this.
 *
 * The keys are listened for on the document rather than bound through
 * `InputRouter`. They are not game keys: they must not be rebindable into a
 * conflict with hard drop, and they must not exist at all while a run is live.
 * The guard is `element.isConnected` — this component is unmounted by having
 * the rail replaced out from under it, so "am I still on screen" is the only
 * honest question, and the listener takes itself off when the answer is no.
 */

import type { SolutionPlayer } from "../game/solution-player";
import { pieceGlyph } from "../render/piece-glyph";
import { el, replaceChildren } from "./dom";
import type { ClearName } from "@shared/puzzle";

const CLEAR_LABELS: Readonly<Record<ClearName, string>> = {
  single: "single",
  double: "double",
  triple: "triple",
  quad: "quad",
  tss: "TSS",
  tsd: "TSD",
  tst: "TST",
  tsmini: "T mini",
  spin: "spin",
  "spin (no lines)": "empty spin",
  "perfect clear": "perfect clear",
};

export interface Replay {
  readonly element: HTMLElement;
  /**
   * Points the controls at a solution.
   *
   * @param onChange called whenever the board behind this should be redrawn.
   *   `stepped` is true only when the reader moved it themselves, and false for
   *   the first render — the verdict badge sits on the board and should survive
   *   landing on a solve, then get out of the way the moment somebody reads it.
   */
  bind(player: SolutionPlayer, onChange: (stepped: boolean) => void): void;
  /** Stops playing and gives up the keyboard. */
  detach(): void;
}

export function createReplay(): Replay {
  const track = el("div", { class: "replay__track" });
  const position = el("span", { class: "replay__position", text: "" });
  const caption = el("div", { class: "replay__caption" });
  const transport = el("div", { class: "replay__transport" });

  const element = el(
    "div",
    { class: "replay" },
    track,
    el("div", { class: "replay__head" }, caption, position),
    transport,
  );

  let player: SolutionPlayer | null = null;
  let notify: (stepped: boolean) => void = () => {};
  /** The tick buttons, rebuilt only when the solution changes. */
  let ticks: HTMLButtonElement[] = [];
  let keys: ((event: KeyboardEvent) => void) | null = null;

  /**
   * The document this component actually lives in.
   *
   * Not the global one. The keydown listener outlives a single frame — autoplay
   * can still be running when the panel is replaced — and a global `document`
   * is not guaranteed to be the same object, or to exist at all, by the time
   * the interval next fires. Reading it off the element is both more correct
   * and the only version that cannot throw on the way out.
   */
  function ownDocument(): Document | null {
    return element.ownerDocument ?? null;
  }

  function releaseKeys(): void {
    if (keys) ownDocument()?.removeEventListener("keydown", keys);
    keys = null;
  }

  /** Draws the controls and tells the caller to redraw the board. */
  function render(stepped: boolean): void {
    if (!player) return;
    const steps = player.placements;
    const at = player.position;

    // Two different states used to print the same thing: sitting on the last
    // placement, and having finished it. Pressing ▶ on the final piece is the
    // most consequential step in a replay and it looked like a no-op.
    // "done" replaces the fraction rather than joining it. The caption beside
    // this also went to the word "done" at the end, so the two together read
    // "3 / 3 · done" next to "done" — which a rail this narrow cannot afford
    // to say twice.
    position.textContent = player.atEnd ? "done" : `${at + 1} / ${steps.length}`;

    // Only the classes move. The ticks are built once per solution in `bind`,
    // because rebuilding N buttons on every frame is what made holding an arrow
    // key expensive on a seventy-three placement solve — and it threw away the
    // focused element every time, which is why the track could not be used from
    // the keyboard at all.
    ticks.forEach((tick, index) => {
      tick.classList.toggle("replay__tick--done", index < at);
      tick.classList.toggle("replay__tick--on", index === at);
    });

    const current = player.current;
    replaceChildren(
      caption,
      // Nothing at the end: the position readout carries that word now, and the
      // caption's job is to say what the *current placement* is.
      current ? pieceGlyph(current.piece, { cell: 10 }) : null,
      current?.clear
        ? el("span", {
            class: "replay__clear",
            text: `${CLEAR_LABELS[current.clear]} +${current.attack}`,
          })
        : null,
    );

    notify(stepped);
  }

  /** Runs `move`, stops any playback, and redraws. */
  function control(label: string, title: string, move: () => void): HTMLButtonElement {
    return el("button", {
      class: "btn btn--small",
      text: label,
      title,
      on: {
        click: () => {
          move();
          render(true);
        },
      },
    });
  }

  return {
    element,
    detach() {
      releaseKeys();
      player = null;
    },
    bind(next, onChange) {
      releaseKeys();
      player = next;
      notify = onChange;

      // The ticks, built once for this solution. One per placement and none for
      // the start: seeking to 0 is what ⏮ is for, and a tick meaning "before
      // anything" reads as an off-by-one to everybody who tries it.
      ticks = next.placements.map((step, index) =>
        el("button", {
          class: "replay__tick" + (step.clear ? " replay__tick--clears" : ""),
          // The full fact, not just a number: a tick's own content is a colour
          // and a height, so everything else it knows has to be said here for
          // anybody reading with a pointer or a screen reader.
          title: step.clear
            ? `${index + 1}. ${step.piece} — ${CLEAR_LABELS[step.clear]} +${step.attack}`
            : `${index + 1}. ${step.piece}`,
          attrs: {
            "aria-label": step.clear
              ? `Placement ${index + 1}, ${step.piece}, ${CLEAR_LABELS[step.clear]}`
              : `Placement ${index + 1}, ${step.piece}`,
          },
          on: {
            click: () => {
                  next.seek(index);
              render(true);
            },
          },
        }),
      );
      replaceChildren(track, ...ticks);

      replaceChildren(
        transport,
        control("⏮", "Back to the start", () => next.reset()),
        control("◀", "Previous placement", () => next.previous()),
        control("▶", "Next placement", () => next.next()),
        control("⏭", "Jump to the end", () => next.end()),
      );

      keys = (event: KeyboardEvent) => {
        // Unmounted by having the rail replaced out from under it, so this is
        // the only honest way to know whether these keys are still ours.
        if (!element.isConnected) {
          releaseKeys();
          return;
        }
        // Never steal a key from somewhere it is being typed.
        //
        // `event.target` is not always an element: with nothing focused it is
        // the document, which has no `closest`, and calling it threw inside the
        // listener — which swallowed the keypress entirely rather than failing
        // loudly. Narrowed rather than cast.
        // Duck-typed rather than `instanceof Element`: this runs anywhere the
        // document does, and a global `window` is not one of the things that is
        // always there.
        const target = event.target as { closest?: (selector: string) => unknown } | null;
        if (
          typeof target?.closest === "function" &&
          target.closest("input, textarea, select, [contenteditable]")
        ) {
          return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        // The settings sheet is a sibling of the deck rather than a screen, so
        // opening it leaves this component mounted and these keys live
        // underneath it. Space would then play a replay nobody can see while
        // somebody is rebinding a key.
        if (ownDocument()?.querySelector('[role="dialog"]:not([hidden])')) return;

        const act = (move: () => void) => {
          event.preventDefault();
          move();
          render(true);
        };
        if (event.key === "ArrowRight") act(() => next.next());
        else if (event.key === "ArrowLeft") act(() => next.previous());
        else if (event.key === "Home") act(() => next.reset());
        else if (event.key === "End") act(() => next.end());
      };
      ownDocument()?.addEventListener("keydown", keys);

      // Not a step: the controls drawing themselves for the first time, on a
      // result the reader has not moved off yet.
      render(false);
    },
  };
}
