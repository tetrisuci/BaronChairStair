/**
 * The review tool: the document that gets served, and the screens it composes.
 *
 * Two halves, and they fail in completely different ways.
 *
 * The **routing** half exists because `/review` serving the wrong page is a
 * *success*: 200, `Content-Type: text/html`, a page that loads and works — the
 * Tetris game. Hono's static middleware appends `index.html` only for a
 * directory and never tries `<path>.html`, so a build that emitted a flat
 * `dist/review.html` would fall through to the single-page fallback with
 * nothing anywhere saying so. That is the most likely way to ship this feature
 * broken, so both arrangements are built as fixtures and driven.
 *
 * The **DOM** half is the reviewer's own two jobs: reading a goal against what
 * the solve actually cleared, and stepping the solve. Nothing here mounts the
 * whole page — `main.ts` boots on import and talks to a server — so the views
 * are driven as what they are, functions from data to elements, with the board
 * arriving through the same `onView` seam the page paints from. happy-dom's
 * canvas has no 2D context, which is exactly why that seam is a callback and
 * not a renderer this view owns.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Window } from "happy-dom";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import viteConfig from "../vite.config";
import { registerStaticRoutes } from "../server/static-routes";
// Type-only: `server/http.ts` is erased here, and `server/static-routes.ts`
// imports no config and opens no database, so this file is outside the
// one-database-per-run ordering `tests/submissions.test.ts` documents.
import type { Variables } from "../server/http";
import { ApiError } from "../client/src/api";
import { MINO_INK } from "../client/src/render/skin";
import type { BoardView } from "../client/src/render/board";
import type { SubmissionDetail, QueueRow, Verdict } from "../client/review/api";
import { createDetailView } from "../client/review/detail";
import { createQueueView } from "../client/review/queue";
import { clearList, filedOn } from "../client/review/format";
import { takeGrant } from "../client/review/grant";

const BASE = "http://localhost";

// ── The document that gets served ────────────────────────────────────────────

const GAME_TITLE = "Puzzle — Daily Tetris";
const REVIEW_TITLE = "Review queue — Daily Tetris";

let builds: string;

/** A build root with the pages named, each carrying only its own title. */
function buildWith(name: string, pages: Readonly<Record<string, string>>): string {
  const root = join(builds, name);
  for (const [path, title] of Object.entries(pages)) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `<!doctype html><html><head><title>${title}</title></head><body></body></html>`);
  }
  return root;
}

function serving(root: string): (path: string) => Promise<Response> {
  const app = new Hono<{ Variables: Variables }>();
  app.all("/api/*", (c) => c.json({ error: "No such endpoint" }, 404));
  registerStaticRoutes(app, root);
  return (path) => Promise.resolve(app.fetch(new Request(BASE + path)));
}

beforeAll(() => {
  builds = mkdtempSync(join(tmpdir(), "review-static-"));
});

afterAll(() => {
  rmSync(builds, { recursive: true, force: true });
});

