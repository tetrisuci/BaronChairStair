/**
 * What shared/bot.env must leave to the deploy.
 *
 * The bot loads its `.env` with `load_dotenv(..., override=True)`
 * (`client/discord_bot.py`), so whatever bot.env sets beats the environment
 * the ecosystem file gives it — unlike the Bun apps, where the inherited
 * variable wins. And `/archive sync` runs `bun run sync-archive` with the
 * bot's own environment, so it inherits the same values. A bot.env copied
 * from the old checkout that still names the old database or the old
 * activity directory sends the sync there, silently: `sync-archive` opens its
 * database with `create: true`, so a missing file is simply made anew.
 *
 * Prepare links this file as each release's `.env` only after its checks;
 * both prepare and `switch bot` refuse overrides before that release runs.
 *
 * Read for variable names only. Values are never kept, compared or printed.
 */

import { existsSync, readFileSync } from "node:fs";
import { DeployError } from "./errors";
import type { Context } from "./host";
import { sharedFile } from "./layout";

/**
 * Set by the ecosystem for the bot (the first five), or left unset so the
 * bot's `/archive sync` runs in the bot's own release (`PUZZLE_ACTIVITY_DIR`).
 */
export const DEPLOY_OWNED_BOT_VARIABLES = ["DATABASE_PATH", "BUILD_ID", "STATUS_FILE", "STATS_DB", "PATH", "PUZZLE_ACTIVITY_DIR"] as const;

// python-dotenv's binding grammar, with no value decoding: quoted values may
// span lines, and a quoted key is a key too. Looking at each physical line
// both missed 'STATS_DB'=… and mistook text inside a multiline value for a key.
// Python's Unicode \s differs from JavaScript's: it includes NEL and the
// information separators, and does not include the byte-order mark.
const UNICODE_SPACE = "\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACE_CHARS = `\\t-\\r\\x1c-\\x20${UNICODE_SPACE}`;
const INLINE_SPACE_CHARS = `\\t\\v\\f\\x1c-\\x20${UNICODE_SPACE}`;
const SPACE = new RegExp(`[${SPACE_CHARS}]*`, "y");
const EXPORT = new RegExp(`(?:export[${INLINE_SPACE_CHARS}]+)?`, "y");
const KEY_QUOTED = /'([^']+)'/y;
const KEY = new RegExp(`([^=#${SPACE_CHARS}]+)`, "y");
const HORIZONTAL_SPACE = new RegExp(`[${INLINE_SPACE_CHARS}]*`, "y");
const EQUAL = new RegExp(`=[${INLINE_SPACE_CHARS}]*`, "y");
const VALUE_SINGLE = /'(?:\\'|[^'])*'/y;
const VALUE_DOUBLE = /"(?:\\"|[^"])*"/y;
const VALUE_PLAIN = /[^\r\n]*/y;
const COMMENT = new RegExp(`(?:[${INLINE_SPACE_CHARS}]*#[^\\r\\n]*)?`, "y");
const END = new RegExp(`[${INLINE_SPACE_CHARS}]*(?:\\r\\n|\\n|\\r|$)`, "y");
const REST_OF_LINE = /[^\r\n]*(?:\r\n|\r|\n)?/y;
const INVALID_BINDING = Symbol("invalid dotenv binding");

/** The names a dotenv text assigns, in order, each once. */
export function assignedNames(text: string): readonly string[] {
  let position = 0;
  const names = new Set<string>();
  function read(pattern: RegExp): RegExpExecArray {
    pattern.lastIndex = position;
    const match = pattern.exec(text);
    if (match === null) throw INVALID_BINDING;
    position = pattern.lastIndex;
    return match;
  }
  while (position < text.length) {
    try {
      read(SPACE);
      if (position === text.length) break;
      read(EXPORT);
      const key = text[position] === "#" ? null : read(text[position] === "'" ? KEY_QUOTED : KEY)[1]!;
      read(HORIZONTAL_SPACE);
      const assigned = text[position] === "=";
      if (assigned) {
        read(EQUAL);
        read(text[position] === "'" ? VALUE_SINGLE : text[position] === '"' ? VALUE_DOUBLE : VALUE_PLAIN);
      }
      read(COMMENT);
      read(END);
      if (key !== null && assigned) names.add(key);
    } catch (error) {
      if (error !== INVALID_BINDING) throw error;
      // Match python-dotenv's recovery from a malformed binding: discard
      // what remains of that line, starting where parsing failed.
      read(REST_OF_LINE);
    }
  }
  return [...names];
}

/** Refuse a bot.env that sets anything in {@link DEPLOY_OWNED_BOT_VARIABLES}, naming the variables only. */
export function requireBotEnvLeavesDeployVariables(ctx: Context): void {
  const path = sharedFile(ctx.layout, "botEnv");
  if (!existsSync(path)) return; // requireSharedFiles reports a missing one
  const owned: ReadonlySet<string> = new Set(DEPLOY_OWNED_BOT_VARIABLES);
  const clashes = assignedNames(readFileSync(path, "utf8")).filter((name) => owned.has(name));
  if (clashes.length === 0) return;
  throw new DeployError(
    `${path} sets ${clashes.join(", ")}. The bot loads that file over its own environment, so it would beat what the ` +
      "deploy gives the bot and its /archive sync — the shared database, stats.db, status file, build id and PATH — " +
      "and PUZZLE_ACTIVITY_DIR would run the sync outside the bot's release. Delete those lines from bot.env and run this again.",
  );
}
