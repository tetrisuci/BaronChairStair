/**
 * The pointer state machine, driven without a browser.
 *
 * A gesture tracker decides what a contact *means* — grab, carry, settle,
 * rotate, hold — and the adapter turns those verdicts into calls on the run.
 * Fingers also come in chords — a tap of two is an undo, three a redo — and
 * the {@link MultiTapTracker} that counts them is tested alongside, because
 * the chord's whole job is to stay out of the one-finger game's way. Both
 * halves are tested here headlessly, and the adapter through a happy-dom
 * element, which dispatches real PointerEvents even though it never lays
 * anything out.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  HOLD_MS,
  MultiTapTracker,
  PointerGestureTracker,
  TAP_CHORD_MS,
  TOUCH_CARRY,
  type Gesture,
  type Spot,
} from "../client/src/game/pointer";

const at = (column: number, row: number): Spot => ({ column, row });

/**
 * A hand-fired hold clock: deterministic where a shared event loop is not.
 * A full test process starves real timers arbitrarily, and an assertion that
 * reads a "has not fired yet" after a starved delay is reading the past —
 * this fired one of those flakes under load. Firing by token makes "not yet"
 * the test's decision instead.
 */
function fakeClock() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    clock: {
      schedule(fn: () => void): unknown {
        const token = ++next;
        pending.set(token, fn);
        return token;
      },
      cancel(token: unknown): void {
        pending.delete(token as number);
      },
    },
    /** Runs the callback a token was armed for, if nothing cancelled it. */
    fire(token: number): void {
      const fn = pending.get(token);
      pending.delete(token);
      fn?.();
    },
  };
}

/** Collects a tracker's gestures, with a short injected hold delay and the fake clock. */
function tracked(holdDelay = 20) {
  const gestures: Gesture[] = [];
  const fake = fakeClock();
  const tracker = new PointerGestureTracker(
    (gesture) => gestures.push(gesture),
    holdDelay,
    fake.clock,
  );
  return { tracker, gestures, fire: fake.fire };
}

const WAIT = 8;
/** Short of the injected 20ms hold window, so a release at WAIT is a rotate. */
const QUICK = WAIT;

