/**
 * The game's routes for what db.tetrisatuci.org may show of a player.
 *
 * The site publishes finished days' boards and a page for each player, under
 * the Discord username the game already shows. A player who would rather not
 * be there says so in the activity's settings, and these two routes are that
 * setting's whole server side: one reads it, one saves it. The choice itself
 * lives in `players.site_hidden` and is read and written through
 * `store.siteIdentity` (`server/site-identity.ts`), which is also where the
 * reason it is a column rather than a preference is written down.
 *
 * Also here, because it is the other thing the site needs from a sign-in:
 * {@link recordSignInGuild}, which writes down a server's name. It is called
 * from the session route in `server/index.ts` rather than registered as a
 * route of its own, since a name is only ever learned in passing, from the
 * answer Discord gives when the sign-in checks the player is in that server.
 *
 * Registered from `server/index.ts` beside the submission routes, with the
 * save's rate limit in that file's limiter block, where the whole stack can be
 * read at once.
 */

import { HTTPException } from "hono/http-exception";
import type { VerifiedGuild } from "./auth";
import type { Store } from "./db";
import { type AppRouter, GUEST_ID, requireSession } from "./http";
import { readJsonBody } from "./limits";
import type { SiteIdentity, SiteVisibility } from "./site-identity";

export const SITE_VISIBILITY_ROUTE = "/api/site-visibility";

/**
 * What both routes answer: the setting, and the two keys the site knows this
 * player and server by. The game reads only the setting today; the keys are
 * kept so links to the site can return without a change here.
 */
export interface SiteVisibilityBody extends SiteVisibility {
  /**
   * The site's key for the server this session plays in, which a link to that
   * server's boards would carry. Null outside a server, or for one the game
   * has not keyed yet.
   */
  readonly serverKey: string | null;
}

/**
 * Registers `GET` and `PUT` on {@link SITE_VISIBILITY_ROUTE}.
 *
 * The save answers with the same body the read does, read back after the
 * write. The settings row repaints only from that answer and never from what
 * it asked for, so a player is never shown "hidden" on the strength of a save
 * that did not happen.
 */
export function registerSiteVisibilityRoutes(app: AppRouter, store: Store): void {
  // Reads only. The site rebuilds whenever this database commits, so a read
  // that wrote — even a key drawn for a server not yet seen — would rebuild the
  // whole site every time somebody opened the settings sheet.
  app.get(SITE_VISIBILITY_ROUTE, requireSession, (c) => {
    const session = c.get("session");
    return c.json(visibilityBody(store.siteIdentity, session.player.id, session.guildId));
  });

  app.put(SITE_VISIBILITY_ROUTE, requireSession, async (c) => {
    const session = c.get("session");
    // Every guest is one shared row, so one guest's choice would be every
    // guest's — and a guest is never on the site to begin with. Refused before
    // the body is read, as the submission route refuses a guest.
    if (session.player.id === GUEST_ID) {
      throw new HTTPException(403, {
        message: "A guest has no name on the site — sign in through Discord to choose",
      });
    }
    const hidden = readHidden(await readJsonBody(c));
    // Filed first, as `recordRun` files a player first. The session outlives
    // the database it was minted against — a restore, a swapped box — and
    // `setHidden` refuses a player it has no row for rather than saving
    // nothing and letting this route report success.
    store.upsertPlayer(session.player);
    store.siteIdentity.setHidden(session.player.id, hidden);
    return c.json(visibilityBody(store.siteIdentity, session.player.id, session.guildId));
  });
}

/**
 * Exactly `true` or `false`. A string, a number or a missing field is refused
 * rather than read as truthy: a client that sent `"false"` and was hidden for
 * it would have done the one thing this setting exists to prevent.
 */
function readHidden(body: Record<string, unknown>): boolean {
  if (typeof body.hidden !== "boolean") {
    throw new HTTPException(400, { message: "hidden must be true or false" });
  }
  return body.hidden;
}

function visibilityBody(
  identity: SiteIdentity,
  playerId: string,
  guildId: string | null,
): SiteVisibilityBody {
  return {
    ...identity.visibility(playerId),
    serverKey: guildId === null ? null : identity.serverKey(guildId),
  };
}

/**
 * Writes down a verified server's name at sign-in, and never fails the sign-in.
 *
 * The name exists for the website; the sign-in exists for the game. A locked
 * database or a key that would not draw must cost the site a name until the
 * next sign-in, not cost a player their session — so anything thrown is
 * logged and swallowed here, and the session is minted either way.
 *
 * Only a server the sign-in confirmed the player is in reaches this, so a
 * client cannot name a server by claiming it.
 */
export function recordSignInGuild(
  identity: Pick<SiteIdentity, "recordGuild">,
  guild: VerifiedGuild | null,
): void {
  if (guild === null) return;
  try {
    identity.recordGuild(guild.id, guild.name);
  } catch (error) {
    console.error("[site-identity] could not record a server's name at sign-in:", error);
  }
}
