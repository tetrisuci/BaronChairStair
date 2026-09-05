/**
 * Which run the player is actually looking at.
 *
 * Three modes keep their own run and the daily keeps `run`, so "the run" is a
 * question with four answers and the wrong one is silent: a repaint that asks
 * the daily during a duel draws nothing, and a canvas that has just been
 * resized — which clears it — stays blank until the next input produces a
 * frame. A puzzle has no gravity, so that means until the player presses a key.
 *
 * Generic over the run so this stays free of the runner, the rush and the duel
 * client, all three of which pull in the engine.
 */
export type PlayMode = "daily" | "rush" | "explore" | "duel" | "build";

export function activeRun<T>(
  mode: PlayMode,
  sessions: {
    readonly daily: T | null;
    readonly rush: T | null | undefined;
    readonly duel: T | null | undefined;
    /** A draft being played inside the builder. Scored by nobody. */
    readonly build: T | null | undefined;
  },
): T | null {
  // Keyed on the mode rather than on whichever session is still non-null, and
  // deliberately not a chain of `??`: a rush between two puzzles has no live
  // run, and that has to read as nothing rather than reaching past it to the
  // daily attempt waiting underneath.
  if (mode === "duel") return sessions.duel ?? null;
  if (mode === "rush") return sessions.rush ?? null;
  if (mode === "build") return sessions.build ?? null;
  return sessions.daily;
}
