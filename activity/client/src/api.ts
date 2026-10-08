/**
 * Typed client for the activity's own API.
 *
 * Inside Discord every request has to travel through the activity proxy, which
 * expects a `/.proxy` prefix. That is the only difference between running in
 * Discord and running on localhost, so it is handled once, here.
 *
 * Two things ride along on every request without the caller asking: the
 * server's build is read off each response ({@link Api.onServerBuild}), and
 * the three hand-ins — the daily filing, the rush hand-in and the practice
 * clear — ask again through a restart ({@link withHandInRetries}). Nothing
 * else retries; every other call behaves exactly as it always did.
 */

import type { ProfileStats } from "./ui/profile";
import type { DailyTier } from "@shared/daily";
import type { Handling } from "@shared/tetris/handling";
import type { InputEvent } from "@shared/tetris/verify";
import type { ClearName, Mino, PuzzlePrompt, RowCode, SolutionStep } from "@shared/puzzle";
import { BUILD_ID_HEADER } from "@shared/runtime-status";
import { isBuildId } from "./build-id";

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
 * One alternate solution, as Explore's "Alternate solutions" tab lists it.
 * Mirrors `AlternateRow` in `server/alternates.ts`, which says why each field
 * is what it is.
 *
 * `locked` is "you have not solved this puzzle": the server then sends
 * `attack`, `pieces` and `clears` as null, and the row must say "solve it
 * first" rather than print them. A puzzle the reader may not see at all —
 * today's unsolved tier — is simply not in the list.
 */
export interface AlternateRow {
  readonly solutionId: number;
  readonly puzzleId: number;
  readonly title: string;
  /** Null when the puzzle is unrated. */
  readonly difficulty: number | null;
  readonly set: string | null;
  readonly finder: PlayerProfile | null;
  readonly foundAt: number;
  readonly locked: boolean;
  readonly attack: number | null;
  readonly pieces: number | null;
  readonly clears: readonly ClearName[] | null;
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

/**
 * Where the signed-in player stands on db.tetrisatuci.org, as the game's server
 * reads it: `GET /api/site-visibility`, and the answer to every
 * `PUT /api/site-visibility`.
 *
 * `hidden` is only the player's own choice. `playerKey` is the site's name for
 * them, and it is null whenever the site would not give them a page — hidden,
 * a guest, not yet keyed, or a username the site refuses to print. The game
 * reads only `hidden` today; the keys are kept so links to the site can return
 * without a server change.
 * `hasFinishedDay` says whether that page exists yet: the site builds it only
 * from finished days, so a player whose every result is from today has a key
 * and no page. `serverKey` is the site's name for the server this session
 * signed in from, or null outside one.
 */
export interface SiteVisibility {
  readonly hidden: boolean;
  readonly playerKey: string | null;
  readonly hasFinishedDay: boolean;
  readonly serverKey: string | null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

// ── Hand-ins that ride out a restart ─────────────────────────────────────────

/**
 * How long to wait before each retry of a hand-in, in milliseconds: about
 * fifteen seconds in all, after which the failure is the player's to see.
 *
 * Short first, because the common case is a restart that is already over —
 * a same-port handover leaves a gap of milliseconds, and the first retry half
 * a second later lands on the new process. Longer after, for a cold restart
 * that has to migrate the database before it listens. Capped at four seconds
 * so the player is never staring at "Reconnecting…" for long between tries.
 */
export const HAND_IN_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 3_000, 4_000, 4_000];

/**
 * Whether a failed hand-in is worth sending again.
 *
 * Only when nobody answered: 0 is a connection that never completed (the
 * process was down), and 502, 503 and 504 are a proxy — cloudflared, nginx,
 * Discord's own — answering for a server that was not there. Everything else
 * is the server's considered answer. A 4xx cannot change by asking again, and
 * a 500 is a bug, where six retries are six copies of one log line and fifteen
 * seconds of "Reconnecting…" before the player learns what the first said.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

/** What a hand-in's caller hears about a retry it is about to make. */
export interface RetryNotice {
  /** The attempt about to be made: 2 is the first retry. */
  readonly attempt: number;
  /** How long until it is sent. */
  readonly delayMs: number;
  /** Why the last one failed: 0 for no connection, else the proxy's status. */
  readonly status: number;
}

export interface HandInOptions {
  /**
   * Epoch ms, on this page's clock, after which no attempt is started. The
   * last wait is cut short to land on it rather than skipped, because the
   * one case with a deadline — the rush — loses everything if it gives up a
   * second early.
   */
  readonly deadline?: number;
  /** Told before each wait, so the screen can say "Reconnecting…". */
  readonly onRetrying?: (notice: RetryNotice) => void;
}

/** Time, as the retries see it. A seam so tests can run fifteen seconds of backoff in none. */
export interface RetryClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: RetryClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

/**
 * How long to wait before the next attempt, or null to give up: past the
 * schedule, or out of time.
 */
function nextWait(retry: number, deadline: number | undefined, now: number): number | null {
  const delay = HAND_IN_RETRY_DELAYS_MS[retry];
  if (delay === undefined) return null;
  if (deadline === undefined) return delay;
  const left = deadline - now;
  return left > 0 ? Math.min(delay, left) : null;
}

/**
 * Sends a hand-in, and sends it again while the server is restarting.
 *
 * Safe because all three hand-in routes already are: the daily filing upserts
 * on (day, player, tier), a rush is first-write-wins on (day, player), and a
 * practice clear only counts up. A retry whose first attempt landed and lost
 * its answer files nothing new. The caller sends the same request each time —
 * `send` is called afresh, but over a body serialised once.
 *
 * Throws the last failure once it gives up, or the first one that is not
 * worth retrying, unchanged — so a caller's `catch` reads exactly what it did
 * before this existed.
 */
export async function withHandInRetries<T>(
  send: () => Promise<T>,
  options: HandInOptions = {},
  clock: RetryClock = SYSTEM_CLOCK,
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof ApiError) || !isRetryableStatus(error.status)) throw error;
      const wait = nextWait(retry, options.deadline, clock.now());
      if (wait === null) throw error;
      options.onRetrying?.({ attempt: retry + 2, delayMs: wait, status: error.status });
      await clock.sleep(wait);
    }
  }
}

