/**
 * The page: the index, read once; each page's body, read as it opens; the
 * address bar; and which view is on screen.
 *
 * **The index once, and a body per page.** `/puzzles.json` is fetched when the
 * page opens and never again, and it names every page — so the title, the
 * header and the part of a page the index can draw are there at once, and a
 * reader who opened the archive before midnight keeps the archive they opened
 * until they reload, as a document would. What a page shows beyond the index —
 * a day's boards, a player's runs, a puzzle's stats and lines, the all-time
 * boards — is one body from `/data/…`, fetched when the page is shown and kept
 * for the rest of the visit, so Back draws it again without asking.
 *
 * **A body that arrives late is dropped.** Every show takes a number, and a
 * body is drawn only if its page is still the one on screen; otherwise a slow
 * answer for the page the reader just left would land on the page they went
 * to. A body the server has not got is the missing page, title and all, just
 * as the server's own document would have been; one that could not be fetched
 * at all says so in its slot and offers another try.
 *
 * **The address decides, and it decides as the server does.** A path names a
 * page through `parsePage`, and the page exists only if `pageText` finds it,
 * which is the same test that gave the server its status code. So a link that
 * opened a puzzle when clicked opens the same puzzle when shared, and a page
 * the server answered 404 is the missing view here, never a different page.
 * The tab's title comes from the same function, word for word. The server
 * chip is in the query string, `?server=`, read here and written back without
 * a history entry, as the browse filter is.
 *
 * **One view at a time, and one answer.** Moving on detaches the puzzle view,
 * which gives up the replay's arrow keys; the browse view is built once and
 * kept, so the filter, the cards and the reader's place in them are still
 * there after Back.
 */

import { ApiError } from "../../client/src/api";
import { el, replaceChildren } from "../../client/src/ui/dom";
import {
  bodyPathFor,
  NOT_FOUND_TEXT,
  type PageRoute,
  pageText,
  parsePage,
  type SiteData,
  type SitePuzzle,
  UNAVAILABLE_TEXT,
} from "../wire";
import { loadBody } from "./api";
import { BoardStage } from "./board-stage";
import { type BrowseView, createBrowseView } from "./browse";
import { type BodyView, indexSiteData, readBody, type SiteIndex, type ViewContext } from "./data";
import { renderDayBoards } from "./day-boards";
import { createDaysView, createDayView } from "./days";
import { filterFromQuery, queryFromFilter } from "./filter-url";
import { markCurrent, missingView, siteFooter, siteHeader, unavailableView } from "./frame";
import { leaderboardsPage } from "./leaderboards";
import { playerPage } from "./player-view";
import { renderPlayers } from "./players";
import { ANSWER_ID, createPuzzleView, LINES_ID, type PuzzleView } from "./puzzle-view";
import { type Navigation, startRouter } from "./router";
import { queryForServer, serverFromQuery } from "./server-chips";

/** What the page says while the archive is on its way — the same words `index.html` starts with. */
const OPENING = "opening the archive";
/** What a page's slot says while its body is on its way. */
const READING = "Reading the records…";
const FAILED = "Couldn't load this part of the page.";

/** How the page fetches a body: `loadBody` in a browser, a stand-in in a test. */
export type BodyLoader = (path: string) => Promise<unknown>;

/** A view the index draws whole, or one with a body still to come. */
type View = HTMLElement | BodyView;

function hasBody(view: View): view is BodyView {
  return "slot" in view && "fill" in view;
}

export class SitePage {
  private index: SiteIndex | null = null;
  private navigation: Navigation | null = null;
  private readonly header = siteHeader();
  private readonly main = el("main", { class: "pdb-main" });
  /** Built on the first visit to `/` and kept, so Back finds it as it was left. */
  private browse: BrowseView | null = null;
  /** The puzzle on screen and its board, while there is one. */
  private puzzle: { readonly view: PuzzleView; readonly stage: BoardStage } | null = null;
  /** Counts every show, so a body that lands after the reader moved on can tell. */
  private showing = 0;
  /** Every body drawn this visit, by path. */
  private readonly bodies = new Map<string, unknown>();
  private readonly redraw = () => this.puzzle?.stage.draw();

  constructor(
    private readonly root: HTMLElement,
    private readonly load: () => Promise<SiteData>,
    private readonly win: Window = window,
    private readonly loadPageBody: BodyLoader = (path) => loadBody(path),
  ) {}

  /** Opening label, the data once, then the router, then whatever the address names. */
  async start(): Promise<void> {
    replaceChildren(this.root, el("p", { class: "label", text: OPENING }));
    let data: SiteData;
    try {
      data = await this.load();
    } catch (error) {
      // The reader gets the one sentence the server's 503 page gets; the
      // reason goes where somebody debugging it will look.
      console.error("[puzzledb] could not load the archive:", error);
      this.win.document.title = UNAVAILABLE_TEXT.title;
      replaceChildren(this.root, unavailableView());
      return;
    }

    this.index = indexSiteData(data);
    replaceChildren(this.root, this.header, this.main, siteFooter(data.about));
    this.win.addEventListener("resize", this.redraw);
    this.navigation = startRouter(this.win, (route, search) => this.show(route, search));
    this.show(parsePage(this.win.location.pathname), this.win.location.search);
  }

