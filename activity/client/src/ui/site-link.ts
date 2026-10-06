/**
 * Links from the game out to db.tetrisatuci.org, and the one way to open them.
 *
 * Only the settings row that hides a player on the site draws one. The game's
 * own boards, profile and solutions link nowhere: players asked to keep
 * browsing those in the activity, and a link off every screen read as the game
 * sending them away.
 *
 * The link is the easy half. The hard half is that an activity cannot simply be
 * clicked out of: it runs in Discord's iframe, which may not navigate itself
 * away and whose `window.open` Discord swallows. A plain `<a target=_blank>`
 * there is a link that does nothing at all, with no error anywhere. Discord's
 * own way out is `commands.openExternalLink`, which shows the "you are leaving
 * Discord" prompt and hands the URL to the browser. So every link here is an
 * anchor — it still reads as a link, and still shows where it goes — whose
 * click is taken away from the browser and given to an opener the connection
 * chose: the SDK inside Discord, a new tab on the local dev server.
 */

import { SITE_ORIGIN } from "@shared/site";
import { el } from "./dom";

/** Opens an absolute URL outside the activity. Never throws into the click that called it. */
export type OpenLink = (url: string) => void;

/**
 * The part of the Discord SDK this file uses, by shape.
 *
 * Structural rather than imported, so the SDK stays out of everything that
 * draws a link — the tests among them — and only `discord.ts`, which already
 * holds an SDK, passes one in.
 */
export interface ExternalLinkCommands {
  openExternalLink(args: { url: string }): Promise<unknown>;
}

/**
 * The opener for this connection: Discord's prompt when there is an SDK to ask,
 * otherwise a new tab.
 *
 * `noopener` because the site has no business with the game's window. A
 * refused or failed prompt is logged and goes no further: the player closed a
 * dialog, and turning that into an exception inside a click handler would
 * report it as the game breaking.
 */
export function externalLinkOpener(
  commands: ExternalLinkCommands | null,
  win: Pick<Window, "open"> = window,
): OpenLink {
  if (!commands) {
    return (url) => {
      win.open(url, "_blank", "noopener");
    };
  }
  return (url) => {
    commands.openExternalLink({ url }).catch((cause: unknown) => {
      console.error("[site-link] Discord did not open the link", cause);
    });
  };
}

/** `SITE_ORIGIN` plus a path that starts with `/`. */
function siteUrl(path: string): string {
  return `${SITE_ORIGIN}${path}`;
}

/**
 * An anchor to `path` on the site, opened through `open`.
 *
 * The href is real so the link reads, hovers and copies as what it is; the
 * click never follows it, for the reason the file comment gives.
 */
export function siteLink(label: string, path: string, open: OpenLink): HTMLAnchorElement {
  const url = siteUrl(path);
  return el("a", {
    class: "site-link",
    text: label,
    attrs: { href: url, rel: "noopener", target: "_blank" },
    on: {
      click: (event) => {
        event.preventDefault();
        open(url);
      },
    },
  });
}