/**
 * The status a daily filing is refused with when the sheet's day is over.
 *
 * The server stamps a run with the day it arrives on, so a sheet solved across
 * midnight — or a retry that crossed it — used to be replayed against the next
 * day's puzzle of the same tier. The filing now names its own day, and the
 * server answers this, with a sentence, when that day is not today.
 */
export const DAILY_STALE_STATUS = 409;

/** What the page lends the client: the network and the clock. Tests lend their own. */
export interface ApiOptions {
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly clock?: RetryClock;
}

export class Api {
  private token: string | null = null;
  private latestBuild: string | null = null;
  private readonly buildListeners = new Set<(buildId: string) => void>();
  private readonly send: (url: string, init: RequestInit) => Promise<Response>;
  private readonly clock: RetryClock;

  constructor(
    private readonly prefix: string,
    options: ApiOptions = {},
  ) {
    // The global is looked up on each call, as it always was, rather than
    // captured here once.
    this.send = options.fetch ?? ((url, init) => fetch(url, init));
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  /**
   * The build the server says it is serving, from the last response that
   * named one; null until one has.
   */
  get serverBuild(): string | null {
    return this.latestBuild;
  }

  /**
   * Hears the server's build whenever it changes, and at once if it is
   * already known — the first responses arrive during sign-in, before any
   * screen exists to listen.
   *
   * Every change, not just the first: during a same-port handover both
   * processes answer for a moment, so a page can hear the old id after the
   * new one. Reporting the latest lets a listener settle on what the server
   * is serving now rather than on whichever answered first.
   */
  onServerBuild(listener: (buildId: string) => void): () => void {
    this.buildListeners.add(listener);
    if (this.latestBuild !== null) listener(this.latestBuild);
    return () => this.buildListeners.delete(listener);
  }

  /** Reads the build header off any response, an error included. */
  private noteBuild(response: Response): void {
    const buildId = response.headers.get(BUILD_ID_HEADER)?.trim() ?? "";
    // A value that is not an id is ignored rather than trusted: it goes no
    // further than a comparison, but a proxy's mangled header must not read
    // as "a different build" and offer a reload that changes nothing.
    if (!isBuildId(buildId) || buildId === this.latestBuild) return;
    this.latestBuild = buildId;
    for (const listener of this.buildListeners) listener(buildId);
  }

  /** A POST of `body` that rides out a restart. Serialised once, so every attempt is the same request. */
  private handIn<T>(path: string, body: unknown, options: HandInOptions | undefined): Promise<T> {
    const init: RequestInit = { method: "POST", body: JSON.stringify(body) };
    return withHandInRetries(() => this.request<T>(path, init), options, this.clock);
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
      response = await this.send(`${this.prefix}${path}`, { ...init, headers });
    } catch (cause) {
      // Inside the Discord webview this is where a CORS refusal or a wrong
      // `/.proxy` prefix surfaces, and the browser's own message is the only
      // thing that says which.
      console.error(`[puzzle] request to ${path} failed`, cause);
      throw new ApiError("Could not reach the server. Check your connection.", 0);
    }
    this.noteBuild(response);

    if (!response.ok) {
      const detail = await response
        .json()
        .then((body: { error?: string }) => body.error)
        .catch(() => null);
      throw new ApiError(detail ?? `Request failed (${response.status})`, response.status);
    }
    // Fetch resolves once the headers arrive. The connection can still fail
    // while reading a successful response, so that read belongs to the same
    // retryable transport failure as fetch itself. Parse only after it has
    // finished: malformed JSON is a server fault, not a connection to retry.
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      console.error(`[puzzle] response from ${path} failed`, cause);
      throw new ApiError("Could not reach the server. Check your connection.", 0);
    }
    return JSON.parse(text) as T;
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

