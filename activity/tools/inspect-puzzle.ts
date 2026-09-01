#!/usr/bin/env bun
/**
 * Inspects one archived puzzle, for when `build-puzzles` refuses to build it.
 *
 *     bun run tools/inspect-puzzle.ts 13 70
 *
 * Prints the decoded position, every page of the answer blueprint (marking
 * which ones are real locks), which placements the puzzle's pieces can actually
 * supply, and where a replay gives up. That is enough to tell a genuinely
 * unreachable placement apart from an archive entry with a false start in it.
 */

import { readFileSync } from "node:fs";
import { decodeBlueprint } from "../shared/blueprint/decode";
import { pieceCells } from "../shared/blueprint/playfield";
import { type BoardCell, type Mino } from "../shared/puzzle";
import { createPuzzleEngine, readBoard, toLetter } from "../shared/tetris/engine";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { findPaths } from "../shared/tetris/pathfinder";
import { alignPlacements } from "./align-placements";
import { parseCsv } from "./csv";

const ARCHIVE = process.env.PUZZLE_ARCHIVE ?? "../tmp";
const CODES_SHEET = "Copy of Puzzles Archive - blueprint urls.csv";
const ENGINE_ROWS = 40;
const ROWS_SHOWN = 14;

const rows = parseCsv(readFileSync(`${ARCHIVE}/${CODES_SHEET}`, "utf8")).slice(1);
const byId = new Map(
  rows.filter((row) => row[0]?.trim()).map((row) => [row[0]!.trim(), row.map((c) => c.trim())]),
);

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: bun run tools/inspect-puzzle.ts <id> [id...]");
  process.exit(2);
}

function render(board: readonly (readonly BoardCell[])[], rowCount: number): string {
  return board
    .slice(0, rowCount)
    .map((row, y) => `  y${String(y).padStart(2)} ${row.map((cell) => cell ?? ".").join("")}`)
    .reverse()
    .join("\n");
}

for (const id of ids) {
  const row = byId.get(id);
  if (!row) {
    console.log(`\n#${id}: not in the archive`);
    continue;
  }

  const position = decodeBlueprint(row[1]!).pages[0]!;
  const queue = [position.piece!.type, ...position.queue.previews] as Mino[];
  const hold = position.queue.hold as Mino | null;
  const board: BoardCell[][] = position.playfield
    .toRows(position.playfield.stackHeight)
    .map((r) => r.map((cell) => (cell === null ? null : cell === "g" ? "G" : (cell as Mino))));

  console.log(`\n#${id} ${JSON.stringify(position.comment)}`);
  console.log(`  queue ${queue.join("")} (${queue.length})  hold ${hold ?? "-"}`);
  console.log(render(board, board.length));

  const pages = decodeBlueprint(row[2]!).pages;
  console.log(`  answer pages: ${pages.length}`);
  for (const [index, page] of pages.entries()) {
    const cells = page.piece
      ? pieceCells(page.piece).map((c) => `${c.x},${c.y}`).join(" ")
      : "—";
    console.log(
      `    ${String(index).padStart(2)} ${page.locked ? "LOCK" : "edit"} ` +
        `${page.piece?.type ?? "-"} [${cells}] h=${page.playfield.stackHeight}`,
    );
  }

  const recorded = pages
    .filter((page) => page.locked && page.piece)
    .map((page) => ({
      piece: page.piece!.type as Mino,
      cells: pieceCells(page.piece!).map((c) => [c.x, c.y] as const),
    }));
  const aligned = alignPlacements(recorded, queue, hold);
  console.log(
    `  recorded ${recorded.map((p) => p.piece).join("")} -> ` +
      `aligned ${aligned.map((p) => p.piece).join("")}`,
  );

  const { engine } = createPuzzleEngine({ board, queue, hold }, DEFAULT_HANDLING);
  for (const [index, placement] of aligned.entries()) {
    if (toLetter(engine.falling.symbol) !== placement.piece) engine.hold(false, true);
    const routes = findPaths(engine, placement.cells);
    if (routes.length === 0) {
      console.log(`  step ${index + 1}: ${placement.piece} unreachable at ${describe(placement.cells)}`);
      console.log(render(readBoard(engine, ENGINE_ROWS), ROWS_SHOWN));
      break;
    }
    for (const key of routes[0]!) engine.press(key);
    engine.press("hardDrop");
  }
}

function describe(cells: readonly (readonly [number, number])[]): string {
  return cells.map(([x, y]) => `${x},${y}`).join(" ");
}
