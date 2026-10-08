/**
 * A real game database for the puzzle database's tests, with something planted
 * in every column that must never reach the open web.
 *
 * A test helper, not a test (its own checks are in `puzzledb-fixture.test.ts`).
 *
 * **The schema is the game's because the game built it.** The database is
 * opened by `new Store(path, undefined, { timeZone })` — config-free, and the
 * same constructor the game runs at boot — so every table, column, index and
 * migration is exactly what a production box has, the site's keys and zone
 * fact included. A hand-written schema would be a second copy that drifts, and
 * a privacy test run against the copy proves nothing about the original.
 *
 * **Rows go in through the game's own writers.** The player tables through the
 * Store's methods (`upsertPlayer`, `recordRun`, `recordSolution`,
 * `siteIdentity.setHidden`, ...) before it is closed; submissions, corrections
 * and the archive through the free helpers the routes and tools call
 * (`insertSubmission`, `acceptSubmission`, `writeOverride`, `upsertArchive`,
 * `publishArchive`, `voidDiscoveries`). Three raw writes remain, each for a
 * reason no writer can serve: `day_puzzles`, because `Store.pinDay` always
 * writes all four tiers and the days below need three, one, or a stray tier;
 * the public keys, which the game draws at random ({@link fixKeys}); and the
 * two millisecond clocks the site cuts by, which the writers take from the
 * real clock rather than {@link NOW} ({@link fixClocks}).
 *
 * **Every never-public column holds a planted value**: a string no real data
 * contains, listed in {@link PLANTED}, so a test can scan any byte the site
 * produces for every one of them at once. The Discord-shaped ids are 18 digits,
 * so a scan for long digit runs catches them as well. Officers' names all
 * begin `discord:planted-officer`, one per column, so a leak names the column
 * it came from.
 *
 * **Some columns are public for one row and forbidden for the next**: a name,
 * a key, a server's name. {@link PLAYERS} and {@link SERVERS} hold each case;
 * the withheld values are in {@link PLANTED}, and the printable ones, the
 * positive controls, in {@link MAY_PUBLISH}.
 *
 * **The days** are {@link DEFAULT_PINS}: one case each for the backfill, the
 * history start, the extreme top-up, a player's puzzle, a departed club puzzle,
 * today and a stray future pin. The clock is {@link NOW}, which is day
 * {@link TODAY} in Irvine. Runs, rushes, lines and clears sit on both sides of
 * today, so every cut the site makes has something to cut.
 *
 * **The files** are a copy of `data/puzzles.json` with no `solutions.json`
 * beside it — the shape of every deploy box, where answers come from the
 * tracked archive — and the committed tracked archive itself, read only.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ArchiveEntry,
  archiveEntry,
  publishArchive,
  upsertArchive,
  voidDiscoveries,
} from "../server/archive-rows";
import { type PlayerProfile, Store } from "../server/db";
import { writeOverride } from "../server/puzzle-overrides";
import {
  acceptSubmission,
  insertSubmission,
  rejectSubmission,
  type SubmissionDraft,
} from "../server/submissions";
import { DAILY_TIERS, type DailyTier, dayNumber, startOfDay } from "../shared/daily";
import { COMMUNITY_ID_BASE, type Puzzle, type SolutionStep } from "../shared/puzzle";
import { DEFAULT_HANDLING } from "../shared/tetris/handling";
import type { InputEvent } from "../shared/tetris/verify";
import { GUEST_ID } from "../shared/site";
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

/** The visible player's Discord id: 18 digits, as Discord's are. Synthetic. */
export const DISCORD_ID = "112233445566778899";
/** Fixture Club's Discord server id, the same shape. Synthetic. */
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

export type PlayerRole = "visible" | "unchosen" | "hidden" | "digitRun" | "guest";

export interface PlantedPlayer {
  readonly id: string;
  /** Their username, which the game shows and the site shows only for a shown player. */
  readonly name: string;
  /** Their `players.public_key`: fixed here, where the game would have drawn it at random. */
  readonly key: string;
  /** `players.site_hidden`: NULL never chose, 0 chose to be shown, 1 chose to hide. */
  readonly siteHidden: 0 | 1 | null;
}

