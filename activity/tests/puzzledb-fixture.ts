/**
 * A real game database for the puzzle database's tests, with something planted
 * in every column that must never reach the open web.
 *
 * A test helper, not a test (its own checks are in `puzzledb-fixture.test.ts`).
 *
 * **The schema is the game's because the game built it.** The database is
 * opened by `new Store(path)` — config-free, and the same constructor the game
 * runs at boot — so every table, column, index and migration is exactly what a
 * production box has. A hand-written schema would be a second copy that drifts,
 * and a privacy test run against the copy proves nothing about the original.
 *
 * **Rows go in through the game's own writers.** The player tables through the
 * Store's methods (`upsertPlayer`, `recordRun`, `recordSolution`, ...) before it
 * is closed; submissions, corrections and the archive through the free helpers
 * the routes and tools call (`insertSubmission`, `acceptSubmission`,
 * `writeOverride`, `upsertArchive`, `publishArchive`). The one raw INSERT is
 * `day_puzzles`, because `Store.pinDay` always writes all four tiers and the
 * days below need three, one, or a stray tier.
 *
 * **Every personal or attribution column holds a planted value**: a string no
 * real data contains, listed in {@link PLANTED}, so a test can scan any byte the
 * site produces for every one of them at once. The two Discord-shaped ids are
 * 18 digits, so a scan for long digit runs catches them as well. Officers'
 * names all begin `discord:planted-officer`, one per column, so a leak names
 * the column it came from.
 *
 * **The days** are {@link DEFAULT_PINS}: one case each for the backfill, the
 * history start, the extreme top-up, a player's puzzle, a departed club puzzle,
 * today and a stray future pin. The clock is {@link NOW}, which is day
 * {@link TODAY} in Irvine.
 *
 * **The files** are a copy of `data/puzzles.json` with no `solutions.json`
 * beside it — the shape of every deploy box, where answers come from the
 * tracked archive — and the committed tracked archive itself, read only.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ArchiveEntry, archiveEntry, publishArchive, upsertArchive } from "../server/archive-rows";
import { type PlayerProfile, Store } from "../server/db";
import { writeOverride } from "../server/puzzle-overrides";
import {
  acceptSubmission,
  insertSubmission,
  rejectSubmission,
  type SubmissionDraft,
} from "../server/submissions";
import { DAILY_TIERS, type DailyTier, dayNumber } from "../shared/daily";
import { COMMUNITY_ID_BASE, type Puzzle, type SolutionStep } from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import type { InputEvent } from "../shared/tetris/verify";
import { FIRST_EXTREME_DAY, FIRST_TIERED_DAY } from "../puzzledb/server/policy";
import type { DatasetSources, DayPin } from "../puzzledb/server/types";

// ── The clock ─────────────────────────────────────────────────────────────────

/** The game's day at {@link NOW}: 2026-10-02 in Irvine. */
export const TODAY = 275;
/** Noon Pacific (daylight time) on 2026-10-02: well clear of either midnight. */
export const NOW = Date.UTC(2026, 9, 2, 19);
/** The club's zone, and the game's default. */
export const LA = "America/Los_Angeles";

// ── Who is planted ────────────────────────────────────────────────────────────

/** A Discord user id: 18 digits, as Discord's are. Synthetic. */
export const DISCORD_ID = "112233445566778899";
/** A Discord server id, the same shape. Synthetic. */
export const GUILD_ID = "998877665544332211";

/** The accepted player puzzle: the first id the game's own accept allocates. */
export const COMMUNITY_ID = COMMUNITY_ID_BASE;
/** Its author, the submitter's display name. Public only while community puzzles are listed. */
export const COMMUNITY_AUTHOR = "planted-community-author";
/** Its title. Public only while community puzzles are listed. */
export const COMMUNITY_TITLE = "planted-community-title";

/** A club puzzle an officer retitled twice; it is served with {@link CORRECTED_TITLE}. */
export const CORRECTED_ID = 12;
export const CORRECTED_TITLE = "Corrected title";
/** A club id pinned on a finished day and absent from `puzzles.json`, as #13 is. */
export const DEPARTED_ID = 13;
/** A synced archive row that is published, with the tracked archive's content. */
export const PUBLISHED_ID = 141;
/** A synced archive row that is not, so nothing may serve it. */
export const UNPUBLISHED_ID = 142;

