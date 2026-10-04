/**
 * The puzzle database's settings: its environment, checked once, at start-up.
 *
 * There are three, and every rule about them answers a way the process could
 * otherwise start wrong without a sound.
 *
 * **Its environment is its own.** The site is started as
 * `bun --env-file=puzzledb/.env`, which *replaces* Bun's usual `.env` loading,
 * so the game's secrets never enter it. Started any other way — `bun run` from
 * `activity/`, say — Bun loads the game's `.env` instead, secrets and all, and
 * nothing would look wrong. So the seven secrets the game and the bot hold are
 * refused by name. Never by value: the refusal is printed to a log, and a
 * check that echoed what it found would leak the very thing it guards.
 *
 * **Nothing it needs is defaulted.** Bun skips an `--env-file` it cannot find
 * without a word and runs on. A default database path would then quietly be
 * the wrong database, so `DATABASE_PATH` is required, and absolute.
 *
 * **Its port is its own variable.** An inherited variable beats the env file,
 * and the game's shell has `PORT=3001` in it; a site that read `PORT` could be
 * moved onto the game's port by the shell it was started from.
 *
 * Every problem is collected before anything is thrown, so an operator reads
 * the whole list once rather than one line per restart. This module never
 * imports `server/config.ts`, which throws at import under NODE_ENV=production
 * without the game's secrets; the time-zone check is the one piece of it this
 * needs, and is repeated below.
 */

import { statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DEFAULT_TIME_ZONE } from "../../shared/daily";

/**
 * Loopback only. Whatever puts db.tetrisatuci.org in front — cloudflared,
 * Caddy, nginx — runs on this box, so nothing else ever needs to reach the
 * process, and every peer it can see is that proxy.
 */
export const HOST = "127.0.0.1";

/** Beside the game's 3001, and the page's dev server on 3003. */
export const DEFAULT_PORT = 3002;

/**
 * What the game (`activity/.env`) and the bot (the root `.env`) keep secret.
 * The site needs none of them, so any one present means it was started the
 * wrong way.
 */
export const FORBIDDEN_SECRETS = [
  "DISCORD_CLIENT_SECRET",
  "SESSION_SECRET",
  "REVIEW_SECRET",
  "BOT_API_KEY",
  "DISCORD_TOKEN",
  "PUZZLE_API_KEY",
  "GITHUB_TOKEN",
] as const;

/**
 * The files a build reads besides the database, found beside this code.
 *
 * The very files the game's next boot reads — `server/config.ts` resolves the
 * same two from its own directory — so the site lists what the game will deal.
 * Not settings: a site pointed at another checkout's puzzles would publish a
 * list the game never deals, and nothing about it would look wrong.
 */
export const SITE_PATHS: {
  readonly puzzles: string;
  readonly trackedArchive: string;
  readonly buildRoot: string;
} = Object.freeze({
  puzzles: resolve(import.meta.dir, "../../data/puzzles.json"),
  trackedArchive: resolve(import.meta.dir, "../../data/archive/puzzles.sqlite"),
  buildRoot: resolve(import.meta.dir, "../dist"),
});

export interface SiteSettings {
  readonly port: number;
  readonly databasePath: string;
  readonly timeZone: string;
}

/** Why the site will not start: every problem at once, each naming its variable. */
export class SettingsError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The puzzle database will not start:\n- ${problems.join("\n- ")}`);
    this.name = "SettingsError";
    this.problems = Object.freeze([...problems]);
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

/** One setting read: its value, and whatever is wrong with it. The value is unused once anything is. */
interface Checked<T> {
  readonly value: T;
  readonly problems: readonly string[];
}

const ENV_FILE_HINT = "start with bun --env-file=puzzledb/.env (activity/puzzledb/DEPLOY.md)";

/** The settings, or a {@link SettingsError} listing everything wrong with them. */
export function readSettings(env: Environment): SiteSettings {
  const databasePath = checkDatabasePath(env.DATABASE_PATH);
  const port = checkPort(env.PUZZLEDB_PORT);
  const timeZone = checkTimeZone(env.DAILY_RESET_TIMEZONE);
  const problems = [
    ...secretsIn(env),
    ...databasePath.problems,
    ...port.problems,
    ...timeZone.problems,
  ];
  if (problems.length > 0) throw new SettingsError(problems);
  return Object.freeze({
    port: port.value,
    databasePath: databasePath.value,
    timeZone: timeZone.value,
  });
}

/** An empty value holds no secret: `SESSION_SECRET=` in a file is a line, not a key. */
function secretsIn(env: Environment): string[] {
  return FORBIDDEN_SECRETS.filter((name) => Boolean(env[name])).map(
    (name) =>
      `${name} is set in this process's environment. The puzzle database never needs the ` +
      `game's or the bot's secrets. Start it with bun --env-file=puzzledb/.env ` +
      "(activity/puzzledb/DEPLOY.md).",
  );
}

