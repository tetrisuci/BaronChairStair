/**
 * `shared/deploy.json`: where the deploy lives and which pm2 apps are its own.
 *
 * The box runs another bot, DIAYN, under the same pm2, so the names in this
 * file are the deploy's whole world: it refuses to act on any app they do not
 * name ({@link assertManaged}). That makes a typo here the cheapest way to
 * aim a deploy at the wrong process, so the file is read strictly — an
 * unknown field is an error rather than a default silently taking its place,
 * and every problem is reported at once so a fix is one edit, not five runs.
 */

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DeployError } from "./errors";

export interface Pm2Names {
  readonly bot: string;
  /** The two game apps that take turns on the one port. */
  readonly gameSlots: readonly [string, string];
  readonly site: string;
}

export interface DeployConfig {
  /** Absolute. Holds repo/, releases/, shared/ and state.json. */
  readonly home: string;
  readonly pm2: Pm2Names;
  readonly gamePort: number;
  readonly sitePort: number;
  /** Absolute: the venv interpreter that runs the bot and its tests. */
  readonly botPython: string;
  /** Absolute path of bun for every app and check; null means the bun running this tool. */
  readonly bun: string | null;
  /** How long a game slot that was told to drain may keep its matches going. */
  readonly drainLimitMinutes: number;
  /** How long the bot must have handled nothing before a restart counts as quiet. */
  readonly botQuietSeconds: number;
  /** How long a bot switch waits for quiet before giving up. */
  readonly botQuietLimitMinutes: number;
  /** How many of the newest releases `prune` keeps, beside any still in use. */
  readonly keepReleases: number;
  /** Globs, relative to the repository root: a change to any of them means the bot changed. */
  readonly botFiles: readonly string[];
}

export const CONFIG_DEFAULTS = {
  drainLimitMinutes: 20,
  botQuietSeconds: 60,
  botQuietLimitMinutes: 30,
  keepReleases: 3,
  botFiles: ["client/**", "server/**", "package.json", "bun.lock", "changelog.json"],
} as const;

const KNOWN_FIELDS = new Set([
  "home",
  "pm2",
  "gamePort",
  "sitePort",
  "botPython",
  "bun",
  "drainLimitMinutes",
  "botQuietSeconds",
  "botQuietLimitMinutes",
  "keepReleases",
  "botFiles",
]);

/**
 * A pm2 app name the deploy can pass on a command line without pm2 reading it
 * as something else: it must start with a letter (a bare number is a pm2 id)
 * and hold no spaces or shell characters.
 */
const PM2_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** Names pm2 gives a meaning of its own. */
const RESERVED_NAMES = new Set(["all"]);

const MAX_PORT = 65_535;

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absolutePath(value: unknown, field: string, problems: string[]): string {
  if (typeof value === "string" && isAbsolute(value)) return value;
  problems.push(`${field} must be an absolute path`);
  return "";
}

function port(value: unknown, field: string, problems: string[]): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PORT) return value;
  problems.push(`${field} must be a whole number from 1 to ${MAX_PORT}`);
  return 0;
}

function positive(value: unknown, field: string, fallback: number, problems: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  problems.push(`${field} must be a number above 0`);
  return fallback;
}

function wholeAtLeastZero(value: unknown, field: string, fallback: number, problems: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  problems.push(`${field} must be a whole number, 0 or more`);
  return fallback;
}

function pm2Name(value: unknown, field: string, problems: string[]): string {
  if (typeof value === "string" && PM2_NAME.test(value) && !RESERVED_NAMES.has(value)) return value;
  problems.push(
    `${field} is ${JSON.stringify(value)}: a pm2 app name must start with a letter, hold only letters, digits, ".", "_" or "-", and not be "all"`,
  );
  return "";
}

