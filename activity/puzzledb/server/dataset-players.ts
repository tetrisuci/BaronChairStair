/**
 * How finished days went, turned from what the snapshot read into public rows.
 *
 * The snapshot has already done the part that must happen in SQL: decided who
 * may be named, aggregated every per-player number, and cut everything at the
 * first unfinished day. What is left is what the owner's policy and the
 * finished days decide, and the ranking — so this module never sees an id, a
 * hidden name or a hidden key, because none of them reached JS to be seen.
 *
 * **What is kept.** A board row survives only on a day the site shows, and in
 * a tier that day was dealt (`tiersShownOn`); a day board marks a tier it was
 * not dealt as NULL. A puzzle a player wrote keeps its row and loses its id
 * while such puzzles are withheld, as the day itself does. Stats, lines and a
 * shown player's cleared list are kept only for a puzzle the site lists, so a
 * list can be shorter than its count. Discovery counts are kept whole, as
 * the game counts them — any puzzle, voided lines included — so the site's
 * Discoveries board agrees with the game's, and can add up to more lines than
 * the site shows.
 *
 * **How it is ranked.** By `rank.ts`'s total order over published columns, so
 * no tie is broken by anything a reader cannot see. Each board's own keys come
 * first and are the game's: solved, then time, then (for a daily nobody
 * solved) attack. All-time boards drop zero and keep fifty, as the game's do.
 *
 * **What a player who hid still contributes.** Their rows, unlabelled, with
 * the values and ranks they earned — the owner's decision — and on an
 * all-time board no `detail`, the second number that would let two of their
 * rows be matched up. They are not in `players`, have no page, and have no
 * cleared list: SQL never let one out.
 *
 * **Two guards that repeat SQL on purpose.** A name holding seventeen digits
 * in a row, or a key not shaped like a key, fails the build: the refresher
 * keeps serving the last good dataset and the log says why. SQL should have
 * made both impossible; this is the second lock on the same door.
 */

import { type DailyTier, DAILY_TIERS } from "../../shared/daily";
import { PUBLIC_KEY_PATTERN } from "../../shared/site";
import { bestStreak, currentStreak } from "../../shared/streaks";
import { ALL_SERVERS, type StandingBoard, type TierMark } from "../wire";
import { isWithheld, tiersShownOn } from "./policy";
import type {
  DayBoardRow,
  LineRow,
  PlayerClearRow,
  PlayerRow,
  PlayerRows,
  PuzzleStatsRow,
  RushBoardRow,
  ServerRow,
  StandingRow,
  TierBoardRow,
} from "./public-db-players";
import { ascending, byPlayer, byText, descending, groupedBy, type Order, ranked, textOrder, then } from "./rank";
import type {
  PlayerSnapshot,
  Policy,
  SnapshotClear,
  SnapshotCount,
  SnapshotDayBoardRow,
  SnapshotLine,
  SnapshotPlayer,
  SnapshotRushRecord,
  SnapshotRushRun,
  SnapshotTierRun,
} from "./types";

/** How many rows an all-time board keeps, as the game's leaderboards. */
export const STANDINGS_SIZE = 50;

/** Seventeen ASCII digits in a row: what a Discord id looks like. */
const DIGIT_RUN = /[0-9]{17}/;

/** What a build of the player tables needs to know besides the snapshot. */
export interface PlayerScope {
  readonly policy: Policy;
  /** The days the site shows. */
  readonly days: ReadonlySet<number>;
  /** The puzzles the site lists. */
  readonly listed: ReadonlySet<number>;
}

/** Every player table's rows for one snapshot. Throws when a guard finds what SQL should have stopped. */
export function playerRows(snapshot: PlayerSnapshot, scope: PlayerScope): PlayerRows {
  assertPublishable(snapshot);
  const runs = snapshot.tierRuns
    .filter((run) => scope.days.has(run.day) && tiersShownOn(run.day, scope.policy).includes(run.tier))
    .map((run) => (isWithheld(run.puzzleId, scope.policy) ? { ...run, puzzleId: null } : run));
  const rushes = snapshot.rushRuns.filter((rush) => scope.days.has(rush.day));
  const tierBoards = tierBoardRows(runs);
  const dayBoards = dayBoardRows(snapshot.dayBoards, scope);
  const rushBoards = rushBoardRows(rushes);
  const standings = standingRows(snapshot);
  return {
    servers: serverRows(snapshot, scope.policy, { tierBoards, dayBoards, rushBoards, standings }),
    players: playerTotals(snapshot, runs, rushes),
    playerClears: clearRows(snapshot.clearedPuzzles, scope.listed),
    tierBoards,
    dayBoards,
    rushBoards,
    standings,
    puzzleStats: statsRows(runs, scope.listed),
    lines: lineRows(snapshot.lines, scope.listed),
  };
}

