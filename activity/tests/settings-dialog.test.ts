/**
 * The settings sheet and the one row on it that is not a setting.
 *
 * "Hide me on db.tetrisatuci.org" sits on the sheet because that is where a
 * player looks for it, but it is stored on the server, beside the player, and
 * deliberately not in `Settings`. Reset replaces every setting with its
 * default, and the default for this one would be "shown": a player who reset
 * their handling would have put their name back on a public site without being
 * asked. These pin that Reset cannot reach it, and that the row asks the server
 * once per opening rather than on every redraw Reset causes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { sanitizeHandling } from "../shared/tetris/handling";
import { DEFAULT_KEYBINDS } from "../shared/keybinds";
import type { InputRouter } from "../client/src/game/input";
import type { SiteVisibility } from "../client/src/api";
import { createSettingsDialog } from "../client/src/ui/settings-dialog";
import { createSiteVisibilityRow } from "../client/src/ui/site-visibility-row";

let window: Window;
const saved = { document: globalThis.document };

beforeAll(() => {
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
});

afterAll(async () => {
  globalThis.document = saved.document;
  await window.happyDOM.close();
});

const HIDDEN: SiteVisibility = { hidden: true, playerKey: null, hasFinishedDay: true, serverKey: null };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The three things the sheet asks of the input router, and nothing else. */
const INPUT = {
  captureKey: () => new Promise<string>(() => {}),
  cancelCapture: () => {},
  setGameInputEnabled: () => {},
} as unknown as InputRouter;

function sheet() {
  const saves: boolean[] = [];
  let loads = 0;
  const web = createSiteVisibilityRow({
    guest: false,
    load: async () => (loads++, HIDDEN),
    save: async (hidden) => (saves.push(hidden), HIDDEN),
    open: () => {},
  });
  const handling = sanitizeHandling({});
  const keybinds = DEFAULT_KEYBINDS;
  let resets = 0;
  const dialog = createSettingsDialog({
    input: INPUT,
    onChange: () => {},
    onClose: () => {},
    // What app.ts does: put the defaults back, and reopen the sheet on them.
    onReset: () => {
      resets += 1;
      dialog.open(sanitizeHandling({}), keybinds);
    },
    web,
  });
  return { dialog, handling, keybinds, saves, loads: () => loads, resets: () => resets };
}

function button(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`no button reading ${text}`);
  return found;
}

describe("the On the web section", () => {
  test("sits above the sheet's foot", () => {
    const { dialog } = sheet();
    const web = dialog.element.querySelector(".site-visibility")!;
    const foot = dialog.element.querySelector(".spec__foot")!;
    expect(web).not.toBeNull();
    expect(web.compareDocumentPosition(foot) & 4).toBe(4); // foot follows web
  });

  test("Reset never calls setSiteHidden, and the row keeps the server's answer", async () => {
    const { dialog, handling, keybinds, saves, resets } = sheet();
    dialog.open(handling, keybinds);
    await flush();
    const toggle = dialog.element.querySelector<HTMLButtonElement>(".site-visibility .spec__toggle")!;
    expect(toggle.textContent).toBe("on");

    button(dialog.element, "Reset").click();
    await flush();

    expect(resets()).toBe(1);
    expect(saves).toEqual([]);
    expect(toggle.textContent).toBe("on");
  });

  test("asks the server once per opening, not on the reopen Reset causes", async () => {
    const { dialog, handling, keybinds, loads } = sheet();
    dialog.open(handling, keybinds);
    await flush();
    button(dialog.element, "Reset").click();
    await flush();
    expect(loads()).toBe(1);

    dialog.close();
    dialog.open(handling, keybinds);
    await flush();
    expect(loads()).toBe(2);
  });

  test("a sheet built without the row still opens", () => {
    const dialog = createSettingsDialog({
      input: INPUT,
      onChange: () => {},
      onClose: () => {},
      onReset: () => {},
    });
    dialog.open(sanitizeHandling({}), DEFAULT_KEYBINDS);
    expect(dialog.element.querySelector(".site-visibility")).toBeNull();
  });
});
