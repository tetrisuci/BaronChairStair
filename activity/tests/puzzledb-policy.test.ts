/**
 * The puzzle database's three decisions, and the two rules read off them.
 *
 * The constants are the owner's, not the code's — `CLAUDE.md` lists them under
 * decisions that are not an implementer's to make — so nothing here pins their
 * values. What is pinned is how they are read: which tiers a day shows, where
 * history starts, and which puzzles stay off the open web while the switch is
 * off. Each rule is driven through a policy handed in, so the boundaries are
 * tested at the constants and not at numbers somebody would have to keep in
 * step with them.
 */

import { describe, expect, test } from "bun:test";
import { DAILY_TIERS, type DailyTier } from "../shared/daily";
import { COMMUNITY_ID_BASE } from "../shared/puzzle";
import {
  FIRST_EXTREME_DAY,
  FIRST_TIERED_DAY,
  isWithheld,
  POLICY,
  PUBLISH_COMMUNITY_PUZZLES,
  tiersShownOn,
} from "../puzzledb/server/policy";
import type { Policy } from "../puzzledb/server/types";

const THREE: readonly DailyTier[] = ["easy", "medium", "hard"];

describe("the tiers a day shows", () => {
  test("shows nothing before the first tiered day, which is backfill nobody was dealt", () => {
    expect(tiersShownOn(FIRST_TIERED_DAY - 1)).toEqual([]);
    expect(tiersShownOn(1)).toEqual([]);
  });

  test("shows three tiers from the first tiered day until extreme began", () => {
    expect(tiersShownOn(FIRST_TIERED_DAY)).toEqual(THREE);
    // A row here is a later top-up, written when something viewed the day.
    expect(tiersShownOn(FIRST_EXTREME_DAY - 1)).toEqual(THREE);
  });

  test("shows all four from the first extreme day on", () => {
    expect(tiersShownOn(FIRST_EXTREME_DAY)).toEqual([...DAILY_TIERS]);
    expect(tiersShownOn(FIRST_EXTREME_DAY + 1000)).toEqual([...DAILY_TIERS]);
  });

  test("reads the days from the policy it is handed", () => {
    const policy: Policy = { publishCommunity: false, firstTieredDay: 5, firstExtremeDay: 10 };

    expect(tiersShownOn(4, policy)).toEqual([]);
    expect(tiersShownOn(5, policy)).toEqual(THREE);
    expect(tiersShownOn(9, policy)).toEqual(THREE);
    expect(tiersShownOn(10, policy)).toEqual([...DAILY_TIERS]);
  });

  test("hands back lists nobody can edit for the next caller", () => {
    for (const day of [FIRST_TIERED_DAY - 1, FIRST_TIERED_DAY, FIRST_EXTREME_DAY]) {
      expect(Object.isFrozen(tiersShownOn(day))).toBe(true);
    }
  });
});

describe("puzzles a player wrote", () => {
  test("are withheld while the switch is off, and club puzzles never are", () => {
    expect(PUBLISH_COMMUNITY_PUZZLES).toBe(false);
    expect(isWithheld(COMMUNITY_ID_BASE)).toBe(true);
    expect(isWithheld(COMMUNITY_ID_BASE + 41)).toBe(true);
    expect(isWithheld(COMMUNITY_ID_BASE - 1)).toBe(false);
    expect(isWithheld(1)).toBe(false);
  });

  test("are listed under a policy that turns the switch on", () => {
    const listing: Policy = { ...POLICY, publishCommunity: true };

    expect(isWithheld(COMMUNITY_ID_BASE, listing)).toBe(false);
  });
});

describe("the policy", () => {
  test("is the three constants, in the order the box lived them", () => {
    expect(POLICY).toEqual({
      publishCommunity: PUBLISH_COMMUNITY_PUZZLES,
      firstTieredDay: FIRST_TIERED_DAY,
      firstExtremeDay: FIRST_EXTREME_DAY,
    });
    expect(FIRST_TIERED_DAY).toBeLessThan(FIRST_EXTREME_DAY);
  });

  test("cannot be changed at run time", () => {
    // A setting would be the wrong shape for this: turning community puzzles on
    // is a reviewed code change with a release note.
    expect(Object.isFrozen(POLICY)).toBe(true);
  });
});
