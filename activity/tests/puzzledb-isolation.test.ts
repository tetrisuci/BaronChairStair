/**
 * What the puzzle database can reach, what it starts with, and what it can
 * never do — held by its imports and its source rather than by anybody's care.
 *
 * **It never loads the game's server.** `server/config.ts` throws at import
 * under NODE_ENV=production without the game's secrets; `server/index.ts`
 * opens the game's database for writing the moment it loads; the engine has
 * no business in a reader. So the site's runtime imports are walked from its
 * entry point, the way Bun itself resolves them, and none of those may
 * appear. `shared/tetris/handling.ts` is the one file under `shared/tetris/`
 * allowed: `server/submissions.ts` uses it to read a stored solve's settings,
 * and it imports nothing. The page is walked too, from its own entry.
 *
 * **It starts as it will in production**: a real process, from a directory
 * with no `.env` in it, with nothing in its environment but `PATH`,
 * `NODE_ENV=production`, a port and the database. It must answer `/health`,
 * and it must refuse — naming the variable, never echoing its value — when a
 * game secret is present or the database is not named at all.
 *
 * **Its source never does the dangerous things**, comments aside: no
 * `VACUUM` or `ATTACH`, which on a read-only handle would still copy or join
 * the game's whole database; `serialize()` only in the privacy boundary,
 * which never sees the game's handle; no HTML built from strings in the page.
 * And it exports an app factory, never a `register*` function, so mounting it
 * in the game can only ever be the Host-checked delegation `app.ts` describes.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { gameFixture, type GameFixture } from "./puzzledb-fixture";

const ACTIVITY = resolve(import.meta.dir, "..");
const SITE = join(ACTIVITY, "puzzledb");
const MAIN = join(SITE, "server/main.ts");
const PAGE = join(SITE, "client/main.ts");
const BUN = process.execPath;
/** Long enough for a cold start that builds the whole dataset on a slow machine. */
const START_MS = 20_000;
/**
 * A process test's own limit: above the two START_MS waits the longest of them
 * makes. Bun stops a test after 5 s by default, which would end a slow cold start
 * with a timeout that names nothing.
 */
const PROCESS_TEST_MS = 2 * START_MS + 5_000;

const fixtures: GameFixture[] = [];
const scratch: string[] = [];

afterAll(() => {
  for (const fixture of fixtures) fixture.cleanup();
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/** A working directory with nothing in it: no `.env` for Bun to load, no `data/` to stumble on. */
function emptyDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "puzzledb-isolation-"));
  scratch.push(directory);
  return directory;
}

function fromActivity(file: string): string {
  return relative(ACTIVITY, file);
}

// ── Imports ───────────────────────────────────────────────────────────────────

/**
 * Every file a module pulls in at run time, by following its imports, plus
 * every package it names.
 *
 * `scanImports` drops type-only imports exactly as Bun's runtime does, so
 * this is the closure that runs, not the one the type checker reads. `@shared`
 * is the page's alias for `activity/shared`, resolved as Vite resolves it; a
 * stylesheet is followed no further, since it carries no code. A leading
 * `#!` line is dropped first, as Bun drops it: `scanImports` refuses one, and
 * the game's own entry point starts with one.
 */
function runtimeClosure(entry: string): { files: Set<string>; packages: Set<string> } {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8").replace(/^#!.*/, "");
    for (const { path } of transpiler.scanImports(source)) {
      const target = resolvedImport(path, file);
      if (target === null) packages.add(path);
      else if (target.endsWith(".ts")) pending.push(target);
    }
  }
  return { files, packages };
}

function resolvedImport(specifier: string, from: string): string | null {
  if (specifier.startsWith(".")) return Bun.resolveSync(specifier, dirname(from));
  if (specifier.startsWith("@shared/")) {
    return Bun.resolveSync(`./${specifier.slice("@shared/".length)}`, join(ACTIVITY, "shared"));
  }
  return null;
}

/** The game's server modules a reader must never load. */
const GAME_SERVER = [
  "config",
  "limits",
  "http",
  "index",
  "auth",
  "db",
  "schedule",
  "duel",
  "review-routes",
  "submission-routes",
  "solve-verdict",
  "public-routes",
  "static-routes",
].map((name) => `server/${name}.ts`);

/** Under `shared/tetris/`, everything but the settings sanitiser is the engine. */
function isEngine(file: string): boolean {
  return file.startsWith("shared/tetris/") && file !== "shared/tetris/handling.ts";
}

/** What the server may load from outside the tree: the runtime's own modules, and Hono. */
function isServerPackage(name: string): boolean {
  return name.startsWith("node:") || name === "bun:sqlite" || name === "hono" || name.startsWith("hono/");
}