  /**
   * Files a daily run. Rides out a restart; refused with
   * {@link DAILY_STALE_STATUS} when `day` is no longer today.
   */
  submitRun(
    body: {
      /** Which of the day's tiers this log was played on. */
      tier: DailyTier;
      /** The day the sheet was dealt on — not the day it is filed on. */
      day: number;
      handling: unknown;
      events: unknown;
      resets: number;
      totalMs: number;
    },
    options?: HandInOptions,
  ): Promise<SubmitResponse> {
    return this.handIn("/api/daily/run", body, options);
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

  /**
   * Hands a rush in. Rides out a restart, with the same ticket every time,
   * until `options.deadline` — the moment the server would refuse it anyway.
   */
  submitRush(
    body: {
      ticket: string;
      handling: unknown;
      segments: readonly { events: unknown }[];
      timeToLastSolveMs: number;
      skipsUsed: number;
    },
    options?: HandInOptions,
  ): Promise<RushSubmitResponse> {
    return this.handIn("/api/rush/run", body, options);
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
   * Every alternate solution across the archive, newest first. Lines on a
   * puzzle this player has not solved come without their content; today's
   * unsolved tiers are left out. See `AlternateRow`.
   */
  alternates(): Promise<{ alternates: readonly AlternateRow[] }> {
    return this.request("/api/alternates");
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
   * Unscored, like the run it describes: nothing here reaches a daily
   * leaderboard or a streak. The line played is filed like a daily's, so it
   * reaches the Solutions menu and, if new, the Discoveries board. The log is
   * sent because the server replays it — a bare claim would let `puzzle_clears` fill with puzzles nobody played,
   * and the Explore ticks and the Archive board both read it as fact.
   *
   * Rides out a restart like the other two hand-ins. A retry whose first
   * attempt landed counts the clear twice in `times`, which is the price of
   * not losing it; nothing ranks on that count.
   */
  clearPuzzle(
    id: number,
    body: { handling: Handling; events: readonly InputEvent[] },
    options?: HandInOptions,
  ): Promise<{ solved: boolean; solution: readonly SolutionStep[] | null }> {
    return this.handIn(`/api/puzzles/${id}/clear`, body, options);
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

  /**
   * Whether this player is hidden on db.tetrisatuci.org, and their keys there.
   * Reads only; the server writes nothing.
   */
  siteVisibility(): Promise<SiteVisibility> {
    return this.request("/api/site-visibility");
  }

  /**
   * Hides this player on db.tetrisatuci.org, or shows them again.
   *
   * Its own route rather than a field of `savePreferences`, on purpose. The
   * preferences payload is rebuilt from known fields, the local copy wins on
   * load, and Reset replaces all of it — any one of which would quietly put a
   * hidden player's name back on a public site. The answer is the state the
   * server now holds, and the settings row paints from that and nothing else.
   */
  setSiteHidden(hidden: boolean): Promise<SiteVisibility> {
    return this.request("/api/site-visibility", {
      method: "PUT",
      body: JSON.stringify({ hidden }),
    });
  }
}