describe("gesture tracker", () => {
  test("a press that stays put and releases quickly rotates", () => {
    const { tracker, gestures } = tracked();
    expect(tracker.press(at(4, 5), 0)).toBeNull();
    expect(tracker.release(QUICK)).toEqual({ type: "rotate" });
    expect(gestures).toEqual([]);
  });

  test("the first move grabs and carries the travel so far; later moves carry on", () => {
    const { tracker, gestures } = tracked();
    tracker.press(at(4, 5), 0);
    // The grab is the finger's first square crossing; the carry it returns is
    // the amplified travel from the press — one finger square at 1:1 is one.
    expect(tracker.move(at(5, 5))).toEqual({ type: "carry", shift: at(1, 0) });
    // Carries are returned, not emitted: only grab and hold go through emit.
    expect(gestures).toEqual([{ type: "grab" }]);
    expect(tracker.move(at(6, 7))).toEqual({ type: "carry", shift: at(2, 2) });
    expect(tracker.release(WAIT * 2)).toEqual({ type: "settle" });
  });

  test("a press that sits still becomes a hold, not a rotate", () => {
    const { tracker, gestures, fire } = tracked();
    expect(tracker.press(at(4, 5), 0)).toBeNull();
    expect(gestures).toEqual([]);
    fire(1);
    expect(gestures).toEqual([{ type: "hold" }]);
  });

  test("a release cancels the pending hold: firing its token is nothing", () => {
    const { tracker, gestures, fire } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.release(QUICK)).toEqual({ type: "rotate" });
    fire(1);
    expect(gestures).toEqual([]);
  });

  test("a drag never becomes a hold, even left parked", () => {
    const { tracker, gestures, fire } = tracked();
    tracker.press(at(4, 5), 0);
    tracker.move(at(6, 5)); // grab; the carry (2,0) is the return value
    fire(1); // the hold window passes; the drag had already cleared the clock
    expect(gestures).toEqual([{ type: "grab" }]);
    // And the drag can still be finished.
    expect(tracker.release(WAIT * 2)).toEqual({ type: "settle" });
  });

  test("a held contact's release is inert, and a new press works normally", () => {
    const { tracker, gestures, fire } = tracked();
    tracker.press(at(4, 5), 0);
    fire(1);
    expect(gestures).toEqual([{ type: "hold" }]);
    expect(tracker.release(QUICK)).toBeNull();
    expect(tracker.press(at(2, 3), QUICK * 2)).toBeNull();
    expect(tracker.release(QUICK * 3)).toEqual({ type: "rotate" });
  });

  test("a held contact that the browser cancels leaves nothing to undo", () => {
    const { tracker, gestures, fire } = tracked();
    tracker.press(at(4, 5), 0);
    fire(1);
    expect(gestures).toEqual([{ type: "hold" }]);
    expect(tracker.cancel()).toBeNull();
  });

  test("a drag the browser cancels asks to cancel the carry", () => {
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

  test("a second landing re-arms the hold clock: resting fingers are not a hold", () => {
    const { tracker, gestures, fire } = tracked();
    tracker.press(at(4, 5), 0);
    tracker.restartHold(); // what a second finger's landing does
    // The original clock is gone: firing its token is nothing — this is the
    // whole property, and no wall-clock race can flake it.
    fire(1);
    expect(gestures).toEqual([]);
    // The re-armed clock is live: a genuine rest still becomes a hold.
    fire(2);
    expect(gestures).toEqual([{ type: "hold" }]);
  });

  test("restartHold leaves a drag alone, and a fired hold is not re-armed", () => {
    const { tracker, gestures, fire } = tracked();
    tracker.press(at(4, 5), 0);
    tracker.move(at(6, 5)); // grab
    tracker.restartHold(); // a drag has already forfeited its hold
    fire(1); // nothing was armed; there is no token to fire
    expect(gestures).toEqual([{ type: "grab" }]);
    expect(tracker.release(WAIT * 2)).toEqual({ type: "settle" });

    // A hold that already fired is not re-armed into firing twice.
    const { tracker: held, gestures: heldGestures, fire: heldFire } = tracked();
    held.press(at(4, 5), 0);
    heldFire(1);
    expect(heldGestures).toEqual([{ type: "hold" }]);
    held.restartHold();
    expect(held.release(QUICK)).toBeNull();
    expect(heldGestures).toEqual([{ type: "hold" }]);
  });
});

describe("multi-finger chords", () => {
  test("a tap of two fingers is an undo, three a redo", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, 10);
    expect(chord.release(1, 20)).toBeNull();
    expect(chord.release(2, 30)).toEqual({ type: "undo" });

    chord.press(1, 1000);
    chord.press(2, 1010);
    chord.press(3, 1020);
    expect(chord.release(3, 1030)).toBeNull();
    expect(chord.release(2, 1040)).toBeNull();
    expect(chord.release(1, 1050)).toEqual({ type: "redo" });
  });

  test("the count is of simultaneous fingers, and a re-land keeps it", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, 10);
    // A third contact replaces the first before either survivor lifts.
    expect(chord.release(1, 20)).toBeNull();
    chord.press(3, 30);
    expect(chord.release(2, 40)).toBeNull();
    expect(chord.release(3, 50)).toEqual({ type: "undo" });
  });

  test("a solo tap and a palm of four name nothing", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    expect(chord.release(1, 10)).toBeNull();

    chord.press(1, 100);
    chord.press(2, 100);
    chord.press(3, 100);
    chord.press(4, 100);
    expect(chord.release(4, 110)).toBeNull();
    expect(chord.release(3, 110)).toBeNull();
    expect(chord.release(2, 110)).toBeNull();
    expect(chord.release(1, 110)).toBeNull();
  });

  test("a finger landing after the window voids the chord", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, TAP_CHORD_MS + 1);
    expect(chord.release(1, TAP_CHORD_MS + 2)).toBeNull();
    expect(chord.release(2, TAP_CHORD_MS + 3)).toBeNull();
  });

  test("a chord that takes longer than the window to complete names nothing", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, 10);
    expect(chord.release(1, 20)).toBeNull();
    expect(chord.release(2, TAP_CHORD_MS + 1)).toBeNull();
  });

  test("a cancelled contact voids the chord it was counted in", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, 10);
    chord.cancel(2);
    expect(chord.release(1, 20)).toBeNull();
  });

  test("a drag or a hold voids the chord spanning it", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, 10);
    chord.poison();
    expect(chord.release(2, 20)).toBeNull();
    expect(chord.release(1, 30)).toBeNull();
    // The void holds: a late lift of a member cannot resurrect it.
    expect(chord.release(1, 40)).toBeNull();
  });

  test("chords reset: two two-finger taps are two undos", () => {
    const chord = new MultiTapTracker();
    chord.press(1, 0);
    chord.press(2, 5);
    chord.release(1, 10);
    expect(chord.release(2, 15)).toEqual({ type: "undo" });
    chord.press(1, 500);
    chord.press(2, 505);
    chord.release(2, 510);
    expect(chord.release(1, 515)).toEqual({ type: "undo" });
  });

  test("wasMulti holds until the next chord begins", () => {
    const chord = new MultiTapTracker();
    expect(chord.wasMulti()).toBe(false);
    chord.press(1, 0);
    expect(chord.wasMulti()).toBe(false);
    chord.press(2, 10);
    expect(chord.wasMulti()).toBe(true);
    chord.release(1, 20);
    chord.release(2, 30);
    // The adapter reads this at the primary's own release, so it must
    // outlive the completion that consumed the members.
    expect(chord.wasMulti()).toBe(true);
    chord.press(1, 1000);
    expect(chord.wasMulti()).toBe(false);
  });
});

