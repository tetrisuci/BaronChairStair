/**
 * The pointer state machine, driven without a browser.
 *
 * A gesture tracker decides what a contact *means* — aim, commit, rotate,
 * hold — and the adapter turns those verdicts into calls on the run. Both
 * halves are tested here: the tracker headlessly, and the adapter through a
 * happy-dom element, which dispatches real PointerEvents even though it never
 * lays anything out.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  PointerGestureTracker,
  type Gesture,
  type Spot,
} from "../client/src/game/pointer";

const at = (column: number, row: number): Spot => ({ column, row });

/** Collects a tracker's gestures, with a short injected hold delay. */
function tracked(holdDelay = 20) {
  const gestures: Gesture[] = [];
  const tracker = new PointerGestureTracker((gesture) => gestures.push(gesture), holdDelay);
  return { tracker, gestures };
}

const WAIT = 8;
/** Short of the injected 20ms hold window, so a release at WAIT is a rotate. */
const QUICK = WAIT;
/** Long enough for the injected hold timer to have fired. */
const holdTick = (): Promise<void> => Bun.sleep(50);

describe("gesture tracker", () => {
  test("a press that stays put and releases quickly rotates", () => {
    const { tracker, gestures } = tracked();
    expect(tracker.press(at(4, 5), 0)).toBeNull();
    expect(tracker.release(QUICK)).toEqual({ type: "rotate" });
    expect(gestures).toEqual([]);
  });

  test("a press that leaves the origin square aims, and releasing commits", () => {
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(5, 5))).toEqual({ type: "aim", spot: at(5, 5) });
    expect(tracker.move(at(6, 7))).toEqual({ type: "aim", spot: at(6, 7) });
    expect(tracker.release(WAIT * 2)).toEqual({ type: "commit", spot: at(6, 7) });
  });

  test("returning to the origin square keeps aiming — the verdict was already made", () => {
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(5, 5))).toEqual({ type: "aim", spot: at(5, 5) });
    expect(tracker.move(at(4, 5))).toEqual({ type: "aim", spot: at(4, 5) });
    expect(tracker.release(QUICK * 2)).toEqual({ type: "commit", spot: at(4, 5) });
  });

  test("a press that sits still becomes a hold, not a rotate", async () => {
    const { tracker, gestures } = tracked();
    tracker.press(at(4, 5), 0);
    expect(gestures).toEqual([]);
    await holdTick();
    expect(gestures).toEqual([{ type: "hold" }]);
  });

  test("a drag never becomes a hold, even left parked", async () => {
    const { tracker, gestures } = tracked();
    tracker.press(at(4, 5), 0);
    tracker.move(at(6, 5));
    await holdTick();
    expect(gestures).toEqual([]);
    // And the drag can still be finished.
    expect(tracker.release(WAIT * 2)).toEqual({ type: "commit", spot: at(6, 5) });
  });

  test("a held contact's release is inert, and a new press works normally", async () => {
    const { tracker, gestures } = tracked();
    tracker.press(at(4, 5), 0);
    await holdTick();
    expect(gestures).toEqual([{ type: "hold" }]);
    expect(tracker.release(QUICK)).toBeNull();
    expect(tracker.press(at(2, 3), QUICK * 2)).toBeNull();
    expect(tracker.release(QUICK * 3)).toEqual({ type: "rotate" });
  });

  test("a held contact that the browser cancels leaves nothing to undo", async () => {
    const { tracker, gestures } = tracked();
    tracker.press(at(4, 5), 0);
    await holdTick();
    expect(gestures).toEqual([{ type: "hold" }]);
    expect(tracker.cancel()).toBeNull();
  });

  test("a drag the browser cancels asks to unaim", () => {
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    tracker.move(at(7, 5));
    expect(tracker.cancel()).toEqual({ type: "cancel" });
  });

  test("moves without a press, and second presses while one is down, are ignored", () => {
    const { tracker } = tracked();
    expect(tracker.move(at(4, 5))).toBeNull();
    expect(tracker.press(at(4, 5), 0)).toBeNull();
    expect(tracker.press(at(6, 6), 1)).toBeNull();
    // The first contact still owns the state.
    expect(tracker.release(QUICK)).toEqual({ type: "rotate" });
  });
});

