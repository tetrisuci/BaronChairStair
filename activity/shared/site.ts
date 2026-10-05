/**
 * The names the game and db.tetrisatuci.org must spell the same way.
 *
 * Two programs read these. The game writes a player's and a server's public
 * key when it first sees them, and builds links to the site from them; the
 * site reads those keys out of the game's database and routes `/player/<key>`
 * by them. A key the game draws from one alphabet and the site matches with
 * another is a player whose page 404s from the very link the game handed them,
 * and nothing anywhere throws — so the alphabet, the length and the pattern
 * live here, once, in a file both may import.
 *
 * **Pure, and free of any Node or Bun API**, because the game's client, its
 * server and both halves of the site all import it, and
 * `tests/puzzledb-isolation.test.ts` allows it into the site precisely because
 * it reaches nothing else.
 *
 * What is deliberately not here any more: a publication day, a notice length
 * and a crowd size for alternate lines. The owner decided player data is shown
 * from the site's first build and every credited line is shown once its day is
 * over, so none of those numbers exists to be shared.
 */

/** Where the site lives. No trailing slash, so `${SITE_ORIGIN}${path}` never doubles one. */
export const SITE_ORIGIN = "https://db.tetrisatuci.org";

/**
 * The one identity every guest shares.
 *
 * Named because it is a gate and not a label: anything that credits a person —
 * writing a puzzle under their name, counting what they owe a review queue,
 * giving them a page on the site — has to refuse it, and a bare string repeated
 * at each of those places is one typo away from letting them all through. It
 * lives here rather than in `server/http.ts` (which re-exports it) because the
 * site has to refuse it too, and the site may not import the game's HTTP layer.
 */
export const GUEST_ID = "guest";

/**
 * The characters a public key is drawn from: digits and lower-case letters,
 * less `0`, `1`, `i`, `l` and `o`.
 *
 * The five missing ones are the characters a person copying a link off a
 * screen mistakes for one another. Lower case only, because a key appears in
 * a path and a path is case-sensitive: `/player/AbC…` and `/player/abc…` would
 * otherwise be two addresses a reader cannot tell apart.
 */
export const PUBLIC_KEY_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/**
 * Ten characters: about 49 bits, which a UNIQUE index backs up rather than
 * relies on.
 *
 * Kept below seventeen on purpose. Seventeen digits in a row is what a Discord
 * id looks like, and the site's leak scans hunt for exactly that run in every
 * byte it publishes. A key shorter than the run can never hold one, whatever
 * characters it happens to draw, so a key can never look like a leak and a
 * leak can never hide behind a key.
 */
export const PUBLIC_KEY_LENGTH = 10;

/**
 * A whole public key and nothing else: {@link PUBLIC_KEY_ALPHABET}, exactly
 * {@link PUBLIC_KEY_LENGTH} long, anchored at both ends.
 *
 * Written out as a literal rather than built from the two constants so that it
 * reads as what it matches; `tests/site-constants.test.ts` checks it admits
 * every character of the alphabet and no other.
 */
export const PUBLIC_KEY_PATTERN = /^[2-9a-hjkmnp-z]{10}$/;
