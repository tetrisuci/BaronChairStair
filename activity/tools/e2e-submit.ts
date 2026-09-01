#!/usr/bin/env bun
/**
 * Plays today's puzzle against a running server, using the archived solution.
 *
 *     bun run tools/e2e-submit.ts [http://localhost:3001]
 *
 * Exercises the parts the unit tests cannot: the session handshake, the wire
 * format of a submitted run, the server's own verification, and — first of all
 * — that the practice endpoint will not hand out today's answer to somebody who
 * has not played it yet.
 */

import { readFileSync } from "node:fs";
import { decodeBoard, pieceBudget, type Puzzle } from "../shared/puzzle";
import { createPuzzleEngine, toLetter } from "../shared/tetris/engine";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import { findPaths } from "../shared/tetris/pathfinder";
import type { GameKey, InputEvent } from "../shared/tetris/verify";

const base = process.argv[2] ?? "http://localhost:3001";
const puzzles: Puzzle[] = JSON.parse(readFileSync("data/puzzles.json", "utf8")).puzzles;

async function main() {
  const session = await post("/api/session", { guildId: "e2e-guild" });
  const daily = await get("/api/daily", session.token);
  const puzzle = puzzles.find((entry) => entry.id === daily.puzzle.id);
  if (!puzzle) throw new Error(`Server served puzzle ${daily.puzzle.id}, not in local data`);

  console.log(`day ${daily.day}: #${puzzle.id} "${puzzle.title}" — ${puzzle.goal} (${puzzle.targetAttack})`);

  await assertSolutionIsWithheld(session.token, puzzle.id);

  const events = buildLog(puzzle);
  const result = await post(
    "/api/daily/run",
    { handling: DEFAULT_HANDLING, events, resets: 2, totalMs: 95_000 },
    session.token,
  );
  console.log(
    `submitted ${events.length} events -> solved=${result.run.solved} ` +
      `attack=${result.run.attack}/${result.run.targetAttack} ` +
      `verified=${result.run.durationMs}ms total=${result.run.totalMs}ms first=${result.isFirst}`,
  );
  console.log(`clears: ${result.run.clears.join(", ")}`);
  console.log(`leaderboard: ${result.leaderboard.length} entr${result.leaderboard.length === 1 ? "y" : "ies"}`);

  const replay = await post("/api/daily/run", { handling: DEFAULT_HANDLING, events, resets: 0, totalMs: 1 }, session.token);
  console.log(`resubmitting keeps the first solve: isFirst=${replay.isFirst} resets=${replay.run.resets}`);
  if (replay.isFirst) throw new Error("A second submission overwrote the first");
  if (!result.run.solved) throw new Error("The archived solution did not solve the puzzle");

  const afterwards = await get(`/api/archive/${puzzle.id}`, session.token);
  if (!afterwards.solution) throw new Error("The solution stayed hidden after a solve");
  console.log("archive releases the solution once the puzzle is solved");
}

/**
 * The practice endpoint serves the whole archive, and today's puzzle is in it.
 * A player who has not solved it must not be able to read its answer.
 */
async function assertSolutionIsWithheld(token: string, todaysId: number): Promise<void> {
  const practice = await get(`/api/archive/${todaysId}`, token);
  if (practice.solution !== null) {
    throw new Error("Today's solution leaked through /api/archive before the run was played");
  }
  console.log("archive withholds today's solution before it is played");
}

function buildLog(puzzle: Puzzle): InputEvent[] {
  const setup = {
    board: decodeBoard(puzzle.board, 40),
    queue: puzzle.queue,
    hold: puzzle.hold,
  };
  const { engine } = createPuzzleEngine(setup, DEFAULT_HANDLING);
  const events: InputEvent[] = [];
  let frame = 0;
  const tap = (key: GameKey) => {
    events.push({ frame, type: "keydown", data: { key, subframe: 0 } });
    events.push({ frame: frame + 1, type: "keyup", data: { key, subframe: 0 } });
    frame += 2;
  };

  for (const step of puzzle.solution.slice(0, pieceBudget(puzzle))) {
    if (toLetter(engine.falling.symbol) !== step.piece) {
      tap("hold");
      engine.hold(false, true);
    }
    const route = findPaths(engine, step.cells)[0];
    if (!route) throw new Error(`No route for ${step.piece}`);
    for (const key of route) {
      tap(key);
      engine.press(key);
    }
    tap("hardDrop");
    engine.press("hardDrop");
  }
  return events;
}

async function get(path: string, token?: string) {
  return unwrap(await fetch(base + path, { headers: authHeaders(token) }), path);
}

async function post(path: string, body: unknown, token?: string) {
  return unwrap(
    await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify(body),
    }),
    path,
  );
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function unwrap(response: Response, path: string) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

await main();
