/**
 * Explore's two tabs: the puzzles, and every alternate solution to them.
 *
 * The Leaderboards' tabs, in shape and in look — `.boards__tabs`, small
 * buttons, the open one primary — with `aria-pressed` as the site's tabs carry
 * it, so the state is in words for a screen reader and not only in a colour.
 * Not `role="tab"`: nothing else here uses it, and a tablist half-implemented
 * (no arrow keys, no `aria-controls`) is worse than honest toggle buttons.
 *
 * Only the open pane is in the document. The explorer keeps its own state
 * either way — it is one long-lived element — so swapping is cheap and the
 * other tab comes back exactly as it was left.
 *
 * Which tab is open lives in this object, which lives as long as the page:
 * remembered for the session, and Puzzles again on the next launch.
 */

import { el, replaceChildren } from "./dom";

export type ExploreTab = "puzzles" | "alternates";

const TABS: readonly ExploreTab[] = ["puzzles", "alternates"];

export const EXPLORE_TAB_LABELS: Readonly<Record<ExploreTab, string>> = {
  puzzles: "Puzzles",
  alternates: "Alternate solutions",
};

export interface ExploreTabs {
  readonly element: HTMLElement;
  readonly active: ExploreTab;
}

/**
 * @param onSelect called when the reader opens a tab that was not already
 *   open — the app refetches the alternates on it.
 */
export function createExploreTabs(
  panes: Readonly<Record<ExploreTab, HTMLElement>>,
  onSelect: (tab: ExploreTab) => void,
  initial: ExploreTab = "puzzles",
): ExploreTabs {
  let active: ExploreTab = initial;
  const tabs = el("div", { class: "boards__tabs explore-tabs__bar" });
  const slot = el("div", { class: "explore-tabs__pane" });

  function draw(): void {
    replaceChildren(
      tabs,
      ...TABS.map((tab) =>
        el("button", {
          class: "btn btn--small" + (tab === active ? " btn--primary" : ""),
          text: EXPLORE_TAB_LABELS[tab],
          attrs: { "aria-pressed": String(tab === active) },
          on: {
            click: () => {
              if (tab === active) return;
              active = tab;
              draw();
              onSelect(tab);
            },
          },
        }),
      ),
    );
    replaceChildren(slot, panes[active]);
  }

  draw();

  return {
    element: el("div", { class: "explore-tabs" }, tabs, slot),
    get active() {
      return active;
    },
  };
}
