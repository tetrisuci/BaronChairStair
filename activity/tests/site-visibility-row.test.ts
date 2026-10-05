/**
 * "Hide me on db.tetrisatuci.org": the one setting that is not the player's to
 * see change before the server agrees.
 *
 * Every other toggle on the sheet is optimistic, and can afford to be: a
 * handling flag that failed to save is wrong on one device until the next
 * load. This one decides whether a stranger can read the player's name on a
 * public site. A toggle that showed "on" while the PUT was failing would tell
 * the player they were hidden when they were not, and nothing would ever say
 * otherwise. So these pin the row's whole contract: it shows nothing it has
 * not been told, a click disables it until the server answers, it repaints only
 * from that answer, and each failure says so in words.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { SITE_ORIGIN } from "../shared/site";
import type { SiteVisibility } from "../client/src/api";
import { createSiteVisibilityRow, type SiteVisibilityRowOptions } from "../client/src/ui/site-visibility-row";

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

const SHOWN: SiteVisibility = { hidden: false, playerKey: "k7m2p9qrst", hasFinishedDay: true, serverKey: null };
const HIDDEN: SiteVisibility = { hidden: true, playerKey: null, hasFinishedDay: true, serverKey: null };

/** A promise the test settles by hand, to stand in for a round trip still on the wire. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every settled promise run its `then`. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function make(over: Partial<SiteVisibilityRowOptions> = {}) {
  const saves: boolean[] = [];
  const changes: SiteVisibility[] = [];
  const opened: string[] = [];
  const row = createSiteVisibilityRow({
    guest: false,
    load: async () => SHOWN,
    save: async (hidden) => (saves.push(hidden), hidden ? HIDDEN : SHOWN),
    open: (url) => opened.push(url),
    onChange: (v) => changes.push(v),
    ...over,
  });
  const toggle = row.element.querySelector<HTMLButtonElement>(".spec__toggle")!;
  const status = () => row.element.querySelector(".site-visibility__status")?.textContent ?? "";
  return { row, toggle, status, saves, changes, opened };
}

describe("loading", () => {
  test("shows … and stays disabled until the GET answers", async () => {
    const answer = deferred<SiteVisibility>();
    const { row, toggle } = make({ load: () => answer.promise });

    row.refresh();
    expect(toggle.textContent).toBe("…");
    expect(toggle.disabled).toBe(true);

    answer.resolve(HIDDEN);
    await flush();
    expect(toggle.textContent).toBe("on");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.disabled).toBe(false);
  });

  test("a failed load says so, and Retry asks again", async () => {
    let calls = 0;
    const { row, toggle, status } = make({
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        return SHOWN;
      },
    });
    const quiet = console.error;
    console.error = () => {};
    try {
      row.refresh();
      await flush();
    } finally {
      console.error = quiet;
    }
    expect(status()).toBe("Couldn't load this setting.");
    expect(toggle.disabled).toBe(true);

    const retry = row.element.querySelector<HTMLButtonElement>(".site-visibility__retry")!;
    retry.click();
    await flush();
    expect(calls).toBe(2);
    expect(toggle.textContent).toBe("off");
    expect(toggle.disabled).toBe(false);
    expect(status()).toBe("");
    expect(row.element.querySelector(".site-visibility__retry")).toBeNull();
  });

  test("an answer that arrives after a newer refresh is dropped", async () => {
    const older = deferred<SiteVisibility>();
    const newer = deferred<SiteVisibility>();
    const queue = [older, newer];
    const { row, toggle } = make({ load: () => queue.shift()!.promise });

    row.refresh();
    row.refresh();
    newer.resolve(HIDDEN);
    await flush();
    older.resolve(SHOWN);
    await flush();
    expect(toggle.textContent).toBe("on");
  });
});

describe("saving", () => {
  test("a click is not optimistic: disabled until the PUT answers, then painted from it", async () => {
    const answer = deferred<SiteVisibility>();
    const { row, toggle, saves, changes } = make({
      save: (hidden) => (saves.push(hidden), answer.promise),
    });
    row.refresh();
    await flush();

    toggle.click();
    expect(saves).toEqual([true]);
    expect(toggle.disabled).toBe(true);
    expect(toggle.textContent).toBe("off");

    answer.resolve(HIDDEN);
    await flush();
    expect(toggle.textContent).toBe("on");
    expect(toggle.disabled).toBe(false);
    expect(changes.at(-1)).toEqual(HIDDEN);
  });

  test("the server's answer wins over what was asked for", async () => {
    const { row, toggle } = make({ save: async () => SHOWN });
    row.refresh();
    await flush();

    toggle.click();
    await flush();
    expect(toggle.textContent).toBe("off");
  });

  test("a failed save says so and leaves the last known state", async () => {
    const { row, toggle, status } = make({ save: () => Promise.reject(new Error("500")) });
    row.refresh();
    await flush();

    const quiet = console.error;
    console.error = () => {};
    try {
      toggle.click();
      await flush();
    } finally {
      console.error = quiet;
    }
    expect(status()).toBe("Couldn't save — try again.");
    expect(toggle.textContent).toBe("off");
    expect(toggle.disabled).toBe(false);
  });

  test("an answer without a boolean is a failed save, not a state", async () => {
    const { row, toggle, status } = make({
      save: async () => ({ ok: true }) as unknown as SiteVisibility,
    });
    row.refresh();
    await flush();

    const quiet = console.error;
    console.error = () => {};
    try {
      toggle.click();
      await flush();
    } finally {
      console.error = quiet;
    }
    expect(status()).toBe("Couldn't save — try again.");
    expect(toggle.textContent).toBe("off");
  });
});

describe("guests and the rest of the row", () => {
  test("a guest sees the toggle disabled with a reason, and nothing is fetched", async () => {
    let loads = 0;
    const { row, toggle, status, saves } = make({
      guest: true,
      load: async () => (loads++, SHOWN),
    });

    row.refresh();
    await flush();
    toggle.click();
    await flush();

    expect(toggle.disabled).toBe(true);
    expect(status()).toBe("Sign in through Discord to choose.");
    expect(loads).toBe(0);
    expect(saves).toEqual([]);
  });

  test("labels the toggle and links to what the site shows", () => {
    const { row, opened } = make();
    expect(row.element.textContent).toContain("On the web");
    expect(row.element.textContent).toContain("Hide me on db.tetrisatuci.org");

    const link = row.element.querySelector<HTMLAnchorElement>("a.site-link")!;
    expect(link.textContent).toBe("What the site shows");
    link.click();
    expect(opened).toEqual([`${SITE_ORIGIN}/`]);
  });
});
