/**
 * The page's requests: the index, from `/puzzles.json`, once per visit, and
 * one body from `/data/…` for each page that needs more than the index.
 *
 * Same origin, no credentials, no prefix and no token. The site's server
 * builds every file on every change to what is public and serves them
 * revalidated on every use — no-cache with an ETag, so an unchanged file costs
 * a bodyless 304. The index names every page, so filtering, routing and the
 * tab's title never wait on the network; a body is what a day's boards, a
 * player's runs, a puzzle's lines and the all-time boards are drawn from.
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
  return readSiteData(await fetchJson(DATA_PATH, fetcher));
}

/**
 * Reads one page's body, unchecked: the page knows which body it asked for and
 * checks its shape (`readBody`). A miss is an `ApiError` with status 404, which
 * the page shows as the missing page it is.
 */
export async function loadBody(path: string, fetcher: Fetcher = browserFetch): Promise<unknown> {
  return fetchJson(path, fetcher);
}

/** One same-origin JSON request, or an `ApiError` in the server's own words. */
async function fetchJson(path: string, fetcher: Fetcher): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(path, { headers: { Accept: "application/json" } });
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
  return body;
}
