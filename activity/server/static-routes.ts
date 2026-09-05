/**
 * Serving the build: the activity, the review tool, and everything they load.
 *
 * This was four lines at the foot of `server/index.ts` until there were two
 * pages in the build instead of one. It moved because the second page has a
 * failure mode nothing else here has — it can be served *successfully*, with
 * the wrong document — and the only way to pin that is to hand the build root
 * in as an argument the way `registerReviewRoutes` takes its secret. A root
 * read from `server/config.ts` is settled once per process, so a test could
 * never point it anywhere.
 *
 * **The wrong document.** Hono's static middleware appends `index.html` only
 * when the path it resolved is a directory (`stat().isDirectory()` in the Bun
 * adapter), and it never tries `<path>.html`. So `/review` finds
 * `dist/review/index.html` and is right; with a flat `dist/review.html` it
 * finds neither a file nor a directory, falls through to the single-page
 * fallback below, and answers **200 with the Tetris game**. No error, no log
 * line, correct content type. `tests/review-page.test.ts` drives both.
 *
 * The other two ways in are not about routing at all. One is a deploy that
 * skipped `bun run build` — `dist` is gitignored, so the directory is simply
 * absent — and {@link warnAboutMissingPages} is what says so, because nothing
 * downstream can. The other is an asset URL that misses and is answered by the
 * fallback with `Content-Type: text/html`, which a browser refuses to execute
 * and says almost nothing about; that one is left alone, because a miss falling
 * through is the behaviour the single-page fallback is built on. Both are in
 * the README's deploy runbook as two `curl` lines.
 */

import { existsSync } from "node:fs";
import { serveStatic } from "hono/bun";
import type { AppRouter } from "./http";
import type { MiddlewareHandler } from "hono";

/** Every page the build is expected to have produced, relative to its root. */
const PAGES = ["index.html", "review/index.html"] as const;

/**
 * The two headers the review page needs and the activity must not have.
 *
 * Scoped to `/review` rather than set globally, and that is not caution: the
 * activity is *only* ever run in an iframe, because that is what a Discord
 * activity is. `DENY` across the board would break the game and nothing else.
 *
 * The review page is the opposite case. It has Accept and Reject on it, Reject
 * is destructive and cheap to trick somebody into, and there is no CSP, no
 * `frame-ancestors` and no Origin check anywhere in this repo to fall back on
 * — so framing it has to be refused by the one header that needs no policy
 * language behind it. `no-referrer` is belt to that braces: the page renders no
 * outbound links at all today, which is the only reason a token in the query
 * string leaks nothing on the way out, and this is what keeps that true if
 * somebody ever adds one.
 *
 * Set after `next()`, the way Hono's own `secureHeaders` does it, so it applies
 * to whatever the static handler built rather than relying on a response having
 * been prepared through the context.
 *
 * Registered on `*` and matching the path itself, case-insensitively, rather
 * than registered on `/review` and `/review/*`. Hono matches a route path
 * exactly; the handler below resolves the same path against the filesystem, and
 * on a case-insensitive one — macOS, Windows — `/REVIEW` finds
 * `dist/review/index.html` and served the whole review tool with neither header
 * on it. A guard the thing it guards does not share is one that holds wherever
 * it was tested and opens wherever it was not.
 */
const REVIEW_PATH = /^\/review(?:\/|$)/i;

const reviewHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  if (!REVIEW_PATH.test(c.req.path)) return;
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Referrer-Policy", "no-referrer");
};

/**
 * Says at start-up when a page the build should have produced is not there.
 *
 * This is the *ordinary* way `/review` serves the wrong thing, and it has
 * nothing to do with code: `dist` is gitignored, so a deploy that pulled and
 * restarted without running `bun run build` has no build at all — and a
 * checkout that predates the review page has a build with one page in it, which
 * is worse, because everything an officer tries still answers 200 with the
 * game. `serveStatic` cannot say so: a miss is how it falls through to the
 * next handler, which is the behaviour every other route depends on.
 *
 * A warning and not a throw. Refusing to boot over a missing file would take
 * down a server that is otherwise answering every API route perfectly, and the
 * people who would notice are the players rather than the officer.
 */
function warnAboutMissingPages(buildRoot: string): void {
  const missing = PAGES.filter((page) => !existsSync(`${buildRoot}/${page}`));
  if (missing.length === 0) return;
  console.warn(
    `[puzzle] the build at ${buildRoot} is missing ${missing.join(" and ")} — ` +
      "run `bun run build` from the activity directory. Until then those pages " +
      "answer with whatever else the fallback finds, which is not an error.",
  );
}

export function registerStaticRoutes(app: AppRouter, buildRoot: string): void {
  warnAboutMissingPages(buildRoot);

  app.use("*", reviewHeaders);

  // Any real file in the build — bundles, fonts, icons — is served as itself;
  // `serveStatic` falls through when the path does not exist, so unknown routes
  // still reach the single-page fallback below.
  app.use("*", serveStatic({ root: buildRoot }));
  // `root` + `path` rather than one joined string. The middleware joins `path`
  // onto `root`, which defaults to `"./"` — and `join("./", "/abs/index.html")`
  // is `"abs/index.html"`, a relative path that resolves nowhere. It happened
  // to work while the only caller passed a root already made relative to the
  // working directory, and answered 404 the first time anything passed an
  // absolute one.
  app.get("*", serveStatic({ root: buildRoot, path: "index.html" }));
}
