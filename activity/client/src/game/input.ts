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
  }

  private readonly heldKeys = new Set<GameKey>();

  private readonly releaseAll = (): void => {
    for (const key of this.heldKeys) this.handlers.onGameKey(key, false);
    this.heldKeys.clear();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.captureResolver) {
      event.preventDefault();
      if (isBindable(event.code)) {
        const resolve = this.captureResolver;
        this.captureResolver = null;
        resolve(event.code);
      }
      return;
    }

    const action = this.lookup.get(event.code);
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
    const action = this.lookup.get(event.code);
    if (!action || !isGameKey(action)) return;
    if (SWALLOWED_CODES.has(event.code)) event.preventDefault();
    if (!this.heldKeys.delete(action)) return;
    this.handlers.onGameKey(action, false);
  };
}
