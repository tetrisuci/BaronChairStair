/**
 * The individual controls on the settings sheet.
 *
 * Split out from the sheet itself because they are the bulk of it and share
 * nothing but a small context object: a way to read the current value and a way
 * to write a new one.
 */

import { HANDLING_RANGES, type Handling, SDF_INSTANT } from "@shared/tetris/handling";
import { ACTION_LABELS, type BindableAction, type Keybinds, keyName } from "@shared/keybinds";
import { el } from "./dom";

export interface HandlingContext {
  readonly current: () => Handling;
  readonly change: (patch: Partial<Handling>) => void;
}

export interface KeybindContext {
  readonly current: () => Keybinds;
  /** Resolves with the next key the player presses. */
  readonly capture: () => Promise<string>;
  readonly assign: (action: BindableAction, code: string) => void;
}

const HANDLING_NOTES: Readonly<Record<keyof typeof HANDLING_RANGES, string>> = {
  das: "How long you hold a direction before it starts repeating.",
  arr: "Time between repeats once it starts. 0 slides to the wall instantly.",
  dcd: "DAS charge lost when a piece spawns or rotates.",
  sdf: "Soft drop speed, as a multiple of gravity. 41 drops the piece instantly.",
};

function describe(key: keyof typeof HANDLING_RANGES, value: number): string {
  if (key === "sdf") return value >= SDF_INSTANT ? "instant" : `×${value}`;
  return `${value}${HANDLING_RANGES[key].unit}`;
}

function row(head: HTMLElement, ...rest: (Node | null)[]): HTMLElement {
  return el("div", { class: "spec__row" }, head, ...rest);
}

function inlineRow(head: HTMLElement, note?: string): HTMLElement {
  return el(
    "div",
    { class: "spec__row spec__row--inline" },
    head,
    note ? el("p", { class: "spec__note", text: note }) : null,
  );
}

function rowHead(label: string, control: HTMLElement): HTMLElement {
  return el(
    "div",
    { class: "spec__rowhead" },
    el("span", { class: "spec__key", text: label }),
    control,
  );
}

export function sliderRow(key: keyof typeof HANDLING_RANGES, ctx: HandlingContext): HTMLElement {
  const range = HANDLING_RANGES[key];
  const readout = el("span", { class: "spec__value", text: describe(key, ctx.current()[key]) });
  const slider = el("input", {
    class: "spec__slider",
    attrs: {
      type: "range",
      min: range.min,
      max: range.max,
      step: range.step,
      value: ctx.current()[key],
      "aria-label": key.toUpperCase(),
    },
    on: {
      input: (event) => {
        const value = Number((event.target as HTMLInputElement).value);
        readout.textContent = describe(key, value);
        ctx.change({ [key]: value });
      },
    },
  });
  return row(
    rowHead(key.toUpperCase(), readout),
    slider,
    el("p", { class: "spec__note", text: HANDLING_NOTES[key] }),
  );
}

export function toggleRow(
  key: "safelock" | "cancel" | "may20g",
  label: string,
  note: string,
  ctx: HandlingContext,
): HTMLElement {
  const paint = (on: boolean, button: HTMLElement) => {
    button.textContent = on ? "on" : "off";
    button.classList.toggle("spec__toggle--on", on);
    button.setAttribute("aria-pressed", String(on));
  };

  const button = el("button", { class: "spec__toggle" });
  paint(ctx.current()[key], button);
  button.addEventListener("click", () => {
    const next = !ctx.current()[key];
    ctx.change({ [key]: next });
    paint(next, button);
  });
  return inlineRow(rowHead(label, button), note);
}

export function modeRow(
  key: "irs" | "ihs",
  label: string,
  note: string,
  ctx: HandlingContext,
): HTMLElement {
  const select = el("select", { class: "spec__select" });
  for (const mode of ["off", "tap", "hold"] as const) {
    select.append(
      el("option", { text: mode, attrs: { value: mode, selected: ctx.current()[key] === mode } }),
    );
  }
  select.addEventListener("change", () => ctx.change({ [key]: select.value as "off" | "tap" | "hold" }));
  return inlineRow(rowHead(label, select), note);
}

export function keybindRow(
  action: BindableAction,
  ctx: KeybindContext,
  onRebound: () => void,
): HTMLElement {
  const codes = ctx.current()[action];
  const button = el("button", {
    class: "spec__bind",
    text: codes.length > 0 ? codes.map(keyName).join("  ·  ") : "unbound",
  });
  button.addEventListener("click", async () => {
    button.textContent = "press a key";
    button.classList.add("spec__bind--listening");
    ctx.assign(action, await ctx.capture());
    onRebound();
  });
  return inlineRow(rowHead(ACTION_LABELS[action], button));
}
