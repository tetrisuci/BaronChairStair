/**
 * Pointer play: tap to rotate, drag to place, long-press to hold.
 *
 * The gestures are deliberately the same on a mouse and a finger — a mouse is
 * just a finger that never loses contact — so one state machine serves both.
 * It is pure: no DOM, and every decision surfaces either as a returned
 * gesture or through the constructor's `emit`, which is what makes it testable
 * without a browser and keeps the adapter below a thin shell.
 *
 * The keyboard plays *keys*; a pointer plays *places*. A drag ends in a hard
 * drop — that is the whole meaning of letting go — so this layer never
 * synthesises soft drop or rides gravity; it only answers, at every moment,
 * which square the piece is pointed at.
 */

export interface Spot {
  readonly column: number;
  readonly row: number;
}

/** What the tracker has decided the pointer is doing. */
export type Gesture =
  | { readonly type: "aim"; readonly spot: Spot }
  | { readonly type: "commit"; readonly spot: Spot }
  | { readonly type: "cancel" }
  | { readonly type: "rotate" }
  | { readonly type: "hold" };

/** How long a still press must sit before it is a hold, in milliseconds. */
export const HOLD_MS = 550;

function sameSpot(a: Spot, b: Spot): boolean {
  return a.column === b.column && a.row === b.row;
}

/**
 * The state machine behind one pointer contact.
 *
 * A press commits to nothing: the piece must not jump to the finger, or a tap
 * would teleport the piece before rotating it. Aiming begins when the contact
 * crosses into another square, which is also the tap/drag verdict — a tap
 * never leaves its square, a drag always does. A press that stays put becomes
 * a hold after {@link HOLD_MS}, emitted asynchronously; everything else is
 * decided when the contact ends.
 */
export class PointerGestureTracker {
  private origin: Spot | null = null;
  private last: Spot | null = null;
  private pressAt = 0;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** The hold fired; the contact's eventual release is inert. */
  private holding = false;
  /** The contact left its first square; the piece is being dragged. */
  private dragging = false;

  constructor(
    private readonly emit: (gesture: Gesture) => void = () => {},
    /** Injectable so tests do not wait out a real hold. */
    private readonly holdDelay: number = HOLD_MS,
  ) {}

  /** A contact began at `spot` at time `now`. Nothing is decided yet. */
  press(spot: Spot, now: number): Gesture | null {
    this.origin = spot;
    this.last = spot;
    this.pressAt = now;
    this.holding = false;
    this.dragging = false;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      // A drag that happens to be over its origin square is a drag, not a
      // hold; only a contact that never moved is.
      if (this.origin && !this.dragging) {
        this.holding = true;
        this.origin = null;
        this.last = null;
        this.emit({ type: "hold" });
      }
    }, this.holdDelay);
    return null;
  }

  /**
   * The contact moved to `spot`. Aims from the moment it enters a new square —
   * including the press square again after leaving it.
   */
  move(spot: Spot): Gesture | null {
    if (!this.origin || this.holding) return null;
    this.last = spot;
    if (!this.dragging) {
      if (sameSpot(this.origin, spot)) return null;
      this.dragging = true;
      this.clearHoldTimer();
    }
    return { type: "aim", spot };
  }

  /**
   * The contact ended. A drag commits to its last square; a tap rotates; a
   * held contact has already had its say.
   */
  release(now: number): Gesture | null {
    this.clearHoldTimer();
    const { origin, last, dragging } = this;
    this.origin = null;
    this.last = null;
    this.dragging = false;
    if (this.holding) {
      this.holding = false;
      return null;
    }
    if (!origin || !last) return null;
    if (dragging) return { type: "commit", spot: last };
    // One threshold everywhere: a press held shorter than the hold window is
    // a rotate — the same window the timer fires the hold at, so a release
    // can never race it on one side in production and the other in a test.
    if (now - this.pressAt < this.holdDelay) return { type: "rotate" };
    return null;
  }

  /** The contact was taken away by the browser: a second finger, a scroll. */
  cancel(): Gesture | null {
    this.clearHoldTimer();
    const wasHolding = this.holding;
    this.origin = null;
    this.last = null;
    this.dragging = false;
    this.holding = false;
    // A held contact aimed at nothing, so there is nothing to unaim.
    return wasHolding ? null : { type: "cancel" };
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }
}

export interface PointerBoard {
  /** Board square under a point in the element's local CSS pixels, or null. */
  spotAt(localX: number, localY: number): Spot | null;
  /** The piece was aimed at a square. */
  aim(spot: Spot): void;
  /** The aim was let go of: place the piece if it can go there. */
  commit(spot: Spot): void;
  /** The piece should stop following the pointer. */
  unaim(): void;
  /** One clockwise rotation. */
  rotate(): void;
  /** Swap the falling piece into hold. */
  hold(): void;
}

/**
 * Wires the tracker to a canvas.
 *
 * The element claims its contacts — `touch-action: none` in CSS keeps the
 * browser from scrolling a drag into a page pan, and the context menu is
 * suppressed because a long-press opening it mid-gesture would steal the
 * hold. Contacts are captured by pointer id, so a second finger resting on
 * the board cannot yank the first finger's drag away.
 */
export function attachPointerPlay(element: HTMLElement, board: PointerBoard): () => void {
  const apply = (gesture: Gesture | null): void => {
    if (!gesture) return;
    switch (gesture.type) {
      case "aim": board.aim(gesture.spot); break;
      case "commit": board.commit(gesture.spot); break;
      case "cancel": board.unaim(); break;
      case "rotate": board.rotate(); break;
      case "hold": board.hold(); break;
    }
  };

  const tracker = new PointerGestureTracker(apply);
  const local = (event: PointerEvent): Spot | null => {
    const box = element.getBoundingClientRect();
    return board.spotAt(event.clientX - box.left, event.clientY - box.top);
  };
  let activeId: number | null = null;

  const onDown = (event: PointerEvent): void => {
    // One contact at a time: a second finger claims nothing and moves
    // nothing, so it can steal neither the drag's aim nor its release.
    if (activeId !== null) return;
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const spot = local(event);
    if (!spot) return;
    event.preventDefault();
    activeId = event.pointerId;
    // Capture keeps a drag alive when the contact leaves the element mid-move.
    // It can legitimately fail — a contact released between events, an axis
    // locked by the browser — and losing it must not lose the gesture: the
    // moves keep coming while the contact is over the board either way.
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Play on without capture.
    }
    apply(tracker.press(spot, event.timeStamp));
  };

  const onMove = (event: PointerEvent): void => {
    if (event.pointerId !== activeId) return;
    const spot = local(event);
    if (!spot) return;
    event.preventDefault();
    apply(tracker.move(spot));
  };

  const onUp = (event: PointerEvent): void => {
    if (event.pointerId !== activeId) return;
    activeId = null;
    event.preventDefault();
    apply(tracker.release(event.timeStamp));
  };

  const onCancel = (event: PointerEvent): void => {
    if (event.pointerId !== activeId) return;
    activeId = null;
    apply(tracker.cancel());
  };

  const stopContextMenu = (event: Event): void => event.preventDefault();
  element.addEventListener("pointerdown", onDown);
  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerup", onUp);
  element.addEventListener("pointercancel", onCancel);
  element.addEventListener("contextmenu", stopContextMenu);

  return () => {
    element.removeEventListener("pointerdown", onDown);
    element.removeEventListener("pointermove", onMove);
    element.removeEventListener("pointerup", onUp);
    element.removeEventListener("pointercancel", onCancel);
    element.removeEventListener("contextmenu", stopContextMenu);
  };
}
