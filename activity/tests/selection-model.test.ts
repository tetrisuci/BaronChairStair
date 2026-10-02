/**
 * The selection model, pinned.
 *
 * sheet.css states it once on `.sheet`: nothing on the page selects by
 * default; text meant to be read asks back in with `.selectable` — which,
 * for iOS's long-press menu, also re-arms the inherited
 * `-webkit-touch-callout` the root sets to `none` — form fields opt
 * themselves in; and while a live run is up, the deck's marker silences
 * even the ask-back-ins (a drift across the goal sentence mid-drag must not
 * paint a highlight and eat the move stream). The marker is dropped by
 * every transition that leaves live play: that lifecycle is pinned below
 * against the real App methods, because a stale marker re-greys exactly the
 * reading surfaces the exit that forgot it goes on to mount.
 *
 * Two things can break that model silently. A CSS edit that moves a rule off
 * the root (the pre-inversion bug class: furniture kept highlighting because
 * each surface carried its own opt-out and the next one was missed) — and a
 * sixth child in App.mount(), which would sit outside every rule written so
 * far for exactly the same reason the credits strip once did. The first the
 * cascade below catches; the second the inventory pin catches, by name.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { todaySheet } from "../client/src/ui/home-sheet";
import type { ShareFields } from "../client/src/ui/share";

let window: Window;
const saved = {
  document: globalThis.document,
  getComputedStyle: globalThis.getComputedStyle,
};

// Loaded once the window above exists (a second `beforeAll`): the lifecycle
// tests run App's own transition methods, and app.ts's module graph is the
// real app — it must not load before the document is in place.
let App: (typeof import("../client/src/app"))["App"];

beforeAll(() => {
  // The global swap is the pattern render.test.ts uses: lending happy-dom's
  // document to the test file so every createElement is typed like the app's
  // own, and restored afterwards because `bun test` shares one process.
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window) as unknown as
    typeof getComputedStyle;
  // The app's sheets, in the order the front door loads them (render.test.ts
  // documents why order matters; only sheet.css carries selection rules, but
  // the cascade these tests read should be the cascade that ships).
  for (const sheet of [
    "client/src/styles/panels.css",
    "client/src/styles/home.css",
    "client/src/styles/overlays.css",
    "client/src/styles/sheet.css",
  ]) {
    const style = document.createElement("style");
    style.textContent = readFileSync(sheet, "utf8");
    document.head.append(style);
  }
});

afterEach(() => {
  document.body.replaceChildren();
});

beforeAll(async () => {
  App = (await import("../client/src/app")).App;
});

afterAll(async () => {
  globalThis.document = saved.document;
  globalThis.getComputedStyle = saved.getComputedStyle;
  // happy-dom holds timers, observers and the whole tree until it is told to
  // stop; without this the process has no reason to exit.
  await window.happyDOM.close();
});

/** The probes the assertions read, one per region of the model. */
interface Page {
  mastheadMark: HTMLElement;
  liveGoal: HTMLElement;
  calmGoal: HTMLElement;
  plain: HTMLElement;
  walkthrough: HTMLElement;
  deckInput: HTMLInputElement;
  creditsTitle: HTMLElement;
  spec: HTMLElement;
  specInput: HTMLInputElement;
  toast: HTMLElement;
  bareInput: HTMLInputElement;
}

/** Mounts the page's five children with one probe inside each region. */
function mountPage(): Page {
  const doc = document;
  const make = (tag: string, cls: string, text = ""): HTMLElement => {
    const node = doc.createElement(tag);
    node.className = cls;
    if (text) node.textContent = text;
    return node;
  };

  const mastheadMark = make("span", "masthead__mark", "Puzzle");
  const liveGoal = make("p", "goal__text selectable", "Clear a Quad");
  const calmGoal = make("p", "goal__text selectable", "Clear a Quad");
  const plain = make("p", "hud__note", "progress note");
  const walkthrough = make("div", "solutions selectable", "how it was solved");
  const deckInput = doc.createElement("input");
  const creditsTitle = make("span", "credits__title", "cave diver 2");
  const spec = make("div", "spec selectable");
  const specInput = doc.createElement("input");
  spec.append(specInput);
  const toast = make("div", "toast", "Nothing to undo");

  const liveDeck = make("div", "deck deck--play deck--gestures");
  liveDeck.append(liveGoal, plain);
  const calmDeck = make("div", "deck deck--screen");
  calmDeck.append(calmGoal, walkthrough, deckInput);

  const sheet = make("div", "sheet");
  sheet.append(
    make("header", "masthead"), // .masthead itself carries the wordmark child
    liveDeck,
    calmDeck,
    make("footer", "credits"),
    spec,
    toast,
  );
  sheet.querySelector(".masthead")!.append(mastheadMark);
  sheet.querySelector(".credits")!.append(creditsTitle);
  doc.body.append(sheet);

  const bareInput = doc.createElement("input");
  doc.body.append(bareInput);

  return {
    mastheadMark,
    liveGoal,
    calmGoal,
    plain,
    walkthrough,
    deckInput,
    creditsTitle,
    spec,
    specInput,
    toast,
    bareInput,
  } as Page;
}