describe("what it loads", () => {
  test("the server's runtime imports never reach the game's server modules or the engine", () => {
    const { files, packages } = runtimeClosure(MAIN);
    const reached = [...files].map(fromActivity);

    expect(reached.filter((file) => GAME_SERVER.includes(file))).toEqual([]);
    expect(reached.filter(isEngine)).toEqual([]);
    expect([...packages].filter((name) => !isServerPackage(name))).toEqual([]);
    // The walk did walk: it reached the data layer through the refresher's wiring.
    expect(reached).toContain("puzzledb/server/snapshot.ts");
    expect(reached).toContain("server/rate-limit.ts");
  });

  test("would notice if it did, because the game's own entry point does", () => {
    const { files, packages } = runtimeClosure(join(ACTIVITY, "server/index.ts"));
    const reached = [...files].map(fromActivity);

    expect(reached).toContain("server/config.ts");
    expect(reached.some(isEngine)).toBe(true);
    // The engine's library, by its subpath, is one of the packages the server's allowlist refuses.
    expect([...packages].filter((name) => !isServerPackage(name))).toContain("@haelp/teto/engine");
  });

  test("the page's runtime imports never reach the game's page entry, the builder or the engine", () => {
    const { files, packages } = runtimeClosure(PAGE);
    const reached = [...files].map(fromActivity);
    const forbidden = ["client/src/discord.ts", "client/src/app.ts", "client/src/main.ts", "client/src/ui/builder-state.ts"];

    expect(reached.filter((file) => forbidden.includes(file))).toEqual([]);
    expect(reached.filter((file) => file.startsWith("shared/tetris/"))).toEqual([]);
    expect([...packages]).toEqual([]);
    expect(reached).toContain("puzzledb/wire.ts");
  });

  test("would notice that too, because the game's page does", () => {
    const reached = [...runtimeClosure(join(ACTIVITY, "client/src/main.ts")).files].map(fromActivity);

    expect(reached).toContain("client/src/app.ts");
  });
});

// ── The process ───────────────────────────────────────────────────────────────

/** Nothing but what the deploy guide's env file and pm2 give it. */
function bareEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? "", NODE_ENV: "production", ...extra };
}

function text(bytes: Uint8Array | null | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : "";
}

/** Reads a stream until `pattern` matches what it has said so far, or gives up. */
async function waitFor(stream: ReadableStream<Uint8Array>, pattern: RegExp, ms: number): Promise<RegExpExecArray> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Bun.sleep(ms).then(() => "timeout" as const);
  let said = "";
  for (;;) {
    const next = await Promise.race([reader.read(), deadline]);
    if (next === "timeout") throw new Error(`nothing matching ${pattern} within ${ms} ms; it said: ${said}`);
    if (next.done) throw new Error(`it closed its output first; it said: ${said}`);
    said += decoder.decode(next.value, { stream: true });
    const match = pattern.exec(said);
    if (match) return match;
  }
}