/**
 * Everyone the site has to decide about, one case each.
 *
 * Two are shown and are the positive controls: `visible` chose to be shown,
 * `unchosen` never chose, which the site reads as shown because the owner chose
 * opt-out. Three are not: `hidden` chose to hide, `digitRun` has a name holding
 * seventeen digits in a row (what a Discord id looks like, so the site treats
 * it as hidden), and `guest` is the one row every guest shares. A withheld
 * player's name and key are planted; a shown one's are on {@link MAY_PUBLISH}.
 *
 * The ids sort in this order, so {@link FixtureOptions.reversedIds} can swap
 * which person holds the lowest one.
 */
export const PLAYERS: Readonly<Record<PlayerRole, PlantedPlayer>> = Object.freeze({
  visible: { id: DISCORD_ID, name: "fixture-visible-player", key: "vsbpayer22", siteHidden: 0 },
  unchosen: { id: "223344556677889900", name: "fixture-unchosen-player", key: "nchpayer33", siteHidden: null },
  hidden: { id: "334455667788990011", name: "planted-hidden-player", key: "hddnpayer4", siteHidden: 1 },
  digitRun: { id: "445566778899001122", name: "planted-digits-24681357924681357", key: "dgtpayer66", siteHidden: null },
  guest: { id: GUEST_ID, name: GUEST_ID, key: "gstpayer55", siteHidden: null },
});

const ROLES = Object.keys(PLAYERS) as PlayerRole[];

export type ServerRole = "club" | "unnamed" | "digitRun" | "quiet";

/** `name` is what a sign-in from it recorded, NULL if none has; `key` is public for every server. */
export type PlantedServer = Readonly<{ id: string; name: string | null; key: string }>;

/**
 * Every kind of server a board can name.
 *
 * `club` is named and shown, the positive control. `unnamed` was keyed from a
 * run and never signed in from. `digitRun`'s name holds seventeen digits, so
 * the site shows it unnamed. `quiet` is named and meant for the site's hide
 * list: a test lists {@link PlantedServer.key | its key} in the policy and
 * checks its name, which is planted, reaches no byte.
 */
export const SERVERS: Readonly<Record<ServerRole, PlantedServer>> = Object.freeze({
  club: { id: GUILD_ID, name: "Fixture Club", key: "fxcserver7" },
  unnamed: { id: "887766554433221199", name: null, key: "unnserver8" },
  digitRun: { id: "776655443322110099", name: "planted-guild-13579246813579246", key: "dgtserver9" },
  quiet: { id: "665544332211009988", name: "Listed Quiet Club", key: "qtcserver2" },
});

/**
 * Today's numbers, each odd enough that finding one in the site's output can
 * only mean today leaked. Nothing about today may be published.
 */
export const TODAY_MARKS = Object.freeze({ runAttack: 604_317, runTotalMs: 902_715_383, rushMs: 864_209_117, lineAttack: 515_157 });

/** The game's midnight that begins today, and the noon of the day before. */
const TODAY_STARTS_AT = startOfDay(TODAY, { timeZone: LA });
const YESTERDAY_NOON = startOfDay(TODAY - 1, { timeZone: LA }) + 12 * 3_600_000;
/** Just past the game's midnight: a site cutting at a later one would call it yesterday. */
const JUST_AFTER_MIDNIGHT = TODAY_STARTS_AT + 61_337;

export interface PlantedLine {
  readonly puzzleId: number;
  readonly attack: number;
  /** What the puzzle asked for when the line was filed. */
  readonly target: number;
  /** The game's day it was filed on, in the game's zone. */
  readonly day: number;
  /** `puzzle_solutions.found_at`. Planted: a line's time would name its finder. */
  readonly foundAt: number;
  readonly finder: PlayerRole | null;
  /** Matches `CREDITED`: it pays its finder on the Discoveries board. */
  readonly credited: boolean;
  /** Matches `LIVE`: not voided by an edit to its puzzle. */
  readonly live: boolean;
}

