/**
 * Handling — the millisecond-level feel of the controls.
 *
 * Players think in milliseconds, and so does every handling guide and every
 * other client they will have used, including the club's own board at
 * tetrisatuci.org/play. The engine thinks in 60Hz frames. These settings are
 * stored and shown in milliseconds; {@link toEngineHandling} is the one place
 * that converts, and it is called inside the engine factory so a caller cannot
 * hand the engine the wrong unit by accident.
 *
 * The conversion is deliberately not rounded to whole frames: the engine's
 * shift and drop arithmetic is all floating point, so a DAS of 103ms really is
 * 103ms rather than the nearest sixtieth of a second.
 */

export interface Handling {
  /** Delayed auto-shift: how long a direction is held before it repeats, in ms. */
  das: number;
  /** Auto-repeat rate: milliseconds between shifts once DAS has charged. */
  arr: number;
  /** DAS cut delay: milliseconds of DAS charge lost when a piece spawns or rotates. */
  dcd: number;
  /** Soft-drop factor — a multiplier, not a time. 41 means "arrive instantly". */
  sdf: number;
  /** Prevents an instant lock when a piece is dropped onto the stack. */
  safelock: boolean;
  /** Releasing one direction while both are held re-charges DAS the other way. */
  cancel: boolean;
  /** Allow 20G-style movement along the floor. */
  may20g: boolean;
  /** Initial rotation system: apply a rotation held through the spawn. */
  irs: "off" | "hold" | "tap";
  /** Initial hold system: apply a hold held through the spawn. */
  ihs: "off" | "hold" | "tap";
}

interface NumericRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** How the value is written: a duration, or a bare multiplier. */
  readonly unit: "ms" | "×";
}

const FRAME_MS = 1000 / 60;

/**
 * Limits, in milliseconds, matching TETR.IO's own once converted from frames.
 * DAS bottoms out at one frame rather than zero: a zero would start repeating
 * on the same tick as the first shift, which is not a setting so much as a bug.
 */
export const HANDLING_RANGES = {
  das: { min: 17, max: 333, step: 1, unit: "ms" },
  arr: { min: 0, max: 83, step: 1, unit: "ms" },
  dcd: { min: 0, max: 333, step: 1, unit: "ms" },
  sdf: { min: 5, max: 41, step: 1, unit: "×" },
} as const satisfies Record<string, NumericRange>;

/** The soft-drop factor at which the piece stops falling and simply arrives. */
export const SDF_INSTANT = 41;

/** The club's own defaults, so the two boards feel the same out of the box. */
export const DEFAULT_HANDLING: Handling = {
  das: 100,
  arr: 0,
  dcd: 0,
  sdf: SDF_INSTANT,
  safelock: true,
  cancel: false,
  may20g: true,
  irs: "tap",
  ihs: "tap",
};

export function msToFrames(ms: number): number {
  return ms / FRAME_MS;
}

/**
 * The same settings with every duration expressed in 60Hz frames.
 *
 * Only the engine wants this. Everything else — storage, the settings sheet,
 * the run submitted to the server — stays in milliseconds.
 */
export function toEngineHandling(handling: Handling): Handling {
  return {
    ...handling,
    das: msToFrames(handling.das),
    arr: msToFrames(handling.arr),
    dcd: msToFrames(handling.dcd),
  };
}

function clampNumber(value: unknown, range: NumericRange, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const stepped = Math.round(value / range.step) * range.step;
  return Math.min(range.max, Math.max(range.min, stepped));
}

function clampBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampMode(value: unknown, fallback: "off" | "hold" | "tap") {
  return value === "off" || value === "hold" || value === "tap" ? value : fallback;
}

/**
 * Coerces anything (a URL param, a stale localStorage blob, a request body)
 * into handling the engine will accept. Never throws — bad values fall back.
 */
export function sanitizeHandling(input: unknown): Handling {
  const raw = (input ?? {}) as Partial<Record<keyof Handling, unknown>>;
  return {
    das: clampNumber(raw.das, HANDLING_RANGES.das, DEFAULT_HANDLING.das),
    arr: clampNumber(raw.arr, HANDLING_RANGES.arr, DEFAULT_HANDLING.arr),
    dcd: clampNumber(raw.dcd, HANDLING_RANGES.dcd, DEFAULT_HANDLING.dcd),
    sdf: clampNumber(raw.sdf, HANDLING_RANGES.sdf, DEFAULT_HANDLING.sdf),
    safelock: clampBoolean(raw.safelock, DEFAULT_HANDLING.safelock),
    cancel: clampBoolean(raw.cancel, DEFAULT_HANDLING.cancel),
    may20g: clampBoolean(raw.may20g, DEFAULT_HANDLING.may20g),
    irs: clampMode(raw.irs, DEFAULT_HANDLING.irs),
    ihs: clampMode(raw.ihs, DEFAULT_HANDLING.ihs),
  };
}
