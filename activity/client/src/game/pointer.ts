/**
 * Pointer play: tap to rotate, drag to place, flick down to slam, long-press to hold.
 *
 * The gestures are deliberately the same on a mouse and a finger — a mouse is
 * just a finger that never loses contact — so one state machine serves both.
 * It is pure: no DOM, and every decision surfaces either as a returned
 * gesture or through the constructor's `emit`, which is what makes it
 * testable without a browser and keeps the adapter below a thin shell.
 *
 * The keyboard plays *keys*; a pointer plays *places*. A drag ends in the
 * piece going where it was carried — committed if it fits, parked as a
 * dashed preview if it does not, reset if the carry ended off the board —
 * and the run owns that verdict; this layer never synthesises soft drop or
 * rides gravity, it only reports where the drag has carried the piece.
 *
 * The carry is the Block Blast model, and it is *relative*, never absolute
 * about the piece: a drag starts from the piece's current position — a seat a
 * previous release parked it on included — and every move applies the
 * finger's amplified travel from where the press landed, {@link TOUCH_CARRY}
 * squares per finger square on both axes, measured as a whole and truncated
 * to whole squares — with the sub-square samples a real pointer stream
 * produces, every square on the way is visited. The piece moves by the
 * finger's travel, never to the finger: the press square is the origin of the
 * measurement, not a destination the piece is snapped to. The travel is
 * never clamped: a drag may wander far off
 * the board and back, and the piece lands exactly where it was — a round trip
 * computes to a shift of zero, because the measurement is absolute. While the
 * carried position sits off the board the preview drops (that is the reset
 * the model asks for) but the drag stays live; correcting the finger brings
 * the preview back before the release. Releasing on the board settles the
 * piece exactly as previewed — a placeable seat opens the rest gate, a
 * blocked one parks — and releasing off the board resets the piece to
 * falling. A clean downward swipe is a slam instead: a stroke that only
 * descends — every movement deeper or a square's blip shallower (truncation
 * noise: the stroke keeps its deepest row), the whole chord judged by its
 * ANGLE on the lift rather than per-sample column rules
 * ({@link SLAM_MAX_ANGLE}) — hard-drops the position the piece was shown
 * at when the stroke began, on the release, skipping the release-and-rest
 * wait a settle begins. A pause ends a stroke, armed or not ({@link
 * SLAM_PAUSE_MS}): positioning and swiping are decisions a player makes in
 * either order on one contact, and stillness is the boundary between them —
 * the stroke that outlives the pause is positioning, whatever it armed on
 * the way down. A stroke may begin anywhere the finger has been still: the
 * drag's first movement, or a fresh descent after that beat
 * (measured by the piece — if the preview moved, it wasn't a pause) —
 * positioning and swiping can share one contact, separated by a beat. The
 * preview keeps following the finger the whole way, and the drop follows
 * the STROKE: the slam is one input command, not a drag plus a drop, so
 * the seat it takes is the one shown when the stroke began — the same
 * motion the player made, descended to rest. A dive flowed straight out of
 * positioning without a pause is only carrying: the release settles exactly
 * as if the swipe had never happened.
 *
 * Fingers also come in chords: a tap of two is an undo and a tap of three a
 * redo ({@link MultiTapTracker}). The chord counts every contact the stage
 * sees — including the one the single-finger game is playing — because the
 * primary contact of a two-finger tap is, to {@link PointerGestureTracker},
 * indistinguishable from a solo tap; the adapter suppresses that tap's
 * rotation when the chord says the contact had company. A drag or a hold
 * voids any chord, and a second finger landing re-arms the hold clock, so
 * fingers resting together never read as a long-press.
 */

export interface Spot {
  readonly column: number;
  readonly row: number;
}

/** What the tracker has decided the pointer is doing. */
export type Gesture =
  | { readonly type: "grab" }
  | { readonly type: "carry"; readonly shift: Spot }
  | { readonly type: "settle" }
  | { readonly type: "slam"; readonly origin: Spot }
  | { readonly type: "cancel" }
  | { readonly type: "rotate" }
  | { readonly type: "hold" };

/** How long a still press must sit before it is a hold, in milliseconds. */
export const HOLD_MS = 550;

/**
 * How far a carried piece travels per square the finger travels, on both
 * axes, in squares.
 *
 * The pad hides the square under the contact, and near the floor it hides
 * the rows the placement is chosen between; amplification is the answer —
 * the piece moves faster than the finger, so the floor seats come to a
 * finger parked near the board's edge. One and a half is the feel of the
 * games that do this, and it keeps every square reachable: the sub-square
 * samples a real pointer stream produces cross the amplified squares one at
 * a time, so nothing on the way is skipped (a coarse sample stream would
 * jump — the price of amplification over discrete events). An integer
 * factor, by contrast, strands half the squares behind a parity wall even
 * with perfect samples — from a grab on an even row, only even rows would
 * ever be visited. The same factor rules the columns: without it a finger
 * would need one precise stroke per column, exactly the squeeze the
 * amplification exists to stop.
 */
export const TOUCH_CARRY = 1.5;

