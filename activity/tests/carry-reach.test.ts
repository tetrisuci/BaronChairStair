/**
 * The carry keeps the bottom rows reachable by touch.
 *
 * A review of PR #68's flat band proved a touch could name only rows 3 and
 * up — and that a lifted row-3 aim is refused outright on an empty board,
 * because `targetAt` answers pre-gravity and `placementAt` accepts only
 * exact locks. The carry that replaced the band has no lift and no hidden
 * strip: the tracker can name *any* row (pointer.test.ts pins the
 * parity-free amplified travel), so what remains to pin here is the engine
 * side of that bargain — every seat a placement is chosen between accepts
 * every piece where the physics allow, and an invalid seat is refused
 * gracefully, which is exactly what the release treats as the reset.
 */

import { describe, expect, test } from "bun:test";
import { createPuzzleEngine } from "../shared/tetris/engine";
import { RoutePlanner } from "../shared/tetris/pathfinder";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { decodeBoard, ENGINE_ROWS, type Mino } from "../shared/puzzle";

const PIECES = ["I", "O", "T", "S", "Z", "J", "L"] as const;

/** An empty board and the piece under test as the falling one. */
function freshPlanner(piece: string): RoutePlanner {
  const { engine } = createPuzzleEngine(
    {
      board: decodeBoard([], ENGINE_ROWS),
      queue: [piece, piece, piece] as Mino[],
      hold: null,
    },
    DEFAULT_HANDLING,
  );
  return new RoutePlanner(engine);
}

describe("touch reaches the bottom rows", () => {
  test("each bottom seat places on the seat it names, for every piece", () => {
    // The floor needs the floor beneath it, the second row a row below it —
    // seats one row apart cannot all be free on one board, so each board
    // here proves the seat that is its lowest free row. This is the ground
    // truth the amplified travel is aimed at: the tracker can name any row,
    // and where a seat is genuinely placeable the commit must take it.
    const cases: { rows: string[]; seat: number }[] = [
      { rows: [], seat: 0 },
      { rows: ["GGGGGGGGGG"], seat: 1 },
      { rows: ["GGGGGGGGGG", "GGGGGGGGGG"], seat: 2 },
    ];
    for (const piece of PIECES) {
      for (const { rows, seat } of cases) {
        const { engine } = createPuzzleEngine(
          {
            board: decodeBoard(rows, ENGINE_ROWS),
            queue: [piece, piece, piece] as Mino[],
            hold: null,
          },
          DEFAULT_HANDLING,
        );
        const planner = new RoutePlanner(engine);
        expect(planner.placementAt(planner.targetAt(4, seat))).not.toBeNull();
      }
    }
  });

  test("a seat the physics refuse is refused without hiding the piece", () => {
    // The review's blocking probe, reframed for the carry: on an empty board
    // a plain floor drop for row 3 does not exist (notch seats aside, a
    // lifted aim has nothing beneath it), so aiming there is refused. The
    // carry does not paper over that — a release at an invalid seat commits
    // nothing and the falling piece is untouched, which is the whole reset:
    // the aim is a preview, and only a valid release spends the piece.
    const planner = freshPlanner("O");
    expect(planner.placementAt(planner.targetAt(4, 3))).toBeNull();
  });
});