/** Every row of the snapshot that names somebody, or would. */
function everyPlayer(snapshot: PlayerSnapshot): SnapshotPlayer[] {
  return [
    ...snapshot.tierRuns,
    ...snapshot.dayBoards,
    ...snapshot.rushRuns,
    ...snapshot.rushRecords,
    ...snapshot.dailyDays,
    ...snapshot.cleared,
    ...snapshot.clearedPuzzles,
    ...snapshot.discoveries,
  ];
}

function assertPublishable(snapshot: PlayerSnapshot): void {
  for (const row of everyPlayer(snapshot)) {
    if (row.name !== null && DIGIT_RUN.test(row.name)) {
      throw new Error("A player's name holding seventeen digits in a row reached the build; refusing to publish it");
    }
    if (row.playerKey !== null && !PUBLIC_KEY_PATTERN.test(row.playerKey)) {
      throw new Error("A player key not shaped like a public key reached the build; refusing to publish it");
    }
  }
  for (const server of snapshot.servers) {
    if (server.name !== null && DIGIT_RUN.test(server.name)) {
      throw new Error("A server's name holding seventeen digits in a row reached the build; refusing to publish it");
    }
    if (!PUBLIC_KEY_PATTERN.test(server.key)) {
      throw new Error("A server key not shaped like a public key reached the build; refusing to publish it");
    }
  }
}

type KeptRun = Omit<SnapshotTierRun, "puzzleId"> & { readonly puzzleId: number | null };

/** The game's tier board order — solved, fastest, then most attack — and then D12's tail. */
const TIER_ORDER: Order<KeptRun> = then<KeptRun>(
  descending((run) => (run.solved ? 1 : 0)),
  ascending((run) => run.timeMs),
  descending((run) => run.attack),
  byPlayer(),
  byText((run) => run.serverKey),
  ascending((run) => run.puzzleId),
  ascending((run) => run.targetAttack),
);

function tierBoardRows(runs: readonly KeptRun[]): TierBoardRow[] {
  const groups = groupedBy(runs, (run) => `${run.day}:${run.tier}`);
  return [...groups.values()].flatMap((group) =>
    ranked(group, TIER_ORDER).map(({ rank, row }): TierBoardRow => [
      row.day,
      row.tier,
      rank,
      row.serverKey,
      row.playerKey,
      row.puzzleId,
      row.solved ? 1 : 0,
      row.timeMs,
      row.attack,
      row.targetAttack,
    ]),
  );
}

const DAY_ORDER: Order<SnapshotDayBoardRow> = then<SnapshotDayBoardRow>(
  descending((row) => row.solved),
  ascending((row) => row.timeMs),
  byPlayer(),
  ...DAILY_TIERS.map((tier) => descending<SnapshotDayBoardRow>((row) => row.marks[tier])),
);

function dayBoardRows(rows: readonly SnapshotDayBoardRow[], scope: PlayerScope): DayBoardRow[] {
  const groups = groupedBy(
    rows.filter((row) => scope.days.has(row.day)),
    (row) => `${row.day}:${row.scope}`,
  );
  return [...groups.values()].flatMap((group) =>
    ranked(group, DAY_ORDER).map(({ rank, row }): DayBoardRow => {
      const shown = tiersShownOn(row.day, scope.policy);
      const mark = (tier: DailyTier): TierMark | null => (shown.includes(tier) ? row.marks[tier] : null);
      return [row.day, row.scope, rank, row.playerKey, row.solved, row.timeMs, ...markCells(mark)];
    }),
  );
}

function markCells(mark: (tier: DailyTier) => TierMark | null) {
  return [mark("easy"), mark("medium"), mark("hard"), mark("extreme")] as const;
}

