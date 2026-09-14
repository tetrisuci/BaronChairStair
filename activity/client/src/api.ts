/**
 * Typed client for the activity's own API.
 *
 * Inside Discord every request has to travel through the activity proxy, which
 * expects a `/.proxy` prefix. That is the only difference between running in
 * Discord and running on localhost, so it is handled once, here.
 */

import type { ProfileStats } from "./ui/profile";
import type { DailyTier } from "@shared/daily";
import type { Handling } from "@shared/tetris/handling";
import type { InputEvent } from "@shared/tetris/verify";
import type { ClearName, Mino, PuzzlePrompt, RowCode, SolutionStep } from "@shared/puzzle";

export interface PlayerProfile {
  readonly id: string;
  readonly username: string;
  readonly avatarUrl: string | null;
}

export interface StoredRun {
  readonly day: number;
  readonly puzzleId: number;
  readonly player: PlayerProfile;
  readonly solved: boolean;
  readonly attack: number;
  readonly targetAttack: number;
  /** The solving attempt, verified by replaying its inputs. */
  readonly durationMs: number;
  /** Wall clock from opening the puzzle to solving it. */
  readonly totalMs: number;
  readonly resets: number;
  readonly piecesPlaced: number;
  readonly clears: readonly ClearName[];
  readonly createdAt: number;
}

/** A day's board row: one player, and how each tier went for them. */
export interface DayBoardRow {
  readonly player: PlayerProfile;
  readonly solved: number;
  readonly totalMs: number;
  /** Missing means never opened; false means filed and not solved. */
  readonly marks: Partial<Record<DailyTier, boolean>>;
}

/** One of the day's tiers, with whatever this player has done to it. */
export interface DailyEntry {
  readonly tier: DailyTier;
  readonly puzzle: PuzzlePrompt;
  readonly run: StoredRun | null;
  /** Sent only once *this* puzzle is solved; solving another buys nothing. */
  readonly solution: readonly SolutionStep[] | null;
}

export interface DailyResponse {
  readonly day: number;
  readonly resetsAt: number;
  /** Easiest first, and always every tier. */
  readonly puzzles: readonly DailyEntry[];
  readonly streak: number;
  readonly totalSolved: number;
}

/** One player on the discovery board. */
export interface DiscoveryRow {
  readonly player: PlayerProfile;
  readonly found: number;
  readonly latestAt: number;
}

/**
 * One line in a puzzle's solutions gallery — a way somebody solved it.
 *
 * `finder` is null for the maker's own recorded answer, which belongs to
 * nobody and is always first.
 */
export interface GalleryLine {
  readonly solutionId: number;
  readonly placements: readonly SolutionStep[];
  readonly attack: number;
  readonly clears: readonly ClearName[];
  readonly source: "reference" | "player" | "enumerated";
  readonly finder: PlayerProfile | null;
  readonly foundAt: number;
  readonly solvedStrict: boolean;
}

/**
 * Where the player reading the board stands on it, or null if they have found
 * nothing yet.
 *
 * Sent apart from `board` because the board is the top twenty five of everybody
 * who has ever played, and almost nobody is on it.
 */
/**
 * One row of any leaderboard.
 *
 * The five boards are five unrelated queries on the server and one shape by the
 * time they reach here, so the page draws one list rather than five.
 * `detailMs` carries a duration for the boards that have one — raw, because
 * `formatDuration` in `ui/dom.ts` is the one definition of what a time looks
 * like in this app.
 */
export interface BoardEntry {
  readonly player: PlayerProfile;
  readonly value: number;
  readonly detail?: string | null;
  readonly detailMs?: number | null;
}

/** How one of today's tiers landed across everybody who filed it. */
export interface DailyTierStat {
  readonly tier: string;
  /** Hand-ins. Somebody who opened it and walked away is in none of these. */
  readonly filed: number;
  readonly solved: number;
  /** What the reader did on it. */
  readonly you: "solved" | "missed" | "none";
}

export interface DailyStats {
  readonly tiers: readonly DailyTierStat[];
  readonly standing: {
    readonly rank: number;
    readonly of: number;
    readonly solved: number;
    readonly totalMs: number;
  } | null;
}

export interface BoardCategory {
  readonly key: string;
  readonly label: string;
  /** "server" or "everyone" — printed, because it is the first thing asked. */
  readonly scope: string;
  /** What `value` counts: "solved", "puzzles", "lines". */
  readonly measure: string;
  readonly entries: readonly BoardEntry[];
}

export interface DiscoveryStanding {
  readonly rank: number;
  readonly found: number;
}

/**
 * What the just-filed run added to what the archive knows about this puzzle.
 *
 * Null when the run met nothing worth recording — an abandoned attempt, or one
 * that never reached the target — so the client can stay quiet rather than
 * announce a discovery of nothing.
 */
export interface RunDiscovery {
  readonly isNew: boolean;
  readonly known: number;
}

