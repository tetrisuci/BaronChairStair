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

  test("a fast downward flick fires on the lift, spending the contact", () => {
    const { tracker, gestures } = tracked();
    tracker.press(at(4, 5), 0);
    tracker.move(at(4, 5), 10); // still in the press square: nothing yet
    // Board rows count up from the floor: downward travel is negative.
    // Three amplified squares — two finger-rows at the carry's
    // amplification — is the threshold, crossed here in one move.
    expect(tracker.move(at(4, 1), 100)).toEqual({ type: "carry", shift: at(0, -4) });
    // The flick is the finger leaving the board, not the descent. The
    // origin rides along: the drop takes the seat the stroke began on.
    expect(tracker.release(120)).toEqual({ type: "slam", origin: at(0, 0) });
    expect(gestures).toEqual([{ type: "grab" }]);
  });

  test("a stroke that pauses past the beat is positioning, and settles", () => {
    // The pause is the boundary between swiping and positioning, in either
    // order: a stroke that goes still for longer than the beat has stopped
    // diving, WHATEVER it armed on the way down. A pause is the start of a
    // new potential gesture, not a hold in the old one — the seated piece
    // is where the player left it, and the release settles.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 1), 90)).toEqual({ type: "carry", shift: at(0, -4) }); // arms
    expect(tracker.move(at(4, 1), 700)).toBeNull(); // the stall: same shift, deduped — but past the beat
    expect(tracker.release(820)).toEqual({ type: "settle" });
  });

  test("an armed stroke survives a beat of stillness and drops on the lift", () => {
    // A SHORT pause — under the beat — is not a decision: the finger may
    // hesitate a moment and the lift still drops, because the stroke
    // earned the drop and has not been silent longer than a pause takes.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 1), 90)).toEqual({ type: "carry", shift: at(0, -4) }); // arms
    expect(tracker.move(at(4, 1), 150)).toBeNull(); // a beat of stillness, deduped
    expect(tracker.release(200)).toEqual({ type: "slam", origin: at(0, 0) });
  });

  test("silence the move stream never saw ends the stroke at the lift", () => {
    // A finger held perfectly still after the dive streams no moves, so
    // the move-stream pause rule never runs — the lift applies it one
    // last time itself: a stroke silent past the beat at the lift is a
    // stopped dive, and the release settles.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 1), 90)).toEqual({ type: "carry", shift: at(0, -4) }); // arms
    expect(tracker.release(820)).toEqual({ type: "settle" }); // 730ms of silence, no moves in between
  });

  test("a veer past a square of wobble hands the finger back", () => {
    // The stroke holds its column within a square — a finger is wide —
    // but a deliberate sideways move is steering: the stroke ends, and
    // the preview, which never left the finger, just carries.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(6, 1), 90)).toEqual({ type: "carry", shift: at(2, -4) }); // arms
    expect(tracker.move(at(7, 0), 110)).toEqual({ type: "carry", shift: at(3, -5) }); // within the wobble: still the stroke, following the finger
    expect(tracker.move(at(9, 0), 120)).toEqual({ type: "carry", shift: at(5, -5) }); // beyond: carrying again
    expect(tracker.release(140)).toEqual({ type: "settle" });
  });

  test("a flick stroke reversed before the lift is a settle, not a slam", () => {
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 1), 80)).toEqual({ type: "carry", shift: at(0, -4) }); // earned it
    // The finger comes back to where the stroke began: a deliberate rise
    // revokes the earned drop — the piece visibly follows, and nothing
    // was ever hidden from it. (Two squares up is not a truncation blip.)
    expect(tracker.move(at(4, 5), 110)).toEqual({ type: "carry", shift: at(0, 0) });
    expect(tracker.move(at(6, 5), 140)).toEqual({ type: "carry", shift: at(2, 0) });
    expect(tracker.release(160)).toEqual({ type: "settle" });
  });

  test("a one-square truncation blip keeps the stroke, at its deepest row", () => {
    // The sim that found the coin-toss: a fast dive's samples land near
    // amplified-row boundaries, and one noisy sample truncating a square
    // SHALLOWER killed the whole stroke. The stroke now keeps its deepest
    // row and shrugs off the blip; only a rise of MORE than a square — a
    // deliberate pull-back — can break it.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 2), 60)).toEqual({ type: "carry", shift: at(0, -3) }); // at threshold
    expect(tracker.move(at(4.2, 2.6), 80)).toEqual({ type: "carry", shift: at(0, -2) }); // noise: one square shallow
    expect(tracker.move(at(4.1, 1.4), 100)).toEqual({ type: "carry", shift: at(0, -3) }); // deeper again: stroke alive
    expect(tracker.release(130)).toEqual({ type: "slam", origin: at(0, 0) });
  });

  test("a blip may also land above the threshold before the stroke reaches it", () => {
    // The same noise, ordered the other way: the blip's shallower row is
    // what the stroke would otherwise have been killed BY before it ever
    // armed — the boundary-hover case real fingers live in.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 3), 50)).toEqual({ type: "carry", shift: at(0, -2) });
    expect(tracker.move(at(4.1, 1.9), 80)).toEqual({ type: "carry", shift: at(0, -3) }); // crosses at -3
    expect(tracker.move(at(4.2, 2.8), 100)).toEqual({ type: "carry", shift: at(0, -2) }); // blip: one shallow
    expect(tracker.move(at(4.1, 1.8), 120)).toEqual({ type: "carry", shift: at(0, -3) }); // back to the deepest
    expect(tracker.release(150)).toEqual({ type: "slam", origin: at(0, 0) });
  });

  test("a re-dive after a reversal is carrying, not a second swipe", () => {
    // The reversal broke the stroke, and the finger never stopped: the
    // later dive is the same motion continuing — carrying, not a stroke.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    tracker.move(at(4, 1), 80); // earned, then reversed...
    tracker.move(at(4, 5), 110);
    expect(tracker.move(at(7, 1), 160)).toEqual({ type: "carry", shift: at(3, -4) });
    expect(tracker.move(at(9, 0), 190)).toEqual({ type: "carry", shift: at(5, -5) });
    expect(tracker.release(220)).toEqual({ type: "settle" });
  });

  test("a descent slower than the window is a settle, not a slam", () => {
    // Connected rows, but each step lands past the window from the last:
    // every stroke dies unarmed, and each fresh one covers only a square
    // of its own — setting the piece down, not flicking it.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 3), 60)).toEqual({ type: "carry", shift: at(0, -2) });
    expect(tracker.move(at(4, 2), 500)).toEqual({ type: "carry", shift: at(0, -3) });
    expect(tracker.release(520)).toEqual({ type: "settle" });
  });

  test("a shallow descent that pauses starts a fresh stroke after it", () => {
    // Two amplified squares is under the threshold, and the stall after
    // it is longer than the window: the stroke died, and the later rows
    // are a new stroke from a lower seat — but they alone don't cover the
    // threshold, so the release still settles.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 3), 60)).toEqual({ type: "carry", shift: at(0, -2) });
    expect(tracker.move(at(4, 1), 500)).toEqual({ type: "carry", shift: at(0, -4) });
    expect(tracker.release(520)).toEqual({ type: "settle" });
  });

  test("a re-armed stroke is judged by its own dive, not the depth below the grab", () => {
    // Positioning drifts down slowly and connectedly — no stroke, however
    // deep it goes. After a pause, a stroke of its own begins from the
    // seat the piece is shown on, and only ITS descent counts: a shallow
    // twitch cannot cash in the depth the positioning already covered.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 3), 40)).toEqual({ type: "carry", shift: at(0, -2) }); // positioning
    expect(tracker.move(at(4, 1), 500)).toEqual({ type: "carry", shift: at(0, -4) }); // pause; a stroke begins here
    expect(tracker.release(520)).toEqual({ type: "settle" }); // own travel: two, not four
  });

  test("positioning, a stall, then a fast dive: the re-armed stroke slams from the shown seat", () => {
    // The same stream, dived harder after the pause: the new stroke covers
    // the threshold on its own travel, and the drop takes the seat the
    // piece was showing when the dive began — the positioned one. The
    // preview followed the finger the whole way, so the dive carried it
    // exactly where the stroke began: the shown seat, nothing new to show.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 3), 40)).toEqual({ type: "carry", shift: at(0, -2) }); // positioning: two squares, under the threshold
    expect(tracker.move(at(4, -1), 500)).toEqual({ type: "carry", shift: at(0, -6) }); // pause, then the dive: a fresh stroke arms at once
    expect(tracker.release(520)).toEqual({ type: "slam", origin: at(0, -2) }); // from the shown seat
  });

  test("a two-finger-row drag is the threshold: a flick, not a carry", () => {
    // Three amplified squares is exactly what two finger-rows produce, so
    // this is the boundary case — and it dives, inside the window: a
    // drop, not a carry. The old threshold of four made this same drag a
    // carry, and the flick unreliable.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 2), 90)).toEqual({ type: "carry", shift: at(0, -3) });
    expect(tracker.release(110)).toEqual({ type: "slam", origin: at(0, 0) });
  });

  test("a fast drag just under the threshold is a settle, not a slam", () => {
    // A quick one-and-a-bit-row stroke still means carry: the threshold
    // is on the amplified travel, and this never reaches it.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 4), 40)).toEqual({ type: "carry", shift: at(0, -1) });
    expect(tracker.move(at(4, 3), 70)).toEqual({ type: "carry", shift: at(0, -2) });
    expect(tracker.release(115)).toEqual({ type: "settle" });
  });

  test("upward and sideways travel never slams", () => {
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 9), 60)).toEqual({ type: "carry", shift: at(0, 4) });
    expect(tracker.move(at(8, 9), 80)).toEqual({ type: "carry", shift: at(4, 4) });
    expect(tracker.release(100)).toEqual({ type: "settle" });
  });

  test("a move without a timestamp never slams", () => {
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 1))).toEqual({ type: "carry", shift: at(0, -4) });
    expect(tracker.release(60)).toEqual({ type: "settle" });
  });

  test("positioning, a pause, then a clean dive is the swipe the pause promised", () => {
    // One contact, two gestures: the positioning — up and sideways — a
    // beat of silence, then a fast straight dive from where the piece was
    // shown. The drop takes THAT seat, not the drag's anchor, not the
    // finger's final position. The preview followed the finger into the
    // dive, so the carried shift just keeps reporting it.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(6, 9), 40)).toEqual({ type: "carry", shift: at(2, 4) }); // positioning: up and sideways
    expect(tracker.move(at(7, 9), 60)).toEqual({ type: "carry", shift: at(3, 4) });
    // The pause, then the dive: the preview follows it, because it always
    // does — and the origin remembers where the piece stood when it began.
    expect(tracker.move(at(7, 1), 500)).toEqual({ type: "carry", shift: at(3, -4) }); // the dive arms at once
    expect(tracker.move(at(7, 0), 530)).toEqual({ type: "carry", shift: at(3, -5) }); // diving deeper
    expect(tracker.release(550)).toEqual({ type: "slam", origin: at(3, 4) });
  });

  test("a dive out of a pause takes the PAUSE position, not the stroke's first stamp", () => {
    // The report behind this: position the piece UP, rest, dive — and the
    // drop must take the seat the piece was showing at the PAUSE (where
    // the finger was resting), not wherever some earlier stamp sat. The
    // stroke opens on the first move DOWNWARD past the resting row, and
    // its depth is measured from that rest row too.
    const { tracker } = tracked();
    tracker.press(at(4, 9), 0);
    expect(tracker.move(at(5, 11), 40)).toEqual({ type: "carry", shift: at(1, 2) }); // up two squares
    expect(tracker.move(at(5, 12), 70)).toEqual({ type: "carry", shift: at(1, 3) }); // up again; then still
    expect(tracker.move(at(5.3, 12.2), 600)).toBeNull(); // pause jitters: deduped, stillness
    // The dive from the resting row: a stroke of its own begins here.
    // Shifts are absolute from the PRESS (4,9): from the rest row 12, one
    // square down is 11, three is 9.
    expect(tracker.move(at(5.4, 11.0), 900)).toEqual({ type: "carry", shift: at(1, 2) });
    expect(tracker.move(at(5.5, 9.0), 930)).toEqual({ type: "carry", shift: at(1, 0) }); // three past the rest: armed
    expect(tracker.move(at(5.6, 6.0), 960)).toEqual({ type: "carry", shift: at(1, -3) }); // deeper still
    expect(tracker.release(980)).toEqual({ type: "slam", origin: at(1, 3) }); // the PAUSE seat
  });

  test("a held-still finger's sub-square jitter does not reset the pause clock", () => {
    // A real finger held "still" keeps streaming moves that dedupe to the
    // same square: the pause that separates two gestures is measured from
    // the last move that CHANGED the shift, or the jitter keeps restarting
    // the clock under itself and the post-pause dive never arms — the live
    // failure the timestamped-clean streams of the other tests cannot see.
    // (The pure tracker carries 1:1 — the adapter applies TOUCH_CARRY.)
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(5.4, 7.5), 40)).toEqual({ type: "carry", shift: at(1, 2) }); // positioning
    // Sub-square jitter whose shift dedupes to the same square. Each lands
    // well past the window from the last CHANGED move, so an activity-
    // based clock would have reset on every one of them.
    expect(tracker.move(at(5.9, 7.9), 500)).toBeNull();
    expect(tracker.move(at(5.4, 7.6), 900)).toBeNull();
    // The dive at 1150: only 250 past the last JITTER event — under the
    // window, so the old activity-based clock would refuse to start a
    // stroke — but 1110 past the last CHANGED move: real stillness, so
    // the stroke begins and its own dive covers the threshold.
    expect(tracker.move(at(5.4, 3.5), 1150)).toEqual({ type: "carry", shift: at(1, -1) });
    expect(tracker.release(1180)).toEqual({ type: "slam", origin: at(1, 2) });
  });

  test("a boundary flip moves the preview, so it restarts the pause", () => {
    // The pause is measured BY THE PIECE — the rule the player can see.
    // A resting finger's jitter that flips the truncated square moves the
    // preview one square: that is a visible move, and the beat restarts
    // from it. (An earlier raw-stream clock counted this exact flip as
    // stillness while demanding sub-tenth-square immobility — inconsistent
    // with the screen both ways.) The dive here lands inside the beat from
    // the flip, so no stroke opens and the release settles.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(5.4, 7.5), 40)).toEqual({ type: "carry", shift: at(1, 2) }); // positioning
    expect(tracker.move(at(5.9, 7.9), 500)).toBeNull(); // jitter in the same square: stillness
    expect(tracker.move(at(6.4, 7.9), 600)).toEqual({ type: "carry", shift: at(2, 2) }); // boundary flip: the preview MOVED
    // Only 100ms past the flip — under the 150ms beat, so no pause ever
    // counted and the connected dive is just carrying.
    expect(tracker.move(at(6.4, 3.5), 700)).toEqual({ type: "carry", shift: at(2, -1) });
    expect(tracker.move(at(6.4, 2.9), 730)).toEqual({ type: "carry", shift: at(2, -2) });
    expect(tracker.release(760)).toEqual({ type: "settle" });
  });

  test("the pause seat is where the preview rests after the last move", () => {
    // The flip case, dropped properly: same boundary flip, but the dive
    // waits out the beat from it — and the drop takes the seat the piece
    // was showing AT THE FLIP (the new square), never the pre-flip seat.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(5.4, 7.5), 40)).toEqual({ type: "carry", shift: at(1, 2) });
    expect(tracker.move(at(5.9, 7.9), 500)).toBeNull(); // stillness
    expect(tracker.move(at(6.4, 7.9), 600)).toEqual({ type: "carry", shift: at(2, 2) }); // preview moves
    expect(tracker.move(at(6.4, 3.5), 900)).toEqual({ type: "carry", shift: at(2, -1) }); // dive, beat respected
    expect(tracker.move(at(6.4, 2.9), 930)).toEqual({ type: "carry", shift: at(2, -2) }); // past the rest: armed
    expect(tracker.release(960)).toEqual({ type: "slam", origin: at(2, 2) }); // the post-flip seat
  });

  test("a dive after a rise is carrying, not a second chance", () => {
    // The first movements went up and the finger never stopped: the dive
    // is the same motion continuing — carrying, not a stroke.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 9), 40)).toEqual({ type: "carry", shift: at(0, 4) }); // up: not a stroke
    expect(tracker.move(at(4, 1), 80)).toEqual({ type: "carry", shift: at(0, -4) }); // the dive: carrying
    expect(tracker.release(100)).toEqual({ type: "settle" });
  });

  test("a dive after a rise and a pause is a fresh stroke", () => {
    // The same geometry as above with a beat of silence before the dive:
    // now the descent starts a stroke of its own, from the seat the rise
    // left the piece shown on.
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    expect(tracker.move(at(4, 9), 40)).toEqual({ type: "carry", shift: at(0, 4) }); // up
    expect(tracker.move(at(4, 1), 500)).toEqual({ type: "carry", shift: at(0, -4) }); // pause, then the dive: armed at once
    expect(tracker.move(at(4, 0), 530)).toEqual({ type: "carry", shift: at(0, -5) }); // deeper: followed
    expect(tracker.release(550)).toEqual({ type: "slam", origin: at(0, 4) });
  });

  test("a cancelled swipe is inert on the release the browser owes nothing", () => {
    const { tracker } = tracked();
    tracker.press(at(4, 5), 0);
    tracker.move(at(4, 1), 90); // earned the flick
    // The browser yanks the contact: the stroke dies with it.
    expect(tracker.cancel()).toEqual({ type: "cancel" });
    expect(tracker.release(120)).toBeNull();
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
      contactDown: () => {},
      contactUp: () => {},
      slamDrop: () => calls.push("slam"),
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

    detach.dispose();
  });

  test("touch defaults are canceled on the board only, while game gestures still work", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const stage = element();
    const canvas = window.document.createElement("canvas") as unknown as HTMLElement;
    stage.append(canvas as unknown as Node);
    const calls: string[] = [];
    const fake = fakeClock();
    const play = attachPointerPlay(
      stage,
      {
        sampleAt: () => at(3, 4),
        grabBase: () => calls.push("grab"),
        carryAt: () => calls.push("carry"),
        settleAt: () => calls.push("settle"),
        contactDown: () => {},
        contactUp: () => {},
        slamDrop: () => calls.push("slam"),
        cancelCarry: () => calls.push("cancelCarry"),
        rotate: () => calls.push("rotate"),
        hold: () => calls.push("hold"),
        undo: () => calls.push("undo"),
        redo: () => calls.push("redo"),
      },
      { holdDelay: 20, clock: fake.clock, touchTarget: canvas },
    );

    const boardTouch = new window.Event("touchstart", { bubbles: true, cancelable: true });
    canvas.dispatchEvent(boardTouch as unknown as Event);
    expect(boardTouch.defaultPrevented).toBe(true);
    const stageMarginTouch = new window.Event("touchstart", { bubbles: true, cancelable: true });
    stage.dispatchEvent(stageMarginTouch as unknown as Event);
    expect(stageMarginTouch.defaultPrevented).toBe(false);

    stage.dispatchEvent(pointer("pointerdown", 10, 10));
    stage.dispatchEvent(pointer("pointerup", 10, 10));
    expect(calls).toEqual(["rotate"]);
    calls.length = 0;
    stage.dispatchEvent(pointer("pointerdown", 10, 10));
    fake.fire(2);
    expect(calls).toEqual(["hold"]);
    stage.dispatchEvent(pointer("pointerup", 10, 10));
    play.dispose();
  });

  test("unexpected capture loss cancels the carry and the next pointer is fresh", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    let contacts = 0;
    const play = attachPointerPlay(node, {
      sampleAt: (x) => ({ column: x / 10, row: 4 }),
      grabBase: () => calls.push("grab"),
      carryAt: () => calls.push("carry"),
      settleAt: () => calls.push("settle"),
      contactDown: () => contacts++,
      contactUp: () => contacts--,
      slamDrop: () => calls.push("slam"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointermove", 30, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("lostpointercapture", 30, 10, { pointerId: 1 }));
    expect(calls).toEqual(["grab", "carry", "cancelCarry"]);
    expect(contacts).toBe(0);

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 2 }));
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 2 }));
    expect(calls.at(-1)).toBe("rotate");
    expect(contacts).toBe(0);
    // Browsers normally report capture loss after pointerup. It must not
    // cancel or otherwise change the already completed tap.
    node.dispatchEvent(pointer("lostpointercapture", 10, 10, { pointerId: 2 }));
    expect(calls.at(-1)).toBe("rotate");
    play.dispose();
  });

  test("pointer cancellation balances the contact and leaves the next tap usable", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    let contacts = 0;
    const play = attachPointerPlay(node, {
      sampleAt: () => at(3, 4),
      grabBase: () => calls.push("grab"),
      carryAt: () => calls.push("carry"),
      settleAt: () => calls.push("settle"),
      contactDown: () => contacts++,
      contactUp: () => contacts--,
      slamDrop: () => calls.push("slam"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointercancel", 10, 10, { pointerId: 1 }));
    expect(calls).toEqual(["cancelCarry"]);
    expect(contacts).toBe(0);
    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 2 }));
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 2 }));
    expect(calls.at(-1)).toBe("rotate");
    expect(contacts).toBe(0);
    play.dispose();
  });

  test("capture loss clears a secondary contact from the chord and run", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    const calls: string[] = [];
    let contacts = 0;
    const play = attachPointerPlay(node, {
      sampleAt: () => at(3, 4),
      grabBase: () => calls.push("grab"),
      carryAt: () => calls.push("carry"),
      settleAt: () => calls.push("settle"),
      contactDown: () => contacts++,
      contactUp: () => contacts--,
      slamDrop: () => calls.push("slam"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerdown", 20, 20, { pointerId: 2 }));
    node.dispatchEvent(pointer("lostpointercapture", 20, 20, { pointerId: 2 }));
    expect(contacts).toBe(1);
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 1 }));
    expect(contacts).toBe(0);

    node.dispatchEvent(pointer("pointerdown", 30, 30, { pointerId: 3 }));
    node.dispatchEvent(pointer("pointerup", 30, 30, { pointerId: 3 }));
    expect(calls).toEqual(["rotate"]);
    expect(contacts).toBe(0);
    play.dispose();
  });

  test("reset, blur and page hiding clear every contact and allow another gesture", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    let contacts = 0;
    const play = attachPointerPlay(node, {
      sampleAt: () => at(3, 4),
      grabBase: () => calls.push("grab"),
      carryAt: () => calls.push("carry"),
      settleAt: () => calls.push("settle"),
      contactDown: () => contacts++,
      contactUp: () => contacts--,
      slamDrop: () => calls.push("slam"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 1 }));
    node.dispatchEvent(pointer("pointerdown", 20, 20, { pointerId: 2 }));
    play.reset();
    expect(contacts).toBe(0);
    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 3 }));
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 3 }));
    expect(calls.at(-1)).toBe("rotate");

    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 4 }));
    window.dispatchEvent(new window.Event("blur"));
    expect(contacts).toBe(0);
    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 5 }));
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 5 }));
    expect(calls.at(-1)).toBe("rotate");

    Object.defineProperty(window.document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 6 }));
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    expect(contacts).toBe(0);
    Object.defineProperty(window.document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    node.dispatchEvent(pointer("pointerdown", 10, 10, { pointerId: 7 }));
    node.dispatchEvent(pointer("pointerup", 10, 10, { pointerId: 7 }));
    expect(calls.at(-1)).toBe("rotate");
    expect(contacts).toBe(0);
    play.dispose();
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
      contactDown: () => {},
      contactUp: () => {},
      slamDrop: () => calls.push("slam"),
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
    // never censored it. The excursion goes sideways: a fast *downward*
    // one is a slam by design, and this probe is about the round trip.
    calls.length = 0;
    node.dispatchEvent(pointer("pointerdown", 25, 25, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointermove", 25, 45, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointermove", 800, 45, { pointerType: "touch" }));
    node.dispatchEvent(pointer("pointermove", 25, 45, { pointerType: "touch" }));
    expect(calls).toEqual(["grab", "carry:0,-1", "carry:58,-1", "carry:0,-1"]);

    detach.dispose();
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
      contactDown: () => {},
      contactUp: () => {},
      slamDrop: () => calls.push("slam"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });
    node.dispatchEvent(pointer("pointerdown", 10, 10));
    node.dispatchEvent(pointer("pointerup", 10, 10));
    expect(calls).toEqual(["rotate"]);
    detach.dispose();
  });

  test("a fast downward flick slams on the lift", async () => {
    const { attachPointerPlay } = await import("../client/src/game/pointer");
    const node = element();
    node.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    const calls: string[] = [];
    const detach = attachPointerPlay(node, {
      sampleAt: (x, y) => ({ column: x / 20, row: (200 - y) / 20 }),
      grabBase: () => calls.push("grab"),
      carryAt: (shift) => calls.push(`carry:${shift.column},${shift.row}`),
      settleAt: () => calls.push("settle"),
      contactDown: () => {},
      contactUp: () => {},
      slamDrop: () => calls.push("slam"),
      cancelCarry: () => calls.push("cancelCarry"),
      rotate: () => calls.push("rotate"),
      hold: () => calls.push("hold"),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    });
    // Down-screen is smaller rows: the crossing move covers the whole
    // threshold in one sample. The carry reports the dive itself — the
    // preview follows the finger — and the slam fires when the finger
    // lifts, taking the seat the stroke began on.
    node.dispatchEvent(pointer("pointerdown", 25, 25));
    node.dispatchEvent(pointer("pointermove", 25, 145));
    node.dispatchEvent(pointer("pointerup", 25, 145));
    expect(calls).toEqual(["grab", "carry:0,-9", "slam"]);
    detach.dispose();
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
      contactDown: () => {},
      contactUp: () => {},
      slamDrop: () => calls.push("slam"),
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
    detach.dispose();
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
      contactDown: () => {},
      contactUp: () => {},
      slamDrop: () => calls.push("slam"),
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
    detach.dispose();
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
      contactDown: () => {},
      contactUp: () => {},
      slamDrop: () => calls.push("slam"),
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
    detach.dispose();
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
      contactDown: () => {},
      contactUp: () => {},
      slamDrop: () => calls.push("slam"),
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
    detach.dispose();
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
      contactDown: () => {},
      contactUp: () => {},
      slamDrop: () => calls.push("slam"),
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
    detach.dispose();
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
      contactDown: () => {},
      contactUp: () => {},
      slamDrop: () => calls.push("slam"),
        cancelCarry: () => calls.push("cancelCarry"),
        rotate: () => calls.push("rotate"),
        hold: () => calls.push("hold"),
        undo: () => calls.push("undo"),
        redo: () => calls.push("redo"),
      },
      { holdDelay: HOLD_MS, clock: fake.clock },
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
    detach.dispose();
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
      contactDown: () => {},
      contactUp: () => {},
      slamDrop: () => {},
      cancelCarry: () => {},
      rotate: () => {},
      hold: () => {},
      undo: () => {},
      redo: () => {},
    });
    node.dispatchEvent(event as unknown as Event);
    expect(defaultPrevented).toBe(true);
    detach.dispose();
  });
});