const PLAYER: PlayerProfile = Object.freeze({
  id: DISCORD_ID,
  username: "planted-player-name",
  avatarUrl: `https://cdn.discordapp.com/avatars/${DISCORD_ID}/planted-avatar.png`,
});

/** One per attribution column, so a leaked name says where it came from. */
const OFFICER = Object.freeze({
  reviewer: "discord:planted-officer-reviewer",
  corrector: "discord:planted-officer-corrector",
  publisher: "discord:planted-officer-publisher",
  editor: "discord:planted-officer-editor",
});

const MARK = Object.freeze({
  preference: "planted-preference",
  foundLine: "planted-found-line",
  foundPlacements: "planted-found-placements",
  foundKey: "planted-canonical-key",
  inputLog: "planted-input-log",
  pendingAuthor: "planted-pending-author",
  pendingTitle: "planted-pending-title",
  rejectedAuthor: "planted-rejected-author",
  rejectedTitle: "planted-rejected-title",
  reviewerNote: "planted-reviewer-note",
  acceptanceNote: "planted-acceptance-note",
  overrideWas: "planted-override-was",
  unpublishedTitle: "planted-unpublished-title",
});

/**
 * Every value that must never appear in anything the site serves, under any
 * policy.
 *
 * {@link COMMUNITY_AUTHOR} and {@link COMMUNITY_TITLE} are deliberately absent:
 * listing community puzzles is meant to publish exactly those two. Scan for
 * them as well while the policy withholds community puzzles.
 */
export const PLANTED: readonly string[] = Object.freeze([
  DISCORD_ID,
  GUILD_ID,
  PLAYER.username,
  PLAYER.avatarUrl!,
  ...Object.values(OFFICER),
  ...Object.values(MARK),
]);

// ── The days ──────────────────────────────────────────────────────────────────

function pinsFor(day: number, ids: Partial<Record<DailyTier, number>>): DayPin[] {
  return DAILY_TIERS.flatMap((tier) => {
    const puzzleId = ids[tier];
    return puzzleId === undefined ? [] : [Object.freeze({ day, tier, puzzleId })];
  });
}

/**
 * What the fixture pins, one case per row. Club ids are puzzles of the tier
 * they are pinned in, except where a row says otherwise.
 *
 * Shown, under the default policy: the first tiered day, the day after it
 * without its top-up, the first extreme day, and the two days before today —
 * history through `TODAY - 1`. `FIRST_TIERED_DAY` itself is pinned so the
 * history start is a boundary a test can see from both sides.
 */
export const DEFAULT_PINS: readonly DayPin[] = Object.freeze([
  // The one-time backfill: a day nobody was dealt tiers on. Never shown.
  ...pinsFor(FIRST_TIERED_DAY - 1, { easy: 37, medium: 27, hard: 2 }),
  // Where history starts.
  ...pinsFor(FIRST_TIERED_DAY, { easy: 46, medium: 32, hard: 4 }),
  // Played with three tiers; the extreme row is a later top-up and never shown.
  ...pinsFor(FIRST_TIERED_DAY + 1, { easy: 47, medium: 34, hard: 5, extreme: 3 }),
  // The first day with four tiers. Its hard is the corrected puzzle.
  ...pinsFor(FIRST_EXTREME_DAY, { easy: 48, medium: 39, hard: CORRECTED_ID, extreme: 16 }),
  // A day that dealt a player's puzzle as its hard. Accepted at difficulty 3,
  // it is a medium now: the tier a day dealt and a puzzle's tier today differ.
  ...pinsFor(TODAY - 2, { easy: 49, medium: 40, hard: COMMUNITY_ID, extreme: 17 }),
  // Yesterday: a departed club id, and the published archive row.
  ...pinsFor(TODAY - 1, { easy: 50, medium: DEPARTED_ID, hard: 6, extreme: PUBLISHED_ID }),
  // Today. Never shown, never marked.
  ...pinsFor(TODAY, { easy: 51, medium: 53, hard: 7, extreme: 18 }),
  // A stray pin past today. It makes MAX(day) TODAY + 1, so the cut is the clock's.
  ...pinsFor(TODAY + 1, { easy: 52 }),
]);

// ── Preconditions ─────────────────────────────────────────────────────────────

const COMMITTED_PUZZLES = resolve(import.meta.dir, "../data/puzzles.json");
const TRACKED_ARCHIVE = resolve(import.meta.dir, "../data/archive/puzzles.sqlite");

