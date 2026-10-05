import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * The puzzle database's page: its own build, beside the game's and never part
 * of it.
 *
 * It compiles the game's board, glyphs and answer stepper from `client/src`
 * and `shared/` unchanged, the way the review page does, but from a root of
 * its own and into a directory of its own. That separation is the point:
 *
 * - **The root is outside `activity/client/`**, so CLAUDE.md's rule that
 *   everything under `activity/client/` builds together stays true, and a
 *   page added here can never re-chunk the game's bundle.
 * - **The output is `puzzledb/dist`**, and `emptyOutDir` only ever empties
 *   that. The game's `vite.config.ts` empties `activity/dist`, which is what
 *   the game serves — so a site deploy cannot leave the game without a page,
 *   and a game deploy cannot leave the site without one.
 *
 * `base: "/"` where the game has `base: ""`. The game's relative base exists
 * for Discord's proxy; this document is served at `/puzzle/42` and `/day/274`
 * as well as at `/`, where a relative `assets/…` would resolve under
 * `/puzzle/` and 404. Absolute is the only base that works at every depth.
 *
 * `publicDir` is the game's, because `tokens.css` is reused as it is and asks
 * for its fonts at `/fonts/…`. That copies `petr.png` too, which is never
 * served: the site's server answers `/assets/*` and `/fonts/*` and nothing
 * else from the build. Everything under `/fonts/` is served, the fonts' OFL
 * licence texts and README included, which is what the OFL asks for.
 *
 * No sourcemaps: the build is served to strangers, and a map is a second copy
 * of every reused module sitting under `/assets/` for nobody's benefit — the
 * repository is public, and that is where the source is read.
 */

const activity = resolve(import.meta.dirname, "..");

/** The site's own server (`DEFAULT_PORT` in `server/settings.ts`), for the dev server to ask for data. */
const SITE_SERVER = "http://127.0.0.1:3002";

export default defineConfig({
  root: resolve(import.meta.dirname, "client"),
  base: "/",
  publicDir: resolve(activity, "client/public"),
  resolve: {
    alias: { "@shared": resolve(activity, "shared") },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    // Never inline an asset as a data: URI. The site's Content-Security-Policy
    // allows images, fonts and styles from 'self' only (server/app.ts), so an
    // inlined favicon or background would be refused without a sound. A file
    // under /assets/ is served with the rest.
    assetsInlineLimit: 0,
  },
  server: {
    // Beside the game's dev server on 3000 and its API on 3001, and the site on 3002.
    port: 3003,
    // The reused modules live outside this root; Vite refuses to serve them otherwise.
    fs: { allow: [activity] },
    // `/data` is every page's body. The page asks for it with `Accept:
    // application/json`, so Vite does not fall back to the HTML document and
    // answers 404 instead, and a 404 body is the "No such page" view: without
    // this line every page but the front opens and then disappears.
    proxy: {
      "/puzzles.json": SITE_SERVER,
      "/puzzles.sqlite": SITE_SERVER,
      "/health": SITE_SERVER,
      "/data": SITE_SERVER,
    },
  },
});
