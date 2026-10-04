/**
 * The page's one request: the whole archive, from `/puzzles.json`.
 *
 * Same origin, no credentials, no prefix and no token. The site's server
 * builds the file on every change to what players are dealt and serves it
 * revalidated on every use — no-cache with an ETag, so an unchanged archive
 * costs a bodyless 304 — and the page asks once per visit, then filters,
 * routes and steps answers from then on without the network.
 *
 * A failure becomes an `ApiError`, the type the game and the review tool
 * already throw, so a failed request reads the same wherever it happened: a
 * status of 0 for "the server was never reached", otherwise the server's own
 * sentence and its status.
 */

import { ApiError } from "../../client/src/api";
import type { SiteData } from "../wire";
import { readSiteData } from "./data";

/** Where the archive is, relative to whatever host served the page. */
export const DATA_PATH = "/puzzles.json";

/**
 * What the page fetches with.
 *
 * Narrower than `typeof fetch` on purpose. Bun's `fetch` type carries extras
 * (`preconnect`) that a browser's does not, so a test standing in for the
 * network would have to forge them; this is the one call the page makes.
 */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** The browser's own, called through an arrow so it is never invoked with a foreign `this`. */
const browserFetch: Fetcher = (input, init) => fetch(input, init);

/** Reads the archive, or throws an `ApiError` that says why it could not. */
export async function loadSiteData(fetcher: Fetcher = browserFetch): Promise<SiteData> {
  let response: Response;
  try {
    response = await fetcher(DATA_PATH, { headers: { Accept: "application/json" } });
  } catch (cause) {
    // Kept as the cause rather than logged here: the page logs the failure
    // once, with this attached, at the point it decides what to show.
    throw Object.assign(new ApiError("Could not reach the archive. Check your connection.", 0), { cause });
  }

  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: unknown) => {
        const error = (body as { error?: unknown } | null)?.error;
        return typeof error === "string" ? error : null;
      })
      .catch(() => null);
    throw new ApiError(detail ?? `Request failed (${response.status})`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    const error = new ApiError("The archive answered with something that is not JSON.", response.status);
    throw Object.assign(error, { cause });
  }
  return readSiteData(body);
}