/**
 * Throws, at import, if the policy or the data has moved under the cases above.
 *
 * Every downstream test reads its expectations off these constants, so a case
 * that silently stopped being the case it names would turn their assertions
 * into checks of nothing. Loud and early instead.
 */
function assertPreconditions(): void {
  if (!(FIRST_TIERED_DAY + 1 < FIRST_EXTREME_DAY && FIRST_EXTREME_DAY < TODAY - 2)) {
    throw new Error(
      `The puzzle database fixture needs FIRST_TIERED_DAY + 1 < FIRST_EXTREME_DAY < TODAY - 2, ` +
        `and policy.ts now says ${FIRST_TIERED_DAY} and ${FIRST_EXTREME_DAY} against TODAY ${TODAY}. ` +
        "Move TODAY and NOW, or re-plan DEFAULT_PINS.",
    );
  }
  const today = dayNumber(NOW, { timeZone: LA });
  if (today !== TODAY) throw new Error(`NOW is day ${today} in ${LA}, not TODAY (${TODAY})`);

  const file = new Set(
    (JSON.parse(readFileSync(COMMITTED_PUZZLES, "utf8")) as { puzzles: Puzzle[] }).puzzles.map(
      (puzzle) => puzzle.id,
    ),
  );
  const fromArchiveOnly = new Set([DEPARTED_ID, PUBLISHED_ID, UNPUBLISHED_ID, COMMUNITY_ID]);
  const missing = DEFAULT_PINS.map((pin) => pin.puzzleId).filter(
    (id) => !fromArchiveOnly.has(id) && !file.has(id),
  );
  const present = [...fromArchiveOnly].filter((id) => file.has(id));
  if (missing.length > 0 || present.length > 0 || !file.has(CORRECTED_ID)) {
    throw new Error(
      `data/puzzles.json no longer fits the puzzle database fixture: pinned but absent ${missing}; ` +
        `meant to be absent but present ${present}; corrected #${CORRECTED_ID} present: ${file.has(CORRECTED_ID)}`,
    );
  }
}

assertPreconditions();

// ── Building it ───────────────────────────────────────────────────────────────

export interface FixtureOptions {
  /** `wal`, as the game runs, by default; `delete` for a byte-stable single file. */
  readonly journal?: "wal" | "delete";
  /** Pinned instead of {@link DEFAULT_PINS}. */
  readonly pins?: readonly DayPin[];
  /**
   * Leaves today and every later day unpinned: the moment after midnight,
   * before anything has asked for the new day. Nothing can have pinned a later
   * day before today, so the stray future pin goes too.
   */
  readonly withoutToday?: boolean;
}

export interface GameFixture {
  readonly dir: string;
  readonly databasePath: string;
  readonly puzzlesPath: string;
  /** The committed `data/archive/puzzles.sqlite`. Open it read-only. */
  readonly trackedArchivePath: string;
  /** What was pinned, after `withoutToday`. */
  readonly pins: readonly DayPin[];
  /** Removes `dir` and everything in it. Safe to call twice. */
  cleanup(): void;
}