  /** Shows a page — or the missing view, when the page is not on this site — and names the tab after it. */
  show(route: PageRoute | null, search: string): void {
    const index = this.index;
    if (!index) return;
    this.leavePuzzle();
    const showing = ++this.showing;

    const text = route ? pageText(route, index.lookup) : null;
    this.win.document.title = (text ?? NOT_FOUND_TEXT).title;
    markCurrent(this.header, text ? route : null);
    const view = route && text ? this.viewFor(route, index, search) : null;
    replaceChildren(this.main, view === null ? missingView(route) : hasBody(view) ? view.element : view);
    if (route?.kind === "puzzle" && this.puzzle) this.settlePuzzle();

    const path = route ? bodyPathFor(route) : null;
    if (route && path && view && hasBody(view)) void this.fillBody(route, path, view, showing);
  }

  /** Gives the window back: the router's listeners, the resize listener and the replay's keys. */
  stop(): void {
    this.navigation?.stop();
    this.navigation = null;
    this.win.removeEventListener("resize", this.redraw);
    this.leavePuzzle();
  }

  /** The view for a page `pageText` found, or null for the unreachable case where the index disagrees. */
  private viewFor(route: PageRoute, index: SiteIndex, search: string): View | null {
    const ctx = this.contextFor(index, search);
    switch (route.kind) {
      case "browse":
        return this.browseView(index, search).element;
      case "days":
        return createDaysView(index);
      case "day": {
        const day = index.dayByNumber.get(route.day);
        if (!day) return null;
        const slot = el("div", { class: "pdb-slot" });
        const fill = (body: unknown) => replaceChildren(slot, renderDayBoards(readBody("day", body), day, index, ctx));
        return { element: createDayView(day, index, slot), slot, fill };
      }
      case "puzzle": {
        const puzzle = index.byId.get(route.id);
        return puzzle ? this.puzzleView(puzzle, index) : null;
      }
      case "leaderboards":
        return leaderboardsPage(index, ctx);
      case "players":
        return renderPlayers(index);
      case "player": {
        const entry = index.playerByKey.get(route.key);
        return entry ? playerPage(entry, index) : null;
      }
    }
  }

  /** The server chip the address names, and the way a picked chip gets back into the address. */
  private contextFor(index: SiteIndex, search: string): ViewContext {
    return {
      server: serverFromQuery(search, index),
      onServer: (server) => this.navigation?.replaceQuery(queryForServer(server)),
    };
  }

  private browseView(index: SiteIndex, search: string): BrowseView {
    const filter = filterFromQuery(search);
    if (this.browse) {
      this.browse.update(filter);
      return this.browse;
    }
    this.browse = createBrowseView(index, filter, {
      onFilter: (next) => this.navigation?.replaceQuery(queryFromFilter(next)),
    });
    return this.browse;
  }

  /** The puzzle view, with its own board stage; the answer opens at once when the address asks for it. */
  private puzzleView(puzzle: SitePuzzle, index: SiteIndex): BodyView {
    const stage = new BoardStage(this.win);
    const revealed = this.win.location.hash === `#${ANSWER_ID}`;
    const view = createPuzzleView(puzzle, index, { onView: (board) => stage.show(board) }, { revealed });
    this.puzzle = { view, stage };
    return { element: view.element, slot: view.extras, fill: (body) => view.addBody(readBody("puzzle", body), index) };
  }

  /**
   * Draws a page's body into its slot: at once from this visit's copy, or
   * after fetching it, unless the reader has moved on by then.
   */
  private async fillBody(route: PageRoute, path: string, view: BodyView, showing: number): Promise<void> {
    if (this.bodies.has(path)) {
      this.place(path, view, this.bodies.get(path), showing, route);
      return;
    }
    replaceChildren(view.slot, el("p", { class: "label pdb-loading", text: READING }));
    let body: unknown;
    try {
      body = await this.loadPageBody(path);
    } catch (error) {
      if (showing !== this.showing) return;
      if (error instanceof ApiError && error.status === 404) this.showMissing(route);
      else this.failed(path, view, showing, route, error);
      return;
    }
    if (showing === this.showing) this.place(path, view, body, showing, route);
  }

  /** Fills the slot, and keeps the body for the visit once it has proved to be the body asked for. */
  private place(path: string, view: BodyView, body: unknown, showing: number, route: PageRoute): void {
    try {
      view.fill(body);
      this.bodies.set(path, body);
    } catch (error) {
      this.failed(path, view, showing, route, error);
    }
  }

  /** The slot says the body could not be had, and offers to ask again. */
  private failed(path: string, view: BodyView, showing: number, route: PageRoute, error: unknown): void {
    console.error("[puzzledb] could not load", path, error);
    const retry = el("button", {
      class: "btn btn--small",
      text: "Try again",
      attrs: { type: "button" },
      on: { click: () => void this.fillBody(route, path, view, showing) },
    });
    replaceChildren(view.slot, el("div", { class: "pdb-failed" }, el("p", { class: "note", text: FAILED }), retry));
  }

  /** The page turned out not to be on this site after all: the server's 404, here. */
  private showMissing(route: PageRoute): void {
    this.leavePuzzle();
    this.win.document.title = NOT_FOUND_TEXT.title;
    markCurrent(this.header, null);
    replaceChildren(this.main, missingView(route));
  }

  /**
   * What a puzzle needs once it is in the document: its canvas, and — for an
   * `#answer` or `#lines` address — the answers scrolled into view, which the
   * browser could not do itself because the panel did not exist when it looked.
   */
  private settlePuzzle(): void {
    const puzzle = this.puzzle;
    if (!puzzle) return;
    puzzle.stage.attach(puzzle.view.canvas);
    const anchor = this.win.location.hash.slice(1);
    if (anchor === ANSWER_ID || anchor === LINES_ID) {
      puzzle.view.element.querySelector(`#${anchor}`)?.scrollIntoView({ block: "start" });
    }
  }

  private leavePuzzle(): void {
    this.puzzle?.view.detach();
    this.puzzle = null;
  }
}