function userSelect(node: HTMLElement): string {
  return getComputedStyle(node).userSelect;
}

/**
 * The declarations of one rule, read from sheet.css's own text.
 *
 * The callout half of the model cannot come from the cascade here:
 * happy-dom's parser drops `-webkit-touch-callout` outright — it never
 * reaches `rule.style.cssText` (probed) — so those assertions pin the
 * source, selector head by selector head. Comments are stripped first:
 * the file's prose names the same selectors it declares.
 */
function ruleBody(selector: string): string {
  const css = readFileSync("client/src/styles/sheet.css", "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const heads = match[1]!.split(",").map((head) => head.trim());
    if (heads.includes(selector)) return match[2]!;
  }
  return "";
}

/**
 * The `user-select` values of every stylesheet rule that matches `node`
 * directly. happy-dom resolves a computed `user-select` only from a direct
 * match — it does not perform the spec's `auto` → parent-used-value
 * resolution a real browser applies — so the furniture probes below assert
 * the thing that matters at the source: no rule names them, and they inherit
 * the sheet's `none` the way the model intends.
 */
function directSelectionRules(node: HTMLElement): string[] {
  const values: string[] = [];
  for (const sheet of document.styleSheets) {
    for (const rule of Array.from((sheet as CSSStyleSheet).cssRules)) {
      // Duck-typed rather than `instanceof CSSStyleRule`: happy-dom defines
      // its own rule classes that are not the globals a real window exposes.
      const style = (rule as CSSStyleRule).style;
      const selector = (rule as CSSStyleRule).selectorText;
      if (!style || typeof selector !== "string") continue;
      try {
        if (node.matches(selector) && style.getPropertyValue("user-select")) {
          values.push(style.getPropertyValue("user-select"));
        }
      } catch {
        // A selector happy-dom cannot parse is not a selection rule.
      }
    }
  }
  return values;
}

describe("the sheet-level selection model", () => {
  test("the sheet opts everything out at the root", () => {
    const page = mountPage();
    const sheet = page.mastheadMark.closest(".sheet")! as HTMLElement;
    expect(userSelect(sheet)).toBe("none");
  });

  test("no per-element rule names the furniture — they inherit the root's none", () => {
    // The pre-inversion bug class: each surface carried its own opt-out and
    // the next piece of furniture was missed. If any rule starts naming the
    // masthead, the credits strip or the toast again, this names it first.
    const page = mountPage();
    expect(directSelectionRules(page.mastheadMark)).toEqual([]);
    expect(directSelectionRules(page.creditsTitle)).toEqual([]);
    expect(directSelectionRules(page.toast)).toEqual([]);
    expect(directSelectionRules(page.plain)).toEqual([]);
  });

  test("reading surfaces ask back in with .selectable", () => {
    const page = mountPage();
    expect(userSelect(page.calmGoal)).toBe("text");
    expect(userSelect(page.walkthrough)).toBe("text");
    expect(userSelect(page.spec)).toBe("text");
  });

  test("a live run silences even the ask-back-ins on the deck", () => {
    const page = mountPage();
    expect(userSelect(page.liveGoal)).toBe("none");
  });

  test("form fields keep their text wherever they sit", () => {
    const page = mountPage();
    expect(userSelect(page.deckInput)).toBe("text");
    expect(userSelect(page.specInput)).toBe("text");
    expect(userSelect(page.bareInput)).toBe("text");
  });

  test("every ask-back re-arms the iOS long-press callout the root sets to none", () => {
    // `-webkit-touch-callout` inherits (MDN: "Inherited: yes"), so the
    // sheet's `none` swallows the callout on every descendant whatever
    // `user-select` says — the release note's "read and copied" is untrue
    // on iOS unless each ask-back names the property itself. Pinned in
    // sheet.css's text (ruleBody) rather than the cascade: happy-dom drops
    // the vendor property before it reaches any rule's style object.
    expect(ruleBody(".sheet")).toContain("-webkit-touch-callout: none");
    expect(ruleBody(".selectable")).toContain("-webkit-touch-callout: default");
    expect(ruleBody("input")).toContain("-webkit-touch-callout: default");
    // And the live marker takes it away again on the deck, as it takes
    // `user-select` — the suppression is callout-clean too.
    expect(ruleBody(".deck--gestures .selectable")).toContain("-webkit-touch-callout: none");
  });

  test("the real hero sheet ships its goal sentence as selectable", () => {
    // The contract says the goal sentence selects, and the hand-built probe
    // above cannot miss the class — the hero used to ship without it. This
    // renders the actual card todaySheet() builds and mounts it the way the
    // front door does: on the deck, under the sheet root, no live marker.
    const card = todaySheet(
      {
        tier: "easy",
        puzzle: {
          id: 2,
          title: "sheet 2",
          author: "satilea",
          difficulty: 1,
          goal: "Clear 1 TSD",
          set: null,
          board: ["TTTT......", "..OO......"],
          queue: ["T", "O", "S", "Z"],
          hold: null,
          targetAttack: 4,
        },
        run: null,
        solution: null,
      } as never, // the fixture shape render.test.ts casts the same way
      { hero: true, started: new Set(), onPick: () => {} },
    );
    const goal = card.querySelector(".goal__text")!;
    expect(goal.classList.contains("selectable")).toBe(true);

    const root = document.createElement("div");
    root.className = "sheet";
    const deck = document.createElement("div");
    deck.className = "deck deck--screen";
    root.append(deck);
    deck.append(card);
    document.body.append(root);
    expect(userSelect(goal as HTMLElement)).toBe("text");
  });

  test("App.mount() mounts exactly the children the model was written for", () => {
    // The sheet-level rule covers the page by covering its children; a sixth
    // child would sit outside every decision made here. This names the set
    // the model relies on so adding to it is a conscious act, not a miss the
    // way the credits strip once was.
    const source = readFileSync("client/src/app.ts", "utf8");
    const mountCall = source.match(/replaceChildren\(\s*this\.root,([\s\S]*?)\)\s*;/);
    expect(mountCall).not.toBeNull();
    const mountBody = mountCall![1];
    expect(mountBody).toBeTruthy();
    const children = [...(mountBody as string).matchAll(/this\.(\w+)(?:\.element)?/g)].map(
      (match) => match[1],
    );
    expect(children).toEqual([
      "masthead",
      "deck",
      "credits",
      "settingsDialog",
      "toastNode",
    ]);
  });
});