describe("the pointer adapter", () => {
  let window: Window;
  const saved = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
  };

  beforeAll(() => {
    // Scoped like render.test.ts: bun test shares one process and the server
    // suite leans on Bun's own fetch/Request.
    window = new Window({ url: "https://local.test/" });
    globalThis.document = window.document as unknown as Document;
    globalThis.getComputedStyle = window.getComputedStyle.bind(
      window,
    ) as unknown as typeof getComputedStyle;
  });

  afterAll(() => {
    globalThis.document = saved.document;
    globalThis.getComputedStyle = saved.getComputedStyle;
  });

  /** happy-dom has no pointer capture; the adapter only sets it. */
  const element = (): HTMLElement => {
    const node = window.document.createElement("div");
    (node as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    window.document.body.append(node);
    return node as unknown as HTMLElement;
  };

  function pointer(
    type: string,
    x: number,
    y: number,
    options: { pointerId?: number; button?: number; pointerType?: string } = {},
  ): PointerEvent {
    return new window.PointerEvent(type, {
      clientX: x,
      clientY: y,
      pointerId: options.pointerId ?? 1,
      button: options.button ?? 0,
      pointerType: options.pointerType ?? "touch",
      bubbles: true,
    }) as unknown as PointerEvent;
  }

  test("tap rotates, drag aims and commits, right-click is ignored", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    const box = { left: 10, top: 20 };
    node.getBoundingClientRect = () => box as DOMRect;
    const calls: string[] = [];
    let aim: Spot | null = null;
    const detach = attachPointerPlay(node, {
      spotAt: (x, y) => ({ column: Math.floor(x / 20), row: 9 - Math.floor(y / 20) }),
      aim: (spot) => {
        aim = spot;
        calls.push(`aim:${spot.column},${spot.row}`);
      },
      commit: (spot) => calls.push(`commit:${spot.column},${spot.row}`),
      unaim: () => calls.push("unaim"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
    });

    // spotAt receives coordinates the adapter has already made local.
    // A right-click never starts a gesture.
    node.dispatchEvent(pointer("pointerdown", 25, 25, { button: 2, pointerType: "mouse" }));
    // A tap: down and up on the same square (cell 0, row 9).
    node.dispatchEvent(pointer("pointerdown", 25, 25));
    node.dispatchEvent(pointer("pointerup", 25, 25));
    expect(calls).toEqual(["rotate"]);
    expect(aim).toBeNull();

    // A drag to the neighbouring cell (1, 9), then let go.
    node.dispatchEvent(pointer("pointerdown", 25, 25));
    node.dispatchEvent(pointer("pointermove", 45, 25));
    expect(calls).toEqual(["rotate", "aim:1,9"]);
    node.dispatchEvent(pointer("pointerup", 45, 25));
    expect(calls).toEqual(["rotate", "aim:1,9", "commit:1,9"]);

    detach();
  });

  test("a second finger can steal neither the aim nor the release", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      spotAt: () => at(3, 4),
      aim: () => calls.push("aim"),
      commit: () => calls.push("commit"),
      unaim: () => calls.push("unaim"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
    });

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointermove", 10, 10, { pointerId: 2 }));
    // The first finger lifts, and only then the second.
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 2 }));
    // First finger's tap rotated; the second finger never touched the game.
    expect(calls).toEqual(["rotate"]);
    detach();
  });

  test("the context menu is suppressed", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    let defaultPrevented = false;
    const event = new window.Event("contextmenu", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "preventDefault", {
      value: () => {
        defaultPrevented = true;
      },
    });
    const detach = attachPointerPlay(node as unknown as HTMLElement, {
      spotAt: () => null,
      aim: () => {},
      commit: () => {},
      unaim: () => {},
      rotate: () => {},
      hold: () => {},
    });
    node.dispatchEvent(event as unknown as Event);
    expect(defaultPrevented).toBe(true);
    detach();
  });
});