describe("the carry", () => {
  /*
   * The carry model: a drag anchors at the piece — wherever it is, a parked
   * preview seat included — and the finger's amplified travel from where the
   * press landed moves the piece. The travel is absolute (measured from the
   * press sample, truncated per axis), so reversing the finger reverses the
   * piece step for step and a round trip computes to exactly zero. The grab —
   * the finger's first square crossing — only flips the contact from tap to
   * drag; the carry it returns is already the full amplified journey. The
   * lift this replaced moved the piece *away* from the finger, which bought
   * visibility by spending reach: rows 0–2 became unreachable by any gesture.
   */
  /** A tracker over fractional samples, carrying at the touch factor. */
  const carried = () => new PointerGestureTracker(undefined, 20, { schedule: () => 0, cancel: () => {} });

  test("the carry constant is the amplified feel, not a parity trap", () => {
    expect(TOUCH_CARRY).toBe(1.5);
  });

  test("a press aims at nothing; the grab is the first crossing, already carrying", () => {
    const t = carried();
    expect(t.press(at(4, 10), 0, TOUCH_CARRY)).toBeNull();
    expect(t.move(at(4.4, 10.4))).toBeNull(); // same whole square: no grab yet
    expect(t.move(at(5.2, 10.2))).toEqual({ type: "carry", shift: at(1, 0) });
    // The grab carries the finger's whole amplified travel from the press —
    // the piece moves by the finger's travel, never to the finger: no snap.
  });

  test("1.5 squares per finger square on both axes, exact at whole travel", () => {
    const t = carried();
    t.press(at(4, 10), 0, TOUCH_CARRY);
    // Two finger squares → three piece squares, on each axis independently.
    expect(t.move(at(6.5, 12.5))).toEqual({ type: "carry", shift: at(3, 3) });
    // Three and a half finger squares → five and a quarter, truncated to
    // whole squares on each axis.
    expect(t.move(at(7.5, 13.5))).toEqual({ type: "carry", shift: at(5, 5) });
  });

  test("half-step pacing still visits every square on the way", () => {
    // Real pointer streams sample far more finely than a square; with 1.5×,
    // successive samples two thirds of a square apart advance the piece one
    // square at a time — the pace alternates around the amplified path.
    const t = carried();
    t.press(at(0, 0), 0, TOUCH_CARRY);
    expect(t.move(at(0.2, 0.2))).toBeNull(); // still the press square: no grab
    expect(t.move(at(0.8, 0.8))).toBeNull(); // likewise — the tap zone holds
    expect(t.move(at(1.05, 1.05))).toEqual({ type: "carry", shift: at(1, 1) });
    expect(t.move(at(1.4, 1.4))).toEqual({ type: "carry", shift: at(2, 2) });
    expect(t.move(at(2.05, 2.05))).toEqual({ type: "carry", shift: at(3, 3) });
    expect(t.move(at(2.6, 2.6))).toBeNull(); // same shift: nothing new to say
    expect(t.move(at(3.2, 3.2))).toEqual({ type: "carry", shift: at(4, 4) });
  });

  test("a round trip returns to exactly the starting shift — no offset", () => {
    const t = carried();
    t.press(at(4, 10), 0, TOUCH_CARRY);
    // Wander far off-board and come back to the press square.
    t.move(at(12.9, 18.9)); // the grab, mid-wander
    t.move(at(-6.3, -4.7));
    expect(t.move(at(4.5, 10.5))).toEqual({ type: "carry", shift: at(0, 0) });
    // And continuing from there is continuous with the start.
    expect(t.move(at(5.5, 11.5))).toEqual({ type: "carry", shift: at(2, 2) });
  });

  test("reversing the finger reverses the piece step for step", () => {
    const t = carried();
    t.press(at(4, 10), 0, TOUCH_CARRY);
    expect(t.move(at(5.5, 10.5))).toEqual({ type: "carry", shift: at(2, 0) }); // the grab
    expect(t.move(at(5.9, 10.5))).toBeNull(); // same shift: nothing new to say
    expect(t.move(at(5.2, 10.5))).toEqual({ type: "carry", shift: at(1, 0) });
    expect(t.move(at(4.5, 10.5))).toEqual({ type: "carry", shift: at(0, 0) });
  });

  test("re-entering the grab square re-anchors with a zero shift", () => {
    const t = carried();
    t.press(at(4, 10), 0, TOUCH_CARRY);
    t.move(at(6.5, 10.5)); // the grab, carried (3,0)
    // Back onto the press square from the other side: zero, not an offset
    // accumulated from the excursion.
    expect(t.move(at(4.2, 10.2))).toEqual({ type: "carry", shift: at(0, 0) });
  });

  test("a mouse carries at 1:1 — the strict drag is the carry factor of one", () => {
    const t = new PointerGestureTracker(undefined, 20, { schedule: () => 0, cancel: () => {} });
    t.press(at(4, 10), 0);
    expect(t.move(at(5.5, 11.5))).toEqual({ type: "carry", shift: at(1, 1) }); // the grab
    expect(t.move(at(6.5, 12.5))).toEqual({ type: "carry", shift: at(2, 2) });
    expect(t.release(5)).toEqual({ type: "settle" });
  });

  test("a drag settles; a never-grabbed release rotates", () => {
    const t = carried();
    t.press(at(4, 10), 0, TOUCH_CARRY);
    t.move(at(4.5, 12.5)); // grabbed on the row crossing: shift (0,3)
    expect(t.release(5)).toEqual({ type: "settle" });

    const tap = carried();
    tap.press(at(4, 10), 0, TOUCH_CARRY);
    expect(tap.release(5)).toEqual({ type: "rotate" });
  });

  test("a drag still voids the hold, and a cancelled carry ends cleanly", () => {
    const t = carried();
    t.press(at(4, 10), 0, TOUCH_CARRY);
    t.move(at(5.5, 10.5)); // grabbed: the carry (2,0) is live
    t.cancel(); // the browser took the contact
    expect(t.cancel()).toBeNull(); // nothing left to cancel
    // A fresh press works normally.
    t.press(at(4, 17), 0, TOUCH_CARRY);
    expect(t.move(at(5.5, 17.5))).toEqual({ type: "carry", shift: at(2, 0) });
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

  afterAll(async () => {
    globalThis.document = saved.document;
    globalThis.getComputedStyle = saved.getComputedStyle;
    // Last hook in the file: happy-dom keeps its timers and its tree alive
    // until told to stop.
    await window.happyDOM.close();
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

  test("tap rotates, drag grabs, carries and settles, right-click is ignored", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    const box = { left: 10, top: 20 };
    node.getBoundingClientRect = () => box as DOMRect;
    const calls: string[] = [];
    // One raw sample map for every pointer: fractional, unclamped — the
    // adapter's own frame math plus the board's, no verdicts about edges.
    const detach = attachPointerPlay(node, {
      sampleAt: (x, y) => ({ column: x / 20, row: (200 - y) / 20 }),
      grabBase: () => calls.push("grab"),
      carryAt: (shift) => calls.push(`carry:${shift.column},${shift.row}`),
      settleAt: () => calls.push("settle"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    // A right-click never starts a gesture.
    node.dispatchEvent(pointer("pointerdown", 25, 25, { button: 2, pointerType: "mouse" }));
    // A tap: down and up on the same square.
    node.dispatchEvent(pointer("pointerdown", 25, 25));
    node.dispatchEvent(pointer("pointerup", 25, 25));
    expect(calls).toEqual(["rotate"]);
    expect(calls).not.toContain("grab");

    // A drag: the grab anchors at the piece, the carry is the amplified
    // travel from the press, and the release settles.
    calls.length = 0;
    node.dispatchEvent(pointer("pointerdown", 25, 25)); // sample (1.25, 8.75)
    node.dispatchEvent(pointer("pointermove", 45, 25)); // grab; (2.25-1.25)*1.5 → col 1
    node.dispatchEvent(pointer("pointermove", 45, 65)); // row 6.75: (6.75-8.75)*1.5 → -3
    expect(calls).toEqual(["grab", "carry:1,0", "carry:1,-3"]);
    node.dispatchEvent(pointer("pointerup", 45, 65));
    expect(calls).toEqual(["grab", "carry:1,0", "carry:1,-3", "settle"]);

    detach();
  });

  test("a touch carries 1.5×, a mouse 1:1, through the same sample map", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      sampleAt: (x, y) => ({ column: x / 20, row: (200 - y) / 20 }),
      grabBase: () => calls.push("grab"),
      carryAt: (shift) => calls.push(`carry:${shift.column},${shift.row}`),
      settleAt: () => calls.push("settle"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    // The same two-square finger drag, both pointers: the touch's piece
    // travels three squares, the mouse's two — the amplification, through
    // the adapter. Both grab on the first crossing and carry from the press.
    node.dispatchEvent(pointer("pointerdown", 25, 25, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointermove", 45, 25, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointermove", 45, 65, { pointerType: "touch" }));
    expect(calls).toEqual(["grab", "carry:1,0", "carry:1,-3"]);
    node.dispatchEvent(pointer("pointerup", 45, 65, { pointerType: "touch" }));
    expect(calls).toEqual(["grab", "carry:1,0", "carry:1,-3", "settle"]);

    calls.length = 0;
    node.dispatchEvent(pointer("pointerdown", 25, 25, { pointerType: "mouse" }));
    node.dispatchEvent(pointer("pointermove", 45, 25, { pointerType: "mouse" }));
    node.dispatchEvent(pointer("pointermove", 45, 65, { pointerType: "mouse" }));
    node.dispatchEvent(pointer("pointerup", 45, 65, { pointerType: "mouse" }));
    expect(calls).toEqual(["grab", "carry:1,0", "carry:1,-2", "settle"]);

    // A finger that drags far past the board's edge: the samples keep
    // coming — nothing clamps — and coming back to the grab square
    // recomputes to zero. The run owns what off-board means; the adapter
    // never censored it.
    calls.length = 0;
    node.dispatchEvent(pointer("pointerdown", 25, 25, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointermove", 45, 25, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointermove", 45, 800, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointermove", 25, 25, { pointerType: "touch" }));
    expect(calls).toEqual(["grab", "carry:1,0", "carry:1,-58", "carry:0,0"]);

    detach();
  });

  test("a tap never grabs, lifted or not", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      sampleAt: () => at(3, 4),
      grabBase: () => calls.push("grab"),
      carryAt: () => calls.push("carry"),
      settleAt: () => calls.push("settle"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });
    node.dispatchEvent(pointer("pointerdown", 10, 10));
    node.dispatchEvent(pointer("pointerup", 10, 10));
    expect(calls).toEqual(["rotate"]);
    detach();
  });

  test("a two-finger tap is an undo, not a rotate and not two gestures", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      sampleAt: () => at(3, 4),
      grabBase: () => calls.push("grab"),
      carryAt: () => calls.push("carry"),
      settleAt: () => calls.push("settle"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerdown", 30, 30, { pointerId: 2 }));
    // The first finger lifts, and only then the second.
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 2 }));
    // The chord is the whole meaning of those two fingers: one undo, and the
    // rotation the primary's tap would otherwise also fire is dropped.
    expect(calls).toEqual(["undo"]);
    detach();
  });

  test("the primary lifting first still completes the chord", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      sampleAt: () => at(3, 4),
      grabBase: () => calls.push("grab"),
      carryAt: () => calls.push("carry"),
      settleAt: () => calls.push("settle"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerdown", 30, 30, { pointerId: 2 }));
    node.dispatchEvent(pointer("pointerup", 30, 30, { pointerId: 2 }));
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 1 }));
    expect(calls).toEqual(["undo"]);
    detach();
  });

  test("a three-finger tap is a redo", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      sampleAt: () => at(3, 4),
      grabBase: () => calls.push("grab"),
      carryAt: () => calls.push("carry"),
      settleAt: () => calls.push("settle"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    for (const id of [1, 2, 3]) {
      node.dispatchEvent(pointer("pointerdown", 10 * id, 10, { pointerId: id }));
    }
    for (const id of [3, 2, 1]) {
      node.dispatchEvent(pointer("pointerup", 10 * id, 10, { pointerId: id }));
    }
    expect(calls).toEqual(["redo"]);
    detach();
  });

  test("a chord works with every finger off the board", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      // The raw map is total — chords are about the fingers, not the board.
      sampleAt: () => at(-5, 30),
      grabBase: () => calls.push("grab"),
      carryAt: () => calls.push("carry"),
      settleAt: () => calls.push("settle"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    node.dispatchEvent(pointer("pointerdown", 5, 400, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerdown", 60, 400, { pointerId: 2 }));
    node.dispatchEvent(pointer("pointerup", 5, 400, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerup", 60, 400, { pointerId: 2 }));
    expect(calls).toEqual(["undo"]);
    detach();
  });

  test("a drag with a second finger resting settles instead of undoing", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      sampleAt: (x) => ({ column: x / 20, row: 9 }),
      grabBase: () => calls.push("grab"),
      carryAt: (shift) => calls.push(`carry:${shift.column},${shift.row}`),
      settleAt: () => calls.push("settle"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerdown", 30, 30, { pointerId: 2 }));
    node.dispatchEvent(pointer("pointermove", 50, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerup", 50, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerup", 30, 30, { pointerId: 2 }));
    // The primary was playing, not tapping: the drag lands, the chord is void.
    expect(calls).toEqual(["grab", "carry:3,0", "settle"]);
    detach();
  });

  test("two fingers resting together are not a long-press", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const fake = fakeClock();
    const detach = attachPointerPlay(
      node,
      {
        sampleAt: () => at(3, 4),
        grabBase: () => calls.push("grab"),
        carryAt: () => calls.push("carry"),
        settleAt: () => calls.push("settle"),
        cancelCarry: () => calls.push("cancelCarry"),
        rotate: () => calls.push("rotate"),
        hold: () => calls.push("hold"),
        undo: () => calls.push("undo"),
        redo: () => calls.push("redo"),
      },
      HOLD_MS,
      fake.clock,
    );

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerdown", 30, 30, { pointerId: 2 })); // re-arms
    // The first finger's clock is gone — firing its token is nothing. This is
    // the whole property, proven without a single real timer.
    fake.fire(1);
    expect(calls).toEqual([]);
    // The re-armed clock is live: a genuine rest does become a hold.
    fake.fire(2);
    expect(calls).toEqual(["hold"]);
    // Releases afterwards are inert, and the poisoned chord names nothing.
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerup", 30, 30, { pointerId: 2 }));
    expect(calls).toEqual(["hold"]);
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
      sampleAt: () => at(0, 0),
      grabBase: () => {},
      carryAt: () => {},
      settleAt: () => {},
      cancelCarry: () => {},
      rotate: () => {},
      hold: () => {},
      undo: () => {},
      redo: () => {},
    });
    node.dispatchEvent(event as unknown as Event);
    expect(defaultPrevented).toBe(true);
    detach();
  });
});
