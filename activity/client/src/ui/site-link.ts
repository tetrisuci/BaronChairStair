/**
 * Links from the game out to db.tetrisatuci.org, and the one way to open them.
 *
 * The site is where the stored data is meant to be read, and the game's own
 * boards, profile and gallery each point at the page there that says more. The
 * link is the easy half. The hard half is that an activity cannot simply be
 * clicked out of: it runs in Discord's iframe, which may not navigate itself
 * away and whose `window.open` Discord swallows. A plain `<a target=_blank>`
 * there is a link that does nothing at all, with no error anywhere. Discord's
 * own way out is `commands.openExternalLink`, which shows the "you are leaving
 * Discord" prompt and hands the URL to the browser. So every link here is an
 * anchor — it still reads as a link, and still shows where it goes — whose
 * click is taken away from the browser and given to an opener the connection
 * chose: the SDK inside Discord, a new tab on the local dev server.
 *
 * The paths are built here and nowhere else, from keys the game's server sent.
 * Those keys are checked against the site's own pattern before they go into a
 * URL, because a value that is not of that shape is not one the site could
 * know: sending it would at best fall through to the site's "All servers", and
 * a link is no place to put a string the game has not looked at.
 */

import { COMMUNITY_ID_BASE } from "@shared/puzzle";
import { PUBLIC_KEY_PATTERN, SITE_ORIGIN } from "@shared/site";
import type { SiteVisibility } from "../api";
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

function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_KEY_PATTERN.test(value);
}

/**
 * The site's boards, on this server's when the game knows the site's name for
 * it. A session outside any server, or one whose server has not been keyed,
 * gets every server — which is what the site shows for an unknown key anyway,
 * so leaving it off only saves a pointless query string.
 */
export function leaderboardsPath(serverKey: string | null): string {
  return isPublicKey(serverKey) ? `/leaderboards?server=${serverKey}` : "/leaderboards";
}

/**
 * The player's own page, or null when there is none to link to.
 *
 * Decided by `playerKey`, never by `hidden`: the key is already null for every
 * player the site will not show, including one who never hid but whose
 * username the site refuses to print. A player with a key and no finished day
 * has no page yet — the site builds pages from finished days only — so they
 * are sent to the list of players rather than to a 404 the game handed them.
 */
export function profilePath(visibility: SiteVisibility | null): string | null {
  if (!visibility || !isPublicKey(visibility.playerKey)) return null;
  return visibility.hasFinishedDay ? `/player/${visibility.playerKey}` : "/players";
}

/**
 * A puzzle's lines on the site, or null for a puzzle the site does not list.
 *
 * Community puzzles are withheld from the site entirely, so a link to one
 * would be a 404; the site's own route also starts its ids at 1.
 */
export function puzzleLinesPath(id: number): string | null {
  if (!Number.isSafeInteger(id) || id < 1 || id >= COMMUNITY_ID_BASE) return null;
  return `/puzzle/${id}#lines`;
}
