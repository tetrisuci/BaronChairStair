/**
 * Which client build this process serves, including a rebuild in place.
 *
 * The client build writes its id into `build.json` inside the build directory,
 * and is compiled with the same id — so the game naming the id *from that file*
 * is what lets an open page compare like with like: "the bundle you are
 * running" against "the bundle this server would hand you now". `BUILD_ID`
 * from the environment is the fallback for a box with no build yet, and "dev"
 * for a checkout with neither. A manual deploy rewrites that directory before
 * it restarts the game: the cached reader checks for a changed file every two
 * seconds so the header names the files being served, not the old bundle that
 * was there when this process started.
 *
 * The file is read, never trusted: whatever it holds ends up in a response
 * header on every request, so anything that is not a short, plain token is
 * ignored rather than passed through — a newline in a header is a thrown
 * error on every response, not a cosmetic fault.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEV_BUILD_ID, isBuildId } from "../shared/build-id";
import { BUILD_ID_FILE } from "../shared/runtime-status";

/** No filesystem work more often than this while responding to requests. */
export const BUILD_ID_REFRESH_MS = 2_000;

/** The id recorded in the build directory, or null when there is none worth reading. */
function recordedIn(buildDir: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(buildDir, BUILD_ID_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const recorded = (JSON.parse(text) as { buildId?: unknown } | null)?.buildId;
    return isBuildId(recorded) ? recorded : null;
  } catch {
    return null;
  }
}

/**
 * @param buildDir the client build this process serves (`config.paths.clientBuild`).
 * @param fromEnvironment `BUILD_ID`, if set.
 */
export function readBuildId(buildDir: string, fromEnvironment: string | null | undefined): string {
  const recorded = recordedIn(buildDir);
  if (recorded) return recorded;
  const named = fromEnvironment?.trim();
  return isBuildId(named) ? named : DEV_BUILD_ID;
}

/**
 * A cheap reader for responses: stat at most once every two seconds, and
 * parse the file only when it changed. Vite replaces it by rename, so include
 * the inode as well as its timestamps and size; a same-length id or a newly
 * written file with the same modification time is still a different build.
 *
 * Missing or malformed files use the same fallback as a first boot. A build
 * empties `dist/` before writing its output, and a reader that sees that gap
 * must look again later rather than remembering the absence forever.
 */
export function createBuildIdReader(
  buildDir: string,
  fromEnvironment: string | null | undefined,
  options: { readonly now?: () => number } = {},
): () => string {
  const now = options.now ?? Date.now;
  const file = join(buildDir, BUILD_ID_FILE);
  let checkedAt = -Infinity;
  let previous: string | null | undefined;
  let buildId: string = DEV_BUILD_ID;
  return () => {
    const at = now();
    if (at >= checkedAt && at - checkedAt < BUILD_ID_REFRESH_MS) return buildId;
    checkedAt = at;
    let version: string | null;
    try {
      const stat = statSync(file);
      version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
      version = null;
    }
    if (version !== previous) {
      previous = version;
      buildId = readBuildId(buildDir, fromEnvironment);
    }
    return buildId;
  };
}
