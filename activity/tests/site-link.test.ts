/**
 * The way the game opens db.tetrisatuci.org, and where it does not.
 *
 * One screen links out: the settings row that hides a player on the site. The
 * game's own leaderboards, profile and solutions do not. Players asked to keep
 * browsing those in the activity, so the links that sent them to the site
 * were taken off again. The last block pins that.
 *
 * The opener can be wrong without anything throwing: an `<a href>` that the
 * Discord webview is left to follow on its own simply does nothing, because an
 * activity's iframe may not navigate away or open a window. So the one way out
 * of the iframe that works is pinned here: `commands.openExternalLink`, which
 * asks Discord to show its own "you are leaving" prompt and open the browser.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { SITE_ORIGIN } from "../shared/site";
import { externalLinkOpener, siteLink } from "../client/src/ui/site-link";
import { createLeaderboards } from "../client/src/ui/leaderboards";
import { createProfile, type ProfileStats } from "../client/src/ui/profile";
import { createSolutionsPanel } from "../client/src/ui/solutions";
import type { GalleryLine } from "../client/src/api";

let window: Window;
const saved = { document: globalThis.document };

beforeAll(() => {
  // Scoped to this file, for the reason render.test.ts gives: `bun test` shares
  // one process and the server suite leans on Bun's own fetch/Request.
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
});

afterAll(async () => {
  globalThis.document = saved.document;
  await window.happyDOM.close();
});

function stats(isSelf: boolean): ProfileStats {
  return {
    player: { id: "synthetic-1", username: "Tester", avatarUrl: null },
    isSelf,
    puzzlesCleared: 3,
    clearsTotal: 4,
    bestMsTotal: 60_000,
    rushSolved: 0,
    rushRuns: 0,
    bestRush: 0,
    discoveries: 0,
    archiveSize: 10,
    streak: 1,
    daysSolved: 2,
  };
}

/** Every site link inside `root`, by the URL it would open. */
function siteHrefs(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLAnchorElement>("a.site-link")].map((a) => a.getAttribute("href") ?? "");
}

describe("how a link leaves the activity", () => {
  test("inside Discord it asks the SDK to open the link, and never the window", async () => {
    const asked: string[] = [];
    const opened: string[] = [];
    const open = externalLinkOpener(
      { openExternalLink: async ({ url }) => (asked.push(url), { opened: true }) },
      { open: (url?: string | URL) => (opened.push(String(url)), null) },
    );

    open(`${SITE_ORIGIN}/players`);
    await Promise.resolve();

    expect(asked).toEqual([`${SITE_ORIGIN}/players`]);
    expect(opened).toEqual([]);
  });

  test("outside Discord it opens a new tab with no opener", () => {
    const calls: unknown[][] = [];
    const open = externalLinkOpener(null, { open: (...args: unknown[]) => (calls.push(args), null) });

    open(`${SITE_ORIGIN}/`);

    expect(calls).toEqual([[`${SITE_ORIGIN}/`, "_blank", "noopener"]]);
  });

  test("a refused or failed Discord prompt does not throw into the click", async () => {
    const open = externalLinkOpener(
      { openExternalLink: () => Promise.reject(new Error("closed")) },
      { open: () => null },
    );
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(() => open(`${SITE_ORIGIN}/`)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = quiet;
    }
  });

  test("the link is an anchor whose click is handed to the opener, not followed", () => {
    const opened: string[] = [];
    const link = siteLink("See more", "/leaderboards", (url) => opened.push(url));
    const click = new window.MouseEvent("click", { bubbles: true, cancelable: true });

    link.dispatchEvent(click as unknown as Event);

    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(`${SITE_ORIGIN}/leaderboards`);
    expect(link.textContent).toBe("See more");
    expect(click.defaultPrevented).toBe(true);
    expect(opened).toEqual([`${SITE_ORIGIN}/leaderboards`]);
  });
});

describe("the game's own screens keep players in the game", () => {
  const LINE: GalleryLine = {
    solutionId: 1,
    placements: [],
    attack: 4,
    clears: [],
    source: "reference",
    finder: null,
    foundAt: 0,
    solvedStrict: true,
  };

  test("the leaderboards draw no link to the site", () => {
    const boards = createLeaderboards({ onPlayer: () => {} });
    expect(siteHrefs(boards.element)).toEqual([]);
  });

  test("your own profile draws no link to the site", () => {
    const profile = createProfile();
    profile.update(stats(true));
    expect(siteHrefs(profile.element)).toEqual([]);
    expect(profile.element.textContent).not.toContain("db.tetrisatuci.org");
  });

  test("a puzzle's solutions draw no link to the site", () => {
    const panel = createSolutionsPanel();
    panel.show([LINE], "synthetic-1", () => {});
    expect(siteHrefs(panel.element)).toEqual([]);
    expect(panel.element.textContent).not.toContain("db.tetrisatuci.org");
  });
});
