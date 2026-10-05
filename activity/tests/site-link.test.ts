/**
 * The game's "see more on db.tetrisatuci.org" links: where each one points,
 * when it is drawn at all, and how it is opened.
 *
 * Every one of these can be wrong without anything throwing. A link to
 * `/player/<key>` for a player the site will not build is a 404 the game handed
 * them itself; a link that carries a server key the site does not know quietly
 * shows them every server instead of their own; and an `<a href>` that the
 * Discord webview is left to follow on its own simply does nothing, because an
 * activity's iframe may not navigate away or open a window. So the paths are
 * pinned here, and so is the one way out of the iframe that works:
 * `commands.openExternalLink`, which asks Discord to show its own "you are
 * leaving" prompt and open the browser.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { COMMUNITY_ID_BASE } from "../shared/puzzle";
import { SITE_ORIGIN } from "../shared/site";
import type { SiteVisibility } from "../client/src/api";
import {
  externalLinkOpener,
  leaderboardsPath,
  profilePath,
  puzzleLinesPath,
  siteLink,
} from "../client/src/ui/site-link";
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

/** A key of the site's own shape. Synthetic: no player anywhere has it. */
const PLAYER_KEY = "k7m2p9qrst";
const SERVER_KEY = "zz22xx33yy";

function visibility(over: Partial<SiteVisibility> = {}): SiteVisibility {
  return { hidden: false, playerKey: PLAYER_KEY, hasFinishedDay: true, serverKey: SERVER_KEY, ...over };
}

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

describe("where each link points", () => {
  test("the leaderboards link carries ?server= only with a key of the site's shape", () => {
    expect(leaderboardsPath(SERVER_KEY)).toBe(`/leaderboards?server=${SERVER_KEY}`);
    expect(leaderboardsPath(null)).toBe("/leaderboards");
    // Anything else is not a key the site could know, so it is not sent.
    expect(leaderboardsPath("123456789012345678")).toBe("/leaderboards");
    expect(leaderboardsPath("../evil")).toBe("/leaderboards");
  });

  test("the profile link targets the player's page once they have a finished day", () => {
    expect(profilePath(visibility())).toBe(`/player/${PLAYER_KEY}`);
  });

  test("the profile link targets /players before the player has a finished day", () => {
    expect(profilePath(visibility({ hasFinishedDay: false }))).toBe("/players");
  });

  test("there is no profile link when the site would not show the player", () => {
    expect(profilePath(visibility({ hidden: true, playerKey: null }))).toBeNull();
    expect(profilePath(visibility({ playerKey: null }))).toBeNull();
    expect(profilePath(visibility({ playerKey: "not a key" }))).toBeNull();
    expect(profilePath(null)).toBeNull();
  });

  test("a puzzle's lines link exists for club puzzles and never for a community one", () => {
    expect(puzzleLinesPath(42)).toBe("/puzzle/42#lines");
    expect(puzzleLinesPath(COMMUNITY_ID_BASE - 1)).toBe(`/puzzle/${COMMUNITY_ID_BASE - 1}#lines`);
    expect(puzzleLinesPath(COMMUNITY_ID_BASE)).toBeNull();
    expect(puzzleLinesPath(COMMUNITY_ID_BASE + 7)).toBeNull();
    expect(puzzleLinesPath(0)).toBeNull();
    expect(puzzleLinesPath(-1)).toBeNull();
    expect(puzzleLinesPath(1.5)).toBeNull();
  });
});

describe("the links on the game's own screens", () => {
  test("the leaderboards header links to the site, and follows the server key", () => {
    const opened: string[] = [];
    const boards = createLeaderboards({ onPlayer: () => {}, openSite: (url) => opened.push(url) });

    expect(siteHrefs(boards.element)).toEqual([`${SITE_ORIGIN}/leaderboards`]);
    boards.setServerKey(SERVER_KEY);
    expect(siteHrefs(boards.element)).toEqual([`${SITE_ORIGIN}/leaderboards?server=${SERVER_KEY}`]);
    boards.element.querySelector<HTMLAnchorElement>("a.site-link")!.click();
    expect(opened).toEqual([`${SITE_ORIGIN}/leaderboards?server=${SERVER_KEY}`]);
    expect(boards.element.querySelector("a.site-link")!.textContent).toBe("See more on db.tetrisatuci.org");
  });

  test("the leaderboards draw no link when nobody gave them a way to open one", () => {
    const boards = createLeaderboards({ onPlayer: () => {} });
    expect(siteHrefs(boards.element)).toEqual([]);
  });

  test("your own profile links to your page, whichever arrives first", () => {
    const first = createProfile({ openSite: () => {} });
    first.update(stats(true));
    first.setSiteVisibility(visibility());
    expect(siteHrefs(first.element)).toEqual([`${SITE_ORIGIN}/player/${PLAYER_KEY}`]);

    const second = createProfile({ openSite: () => {} });
    second.setSiteVisibility(visibility({ hasFinishedDay: false }));
    second.update(stats(true));
    expect(siteHrefs(second.element)).toEqual([`${SITE_ORIGIN}/players`]);
    expect(second.element.querySelector("a.site-link")!.textContent).toBe("Your page on db.tetrisatuci.org");
  });

  test("the profile link is absent when hidden, and on somebody else's profile", () => {
    const hidden = createProfile({ openSite: () => {} });
    hidden.update(stats(true));
    hidden.setSiteVisibility(visibility({ hidden: true, playerKey: null }));
    expect(siteHrefs(hidden.element)).toEqual([]);

    const theirs = createProfile({ openSite: () => {} });
    theirs.setSiteVisibility(visibility());
    theirs.update(stats(false));
    expect(siteHrefs(theirs.element)).toEqual([]);
  });

  test("a profile being fetched drops the previous subject's link", () => {
    const made = createProfile({ openSite: () => {} });
    made.setSiteVisibility(visibility());
    made.update(stats(true));
    made.loading();
    expect(siteHrefs(made.element)).toEqual([]);
  });

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

  test("the solutions panel links to the puzzle's lines on the site", () => {
    const panel = createSolutionsPanel(Date.now, () => {});
    panel.show([LINE], "synthetic-1", () => {}, 42);
    expect(siteHrefs(panel.element)).toEqual([`${SITE_ORIGIN}/puzzle/42#lines`]);
    expect(panel.element.querySelector("a.site-link")!.textContent).toBe("Every line on db.tetrisatuci.org");
  });

  test("the solutions panel has no link for a community puzzle, or without an id", () => {
    const panel = createSolutionsPanel(Date.now, () => {});
    panel.show([LINE], "synthetic-1", () => {}, COMMUNITY_ID_BASE + 3);
    expect(siteHrefs(panel.element)).toEqual([]);
    panel.show([LINE], "synthetic-1", () => {});
    expect(siteHrefs(panel.element)).toEqual([]);
  });

  test("the reading view drops the link, which belonged to the last gallery shown", () => {
    const panel = createSolutionsPanel(Date.now, () => {});
    panel.show([LINE], "synthetic-1", () => {}, 42);
    panel.readingOnly();
    expect(siteHrefs(panel.element)).toEqual([]);
  });
});
