/**
 * Every way a puzzle can be solved, not just the way its author had in mind.
 *
 * Two jobs, and they are the same search. A maker wants to know whether the
 * condition they wrote actually forces the line they meant — and the only
 * honest answer is a counterexample or a proof that none exists. A player wants
 * credit for finding a line nobody had recorded, which means the archive has to
 * know what was already known.
 *
 * The search is deliberately built out of the pieces the *game* is built out
 * of: {@link RoutePlanner.restingPlacements} for what a piece can reach,
 * {@link RoutePlanner.placementAt} for which kick lands it, and `solvesPuzzle`
 * for whether the run is over. A search with its own idea of any of those
 * would answer a question about a game nobody is playing — and the direction
 * it would fail in is the dangerous one: a placement it cannot reach is a
 * solution it cannot find, reported to a maker as "your puzzle is tight".
 */

import type { Engine, LockRes } from "@haelp/teto/engine";
import {
  BOARD_WIDTH,
  clearShortfall,
  encodeBoard,
  ENGINE_ROWS,
  decodeBoard,
  solvesPuzzle,
  type ClearName,
  type Mino,
  type Puzzle,
  type SolutionStep,
} from "../puzzle";
import { DEFAULT_HANDLING, SDF_INSTANT, type Handling } from "./handling";
import { createPuzzleEngine, readBoard, toLetter } from "./engine";
import { nameClear } from "./replay";
import { RoutePlanner, ticksForRoute, type MoveKey, type TargetCells } from "./pathfinder";
import { solutionKey } from "../solution-key";

/**
 * Where a search stopped, which is the difference between a proof and a
 * finding.
 *
 * `exhausted` is the only one that licenses "this puzzle has exactly these
 * solutions". The other three mean the search ran out of something and the
 * unexplored part may hold anything — reported rather than rounded off,
 * because a bounded search quietly presented as a complete one is worse than
 * no search: it is a maker being told their puzzle is tight by a tool that
 * simply stopped looking.
 */
export type StopReason = "exhausted" | "lines" | "nodes" | "time";

export interface SearchLimits {
  /** Stop after this many distinct solving lines. */
  readonly maxLines: number;
  /** Stop after this many node expansions. */
  readonly maxNodes: number;
  /** Stop after this long. */
  readonly maxMillis: number;
}

export const DEFAULT_LIMITS: SearchLimits = {
  maxLines: 10,
  maxNodes: 20_000,
  maxMillis: 20_000,
};

export interface FoundLine {
  readonly placements: readonly SolutionStep[];
  readonly attack: number;
  readonly clears: readonly ClearName[];
}

export interface SearchReport {
  readonly lines: readonly FoundLine[];
  readonly stoppedBy: StopReason;
  readonly nodes: number;
  readonly millis: number;
}

/** Pieces still owed, as a multiset. Immutable: the walk keeps one per node. */
type Owed = ReadonlyMap<Mino, number>;

function owedFrom(puzzle: Pick<Puzzle, "queue" | "hold">): Owed {
  const owed = new Map<Mino, number>();
  for (const piece of [...puzzle.queue, ...(puzzle.hold ? [puzzle.hold] : [])]) {
    owed.set(piece, (owed.get(piece) ?? 0) + 1);
  }
  return owed;
}

function spend(owed: Owed, piece: Mino): Owed {
  const next = new Map(owed);
  const left = next.get(piece) ?? 0;
  if (left <= 1) next.delete(piece);
  else next.set(piece, left - 1);
  return next;
}

function total(owed: Owed): number {
  let count = 0;
  for (const value of owed.values()) count += value;
  return count;
}

/**
 * The state a repeat of would be a repeat of.
 *
 * Two different orders of the same placements reach the same board with the
 * same pieces left, and everything past that point is identical — so the
 * second one to arrive has nothing to add. On a puzzle whose pieces can go
 * down in any order this is the difference between a search that finishes and
 * one that does not.
 *
 * Attack and clears are *in* the key rather than merely along for the ride:
 * two lines can build the same board and have scored differently getting
 * there, and the goal is asked of the score. Merging those would drop whichever
 * line arrived second, which on a puzzle scored by clears is exactly the line
 * a maker needs to see.
 */