/**
 * The marker's lifecycle: raised with the playfield, dropped by every
 * transition that leaves live play.
 *
 * `showColumns` drops it for column mounts, but a settled verdict and a
 * screen mount without going through it — so those exits must drop it
 * themselves, or the goal and walkthrough they go on to mount sit inert
 * under `.deck--gestures .selectable`.
 *
 * The real methods run, against faked fields: App's constructor builds the
 * whole sheet while these transitions touch a handful of it, and taking the
 * prototype skips the constructor entirely.
 */
describe("the gesture marker's lifecycle", () => {
  /** The slice of App these transitions touch; everything else faked. */
  interface LifecycleApp {
    deck: HTMLElement;
    stage: HTMLElement;
    credits: { update: (entry: unknown) => void };
    hud: {
      left: HTMLElement;
      right: HTMLElement;
      showFinal: (attack: number, target: number, clears: readonly unknown[]) => void;
    };
    leaderboard: { element: HTMLElement };
    verdict: { update: (fields: unknown, run: unknown, options: unknown) => void };
    sheet: unknown;
    cleared: Set<number>;
    relayout: () => void;
    showScreen: (
      options: { wide?: boolean; full?: boolean; fill?: boolean },
      ...cards: HTMLElement[]
    ) => void;
    presentVerdict: (fields: ShareFields, run: unknown) => void;
    showPlayfield: (options?: { live?: boolean }) => void;
  }

  const FIELDS: ShareFields = {
    day: 247,
    puzzleId: 2,
    solved: false,
    attack: 1,
    targetAttack: 4,
    durationMs: 60_000,
    resets: 0,
    piecesPlaced: 12,
    clears: [],
  };

  function lifecycleApp(): LifecycleApp {
    const app = Object.create(App.prototype) as unknown as LifecycleApp;
    app.deck = document.createElement("div");
    app.stage = document.createElement("div");
    app.credits = { update: () => {} };
    app.hud = {
      left: document.createElement("div"),
      right: document.createElement("div"),
      showFinal: () => {},
    };
    app.leaderboard = { element: document.createElement("div") };
    app.verdict = { update: () => {} };
    app.sheet = null;
    app.cleared = new Set<number>();
    app.relayout = () => {};
    return app;
  }

  test("the playfield raises the marker only while the run is live", () => {
    const app = lifecycleApp();
    app.showPlayfield();
    expect(app.deck.classList.contains("deck--gestures")).toBe(true);
    app.showPlayfield({ live: false });
    expect(app.deck.classList.contains("deck--gestures")).toBe(false);
  });

  test("a settled verdict drops the marker with deck--play", () => {
    const app = lifecycleApp();
    app.deck.classList.add("deck--play", "deck--gestures");
    app.presentVerdict(FIELDS, null);
    expect(app.deck.classList.contains("deck--gestures")).toBe(false);
    expect(app.deck.classList.contains("deck--play")).toBe(false);
  });

  test("a screen drops the marker — Home after a run reads normally", () => {
    const app = lifecycleApp();
    app.deck.classList.add("deck--play", "deck--gestures");
    app.showScreen({ full: true }, document.createElement("div"));
    expect(app.deck.classList.contains("deck--gestures")).toBe(false);
    expect(app.deck.classList.contains("deck--screen")).toBe(true);
  });
});