/**
 * How far down a swipe must travel to be a slam, in amplified squares.
 *
 * Three is the boundary of a deliberate plunge: the carry's own
 * amplification turns two finger-rows into three squares, so the
 * threshold sits exactly at what carrying produces — a flick need only
 * be as long as an ordinary fast drag, which is what makes it reliable,
 * while slower travel the whole way never arms inside the window. The
 * depth is the stroke's DEEPEST row on the descent from where the stroke
 * began (its own travel, rows counting up from the floor, so downward is
 * negative): a shallower plunge is positioning, but a one-square shallow
 * blip is truncation noise a real finger cannot help, so it neither
 * deepens nor breaks the stroke — only a rise of more than a square does.
 * The travel is measured on the FINGER's own samples, raw and untruncated,
 * amplified by the carry's own factor: the truncated shift only decides how
 * the preview moves, so building the threshold out of it quantized each end
 * of the stroke and made the crossing anywhere between one and three finger
 * rows depending on where the sample boundaries fell. Two finger rows is
 * exactly the crossing, every time.
 */
export const SLAM_MIN_SHIFT = 3;

/**
 * How long a swipe may take, in milliseconds, and how much silence ends
 * one — or separates two. A real slam lands inside a hundred; 400 leaves
 * room for a sample stream that drops in several steps and for the beat
 * of stillness a positioning hand needs before the dive — finger-testing
 * kept missing the older, tighter windows. Before the stroke
 * has crossed the threshold, the window is the whole envelope: it times
 * the descent from where the stroke began toward the threshold, every
 * gap between the stroke's movements included; a stroke that outlives it
 * unarmed is a player positioning the piece — and the silence re-arms
 * the swipe, so the next descent starts a fresh stroke of its own. The
 * window is about SPEED, and only before the crossing: once armed, a
 * stroke lives on the pause clock instead — stillness longer than
 * {@link SLAM_PAUSE_MS} ends it, armed or not, because a pause is the
 * boundary between swiping and positioning in either order. The same
 * span read as silence is what lets one contact do two gestures — a
 * pause longer than the window ends the live stroke, and the next
 * movement, if it descends, begins a fresh one from wherever the piece
 * is then shown. Positioning, a beat, a swipe: one contact, two
 * intentions.
 */
export const SLAM_MAX_MS = 400;

/**
 * How far off vertical a swipe may point and stay a swipe, in degrees.
 *
 * The judge is the CHORD — the angle from where the stroke began to where
 * the finger's last sample left it — not the wobble of individual samples: a
 * real flick sways on the way down and lands where it meant to, so
 * per-sample column rules made every sway a broken stroke. The chord is
 * measured on the RAW finger samples, not on the truncated shifts that drive
 * the preview: each truncated end can be up to a square out, which turned an
 * honest eighteen-degree flick into a thirty-four-degree steer. Thirty
 * degrees off vertical keeps a confident diagonal a drop while a 45-degree
 * steer — carrying the piece across the board — is still carrying.
 */
export const SLAM_MAX_ANGLE = 30;

/**
 * How much stillness ends a stroke, or separates two gestures, in
 * milliseconds.
 *
 * Deliberately much shorter than the swipe window: the beat a positioning
 * hand needs before a dive is small — the finger settles, then goes — and
 * the old window-long wait made positioning-then-swipe miss its beat.
 * Stillness is measured BY THE PIECE: the beat accrues from the last move
 * that changed the carried shift — the last time the preview moved. Wobble
 * that leaves the piece on the same square is a pause; a move the player
 * can see (a boundary flip included) is not. The rule matches what the
 * screen shows, which is the only consistency a player can hold onto.
 */
export const SLAM_PAUSE_MS = 150;

/**
 * How long the whole of a multi-finger chord may take, first finger down to
 * last finger up, in milliseconds.
 *
 * A real two-finger tap lands and lifts inside about 150ms; 300 leaves room
 * for a deliberate third finger without reaching the hold window
 * ({@link HOLD_MS}) where a slow chord would collide with a long-press.
 */
export const TAP_CHORD_MS = 300;

/** What a completed chord asks for. */
export type ChordGesture = { readonly type: "undo" } | { readonly type: "redo" };

/**
 * Counts the contacts of a quick all-fingers-down-up chord.
 *
 * Every contact the stage sees is reported here — the one the one-finger
 * game is playing included, because that contact is exactly what a chord
 * member looks like. A chord completes when its last contact lifts, so no
 * verdict is ever speculated while fingers are still down; it is an undo at
 * two fingers, a redo at three, and nothing at one or at four-plus (four is
 * a palm, not a command). Three things void it: a contact the browser
 * cancels, a finger landing after the window has closed, and the primary
 * contact turning into a drag or a hold — the player is playing, not
 * commanding.
 *
 * The count outlives the completion until the next first-contact press
 * resets it, because the adapter needs to ask, at the primary's own release,
 * whether that contact had company — a tap that was one of several fingers
 * is not a solo tap and must not rotate.
 */
