/**
 * The furniture around every page, and the two pages that are not pages.
 *
 * The header is the way home, the way to the six list pages, and the way out
 * with the data: the two downloads sit in the navigation itself, because "can
 * I just have the whole thing" is a first-class question for a public dataset
 * and the answer should not be at the bottom of an about box. The footer says
 * how fresh the data is and which days it covers, so a reader looking for
 * yesterday can see at a glance whether it has been recorded yet — and, since
 * the site shows players, whose names these are and how to take yours off.
 *
 * The block mark is drawn by the stylesheet. The game's `blockMark` colours
 * its four squares with inline styles and is not exported; here the squares
 * are four empty spans that `site.css` colours from the club's tokens, which
 * also keeps the page clear of anything a strict CSP would have to allow.
 */

import { el, panel } from "../../client/src/ui/dom";
import { dayLabel, type PageRoute, pathOf, type SiteAbout, UNAVAILABLE_TEXT } from "../wire";

/** The two downloads, as the header and the about panel both offer them. */
const SQLITE_PATH = "/puzzles.sqlite";
const JSON_PATH = "/puzzles.json";

interface NavItem {
  readonly label: string;
  readonly path: string;
  readonly download?: boolean;
}

const NAV: readonly NavItem[] = [
  { label: "Puzzles", path: "/" },
  { label: "Days", path: "/days" },
  { label: "Leaderboards", path: "/leaderboards" },
  { label: "Players", path: "/players" },
  { label: "Solves", path: "/solves" },
  { label: "Alternates", path: "/alternates" },
  { label: "Download SQLite", path: SQLITE_PATH, download: true },
  { label: "JSON", path: JSON_PATH },
];

/** The club's four blocks — T, O, I, S — as empty spans `site.css` colours. */
function blockMark(): HTMLElement {
  const squares = [el("span"), el("span"), el("span"), el("span")];
  return el("span", { class: "pdb-mark", attrs: { "aria-hidden": "true" } }, ...squares);
}

interface LinkOptions {
  readonly download?: boolean;
  readonly class?: string;
}

function link(text: string, href: string, options: LinkOptions = {}): HTMLAnchorElement {
  return el("a", { class: options.class, text, attrs: { href, download: options.download ? true : null } });
}

/** The two downloads are set apart from the pages, so the eye reads them as files rather than places. */
function navLink(item: NavItem): HTMLAnchorElement {
  const kind = item.path === SQLITE_PATH || item.path === JSON_PATH ? " pdb-nav__link--data" : "";
  return link(item.label, item.path, { download: item.download, class: `pdb-nav__link${kind}` });
}

/** The mark and name, home; then the six list pages and the two downloads. */
export function siteHeader(): HTMLElement {
  return el(
    "header",
    { class: "pdb-head" },
    el(
      "a",
      { class: "pdb-brand", attrs: { href: "/" } },
      blockMark(),
      el("span", { class: "display pdb-brand__name", text: "Puzzle archive" }),
    ),
    el(
      "nav",
      { class: "pdb-nav", attrs: { "aria-label": "Archive" } },
      ...NAV.map(navLink),
    ),
  );
}

/** The pages the header links to; a puzzle, a day or a player is reached from one of them. */
const LISTED_IN_NAV: ReadonlySet<PageRoute["kind"]> = new Set([
  "browse",
  "days",
  "leaderboards",
  "players",
  "solves",
  "alternates",
]);

/**
 * Marks the header link for the page on screen, for a screen reader and for
 * the stylesheet. Only the list pages have one.
 */
export function markCurrent(header: HTMLElement, route: PageRoute | null): void {
  const current = route && LISTED_IN_NAV.has(route.kind) ? pathOf(route) : null;
  for (const anchor of header.querySelectorAll(".pdb-nav__link")) {
    if (anchor.getAttribute("href") === current) anchor.setAttribute("aria-current", "page");
    else anchor.removeAttribute("aria-current");
  }
}

/**
 * When the data was built, in the reader's own time, as `2026-10-02 14:32`.
 *
 * Written out rather than `toLocaleString`, for the reason the review tool's
 * `filedOn` gives: that renders a different shape on every machine, and none of
 * them says which shape it is. Local because "is this from before or after I
 * played tonight" is the question a reader is asking of it.
 */
export function dataAsOf(builtAt: string): string {
  const when = new Date(builtAt);
  if (Number.isNaN(when.getTime())) return "unknown";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}