/**
 * Absolute, because a relative path means a different file depending on the
 * directory the process happened to start in — the same mistake that makes
 * the game's own open create a fresh, empty database where it meant to find
 * the real one.
 */
function checkDatabasePath(raw: string | undefined): Checked<string> {
  const path = raw?.trim() ?? "";
  if (path === "") {
    return refused(
      "",
      "DATABASE_PATH is not set. Set it in puzzledb/.env to the absolute path of the game's " +
        `daily.sqlite, and ${ENV_FILE_HINT}: Bun skips an env file it cannot find without a word.`,
    );
  }
  if (!isAbsolute(path)) {
    return refused(
      "",
      "DATABASE_PATH must be an absolute path, and it is a relative one, which names a different " +
        "file depending on where the process starts. Give the game's own path.",
    );
  }
  return accepted(resolve(path));
}

/** Digits only, so `1e3`, `0x10` and `+80` — all numbers to `Number()` — are refused as typos. */
function checkPort(raw: string | undefined): Checked<number> {
  const text = raw?.trim() ?? "";
  if (text === "") return accepted(DEFAULT_PORT);
  const port = /^\d{1,5}$/.test(text) ? Number(text) : Number.NaN;
  if (Number.isInteger(port) && port <= 65_535) return accepted(port);
  return refused(
    DEFAULT_PORT,
    "PUZZLEDB_PORT must be a whole number from 0 to 65535 (0 takes any free port). " +
      "The site never reads PORT, which is the game's.",
  );
}

/**
 * The game's own check and the game's own message, from `validTimeZone` in
 * `server/config.ts`. Repeated rather than imported, because importing config
 * is the one thing this process must never do.
 */
function checkTimeZone(raw: string | undefined): Checked<string> {
  const zone = raw?.trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    return refused(zone, `DAILY_RESET_TIMEZONE "${zone}" is not a known IANA time zone`);
  }
  return accepted(zone);
}

function accepted<T>(value: T): Checked<T> {
  return { value, problems: [] };
}

function refused<T>(placeholder: T, problem: string): Checked<T> {
  return { value: placeholder, problems: [problem] };
}

type Ownership =
  | { readonly path: string; readonly uid: number }
  | { readonly path: string; readonly error: string };

/**
 * Says so when the database belongs to a different user from this process.
 *
 * The game's database runs in WAL mode, and even a read-only connection can
 * create the `-wal` and `-shm` files beside it when they are missing. Created
 * by the wrong user, they can stop the game itself from writing — which is a
 * failure in the game, far from its cause. A warning rather than a refusal:
 * a box that shares the files through a group has every right to run this
 * way, and the refusal would stop it for no reason.
 *
 * With the file not there yet, its directory is asked instead, since that is
 * who will own the file. Null when nothing exists to ask, or on a system with
 * no uids.
 */
export function ownerWarning(databasePath: string, uid: number | undefined = process.getuid?.()): string | null {
  if (uid === undefined) return null;
  const owner = ownershipOf(databasePath) ?? ownershipOf(dirname(databasePath));
  if (owner === null) return null;
  if ("error" in owner) {
    return (
      `could not check who owns ${owner.path} (${owner.error}). Run the puzzle database as the ` +
      "game's user, with the same access to the database as the game has."
    );
  }
  if (owner.uid === uid) return null;
  return (
    `this process runs as uid ${uid}, but ${owner.path} belongs to uid ${owner.uid}. Run the ` +
    "puzzle database as the game's user: even a read-only connection can create the -wal and " +
    "-shm files beside it, and one owned by the wrong user can stop the game writing."
  );
}

/** Who owns `path`; null when there is nothing there to own. */
function ownershipOf(path: string): Ownership | null {
  try {
    return { path, uid: statSync(path).uid };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}
