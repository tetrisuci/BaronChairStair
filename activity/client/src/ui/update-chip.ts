/**
 * "Update ready — reload when you're done": a small chip in the header.
 *
 * Quiet on purpose. A deploy is not the player's problem, and the old page
 * keeps working against the new server — every change is additive — so there
 * is nothing urgent to say. It never reloads by itself: a reload drops
 * whatever is on the board, and only the player knows whether they are done.
 * `role="status"` rather than an alert, so a screen reader mentions it once
 * when it appears instead of interrupting.
 *
 * Two layers. {@link createUpdateChip} only paints. {@link createUpdateNotice}
 * owns what the chip is about — the build the server last named — and asks
 * the app what is going on whenever it is told to look again; the rules
 * themselves are the pure ones in `build-id.ts`.
 */

import type { Api } from "../api";
import { isMidPlay, type PlayState, shouldOfferUpdate } from "../build-id";
import { el } from "./dom";

export const UPDATE_CHIP_TEXT = "Update ready — reload when you're done";

export interface UpdateChip {
  readonly element: HTMLElement;
  setVisible(visible: boolean): void;
}

export function createUpdateChip(onReload: () => void): UpdateChip {
  const element = el(
    "div",
    { class: "update-chip", attrs: { role: "status", hidden: true } },
    el("span", { class: "update-chip__text", text: UPDATE_CHIP_TEXT }),
    el("button", {
      class: "btn btn--small",
      text: "Reload",
      title: "Load the new version of the activity",
      on: { click: () => onReload() },
    }),
  );
  return {
    element,
    setVisible(visible) {
      element.hidden = !visible;
    },
  };
}

export interface UpdateNotice {
  readonly element: HTMLElement;
  /**
   * Looks again: shows the chip if the server is on another build and nothing
   * would be lost to a reload, hides it otherwise. Called when play starts,
   * so it gets out of the way at once, and on the app's once-a-second tick,
   * which is what brings it back afterwards.
   */
  refresh(): void;
}

export function createUpdateNotice(options: {
  /** This page's build. */
  readonly clientBuild: string;
  /** Where the server's build is heard from. */
  readonly api: Pick<Api, "onServerBuild">;
  /** What the app is doing right now, read on every look. */
  readonly playState: () => PlayState;
  readonly reload: () => void;
}): UpdateNotice {
  const chip = createUpdateChip(options.reload);
  let serverBuild: string | null = null;
  const refresh = (): void => {
    const offered = shouldOfferUpdate(options.clientBuild, serverBuild);
    chip.setVisible(offered && !isMidPlay(options.playState()));
  };
  // Replays the build sign-in already heard, so this can be made at any time.
  options.api.onServerBuild((buildId) => {
    serverBuild = buildId;
    refresh();
  });
  return { element: chip.element, refresh };
}