function stateKey(
  engine: Engine,
  owed: Owed,
  held: Mino | null,
  attack: number,
  clears: readonly ClearName[],
): string {
  const pieces = [...owed].sort(([a], [b]) => a.localeCompare(b)).map(([p, n]) => `${p}${n}`);
  return [
    encodeBoard(readBoard(engine) as never).join("/"),
    pieces.join(""),
    held ?? "-",
    attack,
    [...clears].sort().join(","),
    // The scoring state the engine carries into the *next* placement, and the
    // reason the rest of this key is not enough. Combo multiplies damage —
    // `garbage *= 1 + 0.25 * combo` — and back-to-back adds to it, so two ways
    // of reaching the same board with the same score so far can be worth
    // different amounts from here on.
    //
    // Leaving them out is not a weaker merge, it is a wrong one. Measured: on a
    // three-I position, placing a quiet piece then a line-clearing one, or the
    // same two in the other order, gives a byte-identical board, owed set, hold,
    // attack and clear multiset — and combo 0 against -1. The identical third
    // placement then scores a quad worth 5 from one and 4 from the other, so
    // merging them dropped four real solving lines while the search still
    // reported `exhausted`.
    engine.stats.combo,
    engine.stats.b2b,
  ].join("|");
}

interface Walker {
  readonly engine: Engine;
  readonly puzzle: Puzzle;
  readonly limits: SearchLimits;
  readonly deadline: number;
  /** The soft-drop rate the run is being planned at. */
  readonly sdf: number;
  readonly seen: Set<string>;
  readonly lines: FoundLine[];
  /** Canonical keys of the lines already kept, so permutations count once. */
  readonly keys: Set<string>;
  readonly lastLock: () => LockRes | null;
  nodes: number;
  stoppedBy: StopReason;
}

/** Whether the walk must stop, and why. Checked before every expansion. */
function budgetSpent(walker: Walker): boolean {
  if (walker.lines.length >= walker.limits.maxLines) {
    walker.stoppedBy = "lines";
    return true;
  }
  if (walker.nodes >= walker.limits.maxNodes) {
    walker.stoppedBy = "nodes";
    return true;
  }
  if (performance.now() >= walker.deadline) {
    walker.stoppedBy = "time";
    return true;
  }
  return false;
}

/**
 * The fewest rows a clear of this name can put out.
 *
 * A lower bound, and it must stay one: it is multiplied up into a claim that a
 * position cannot possibly reach the goal, and a bound that overstates would
 * throw away real solutions — the one error this tool must never make, because
 * its output is a maker being told their puzzle is tight.
 */
const ROWS_PER_CLEAR: Readonly<Record<ClearName, number>> = {
  single: 1,
  double: 2,
  triple: 3,
  quad: 4,
  tss: 1,
  tsd: 2,
  tst: 3,
  tsmini: 1,
  spin: 1,
  // Clears no rows, so it lends the bound nothing. Zero is the honest
  // figure and the safe direction: this is a lower bound, and understating
  // it can only keep a position alive that another check will settle.
  "spin (no lines)": 0,
  "perfect clear": 1,
};

/** Clears whose name only a T can earn. */
const T_CLEARS: ReadonlySet<ClearName> = new Set<ClearName>(["tss", "tsd", "tst", "tsmini"]);

/**
 * Whether this position can still reach the goal, on the arithmetic alone.
 *
 * Two counts, both of which only ever *under*-state what is needed, so a
 * position this rejects genuinely cannot be finished:
 *
 * 1. **Cells.** Clearing a row means filling every empty square in it. Clearing
 *    `k` more rows therefore costs at least the emptiest-but-cheapest `k` rows
 *    on the board, and every piece left brings exactly four squares. Rows move
 *    down as lines come out, but they move as whole rows — the multiset this
 *    counts over is the same one, repositioned — so the bound survives clears.
 * 2. **T pieces.** A TSD needs a T. If the goal still wants T-spins and no T is
 *    owed, no ordering of what is left will produce one.
 *
 * Deliberately *not* here: the tempting one, that a covered square can never be
 * filled again. It is false in this game — a piece can be slid under an
 * overhang, and {@link RoutePlanner.restingPlacements} finds exactly those
 * tucks — so a hole-counting prune would quietly discard the cleverest lines,
 * which are the ones a maker most needs to see.
 */
function canStillReachGoal(
  engine: Engine,
  puzzle: Puzzle,
  owed: Owed,
  clears: readonly ClearName[],
): boolean {
  const outstanding = clearShortfall(clears, puzzle.requiredClears);
  const left = total(owed);

  if (outstanding.some((entry) => T_CLEARS.has(entry.clear)) && !owed.has("T")) return false;

  const rowsNeeded = outstanding.reduce(
    (rows, entry) => rows + ROWS_PER_CLEAR[entry.clear] * entry.count,
    0,
  );
  if (rowsNeeded === 0) return true;

  // Every row, including the empty ones above the stack: a row with nothing in
  // it is still a row that can be filled and cleared, and leaving those out
  // would let this reject a position that a taller line solves.
  const gaps: number[] = [];
  for (let y = 0; y < engine.board.fullHeight; y++) {
    const row = engine.board.state[y];
    let empty = 0;
    for (let x = 0; x < BOARD_WIDTH; x++) if (toLetter(row?.[x]?.mino) === null) empty++;
    gaps.push(empty);
  }
  gaps.sort((a, b) => a - b);
  if (gaps.length < rowsNeeded) return false;

  const cellsNeeded = gaps.slice(0, rowsNeeded).reduce((sum, gap) => sum + gap, 0);
  return cellsNeeded <= left * 4;
}