export interface SubmitResponse {
  readonly tier: DailyTier;
  readonly run: StoredRun;
  readonly isFirst: boolean;
  readonly discovery: RunDiscovery | null;
  readonly streak: number;
  readonly totalSolved: number;
  /**
   * Null on a server with no `data/solutions.json`, which is every ordinary
   * deploy — the answers are untracked, so `earnedSolution` returns null and the
   * reveal has nothing to show. This said `readonly SolutionStep[]` and was
   * therefore a lie in production: the client stepped straight into
   * `new SolutionPlayer(..., null)`, which throws, inside the same `try` that
   * files the run. The run had already been filed by then, so the player was
   * told "Could not file the sheet" about a sheet that was filed.
   */
  readonly solution: readonly SolutionStep[] | null;
  readonly leaderboard: readonly StoredRun[];
}

/** One player's rush, as it appears on the board. */
export interface RushRun {
  readonly day: number;
  readonly player: PlayerProfile;
  readonly solved: number;
  readonly attempted: number;
  readonly skipsUsed: number;
  readonly timeToLastSolveMs: number;
  readonly elapsedMs: number;
  readonly createdAt: number;
}

export interface RushState {
  readonly day: number;
  readonly resetsAt: number;
  readonly durationMs: number;
  readonly skips: number;
  readonly run: RushRun | null;
  readonly best: number;
  readonly leaderboard: readonly RushRun[];
}

export interface RushStart {
  /** Signed by the server; carries the instant the five minutes began. */
  readonly ticket: string;
  readonly ranked: boolean;
  readonly day: number;
  readonly durationMs: number;
  readonly skips: number;
  readonly puzzles: readonly PuzzlePrompt[];
}

/** One puzzle of a finished rush, as the verifier scored it. */
export interface RushPlayed {
  readonly id: number;
  readonly title: string;
  readonly solved: boolean;
}

/** One player's best rush ever. */
export interface RushRecord {
  readonly player: PlayerProfile;
  readonly solved: number;
  readonly timeToLastSolveMs: number;
  readonly day: number;
}

export type RushScope = "global" | "server";

export interface RushSubmitResponse {
  readonly ranked: boolean;
  /** In play order, and only the puzzles actually reached. */
  readonly played: readonly RushPlayed[];
  readonly run: RushRun;
  readonly isFirst: boolean;
  readonly best: number;
  readonly leaderboard: readonly RushRun[];
}

export interface ArchiveEntry {
  readonly id: number;
  readonly title: string;
  readonly author: string;
  readonly difficulty: number;
  readonly goal: string;
  readonly set: string | null;
  readonly pieces: number;
  readonly targetAttack: number;
  /** Whether a player wrote it and an officer accepted it. */
  readonly community: boolean;
}

/**
 * The receipt for a filed puzzle.
 *
 * `verified` is the server's own reading of the log that was sent, and the only
 * one that counts: `attack` becomes the target every later player is scored
 * against. It comes back rather than being assumed because the builder's number
 * and the server's disagreeing is the one failure an author cannot investigate
 * from their side of the wire.
 */