describe("as a process", () => {
  test("loads under NODE_ENV=production with none of the game's secrets", () => {
    // Imported, not run: `import.meta.main` is false, so nothing may happen.
    const loaded = Bun.spawnSync([BUN, "-e", `await import(${JSON.stringify(MAIN)})`], {
      cwd: emptyDirectory(),
      env: bareEnvironment(),
      timeout: START_MS,
    });

    expect(text(loaded.stderr)).toBe("");
    expect(text(loaded.stdout)).toBe("");
    expect(loaded.exitCode).toBe(0);
  }, PROCESS_TEST_MS);

  test("starts as a process on 127.0.0.1 from a bare environment and answers /health", async () => {
    const game = gameFixture({ journal: "delete" });
    fixtures.push(game);
    const site = Bun.spawn([BUN, MAIN], {
      cwd: emptyDirectory(),
      env: bareEnvironment({ PUZZLEDB_PORT: "0", DATABASE_PATH: game.databasePath }),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const banner = await waitFor(site.stdout, /^puzzledb — .* on (http:\/\/\S+)$/m, START_MS);
      const origin = new URL(banner[1]!);

      expect(origin.hostname).toBe("127.0.0.1");
      expect(Number(origin.port)).toBeGreaterThan(0);
      expect(banner[0]).toContain(`from ${game.databasePath}`);
      const health = await fetch(new URL("/health", origin));
      expect(health.status).toBe(200);
      expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      // By its own PID, never by a pattern.
      process.kill(site.pid, "SIGTERM");
    }
    // Stopped by its own handler, which exits cleanly, rather than killed by the signal.
    expect(await site.exited).toBe(0);
  }, PROCESS_TEST_MS);

  test("refuses to share its port with a second copy of itself", async () => {
    // `development: false` alone turns on SO_REUSEPORT in Bun 1.3, and then a
    // second copy — a foreground trial left in tmux, a pm2 app beside the
    // systemd unit the guide also offers — binds beside the first and takes
    // half of cloudflared's connections. The guide's "EADDRINUSE: a second
    // site process" depends on it failing instead.
    const game = gameFixture({ journal: "delete" });
    fixtures.push(game);
    const env = (port: string) => bareEnvironment({ PUZZLEDB_PORT: port, DATABASE_PATH: game.databasePath });
    const first = Bun.spawn([BUN, MAIN], { cwd: emptyDirectory(), env: env("0"), stdout: "pipe", stderr: "pipe" });
    try {
      const banner = await waitFor(first.stdout, /^puzzledb — .* on (http:\/\/\S+)$/m, START_MS);
      const second = Bun.spawnSync([BUN, MAIN], {
        cwd: emptyDirectory(),
        env: env(new URL(banner[1]!).port),
        timeout: START_MS,
      });

      expect(second.exitCode).toBe(1);
      expect(text(second.stderr)).toMatch(/in use/i);
    } finally {
      process.kill(first.pid, "SIGTERM");
    }
    expect(await first.exited).toBe(0);
  }, PROCESS_TEST_MS);

  test("refuses to start with a game secret in its environment, naming the variable and not its value", () => {
    const value = "planted-session-secret-value";

    const refused = Bun.spawnSync([BUN, MAIN], {
      cwd: emptyDirectory(),
      env: bareEnvironment({ DATABASE_PATH: "/srv/baronchairstair/activity/data/daily.sqlite", SESSION_SECRET: value }),
      timeout: START_MS,
    });
    const said = text(refused.stdout) + text(refused.stderr);

    expect(refused.exitCode).toBe(1);
    expect(text(refused.stderr)).toContain("[puzzledb] not starting:");
    expect(said).toContain("SESSION_SECRET is set in this process's environment");
    expect(said).not.toContain(value);
  }, PROCESS_TEST_MS);

  test("refuses to start without DATABASE_PATH", () => {
    const refused = Bun.spawnSync([BUN, MAIN], { cwd: emptyDirectory(), env: bareEnvironment(), timeout: START_MS });

    expect(refused.exitCode).toBe(1);
    expect(text(refused.stderr)).toContain("DATABASE_PATH is not set");
  }, PROCESS_TEST_MS);
});

// ── The source ────────────────────────────────────────────────────────────────

/** Every TypeScript file of the site's own, server and page. */
function siteSources(directory = SITE): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "dist" || entry.name === "node_modules" ? [] : siteSources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** A file as it runs: comments and types gone, strings and calls kept. */
function codeOf(file: string): string {
  return new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(file, "utf8"));
}

function filesWhoseCode(pattern: RegExp, files = siteSources()): string[] {
  return files.filter((file) => pattern.test(codeOf(file))).map(fromActivity);
}

/** SQLite's ATTACH as a statement — `ATTACH 'x'`, `ATTACH DATABASE ?` — not a method called `attach`. */
const ATTACH = /\battach\s+(?:database\b|['"`?:@$])/i;
const VACUUM = /\bvacuum\b/i;
const SERIALIZE = /\.serialize\s*\(/;
const HTML_STRINGS = /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b|\bdocument\.write(?:ln)?\b/;

describe("what its source never does", () => {
  test("never runs VACUUM or ATTACH, and calls serialize() only in public-db.ts", () => {
    expect(siteSources().map(fromActivity)).toContain("puzzledb/server/public-db.ts");

    expect(filesWhoseCode(VACUUM)).toEqual([]);
    expect(filesWhoseCode(ATTACH)).toEqual([]);
    expect(filesWhoseCode(SERIALIZE)).toEqual(["puzzledb/server/public-db.ts"]);
  });

  test("reads code, not comments, and knows a statement from a method", () => {
    // public-db.ts explains why it never uses VACUUM INTO, in prose the scan must not count.
    expect(readFileSync(join(SITE, "server/public-db.ts"), "utf8")).toMatch(/VACUUM INTO/);
    expect(ATTACH.test(`db.exec("ATTACH DATABASE ? AS game")`)).toBe(true);
    expect(ATTACH.test("db.exec(`attach '${path}' as game`)")).toBe(true);
    expect(ATTACH.test("stage.attach(canvas)")).toBe(false);
  });

  test("builds no DOM from HTML strings", () => {
    const page = siteSources(join(SITE, "client"));

    expect(page.length).toBeGreaterThan(0);
    expect(filesWhoseCode(HTML_STRINGS, page)).toEqual([]);
    expect(HTML_STRINGS.test("root.innerHTML = title")).toBe(true);
  });

  test("exports an app factory and no register* function", async () => {
    for (const file of siteSources(join(SITE, "server"))) {
      const exported = Object.keys(await import(file));
      expect(exported.filter((name) => /^register/i.test(name))).toEqual([]);
    }
    const app = (await import(join(SITE, "server/app.ts"))) as Record<string, unknown>;

    expect(Object.keys(app).filter((name) => typeof app[name] === "function")).toEqual(["createSiteApp"]);
  });
});
