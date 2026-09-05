/**
 * The review tool's own client for `/api/review/*`.
 *
 * Deliberately not a mode of `client/src/api.ts`. That one is the activity's:
 * it carries the `/.proxy` prefix Discord's iframe needs and it holds a player
 * session. This page is opened in an ordinary browser tab, from a link, by
 * somebody who has no player identity here at all. The two share `ApiError`,
 * because a failed request should read the same wherever it happened, and
 * nothing else.
 */

import type { ArchiveListing, ClearName, Mino, RowCode, SolutionStep } from "@shared/puzzle";
import { ApiError } from "../src/api";

/** One row of the queue: enough to choose from, never enough to judge. */
export interface QueueRow {
  readonly submissionId: number;
  readonly title: string;
  readonly author: string;
  readonly goal: string;
  readonly claimedDifficulty: number;
  readonly piecesPlaced: number;
  /**
   * The attack the author's own solve sent — named for what it is at every
   * point it is shown, because it is a different kind of number from an
   * archived puzzle's target and reading it as one is the mistake this whole
   * feature can make silently.
   */
  readonly playedAttack: number;
  readonly clears: readonly ClearName[];
  readonly createdAt: number;
}

/** One submission opened: the row, plus the board and the solve. */
export interface SubmissionDetail extends QueueRow {
  readonly board: readonly RowCode[];
  readonly queue: readonly Mino[];
  readonly hold: Mino | null;
  readonly solution: readonly SolutionStep[];
}

/** What a decision answers with. No puzzle comes back, only the verdict. */
export interface Verdict {
  readonly submissionId: number;
  readonly title: string;
  readonly author: string;
  readonly status: "accepted" | "rejected";
  readonly reviewedBy: string | null;
  readonly reviewedAt: number | null;
  readonly note: string | null;
  readonly puzzleId: number | null;
  readonly difficulty: number | null;
}

/**
 * One archived puzzle as an officer sees it: the values in force, and the ones
 * its source holds underneath them.
 *
 * The pair is the whole point of the screen, and it is why this is not
 * `ArchiveListing`. A correction is a row laid over a source that never
 * changes — `data/puzzles.json` is rewritten wholesale by `bun run puzzles`,
 * and an accepted submission keeps the row the author filed — so "what does
 * this say now" and "what did it say before anybody touched it" are two
 * different questions and the officer needs both in front of them.
 *
 * `overridden` is whether a correction row exists at all, which is not the same
 * as any field differing: the route records a correction that repeats its
 * source rather than normalising it away. Which *fields* differ is read off
 * `original` against the values beside it — see `client/review/correction.ts`.
 */
export interface ReviewPuzzle extends ArchiveListing {
  readonly overridden: boolean;
  /**
   * A correction that is on file but not being served.
   *
   * Two ways in: this row is malformed, or the corrected archive emptied a
   * daily band and the server refused every correction whole. Either way the
   * values beside it are the source's, and a page that did not say so was
   * showing an officer a fix that no player has.
   */
  readonly shelved: boolean;
  readonly original: {
    readonly title: string;
    readonly author: string;
    readonly goal: string;
    readonly difficulty: number;
    readonly set: string | null;
  };
  readonly updatedAt: number | null;
  /**
   * Who last moved each field, and when.
   *
   * Per field, not per row. The table keeps one `updated_by` for five
   * independently correctable fields and restamps it on every write, so a
   * row-level name credits whoever wrote last for everything the officer
   * before them did — and overwrites that officer's name in place. The values
   * here come from the append-only log, which survives both a second
   * correction and the revert that removes the row.
   *
   * The review grant's subject: an attribution somebody typed, never an
   * identity.
   */
  readonly correctedBy: Readonly<Record<string, { readonly by: string; readonly at: number }>>;
  /** Every move ever made to this puzzle's metadata, oldest first. */
  readonly history: readonly OverrideMove[];
  /** Never set on a real row. The discriminant `OrphanedOverride` carries. */
  readonly orphaned?: false;
}

/** One move in a puzzle's correction history. */
export interface OverrideMove {
  readonly field: string;
  readonly was: string | null;
  readonly became: string | null;
  readonly at: number;
  readonly by: string;
}

/**
 * A correction whose puzzle is no longer in the archive.
 *
 * `bun run puzzles` rewrites the file from the club's sheet, so a puzzle can
 * leave it while its correction row stays behind — and the merge is by id
 * alone, so whatever the club numbers next would inherit that correction. The
 * route lists these so an officer can reach one and delete it.
 *
 * A separate type rather than `ReviewPuzzle` with everything nullable, because
 * this is what the server actually sends: no title, no author, no goal, no
 * `pieces`, and no `original` to compare against. Writing that as one loose
 * interface is what let `matches()` call `.toLowerCase()` on a null and take
 * the Archive tab down on the first keystroke. As a union member, every
 * consumer has to say what it does with one, and `tsc` checks that it did.
 */
export interface OrphanedOverride {
  readonly id: number;
  readonly orphaned: true;
  readonly overridden: true;
  readonly updatedAt: number | null;
  readonly correctedBy: Readonly<Record<string, { readonly by: string; readonly at: number }>>;
  readonly history: readonly OverrideMove[];
}