const RUSH_ORDER: Order<SnapshotRushRun> = then<SnapshotRushRun>(
  descending((row) => row.solved),
  ascending((row) => row.timeMs),
  byPlayer(),
  byText((row) => row.serverKey),
);

function rushBoardRows(rushes: readonly SnapshotRushRun[]): RushBoardRow[] {
  return [...groupedBy(rushes, (rush) => String(rush.day)).values()].flatMap((group) =>
    ranked(group, RUSH_ORDER).map(({ rank, row }): RushBoardRow => [
      row.day,
      rank,
      row.serverKey,
      row.playerKey,
      row.solved,
      row.timeMs,
    ]),
  );
}

/** One all-time board's row before it is ranked. */
interface Standing extends SnapshotPlayer {
  readonly scope: string;
  readonly value: number;
  readonly detail: number | null;
  readonly timeMs: number | null;
  readonly day: number | null;
}

/** Value first, then for rush the time and day as the game's record book orders them, then D12's tail. */
const STANDING_ORDER: Order<Standing> = then<Standing>(
  descending((row) => row.value),
  ascending((row) => row.timeMs),
  ascending((row) => row.day),
  byPlayer(),
  descending((row) => row.detail),
);

function standing(player: SnapshotPlayer, value: number, extra: Partial<Standing> = {}): Standing {
  return { playerKey: player.playerKey, name: player.name, scope: ALL_SERVERS, value, detail: null, timeMs: null, day: null, ...extra };
}

/** A shown player's second number; never a hidden one's, so no two of their rows can be matched by it. */
function detailOf(player: SnapshotPlayer, detail: number): number | null {
  return player.playerKey === null ? null : detail;
}

function standingsOf(snapshot: PlayerSnapshot): Record<StandingBoard, Standing[]> {
  const { cut, dailyDays } = snapshot;
  const counted = (rows: readonly SnapshotCount[]) => rows.map((row) => standing(row, row.count));
  return {
    rush: snapshot.rushRecords.map((row: SnapshotRushRecord) =>
      standing(row, row.solved, { scope: row.scope, timeMs: row.timeMs, day: row.day }),
    ),
    dailies: dailyDays.map((row) => standing(row, row.dailies, { detail: detailOf(row, row.days.length) })),
    streak: dailyDays.map((row) =>
      standing(row, currentStreak(row.days, cut), { detail: detailOf(row, bestStreak(row.days)) }),
    ),
    best_streak: dailyDays.map((row) => standing(row, bestStreak(row.days))),
    cleared: counted(snapshot.cleared),
    discoveries: counted(snapshot.discoveries),
  };
}

function standingRows(snapshot: PlayerSnapshot): StandingRow[] {
  return Object.entries(standingsOf(snapshot)).flatMap(([board, rows]) => {
    const scopes = groupedBy(
      rows.filter((row) => row.value > 0),
      (row) => row.scope,
    );
    return [...scopes.values()].flatMap((group) =>
      ranked(group, STANDING_ORDER)
        .slice(0, STANDINGS_SIZE)
        .map(({ rank, row }): StandingRow => [
          board as StandingBoard,
          row.scope,
          rank,
          row.playerKey,
          row.value,
          row.detail,
          row.timeMs,
          row.day,
        ]),
    );
  });
}

/**
 * A daily's field on the finished days it was dealt. The fastest is the first
 * solved row in tier-board order, so a tie for fastest goes the way the board
 * shows it.
 */
function statsRows(runs: readonly KeptRun[], listed: ReadonlySet<number>): PuzzleStatsRow[] {
  const groups = groupedBy(
    runs.filter((run) => run.puzzleId !== null && listed.has(run.puzzleId)),
    (run) => String(run.puzzleId),
  );
  return [...groups.values()]
    .map((group): PuzzleStatsRow => {
      const solves = group.filter((run) => run.solved).toSorted(TIER_ORDER);
      const times = solves.map((run) => run.timeMs!).toSorted((a, b) => a - b);
      const fastest = solves[0];
      return [group[0]!.puzzleId!, group.length, solves.length, fastest?.timeMs ?? null, medianOf(times), fastest?.playerKey ?? null];
    })
    .toSorted((a, b) => a[0] - b[0]);
}

