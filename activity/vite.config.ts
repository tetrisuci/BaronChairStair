import { defineConfig, type Plugin } from "vite";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUILD_ID_FILE, ENV } from "./shared/runtime-status";
import { DEV_BUILD_ID, isBuildId } from "./shared/build-id";

/**
 * The client is a plain TypeScript app: no framework, one canvas, and a small
 * amount of DOM. `shared/` is compiled from source rather than pre-built so the
 * browser and the server always run byte-identical game logic.
 *
 * Two pages come out of it. The activity is `client/index.html`; the officers'
 * review tool is `client/review/index.html`, and the **directory** in that path
 * is load-bearing rather than tidy. Hono's static middleware appends
 * `index.html` only when the path it resolved is a directory, and never tries
 * `<path>.html` — so `dist/review/index.html` is served at `/review`, while a
 * flat `dist/review.html` would fall through to the single-page fallback and
 * answer 200 with the game. See `server/static-routes.ts`, which pins it.
 *
 * `base: ""` stays, and that is what makes the nested entry work: it emits
 * asset URLs relative to the document, so `dist/review/index.html` references
 * `../assets/…` and resolves to the same bundle the activity loads. An absolute
 * base would be fine here and wrong inside Discord's proxy, which is what it
 * was set for.
 *
 * Both pages always build together — `emptyOutDir` empties the lot — and the
 * review page importing anything from `client/src` re-chunks the activity's
 * bundle. Neither matters, and both mean "ship the review page" is never an
 * independent deploy.
 *
 * The build names itself twice, with one id: compiled into the page as
 * `__BUILD_ID__`, and written beside it as `build.json`, which the server reads
 * and sends back as `X-Build-Id`. A page that hears an id other than
 * its own offers a reload — see `client/src/build-id.ts`. Both come from one
 * plugin that runs only for `vite build`, so the dev server compiles in no id
 * and its page calls itself dev. The site's build (`puzzledb/vite.config.ts`)
 * does neither: it has no server of its own to compare against, and
 * `build-id.ts` reads the missing define as dev.
 */

/** The global the page reads its build id from; replaced with a literal at build time. */
export const BUILD_ID_DEFINE = "__BUILD_ID__";

/** The checkout's commit, short, or null where there is no git to ask. */
function checkoutCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Which build this is: `BUILD_ID` when the deploy sets it (the release's
 * commit, by the contract in `shared/runtime-status.ts`), else the checkout's
 * commit, else dev.
 *
 * A `BUILD_ID` that is not an id stops the build. It would otherwise be either
 * a header the server cannot send or a silent fall back to dev — and a dev
 * build never offers an update, so every open page would quietly stay on the
 * old bundle with nothing anywhere saying why.
 */
export function resolveBuildId(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readCommit: () => string | null = checkoutCommit,
): string {
  const given = env[ENV.buildId]?.trim();
  if (given) {
    if (!isBuildId(given)) {
      throw new Error(
        `${ENV.buildId} must be 1-64 letters, digits, dots, dashes, underscores or pluses; got ${JSON.stringify(given)}`,
      );
    }
    return given;
  }
  const commit = readCommit();
  return isBuildId(commit) ? commit : DEV_BUILD_ID;
}

/**
 * Writes `<dir>/build.json` whole: to a temporary name first, then renamed
 * over the old one, so a server booting mid-build reads the old id or the new
 * one and never half a file.
 */
export function writeBuildIdFile(dir: string, buildId: string): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, BUILD_ID_FILE);
  const pending = `${target}.${process.pid}.tmp`;
  writeFileSync(pending, `${JSON.stringify({ buildId })}\n`);
  renameSync(pending, target);
}

/**
 * Names a build: compiles the id into the page, and writes `build.json` once
 * the bundle is on disk.
 *
 * A build only (`apply`), the define included. Under the dev server the page
 * is rebuilt on every save and is never the checkout's commit, so it must not
 * claim to be: with the commit compiled in, a `dist/build.json` left from a
 * build at another commit had the dev page offering "Update ready", and
 * Reload changed nothing. With no define it calls itself dev, which never
 * offers one. The define lives here rather than in the config's own `define`
 * because that one applies to `vite` and `vite build` alike.
 *
 * `writeBundle` rather than an emitted asset, because it runs after every
 * other file has been written: a `build.json` naming this build means the
 * bundle beside it is this build, whole.
 */
export function buildIdPlugin(buildId: string): Plugin {
  return {
    name: "puzzle:build-id",
    apply: "build",
    config: () => ({ define: { [BUILD_ID_DEFINE]: JSON.stringify(buildId) } }),
    writeBundle(output) {
      if (!output.dir) throw new Error(`Cannot write ${BUILD_ID_FILE}: the build has no output directory`);
      writeBuildIdFile(output.dir, buildId);
    },
  };
}

const buildId = resolveBuildId();

export default defineConfig({
  root: "client",
  base: "",
  resolve: {
    alias: { "@shared": resolve(import.meta.dirname, "shared") },
  },
  plugins: [buildIdPlugin(buildId)],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "client/index.html"),
        review: resolve(import.meta.dirname, "client/review/index.html"),
      },
    },
  },
  server: {
    port: 3000,
    proxy: { "/api": "http://localhost:3001" },
  },
});
