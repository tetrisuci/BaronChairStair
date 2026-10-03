/**
 * Moving between the site's pages without reloading it.
 *
 * Every page has a real path — `/puzzle/42`, `/day/274` — because a path is
 * what the server can put a title and an unfurl on, and a `#/puzzle/42` hash
 * would give every shared link the front page's. So links here are ordinary
 * `<a href>`s that work with no script at all, and this module's whole job is
 * to take the clicks a reader means as "go there" and do them in place with
 * the History API, so the archive is read once per visit rather than once per
 * page.
 *
 * **It takes as few clicks as it can.** A click with a modifier, a middle
 * click, a link with a `target` or a `download`, a link to another site, and a
 * link to a path that is not a page (`/puzzles.sqlite`, `/puzzles.json`) are
 * all left to the browser, because each of those means something the reader
 * chose — a new tab, a download — that an in-place navigation would silently
 * replace. The test for "is a page" is `parsePage`, the same function the
 * server answers 404 by, so the two cannot disagree about which links are
 * the site's.
 */

import { type PageRoute, parsePage } from "../wire";

export interface Navigation {
  /** Goes to a path on this site as a new history entry, and shows it. */
  go(path: string): void;
  /** Rewrites the query string in place: no history entry, and no re-render. */
  replaceQuery(query: string): void;
  /** Gives the window's clicks and history back. Nothing calls it on the live site; a test does. */
  stop(): void;
}

/** The link a click landed in, if any. Duck-typed: an SVG thumbnail inside a card is a target too. */
function linkAround(target: EventTarget | null): HTMLAnchorElement | null {
  const node = target as { closest?: (selector: string) => Element | null } | null;
  if (typeof node?.closest !== "function") return null;
  return node.closest("a[href]") as HTMLAnchorElement | null;
}

/** Where a link goes, or null for an href that is no URL at all. */
function destination(anchor: HTMLAnchorElement, origin: string): URL | null {
  try {
    return new URL(anchor.href, origin);
  } catch {
    return null;
  }
}

/**
 * Whether a click is one the page should take: a plain left click on a link to
 * one of this site's pages.
 *
 * True only for button 0 with no modifier, a click nothing else has already
 * claimed, a link with no `target` (or `_self`) and no `download`, a same-origin
 * href, and a path `parsePage` reads as a page.
 */
export function isInternalClick(event: MouseEvent, anchor: HTMLAnchorElement, origin: string): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = anchor.getAttribute("target");
  if (target && target !== "_self") return false;
  if (anchor.hasAttribute("download") || !anchor.hasAttribute("href")) return false;
  const url = destination(anchor, origin);
  return url !== null && url.origin === origin && parsePage(url.pathname) !== null;
}

/**
 * Starts listening, and returns the way to navigate.
 *
 * `onRoute` is called for every page change this takes — a click, `go`, the
 * back and forward buttons — with the page the path names (null when it names
 * none) and the query string, which carries the browse filter. It is not
 * called for the page already showing; the caller shows that one itself.
 */
export function startRouter(
  win: Window,
  onRoute: (route: PageRoute | null, search: string) => void,
): Navigation {
  const show = () => onRoute(parsePage(win.location.pathname), win.location.search);

  const go = (path: string) => {
    const next = new URL(path, win.location.href);
    // A link to the page already open is a reload in a browser, not a new
    // entry: pressing Back afterwards should leave, not show the same page.
    if (next.href === win.location.href) win.history.replaceState(null, "", next.href);
    else win.history.pushState(null, "", next.href);
    // Before showing, so a page that scrolls itself somewhere (#answer) wins.
    win.scrollTo(0, 0);
    show();
  };

  const onClick = (event: Event) => {
    const click = event as MouseEvent;
    const anchor = linkAround(click.target);
    if (!anchor || !isInternalClick(click, anchor, win.location.origin)) return;
    click.preventDefault();
    go(anchor.href);
  };

  win.document.addEventListener("click", onClick);
  win.addEventListener("popstate", show);

  return {
    go,
    replaceQuery(query) {
      win.history.replaceState(win.history.state, "", `${win.location.pathname}${query}`);
    },
    stop() {
      win.document.removeEventListener("click", onClick);
      win.removeEventListener("popstate", show);
    },
  };
}
