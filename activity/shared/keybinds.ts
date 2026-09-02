/**
 * Key bindings.
 *
 * Bindings are stored as `KeyboardEvent.code` values, which describe a physical
 * key rather than the character it produces — so a binding survives a layout
 * change, and players on AZERTY or Dvorak get the key they actually pressed.
 *
 * Shared rather than client-only because the server stores bindings as part of
 * a player's preferences and has to sanitise them before writing the row.
 */

import type { GameKey } from "./tetris/verify";

/** Actions the run itself handles, alongside the engine's own keys. */
export type LocalAction = "reset" | "settings" | "skip" | "undo" | "redo";

export type BindableAction = GameKey | LocalAction;

export type Keybinds = Readonly<Record<BindableAction, readonly string[]>>;

export const ACTION_ORDER: readonly BindableAction[] = [
  "moveLeft",
  "moveRight",
  "softDrop",
  "hardDrop",
  "rotateCW",
  "rotateCCW",
  "rotate180",
  "hold",
  "undo",
  "redo",
  "reset",
  "skip",
  "settings",
];

export const ACTION_LABELS: Readonly<Record<BindableAction, string>> = {
  moveLeft: "Move left",
  moveRight: "Move right",
  softDrop: "Soft drop",
  hardDrop: "Hard drop",
  rotateCW: "Rotate right",
  rotateCCW: "Rotate left",
  rotate180: "Flip 180",
  hold: "Hold",
  undo: "Undo placement",
  redo: "Redo placement",
  reset: "Restart",
  skip: "Skip puzzle",
  settings: "Settings",
};

export const DEFAULT_KEYBINDS: Keybinds = {
  moveLeft: ["ArrowLeft"],
  moveRight: ["ArrowRight"],
  softDrop: ["ArrowDown"],
  hardDrop: ["Space"],
  rotateCW: ["ArrowUp", "KeyX"],
  // Z alone, not Ctrl as well: with undo on Ctrl+Z below, a bare Ctrl binding
  // would rotate the piece on the way into every undo. Ctrl is still bindable
  // by anyone who wants it there.
  rotateCCW: ["KeyZ"],
  rotate180: ["KeyA"],
  hold: ["KeyC", "ShiftLeft"],
  // Free keys next to each other; every letter the game already uses is taken.
  undo: ["Ctrl+KeyZ"],
  redo: ["Ctrl+KeyY"],
  reset: ["KeyR"],
  // Rush only; in the daily there is nothing to skip to.
  skip: ["KeyS"],
  settings: ["Escape"],
};

const ACTIONS = new Set<string>(ACTION_ORDER);

/** Never let a binding capture a key the browser needs to stay usable. */
const FORBIDDEN_CODES = new Set(["F5", "F11", "F12", "Tab"]);

/**
 * A `KeyboardEvent.code` is a short identifier like `ArrowLeft` or `KeyZ`.
 * Bounding the shape matters because these are stored server-side: without it
 * the preferences row is free unbounded storage for anyone with a session.
 */
const KEY_CODE = /^[A-Za-z0-9]{1,32}$/;

/**
 * Modifiers, in the one order a chord is ever written.
 *
 * A binding is a base key with optional modifiers in front of it, joined by
 * `+` — `Ctrl+KeyZ`. Canonical order matters because the string *is* the
 * lookup key: `Shift+Ctrl+KeyZ` and `Ctrl+Shift+KeyZ` are the same chord, and
 * only one of them may ever be written down.
 */
const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Which modifier a key *is*, when the key pressed is itself a modifier. */
const MODIFIER_KEYS: Readonly<Record<string, Modifier>> = {
  ControlLeft: "Ctrl", ControlRight: "Ctrl",
  AltLeft: "Alt", AltRight: "Alt",
  ShiftLeft: "Shift", ShiftRight: "Shift",
  MetaLeft: "Meta", MetaRight: "Meta",
};

/**
 * The chord a key event represents.
 *
 * A modifier the event's own key *is* does not count towards its chord, which
 * is what keeps a bare modifier binding working: rotate-left is bound to
 * `ControlLeft` by default, and the browser reports `ctrlKey: true` on the very
 * event that presses it. Counting that would turn every press of it into
 * `Ctrl+ControlLeft` and the binding would never match again.
 */
