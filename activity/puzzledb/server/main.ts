/**
 * The puzzle database's entry point, run from `activity/` as
 * `bun --env-file=puzzledb/.env puzzledb/server/main.ts`.
 *
 * Named `main.ts`, not `index.ts`, so `pkill -f server/index.ts` — which has
 * already taken down the wrong server on this box — can never match it.
 *
 * **Nothing runs at import.** Everything sits behind `import.meta.main`, so a
 * test can import this file, and a tool can read its exports, without opening
 * a database or a port.
 *
 * **It exits on purpose only when its settings are wrong.** That is the one
 * failure a restart cannot fix and an operator must. Everything about the
 * game's state — a database missing, locked, older than this code, or a
 * puzzle file that will not load — is the refresher's to explain and retry,
 * while the site answers 503 or keeps serving the last dataset that built. An
 * exit there would be a pm2 restart loop that serves nothing and says the
 * same thing over and over. (A port already taken stops it too, by Bun's own
 * error rather than by choice; see {@link listen}.)
 *
 * The order below is the point of it: the settings are checked before
 * anything opens; the first build, or the first explained failure, happens
 * before the port does; and the banner says what is being served, from which
 * database, at which address, once all of that is true.
 */

import type { Server } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { callerKeyFor } from "../../server/rate-limit";
import { createSiteApp } from "./app";
import { buildDataset } from "./dataset";
import { POLICY } from "./policy";
import { createRefresher, describeServing, POLL_MS, type Refresher } from "./refresher";
import { HOST, ownerWarning, readSettings, SettingsError, SITE_PATHS, type SiteSettings } from "./settings";
import { dataVersion, openGameDatabase, readSnapshot } from "./snapshot";

/** Long enough for a slow phone on the download, short enough that idle sockets go. */
const IDLE_TIMEOUT_SECONDS = 30;
/** Every route is a GET. Bun's default would buffer 128 MB of a body nothing reads. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Who a request is counted against: always the visitor the proxy names.
 *
 * `true`, with no `TRUST_PROXY` setting to turn it off, because the process
 * binds loopback only — every peer it can ever see is the proxy on this box.
 * Keyed on the peer instead, every visitor would share the proxy's one
 * bucket, which is the failure the game's own start-up warning describes. The
 * deploy guide's half of the bargain is a proxy that overwrites
 * `Cf-Connecting-Ip` and `X-Forwarded-For` rather than passing a client's on.
 */
export function siteCallerKey(c: Context): string {
  return callerKeyFor(c, true);
}

function main(): void {
  const settings = settingsOrExit();
  const owner = ownerWarning(settings.databasePath);
  if (owner) console.warn(`[puzzledb] ${owner}`);

  const refresher = refresherFor(settings);
  // The first build, or the first explained failure, before the first request.
  refresher.check();
  refresher.start(POLL_MS);
  if (!existsSync(join(SITE_PATHS.buildRoot, "index.html"))) {
    console.warn(
      "[puzzledb] the page is not built: run `bun run build:puzzledb` in activity/. " +
        "The data routes work without it.",
    );
  }

  const server = listen(
    createSiteApp({
      dataset: () => refresher.current(),
      status: () => refresher.status(),
      buildRoot: SITE_PATHS.buildRoot,
      callerKey: siteCallerKey,
    }),
    settings.port,
  );
  console.log(banner(refresher, settings, server.url.href));
  stopOnSignals(refresher, server);
}

/** The settings, or every problem with them on stderr and exit code 1: the one deliberate exit. */
function settingsOrExit(): SiteSettings {
  try {
    return readSettings(Bun.env);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    console.error(`[puzzledb] not starting:\n- ${error.problems.join("\n- ")}`);
    process.exit(1);
  }
}

/** The refresher over the real collaborators: the game's database, read-only, and the files beside this code. */
function refresherFor(settings: SiteSettings): Refresher {
  return createRefresher({
    databasePath: settings.databasePath,
    sources: {
      puzzlesPath: SITE_PATHS.puzzles,
      trackedArchivePath: SITE_PATHS.trackedArchive,
      timeZone: settings.timeZone,
    },
    policy: POLICY,
    now: Date.now,
    log: console,
    open: openGameDatabase,
    version: dataVersion,
    read: readSnapshot,
    build: buildDataset,
  });
}

/**
 * Loopback only, and GET-only in practice. Bun's own error stops the process
 * when the port is taken — "Is port 3002 in use?" — which is the one other
 * failure a retry cannot fix: it means a second puzzle database is running.
 *
 * `reusePort: false` is what makes that true. In Bun 1.3, `development: false`
 * on its own also turns on SO_REUSEPORT, and a second copy — a foreground
 * trial left in tmux, a pm2 app beside the systemd unit — would then bind
 * beside the first and quietly take half the connections.
 */
function listen(app: Hono, port: number): Server<undefined> {
  return Bun.serve({
    hostname: HOST,
    port,
    development: false,
    reusePort: false,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    maxRequestBodySize: MAX_BODY_BYTES,
    // The server goes to Hono as its env: it is what knows the socket's peer.
    fetch: (request, server) => app.fetch(request, server),
  });
}

/** Ctrl-C in the foreground, `pm2 stop` under pm2: let go of the database and the port, then go. */
function stopOnSignals(refresher: Refresher, server: Server<undefined>): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      refresher.stop();
      server.stop(true);
      process.exit(0);
    });
  }
}

/**
 * One line that answers the questions asked of a fresh start: is it serving,
 * how much, through which day, from which database, at which address.
 */
function banner(refresher: Refresher, settings: SiteSettings, address: string): string {
  const where = `from ${settings.databasePath}, on ${address}`;
  const dataset = refresher.current();
  if (!dataset) {
    return `puzzledb — not serving data yet (${refresher.status().failing ?? "no build yet"}), ${where}`;
  }
  return `puzzledb — ${describeServing(dataset.data)} (${settings.timeZone}), ${where}`;
}

if (import.meta.main) main();
