#!/usr/bin/env bun
/**
 * Turns the puzzle archive spreadsheet into `data/puzzles.json`.
 *
 * The archive stores each puzzle as two blueprint codes — the position and the
 * author's answer — plus loose metadata. This script decodes both, replays the
 * answer through the real engine to learn what it actually sends, and writes a
 * flat file the server can load without a decoder.
 *
 *     bun run tools/build-puzzles.ts [--archive ../tmp] [--out data/puzzles.json]
 *
 * Puzzles whose answer cannot be replayed are reported and skipped: a puzzle
 * with no verified target is a puzzle nobody can be scored against.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BlueprintDecodeError, decodeBlueprint } from "../shared/blueprint/decode";
import { pieceCells, type Playfield } from "../shared/blueprint/playfield";
import {
  type BoardCell,
  encodeBoard,
  type Mino,
  type Puzzle,
  type SolutionStep,
} from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { replayPlacements } from "../shared/tetris/replay";
import { alignPlacements } from "./align-placements";
import { parseCsv } from "./csv";

const CODES_SHEET = "Copy of Puzzles Archive - blueprint urls.csv";
const META_SHEET = "Copy of Puzzles Archive - Puzzles.csv";

interface CliOptions {
  archive: string;
  out: string;
  solutions: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    archive: "../tmp",
    out: "data/puzzles.json",
    solutions: "data/solutions.json",
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--archive") options.archive = value;
    else if (flag === "--out") options.out = value;
    else throw new Error(`Unknown flag ${flag}`);
  }
  return options;
}

/** Row lookup keyed by puzzle id, tolerating the archive's stray whitespace. */
function indexById(rows: string[][]): Map<number, string[]> {
  const byId = new Map<number, string[]>();
  for (const row of rows) {
    const id = Number.parseInt(row[0]?.trim() ?? "", 10);
    if (Number.isFinite(id)) byId.set(id, row.map((cell) => cell.trim()));
  }
  return byId;
}

function toBoardCells(playfield: Playfield): BoardCell[][] {
  return playfield.toRows(playfield.stackHeight).map((row) =>
    row.map((cell) => {
      if (cell === null) return null;
      // 'u' marks the wall outside the field and never appears inside a puzzle.
      return cell === "g" ? "G" : cell === "u" ? null : (cell as Mino);
    }),
  );
}

interface DecodedPosition {
  board: BoardCell[][];
  queue: Mino[];
  hold: Mino | null;
  goal: string;
}

function decodePosition(code: string): DecodedPosition {
  const page = decodeBlueprint(code).pages[0];
  if (!page) throw new Error("Blueprint decoded to no pages");
  if (!page.piece) throw new Error("Position has no active piece to start from");
  return {
    board: toBoardCells(page.playfield),
    queue: [page.piece.type, ...page.queue.previews],
    hold: page.queue.hold,
    goal: page.comment.trim(),
  };
}

/** Only locked pages are placements; the rest are editor snapshots. */
function decodeAnswerPlacements(code: string) {
  return decodeBlueprint(code)
    .pages.filter((page) => page.locked && page.piece !== null)
    .map((page) => ({
      piece: page.piece!.type,
      cells: pieceCells(page.piece!).map(({ x, y }) => [x, y] as const),
    }));
}

interface BuildFailure {
  id: number;
  reason: string;
}