describe("what /review serves", () => {
  test("the review document, at both /review and /review/", async () => {
    const get = serving(
      buildWith("nested", { "index.html": GAME_TITLE, "review/index.html": REVIEW_TITLE }),
    );

    for (const path of ["/review", "/review/"]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain(`<title>${REVIEW_TITLE}</title>`);
    }
  });

  test("the game is still the game, and carries none of the review headers", async () => {
    const get = serving(
      buildWith("nested-game", { "index.html": GAME_TITLE, "review/index.html": REVIEW_TITLE }),
    );

    const response = await get("/");
    expect(await response.text()).toContain(`<title>${GAME_TITLE}</title>`);
    // A Discord activity is *only* ever run in an iframe. DENY across the board
    // would break the game and nothing else.
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  test("a case-variant path carries the headers too", async () => {
    // The guard was registered on the literal paths "/review" and "/review/*",
    // which Hono matches exactly — while the handler under it resolves the same
    // path against the filesystem. On a case-insensitive one (macOS, Windows)
    // /REVIEW therefore found dist/review/index.html and served the whole tool,
    // Accept and Reject included, with neither header on it. The guard is on
    // the path now rather than on the route, so it cannot disagree with what
    // the filesystem is willing to answer.
    const get = serving(
      buildWith("casing", { "index.html": GAME_TITLE, "review/index.html": REVIEW_TITLE }),
    );

    for (const path of ["/REVIEW", "/Review/", "/review/assets/x.js"]) {
      const response = await get(path);
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    // And nothing merely starting with the letters is caught by it.
    expect((await get("/reviewer")).headers.get("x-frame-options")).toBeNull();
  });

  test("the review page refuses to be framed and sends no referrer", async () => {
    const get = serving(
      buildWith("headers", { "index.html": GAME_TITLE, "review/index.html": REVIEW_TITLE }),
    );

    const response = await get("/review");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  /**
   * The bug this pins, and it is the whole reason this file exists: a build
   * that put the review page at `dist/review.html` instead of
   * `dist/review/index.html` answers `/review` with the Tetris game, at 200,
   * as HTML. An officer opening their link would see a puzzle and have no idea
   * why. Nothing throws, nothing logs, and no other test in this suite looks
   * at a served document.
   */
  test("a flat review.html is NOT found — /review answers with the game", async () => {
    const get = serving(buildWith("flat", { "index.html": GAME_TITLE, "review.html": REVIEW_TITLE }));

    const response = await get("/review");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`<title>${GAME_TITLE}</title>`);
  });

  /**
   * And the ordinary way it happens: `dist` is gitignored, so a deploy that
   * pulled and restarted without `bun run build` has no review page at all —
   * or, worse, has a build from before the review page existed, where every
   * path still answers 200. The only thing that can say so is start-up.
   */
  test("a build with no review page says so at start-up", () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      serving(buildWith("stale", { "index.html": GAME_TITLE }));
    } finally {
      console.warn = warn;
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("review/index.html");
    expect(warnings[0]).toContain("bun run build");
  });

  /**
   * The other end of the same rule. `serveStatic` is what makes the directory
   * matter, and the build config is what produces one — so a config that named
   * a flat file would move the failure above out of reach of every test here.
   */
  test("the build's review entry is a directory index", () => {
    const input = viteConfig.build?.rollupOptions?.input as Record<string, string>;
    expect(input.review?.endsWith("/review/index.html")).toBe(true);
  });
});

// ── The screens ──────────────────────────────────────────────────────────────

let window: Window;
const saved = { document: globalThis.document, window: globalThis.window };

beforeAll(() => {
  // Scoped to this file rather than registered as a preload, for the reason
  // render.test.ts gives: `bun test` shares one process and the server suites
  // lean on Bun's own fetch/Request.
  window = new Window({ url: "https://local.test/review" });
  globalThis.document = window.document as unknown as Document;
});

afterAll(() => {
  globalThis.document = saved.document;
  globalThis.window = saved.window;
});

/**
 * One submission, hand-written.
 *
 * The T fills the last hole in row 0 and lands three of its own cells in row 1,
 * so locking it clears a line and drops the rest — which is the whole of what
 * `SolutionPlayer` does for itself, and the one thing worth pinning about the
 * stepper. The clear name and the attack are labels on a display fixture, not
 * numbers this file re-derives: nothing in the review tool computes them, and a
 * fixture that recomputed the attack table would fail whenever it was retuned.
 */
const SUBMISSION: SubmissionDetail = {
  submissionId: 7,
  title: "Notch",
  author: "petra",
  goal: "Clear a TSD.",
  claimedDifficulty: 6,
  piecesPlaced: 1,
  playedAttack: 4,
  clears: ["tsd"],
  createdAt: new Date(2026, 8, 4, 21, 32, 8).getTime(),
  board: ["GGG.GGGGGG"],
  queue: ["T"],
  hold: null,
  solution: [
    {
      piece: "T",
      cells: [
        [3, 0],
        [2, 1],
        [3, 1],
        [4, 1],
      ],
      clear: "tsd",
      attack: 4,
    },
  ],
};

const QUEUE_ROW: QueueRow = {
  submissionId: SUBMISSION.submissionId,
  title: SUBMISSION.title,
  author: SUBMISSION.author,
  goal: SUBMISSION.goal,
  claimedDifficulty: SUBMISSION.claimedDifficulty,
  piecesPlaced: SUBMISSION.piecesPlaced,
  playedAttack: SUBMISSION.playedAttack,
  clears: SUBMISSION.clears,
  createdAt: SUBMISSION.createdAt,
};

const VERDICT: Verdict = {
  submissionId: 7,
  title: "Notch",
  author: "petra",
  status: "accepted",
  reviewedBy: "hannah",
  reviewedAt: 0,
  note: null,
  puzzleId: 100_000,
  difficulty: 12,
};

interface Driven {
  readonly element: HTMLElement;
  readonly views: BoardView[];
  readonly accepted: { difficulty: number; note: string | null }[];
  readonly rejected: { note: string }[];
  readonly decided: Verdict[];
}

/** The detail screen, with every handler recording instead of calling a server. */
function drive(
  submission: SubmissionDetail = SUBMISSION,
  answer: (body: unknown) => Promise<Verdict> = () => Promise.resolve(VERDICT),
): Driven {
  const views: BoardView[] = [];
  const accepted: Driven["accepted"] = [];
  const rejected: Driven["rejected"] = [];
  const decided: Verdict[] = [];
  const view = createDetailView(submission, {
    onView: (board) => void views.push(board),
    onBack: () => {},
    onAccept: (body) => {
      accepted.push(body);
      return answer(body);
    },
    onReject: (body) => {
      rejected.push(body);
      return answer(body);
    },
    onDecided: (verdict) => void decided.push(verdict),
  });
  return { element: view.element, views, accepted, rejected, decided };
}

function find<T extends Element>(root: Element, selector: string): T {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`nothing matched ${selector}`);
  return node as unknown as T;
}

function buttonSaying(root: Element, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!match) throw new Error(`no button says ${label}`);
  return match as unknown as HTMLButtonElement;
}

describe("the queue screen", () => {
  test("a row carries who, when, the title, the goal and both numbers", () => {
    const element = createQueueView([QUEUE_ROW], { onOpen: () => {}, onRefresh: () => {} });
    const row = find(element, ".review__row");

    expect(find(row, ".review__row-title").textContent).toBe("Notch");
    expect(find(row, ".review__row-by").textContent).toBe("by petra · filed 2026-09-04 21:32");
    expect(find(row, ".review__row-goal").textContent).toBe("Clear a TSD.");
    const meta = find(row, ".review__row-meta").textContent ?? "";
    // The author's own rating, said to be theirs: the reviewer's is the number
    // that ends up on the puzzle, and a row labelled "difficulty" would read as
    // one that had already been decided.
    expect(meta).toContain("rated 6");
    expect(meta).toContain("1 piece");
    expect(meta).toContain("+4 attack");
  });

  test("a row opens the submission it names", () => {
    const opened: number[] = [];
    const element = createQueueView([QUEUE_ROW], {
      onOpen: (id) => void opened.push(id),
      onRefresh: () => {},
    });

    find<HTMLButtonElement>(element, ".review__row").click();
    expect(opened).toEqual([7]);
  });

  test("an empty queue says there is nothing to do, not nothing at all", () => {
    const element = createQueueView([], { onOpen: () => {}, onRefresh: () => {} });

    expect(element.querySelector(".review__row")).toBeNull();
    expect(element.textContent).toContain("nothing waiting");
    expect(element.textContent).toContain("has been decided");
  });
});

describe("the submission screen", () => {
  /**
   * The reviewer's actual job. There is no goal checker on the server and there
   * is not going to be one — `parseGoal` is a builder UI module and returns
   * null on prose, which most goals are — so the only check that ever happens
   * is a person reading the goal against the clears. If those two are not in
   * the same panel, nobody does it.
   */
  test("the goal and the clears the solve made are in one panel", () => {
    const { element } = drive();
    const goal = find(element, ".goal__text");
    const clears = find(element, ".review__clears");

    expect(goal.textContent).toBe("Clear a TSD.");
    expect(clears.textContent).toBe("TSD");
    expect(goal.closest(".panel")).toBe(clears.closest(".panel"));
  });

  /**
   * The number a community puzzle carries is what its author actually did, and
   * an archive puzzle's is the best line a pathfinder could find. Reading one
   * as the other is the quiet mistake this whole feature can make, so the page
   * never calls this a target.
   */
  test("the attack is named as the author's own solve, never as a target", () => {
    const { element } = drive();
    const captions = [...element.querySelectorAll(".panel__caption")].map((node) => node.textContent);

    expect(captions).toContain("The author's solve");
    expect(element.textContent).toContain("+4");
    expect(element.textContent?.toLowerCase()).not.toContain("target attack");
  });

  test("the first thing painted is the board as the author left it", () => {
    const { views } = drive();
    const first = views[0]!;

    expect(first.cells[0]).toEqual(["G", "G", "G", null, "G", "G", "G", "G", "G", "G"]);
    expect(first.active).toEqual(SUBMISSION.solution[0]!.cells);
    expect(first.activeInk).toBe(MINO_INK.T);
  });

  /**
   * The bug this pins: a stepper that only redrew the stack would show the T
   * sitting in a row that the same placement clears. `SolutionPlayer` clears
   * full rows itself, and the review page is the only screen where being wrong
   * about that costs a puzzle rather than a reveal animation.
   */
  test("stepping past the last placement shows the row cleared and nothing falling", () => {
    const { element, views } = drive();

    buttonSaying(element, "Next").click();
    const after = views[views.length - 1]!;

    expect(after.cells[0]).toEqual([null, null, "T", "T", "T", null, null, null, null, null]);
    expect(after.active).toEqual([]);
    expect(after.activeInk).toBeNull();
    expect(find(element, ".readout").textContent).toBe("1 / 1");
  });

  test("Restart puts the author's board back", () => {
    const { element, views } = drive();

    buttonSaying(element, "Next").click();
    buttonSaying(element, "Restart").click();
    expect(views[views.length - 1]!.cells[0]).toEqual(views[0]!.cells[0]);
  });

  /**
   * The bug this pins: `title`, `goal` and `author` are typed by players and
   * this page is a plain document outside Discord's sandbox, with no CSP and no
   * `frame-ancestors` behind it. The server refuses control characters and
   * over-length; it does not escape HTML, because escaping belongs to whoever
   * renders — which is here.
   */
  test("a title that looks like markup is text, not markup", () => {
    const { element } = drive({ ...SUBMISSION, title: "<img src=x onerror=alert(1)>" });

    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("Reject is shut until there is a reason to give", () => {
    const { element, rejected } = drive();
    const reject = buttonSaying(element, "Reject");
    expect(reject.disabled).toBe(true);

    const note = find<HTMLTextAreaElement>(element, ".review__reason");
    note.value = "  ";
    note.dispatchEvent(new window.Event("input") as unknown as Event);
    expect(reject.disabled).toBe(true);

    note.value = "The queue runs out two pieces early.";
    note.dispatchEvent(new window.Event("input") as unknown as Event);
    expect(reject.disabled).toBe(false);

    reject.click();
    expect(rejected).toEqual([{ note: "The queue runs out two pieces early." }]);
  });

  test("Accept sends the reviewer's rating and an empty note as none", () => {
    const { element, accepted, decided } = drive();
    const rating = find<HTMLInputElement>(element, ".explore__number");
    expect(rating.value).toBe("6");

    rating.value = "12";
    rating.dispatchEvent(new window.Event("input") as unknown as Event);
    buttonSaying(element, "Accept").click();

    expect(accepted).toEqual([{ difficulty: 12, note: null }]);
    return Promise.resolve().then(() => expect(decided).toEqual([VERDICT]));
  });

  test("the rating's own tier is shown, derived rather than printed", () => {
    const { element } = drive();
    const rating = find<HTMLInputElement>(element, ".explore__number");
    const tier = find(element, ".review__tier");
    expect(tier.textContent).toBe("medium");

    rating.value = "2";
    rating.dispatchEvent(new window.Event("input") as unknown as Event);
    expect(tier.textContent).toBe("easy");

    // `Number("")` is 0 and 0 is a tier — "hard" — so an emptied box would sit
    // there naming one the server would refuse in the same breath.
    rating.value = "";
    rating.dispatchEvent(new window.Event("input") as unknown as Event);
    expect(tier.textContent).toBe("");
  });

  test("a rating outside the scale never reaches the server", () => {
    const { element, accepted } = drive();
    const rating = find<HTMLInputElement>(element, ".explore__number");

    rating.value = "40";
    rating.dispatchEvent(new window.Event("input") as unknown as Event);
    buttonSaying(element, "Accept").click();

    expect(accepted).toEqual([]);
    expect(find(element, ".review__status").textContent).toContain("between 1 and 20");
  });

  /**
   * The bug this pins: two officers can hold links at once and nothing
   * coordinates them, so "already accepted by hannah" is a real answer and the
   * one the officer needs to read. Swallowing it would leave a button that did
   * nothing.
   */
  test("the server's refusal is shown beside the buttons", async () => {
    const refused = () => Promise.reject(new ApiError("Submission 7 was already accepted by hannah", 409));
    const { element, decided } = drive(SUBMISSION, refused);

    buttonSaying(element, "Accept").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(find(element, ".review__status").textContent).toBe(
      "Submission 7 was already accepted by hannah",
    );
    expect(decided).toEqual([]);
    expect(buttonSaying(element, "Accept").disabled).toBe(false);
  });

  /**
   * The bug this pins: a second click sends a second decision, and it loses to
   * the `WHERE status = 'pending'` guard — so the officer is told their own
   * name got there first, which reads exactly like somebody else did.
   */
  test("both buttons are shut while a decision is in flight", () => {
    const { element, accepted } = drive(SUBMISSION, () => new Promise<Verdict>(() => {}));
    const accept = buttonSaying(element, "Accept");

    accept.click();
    expect(accept.disabled).toBe(true);
    expect(buttonSaying(element, "Reject").disabled).toBe(true);

    accept.click();
    expect(accepted).toHaveLength(1);
  });
});

// ── The link, and the two things read off a row ──────────────────────────────

describe("the link", () => {
  function at(url: string): string | null {
    const page = new Window({ url });
    globalThis.window = page as unknown as typeof globalThis.window;
    const grant = takeGrant();
    expect(page.location.search).toBe("");
    expect(page.location.hash).toBe("");
    return grant;
  }

  /**
   * The bug this pins: the link is a bearer capability with nothing written
   * down behind it, so spending it does not make it useless — it works until it
   * expires, for anybody. Leaving it in the address bar leaves it in a
   * screenshot of the queue and in the history of a shared laptop.
   */
  test("is read out of #t and taken out of the address bar", () => {
    expect(at("https://local.test/review#t=a-signed-grant")).toBe("a-signed-grant");
  });

  /**
   * Why the fragment: a browser never puts it in the request line, so the one
   * copy of the token nobody can be careful with — the reverse proxy's access
   * log — never gets written. `?t=` was in every one of them.
   */
  test("a link minted by an older build still works", () => {
    expect(at("https://local.test/review?t=a-signed-grant")).toBe("a-signed-grant");
  });

  test("is absent rather than empty when the page was opened by hand", () => {
    expect(at("https://local.test/review")).toBeNull();
  });
});

describe("what a row says", () => {
  test("a filing time reads the same on every officer's machine", () => {
    expect(filedOn(new Date(2026, 0, 9, 7, 5).getTime())).toBe("2026-01-09 07:05");
    expect(filedOn(Number.NaN)).toBe("unknown");
  });

  /**
   * In the builder's own goal vocabulary, because this list exists to be read
   * against a sentence written in it. Repeats are kept and not tallied: a goal
   * asking for a TSD *last* is one a count cannot answer.
   */
  test("clears are listed in the words the goal is written in, in order", () => {
    expect(clearList(["tsd", "double", "tsd"])).toBe("TSD, Double, TSD");
    expect(clearList([])).toBe("no line clears at all");
  });
});
