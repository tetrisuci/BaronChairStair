/**
 * What a streak is, for every board that prints one.
 *
 * Moved out of `server/db.ts` so db.tetrisatuci.org can ask the same question
 * the game does. The site may not import the game's database module —
 * `tests/puzzledb-isolation.test.ts` forbids it, because that module migrates a
 * file the moment it is constructed — and a site with its own copy of the rule
 * would, on the first day the two copies read "consecutive" differently, show a
 * player a streak the game's own profile contradicts.
 *
 * Pure functions over day numbers, so either side can hand them whatever days
 * it trusts. The game hands them every solved day; the site hands them only the
 * finished ones and asks at its cut, which is why a player who has already
 * solved today reads one lower on the site than in the game. That is the cut
 * working, not the rule differing.
 *
 * `Store.streak` keeps a single-player copy of {@link currentStreak} over its own
 * `LIMIT 400` query, written in the same shape, for the reason its docstring
 * gives.
 */

/**
 * The streak a player is on now, walking back from `today`.
 *
 * `days` arrives newest-first and already distinct. Today not yet played does
 * not break a streak — somebody who solved yesterday and has not opened the
 * game yet is still on it — but any other missed day does.
 *
 * Asked with every day before a cut and the cut as `today`, the grace day lands
 * on the cut itself, so the streak stands exactly when the day before the cut
 * was solved: a streak "as of the newest finished day".
 */
export function currentStreak(days: readonly number[], today: number): number {
  let streak = 0;
  let expected = today;
  for (const day of days) {
    if (day === expected) {
      streak++;
      expected--;
    } else if (day === expected - 1 && streak === 0) {
      // Today not yet played does not break a streak; a missed day does.
      streak++;
      expected = day - 1;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * The longest run of consecutive days they ever put together.
 *
 * No grace day here: the grace in {@link currentStreak} is for a day that has
 * not happened yet, and a best is a record of what was done.
 */
export function bestStreak(days: readonly number[]): number {
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  // Newest-first, so consecutive means each day is one less than the last.
  for (const day of days) {
    run = previous !== null && day === previous - 1 ? run + 1 : 1;
    previous = day;
    if (run > best) best = run;
  }
  return best;
}