/** The middle of sorted numbers, the two middles' mean rounded to a millisecond, or null with none. */
export function medianOf(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Each listed puzzle's lines, numbered in the order the snapshot read them. */
function lineRows(lines: readonly SnapshotLine[], listed: ReadonlySet<number>): LineRow[] {
  const positions = new Map<number, number>();
  return lines
    .filter((line) => listed.has(line.puzzleId))
    .map((line): LineRow => {
      const position = (positions.get(line.puzzleId) ?? 0) + 1;
      positions.set(line.puzzleId, position);
      return [line.puzzleId, position, line.attack, JSON.stringify(line.clears), JSON.stringify(line.steps)];
    });
}

/**
 * Each shown player's clears of puzzles the site lists, by key then puzzle.
 * `players.puzzles_cleared` keeps counting the rest, as the game does.
 *
 * **A clear with no shown player fails the build.** SQL lets only a shown
 * player's list out at all, because a whole set of clears names its owner
 * even unlabelled; this is the second lock on that door.
 */
function clearRows(clears: readonly SnapshotClear[], listed: ReadonlySet<number>): PlayerClearRow[] {
  return clears
    .map((clear): PlayerClearRow => {
      if (clear.playerKey === null) {
        throw new Error("A cleared puzzle reached the build without a shown player; refusing to publish it");
      }
      return [clear.playerKey, clear.puzzleId];
    })
    .filter(([, puzzleId]) => listed.has(puzzleId))
    .toSorted(([keyA, idA], [keyB, idB]) => textOrder(keyA, keyB) || idA - idB);
}

/** By shown key, the one row of each per-player list a key appears in. */
function byKey<T extends SnapshotPlayer>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.flatMap((row) => (row.playerKey === null ? [] : [[row.playerKey, row] as const])));
}

/**
 * Every shown player with something on a finished day, and their totals.
 * Streaks are asked as of the cut, so a streak stands when the newest
 * finished day was solved.
 */
function playerTotals(snapshot: PlayerSnapshot, runs: readonly KeptRun[], rushes: readonly SnapshotRushRun[]): PlayerRow[] {
  const days = byKey(snapshot.dailyDays);
  const cleared = byKey(snapshot.cleared);
  const found = byKey(snapshot.discoveries);
  const best = byKey(snapshot.rushRecords.filter((row) => row.scope === ALL_SERVERS));
  const rushCounts = new Map<string, number>();
  for (const rush of rushes) if (rush.playerKey) rushCounts.set(rush.playerKey, (rushCounts.get(rush.playerKey) ?? 0) + 1);
  const names = new Map<string, string>();
  for (const row of [...runs, ...everyPlayer(snapshot)]) {
    if (row.playerKey !== null && row.name !== null && !names.has(row.playerKey)) names.set(row.playerKey, row.name);
  }
  return [...names].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, name]): PlayerRow => {
    const solved = days.get(key)?.days ?? [];
    const record = best.get(key);
    return [
      key,
      name,
      solved.length,
      days.get(key)?.dailies ?? 0,
      currentStreak(solved, snapshot.cut),
      bestStreak(solved),
      cleared.get(key)?.count ?? 0,
      found.get(key)?.count ?? 0,
      rushCounts.get(key) ?? 0,
      record?.solved ?? null,
      record?.timeMs ?? null,
      record?.day ?? null,
    ];
  });
}

interface Published {
  readonly tierBoards: readonly TierBoardRow[];
  readonly dayBoards: readonly DayBoardRow[];
  readonly rushBoards: readonly RushBoardRow[];
  readonly standings: readonly StandingRow[];
}

/**
 * The servers some published row names, and nothing else: a server the game
 * has keyed but no finished day shows would be a name with no board. A name
 * on the owner's hide list becomes NULL, exactly as one never recorded.
 */
function serverRows(snapshot: PlayerSnapshot, policy: Policy, published: Published): ServerRow[] {
  const keys = new Set<string>();
  const add = (key: string | null) => {
    if (key !== null && key !== ALL_SERVERS) keys.add(key);
  };
  for (const row of published.tierBoards) add(row[3]);
  for (const row of published.rushBoards) add(row[2]);
  for (const row of published.dayBoards) add(row[1]);
  for (const row of published.standings) add(row[1]);
  const names = new Map(snapshot.servers.map((server) => [server.key, server.name]));
  return [...keys]
    .sort()
    .map((key): ServerRow => [key, policy.hiddenServerKeys.has(key) ? null : (names.get(key) ?? null)]);
}
