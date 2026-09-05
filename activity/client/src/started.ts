/**
 * Which of the day's puzzles this player has opened.
 *
 * The server only knows about runs that were *filed*, and a daily run is filed
 * when it solves — so a puzzle somebody opened, spent five minutes on and
 * walked away from is, as far as the server is concerned, indistinguishable
 * from one they never looked at. The chooser called both "not played", which
 * is the one thing a player reading that row already knows to be false.
 *
 * Kept in `localStorage` rather than in memory, because a Discord activity is
 * closed and reopened constantly and a record of having started something that
 * forgets itself when the panel closes tells the same lie a minute later.
 *
 * Scoped per player for the reason `settings.ts` gives at length — one origin
 * serves every Discord account that has ever opened the activity in this
 * browser — and stamped with the day, so yesterday's record is never read as
 * today's and there is nothing to clean up.
 */

const VERSION = 1;

function storageKey(playerId: string): string {
  return `puzzle.started.v${VERSION}.${playerId}`;
}

interface Stored {
  readonly day: number;
  readonly ids: readonly number[];
}

export interface StartedPuzzles {
  /** Whether this puzzle has been opened on this day. */
  has(day: number, puzzleId: number): boolean;
  /** Records that it has been. Idempotent, and cheap enough to call per run. */
  add(day: number, puzzleId: number): void;
}

function read(key: string, day: number): number[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const stored = JSON.parse(raw) as Partial<Stored>;
    // A record from another day is not this day's. Reading it as empty is the
    // whole of the rollover: the next write replaces it.
    if (stored.day !== day || !Array.isArray(stored.ids)) return [];
    return stored.ids.filter((id): id is number => Number.isInteger(id));
  } catch {
    // Private-mode browsers and blocked storage both land here. Nothing is
    // lost that matters: a puzzle reads as unopened, which is what it read as
    // before this existed.
    return [];
  }
}

function write(key: string, stored: Stored): void {
  try {
    localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    // The in-memory copy still answers for the rest of this session.
  }
}

export function createStartedPuzzles(playerId: string): StartedPuzzles {
  const key = storageKey(playerId);
  /** Hydrated on first use and re-read if the day ever changes under us. */
  let today: { day: number; ids: Set<number> } | null = null;

  function state(day: number): { day: number; ids: Set<number> } {
    if (today?.day !== day) today = { day, ids: new Set(read(key, day)) };
    return today;
  }

  return {
    has: (day, puzzleId) => state(day).ids.has(puzzleId),
    add(day, puzzleId) {
      const current = state(day);
      if (current.ids.has(puzzleId)) return;
      current.ids.add(puzzleId);
      write(key, { day, ids: [...current.ids] });
    },
  };
}