function pm2Names(value: unknown, problems: string[]): Pm2Names {
  if (!isRecord(value)) {
    problems.push("pm2 must be an object: { bot, gameSlots: [two names], site }");
    return { bot: "", gameSlots: ["", ""], site: "" };
  }
  const bot = pm2Name(value.bot, "pm2.bot", problems);
  const site = pm2Name(value.site, "pm2.site", problems);
  const slots = Array.isArray(value.gameSlots) ? value.gameSlots : [];
  if (slots.length !== 2) problems.push("pm2.gameSlots must name exactly two apps");
  const gameSlots: [string, string] = [
    pm2Name(slots[0], "pm2.gameSlots[0]", problems),
    pm2Name(slots[1], "pm2.gameSlots[1]", problems),
  ];
  const named = [bot, site, ...gameSlots].filter((name) => name !== "");
  if (new Set(named).size !== named.length) {
    problems.push("pm2.bot, pm2.site and the two pm2.gameSlots must all be different");
  }
  // The bot's status file is run/bot.json and a slot's is run/<slot>.json.
  if (gameSlots.includes("bot")) problems.push('a game slot named "bot" would share the bot\'s status file, run/bot.json');
  return { bot, gameSlots, site };
}

function globs(value: unknown, problems: string[]): readonly string[] {
  if (value === undefined) return CONFIG_DEFAULTS.botFiles;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item !== "")) {
    return value as string[];
  }
  problems.push("botFiles must be a non-empty list of globs, such as \"client/**\"");
  return CONFIG_DEFAULTS.botFiles;
}

/** Read and check a deploy.json's text. `source` names it in every message. */
export function parseConfig(text: string, source: string): DeployConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DeployError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) throw new DeployError(`${source} must hold one JSON object`);

  const problems: string[] = [];
  for (const field of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(field)) problems.push(`unknown field "${field}"`);
  }
  const config: DeployConfig = {
    home: absolutePath(raw.home, "home", problems),
    pm2: pm2Names(raw.pm2, problems),
    gamePort: port(raw.gamePort, "gamePort", problems),
    sitePort: port(raw.sitePort, "sitePort", problems),
    botPython: absolutePath(raw.botPython, "botPython", problems),
    bun: raw.bun === undefined || raw.bun === null ? null : absolutePath(raw.bun, "bun", problems),
    drainLimitMinutes: positive(raw.drainLimitMinutes, "drainLimitMinutes", CONFIG_DEFAULTS.drainLimitMinutes, problems),
    botQuietSeconds: wholeAtLeastZero(raw.botQuietSeconds, "botQuietSeconds", CONFIG_DEFAULTS.botQuietSeconds, problems),
    botQuietLimitMinutes: positive(
      raw.botQuietLimitMinutes,
      "botQuietLimitMinutes",
      CONFIG_DEFAULTS.botQuietLimitMinutes,
      problems,
    ),
    keepReleases: wholeAtLeastZero(raw.keepReleases, "keepReleases", CONFIG_DEFAULTS.keepReleases, problems),
    botFiles: globs(raw.botFiles, problems),
  };
  if (config.gamePort !== 0 && config.gamePort === config.sitePort) problems.push("gamePort and sitePort must differ");
  if (problems.length > 0) {
    throw new DeployError(`${source} cannot be used:\n  - ${problems.join("\n  - ")}`);
  }
  return config;
}

export function loadConfig(path: string): DeployConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new DeployError(
      `cannot read ${path}. Pass --config <file>, or write it from tools/deploy/deploy.example.json (see tools/deploy/README.md).`,
    );
  }
  return parseConfig(text, path);
}

/** The only pm2 apps the deploy may touch. */
export function managedNames(config: DeployConfig): ReadonlySet<string> {
  return new Set([config.pm2.bot, config.pm2.site, ...config.pm2.gameSlots]);
}

export function assertManaged(config: DeployConfig, name: string): void {
  if (!managedNames(config).has(name)) {
    throw new DeployError(`refusing to act on pm2 app "${name}": it is not named in deploy.json`);
  }
}