/**
 * Whether putting the piece on these squares completes a row.
 *
 * Read off the board rather than discovered by playing, because it is the one
 * thing about a placement that no route can change: a row completes when all
 * ten of its columns are filled, and which squares the piece ends on is the
 * same however it got there. That makes it the cheap test that says whether
 * the expensive one — which kick the engine credits — can possibly matter.
 *
 * Nothing clears means nothing is sent, and a spin nobody scores is a spin
 * worth nothing. So a "no" here licenses taking any route that arrives.
 */
function completesARow(engine: Engine, cells: TargetCells): boolean {
  const added = new Map<number, number>();
  for (const [, y] of cells) added.set(y, (added.get(y) ?? 0) + 1);

  for (const [y, count] of added) {
    const row = engine.board.state[y];
    if (!row) continue;
    let filled = count;
    for (let x = 0; x < BOARD_WIDTH; x++) {
      if (toLetter(row[x]?.mino) !== null) filled++;
    }
    if (filled >= BOARD_WIDTH) return true;
  }
  return false;
}

/**
 * Plays a route out on the live engine and reads what the lock scored.
 *
 * `sdf` and `softDrops` are what #44 added to `ticksForRoute`: below the
 * instant soft drop a held drop descends `0.05 × sdf` rows a frame, so the key
 * has to stay down for as many frames as the planned descent needs. At the
 * default they change nothing, which is why omitting them typechecked as a
 * two-argument call right up until the two branches met.
 */
function play(
  engine: Engine,
  route: readonly MoveKey[],
  sdf: number,
  softDrops: readonly number[],
  lastLock: () => LockRes | null,
): { readonly clear: ClearName | null; readonly attack: number } | null {
  for (const batch of ticksForRoute(route, engine.frame, sdf, softDrops)) {
    engine.tick(batch as never);
  }
  const lock = lastLock();
  if (!lock) return null;
  return {
    clear: nameClear(lock, engine.board.perfectClear),
    attack: lock.garbage.reduce((sum, value) => sum + value, 0),
  };
}

interface Branch {
  readonly cells: TargetCells;
  readonly piece: Mino;
  readonly clear: ClearName | null;
  readonly attack: number;
  readonly holdFirst: boolean;
  /**
   * The inputs that put the piece there, kept from the trial that scored it.
   *
   * Choosing the kick is by far the most expensive thing this search does —
   * every candidate rotation is played out on the real engine and judged by
   * its lock — and the recursion would otherwise pay for the identical
   * decision a second time, from the identical position, to reach the
   * identical answer.
   */
  readonly route: readonly MoveKey[];
  /** The descent of each soft drop in `route`, as the planner measured it. */
  readonly softDrops: readonly number[];
}

/**
 * Every child of this node, with what each one scores.
 *
 * Both branches a player has — place what is falling, or hold and place the
 * other — are walked, and the engine is put back exactly as it was found after
 * each. The outcomes are read here rather than discovered during the recursion
 * so the children can be tried best-first: a line that scores is usually
 * reached through the placements that score, and on a bounded search the order
 * decides what gets found before the budget runs out.
 */