export class MultiTapTracker {
  /** Contacts now down, to their press times. */
  private members = new Map<number, number>();
  /** When the live chord's first contact landed. */
  private startedAt = 0;
  /** The most contacts the live chord held at once. */
  private peak = 0;
  /** A finger landed after the window closed; the chord is beyond saving. */
  private stray = false;
  /** A cancel or a drag/hold voided the chord; it can only wait out its members. */
  private dead = false;

  /** A contact landed. Never decides anything — chords complete on lifts. */
  press(id: number, now: number): ChordGesture | null {
    if (this.members.size === 0) {
      this.startedAt = now;
      this.peak = 0;
      this.stray = false;
      this.dead = false;
    } else if (now - this.startedAt > TAP_CHORD_MS) {
      // Too late to be part of what the first finger started.
      this.stray = true;
    }
    this.members.set(id, now);
    this.peak = Math.max(this.peak, this.members.size);
    return null;
  }

  /**
   * A contact lifted. The last one up completes the chord, for better or
   * worse; every earlier lift is just the chord losing a member.
   */
  release(id: number, now: number): ChordGesture | null {
    if (!this.members.delete(id)) return null;
    if (this.members.size > 0) return null;
    if (this.dead || this.stray || this.peak < 2) return null;
    if (now - this.startedAt > TAP_CHORD_MS) return null;
    if (this.peak === 2) return { type: "undo" };
    if (this.peak === 3) return { type: "redo" };
    return null;
  }

  /**
   * Whether the live — or just-completed — chord ever held two contacts at
   * once. The adapter reads this at the primary's release to keep a tap that
   * was one of several fingers from also rotating.
   */
  wasMulti(): boolean {
    return this.peak >= 2;
  }

  /** The browser took a contact away: anything it was part of is not a tap. */
  cancel(id: number): void {
    if (this.members.delete(id)) this.dead = true;
  }

  /**
   * The primary contact became a drag or a hold: the player is playing the
   * one-finger game, so no chord spanning it may fire. Members stay tracked
   * — their lifts are bookkeeping, not gestures.
   */
  poison(): void {
    if (this.members.size > 0) this.dead = true;
  }
}

/**
 * The hold clock, sliced out for tests. Production arms real timers; a test
 * arms fakes it fires by hand, so "not yet" is decided by the test and not by
 * where a shared event loop happens to be when an assertion runs — a full
 * test process starves timers arbitrarily, and an assertion that reads a
 * "has not fired yet" after a starved delay is reading the past.
 */
export interface HoldClock {
  /** Arms a callback for `ms` from now; returns a token to cancel it by. */
  schedule(fn: () => void, ms: number): unknown;
  /** Disarms a scheduled callback. Cancelling an unknown token is nothing. */
  cancel(token: unknown): void;
}

const timeoutClock: HoldClock = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
};

function wholeSquare(sample: Spot): Spot {
  return { column: Math.floor(sample.column), row: Math.floor(sample.row) };
}

function sameSquare(a: Spot, b: Spot): boolean {
  return wholeSquare(a).column === wholeSquare(b).column && wholeSquare(a).row === wholeSquare(b).row;
}

/**
 * The state machine behind one pointer contact.
 *
 * A press commits to nothing: the piece must not jump to the finger, or a tap
 * would teleport the piece before rotating it. The contact's samples arrive
 * already in board squares — fractional and unclamped, the raw projection of
 * the pointer onto the board's own frame. Aiming begins when a sample
 * crosses into a new square — the *grab* — and that first carrying move
 * already applies the finger's amplified travel from the press, measured as
 * a whole each move and truncated to whole squares per axis. The measurement
 * is absolute, so a round trip computes to exactly zero and no excursion
 * leaves an offset behind. Leaving the board is not an event: the samples go
 * on, the shift goes on, and the run decides what off-board means (the
 * preview drops; the drag does not end). A press that stays put becomes a
 * hold after {@link HOLD_MS}, emitted asynchronously; everything else is
 * decided when the contact ends.
 */
