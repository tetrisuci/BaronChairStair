/**
 * Where a Blueprint code becomes a link.
 *
 * The club's spreadsheet stores these two ways in two tabs — a bare code on
 * one, a full URL on the other — and the website validates the host it links
 * to. Building the URL here from the code means downstream projects never have
 * to know that, and never have to trust a host that arrived in data.
 *
 * Shared, and importing nothing, because two servers build these links now:
 * `/api/public` and the puzzle database (`activity/puzzledb/`). The database's
 * privacy boundary is the one module allowed to decide what leaves it, and it
 * must not load a route module of the game's to learn one string.
 */
export const BLUEPRINT_VIEWER = "https://bp.tali.software/?";

/**
 * The viewer link for a code, or null when there is no code to link.
 *
 * Empty counts as none: a puzzle a player wrote has no code at all, and the
 * archive stores `""` for a code the sheet left blank. Either way there is
 * nothing for the viewer to open, and a link to its empty page is worse than
 * no link.
 */
export function blueprintLink(code: string | null | undefined): string | null {
  return code ? `${BLUEPRINT_VIEWER}${code}` : null;
}