function buildPuzzle(
  id: number,
  codes: string[],
  meta: string[] | undefined,
): Puzzle {
  const position = decodePosition(codes[1] ?? "");
  const answerCode = codes[2] ?? "";
  if (!answerCode) throw new Error("No answer blueprint on file");

  const recorded = decodeAnswerPlacements(answerCode);
  if (recorded.length === 0) throw new Error("Answer blueprint places no pieces");
  const placements = alignPlacements(recorded, position.queue, position.hold);
  if (placements.length === 0) {
    throw new Error("No placement in the answer can be reached with the puzzle's pieces");
  }

  const setup = { board: position.board, queue: position.queue, hold: position.hold };
  const replay = replayPlacements(setup, DEFAULT_HANDLING, placements);
  if (replay.totalAttack === 0) throw new Error("Answer sends no attack — nothing to score");

  const solution: SolutionStep[] = replay.steps.map((step) => ({
    piece: step.piece,
    cells: step.cells.map(([x, y]) => [x, y] as const),
    clear: step.clear,
    attack: step.attack,
  }));

  const difficulty = Number.parseFloat(meta?.[2] ?? "");
  return {
    id,
    title: (meta?.[1] || codes[4] || `Puzzle ${id}`).trim(),
    author: (meta?.[3] || "unknown").trim(),
    difficulty: Number.isFinite(difficulty) ? difficulty : 0,
    goal: position.goal,
    set: meta?.[7]?.trim() || null,
    board: encodeBoard(position.board),
    queue: position.queue,
    hold: position.hold,
    targetAttack: replay.totalAttack,
    solution,
    source: { puzzle: codes[1] ?? "", solution: answerCode },
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const read = (sheet: string) => parseCsv(readFileSync(join(options.archive, sheet), "utf8"));

  const codesById = indexById(read(CODES_SHEET).slice(1));
  const metaById = indexById(read(META_SHEET).slice(1));

  const puzzles: Puzzle[] = [];
  const failures: BuildFailure[] = [];

  for (const [id, codes] of [...codesById].sort(([a], [b]) => a - b)) {
    if (!codes[1]) continue;
    try {
      puzzles.push(buildPuzzle(id, codes, metaById.get(id)));
    } catch (error) {
      const reason =
        error instanceof BlueprintDecodeError || error instanceof Error
          ? error.message
          : String(error);
      failures.push({ id, reason });
    }
  }

  if (puzzles.length === 0) {
    // Writing here would replace a good archive with an empty one, and the
    // failure list below is the only clue anything went wrong.
    console.error(`built nothing — ${options.out} left untouched`);
    for (const { id, reason } of failures) console.error(`  #${id}: ${reason}`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(options.out), { recursive: true });
  // Two files, and only one of them is tracked. The answers are the whole game
  // — a puzzle whose solution sits beside it in a public repository is a puzzle
  // with a published answer key — so they go to their own file, which
  // .gitignore keeps out of the repo, and the server merges them back at load.
  const prompts = puzzles.map(({ solution: _s, source: _src, ...prompt }) => prompt);
  writeFileSync(options.out, `${JSON.stringify({ puzzles: prompts }, null, 1)}\n`);
  writeFileSync(
    options.solutions,
    `${JSON.stringify(
      {
        solutions: puzzles.map((puzzle) => ({
          id: puzzle.id,
          solution: puzzle.solution,
          source: puzzle.source,
        })),
      },
      null,
      1,
    )}\n`,
  );

  const goalAgreement = puzzles.filter((p) => goalMatchesSolution(p)).length;
  console.log(`built ${puzzles.length} puzzles -> ${options.out}`);
  console.log(`  stated goal matches replayed clears: ${goalAgreement}/${puzzles.length}`);
  console.log(`  attack range: ${Math.min(...puzzles.map((p) => p.targetAttack))}–${Math.max(...puzzles.map((p) => p.targetAttack))}`);
  if (failures.length > 0) {
    console.log(`\nskipped ${failures.length}:`);
    for (const { id, reason } of failures) console.log(`  #${id}: ${reason}`);
  }
}

/**
 * A rough cross-check: the author's prose goal should mention roughly the same
 * clears the replay produced. Only reported, never enforced — the prose is
 * free-form and the engine is the authority.
 */
function goalMatchesSolution(puzzle: Puzzle): boolean {
  const goal = puzzle.goal.toLowerCase();
  const counts = new Map<string, number>();
  // Built here a few lines up, so it is present by construction.
  for (const step of puzzle.solution ?? []) {
    if (step.clear) counts.set(step.clear, (counts.get(step.clear) ?? 0) + 1);
  }
  const aliases: Record<string, readonly string[]> = {
    tsd: ["tsd", "t-spin double"],
    tst: ["tst", "t-spin triple"],
    tss: ["tss", "t-spin single"],
    quad: ["quad", "tetris"],
  };
  for (const [clear, count] of counts) {
    const names = aliases[clear];
    if (!names) continue;
    if (!names.some((name) => goal.includes(name))) return false;
    // The prose is free-form ("2 TSDs", "Clear 3 TSDs.", "3TSD in one combo"),
    // so the count only has to appear next to the clear's name somewhere.
    if (count > 1 && !new RegExp(`${count}\\s*(x\\s*)?`).test(goal)) return false;
  }
  return counts.size > 0;
}

main();
