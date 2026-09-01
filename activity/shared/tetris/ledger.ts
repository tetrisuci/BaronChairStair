/**
 * The pieces a puzzle owes the player.
 *
 * The engine needs something in the queue after the final placement or the
 * spawn crashes, so the queue is padded with filler. Counting placements is not
 * enough to keep that filler out of play: holding the last real piece and
 * dropping a filler instead lands a free extra tetromino, which is precisely
 * the constraint a puzzle exists to impose.
 *
 * This ledger tracks the multiset of pieces the puzzle actually provides.
 * A lock the ledger cannot account for is filler, and ends the run.
 */

import type { Mino } from "../puzzle";

export class PieceLedger {
  private readonly owed = new Map<Mino, number>();
  private outstanding = 0;

  constructor(queue: readonly Mino[], hold: Mino | null) {
    for (const piece of [...queue, ...(hold ? [hold] : [])]) {
      this.owed.set(piece, (this.owed.get(piece) ?? 0) + 1);
      this.outstanding++;
    }
  }

  /** Pieces the puzzle still owes. Zero means the run is over. */
  get remaining(): number {
    return this.outstanding;
  }

  /** Whether the puzzle still owes this piece. */
  owes(piece: Mino): boolean {
    return (this.owed.get(piece) ?? 0) > 0;
  }

  /**
   * Accounts for a locked piece.
   *
   * @returns false if the puzzle never owed this piece — the player reached
   *   past its queue into the engine's padding, and the run must stop.
   */
  spend(piece: Mino): boolean {
    const left = this.owed.get(piece) ?? 0;
    if (left === 0) return false;
    this.owed.set(piece, left - 1);
    this.outstanding--;
    return true;
  }
}