export function chordOf(event: {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string {
  const self = MODIFIER_KEYS[event.code];
  const held: Modifier[] = [];
  if (event.ctrlKey && self !== "Ctrl") held.push("Ctrl");
  if (event.altKey && self !== "Alt") held.push("Alt");
  if (event.shiftKey && self !== "Shift") held.push("Shift");
  if (event.metaKey && self !== "Meta") held.push("Meta");
  return [...held, event.code].join("+");
}

/** Splits a chord into its modifiers and the key they qualify. */
function parseChord(chord: string): { mods: string[]; base: string } | null {
  const parts = chord.split("+");
  const base = parts.pop() ?? "";
  const mods = parts;
  if (mods.length > MODIFIERS.length) return null;
  if (new Set(mods).size !== mods.length) return null;
  if (!mods.every((mod) => (MODIFIERS as readonly string[]).includes(mod))) return null;
  // In canonical order, or two spellings of one chord would be two bindings.
  const canonical = MODIFIERS.filter((mod) => mods.includes(mod));
  if (canonical.join("+") !== mods.join("+")) return null;
  // `Ctrl+ControlLeft` is not a chord, it is a modifier qualifying itself.
  if (mods.length > 0 && MODIFIER_KEYS[base]) return null;
  return { mods, base };
}

/** More than a couple of alternates per action is a payload, not a preference. */
const MAX_CODES_PER_ACTION = 4;

export function isBindable(chord: string): boolean {
  const parsed = parseChord(chord);
  if (!parsed) return false;
  return KEY_CODE.test(parsed.base) && !FORBIDDEN_CODES.has(parsed.base);
}

/** Human-readable name for a chord, e.g. `Ctrl+KeyZ` as "Ctrl + Z". */
export function keyName(chord: string): string {
  const parsed = parseChord(chord);
  if (parsed && parsed.mods.length > 0) {
    return [...parsed.mods, baseName(parsed.base)].join(" + ");
  }
  return baseName(chord);
}

function baseName(code: string): string {
  const named: Record<string, string> = {
    Space: "Space",
    ArrowLeft: "◀",
    ArrowRight: "▶",
    ArrowUp: "▲",
    ArrowDown: "▼",
    ControlLeft: "L Ctrl",
    ControlRight: "R Ctrl",
    ShiftLeft: "L Shift",
    ShiftRight: "R Shift",
    AltLeft: "L Alt",
    AltRight: "R Alt",
    Escape: "Esc",
    Enter: "Enter",
    Backspace: "Bksp",
  };
  if (named[code]) return named[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}

/**
 * Coerces stored bindings into something usable, keeping whatever is valid.
 *
 * An action present but empty is deliberate — rebinding a key takes it away
 * from whoever had it, and the player can see the result in the settings sheet.
 * Only a missing or malformed entry falls back to the default, or reassigning a
 * key would silently hand it back on the next reload.
 */
export function sanitizeKeybinds(input: unknown): Keybinds {
  const raw = (input ?? {}) as Record<string, unknown>;
  const result: Record<BindableAction, string[]> = {} as Record<BindableAction, string[]>;
  for (const action of ACTION_ORDER) {
    const codes = raw[action];
    if (!Array.isArray(codes)) {
      result[action] = [...DEFAULT_KEYBINDS[action]];
      continue;
    }
    const valid = codes.filter(
      (code): code is string => typeof code === "string" && isBindable(code),
    );
    result[action] = [...new Set(valid)].slice(0, MAX_CODES_PER_ACTION);
  }
  return result;
}

/** Reverse index from physical key to action, for the input handler's hot path. */
export function buildLookup(binds: Keybinds): ReadonlyMap<string, BindableAction> {
  const lookup = new Map<string, BindableAction>();
  for (const action of ACTION_ORDER) {
    for (const code of binds[action]) {
      if (!lookup.has(code)) lookup.set(code, action);
    }
  }
  return lookup;
}

/**
 * Listed once rather than tested inline, so adding a local action cannot leave
 * this behind — a game key that answers `false` here is routed to the engine,
 * which does not have it, and the binding silently does nothing.
 */
const LOCAL_ACTIONS = new Set<string>(["reset", "skip", "settings", "undo", "redo"]);

export function isLocalAction(action: BindableAction): action is LocalAction {
  return LOCAL_ACTIONS.has(action);
}

export function isGameKey(action: BindableAction): action is GameKey {
  return ACTIONS.has(action) && !isLocalAction(action);
}

/**
 * Replaces one action's bindings with `code`, taking that key away from any
 * other action so one key never fires two things at once.
 *
 * The action that loses it may be left with nothing, which the settings sheet
 * shows as "unbound" — that is the honest result of assigning its key
 * elsewhere, and it stays that way until the player says otherwise.
 */
export function rebind(binds: Keybinds, action: BindableAction, code: string): Keybinds {
  const next: Record<BindableAction, string[]> = {} as Record<BindableAction, string[]>;
  for (const other of ACTION_ORDER) {
    next[other] = binds[other].filter((existing) => existing !== code);
  }
  next[action] = [code];
  return next;
}