export class PointerGestureTracker {
  /** The contact's first sample — the origin every shift is measured from. */
  private origin: Spot | null = null;
  private pressAt = 0;
  private holdTimer: unknown = null;
  /** The hold fired; the contact's eventual release is inert. */
  private holding = false;
  /** The contact crossed a square boundary; the piece is being carried. */
  private dragging = false;
  /** The last carried shift, to dedupe moves that change nothing. */
  private lastShift: Spot | null = null;
  /** The finger's last sample — the grab gate measures crossings against it. */
  private lastSample: Spot | null = null;
  /** This contact's amplification: {@link TOUCH_CARRY} for a touch, 1 otherwise. */
  private carry = 1;
  /** When the live stroke began, to time it by; null once broken or never begun. */
  private downAt: number | null = null;
  /** The deepest row the live stroke has descended to; each movement must go deeper. */
  private strokeRow: number | null = null;
  /**
   * The piece's carried shift when the live stroke began — the seat a slam
   * takes, in the drag's own shift space, mapped through the anchor at the
   * drop. The slam is one command, so its target is fixed when the command
   * begins, not re-derived from where the finger ended.
   */
  private strokeOrigin: Spot | null = null;
  /**
   * The finger's RAW sample where the live stroke began — its own previous
   * sample, the position it was resting on — and the deepest RAW row it has
   * reached since. The arming threshold is measured on this pair: the
   * finger's travel, amplified exactly as the carry amplifies it, with no
   * truncated shift in the path, so two finger rows cross it wherever the
   * square boundaries happen to fall.
   */
  private strokeStartRaw: Spot | null = null;
  private strokeDeepestRawRow: number | null = null;
  /** The finger's last RAW sample in the live stroke: the chord's far end. */
  private strokeLastRaw: Spot | null = null;
  /** The contact's stroke is clean so far: the release, promptly after, is what drops. */
  private slammed = false;
  /**
   * The last timestamped move that CHANGED the carried shift — the pause
   * clock, and the pause is measured BY THE PIECE: if the preview moved,
   * it wasn't a pause; wobble that leaves the piece on the same square is
   * stillness. This is the rule a player can see. (An earlier attempt
   * measured stillness on the raw finger stream, but that counts a
   * boundary flip — a visible preview move — as stillness while demanding
   * sub-tenth-square finger immobility the player cannot deliver. The
   * preview answers both failures at once: deduped moves are stillness
   * whatever the finger did, and a flip is activity because the player
   * watched the piece jump.)
   */
  private lastChangedAt: number | null = null;
  /** The finger's last carried shift — the stroke's own travel is measured against it. */
  private lastFinger: Spot | null = null;
  /**
   * Whether this contact has carried the piece anywhere yet — any nonzero
   * shift, ever. "The drag's first movement" as the swipe's descent gate
   * reads it: a one-shot flag burned by a nonzero carry, not by the grab
   * move itself. The grab usually fires before the amplified shift leaves
   * zero (the square boundary comes first), and burning on THAT move made
   * every continuous dive from the press a settle — the finger never
   * stopped, so no pause ever opened a stroke either.
   */
  private carried = false;

  constructor(
    private readonly emit: (gesture: Gesture) => void = () => {},
    /** Injectable so tests do not wait out a real hold. */
    private readonly holdDelay: number = HOLD_MS,
    private readonly clock: HoldClock = timeoutClock,
  ) {}

  /**
   * A contact began, its sample the raw board-frame projection of the press
   * (fractional, unclamped); `carry` is its amplification. Nothing is
   * decided yet — in particular the piece does not move.
   */
  press(sample: Spot, now: number, carry: number = 1): Gesture | null {
    this.origin = sample;
    this.pressAt = now;
    this.holding = false;
    this.dragging = false;
    this.lastShift = null;
    this.lastSample = sample;
    this.lastFinger = null;
    this.carried = false;
    this.carry = Math.max(1, carry);
    this.endStroke();
    this.lastChangedAt = null;
    this.armHold();
    return null;
  }

  /**
   * Ends any live stroke. The fields are the stroke; nulling them is the
   * same whatever broke it — a rise, a detour, a stall, a pause.
   */
  private endStroke(): void {
    this.downAt = null;
    this.strokeRow = null;
    this.strokeOrigin = null;
    this.strokeStartRaw = null;
    this.strokeDeepestRawRow = null;
    this.strokeLastRaw = null;
    this.slammed = false;
  }