/** Builds a planted game database in a fresh temporary directory. The caller cleans it up. */
export function gameFixture(options: FixtureOptions = {}): GameFixture {
  const chosen = options.pins ?? DEFAULT_PINS;
  const pins = options.withoutToday ? chosen.filter((pin) => pin.day < TODAY) : chosen;
  const dir = mkdtempSync(join(tmpdir(), "puzzledb-fixture-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const databasePath = join(dir, "daily.sqlite");
    const puzzlesPath = join(dir, "puzzles.json");
    copyFileSync(COMMITTED_PUZZLES, puzzlesPath);
    plantDatabase(databasePath, pins, options.journal ?? "wal");
    return Object.freeze({
      dir,
      databasePath,
      puzzlesPath,
      trackedArchivePath: TRACKED_ARCHIVE,
      pins,
      cleanup,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** The sources a dataset build reads beside the fixture's database. */
export function fixtureSources(
  fixture: Pick<GameFixture, "puzzlesPath" | "trackedArchivePath">,
): DatasetSources {
  return { puzzlesPath: fixture.puzzlesPath, trackedArchivePath: fixture.trackedArchivePath, timeZone: LA };
}

function plantDatabase(path: string, pins: readonly DayPin[], journal: "wal" | "delete"): void {
  const store = new Store(path);
  try {
    plantPlayer(store);
  } finally {
    store.close();
  }

  const tracked = trackedRows();
  const db = new Database(path, { readwrite: true });
  try {
    // As the game's own connection has it, so a planted row that would break a
    // reference fails here rather than sitting in the file.
    db.exec("PRAGMA foreign_keys = ON");
    plantPins(db, pins);
    plantSubmissions(db, tracked.published.puzzle);
    plantCorrections(db);
    plantArchive(db, tracked);
    if (journal === "delete") setRollbackJournal(db);
  } finally {
    db.close();
  }
  if (journal === "delete") removeWalFiles(path);
}

/**
 * One player who has done everything a player can: played four tiers, a
 * rush, cleared a puzzle, saved settings, and found a line of their own.
 */
function plantPlayer(store: Store): void {
  store.upsertPlayer(PLAYER);
  const played = DEFAULT_PINS.filter((pin) => pin.day === FIRST_EXTREME_DAY);
  for (const pin of played) {
    store.recordRun(pin.day, pin.tier as DailyTier, pin.puzzleId, PLAYER, GUILD_ID, {
      solved: true,
      attack: 8,
      targetAttack: 8,
      durationMs: 41_000,
      totalMs: 95_000,
      resets: 2,
      piecesPlaced: 7,
      clears: ["tsd", "tsd"],
    });
  }
  store.recordRushRun(TODAY - 1, PLAYER, GUILD_ID, {
    solved: 7,
    attempted: 9,
    skipsUsed: 1,
    timeToLastSolveMs: 170_000,
    elapsedMs: 180_000,
  });
  store.recordClear({ playerId: DISCORD_ID, puzzleId: CORRECTED_ID, durationMs: 41_000 });
  store.savePreferences(PLAYER, { planted: MARK.preference });
  store.recordSolution({
    puzzleId: CORRECTED_ID,
    canonicalKey: MARK.foundKey,
    keyVersion: 1,
    placements: plantedPlacements(),
    events: plantedLog(MARK.foundLine),
    handling: DEFAULT_HANDLING,
    attack: 22,
    targetAttack: 22,
    clears: ["tst", "tst", "tst"],
    solvedStrict: true,
    source: "player",
    foundBy: DISCORD_ID,
    guildId: GUILD_ID,
  });
  store.pinRushPool(TODAY, [
    { id: 1, difficulty: 1 },
    { id: 2, difficulty: 6 },
    { id: 3, difficulty: 9 },
  ]);
}

/**
 * An input log carrying a marker.
 *
 * Nothing that reads a log checks more than that it is a list until a replay,
 * and nothing here replays it — so the marker can ride along in an extra field,
 * and a log leaked whole carries it out with it.
 */
function plantedLog(marker: string): InputEvent[] {
  return [
    { frame: 0, type: "keydown", data: { key: "hardDrop", subframe: 0 }, planted: marker },
  ] as unknown as InputEvent[];
}

/** A player-found line, marked the same way: the placements are the secret. */
function plantedPlacements(): SolutionStep[] {
  return [
    { piece: "T", cells: [[0, 0], [1, 0], [2, 0], [1, 1]], clear: "tst", attack: 22, planted: MARK.foundPlacements },
  ] as unknown as SolutionStep[];
}

function plantPins(db: Database, pins: readonly DayPin[]): void {
  const insert = db.query<unknown, [number, string, number]>(
    "INSERT INTO day_puzzles (day, tier, puzzle_id) VALUES (?1, ?2, ?3)",
  );
  db.transaction(() => {
    for (const pin of pins) insert.run(pin.day, pin.tier, pin.puzzleId);
  })();
}

/**
 * One accepted player puzzle, one pending, one rejected.
 *
 * The board, queue and answer are tracked row 141's, so the accepted one is a
 * puzzle `PuzzleArchive.load` will take. Each author's name differs from the
 * player's current one, as a rename after filing leaves it — so the
 * submission's own column is what carries it.
 */
function plantSubmissions(db: Database, content: Puzzle): void {
  const accepted = insertSubmission(db, draftOf(content, COMMUNITY_AUTHOR, COMMUNITY_TITLE));
  const decided = acceptSubmission(db, accepted.submissionId, {
    reviewedBy: OFFICER.reviewer,
    difficulty: 3,
    note: MARK.acceptanceNote,
  });
  if (decided.submission.puzzleId !== COMMUNITY_ID) {
    throw new Error(`The accepted puzzle took id ${decided.submission.puzzleId}, not ${COMMUNITY_ID}`);
  }

  insertSubmission(db, draftOf(content, MARK.pendingAuthor, MARK.pendingTitle));

  const rejected = insertSubmission(db, draftOf(content, MARK.rejectedAuthor, MARK.rejectedTitle));
  rejectSubmission(db, rejected.submissionId, { reviewedBy: OFFICER.reviewer, note: MARK.reviewerNote });
}

function draftOf(content: Puzzle, author: string, title: string): SubmissionDraft {
  const solution = content.solution ?? [];
  return {
    player: { ...PLAYER, username: author },
    guildId: GUILD_ID,
    title,
    goal: content.goal,
    claimedDifficulty: 3,
    board: content.board,
    queue: content.queue,
    hold: content.hold,
    targetAttack: content.targetAttack,
    solution,
    events: plantedLog(MARK.inputLog),
    handling: DEFAULT_HANDLING,
    piecesPlaced: solution.length,
    clears: solution.flatMap((step) => (step.clear ? [step.clear] : [])),
    requiredClears: content.requiredClears ?? null,
  };
}

/** Retitled twice, so the log's `was` holds the planted title and the row the final one. */
function plantCorrections(db: Database): void {
  writeOverride(db, CORRECTED_ID, { title: MARK.overrideWas }, OFFICER.corrector);
  writeOverride(db, CORRECTED_ID, { title: CORRECTED_TITLE }, OFFICER.corrector);
}

/**
 * Row 141 synced and published; row 142 synced, edited and left unpublished.
 *
 * The edit is what writes `archive_content_log`: 142 first goes in as an
 * earlier draft with a different target, and the second upsert changes its
 * content, which `upsertArchive` records under the editor's name.
 */
function plantArchive(db: Database, tracked: TrackedRows): void {
  const { published, unpublished } = tracked;
  upsertArchive(db, published.puzzle, NOW, "sync-archive", metaOf(published));
  publishArchive(db, [PUBLISHED_ID], OFFICER.publisher, NOW);

  const final = { ...unpublished.puzzle, title: MARK.unpublishedTitle };
  const draft = { ...final, targetAttack: final.targetAttack + 1 };
  upsertArchive(db, draft, NOW - 86_400_000, "sync-archive", metaOf(unpublished));
  const edit = upsertArchive(db, final, NOW, OFFICER.editor, metaOf(unpublished));
  if (edit.kind !== "amended" || !edit.fields.includes("content")) {
    throw new Error(`Editing #${UNPUBLISHED_ID} logged nothing: ${JSON.stringify(edit)}`);
  }
}

function metaOf(entry: ArchiveEntry): { addedOn: string | null; solveCount: number | null } {
  return { addedOn: entry.addedOn, solveCount: entry.solveCount };
}

interface TrackedRows {
  readonly published: ArchiveEntry;
  readonly unpublished: ArchiveEntry;
}

/** Rows 141 and 142 as the committed tracked archive holds them, answers included. */
function trackedRows(): TrackedRows {
  const tracked = new Database(TRACKED_ARCHIVE, { readonly: true });
  try {
    const row = (id: number): ArchiveEntry => {
      const entry = archiveEntry(tracked, id);
      if (!entry?.puzzle.solution?.length) {
        throw new Error(`The tracked archive has no answered row ${id} for the fixture to copy`);
      }
      return entry;
    };
    return { published: row(PUBLISHED_ID), unpublished: row(UNPUBLISHED_ID) };
  } finally {
    tracked.close();
  }
}

/** Leaves the file in rollback-journal mode, which needs this to be the only connection. */
function setRollbackJournal(db: Database): void {
  const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE").get()?.journal_mode;
  if (mode !== "delete") throw new Error(`Could not leave WAL: journal_mode is ${mode}`);
}

/**
 * Makes a rollback-journal database the one file it is, on every platform.
 *
 * Apple's system SQLite, which Bun uses on macOS, keeps `-wal` and `-shm`
 * beside a database after its last connection closes — even once it has left
 * WAL — where a Linux build deletes them. Nothing reads them once the journal
 * is DELETE, and every connection here is closed, so they go: a test that
 * copies or hashes the file then sees the same directory on a laptop and on
 * the box.
 */
function removeWalFiles(path: string): void {
  for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}
