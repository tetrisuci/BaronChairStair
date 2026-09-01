/**
 * The settings sheet: handling and controls.
 *
 * The sheet itself is only layout and lifecycle; the controls live in
 * `settings-rows.ts`. Changes are reported as they happen so the values save
 * immediately, and once more on close, because a slider fires continuously
 * while it is dragged and restarting a run on every pixel would be absurd.
 */

import { type Handling, sanitizeHandling } from "@shared/tetris/handling";
import { ACTION_ORDER, type BindableAction, type Keybinds, rebind } from "@shared/keybinds";
import type { InputRouter } from "../game/input";
import { el, replaceChildren } from "./dom";
import {
  type HandlingContext,
  type KeybindContext,
  keybindRow,
  modeRow,
  sliderRow,
  toggleRow,
} from "./settings-rows";

export interface SettingsDialogOptions {
  readonly input: InputRouter;
  readonly onChange: (patch: { handling?: Handling; keybinds?: Keybinds }) => void;
  readonly onReset: () => void;
  /**
   * Fired once when the sheet closes. Sliders emit continuously while dragged,
   * so anything expensive — like restarting the attempt handling now applies
   * to — belongs here rather than in `onChange`.
   */
  readonly onClose: (changed: { handling: boolean }) => void;
}

export interface SettingsDialog {
  readonly element: HTMLElement;
  open(handling: Handling, keybinds: Keybinds): void;
  close(): void;
  readonly isOpen: boolean;
}

/** Ordered as a player tunes them: the two that matter most, then the rest. */
const SLIDERS = ["das", "arr", "sdf", "dcd"] as const;

interface SheetParts {
  readonly handlingBody: HTMLElement;
  readonly bindsBody: HTMLElement;
  readonly onClose: () => void;
  readonly onReset: () => void;
}

function column(title: string, body: HTMLElement): HTMLElement {
  return el(
    "section",
    { class: "spec__col" },
    el("h3", { class: "spec__title", style: { fontSize: "14px" } }, title),
    body,
  );
}

/** The sheet's markup, kept apart from the state it displays. */
function buildSheet(parts: SheetParts): HTMLElement {
  return el(
    "div",
    { class: "spec", attrs: { hidden: true, role: "dialog", "aria-label": "Settings" } },
    el(
      "div",
      { class: "spec__sheet" },
      el(
        "div",
        { class: "spec__head" },
        el("span", { class: "spec__title", text: "Settings" }),
        el("span", { class: "spec__spacer" }),
        el("button", { class: "btn", text: "Close", on: { click: parts.onClose } }),
      ),
      el(
        "div",
        { class: "spec__cols" },
        column("Handling", parts.handlingBody),
        column("Controls", parts.bindsBody),
      ),
      el(
        "div",
        { class: "spec__foot" },
        el("p", { class: "note", text: "Settings follow your Discord account across devices." }),
        el("button", { class: "btn", text: "Reset", on: { click: parts.onReset } }),
      ),
    ),
  );
}

export function createSettingsDialog(options: SettingsDialogOptions): SettingsDialog {
  let handling: Handling = sanitizeHandling({});
  let keybinds: Keybinds = {} as Keybinds;
  let isOpen = false;
  /** Serialised handling as it was when the sheet opened, to detect a change. */
  let openedWith = "";

  const handlingBody = el("div", { class: "spec__rows" });
  const bindsBody = el("div", { class: "spec__rows" });

  const handlingCtx: HandlingContext = {
    current: () => handling,
    change: (patch) => {
      handling = sanitizeHandling({ ...handling, ...patch });
      options.onChange({ handling });
    },
  };

  const keybindCtx: KeybindContext = {
    current: () => keybinds,
    capture: () => options.input.captureKey(),
    assign: (action: BindableAction, code: string) => {
      keybinds = rebind(keybinds, action, code);
      options.onChange({ keybinds });
    },
  };

  function renderHandling(): void {
    replaceChildren(
      handlingBody,
      ...SLIDERS.map((key) => sliderRow(key, handlingCtx)),
      toggleRow("safelock", "Safe lock", "Stops a dropped piece locking the instant it lands.", handlingCtx),
      toggleRow("cancel", "DAS cancel", "Releasing one direction recharges DAS the other way.", handlingCtx),
      toggleRow("may20g", "20G movement", "Allows sliding along the floor at full speed.", handlingCtx),
      modeRow("irs", "Initial rotation", "Applies a rotation held through the spawn.", handlingCtx),
      modeRow("ihs", "Initial hold", "Applies a hold held through the spawn.", handlingCtx),
    );
  }

  function renderBinds(): void {
    replaceChildren(
      bindsBody,
      ...ACTION_ORDER.map((action) => keybindRow(action, keybindCtx, renderBinds)),
    );
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    options.input.cancelCapture();
    options.input.setGameInputEnabled(true);
    element.hidden = true;
    options.onClose({ handling: JSON.stringify(handling) !== openedWith });
  }

  const element = buildSheet({
    handlingBody,
    bindsBody,
    onClose: close,
    onReset: () => options.onReset(),
  });

  return {
    element,
    get isOpen() {
      return isOpen;
    },
    open(nextHandling, nextKeybinds) {
      handling = nextHandling;
      keybinds = nextKeybinds;
      // Only the first open stamps the baseline. Reset re-opens the sheet, and
      // re-stamping there would compare the defaults against themselves and
      // report no change — leaving the attempt running under the old handling
      // while the sheet claims otherwise.
      if (!isOpen) openedWith = JSON.stringify(nextHandling);
      isOpen = true;
      element.hidden = false;
      options.input.setGameInputEnabled(false);
      renderHandling();
      renderBinds();
    },
    close,
  };
}
