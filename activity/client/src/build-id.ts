/**
 * Which build this page is, and whether the server is serving a newer one.
 *
 * A Discord activity stays open for hours and never fetches a new bundle by
 * itself — there is no dynamic `import()` anywhere in the client — so after a
 * deploy a player goes on running the old page against the new server for as
 * long as they keep it open. The two halves are each built knowing their id:
 * this page has it compiled in (`__BUILD_ID__`, defined by `vite.config.ts`),
 * and the server reads the same build's `build.json` at boot and names it on
 * every response (`X-Build-Id`, read in `api.ts`). When they differ, the page
 * offers a reload; see `ui/update-chip.ts` for how quietly.
 *
 * Pure and importing nothing, so `vite.config.ts` can share {@link isBuildId}
 * with the page, and the site's bundle — which pulls `api.ts` in for its
 * `ApiError` — can load it without the define: the `typeof` guard below reads
 * a missing `__BUILD_ID__` as dev rather than throwing.
 */

/**
 * Replaced with a string literal at build time; absent under `bun test`, the
 * site's build and anything else that does not define it.
 */
declare const __BUILD_ID__: string | undefined;

/**
 * What a build calls itself when it cannot say which it is: a dev server, a
 * test run, or a box with neither `BUILD_ID` set nor git to ask. It never
 * offers an update and is never offered one — a build that does not know what
 * it is cannot be out of date.
 */
export const DEV_BUILD_ID = "dev";

/**
 * A short commit hash, a tag, a release name. Narrow on purpose: the id is
 * written into a response header and compared with what comes back, so a
 * space, a newline or anything a proxy might rewrite is refused at both ends.
 */
const BUILD_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

export function isBuildId(value: unknown): value is string {
  return typeof value === "string" && BUILD_ID_SHAPE.test(value);
}

function compiledBuildId(): string {
  const compiled: unknown = typeof __BUILD_ID__ === "undefined" ? undefined : __BUILD_ID__;
  return isBuildId(compiled) ? compiled : DEV_BUILD_ID;
}

/** This page's build. */
export const CLIENT_BUILD_ID: string = compiledBuildId();

/**
 * Whether the server is serving a build this page is not.
 *
 * Both must be known and neither dev. Only "different", never "newer": ids are
 * commits, which do not order, and a rollback is as much a reason to reload as
 * an upgrade. Read off the latest response each time rather than latched — a
 * page loaded from the new process can hear the old one once during a
 * handover, and must stop offering when the next answer agrees with it.
 */
export function shouldOfferUpdate(client: string | null, server: string | null): boolean {
  if (!client || !server) return false;
  if (client === DEV_BUILD_ID || server === DEV_BUILD_ID) return false;
  return client !== server;
}

/** What the app is doing, as far as a reload would interrupt it. */
export interface PlayState {
  /** The daily or practice run on the board, or null when there is none. */
  readonly runPhase: "ready" | "playing" | "solved" | "failed" | null;
  /** A rush is on its clock, or being handed in. */
  readonly rushLive: boolean;
  /** A duel socket is open — a lobby, a match, or a result with a rematch on offer. */
  readonly duelOpen: boolean;
  /** A draft is being played in the builder. */
  readonly testing: boolean;
  /**
   * A hand-in — the daily filing, a rush, a practice clear — has been sent
   * and not yet answered, retries included.
   *
   * Apart from the rest because it outlives what is on screen: the board
   * already says "solved" while the filing is out, and the player may have
   * gone Home, leaving nothing else running. A reload then throws away the
   * very request the retries hold open through a restart to save.
   */
  readonly handingIn: boolean;
}

/**
 * Whether a reload now would throw away something the player is in the middle
 * of. While it would, the chip stays out of sight.
 *
 * A run that is merely open counts: its clock started when the puzzle was put
 * in front of them, and a chip appearing over the board mid-thought is the
 * interruption this exists to avoid. A whole duel counts, lobby and result
 * included, because a reload drops the seat and the rematch with it. So does
 * a hand-in still on its way, wherever the player has gone since.
 */
export function isMidPlay(state: PlayState): boolean {
  const running = state.runPhase === "ready" || state.runPhase === "playing";
  return running || state.rushLive || state.duelOpen || state.testing || state.handingIn;
}
