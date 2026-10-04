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
 *
 * **The address bar follows the browse filter, but not keystroke by
 * keystroke.** WebKit refuses a hundredth history write inside ten seconds
 * with a SecurityError, so a reader holding Backspace in the search box would
 * otherwise stop the address tracking the list and throw out of the input
 * listener. The query is written once the typing pauses, written onto the
 * page it was typed on before any navigation, and a refused write is retried
 * rather than thrown.
 */

import { type PageRoute, parsePage } from "../wire";

/** How long the filter must sit still before the address is rewritten: a pause in typing. */
export const QUERY_WRITE_MS = 250;
/** How long to wait after a browser refused a history write before trying again. */
export const REFUSED_RETRY_MS = 2_000;

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
  const query = heldQuery(win);

  const go = (path: string) => {
    const next = new URL(path, win.location.href);
    // The filter belongs to the page it was typed on, so it goes there first.
    query.flush();
    try {
      // A link to the page already open is a reload in a browser, not a new
      // entry: pressing Back afterwards should leave, not show the same page.
      if (next.href === win.location.href) win.history.replaceState(null, "", next.href);
      else win.history.pushState(null, "", next.href);
    } catch (error) {
      if (!refused(error)) throw error;
      // The browser will not move in place right now; it will still load the page.
      win.location.assign(next.href);
      return;
    }
    // Before showing, so a page that scrolls itself somewhere (#answer) wins.
    win.scrollTo(0, 0);
    show();
  };

  // Back and forward have already moved the entry, so a filter still waiting
  // would land on the page arrived at. It is dropped instead.
  const onPop = () => {
    query.drop();
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
  win.addEventListener("popstate", onPop);

  return {
    go,
    replaceQuery: (search) => query.hold(search),
    stop() {
      query.drop();
      win.document.removeEventListener("click", onClick);
      win.removeEventListener("popstate", onPop);
    },
  };
}

/** A browser's refusal of a history write: WebKit throws a SecurityError past its rate limit. */
function refused(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "SecurityError";
}

interface HeldQuery {
  /** Writes `search` once the filter has been still for {@link QUERY_WRITE_MS}. */
  hold(search: string): void;
  /** Writes whatever is waiting onto the current entry now. */
  flush(): void;
  /** Forgets whatever is waiting. */
  drop(): void;
}

/**
 * The query string waiting to be written onto the current history entry.
 *
 * Timers come from `win`, so a test can turn the clock. A refused write keeps
 * the query and tries again after {@link REFUSED_RETRY_MS}; the refusal is
 * warned about once, since a browser repeating it is not news.
 */
function heldQuery(win: Window): HeldQuery {
  let waiting: string | null = null;
  let timer: number | null = null;
  let warned = false;

  const cancel = () => {
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
  };
  const write = () => {
    timer = null;
    if (waiting === null) return;
    try {
      win.history.replaceState(win.history.state, "", `${win.location.pathname}${waiting}`);
      waiting = null;
    } catch (error) {
      if (!refused(error)) throw error;
      if (!warned) console.warn("[puzzledb] the browser refused to update the address; trying again shortly.");
      warned = true;
      timer = win.setTimeout(write, REFUSED_RETRY_MS);
    }
  };

  return {
    hold(search) {
      waiting = search;
      cancel();
      timer = win.setTimeout(write, QUERY_WRITE_MS);
    },
    flush() {
      cancel();
      write();
      // A write the browser refused cannot follow the reader to the next page.
      cancel();
      waiting = null;
    },
    drop() {
      cancel();
      waiting = null;
    },
  };
}