/** A line filed at `foundAt`, on whatever day that is in the game's zone. */
function line(...[puzzleId, attack, target, foundAt, finder, credited, live = true]: LineArgs): PlantedLine {
  const day = dayNumber(foundAt, { timeZone: LA });
  return Object.freeze({ puzzleId, attack, target, day, foundAt, finder, credited, live });
}
type LineArgs = [number, number, number, number, PlayerRole | null, boolean, boolean?];

/**
 * One line of each kind the site must sort: published, counted only, or
 * neither. Times are odd offsets, so no two coincide and none is a round
 * number some other column might hold.
 */
export const LINES = Object.freeze({
  /** Published. Its steps carry a planted extra field the re-projection must drop. */
  visible: line(CORRECTED_ID, 22, 22, YESTERDAY_NOON + 1_111, "visible", true),
  /** Published with no finder; the hidden player's Discoveries row is "a player". */
  hidden: line(6, 10, 10, YESTERDAY_NOON + 2_222, "hidden", true),
  /** Filed today on today's hard, credited for sending more than asked: in no line list and no count. */
  today: line(7, TODAY_MARKS.lineAttack, 8, JUST_AFTER_MIDNIGHT + 1_000, "visible", true),
  /** Voided by an edit: still counted, as the game counts it, and never shown. */
  voided: line(50, 6, 6, YESTERDAY_NOON + 3_333, "unchosen", true, false),
  /** Met the target exactly and missed the named clears: off the site entirely. */
  nearMiss: line(PUBLISHED_ID, 9, 9, YESTERDAY_NOON + 4_444, "visible", false),
  /** The batch enumerator's: nobody's, so never counted and never shown. */
  enumerated: line(6, 12, 12, YESTERDAY_NOON + 5_555, null, false),
});

/** `firstAt` is `puzzle_clears.first_at`, the column the site counts "puzzles cleared" by. */
export type PlantedClear = Readonly<{ player: PlayerRole; puzzleId: number; firstAt: number }>;

/** First clears on both sides of today's midnight, and one of a puzzle the site withholds, which it counts and never lists. */
export const CLEARS: readonly PlantedClear[] = Object.freeze([
  { player: "visible", puzzleId: CORRECTED_ID, firstAt: YESTERDAY_NOON + 6_666 },
  { player: "visible", puzzleId: COMMUNITY_ID, firstAt: YESTERDAY_NOON + 9_999 },
  { player: "unchosen", puzzleId: 50, firstAt: YESTERDAY_NOON + 7_777 },
  { player: "hidden", puzzleId: 6, firstAt: YESTERDAY_NOON + 8_888 },
  { player: "visible", puzzleId: 51, firstAt: JUST_AFTER_MIDNIGHT },
]);

/** A Discord avatar URL. It embeds the user's id, which is why the site never shows one. */
function avatarOf(id: string): string {
  return `https://cdn.discordapp.com/avatars/${id}/planted-avatar.png`;
}

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
  clearAttempt: "planted-clear-attempt",
  rushTicket: "planted-rush-ticket",
});

/**
 * Every value that must never appear in anything the site serves, under any
 * policy.
 *
 * {@link COMMUNITY_AUTHOR} and {@link COMMUNITY_TITLE} are deliberately absent:
 * listing community puzzles is meant to publish exactly those two. Scan for
 * them as well while the policy withholds community puzzles.
 *
 * So are the shown players' names and keys, every server's key, and Fixture
 * Club's name, which the site exists to publish: they are {@link MAY_PUBLISH}.
 * The guest's name is the bare word `guest`, which the site's own text may
 * use; the guest is caught by its key instead. "Listed Quiet Club" is here
 * although only the hide list withholds it, because the fixture's tests always
 * list it; a test that builds without the list must exempt it.
 */
