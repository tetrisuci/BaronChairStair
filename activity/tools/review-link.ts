#!/usr/bin/env bun
/**
 * Mints a link that lets one person into the review queue.
 *
 *     bun run review-link -- hannah
 *     bun run review-link -- hannah --minutes 5 --base https://puzzle.example
 *
 * Run on the VPS, from `activity/`, by whoever has SSH to it. That is the whole
 * trust root and this file does not pretend otherwise: `<who>` is an
 * attribution that lands in `submissions.reviewed_by`, not an identity anything
 * checks.
 *
 * **Read-only, deliberately.** It signs a string, prints it and exits. It never
 * constructs a `Store`, because that runs the whole `SCHEMA` plus the
 * `addSlotsToRuns` DROP/copy/rename rebuild on every construction — and nothing
 * anywhere in this repo sets `busy_timeout`, so a second writer against the
 * live WAL database fails instantly rather than waiting. A one-off command that
 * can take the server's database down is not a one-off command.
 *
 * **It reads `REVIEW_SECRET` from the environment directly**, and imports
 * `server/review-token.ts` rather than anything that touches `server/config.ts`.
 * Two reasons, both about being run by hand on a live box. `config.ts` calls
 * `required("DISCORD_CLIENT_SECRET")` under NODE_ENV=production and throws at
 * import unless the entire production environment is present — measured, from a
 * directory with no `.env` in it, which is exactly where somebody runs a one-off
 * command. And `config.sessionSecret` falls back to a random per-process key
 * outside production with only a `console.warn`, so a run from the wrong
 * directory would print a perfectly-formed link that the server answers with
 * "Bad review link signature". Unset means exit, not fall back.
 */

import { MAX_LINK_MINUTES, mintReviewGrant } from "../server/review-token";

/** Long enough to walk to a laptop, short enough that a leak ages out. */
const DEFAULT_MINUTES = 15;

const USAGE =
  "usage: bun run review-link -- <who> [--minutes 15] [--base https://host]\n" +
  "  who       the name that goes in the audit column, e.g. a Discord handle\n" +
  `  --minutes how long the link works for, 1 to ${MAX_LINK_MINUTES} (default ${DEFAULT_MINUTES})\n` +
  "  --base    public origin to print the link against; defaults to $REVIEW_BASE_URL";

interface Options {
  readonly subject: string;
  readonly minutes: number;
  readonly base: string;
}

/**
 * Reads the flags, refusing anything it does not understand.
 *
 * `Number` rather than `Number.parseInt` for the same reason `finishedDay` in
 * `server/index.ts` gives: parseInt reads "15m" as 15 and would mint something
 * other than what the operator typed, silently.
 */
function parseArgs(argv: readonly string[]): Options {
  let subject: string | null = null;
  let minutes = DEFAULT_MINUTES;
  let base = process.env.REVIEW_BASE_URL ?? "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--minutes" || arg === "--base") {
      const value = argv[++i];
      if (value === undefined) fail(`Missing value for ${arg}`);
      if (arg === "--base") base = value;
      else {
        minutes = Number(value);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_LINK_MINUTES) {
          fail(`--minutes must be a whole number between 1 and ${MAX_LINK_MINUTES}, got "${value}"`);
        }
      }
      continue;
    }
    if (arg.startsWith("--")) fail(`Unknown flag ${arg}`);
    if (subject !== null) fail(`Expected one name, got "${subject}" and "${arg}"`);
    subject = arg;
  }

  if (!subject?.trim()) fail("Say who the link is for");
  return { subject: subject.trim(), minutes, base: base.replace(/\/+$/, "") };
}

/** Usage problems go to stderr and exit 2, the way `inspect-puzzle` does it. */
function fail(message: string): never {
  console.error(`review-link: ${message}\n\n${USAGE}`);
  process.exit(2);
}

const options = parseArgs(process.argv.slice(2));

const secret = process.env.REVIEW_SECRET ?? "";
if (!secret) {
  console.error(
    "review-link: REVIEW_SECRET is not set, so nothing this prints would be accepted.\n" +
      "Set it in activity/.env (`openssl rand -hex 32`) and restart the server — until it\n" +
      "is set the server answers the review routes with 404, not with a login.",
  );
  process.exit(1);
}

const token = await mintReviewGrant(secret, options.subject, options.minutes);
// A fragment rather than a query: a browser never sends it to the server, so
// the token stays out of the reverse proxy's access log. See `takeGrant`.
const link = `${options.base}/review#t=${token}`;

console.log(`review link for "${options.subject}", good for ${options.minutes} minutes:\n`);
console.log(`  ${link}\n`);
if (!options.base) {
  console.log(
    "That is a path, not a URL — put your public origin in front of it, or pass\n" +
      "--base / set REVIEW_BASE_URL to have it printed whole.\n",
  );
}
// Said out loud because the property is deliberate and not obvious: the link is
// a bearer capability with nothing written down behind it. Making it single-use
// would need a used-nonce table — the storage a rush ticket exists to avoid —
// and Discord's unfurler would burn it by fetching the page before the officer
// ever clicked.
// The two windows are named separately because they add up rather than
// overlap: the link is what may sit in a shell history or a DM, and spending it
// in its last second still buys a full sitting. Saying only the first number
// understates the exposure by an order of magnitude, which is the opposite of
// what a warning is for.
console.log(
  `Anyone holding this link is a reviewer. The link itself is good for ${options.minutes} minutes,\n` +
    "and spending it buys a sitting of two hours from that moment — so the worst case is\n" +
    `${options.minutes} minutes plus two hours. Send it in a DM, not a channel. There is no way to\n` +
    "revoke one link: rotating REVIEW_SECRET and restarting kills every review link at\n" +
    "once, and no player notices.",
);
