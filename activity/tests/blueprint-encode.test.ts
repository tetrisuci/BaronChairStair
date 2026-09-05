/**
 * The encoder, checked against the format rather than against itself.
 *
 * "Cross-compatible with blueprint" is a claim, and the only evidence available
 * here is the club's own archive: 138 codes written by bp.tali.software, not by
 * us. Every one is decoded, re-encoded, and decoded again — if the second
 * document matches the first then what we write is something the format's own
 * output is indistinguishable from, at least to this decoder.
 *
 * What that does not prove: that bp.tali.software reads it back. Nothing local
 * can prove that. It is why the encoder writes only the four opcodes the
 * archive itself already uses, rather than the tidiest ones available.
 */

import { describe, expect, test } from "bun:test";
import { decodeBlueprint } from "../shared/blueprint/decode";
import { encodeBlueprint } from "../shared/blueprint/encode";
import { ROWS } from "../shared/blueprint/playfield";
import { archive, hasSolutions } from "./archive";

const COLUMNS = 10;

function cellsOf(page: ReturnType<typeof decodeBlueprint>["pages"][number]) {
  const cells = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLUMNS; x++) {
      const type = page.playfield.getCell(x, y);
      if (type) cells.push({ x, y, type });
    }
  }
  return cells;
}

const codes = archive
  .map((puzzle) => ({ id: puzzle.id, code: puzzle.source?.puzzle }))
  .filter((entry): entry is { id: number; code: string } => Boolean(entry.code));

describe.skipIf(!hasSolutions)("every code the club's archive was written with", () => {
  test("survives a decode, an encode and a decode", () => {
    expect(codes.length).toBeGreaterThan(100);
    const broken: number[] = [];
    for (const { id, code } of codes) {
      const original = decodeBlueprint(code).pages[0]!;
      const again = decodeBlueprint(
        encodeBlueprint({
          cells: cellsOf(original),
          previews: original.queue.previews,
          hold: original.queue.hold,
        }),
      ).pages[0]!;

      const sameQueue = JSON.stringify(again.queue) === JSON.stringify(original.queue);
      const sameBoard = cellsOf(again).every(
        (cell, index) => JSON.stringify(cell) === JSON.stringify(cellsOf(original)[index]),
      );
      if (!sameQueue || !sameBoard) broken.push(id);
    }
    expect(broken).toEqual([]);
  });
});

describe("what the encoder writes", () => {
  test("an empty board with a queue is a legal code", () => {
    const code = encodeBlueprint({ cells: [], previews: ["T", "S", "Z"], hold: null });
    expect(code.startsWith("b1@")).toBe(true);
    const page = decodeBlueprint(code).pages[0]!;
    expect(page.queue.previews).toEqual(["T", "S", "Z"]);
    expect(page.queue.hold).toBeNull();
  });

  test("a hold piece does not eat the first preview", () => {
    // Hold is set by pushing that piece and swapping it, and SwapHold on an
    // empty hold takes the front preview — so the order this is written in is
    // the whole of whether the queue survives.
    const page = decodeBlueprint(
      encodeBlueprint({ cells: [], previews: ["I", "O"], hold: "T" }),
    ).pages[0]!;
    expect(page.queue.hold).toBe("T");
    expect(page.queue.previews).toEqual(["I", "O"]);
  });

  test("garbage and pieces are different cells", () => {
    const page = decodeBlueprint(
      encodeBlueprint({
        cells: [
          { x: 0, y: 0, type: "g" },
          { x: 1, y: 0, type: "T" },
        ],
        previews: [],
        hold: null,
      }),
    ).pages[0]!;
    expect(page.playfield.getCell(0, 0)).toBe("g");
    expect(page.playfield.getCell(1, 0)).toBe("T");
  });

  test("a gap before the first cell survives", () => {
    // The first run is "on" and may be empty; that empty run is the only way
    // the format says "the board starts with a hole".
    const page = decodeBlueprint(
      encodeBlueprint({ cells: [{ x: 4, y: 2, type: "S" }], previews: [], hold: null }),
    ).pages[0]!;
    expect(page.playfield.getCell(4, 2)).toBe("S");
    expect(page.playfield.getCell(0, 0)).toBeNull();
  });

  test("a note comes back as it was written", () => {
    const page = decodeBlueprint(
      encodeBlueprint({ cells: [], previews: ["T"], hold: null, comment: "Clear 1 TSD (v2)" }),
    ).pages[0]!;
    expect(page.comment).toBe("Clear 1 TSD (v2)");
  });

  test("every payload length the base64 reader accepts", () => {
    // `length % 4 === 1` is rejected outright by the reader, and a bit stream
    // lands there about a third of the time. Anything from one cell to a full
    // board has to come out legal.
    for (let n = 1; n <= 40; n++) {
      const cells = Array.from({ length: n }, (_, i) => ({
        x: i % COLUMNS,
        y: Math.floor(i / COLUMNS),
        type: "g" as const,
      }));
      const payload = encodeBlueprint({ cells, previews: [], hold: null }).slice(3);
      expect(payload.length % 4).not.toBe(1);
      expect(() => decodeBlueprint(`b1@${payload}`)).not.toThrow();
    }
  });
});
