/**
 * The puzzle database's build: where it reads, where it writes, and the one
 * document it ships.
 *
 * Read, not run. A Vite build takes seconds and writes a directory, and
 * everything it would prove here is already written down in the two configs
 * and the template — so this checks those, and the deploy guide runs the real
 * build. What it pins are the ways the site's build could hurt something that
 * is not the site:
 *
 * - writing into the game's `dist/`, which the game serves from the root of its
 *   own host, or emptying it: `emptyOutDir` empties whatever `outDir` names;
 * - taking a root inside `activity/client/`, which would make CLAUDE.md's
 *   "everything under activity/client/ builds together" false the day the two
 *   builds diverge;
 * - a template that needs `'unsafe-inline'` under the site's CSP, where the
 *   failure is a page that loads blank in a browser and passes every test
 *   happy-dom can run; or one carrying the head placeholder twice, which the
 *   server's `injectHead` refuses, so every page would answer 500.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import gameConfig from "../vite.config";
import siteConfig from "../puzzledb/vite.config";

const ACTIVITY = resolve(import.meta.dir, "..");
const GAME_CLIENT = resolve(ACTIVITY, "client");
const TEMPLATE = resolve(ACTIVITY, "puzzledb/client/index.html");
const TOKENS = resolve(ACTIVITY, "client/src/styles/tokens.css");

/**
 * Where the server puts each page's `<title>` and Open Graph tags
 * (`HEAD_PLACEHOLDER` in `puzzledb/server/head.ts`). Written out rather than
 * imported, because this file reads the page's side of the contract and must
 * not need the server's code to do it; the plan fixes the string for both.
 */
const HEAD_PLACEHOLDER = "<!--puzzledb:head-->";

/** Whether `path` is `parent` or anything below it. */
function isInside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The game's output directory, resolved the way Vite resolves it: against its root, from `activity/`. */
function gameOutDir(): string {
  return resolve(ACTIVITY, gameConfig.root ?? ".", gameConfig.build?.outDir ?? "dist");
}

describe("the site's build", () => {
  test("builds into puzzledb/dist from a root outside activity/client, never into the game's dist", () => {
    const root = siteConfig.root ?? "";
    const outDir = siteConfig.build?.outDir ?? "";

    expect(root).toBe(resolve(ACTIVITY, "puzzledb/client"));
    expect(outDir).toBe(resolve(ACTIVITY, "puzzledb/dist"));
    expect(isInside(root, GAME_CLIENT)).toBe(false);

    // Neither output directory may hold the other: emptying one would empty both.
    expect(gameOutDir()).toBe(resolve(ACTIVITY, "dist"));
    expect(isInside(outDir, gameOutDir())).toBe(false);
    expect(isInside(gameOutDir(), outDir)).toBe(false);
    // Said explicitly: Vite will not empty an outDir outside its root otherwise,
    // and a stale hashed bundle left beside the new one is served forever.
    expect(siteConfig.build?.emptyOutDir).toBe(true);
  });

  test("serves from the host root and ships the club's fonts", () => {
    // Absolute asset URLs, because the document is served at /puzzle/42 and
    // /day/274 too: a relative `assets/…` would resolve under /puzzle/.
    expect(siteConfig.base).toBe("/");
    const publicDir = siteConfig.publicDir;
    expect(publicDir).toBe(resolve(ACTIVITY, "client/public"));

    // Every face tokens.css asks for, at the very path it asks for it. The
    // stylesheet is the game's and is reused unchanged, so the fonts have to be
    // where the game keeps them — at /fonts/ on whatever host serves the page.
    const urls = [...readFileSync(TOKENS, "utf8").matchAll(/url\("(\/[^"]+)"\)/g)].map((match) => match[1]!);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("/fonts/")).toBe(true);
      expect(existsSync(resolve(String(publicDir), `.${url}`))).toBe(true);
    }
  });

  test("publishes no sourcemaps", () => {
    expect(siteConfig.build?.sourcemap).toBe(false);
  });

  test("never inlines an asset as a data: URI, which the site's CSP would refuse", () => {
    // img-src, font-src and style-src are 'self' only (server/app.ts), so a
    // favicon Vite inlined below its default 4 KB limit would silently fail.
    expect(siteConfig.build?.assetsInlineLimit).toBe(0);
  });

  test("resolves @shared as the game does, so the reused client modules compile", () => {
    expect(siteConfig.resolve?.alias).toEqual({ "@shared": resolve(ACTIVITY, "shared") });
  });

  test("develops against the site's own server, never the game's", () => {
    expect(siteConfig.server?.port).toBe(3003);
    expect(siteConfig.server?.proxy).toEqual({
      "/puzzles.json": "http://127.0.0.1:3002",
      "/puzzles.sqlite": "http://127.0.0.1:3002",
      "/health": "http://127.0.0.1:3002",
    });
  });

  test("leaves the game's build with exactly its two pages", () => {
    const input = gameConfig.build?.rollupOptions?.input as Record<string, string>;

    expect(Object.keys(input).sort()).toEqual(["main", "review"]);
    for (const page of Object.values(input)) {
      expect(isInside(page, GAME_CLIENT)).toBe(true);
      expect(page.includes("puzzledb")).toBe(false);
    }
  });

  test("tsconfig.json includes puzzledb/**/*.ts", () => {
    const tsconfig = Bun.JSONC.parse(readFileSync(resolve(ACTIVITY, "tsconfig.json"), "utf8")) as {
      include: string[];
    };
    expect(tsconfig.include).toContain("puzzledb/**/*.ts");
  });
});

