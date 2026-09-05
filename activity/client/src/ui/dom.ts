/**
 * A very small DOM helper.
 *
 * The interface is a few dozen elements that change rarely, so a framework
 * would cost more than it saves. This is enough to build them declaratively and
 * keep the rest of the UI code readable.
 */

type Child = Node | string | number | null | undefined | false;

interface ElementOptions {
  readonly class?: string;
  readonly text?: string | number;
  readonly title?: string;
  readonly attrs?: Readonly<Record<string, string | number | boolean | null>>;
  readonly on?: Readonly<Record<string, EventListener>>;
  readonly style?: Partial<CSSStyleDeclaration>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.title) node.title = options.title;

  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === null || value === false) node.removeAttribute(name);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const [type, listener] of Object.entries(options.on ?? {})) {
    node.addEventListener(type, listener);
  }
  Object.assign(node.style, options.style ?? {});

  append(node, children);
  return node;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/** A cream card with a heavy caption — the interface's one container. */
export function panel(caption: string, options: { class?: string } = {}, ...children: Child[]) {
  return el(
    "section",
    { class: ["panel", options.class].filter(Boolean).join(" ") },
    el("h2", { class: "panel__caption", text: caption }),
    ...children,
  );
}

/**
 * Puts the model's own text back into a field once the caret has left it.
 *
 * A redraw cannot: it refuses to write into the focused field, which is the
 * only reason a caret survives typing. So a dropped emoji, a letter a field
 * does not take, or a number that was clamped stays visible while the model
 * carries something else — right up until something ships the difference. On
 * blur there is no caret to protect, and what is on screen becomes the truth.
 */
export function writeBackOnBlur(field: HTMLInputElement, read: () => string): void {
  field.addEventListener("blur", () => {
    field.value = read();
  });
}

export function stat(key: string, value: string | number): HTMLElement {
  return el(
    "div",
    { class: "stat" },
    el("span", { class: "stat__key", text: key }),
    el("span", { class: "stat__value", text: value }),
  );
}

/**
 * `mm:ss.d`, the format every Tetris player already reads without thinking.
 *
 * Rounded to tenths *before* the minutes are split off: rounding afterwards
 * turns 59.96s into "0:60.0", which is both wrong and unmistakably a bug to
 * anyone who sees it.
 */
export function formatDuration(ms: number): string {
  const tenths = Math.round(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths - minutes * 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

/**
 * Puts an on/off button's state into its label.
 *
 * It used to be carried by colour alone — green for on, plain for off — which
 * only reads if you already know the rule, and does not read at all if you
 * cannot tell the two apart. The word is the state; `aria-pressed` says the
 * same thing to a screen reader, and the two cannot drift because they are
 * written here together.
 */
export function setToggleLabel(button: HTMLButtonElement, label: string, on: boolean): void {
  button.textContent = `${label} ${on ? "ON" : "OFF"}`;
  button.setAttribute("aria-pressed", String(on));
}
