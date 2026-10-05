/**
 * What the puzzle database shows, decided once.
 *
 * Four constants, and every one is the owner's call rather than the code's —
 * `CLAUDE.md` lists them under decisions that are not an implementer's to
 * make. They are constants and not settings on purpose. A setting can be
 * flipped on one box at two in the morning with no review and no release note;
 * each of these decides what strangers can read about the club's players and
 * its history, and changing one should be a commit somebody looked at.
 *
 * The rules below, and the build's naming of servers, are the only places the
 * constants are read, so a test can hand in a different policy and pin the
 * boundaries without knowing the numbers.
 */

import { DAILY_TIERS, type DailyTier } from "../../shared/daily";
import { COMMUNITY_ID_BASE } from "../../shared/puzzle";
import type { Policy } from "./types";

/**
 * The first day the daily was dealt as tiers.
 *
 * Every earlier `day_puzzles` row is the one-time backfill the game wrote when
 * it first opened its database (`Store.pinPastDays`, `server/db.ts`): what the
 * rotation *would* have dealt on days when nobody was dealt tiers at all.
 * Showing those as history would present a derivation as a record.
 *
 * A fact about the production box, not about the code, read from its own
 * `runs` on 2026-10-05. Days 245 and 246 hold only `legacy` runs: one puzzle a
 * day, with tier rows the backfill derived afterwards. Day 247 is the first
 * with tiered runs (and the last with legacy ones: tiers reached the box that
 * day). The commit date, 2026-09-02 = day 245, was two days early.
 */
export const FIRST_TIERED_DAY = 247;

/**
 * The first day dealt with an extreme tier.
 *
 * On an earlier day an `extreme` row is not something anybody was dealt. It is
 * a top-up: `DaySchedule` completes a three-tier day with a fourth puzzle the
 * moment anything views it (`pinFor`, `server/schedule.ts`), and the bot's
 * `/api/recap` views finished days. So a day played with three tiers can hold
 * four rows today, and only the date tells the fourth apart.
 *
 * Read from the production box's `runs` in the same way as
 * {@link FIRST_TIERED_DAY}. Day 251 holds an `extreme` row and no extreme
 * runs: the fourth tier reached the box late that evening, Pacific time, and
 * topped the day up. Day 252 is the first dealt with four tiers. The commit
 * date, 2026-09-08 = day 251, was a day early.
 */
export const FIRST_EXTREME_DAY = 252;

/**
 * Off. A community puzzle's author is the submitter's Discord display name
 * (`insertSubmission`, `server/submissions.ts`), today shown only to players
 * signed in to the game, and nobody who wrote one was asked whether it could
 * go on the open web. Turning this on is a reviewed code change with a release
 * note, never a setting.
 *
 * Off withholds the puzzle and its id: a day that dealt one shows the tier and
 * says a player wrote it, and names neither.
 */
export const PUBLISH_COMMUNITY_PUZZLES = false;

/**
 * A set nobody can change once it is made. `Object.freeze` alone does not do
 * it: a frozen `Set` still answers `add`, because its entries are not
 * properties.
 */
class FixedSet<T> extends Set<T> {
  constructor(entries: Iterable<T>) {
    super();
    for (const entry of entries) super.add(entry);
    Object.freeze(this);
  }

  override add(): this {
    throw new TypeError("This set is fixed: change it in the source, as a reviewed commit");
  }

  override delete(): boolean {
    throw new TypeError("This set is fixed: change it in the source, as a reviewed commit");
  }

  override clear(): void {
    throw new TypeError("This set is fixed: change it in the source, as a reviewed commit");
  }
}

/**
 * Servers whose Discord name the site never prints, by their public key
 * (`guilds.public_key`, the ten characters after `?server=` in the site's own
 * links). Empty: every server shows the name Discord gave it at a player's
 * last sign-in from it.
 *
 * A listed server renders "Unnamed server", exactly as one nobody has signed
 * in from since names were first kept, so a reader cannot tell a server that
 * asked from one that never had a name. Its boards stay; only the name goes.
 * The build applies it, rather than the snapshot's SQL, so that the snapshot
 * keeps the signature the refresher calls it with; the name may sit in memory
 * for the length of a build and never reaches a public byte.
 *
 * Keyed by the opaque key rather than the guild id because the id must never
 * appear in this repository, which is public. A key is shaped by
 * `PUBLIC_KEY_PATTERN` (`shared/site.ts`), and the policy test refuses an entry
 * that is not, because a mistyped key would hide nothing and say nothing.
 * Adding or removing one is the owner's call, and takes a site restart.
 */
export const HIDDEN_SERVER_KEYS: ReadonlySet<string> = new FixedSet<string>([]);

/** The constants as the value a build is handed. Frozen: nothing may edit the policy in flight. */
export const POLICY: Policy = Object.freeze({
  publishCommunity: PUBLISH_COMMUNITY_PUZZLES,
  firstTieredDay: FIRST_TIERED_DAY,
  firstExtremeDay: FIRST_EXTREME_DAY,
  hiddenServerKeys: HIDDEN_SERVER_KEYS,
});

const NO_TIERS: readonly DailyTier[] = Object.freeze([]);
const THREE_TIERS: readonly DailyTier[] = Object.freeze(DAILY_TIERS.filter((tier) => tier !== "extreme"));
const ALL_TIERS: readonly DailyTier[] = Object.freeze([...DAILY_TIERS]);

/**
 * The tiers a day was actually dealt, in daily order.
 *
 * None before the first tiered day, which is backfill; easy, medium and hard
 * until extreme began; all four after. The snapshot's SQL already starts
 * history at the first tiered day, and this says so again on purpose: it is
 * the rule every pin passes through on its way out, so a pin that reached it by
 * any other road still cannot present backfill as history.
 */
export function tiersShownOn(day: number, policy: Policy = POLICY): readonly DailyTier[] {
  if (day < policy.firstTieredDay) return NO_TIERS;
  return day < policy.firstExtremeDay ? THREE_TIERS : ALL_TIERS;
}

/**
 * Whether a puzzle is kept off the site: a player wrote it, and the switch is off.
 *
 * The id band is the only record of where a puzzle came from — see
 * {@link COMMUNITY_ID_BASE} — so the band is what is checked.
 */
export function isWithheld(puzzleId: number, policy: Policy = POLICY): boolean {
  return !policy.publishCommunity && puzzleId >= COMMUNITY_ID_BASE;
}
