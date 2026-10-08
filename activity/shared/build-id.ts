/**
 * The build's name, shared by the build tool, the server and the browser.
 *
 * It is sent in a response header, so a commit, tag or release name is fine;
 * whitespace, control characters and anything a proxy might rewrite are not.
 * Keeping the check here means a name the server accepts cannot disappear
 * when the page reads it. In particular, a plus is safe in a header and is
 * part of some release names.
 */
const BUILD_ID_SHAPE = /^[A-Za-z0-9._+-]{1,64}$/;

export function isBuildId(value: unknown): value is string {
  return typeof value === "string" && BUILD_ID_SHAPE.test(value);
}

/** An unnamed build cannot compare itself with another and offers no update. */
export const DEV_BUILD_ID = "dev";
