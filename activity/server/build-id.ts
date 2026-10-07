/**
 * Which build this process serves, read once at boot.
 *
 * The client build writes its id into `build.json` inside the build directory,
 * and is compiled with the same id — so the game naming the id *from that file*
 * is what lets an open page compare like with like: "the bundle you are
 * running" against "the bundle this server would hand you now". `BUILD_ID`
 * from the environment is the fallback for a box with no build yet, and "dev"
 * for a checkout with neither.
 *
 * The file is read, never trusted: whatever it holds ends up in a response
 * header on every request, so anything that is not a short, plain token is
 * ignored rather than passed through — a newline in a header is a thrown
 * error on every response, not a cosmetic fault.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_ID_FILE } from "../shared/runtime-status";

/** What a build id may look like: a commit, a tag, a date — nothing a header could choke on. */
const USABLE_ID = /^[A-Za-z0-9._+-]{1,64}$/;

const FALLBACK = "dev";

function usable(value: unknown): value is string {
  return typeof value === "string" && USABLE_ID.test(value);
}

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
    return usable(recorded) ? recorded : null;
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
  return usable(named) ? named : FALLBACK;
}