// ── The template ─────────────────────────────────────────────────────────────

interface TemplateScan {
  readonly placeholdersInHead: number;
  readonly scripts: { src: string | null; type: string | null; body: string }[];
  readonly styleElements: number;
  /** `element[attribute]` for every `style=` and `on…=` attribute anywhere. */
  readonly inlineAttributes: string[];
  readonly mountPoints: number;
}

/**
 * Walks the template with Bun's HTMLRewriter rather than with regexes, so a
 * comment or an attribute order cannot hide anything.
 */
async function scanTemplate(html: string): Promise<TemplateScan> {
  const scripts: TemplateScan["scripts"] = [];
  const inlineAttributes: string[] = [];
  let placeholdersInHead = 0;
  let styleElements = 0;
  let mountPoints = 0;

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        for (const [name] of element.attributes) {
          if (name === "style" || /^on/i.test(name)) inlineAttributes.push(`${element.tagName}[${name}]`);
        }
      },
    })
    .on("head", {
      comments(comment) {
        if (`<!--${comment.text}-->` === HEAD_PLACEHOLDER) placeholdersInHead += 1;
      },
    })
    .on("script", {
      element(element) {
        scripts.push({ src: element.getAttribute("src"), type: element.getAttribute("type"), body: "" });
      },
      text(chunk) {
        const last = scripts[scripts.length - 1];
        if (last) last.body += chunk.text;
      },
    })
    .on("style", {
      element() {
        styleElements += 1;
      },
    })
    .on("#puzzledb", {
      element() {
        mountPoints += 1;
      },
    });
  await rewriter.transform(new Response(html)).text();
  return { placeholdersInHead, scripts, styleElements, inlineAttributes, mountPoints };
}

describe("the site's document", () => {
  test("has one head placeholder and no inline script, style or event handler", async () => {
    const html = readFileSync(TEMPLATE, "utf8");
    const scan = await scanTemplate(html);

    // Exactly once in the whole file, and that once inside <head>.
    expect(html.split(HEAD_PLACEHOLDER).length - 1).toBe(1);
    expect(scan.placeholdersInHead).toBe(1);

    // One module script, by URL, with nothing written inside it: the CSP is
    // `script-src 'self'` with no 'unsafe-inline', so an inline one never runs.
    expect(scan.scripts).toEqual([{ src: "./main.ts", type: "module", body: "" }]);
    expect(scan.styleElements).toBe(0);
    expect(scan.inlineAttributes).toEqual([]);
  });

  test("has the element the page mounts into", async () => {
    // main.ts throws without it, and a page that throws on boot is a blank page
    // under a title that says everything is fine.
    expect((await scanTemplate(readFileSync(TEMPLATE, "utf8"))).mountPoints).toBe(1);
  });
});