  /**
   * The contact moved; `sample` is its raw projection in board squares.
   *
   * The first sample in a new square grabs, and that move already carries
   * the amplified travel from the press: the drag begins with the piece
   * moved by the finger's travel so far — by it, never to it (the run
   * anchors the drag wherever the piece is). Every move carries the
   * finger's amplified travel from the press sample, truncated to whole
   * squares per axis. With fractional samples a move *within* a square can
   * still cross an amplified boundary, so nothing is deduped by square —
   * only by shift. Re-entering the press square computes a zero shift: the
   * finger's return to where the drag started is a fresh start, with no
   * offset accumulated from anywhere it went.
   *
   * `now` is the move's timestamp, and only the slam needs it — how fast
   * the descent was, and how long the finger has been silent. A caller
   * that cannot timestamp its moves (the pure tests) omits it and simply
   * never slams: a time-blind stream cannot mean a flick.
   */
  move(sample: Spot, now?: number): Gesture | null {
    if (!this.origin || this.holding) return null;
    if (!this.dragging) {
      if (sameSquare(this.lastSample!, sample)) return null;
      this.dragging = true;
      this.clearHoldTimer();
      // The grab: the piece stays put; the run anchors the drag at it.
      this.emit({ type: "grab" });
      // Fall through: the grab move itself already carries the shift.
    }
    // The finger's sample before this one: where the current movement began,
    // and — for a movement that opens a stroke — the raw position the
    // stroke's own travel is measured from.
    const previousSample = this.lastSample!;
    const shift = this.carriedShift(this.origin, sample);
    this.lastSample = sample;
    // The pause between gestures is read off the move stream itself: a
    // gap longer than the window ends the live stroke, and the silence
    // re-arms the swipe for a fresh descent after it. Arming does not
    // exempt a stroke from this: the pause is the boundary between
    // positioning and swiping, in either order, and a finger that stops
    // for longer than the window has stopped flicking — whatever the
    // stroke armed on the way down. The seated piece is where the player
    // left it, and the release settles.
    const previousChangedAt = this.lastChangedAt;
    if (now !== undefined) {
      // The window that expires a stroke runs on its own clock; the
      // silence that separates two gestures runs on the stillness clock
      // (below) — a held-still finger's sub-square stream is stillness,
      // however the truncated shift flips.
      if (
        (!this.slammed &&
          ((this.downAt !== null && now - this.downAt > SLAM_MAX_MS) ||
            (previousChangedAt !== null && now - previousChangedAt > SLAM_MAX_MS))) ||
        (previousChangedAt !== null && now - previousChangedAt > SLAM_PAUSE_MS)
      ) {
        this.endStroke();
      }
    }
    if (this.downAt !== null) {
      // A live stroke demands a still-deepening dive — laterally free.
      // The chord is judged by its ANGLE on the lift, not by per-sample
      // column rules: a real flick sways on the way down and lands where
      // it meant to, and a per-sample column clamp made every sway a
      // broken stroke. Only a deliberate RISE ends the stroke here: a
      // one-square shallowing is truncation noise — amplified rows land
      // near boundaries, and killing the stroke on that blip is what made
      // a clean flick a coin toss. The stroke keeps its DEEPEST row.
      if (shift.row > this.strokeRow! + 1) {
        this.endStroke();
      } else if (shift.row < this.strokeRow!) {
        this.strokeRow = shift.row;
      }
    } else if (now !== undefined) {
      // A descent begins a stroke only where the finger has been still:
      // the drag's first movement, or the first movement after a pause.
      // The dive that opens a
      // stroke is the first move DOWNWARD past the row the finger is
      // resting on — a finger parked HIGH (the piece moved up first) then
      // diving starts its stroke here, not above at some earlier stamp.
      // The pause is measured from the last move that CHANGED the shift —
      // a held-still finger keeps streaming sub-square events whose shift
      // dedupes to the same square, and they must not reset the pause
      // clock under themselves.
      const first = !this.carried; // the drag's first meaningful travel
      // The pause is measured BY THE PIECE: stillness since the last move
      // that changed the carried shift — the last time the preview moved.
      const afterPause = previousChangedAt !== null && now - previousChangedAt > SLAM_PAUSE_MS;
      const resting = this.lastFinger ?? { column: 0, row: 0 };
      if (shift.row < resting.row && (first || afterPause)) {
        this.downAt = now;
        this.strokeRow = shift.row;
        // The stroke's origin is the seat the piece was shown at — the
        // last carried shift, or the drag's anchor when nothing has
        // carried yet. The runner maps it back to a seat at the slam, so
        // the drop takes what the player watched the stroke begin on —
        // and for a dive out of a pause, that is exactly the pause
        // position: where the finger was resting, wherever it parked
        // the piece first.
        this.strokeOrigin = this.lastShift ? { ...this.lastShift } : { column: 0, row: 0 };
        // The depth a stroke is judged by is its own travel: the descent
        // from where the finger actually was, never the frozen depth of
        // some earlier, broken stroke above it. The reference is the
        // finger's own previous sample — raw and untruncated — because the
        // threshold is a claim about the finger, while the truncated shift
        // it also produces is a claim about the preview.
        this.strokeStartRaw = previousSample;
        this.strokeDeepestRawRow = sample.row;
        this.strokeLastRaw = sample;
      }
    }
    // The stroke's deepest RAW descent, in lockstep with the truncated
    // strokeRow above: the finger's own samples, nothing truncated.
    if (this.downAt !== null && this.strokeDeepestRawRow !== null) {
      if (sample.row < this.strokeDeepestRawRow) this.strokeDeepestRawRow = sample.row;
      this.strokeLastRaw = sample;
    }
    // Arming: the stroke has covered the threshold inside the window.
    // Board rows count up from the floor, so downward is the negative
    // direction, and the depth is the stroke's own deepest descent — a
    // positioning drift cannot borrow a later twitch's speed. The depth is
    // the finger's RAW amplified travel: with no truncated shift in the
    // path, the crossing sits at the same two finger rows every time.
    if (
      !this.slammed &&
      now !== undefined &&
      this.downAt !== null &&
      this.strokeStartRaw !== null &&
      this.strokeDeepestRawRow !== null &&
      now - this.downAt <= SLAM_MAX_MS &&
      (this.strokeStartRaw.row - this.strokeDeepestRawRow) * this.carry >= SLAM_MIN_SHIFT
    ) {
      this.slammed = true;
    }
    this.lastFinger = shift;
    // Meaningful travel happened: the drag's first-movement window is
    // spent. A zero shift (the grab move, a return to the press point)
    // does not spend it — the descent may still begin.
    if (shift.column !== 0 || shift.row !== 0) this.carried = true;
    // The preview ALWAYS follows the finger — armed or not. The stroke's
    // travel is gesture, never steering: what the finger moved is what
    // the drop will take, and the runner maps the stroke's origin through
    // whatever slides and rotations have happened since. A stroke never
    // moves what the player sees mid-gesture, so there is nothing to snap
    // back when the drop arrives.
    const carried = shift;
    if (this.lastShift && carried.column === this.lastShift.column && carried.row === this.lastShift.row) {
      return null;
    }
    this.lastShift = carried;
    // The shift changed: this is activity, and the pause clock restarts
    // from it. Deduped moves leave {@link lastChangedAt} standing.
    if (now !== undefined) this.lastChangedAt = now;
    return { type: "carry", shift: carried };
  }

