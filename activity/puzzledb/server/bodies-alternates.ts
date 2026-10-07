/**
 * `/data/alternates.json`: every published line, across every listed puzzle,
 * for the alternates table to sort.
 *
 * Beside `bodies.ts` rather than in it only for length; the rule is the same
 * one. It is cut from {@link PlayerData.lines}, what was read back out of the
 * public `lines` table, and from the listed puzzles in {@link SiteData} — so a
 * row cannot say anything the download does not, and a line on a puzzle the
 * site does not list cannot reach it even if the table ever held one.
 *
 * **No steps.** A sort needs every row at once, so this body grows with every
 * line found; the steps would make it heavy, and each puzzle's own body
 * already carries them, which is where a row's link goes. A row's `pieces` is
 * its steps counted, the same number a puzzle page's chip prints.
 */

import type { SiteData } from "../wire";
import type { SiteAlternateRow, SiteAlternatesBody } from "../wire-alternates";
import type { PlayerData } from "./public-db-players";

/** Every listed puzzle's published lines, by puzzle then position, as the table reads them. */
export function alternatesBody(data: SiteData, players: PlayerData, builtAt: string): SiteAlternatesBody {
  const listed = new Set(data.puzzles.map((puzzle) => puzzle.id));
  return {
    builtAt,
    lines: players.lines
      .filter((line) => listed.has(line.puzzleId))
      .map(
        (line): SiteAlternateRow => ({
          puzzleId: line.puzzleId,
          position: line.position,
          day: line.day,
          attack: line.attack,
          pieces: line.steps.length,
          clears: line.clears,
        }),
      ),
  };
}