function childrenOf(walker: Walker, owed: Owed): Branch[] {
  const { engine } = walker;
  const found: Branch[] = [];

  for (const holdFirst of [false, true]) {
    const before = engine.snapshot();
    try {
      if (holdFirst) engine.hold(false, true);
      const piece = toLetter(engine.falling.symbol);
      // Filler. The engine always has something to spawn so the board never
      // crashes; the ledger is what says the puzzle stopped providing pieces.
      if (piece === null || piece === "G" || !owed.has(piece)) continue;
      if (holdFirst && found.some((branch) => branch.piece === piece)) continue;

      const planner = new RoutePlanner(engine);
      for (const cells of planner.restingPlacements()) {
        // The expensive question — which kick does the engine credit — is only
        // worth asking where a row actually comes out. On a puzzle board most
        // placements are quiet stacking, and asking anyway was the whole cost
        // of the search.
        // The expensive question — which kick does the engine credit — is only
        // worth asking where a row actually comes out. Below the instant soft
        // drop it has to be asked anyway: `plainRouteTo` reports a route and no
        // descents, and *every* plain route contains a soft drop (673 of 673
        // over the archive's opening positions), so one held tick would stop
        // the fall short and land the piece on squares nobody asked for. At
        // `SDF_INSTANT` one tick always covers the whole descent, which is what
        // makes the cheap route safe there and only there.
        const mustMeasure = completesARow(engine, cells) || walker.sdf < SDF_INSTANT;
        const plain = mustMeasure ? null : planner.plainRouteTo(cells);
        const measured = plain ? null : planner.placementAt(cells);
        const route = plain ?? measured?.route;
        // A seat the planner cannot land on is skipped, clearing or not —
        // falling through to the cheap route there would play a placement the
        // engine had just refused.
        if (!route) continue;
        const softDrops = measured?.softDrops ?? [];
        const resting = engine.snapshot();
        const outcome = play(engine, route, walker.sdf, softDrops, walker.lastLock);
        engine.fromSnapshot(resting);
        if (outcome) found.push({ cells, piece, holdFirst, route, softDrops, ...outcome });
      }
    } finally {
      engine.fromSnapshot(before);
    }
  }

  return found.sort((a, b) => b.attack - a.attack);
}

function walk(
  walker: Walker,
  owed: Owed,
  attack: number,
  clears: readonly ClearName[],
  placements: readonly SolutionStep[],
): void {
  // The run is over the moment the goal is met — the game ends it there, so a
  // longer line through the same solve is not a different solution, it is a
  // line that could not have been played.
  if (placements.length > 0 && solvesPuzzle(attack, clears, walker.puzzle)) {
    // Two orders of the same placements are one solution, not two. The search
    // reaches them separately — the transposition table merges positions, not
    // paths — so the collapse happens here, on the same rule the archive and
    // the leaderboard use to decide a discovery is new.
    const key = solutionKey(placements);
    if (!walker.keys.has(key)) {
      walker.keys.add(key);
      walker.lines.push({ placements, attack, clears });
    }
    return;
  }
  if (total(owed) === 0 || budgetSpent(walker)) return;
  if (!canStillReachGoal(walker.engine, walker.puzzle, owed, clears)) return;

  const key = stateKey(walker.engine, owed, toLetter(walker.engine.held) as Mino | null, attack, clears);
  if (walker.seen.has(key)) return;
  walker.seen.add(key);

  walker.nodes++;
  const { engine } = walker;

  for (const branch of childrenOf(walker, owed)) {
    if (budgetSpent(walker)) return;
    const before = engine.snapshot();
    try {
      if (branch.holdFirst) engine.hold(false, true);
      const outcome = play(engine, branch.route, walker.sdf, branch.softDrops, walker.lastLock);
      if (!outcome) continue;
      walk(
        walker,
        spend(owed, branch.piece),
        attack + outcome.attack,
        outcome.clear ? [...clears, outcome.clear] : clears,
        [
          ...placements,
          {
            piece: branch.piece,
            cells: branch.cells.map(([x, y]) => [x, y] as const),
            clear: outcome.clear,
            attack: outcome.attack,
          },
        ],
      );
    } finally {
      engine.fromSnapshot(before);
    }
  }
}

/**
 * Solving lines for one puzzle, best-scoring first, up to the limits given.
 *
 * A line ends where the game would end it: at the placement that meets the
 * goal. `stoppedBy` is the part a caller must not drop — only `"exhausted"`
 * means the returned lines are all the lines there are.
 */
export function searchSolutions(
  puzzle: Puzzle,
  limits: Partial<SearchLimits> = {},
  handling: Handling = DEFAULT_HANDLING,
): SearchReport {
  const settled = { ...DEFAULT_LIMITS, ...limits };
  const started = performance.now();
  const { engine } = createPuzzleEngine(
    {
      board: decodeBoard(puzzle.board, ENGINE_ROWS),
      queue: puzzle.queue,
      hold: puzzle.hold,
    },
    handling,
  );

  let lock: LockRes | null = null;
  engine.events.on("falling.lock", (result) => {
    lock = result;
  });

  const walker: Walker = {
    engine,
    puzzle,
    limits: settled,
    deadline: started + settled.maxMillis,
    sdf: handling.sdf,
    seen: new Set(),
    lines: [],
    keys: new Set(),
    lastLock: () => {
      const seen = lock;
      lock = null;
      return seen;
    },
    nodes: 0,
    stoppedBy: "exhausted",
  };

  walk(walker, owedFrom(puzzle), 0, [], []);

  return {
    lines: walker.lines,
    stoppedBy: walker.stoppedBy,
    nodes: walker.nodes,
    millis: performance.now() - started,
  };
}