  /**
   * The amplified travel from the press sample (`origin`) to `sample`, in
   * whole squares per axis. Absolute and truncating: the same sample always
   * computes to the same shift, so reversing the finger reverses the piece
   * step for step and returning to the press point computes to exactly zero.
   */
  private carriedShift(origin: Spot, sample: Spot): Spot {
    return {
      column: Math.trunc((sample.column - origin.column) * this.carry),
      row: Math.trunc((sample.row - origin.row) * this.carry),
    };
  }

  /**
   * The contact ended. A drag settles the piece exactly as carried — the run
   * decides between committing, parking and resetting; a tap rotates; a slam
   * and a held contact have already had their say and leave nothing behind.
   */
  release(now: number): Gesture | null {
    this.clearHoldTimer();
    // The armed stroke fires here: the window timed the dive that earned
    // the drop, not the hold after it — swipe down, release drops the
    // piece. An unarmed stroke never armed, and a stroke that PAUSED has
    // already been ended by the move stream; but a finger perfectly still
    // streams no moves, so the release itself applies the pause rule one
    // last time: silence at the lift is the same boundary silence is
    // anywhere else.
    let swiped = this.slammed;
    if (swiped && this.lastChangedAt !== null && now - this.lastChangedAt > SLAM_PAUSE_MS) {
      swiped = false;
    }
    // Read before endStroke below nulls it: the origin is the slam's cargo.
    const strokeOrigin = this.strokeOrigin;
    // The angle judge runs at the lift, over the WHOLE stroke, on the RAW
    // samples: the chord from where the dive began to the finger's last
    // sample. A flick may sway on the way down — per-sample column clamps
    // broke on every sway — but the chord names the gesture: within
    // {@link SLAM_MAX_ANGLE} of vertical is a drop, wider is steering.
    if (swiped && this.strokeStartRaw && this.strokeLastRaw) {
      const angleOffVertical =
        (Math.atan2(
          this.strokeLastRaw.column - this.strokeStartRaw.column,
          this.strokeStartRaw.row - this.strokeLastRaw.row,
        ) *
          180) /
        Math.PI;
      if (Math.abs(angleOffVertical) > SLAM_MAX_ANGLE) swiped = false;
    }
    this.endStroke();
    this.lastChangedAt = null;
    const { origin, dragging } = this;
    this.origin = null;
    this.lastShift = null;
    this.lastSample = null;
    this.lastFinger = null;
    this.dragging = false;
    if (this.holding) {
      this.holding = false;
      return null;
    }
    if (!origin) return null;
    // The stroke that stayed clean to the very lift fires here: the whole
    // gesture belonged to the player until the finger was up. The seat
    // rides along: the drop takes what the piece was showing when the
    // stroke began — the slam is one command, and the player's intent is
    // the stroke's seat, not a seat the finger drifted to after it.
    if (swiped) return { type: "slam", origin: strokeOrigin! };
    if (dragging) return { type: "settle" };
    // One threshold everywhere: a press held shorter than the hold window is
    // a rotate — the same window the timer fires the hold at, so a release
    // can never race it on one side in production and the other in a test.
    if (now - this.pressAt < this.holdDelay) return { type: "rotate" };
    return null;
  }

  /**
   * Re-arms the hold clock, as when a second finger lands: fingers resting
   * together are a chord in the making, not a long-press. The clock only
   * restarts while a still contact is pending — a drag has already forfeited
   * its hold and a fired hold has already had its say.
   */
  restartHold(): void {
    if (!this.origin || this.dragging || this.holding) return;
    this.clearHoldTimer();
    this.armHold();
  }

