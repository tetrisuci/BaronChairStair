/**
 * The counts a status file reports about who is using the game right now.
 *
 * The deploy reads these to decide whether a handover is quiet enough, so a
 * count that never falls is a deploy that never finishes, and a count that
 * falls too early is a player cut off mid-rush. Each one is driven here by a
 * hand-turned clock rather than by waiting.
 */

import { describe, expect, test } from "bun:test";
import { Activity } from "../server/activity";
import { RECENT_RUSH_MS, RECENT_SESSION_MS } from "../shared/runtime-status";

const START = 1_791_300_000_000;
const MINUTE = 60_000;

function clockAt(start = START) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("requests in flight", () => {
  test("counts a request from the moment it starts until it is answered", () => {
    const activity = new Activity(clockAt().now);
    activity.requestStarted();
    activity.requestStarted();
    expect(activity.counts().inflight).toBe(2);
    activity.requestFinished();
    expect(activity.counts().inflight).toBe(1);
    activity.requestFinished();
    expect(activity.counts().inflight).toBe(0);
  });

  test("never reports fewer than none, whatever order the calls arrive in", () => {
    const activity = new Activity(clockAt().now);
    activity.requestFinished();
    expect(activity.counts().inflight).toBe(0);
  });
});

describe("recent sessions", () => {
  test("counts players, not requests", () => {
    const activity = new Activity(clockAt().now);
    activity.sawSession("player-one");
    activity.sawSession("player-one");
    activity.sawSession("player-two");
    expect(activity.counts().sessionsRecent).toBe(2);
  });

  test("forgets a player once the window has passed without a request from them", () => {
    const clock = clockAt();
    const activity = new Activity(clock.now);
    activity.sawSession("early");
    clock.advance(RECENT_SESSION_MS - 1);
    activity.sawSession("late");
    expect(activity.counts().sessionsRecent).toBe(2);
    clock.advance(1);
    expect(activity.counts().sessionsRecent).toBe(1);
    clock.advance(RECENT_SESSION_MS);
    expect(activity.counts().sessionsRecent).toBe(0);
  });

  test("a later request keeps a player recent", () => {
    const clock = clockAt();
    const activity = new Activity(clock.now);
    activity.sawSession("steady");
    activity.sawSession("gone");
    clock.advance(RECENT_SESSION_MS - 1_000);
    activity.sawSession("steady");
    clock.advance(2_000);
    expect(activity.counts().sessionsRecent).toBe(1);
  });

  test("holds a bounded number of sessions however many arrive", () => {
    const activity = new Activity(clockAt().now, { sessionLimit: 3 });
    for (const id of ["a", "b", "c", "d", "e"]) activity.sawSession(id);
    expect(activity.counts().sessionsRecent).toBe(3);
  });

  test("lets go of a player whose window has passed even when nothing reads the counts", () => {
    // A box with no STATUS_FILE never asks for the counts, so a player who
    // has moved on must be forgotten on the way in, not only on the way out.
    const clock = clockAt();
    const activity = new Activity(clock.now);
    for (let minute = 0; minute < 3 * (RECENT_SESSION_MS / MINUTE); minute++) {
      activity.sawSession(`player-${minute}`);
      clock.advance(MINUTE);
    }
    expect(activity.held().sessions).toBeLessThanOrEqual(RECENT_SESSION_MS / MINUTE);
  });
});

describe("recent rush tickets", () => {
  test("counts every ticket minted within a rush and its grace", () => {
    const clock = clockAt();
    const activity = new Activity(clock.now);
    activity.mintedRushTicket();
    clock.advance(60_000);
    activity.mintedRushTicket();
    expect(activity.counts().rushTicketsRecent).toBe(2);
    clock.advance(RECENT_RUSH_MS - 60_000);
    expect(activity.counts().rushTicketsRecent).toBe(1);
    clock.advance(60_000);
    expect(activity.counts().rushTicketsRecent).toBe(0);
  });

  test("keeps no more tickets than the window holds even when nothing reads the counts", () => {
    const clock = clockAt();
    const activity = new Activity(clock.now);
    const windowMinutes = Math.ceil(RECENT_RUSH_MS / MINUTE);
    for (let minute = 0; minute < 3 * windowMinutes; minute++) {
      activity.mintedRushTicket();
      clock.advance(MINUTE);
    }
    expect(activity.held().rushTickets).toBeLessThanOrEqual(windowMinutes);
  });
});
