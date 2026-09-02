/**
 * The order the duel client does two things in.
 *
 * Painting a board and mounting the screen it is painted onto are separate
 * steps here, and they are separated by nothing — no await, no frame — so the
 * only thing keeping them in the right order is the order they are written in.
 * That is thin enough to be worth a test: get it backwards and the first frame
 * of a round lands on a playfield that is not on the page yet, leaving whatever
 * was drawn there last on screen. A puzzle has no gravity, so nothing repaints
 * it until the player presses a key.
 *
 * No document is needed for any of this. The runner's view and snapshot are
 * plain data, and the loop it starts is stubbed out below.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DuelClient } from "../client/src/game/duel";
import type { DuelEvent, DuelView } from "../shared/duel";
import { type Puzzle, toPrompt } from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";

// The runner drives itself off animation frames, which exist in a browser.
globalThis.requestAnimationFrame ??= ((): number => 0) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame ??= ((): void => {}) as typeof cancelAnimationFrame;

const archive: Puzzle[] = JSON.parse(readFileSync("data/puzzles.json", "utf8")).puzzles;
const prompt = toPrompt(archive[0]!);
const duel = { id: "d", phase: "playing", settings: {}, players: [] } as unknown as DuelView;

/** Records which callback ran, in the order they ran. */
function trace(): { calls: string[]; client: DuelClient } {
  const calls: string[] = [];
  const mark = (name: string) => () => void calls.push(name);
  const client = new DuelClient("ws://not-connected", DEFAULT_HANDLING, {
    onFrame: mark("frame"),
    onState: mark("state"),
    onRound: mark("round"),
    onRushPuzzle: mark("rush"),
    onOpponent: mark("opponent"),
    onRoundOver: mark("roundOver"),
    onMatchOver: mark("matchOver"),
    onLobbies: mark("lobbies"),
    onError: mark("error"),
    onClosed: mark("closed"),
  });
  return { calls, client };
}

function deliver(client: DuelClient, event: DuelEvent): void {
  (client as unknown as { receive(event: DuelEvent): void }).receive(event);
}

describe("a round is put on screen before it is drawn", () => {
  test("the round frame mounts the playfield before the first board frame", () => {
    const { calls, client } = trace();
    deliver(client, {
      type: "round",
      round: 1,
      puzzle: prompt,
      endsAt: Date.now() + 60_000,
      duel,
    });
    expect(calls[0]).toBe("round");
    expect(calls).toContain("frame");
    expect(calls.indexOf("round")).toBeLessThan(calls.indexOf("frame"));
  });

  test("a rush puzzle does the same", () => {
    const { calls, client } = trace();
    deliver(client, {
      type: "rush",
      index: 0,
      puzzle: prompt,
      endsAt: Date.now() + 60_000,
      solved: 0,
      skipsLeft: 2,
      duel,
    });
    expect(calls.indexOf("rush")).toBeLessThan(calls.indexOf("frame"));
  });

  test("a spent rush stack still tells the screen, and paints nothing", () => {
    const { calls, client } = trace();
    deliver(client, {
      type: "rush",
      index: 0,
      puzzle: null,
      endsAt: Date.now() + 60_000,
      solved: 3,
      skipsLeft: 0,
      duel,
    });
    expect(calls).toEqual(["rush"]);
  });
});
