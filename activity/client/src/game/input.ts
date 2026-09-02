/**
 * Keyboard routing.
 *
 * Reads physical keys, resolves them through the player's bindings, and hands
 * game keys straight to the run. Auto-repeat from the operating system is
 * discarded: DAS and ARR belong to the engine, and letting the OS repeat on top
 * of them is what makes browser Tetris feel wrong.
 */

import type { GameKey } from "@shared/tetris/verify";
import {
  buildLookup,
  chordOf,
  type BindableAction,
  type Keybinds,
  isBindable,
  isGameKey,
  type LocalAction,
} from "@shared/keybinds";

export interface InputHandlers {
  readonly onGameKey: (key: GameKey, down: boolean) => void;
  readonly onLocalAction: (action: LocalAction) => void;
}

/** Keys whose default browser behaviour would fight the game. */
/**
 * Keys that are only ever the front half of a chord. Capturing one on its own
 * would bind an action to "Ctrl", and every chord using it would then fire the
 * wrong thing on the way in.
 */
const MODIFIER_ONLY = new Set([
  "ControlLeft", "ControlRight", "AltLeft", "AltRight",
  "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight",
]);

const SWALLOWED_CODES = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Space",
  "Tab",
]);

export class InputRouter {
  private lookup: ReadonlyMap<string, BindableAction>;
  private enabled = false;
  private captureResolver: ((code: string) => void) | null = null;
  /** A modifier held during capture, not yet known to be a chord. */
  private capturePending: string | null = null;

  constructor(
    keybinds: Keybinds,
    private readonly handlers: InputHandlers,
  ) {
    this.lookup = buildLookup(keybinds);
  }

  setKeybinds(keybinds: Keybinds): void {
    this.lookup = buildLookup(keybinds);
  }

  attach(): void {
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp, { passive: false });
    window.addEventListener("blur", this.releaseAll);
    this.enabled = true;
  }

  detach(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.releaseAll);
    this.enabled = false;
  }

  /** Suspends game input, e.g. while a dialog is open. Local actions still fire. */
  setGameInputEnabled(enabled: boolean): void {
    if (!enabled) this.releaseAll();
    this.enabled = enabled;
  }

  /**
   * Waits for the next key press and resolves with its code, instead of routing
   * it. Used by the rebinding UI.
   */
  captureKey(): Promise<string> {
    this.releaseAll();
    return new Promise((resolve) => {
      this.captureResolver = resolve;
    });
  }

  cancelCapture(): void {
    this.captureResolver = null;
    this.capturePending = null;
  }

  private readonly heldKeys = new Set<GameKey>();

  private readonly releaseAll = (): void => {
    for (const key of this.heldKeys) this.handlers.onGameKey(key, false);
    this.heldKeys.clear();
  };

  /**
   * Whether the keystroke belongs to something the player is typing into.
   *
   * The explorer has a search box and the settings sheet has number fields,
   * and a local action fires even while game input is switched off — so
   * without this, typing "u" into a search box would undo a placement.
   */
  private static isTyping(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    if (!target) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.captureResolver) {
      event.preventDefault();
      // A chord is only finished when a non-modifier arrives: pressing Ctrl on
      // the way to Ctrl+Z must not be captured as the binding by itself.
      // A modifier alone is ambiguous: it could be the binding, or the front
      // half of one. Hold it and see — a key after it makes a chord, letting
      // it go makes it the binding.
      if (MODIFIER_ONLY.has(event.code)) {
        this.capturePending = event.code;
        return;
      }
      this.capturePending = null;
      const chord = chordOf(event);
      if (isBindable(chord)) {
        const resolve = this.captureResolver;
        this.captureResolver = null;
        resolve(chord);
      }
      return;
    }
    if (InputRouter.isTyping(event)) return;

    const action = this.lookup.get(chordOf(event));
    if (!action) return;
    if (SWALLOWED_CODES.has(event.code)) event.preventDefault();
    if (event.repeat) return;

    if (isGameKey(action)) {
      if (!this.enabled) return;
      this.heldKeys.add(action);
      this.handlers.onGameKey(action, true);
    } else {
      this.handlers.onLocalAction(action);
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (this.captureResolver) {
      if (this.capturePending === event.code) {
        // Let go with nothing pressed after it, so they meant the modifier.
        const resolve = this.captureResolver;
        this.captureResolver = null;
        this.capturePending = null;
        if (isBindable(event.code)) resolve(event.code);
      }
      return;
    }
    // Released against the bare key, not the chord: a modifier let go first
    // would otherwise strand the key down forever.
    const action = this.lookup.get(event.code) ?? this.lookup.get(chordOf(event));
    if (!action || !isGameKey(action)) return;
    if (SWALLOWED_CODES.has(event.code)) event.preventDefault();
    if (!this.heldKeys.delete(action)) return;
    this.handlers.onGameKey(action, false);
  };
}