  /** The contact was taken away by the browser: a second finger, a scroll. */
  cancel(): Gesture | null {
    this.clearHoldTimer();
    this.endStroke();
    this.lastChangedAt = null;
    const wasHolding = this.holding;
    const hadPress = this.origin !== null;
    this.slammed = false;
    this.dragging = false;
    this.holding = false;
    this.origin = null;
    this.lastShift = null;
    this.lastSample = null;
    this.lastFinger = null;
    // A held contact carried nothing, so there is nothing to reset — and a
    // cancel with no contact at all names nothing.
    return wasHolding || !hadPress ? null : { type: "cancel" };
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      this.clock.cancel(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private armHold(): void {
    this.holdTimer = this.clock.schedule(() => {
      this.holdTimer = null;
      // A drag that happens to be over its origin square is a drag, not a
      // hold; only a contact that never moved is.
      if (this.origin && !this.dragging) {
        this.holding = true;
        this.origin = null;
        this.emit({ type: "hold" });
      }
    }, this.holdDelay);
  }
}

export interface PointerBoard {
  /**
   * The raw projection of a point onto the board's own frame, in board
   * squares: fractional, unclamped — anywhere on the stage maps to the
   * square it would name if the board extended that far, and off-board
   * samples are exactly how a drag travels virtually.
   */
  sampleAt(localX: number, localY: number): Spot;
  /**
   * A contact landed. The run counts them: a placement waiting out its rest
   * cannot commit while any contact is down — the rest is the time the hand
   * spends off the piece, which is what makes the commit deliberate — and the
   * last lift starts it over, so a finger resting on the piece can never lock
   * it out from under itself and hand the next gesture to the next piece.
   */
  contactDown(): void;
  /** A contact lifted: with the last one up, a waiting rest starts over. */
  contactUp(): void;
  /**
   * A drag took hold: anchor it at the piece's current position — the parked
   * preview seat, or the falling piece itself. Never moves anything.
   */
  grabBase(): void;
  /**
   * The drag carried the piece by `shift` — the finger's amplified travel
   * from the grab point, in whole board squares, unclamped. Off-board shifts
   * drop the preview; the run owns that decision.
   */
  carryAt(shift: Spot): void;
  /**
   * The drag ended: commit the carried seat if it is on the board and
   * placeable, park the piece exactly as previewed if the seat is shown but
   * unplaceable, and reset when the carry ended off the board (no live aim
   * to settle).
   */
  settleAt(): void;
  /**
   * A clean downward swipe: hard-drop the stroke's seat — descended to
   * rest the way a hard drop descends it — and commit it at once, without
   * waiting out the rest. An invalid swipe — a stroke seat past the edge,
   * where nothing is shown to drop — resets the piece, as any drag
   * released off the board; a seat already inside the stack is a settled
   * nothing.
   */
  slamDrop(origin: Spot): void;
  /** The drag died without a release: drop the preview, piece falls on. */
  cancelCarry(): void;
  /** One clockwise rotation. */
  rotate(): void;
  /** Swap the falling piece into hold. */
  hold(): void;
  /** Take back the last placement. */
  undo(): void;
  /** Put back the placement undo took. */
  redo(): void;
}

export interface PointerPlayOptions {
  /** Injectable so tests do not wait out a real hold. */
  readonly holdDelay?: number;
  /** The hold clock, for tests that fire it by hand. */
  readonly clock?: HoldClock;
  /** Surface whose native iOS long-press loupe should be suppressed. */
  readonly touchTarget?: HTMLElement;
}

export interface PointerPlayHandle {
  /** Cancels any active gesture and balances every contact, keeping listeners. */
  reset(): void;
  /** Cancels state and removes the event listeners. Safe to call more than once. */
  dispose(): void;
}

/**
 * Wires the tracker to the play surface.
 *
 * The element is the stage around the board rather than the board itself: a
 * press anywhere on it can begin a drag, because a drag anchors at the piece
 * rather than at the finger, and the drag may leave the card without ending
 * — the samples keep coming and the travel stays virtual. The element
 * claims its contacts — `touch-action: none` in CSS keeps the browser from
 * scrolling a drag into a page pan, and the context menu is suppressed
 * because a long-press opening it mid-gesture would steal the hold. Contacts
 * are captured by pointer id, so a second finger resting on the board cannot
 * yank the first finger's drag away.
 */
export function attachPointerPlay(
  element: HTMLElement,
  board: PointerBoard,
  options: PointerPlayOptions = {},
): PointerPlayHandle {
  const holdDelay = options.holdDelay ?? HOLD_MS;
  const clock = options.clock ?? timeoutClock;
  const touchTarget = options.touchTarget ?? element;
  const chord = new MultiTapTracker();
  const apply = (gesture: Gesture | ChordGesture | null): void => {
    if (!gesture) return;
    switch (gesture.type) {
      case "grab": board.grabBase(); break;
      case "carry": board.carryAt(gesture.shift); break;
      case "settle": board.settleAt(); break;
      case "slam": board.slamDrop(gesture.origin); break;
      case "cancel": board.cancelCarry(); break;
      case "rotate": board.rotate(); break;
      case "hold": board.hold(); break;
      case "undo": board.undo(); break;
      case "redo": board.redo(); break;
    }
  };

  // One path for the tracker's own verdicts, so the rule the game owes the
  // chord holds everywhere: a contact that starts playing — a grab, a hold,
  // or a slam — is not tapping, and voids any chord it was counted in. Grab
  // and hold arrive through the constructor's emit; the lift's verdict
  // (settle, slam, rotate) comes back from `release` and reaches here the
  // same way. Carry moves go straight to `apply`: a carry only exists after
  // a grab, which has already voided the chord.
  const play = (gesture: Gesture | null): void => {
    if (
      gesture &&
      (gesture.type === "grab" || gesture.type === "hold" || gesture.type === "slam")
    ) {
      chord.poison();
    }
    apply(gesture);
  };
  const tracker = new PointerGestureTracker(play, holdDelay, clock);
  const local = (event: PointerEvent): Spot => {
    const box = element.getBoundingClientRect();
    return board.sampleAt(event.clientX - box.left, event.clientY - box.top);
  };
  let activeId: number | null = null;
  /**
   * The contacts this adapter counted down. Kept here rather than in the
   * tracker: a chord's extra fingers never reach the one-finger state
   * machine, but every one of them is still a finger on the piece.
   */
  const contacts = new Set<number>();

  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if (activeId !== null) {
      // A second contact: it joins the chord count and restarts the hold
      // clock — fingers resting together are not a long-press — and claims
      // nothing else, so it can steal neither the drag's aim nor its release.
      // It still counts as a hand on the piece: a rest gate waiting under it
      // holds its seat without counting down.
      event.preventDefault();
      chord.press(event.pointerId, event.timeStamp);
      tracker.restartHold();
      contacts.add(event.pointerId);
      board.contactDown();
      return;
    }
    // Every contact counts toward a chord, wherever it lands: a tap is about
    // the fingers, not about where the sample map can see them.
    chord.press(event.pointerId, event.timeStamp);
    const sample = local(event);
    event.preventDefault();
    activeId = event.pointerId;
    contacts.add(event.pointerId);
    board.contactDown();
    // Capture keeps a drag alive when the contact leaves the element mid-move.
    // It can legitimately fail — a contact released between events, an axis
    // locked by the browser — and losing it must not lose the gesture: the
    // moves keep coming while the contact is over the stage either way.
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Play on without capture.
    }
    apply(
      tracker.press(
        sample,
        event.timeStamp,
        event.pointerType === "touch" ? TOUCH_CARRY : 1,
      ),
    );
  };