export interface PuzzleSubmitResponse {
  readonly ok: true;
  readonly submissionId: number;
  readonly verified: {
    readonly attack: number;
    readonly clears: readonly ClearName[];
    readonly piecesPlaced: number;
  };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export class Api {
  private token: string | null = null;

  constructor(private readonly prefix: string) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  /**
   * The duel socket's address.
   *
   * Built here so the prefix and the token both stay private. The token goes in
   * the query string because a browser cannot set a header on a WebSocket
   * handshake, and the scheme follows the page's — a page served over https
   * cannot open a plaintext socket, and inside Discord it always is.
   */
  socketUrl(path: string): string {
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = encodeURIComponent(this.token ?? "");
    return `${scheme}//${window.location.host}${this.prefix}${path}?token=${token}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (init?.body) headers.set("Content-Type", "application/json");

    let response: Response;
    try {
      response = await fetch(`${this.prefix}${path}`, { ...init, headers });
    } catch (cause) {
      // Inside the Discord webview this is where a CORS refusal or a wrong
      // `/.proxy` prefix surfaces, and the browser's own message is the only
      // thing that says which.
      console.error(`[puzzle] request to ${path} failed`, cause);
      throw new ApiError("Could not reach the server. Check your connection.", 0);
    }

    if (!response.ok) {
      const detail = await response
        .json()
        .then((body: { error?: string }) => body.error)
        .catch(() => null);
      throw new ApiError(detail ?? `Request failed (${response.status})`, response.status);
    }
    return (await response.json()) as T;
  }

  config(): Promise<{ clientId: string; allowGuestPlay: boolean }> {
    return this.request("/api/config");
  }

  session(body: { code?: string; guildId?: string | null }): Promise<{
    token: string;
    player: PlayerProfile;
    accessToken?: string;
    guest: boolean;
  }> {
    return this.request("/api/session", { method: "POST", body: JSON.stringify(body) });
  }

  daily(): Promise<DailyResponse> {
    return this.request("/api/daily");
  }

  submitRun(body: {
    /** Which of the day's tiers this log was played on. */
    tier: DailyTier;
    handling: unknown;
    events: unknown;
    resets: number;
    totalMs: number;
  }): Promise<SubmitResponse> {
    return this.request("/api/daily/run", { method: "POST", body: JSON.stringify(body) });
  }

  rushRecords(scope: RushScope): Promise<{ scope: RushScope; entries: readonly RushRecord[] }> {
    return this.request(`/api/rush/records?scope=${scope}`);
  }

  leaderboard(): Promise<{
    day: number;
    board: readonly DayBoardRow[];
    rush: readonly RushRun[];
  }> {
    return this.request("/api/daily/leaderboard");
  }

  discoveries(): Promise<{
    readonly board: readonly DiscoveryRow[];
    readonly self: DiscoveryStanding | null;
  }> {
    return this.request("/api/discoveries");
  }

  rush(): Promise<RushState> {
    return this.request("/api/rush");
  }

  startRush(practice: boolean): Promise<RushStart> {
    return this.request("/api/rush/start", {
      method: "POST",
      body: JSON.stringify({ practice }),
    });
  }

  submitRush(body: {
    ticket: string;
    handling: unknown;
    segments: readonly { events: unknown }[];
    timeToLastSolveMs: number;
    skipsUsed: number;
  }): Promise<RushSubmitResponse> {
    return this.request("/api/rush/run", { method: "POST", body: JSON.stringify(body) });
  }

  /**
   * Files a puzzle the player wrote, with the run they made on it.
   *
   * What is absent is the point. No `targetAttack`, no `id`, no `author` and no
   * `solution`: the server derives all four — the first two from replaying
   * `events` against the board beside them, the rest from the session — because
   * a target nobody earned is a bar every other player is then scored on. The
   * builder compiles this body in `toSubmission` and never fills those in.
   */
  submitPuzzle(body: {
    title: string;
    goal: string;
    /** The author's own 1–20 estimate. Advisory; the reviewer sets the real one. */
    claimedDifficulty: number;
    board: readonly RowCode[];
    queue: readonly Mino[];
    hold: Mino | null;
    handling: unknown;
    events: unknown;
  }): Promise<PuzzleSubmitResponse> {
    return this.request("/api/submissions", { method: "POST", body: JSON.stringify(body) });
  }

  rushLeaderboard(): Promise<{ day: number; entries: readonly RushRun[] }> {
    return this.request("/api/rush/leaderboard");
  }

  /** `cleared` is every puzzle this player has ever solved, however they solved it. */
  archive(): Promise<{
    puzzles: readonly ArchiveEntry[];
    today: number;
    cleared: readonly number[];
  }> {
    return this.request("/api/archive");
  }

  /** Every board, in one shape. */
  leaderboards(): Promise<{
    day: number;
    daily: DailyStats;
    categories: readonly BoardCategory[];
  }> {
    return this.request("/api/leaderboards");
  }

  /**
   * A lifetime record. Somebody else's when an id is given, otherwise the
   * caller's — the boards link to these, so a name on one can be opened.
   */
  profile(id?: string): Promise<ProfileStats> {
    return this.request(id ? `/api/profile/${id}` : "/api/profile");
  }

  /**
   * Every way a puzzle has been solved. 403 until this player has solved it
   * themselves, and 403 while it is one of today's unfiled tiers.
   */
  puzzleSolutions(id: number): Promise<{ solutions: readonly GalleryLine[] }> {
    return this.request(`/api/puzzles/${id}/solutions`);
  }

  /**
   * Files a practice solve so it counts towards what this player has cleared.
   *
   * Unscored, like the run it describes: nothing here reaches a leaderboard, a
   * streak or the discovery board. The log is sent because the server replays
   * it — a bare claim would let `puzzle_clears` fill with puzzles nobody played,
   * and the Explore ticks and the Archive board both read it as fact.
   */
  clearPuzzle(
    id: number,
    body: { handling: Handling; events: readonly InputEvent[] },
  ): Promise<{ solved: boolean; solution: readonly SolutionStep[] | null }> {
    return this.request(`/api/puzzles/${id}/clear`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * A puzzle to practise, and its answer only if this player has earned it.
   *
   * `solution` is nullable and always was — the server withholds it for a
   * puzzle this player has not cleared, and on a box with no
   * `data/solutions.json` there is no answer to send at all. The type said
   * otherwise, which is how the answer ended up being treated as always
   * present at the call sites.
   */
  archivePuzzle(
    id: number,
  ): Promise<{ puzzle: PuzzlePrompt; solution: readonly SolutionStep[] | null }> {
    return this.request(`/api/archive/${id}`);
  }

  preferences(): Promise<{ preferences: unknown }> {
    return this.request("/api/prefs");
  }

  savePreferences(preferences: unknown): Promise<{ ok: true }> {
    return this.request("/api/prefs", { method: "PUT", body: JSON.stringify({ preferences }) });
  }
}