export const PLANTED: readonly string[] = Object.freeze([
  ...Object.values(PLAYERS).flatMap((player) => (player.id === GUEST_ID ? [] : [player.id, avatarOf(player.id)])),
  ...Object.values(SERVERS).map((server) => server.id),
  ...[PLAYERS.hidden, PLAYERS.digitRun].flatMap((player) => [player.name, player.key]),
  PLAYERS.guest.key,
  SERVERS.digitRun.name!,
  SERVERS.quiet.name!,
  ...Object.values(LINES).map((line) => String(line.foundAt)),
  ...CLEARS.map((clear) => String(clear.firstAt)),
  ...Object.values(TODAY_MARKS).map(String),
  ...Object.values(OFFICER),
  ...Object.values(MARK),
]);

/**
 * What the site may print about the people and servers above: the positive
 * controls. A test that finds none of these in the site's output has proved
 * nothing by finding no {@link PLANTED} value either.
 */
export const MAY_PUBLISH: readonly string[] = Object.freeze([
  ...[PLAYERS.visible, PLAYERS.unchosen].flatMap((player) => [player.name, player.key]),
  ...Object.values(SERVERS).map((server) => server.key),
  SERVERS.club.name!,
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
  /**
   * Hands the four Discord ids out in reverse: the visible player gets the
   * highest and the digit-run player the lowest, while every name, key and row
   * stays with the person it belongs to. Two builds then differ only in which
   * person sorts first by id, so anything the site publishes in an order SQLite
   * chose by id shows up as a difference between them.
   */
  readonly reversedIds?: boolean;
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
    plantDatabase(databasePath, pins, options.journal ?? "wal", castOf(options.reversedIds ?? false));
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

function plantDatabase(path: string, pins: readonly DayPin[], journal: "wal" | "delete", cast: Cast): void {
  const store = new Store(path, undefined, { timeZone: LA });
  try {
    plantPlayers(store, cast);
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
    voidDiscoveries(db, LINES.voided.puzzleId);
    fixKeys(db, cast);
    fixClocks(db, cast);
    if (journal === "delete") setRollbackJournal(db);
  } finally {
    db.close();
  }
  if (journal === "delete") removeWalFiles(path);
}

/** Each role's profile as this build files it: the role's name, and an id that may be swapped. */
type Cast = Readonly<Record<PlayerRole, PlayerProfile>>;

function castOf(reversed: boolean): Cast {
  const order: PlayerRole[] = ["visible", "unchosen", "hidden", "digitRun"];
  const ids = order.map((role) => PLAYERS[role].id);
  if (reversed) ids.reverse();
  const profile = (role: PlayerRole, id: string): PlayerProfile =>
    Object.freeze({ id, username: PLAYERS[role].name, avatarUrl: id === GUEST_ID ? null : avatarOf(id) });
  return Object.freeze({
    ...Object.fromEntries(order.map((role, at) => [role, profile(role, ids[at]!)])),
    guest: profile("guest", GUEST_ID),
  }) as Cast;
}

/**
 * Everything players do, through the Store's own writers: who they are, what
 * they played and where, what they found, and what they chose about the site.
 */
function plantPlayers(store: Store, cast: Cast): void {
  for (const role of ROLES) store.upsertPlayer(cast[role]);
  plantDailies(store, cast);
  plantRushes(store, cast);
  for (const clear of CLEARS) {
    store.recordClear({ playerId: cast[clear.player].id, puzzleId: clear.puzzleId, durationMs: 41_000,
      attemptId: MARK.clearAttempt });
  }
  store.savePreferences(cast.visible, { planted: MARK.preference });
  plantLines(store, cast);
  store.pinRushPool(TODAY, [{ id: 1, difficulty: 1 }, { id: 2, difficulty: 6 }, { id: 3, difficulty: 9 }]);
  store.siteIdentity.setHidden(cast.visible.id, false);
  store.siteIdentity.setHidden(cast.hidden.id, true);
  for (const server of Object.values(SERVERS)) {
    if (server.name !== null) store.siteIdentity.recordGuild(server.id, server.name, NOW);
  }
}

type PlantedRun = Readonly<{
  day: number; tier: DailyTier; player: PlayerRole; server: ServerRole | null;
  solved: boolean; attack: number; target: number; totalMs: number;
}>;

function daily(...[day, tier, player, server, solved, attack, target, totalMs]: RunArgs): PlantedRun {
  return Object.freeze({ day, tier, player, server, solved, attack, target, totalMs });
}
type RunArgs = [number, DailyTier, PlayerRole, ServerRole | null, boolean, number, number, number];

/**
 * The dailies, one case per row. The hidden player's two differ in every
 * column but the player, so a test can check nothing ties their rows together
 * except the server a row names.
 */
const RUNS: readonly PlantedRun[] = Object.freeze([
  // daily(day, tier, player, server, solved, attack, target, totalMs)
  // The visible player: all four tiers on the first extreme day.
  ...DAILY_TIERS.map((tier) => daily(FIRST_EXTREME_DAY, tier, "visible", "club", true, 8, 8, 95_000)),
  // A player's puzzle, dealt as the hard two days ago.
  daily(TODAY - 2, "hard", "visible", "club", true, 7, 7, 88_100),
  // Yesterday across two servers, one tier handed in at its target without the clears it named.
  daily(TODAY - 1, "easy", "visible", "club", true, 6, 6, 64_250),
  daily(TODAY - 1, "medium", "visible", "club", false, 9, 8, 140_020),
  daily(TODAY - 1, "hard", "visible", "unnamed", true, 10, 10, 131_500),
  // Today, with numbers nothing else holds.
  daily(TODAY, "easy", "visible", "club", true, TODAY_MARKS.runAttack, 6, TODAY_MARKS.runTotalMs),
  // Outside any server, as a session with no guild files it.
  daily(TODAY - 1, "easy", "unchosen", null, true, 6, 6, 71_900),
  daily(TODAY - 1, "hard", "unchosen", "unnamed", false, 4, 10, 150_000),
  daily(TODAY - 1, "easy", "hidden", "club", true, 6, 6, 58_730),
  daily(TODAY - 2, "medium", "hidden", "quiet", false, 3, 5, 120_440),
  daily(TODAY - 1, "easy", "digitRun", "digitRun", true, 6, 6, 99_990),
  // Guests are global-only: the game never files one under a server.
  daily(TODAY - 1, "easy", "guest", null, true, 6, 6, 77_310),
]);

function plantDailies(store: Store, cast: Cast): void {
  const dealt = new Map(DEFAULT_PINS.map((pin) => [`${pin.day}:${pin.tier}`, pin.puzzleId]));
  for (const run of RUNS) {
    const puzzleId = dealt.get(`${run.day}:${run.tier}`);
    if (puzzleId === undefined) throw new Error(`The fixture plays ${run.tier} on day ${run.day}, which it never pins`);
    const guildId = run.server === null ? null : SERVERS[run.server].id;
    store.recordRun(run.day, run.tier, puzzleId, cast[run.player], guildId, {
      solved: run.solved, attack: run.attack, targetAttack: run.target, totalMs: run.totalMs,
      durationMs: Math.min(run.totalMs, 41_000), resets: 2, piecesPlaced: 7, clears: ["tsd", "tsd"],
    });
  }
}

/** Ranked rushes yesterday, from three players in two servers, and one today. */
function plantRushes(store: Store, cast: Cast): void {
  const rush = (day: number, role: PlayerRole, server: ServerRole, solved: number, ms: number) =>
    store.recordRushRun(day, cast[role], SERVERS[server].id, {
      solved, attempted: solved + 2, skipsUsed: 1, timeToLastSolveMs: ms, elapsedMs: 180_000,
    }, MARK.rushTicket);
  rush(TODAY - 1, "visible", "club", 7, 170_000);
  rush(TODAY - 1, "unchosen", "unnamed", 5, 141_200);
  rush(TODAY - 1, "hidden", "club", 6, 155_550);
  rush(TODAY, "visible", "club", 11, TODAY_MARKS.rushMs);
}

/**
 * Every line in {@link LINES}. Only the visible player's carries planted
 * placements: the others are lines the site publishes as they are.
 */
function plantLines(store: Store, cast: Cast): void {
  for (const [name, line] of Object.entries(LINES)) {
    const player = line.finder === null ? null : cast[line.finder];
    store.recordSolution({
      puzzleId: line.puzzleId,
      canonicalKey: lineKey(name),
      keyVersion: 1,
      placements: placements(line.attack, name === "visible" ? MARK.foundPlacements : null),
      events: player === null ? null : plantedLog(MARK.foundLine),
      handling: player === null ? null : DEFAULT_HANDLING,
      attack: line.attack,
      targetAttack: line.target,
      clears: ["tsd", "tsd"],
      // Credited on the solve where it met the target; today's on its surplus.
      solvedStrict: line.credited && line.attack <= line.target,
      source: player === null ? "enumerated" : "player",
      foundBy: player?.id ?? null,
      guildId: player === null ? null : GUILD_ID,
    });
  }
}

/** Each line's dedup key, planted: the key is how the game recognises a line it has seen. */
function lineKey(name: string): string {
  return `${MARK.foundKey}:${name}`;
}

/**
 * Replaces each drawn key with the one {@link PLAYERS} and {@link SERVERS} name.
 *
 * The game draws keys at random, and a fixture that kept them could neither
 * list the hidden player's key in {@link PLANTED} nor be built twice and
 * compared. The rows were made by the real writers and keyed by them; this
 * only swaps one well-formed key for another.
 */
function fixKeys(db: Database, cast: Cast): void {
  const assign = (sql: string, key: string, id: string) => {
    if (db.run(sql, [key, id]).changes !== 1) throw new Error(`The fixture found no row ${id} to key`);
  };
  for (const role of ROLES) {
    assign("UPDATE players SET public_key = ?1 WHERE id = ?2", PLAYERS[role].key, cast[role].id);
  }
  for (const server of Object.values(SERVERS)) {
    assign("UPDATE guilds SET public_key = ?1 WHERE guild_id = ?2", server.key, server.id);
  }
}

/**
 * Moves each line and first clear to the moment {@link LINES} and
 * {@link CLEARS} give it.
 *
 * The writers stamp `Date.now()`, which is the real clock and not
 * {@link NOW}: left alone, every line would be filed days after the fixture's
 * today, on no day the site could cut at. These two columns are the only
 * clocks the site reads without a day beside them.
 */
function fixClocks(db: Database, cast: Cast): void {
  const stamp = (sql: string, at: number, ...where: (string | number)[]) => {
    if (db.run(sql, [at, ...where]).changes !== 1) throw new Error(`The fixture found no row ${where} to stamp`);
  };
  for (const [name, line] of Object.entries(LINES)) {
    stamp("UPDATE puzzle_solutions SET found_at = ?1 WHERE canonical_key = ?2", line.foundAt, lineKey(name));
  }
  for (const clear of CLEARS) {
    const sql = "UPDATE puzzle_clears SET first_at = ?1, last_at = ?1 WHERE player_id = ?2 AND puzzle_id = ?3";
    stamp(sql, clear.firstAt, cast[clear.player].id, clear.puzzleId);
  }
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

/**
 * A one-step line. A marked one carries its marker in an extra field the
 * site's re-projection to `{piece, cells, clear, attack}` must drop: the
 * placements are the secret only in what rides beside them.
 */
function placements(attack: number, marker: string | null): SolutionStep[] {
  const step = { piece: "T", cells: [[0, 0], [1, 0], [2, 0], [1, 1]], clear: "tsd", attack };
  return [marker === null ? step : { ...step, planted: marker }] as unknown as SolutionStep[];
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
    player: { id: DISCORD_ID, username: author, avatarUrl: avatarOf(DISCORD_ID) },
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