  const onMove = (event: PointerEvent): void => {
    if (event.pointerId !== activeId) return;
    // The timestamp is the slam's evidence: how fast the descent was.
    apply(tracker.move(local(event), event.timeStamp));
  };

  const onUp = (event: PointerEvent): void => {
    const chordGesture = chord.release(event.pointerId, event.timeStamp);
    if (contacts.delete(event.pointerId)) board.contactUp();
    if (event.pointerId !== activeId) {
      if (chordGesture) apply(chordGesture);
      return;
    }
    activeId = null;
    event.preventDefault();
    const verdict = tracker.release(event.timeStamp);
    // A tap that was one of several fingers is not a solo tap: the chord is
    // what those fingers meant, and the rotation they would also trigger is
    // dropped. A drag still settles — the piece is where it was carried.
    if (verdict && !(verdict.type === "rotate" && chord.wasMulti())) play(verdict);
    if (chordGesture) apply(chordGesture);
  };

  /** A browser interruption ended one contact without a player command. */
  const cancelContact = (pointerId: number): void => {
    chord.cancel(pointerId);
    const wasActive = pointerId === activeId;
    if (wasActive) {
      activeId = null;
      apply(tracker.cancel());
    }
    if (contacts.delete(pointerId)) board.contactUp();
  };

  const onCancel = (event: PointerEvent): void => {
    cancelContact(event.pointerId);
  };

  const reset = (): void => {
    // Cancel the primary before lifting contacts: cancelCarry clears any
    // pending placement gate, then the balanced lifts can safely restart it.
    if (activeId !== null) {
      const pointerId = activeId;
      activeId = null;
      chord.cancel(pointerId);
      apply(tracker.cancel());
      try {
        element.releasePointerCapture(pointerId);
      } catch {
        // Capture may already have been released by the browser.
      }
    }
    for (const pointerId of contacts) {
      chord.cancel(pointerId);
      contacts.delete(pointerId);
      board.contactUp();
    }
  };

  const onLostCapture = (event: PointerEvent): void => {
    // Normal pointerup/pointercancel releases capture after their handlers
    // have already removed the contact. An early loss must also clear a
    // secondary finger: it has no drag, but still owns a chord/contact count.
    if (contacts.has(event.pointerId)) cancelContact(event.pointerId);
  };

  const onBlur = (): void => reset();
  const ownerDocument = element.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const onVisibilityChange = (): void => {
    if (ownerDocument.visibilityState === "hidden") reset();
  };

  const suppressTouchLoupe = (event: TouchEvent): void => {
    // WebKit's tap-then-hold loupe is separate from the callout CSS and is
    // suppressed by canceling touchstart. Keep this on the canvas only, so
    // page controls, fields, and scrolling outside the board retain defaults.
    if (event.cancelable) event.preventDefault();
  };

  const stopContextMenu = (event: Event): void => event.preventDefault();
  element.addEventListener("pointerdown", onDown);
  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerup", onUp);
  element.addEventListener("pointercancel", onCancel);
  element.addEventListener("lostpointercapture", onLostCapture);
  element.addEventListener("contextmenu", stopContextMenu);
  touchTarget.addEventListener("touchstart", suppressTouchLoupe, { passive: false });
  ownerWindow?.addEventListener("blur", onBlur);
  ownerDocument.addEventListener("visibilitychange", onVisibilityChange);

  let disposed = false;
  return {
    reset,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      reset();
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onCancel);
      element.removeEventListener("lostpointercapture", onLostCapture);
      element.removeEventListener("contextmenu", stopContextMenu);
      touchTarget.removeEventListener("touchstart", suppressTouchLoupe);
      ownerWindow?.removeEventListener("blur", onBlur);
      ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
