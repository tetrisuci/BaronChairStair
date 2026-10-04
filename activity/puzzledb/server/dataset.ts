/**
 * One build of the puzzle database: what players are dealt, and the days that are over.
 *
 * **What players are dealt, not the published record.** The list is the
 * game's own: `PuzzleArchive.load` over the same six inputs the game's next
 * boot reads — the club's file and zone, the accepted submissions, the
 * corrections, the tracked archive's answers and the published rows. So an
 * officer's correction shows, an unpublished row never does, and the committed
 * puzzles are listed whether or not anybody has synced. `/api/public` is the
 * other thing — the published record only, uncorrected, and empty on a box
 * nobody has synced — and it stays exactly as it is.
 *
 * **The whole accepted list goes in; the policy takes community puzzles out
 * afterwards.** `load` checks the merged list for clashing ids, empty tiers
 * and corrections that would empty one, and those checks mean something only
 * over the list the game itself merges. Filtering first would build a list the
 * game never builds, and could pass where the game would refuse to boot.
 *
 * **Past days, as they are now.** History is the snapshot's finished days,
 * through `tiersShownOn`: three tiers before extreme began, four after. A day
 * that dealt a puzzle a player wrote names the tier and withholds the id while
 * such puzzles are withheld; a club id the archive no longer holds keeps its
 * number. Each puzzle is shown as it is today, which may not be what a day
 * dealt if somebody has edited it since.
 *
 * The rows go to `public-db.ts`, and everything this returns is read back from
 * there. The result is frozen and swapped whole by the refresher.
 */

import { trackedAnswers } from "../../server/archive-solutions";
import { PuzzleArchive, shapeKey } from "../../server/puzzles";
import { dailyTierOf } from "../../shared/daily";
import { COMMUNITY_ID_BASE, pieceBudget, type Puzzle } from "../../shared/puzzle";
import { dateOfDay, SCHEMA_VERSION } from "../wire";
import { type TrackedCodes, trackedCodes } from "./codes";
import { isWithheld, POLICY, tiersShownOn } from "./policy";
import { type AboutRow, type DayRow, type PuzzleRow, writePublicDatabase } from "./public-db";
import type { Dataset, DatasetSources, DayPin, GameSnapshot, Policy } from "./types";

/**
 * Builds the dataset for one snapshot.
 *
 * Throws whatever `PuzzleArchive.load` throws on bad data — a malformed
 * `puzzles.json`, two puzzles claiming one id — which is the refresher's cue to
 * keep serving the last dataset that built.
 */
export function buildDataset(
  snapshot: GameSnapshot,
  sources: DatasetSources,
  builtAt: number,
  policy: Policy = POLICY,
): Dataset {
  const archive = PuzzleArchive.load(
    sources.puzzlesPath,
    { timeZone: sources.timeZone },
    snapshot.accepted,
    snapshot.overrides,
    trackedAnswers(sources.trackedArchivePath),
    snapshot.published,
  );
  const codes = trackedCodes(sources.trackedArchivePath);
  const puzzles = archive.puzzles
    .filter((puzzle) => !isWithheld(puzzle.id, policy))
    .toSorted((a, b) => a.id - b.id)
    .map((puzzle) => puzzleRow(puzzle, codes));
  const days = dayRows(snapshot.pins, policy);
  const about = aboutRows(builtAt, policy, days);
  const { sqlite, data } = writePublicDatabase({ puzzles, days, about });
  return Object.freeze({
    json: new TextEncoder().encode(JSON.stringify(data)),
    sqlite,
    data,
    puzzleById: new Map(data.puzzles.map((puzzle) => [puzzle.id, puzzle])),
    dayByNumber: new Map(data.days.map((day) => [day.day, day])),
    builtAt,
  });
}

/** One served puzzle as a `puzzles` row. */
function puzzleRow(puzzle: Puzzle, codes: ReadonlyMap<string, TrackedCodes>): PuzzleRow {
  const code = codesFor(puzzle, codes);
  return [
    puzzle.id,
    puzzle.title,
    puzzle.author,
    // 0 is how the game spells "unrated", and not a rating on a scale that
    // starts at 1 — the rule `/api/public` already follows.
    puzzle.difficulty === 0 ? null : puzzle.difficulty,
    dailyTierOf(puzzle),
    puzzle.goal,
    puzzle.set ?? null,
    JSON.stringify(puzzle.board),
    JSON.stringify(puzzle.queue),
    puzzle.hold ?? null,
    pieceBudget(puzzle),
    puzzle.targetAttack,
    // Absent is "nobody has decided" and [] is "decided that none applies":
    // two different answers, so two different cells.
    puzzle.requiredClears === undefined ? null : JSON.stringify(puzzle.requiredClears),
    puzzle.solution?.length ? JSON.stringify(puzzle.solution) : null,
    code.puzzle,
    code.solution,
  ];
}

interface Codes {
  readonly puzzle: string | null;
  readonly solution: string | null;
}

const NO_CODES: Codes = Object.freeze({ puzzle: null, solution: null });

/**
 * A puzzle's own Blueprint codes where it has any, else the tracked archive's
 * for its shape — for a club puzzle, and only when they play its answer.
 *
 * Only when they play its answer, because a box whose own `solutions.json`
 * answers a puzzle differently would otherwise link the viewer to a line the
 * page does not step through. Only for a club puzzle, because the tracked
 * archive is the club's sheet: a puzzle a player wrote was never a Blueprint
 * code, and one that happens to share a club puzzle's board would otherwise be
 * credited with that puzzle's codes as its source.
 */
function codesFor(puzzle: Puzzle, codes: ReadonlyMap<string, TrackedCodes>): Codes {
  const own = puzzle.source;
  if (own) return { puzzle: own.puzzle || null, solution: own.solution || null };
  if (puzzle.id >= COMMUNITY_ID_BASE || !puzzle.solution?.length) return NO_CODES;
  const tracked = codes.get(shapeKey(puzzle));
  if (!tracked || tracked.answer !== JSON.stringify(puzzle.solution)) return NO_CODES;
  return { puzzle: tracked.puzzle, solution: tracked.solution };
}

/** The pins a day shows, as `day_puzzles` rows: shown tiers only, withheld ids blanked. */
function dayRows(pins: readonly DayPin[], policy: Policy): DayRow[] {
  return pins.flatMap((pin): DayRow[] => {
    const tier = tiersShownOn(pin.day, policy).find((shown) => shown === pin.tier);
    if (!tier) return [];
    const puzzleId = isWithheld(pin.puzzleId, policy) ? null : pin.puzzleId;
    return [[pin.day, dateOfDay(pin.day), tier, puzzleId]];
  });
}

function aboutRows(builtAt: number, policy: Policy, days: readonly DayRow[]): AboutRow[] {
  const throughDay = days.reduce<number | null>(
    (newest, [day]) => (newest === null || day > newest ? day : newest),
    null,
  );
  return [
    ["schema", String(SCHEMA_VERSION)],
    ["built_at", new Date(builtAt).toISOString()],
    ["first_day", String(policy.firstTieredDay)],
    ["through_day", throughDay === null ? null : String(throughDay)],
  ];
}