function daysCovered(about: SiteAbout): string {
  if (about.throughDay === null) return "no finished days yet";
  return `finished days ${about.firstDay}–${about.throughDay}`;
}

/** What the footer says about the people on the site, on every page. */
export const NAMES_NOTE = "Player names as the game shows them. Hide yours in the activity's settings.";

/** `Data as of 2026-10-02 12:05 · finished days 245–274 · tetrisatuci.org`, and whose names these are. */
export function siteFooter(about: SiteAbout): HTMLElement {
  const club = el("a", {
    text: "tetrisatuci.org",
    attrs: { href: "https://tetrisatuci.org", rel: "noopener noreferrer" },
  });
  return el(
    "footer",
    { class: "pdb-foot label" },
    el("span", {}, `Data as of ${dataAsOf(about.builtAt)}`, " · ", daysCovered(about), " · ", club),
    el("span", { class: "pdb-foot__names", text: NAMES_NOTE }),
  );
}

/** What this is, what it leaves out on purpose, and where the whole of it downloads. */
export function aboutPanel(about: SiteAbout): HTMLElement {
  const history =
    about.throughDay === null
      ? "Days are listed once they are over, never today's. No day has finished yet."
      : `Days are listed once they are over, never today's. History starts on day ${about.firstDay}, ` +
        `${dayLabel(about.firstDay)}.`;
  return panel(
    "About this archive",
    { class: "pdb-about" },
    el("p", {
      class: "note",
      text:
        "Every club puzzle the Tetris at UCI daily deals from, as players are dealt it now, officers' " +
        "corrections included. Each maker's answer is here too, hidden until you ask for it.",
    }),
    el("p", { class: "note", text: history }),
    el("p", {
      class: "note",
      text:
        "Each finished day's boards, the all-time leaderboards, each puzzle's stats and the lines players " +
        "found, with the day each was found, are here too — never who found a line. A player who chose to " +
        "hide shows as \u201ca player\u201d.",
    }),
    el("p", { class: "note", text: "Puzzles written by players are not listed." }),
    el(
      "p",
      { class: "note" },
      "All of it downloads as one ",
      link("SQLite file", SQLITE_PATH, { download: true }),
      " or as ",
      link("JSON", JSON_PATH),
      ".",
    ),
  );
}

/** One side of a pager: where it goes and what it says. */
export interface PagerLink {
  readonly href: string;
  readonly text: string;
}

/** Previous and next, either of which may be missing, as one row of two links. */
export function pager(label: string, previous: PagerLink | null, next: PagerLink | null): HTMLElement {
  return el(
    "nav",
    { class: "pdb-pager", attrs: { "aria-label": label } },
    previous
      ? el("a", { class: "pdb-pager__prev", text: `← ${previous.text}`, attrs: { href: previous.href } })
      : null,
    next ? el("a", { class: "pdb-pager__next", text: `${next.text} →`, attrs: { href: next.href } }) : null,
  );
}

/**
 * The sentence for a page that is not on this site.
 *
 * One per kind and nothing more: an unpublished puzzle, a player's puzzle and
 * an id nobody used are missing in exactly the same words, as they are on the
 * server, and today, a future day and a day before history likewise. A player
 * gets no sentence of their own: one who hid and a key nobody holds are both
 * "No such page", so the words cannot tell a reader which it was.
 */
function missingSentence(route: PageRoute | null): string {
  if (route?.kind === "puzzle") return `No puzzle #${route.id} here`;
  if (route?.kind === "day") return `Day ${route.day} is not on this site`;
  return "No such page";
}

/** The page for a path the site does not have, with the way back to one it does. */
export function missingView(route: PageRoute | null): HTMLElement {
  return el(
    "div",
    { class: "pdb-stack pdb-missing" },
    el("h1", { class: "display pdb-title", text: missingSentence(route) }),
    route?.kind === "day"
      ? el("p", { class: "note", text: "Days are listed here once they are over." })
      : null,
    el("p", {}, el("a", { class: "btn btn--small", text: "Browse the archive", attrs: { href: "/" } })),
  );
}

/** While there is no data to show: before the site's first build, or while it cannot make one. */
export function unavailableView(): HTMLElement {
  const sentence = el("p", { class: "note", text: UNAVAILABLE_TEXT.description });
  return panel("Puzzle archive", { class: "pdb-missing" }, sentence);
}
