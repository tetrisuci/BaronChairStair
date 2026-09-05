/**
 * Drag parity corpus: hollow == lock == server replay, everywhere.
 *
 * Every number the drag path promises comes out of engine internals — that a
 * same-frame tap holds nothing, that one held tick drops the piece fully at
 * instant sdf, that zero subframes keep slice phases inert, that snapshots
 * restore input and stats. Any `@haelp/teto` upgrade can silently change one
 * of those, and nothing else in the suite would catch it: the targeted tests
 * pin a handful of seats, this sweeps pieces × rotations × spots × boards ×
 * handling and asserts the one load-bearing invariant — a solid hollow is a
 * seat the committed log lands on, exactly, as the server replays it.
 *
 * Kept sharp rather than exhaustive: four pieces cover the distinct SRS kick
 * tables (I, T, S, J), three rotation modes cover kicked starts, four spots
 * cover both walls, open floor and the staircase nook, on empty and stair
 * boards. Default handling runs all seven pieces; the slow-drop and fast-hands
 * profiles run the kick-cover subset.
 */

import { describe, expect, test } from "bun:test";
import { PuzzleRun } from "../client/src/game/runner";
import { decodeBoard, ENGINE_ROWS, type Mino, type PuzzlePrompt } from "../shared/puzzle";
import { DEFAULT_HANDLING, type Handling } from "../shared/tetris/handling";
import { type InputEvent, verifyRun } from "../shared/tetris/verify";
import { pump, pumpUntil, resetHarness, SAFE_LOCK_FRAMES } from "./harness";

const ALL_PIECES: readonly Mino[] = ["I", "O", "S", "T", "Z", "J", "L"];
/** I/T/S/J span the distinct SRS kick tables; the rest ride along on default. */
const KICK_COVER: readonly Mino[] = ["I", "T", "S", "J"];

type RotationMode = "none" | "tapCW" | "tapCCW";
const MODES: readonly RotationMode[] = ["none", "tapCW", "tapCCW"];

const SPOTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [9, 0],
  [4, 0],
  [1, 1],
];

const BOARDS: Record<string, PuzzlePrompt["board"]> = {
  empty: [],
  stair: ["....XXXXXX", "...XXXXXXX", "..XXXXXXXX"],
};

const PROFILES: readonly { readonly name: string; readonly handling: Handling; readonly pieces: readonly Mino[] }[] = [
  { name: "default handling", handling: DEFAULT_HANDLING, pieces: ALL_PIECES },
  { name: "slow drop", handling: { ...DEFAULT_HANDLING, sdf: 5 }, pieces: KICK_COVER },
  { name: "fast hands", handling: { ...DEFAULT_HANDLING, das: 17, arr: 8 }, pieces: KICK_COVER },
];

function sortCells(cells: readonly (readonly [number, number])[]): string {
  return cells.map(([x, y]) => `${x},${y}`).sort().join(" ");
}

describe("drag parity corpus", () => {
  for (const profile of PROFILES) {
    test(`hollow == lock == server replay under ${profile.name}`, () => {
      const failures: string[] = [];
      for (const [boardName, board] of Object.entries(BOARDS)) {
        for (const piece of profile.pieces) {
          for (const mode of MODES) {
            for (const [column, row] of SPOTS) {
              resetHarness();
              const where = `${boardName}/${piece}/${mode}@(${column},${row})`;
              const run = new PuzzleRun(
                {
                  id: 1, title: "corpus", author: "corpus", difficulty: 1,
                  goal: "parity", set: null, board,
                  queue: [piece, "O", "O", "O", "O", "O"] as const,
                  hold: null, targetAttack: 999,
                },
                profile.handling,
                { onFrame: () => {}, onFinish: () => {}, onLock: () => {} },
              );
              if (mode === "tapCW") run.tap("rotateCW");
              else if (mode === "tapCCW") run.tap("rotateCCW");
              run.aimAt({ column, row });
              const aim = run.view().aim;
              if (!aim || !aim.legal) {
                if (run.placeAt()) failures.push(`${where}: dashed hollow committed`);
                run.dispose();
                continue;
              }
              const hollow = sortCells(aim.cells);
              if (!run.placeAt()) {
                failures.push(`${where}: solid hollow refused to commit (hollow=${hollow})`);
                run.dispose();
                continue;
              }
              pumpUntil(() => run.snapshot().piecesPlaced === 1);
              pump(SAFE_LOCK_FRAMES);
              if (run.snapshot().piecesPlaced !== 1) {
                failures.push(`${where}: committed but never locked (hollow=${hollow})`);
                run.dispose();
                continue;
              }
              const log = structuredClone(run.log()) as InputEvent[];
              const verified = verifyRun(
                {
                  board: decodeBoard(board, ENGINE_ROWS),
                  queue: [piece, "O", "O", "O", "O", "O"] as const,
                  hold: null,
                },
                profile.handling,
                log,
              );
              if (verified.placements.length !== 1) {
                failures.push(`${where}: server saw ${verified.placements.length} placements (hollow=${hollow})`);
              } else {
                const locked = sortCells(verified.placements[0]!.cells);
                if (locked !== hollow) {
                  failures.push(`${where}: hollow=${hollow} locked=${locked}`);
                }
              }
              run.dispose();
            }
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
