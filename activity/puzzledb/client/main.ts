/**
 * db.tetrisatuci.org: the club's stylesheets, then the page.
 *
 * The third page built from this repository's client code and the first meant
 * for strangers. Like the review tool it runs in an ordinary browser tab, with
 * no Discord SDK, no session and no `/.proxy` prefix, and borrows from
 * `client/src` only what draws a board and steps an answer.
 *
 * **The stylesheets come first, and in this order.** `skin.ts` reads the
 * palette from the stylesheet at import (as `review/main.ts` relies on), and
 * `site.css` has to come after `tokens.css` to undo the game's `overflow:
 * hidden` on the body — this is a document, and it scrolls. `overlays.css` is
 * loaded for the replay's timeline and transport, `.note` and the selects; it
 * is class-scoped throughout, so it styles nothing it was not asked to.
 */

import "../../client/src/styles/tokens.css";
import "../../client/src/styles/panels.css";
import "../../client/src/styles/overlays.css";
import "./site.css";

import { loadSiteData } from "./api";
import { SitePage } from "./page";

function boot(): void {
  const root = document.getElementById("puzzledb");
  if (!root) throw new Error("Missing #puzzledb mount point");
  // `start` shows the unavailable page itself when the data cannot be had, so
  // anything reaching this catch is a bug in the page, and the console is
  // where it can be read.
  new SitePage(root, () => loadSiteData()).start().catch((error: unknown) => {
    console.error("[puzzledb] the page failed to start:", error);
  });
}

boot();
