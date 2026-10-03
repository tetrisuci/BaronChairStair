/**
 * The page: the archive, read once; the address bar; and which view is on
 * screen.
 *
 * **One request per visit.** The data is fetched when the page opens and
 * never again, and every route after that is drawn from the same index. So a
 * reader who opened the archive before midnight keeps the archive they opened
 * — including which day was the newest finished one — until they reload,
 * which is what a document would do too.
 *
 * **The address decides, and it decides as the server does.** A path names a
 * page through `parsePage`, and the page exists only if `pageText` finds it,
 * which is the same test that gave the server its status code. So a link that
 * opened a puzzle when clicked opens the same puzzle when shared, and a page
 * the server answered 404 is the missing view here, never a different page.
 * The tab's title comes from the same function, word for word.
 *
 * **One view at a time, and one answer.** Moving on detaches the puzzle view,
 * which gives up the replay's arrow keys; the browse view is built once and
 * kept, so the filter, the cards and the reader's place in them are still
 * there after Back.
 */

import { el, replaceChildren } from "../../client/src/ui/dom";
import {
  NOT_FOUND_TEXT,
  type PageRoute,
  pageText,
  parsePage,
  type SiteData,
  type SitePuzzle,
  UNAVAILABLE_TEXT,
} from "../wire";
import { BoardStage } from "./board-stage";
import { type BrowseView, createBrowseView } from "./browse";
import { indexSiteData, type SiteIndex } from "./data";
import { createDaysView, createDayView } from "./days";
import { filterFromQuery, queryFromFilter } from "./filter-url";
import { markCurrent, missingView, siteFooter, siteHeader, unavailableView } from "./frame";
import { ANSWER_ID, createPuzzleView, type PuzzleView } from "./puzzle-view";
import { type Navigation, startRouter } from "./router";

/** What the page says while the archive is on its way — the same words `index.html` starts with. */
const OPENING = "opening the archive";

export class SitePage {
  private index: SiteIndex | null = null;
  private navigation: Navigation | null = null;
  private readonly header = siteHeader();
  private readonly main = el("main", { class: "pdb-main" });
  /** Built on the first visit to `/` and kept, so Back finds it as it was left. */
  private browse: BrowseView | null = null;
  /** The puzzle on screen and its board, while there is one. */
  private puzzle: { readonly view: PuzzleView; readonly stage: BoardStage } | null = null;
  private readonly redraw = () => this.puzzle?.stage.draw();

  constructor(
    private readonly root: HTMLElement,
    private readonly load: () => Promise<SiteData>,
    private readonly win: Window = window,
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

    const text = route ? pageText(route, index.lookup) : null;
    this.win.document.title = (text ?? NOT_FOUND_TEXT).title;
    markCurrent(this.header, text ? route : null);
    const view = route && text ? this.viewFor(route, index, search) : null;
    replaceChildren(this.main, view ?? missingView(route));
    if (route?.kind === "puzzle" && this.puzzle) this.settlePuzzle();
  }

  /** Gives the window back: the router's listeners, the resize listener and the replay's keys. */
  stop(): void {
    this.navigation?.stop();
    this.navigation = null;
    this.win.removeEventListener("resize", this.redraw);
    this.leavePuzzle();
  }

  /** The element for a page `pageText` found, or null for the unreachable case where the index disagrees. */
  private viewFor(route: PageRoute, index: SiteIndex, search: string): HTMLElement | null {
    switch (route.kind) {
      case "browse":
        return this.browseView(index, search).element;
      case "days":
        return createDaysView(index);
      case "day": {
        const day = index.dayByNumber.get(route.day);
        return day ? createDayView(day, index) : null;
      }
      case "puzzle": {
        const puzzle = index.byId.get(route.id);
        return puzzle ? this.puzzleView(puzzle, index) : null;
      }
    }
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
  private puzzleView(puzzle: SitePuzzle, index: SiteIndex): HTMLElement {
    const stage = new BoardStage(this.win);
    const revealed = this.win.location.hash === `#${ANSWER_ID}`;
    const view = createPuzzleView(puzzle, index, { onView: (board) => stage.show(board) }, { revealed });
    this.puzzle = { view, stage };
    return view.element;
  }

  /**
   * What a puzzle needs once it is in the document: its canvas, and — for an
   * `#answer` address — the answer scrolled into view, which the browser
   * could not do itself because the panel did not exist when it looked.
   */
  private settlePuzzle(): void {
    const puzzle = this.puzzle;
    if (!puzzle) return;
    puzzle.stage.attach(puzzle.view.canvas);
    if (this.win.location.hash === `#${ANSWER_ID}`) {
      puzzle.view.element.querySelector(`#${ANSWER_ID}`)?.scrollIntoView({ block: "start" });
    }
  }

  private leavePuzzle(): void {
    this.puzzle?.view.detach();
    this.puzzle = null;
  }
}
