/**
 * "3 days ago", roughly. A list of finds wants an age, not a timestamp.
 *
 * One copy for every list that prints one — the solutions menu, a profile's
 * finds and the alternate solutions tab. It was a private function in the
 * first two, word for word, and a third copy is where two lists start
 * disagreeing about what "a month" is.
 *
 * Empty for a time in the future or no time at all, rather than "-1 days ago":
 * a clock that disagrees with the server's by a minute is not worth a sentence.
 */

const DAY_MS = 86_400_000;
const DAYS_IN_A_MONTH = 30;

export function ago(at: number, now: number): string {
  const days = Math.floor((now - at) / DAY_MS);
  if (!Number.isFinite(days) || days < 0) return "";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < DAYS_IN_A_MONTH) return `${days} days ago`;
  const months = Math.floor(days / DAYS_IN_A_MONTH);
  return months === 1 ? "a month ago" : `${months} months ago`;
}