/** A row of the Archive tab: a puzzle, or a correction that outlived one. */
export type ArchiveRow = ReviewPuzzle | OrphanedOverride;

/**
 * A correction, field by field: absent leaves a field alone, `null` puts that
 * one field back to the source, a value sets it.
 *
 * The three states are the shape of the route rather than a convenience, and
 * they are why this is a bag of optional fields instead of a whole record —
 * see `readOverrideChanges` in `server/submission-input.ts`. `JSON.stringify`
 * drops undefined keys, so an object built by omitting what did not change
 * serialises to exactly the body that route reads, with no filtering step in
 * between for a later edit to get wrong.
 */
export interface PuzzleChanges {
  readonly title?: string | null;
  readonly author?: string | null;
  readonly goal?: string | null;
  readonly difficulty?: number | null;
  readonly set?: string | null;
}

export class ReviewApi {
  /**
   * The review token, held in a variable and nowhere else.
   *
   * **Never `localStorage`, never `sessionStorage`, never a cookie.** This is
   * not a preference about tidiness and it must not be "fixed" later:
   *
   * - A **cookie** would manufacture CSRF in a codebase that has no answer to
   *   it. There is not one cookie anywhere in this repo, no `SameSite`
   *   configuration, no CORS middleware and no Origin check — which is exactly
   *   why nothing needs a CSRF token today: authentication is a header a
   *   browser never attaches by itself, so a cross-site POST arrives
   *   unauthenticated and Accept and Reject are unreachable from another
   *   origin. Put the token in a cookie and every one of those becomes a form
   *   somebody else's page can submit.
   * - **Storage** outlives the tab and the sitting. The token is good for two
   *   hours with no revocation of any kind — the only kill switch is rotating
   *   `REVIEW_SECRET` — so a shared or borrowed laptop keeps a working
   *   reviewer credential in a place anything running on the origin can read.
   *   A variable dies with the tab, which is the intended lifetime of a
   *   sitting at the queue.
   *
   * The cost is that a refresh signs you out, and that is correct: the link is
   * still in the shell of whoever minted it, not in this page's history.
   */
  private token: string | null = null;

  /**
   * Trades the link for the token. The grant goes in the **body**.
   *
   * Not in the query string, and that is the only part of this exchange that
   * buys anything: the link has already been in a URL by the time this runs, so
   * what matters is that what comes back never is.
   */
  async signIn(grant: string): Promise<string> {
    const { token, subject } = await this.request<{ token: string; subject: string }>(
      "/api/review/session",
      { method: "POST", body: JSON.stringify({ grant }) },
    );
    this.token = token;
    return subject;
  }

  queue(): Promise<{ reviewer: string; queue: readonly QueueRow[] }> {
    return this.request("/api/review/queue");
  }

  async submission(id: number): Promise<SubmissionDetail> {
    const { submission } = await this.request<{ submission: SubmissionDetail }>(
      `/api/review/submissions/${id}`,
    );
    return submission;
  }

  accept(id: number, body: { difficulty: number; note: string | null }): Promise<Verdict> {
    return this.decide(id, "accept", body);
  }

  reject(id: number, body: { note: string }): Promise<Verdict> {
    return this.decide(id, "reject", body);
  }

  /**
   * The whole archive in one response, corrections and all.
   *
   * No paging and no server-side search, for the reason `/api/archive` has
   * neither: it is twenty-odd kilobytes, and a page holding all of it filters
   * on every keystroke without a round trip. 139 rows today.
   */
  puzzles(): Promise<{ reviewer: string; puzzles: readonly ArchiveRow[] }> {
    return this.request("/api/review/puzzles");
  }

  async correct(id: number, changes: PuzzleChanges): Promise<ReviewPuzzle> {
    const { puzzle } = await this.request<{ puzzle: ReviewPuzzle }>(
      `/api/review/puzzles/${id}`,
      { method: "PATCH", body: JSON.stringify(changes) },
    );
    return puzzle;
  }

  /**
   * Puts a puzzle back to its source entirely.
   *
   * `reverted` comes back because the route is idempotent — reverting a puzzle
   * that has no correction is a 200, not a 404 — and "there was nothing to
   * revert" is a different thing to tell an officer from "done".
   *
   * `puzzle` is null when the correction was an orphan — there is no puzzle to
   * hand back, which is the case this route exists to let an officer reach.
   */
  revert(id: number): Promise<{ reverted: boolean; puzzle: ReviewPuzzle | null }> {
    return this.request(`/api/review/puzzles/${id}/override`, { method: "DELETE" });
  }

  private async decide(id: number, verb: string, body: unknown): Promise<Verdict> {
    const { decided } = await this.request<{ decided: Verdict }>(
      `/api/review/submissions/${id}/${verb}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return decided;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (init?.body) headers.set("Content-Type", "application/json");

    let response: Response;
    try {
      response = await fetch(path, { ...init, headers });
    } catch (cause) {
      console.error(`[review] request to ${path} failed`, cause);
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
}
