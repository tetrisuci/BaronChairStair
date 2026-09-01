/**
 * Archive hygiene: works out which of an answer blueprint's placements are the
 * actual solve.
 *
 * Blueprint documents are editor histories, not recordings. Answers in the
 * archive routinely carry a false start before the real attempt, or the same
 * solve pasted twice. Both show up as placements the puzzle's pieces cannot
 * supply, so the real solve is the longest run of placements that a legal
 * sequence of draws and holds can actually produce.
 */

import type { Mino } from "../shared/puzzle";

export interface CandidatePlacement {
  readonly piece: Mino;
  readonly cells: readonly (readonly [number, number])[];
}

/** How many leading placements may be discarded as a false start. */
const MAX_FALSE_START = 4;

interface Supply {
  readonly falling: Mino | undefined;
  readonly upcoming: readonly Mino[];
  readonly hold: Mino | null;
  readonly holdLocked: boolean;
}

function draw(supply: Supply): Supply {
  const [next, ...rest] = supply.upcoming;
  return { falling: next, upcoming: rest, hold: supply.hold, holdLocked: false };
}

/**
 * TETR.IO hold: swap with the held piece, or bank this one and draw.
 *
 * Swapping still works once the queue is empty — that is how a solve spends the
 * piece it banked at the start.
 */
function swapHold(supply: Supply): Supply | null {
  if (supply.holdLocked) return null;
  if (supply.hold !== null) {
    return { ...supply, falling: supply.hold, hold: supply.falling ?? null, holdLocked: true };
  }
  if (supply.falling === undefined) return null;
  const [next, ...rest] = supply.upcoming;
  if (next === undefined) return null;
  return { falling: next, upcoming: rest, hold: supply.falling, holdLocked: true };
}

/** Advances the supply past `piece`, or returns null if it cannot be reached. */
function place(supply: Supply, piece: Mino): Supply | null {
  if (supply.falling === piece) return draw(supply);
  const held = swapHold(supply);
  if (held?.falling === piece) return draw(held);
  return null;
}

function runLength(
  placements: readonly CandidatePlacement[],
  start: Supply,
): number {
  let supply: Supply | null = start;
  let count = 0;
  for (const placement of placements) {
    supply = place(supply, placement.piece);
    if (supply === null) break;
    count++;
  }
  return count;
}

/**
 * Returns the longest prefix of `placements`, after discarding up to
 * {@link MAX_FALSE_START} leading entries, that the puzzle's pieces can supply.
 * Ties go to the earliest start.
 */
export function alignPlacements(
  placements: readonly CandidatePlacement[],
  queue: readonly Mino[],
  hold: Mino | null,
): CandidatePlacement[] {
  const [falling, ...upcoming] = queue;
  const start: Supply = { falling, upcoming, hold, holdLocked: false };

  let best: CandidatePlacement[] = [];
  for (let offset = 0; offset <= MAX_FALSE_START && offset < placements.length; offset++) {
    const candidate = placements.slice(offset);
    const length = runLength(candidate, start);
    if (length > best.length) best = candidate.slice(0, length);
  }
  return best;
}
