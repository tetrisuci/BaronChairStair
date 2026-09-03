/**
 * The opponent bar's arithmetic.
 *
 * The bar is all a duellist is ever shown of the other player, and what feeds
 * it arrives in a WebSocket frame that met no middleware on the way in — the
 * peer may have sent no numbers at all. Building the panel itself needs a
 * document, which `bun test` has not got; the arithmetic does not, so the guard
 * that keeps a hostile frame from throwing inside `socket.onmessage`, or from
 * writing a width the browser silently drops, is pinned here on its own.
 */

import { describe, expect, test } from "bun:test";
import { opponentRatio, rulesForMode } from "../client/src/ui/duel";
import {
  DEFAULT_DUEL_SETTINGS,
  DUEL_ROUND_MS_DEFAULT,
  DUEL_RUSH_MS_DEFAULT,
  type DuelProgress,
  type DuelSettings,
} from "../shared/duel";

/** A frame as the type promises it, with any field replaced by anything. */
function frame(patch: Record<string, unknown> = {}): DuelProgress {
  return { piecesPlaced: 2, pieceBudget: 10, attack: 0, targetAttack: 4, solved: 0, ...patch } as
    unknown as DuelProgress;
}

describe("opponentRatio", () => {
  test("reports how much of the target attack the opponent has reached", () => {
    expect(opponentRatio(frame({ attack: 1, targetAttack: 4 }))).toBe(0.25);
    expect(opponentRatio(frame({ attack: 4, targetAttack: 4 }))).toBe(1);
  });

  test("stays empty on a puzzle that asks for no attack", () => {
    expect(opponentRatio(frame({ attack: 3, targetAttack: 0 }))).toBe(0);
    expect(opponentRatio(frame({ attack: 3, targetAttack: -5 }))).toBe(0);
  });

  test("never runs past full or below empty", () => {
    expect(opponentRatio(frame({ attack: 99, targetAttack: 4 }))).toBe(1);
    expect(opponentRatio(frame({ attack: -99, targetAttack: 4 }))).toBe(0);
  });

  test("survives a frame with the numbers missing", () => {
    expect(opponentRatio(undefined)).toBe(0);
    expect(opponentRatio(null)).toBe(0);
    expect(opponentRatio({} as DuelProgress)).toBe(0);
    expect(opponentRatio(frame({ attack: null, targetAttack: null }))).toBe(0);
  });

  test("survives a frame whose numbers are not numbers", () => {
    for (const junk of ["lots", {}, [], NaN, Infinity]) {
      expect(opponentRatio(frame({ attack: junk }))).toBe(0);
      expect(opponentRatio(frame({ targetAttack: junk }))).toBe(0);
    }
  });
});

describe("switching a room between modes", () => {
  const puzzle: DuelSettings = { ...DEFAULT_DUEL_SETTINGS, rounds: 5 };

  test("rush drops the round count and takes a rush clock", () => {
    const rush = rulesForMode(puzzle, "rush", 5);
    expect(rush.mode).toBe("rush");
    expect(rush.durationMs).toBe(DUEL_RUSH_MS_DEFAULT);
  });

  test("coming back out of rush restores the best-of the host chose", () => {
    // The referee pins rounds to 1 for a rush and says so in the frame it
    // broadcasts, so this is what the form is holding when the host switches
    // back. Reading that 1 as the host's choice is the bug.
    const asServerSeesIt: DuelSettings = { ...puzzle, mode: "rush", rounds: 1 };
    const back = rulesForMode(asServerSeesIt, "puzzle", 5);
    expect(back.rounds).toBe(5);
    expect(back.durationMs).toBe(DUEL_ROUND_MS_DEFAULT);
  });

  test("the difficulty band survives the trip either way", () => {
    const banded: DuelSettings = { ...puzzle, minDifficulty: 6, maxDifficulty: 9 };
    for (const mode of ["rush", "puzzle"] as const) {
      const next = rulesForMode(banded, mode, 5);
      expect(next.minDifficulty).toBe(6);
      expect(next.maxDifficulty).toBe(9);
    }
  });
});
