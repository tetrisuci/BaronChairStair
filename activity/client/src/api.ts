/**
 * Typed client for the activity's own API.
 *
 * Inside Discord every request has to travel through the activity proxy, which
 * expects a `/.proxy` prefix. That is the only difference between running in
 * Discord and running on localhost, so it is handled once, here.
 */

import type { ClearName, PuzzlePrompt, SolutionStep } from "@shared/puzzle";

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

export interface DailyResponse {
  readonly day: number;
  readonly resetsAt: number;
  readonly puzzle: PuzzlePrompt;
  readonly run: StoredRun | null;
  readonly streak: number;
  readonly totalSolved: number;
  readonly solution: readonly SolutionStep[] | null;
}

export interface SubmitResponse {
  readonly run: StoredRun;
  readonly isFirst: boolean;
  readonly streak: number;
  readonly totalSolved: number;
  readonly solution: readonly SolutionStep[];
  readonly leaderboard: readonly StoredRun[];
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
    handling: unknown;
    events: unknown;
    resets: number;
    totalMs: number;
  }): Promise<SubmitResponse> {
    return this.request("/api/daily/run", { method: "POST", body: JSON.stringify(body) });
  }

  leaderboard(): Promise<{ day: number; entries: readonly StoredRun[] }> {
    return this.request("/api/daily/leaderboard");
  }

  archive(): Promise<{ puzzles: readonly ArchiveEntry[]; today: number }> {
    return this.request("/api/archive");
  }

  archivePuzzle(id: number): Promise<{ puzzle: PuzzlePrompt; solution: readonly SolutionStep[] }> {
    return this.request(`/api/archive/${id}`);
  }

  preferences(): Promise<{ preferences: unknown }> {
    return this.request("/api/prefs");
  }

  savePreferences(preferences: unknown): Promise<{ ok: true }> {
    return this.request("/api/prefs", { method: "PUT", body: JSON.stringify({ preferences }) });
  }
}
