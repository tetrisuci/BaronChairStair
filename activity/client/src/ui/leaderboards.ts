/**
 * Every board in the app, on one page, in one shape.
 *
 * They were scattered: the day's board on the front screen, the rush boards
 * behind a rush, discoveries in the rail beside them, and no way at all to see
 * how much of the archive anybody had solved. Each was a different row type
 * rendered by different code, which is why none of them had ever been put next
 * to another.
 *
 * The server normalises all five to `{ player, value, detail }` — see
 * `/api/leaderboards` — so this file draws one list and switches which data
 * goes into it. That is the whole design: the categories are tabs, not screens,
 * because the thing a reader does here is compare, and a page that reloaded
 * between boards would make comparing a thing you do from memory.
 *
 * **Rows are buttons.** Every name here belongs to somebody with a profile, and
 * a leaderboard whose names cannot be opened is a list of strangers. That is
 * also why `scope` is printed under the heading rather than assumed: two of
 * these boards are this server's and three are everybody's, and "why am I not
 * on this" is the first question a reader asks.
 */

import type { BoardCategory, BoardEntry, DailyStats } from "../api";
import { playerAvatar } from "./avatar";
import { el, formatDuration, panel, replaceChildren } from "./dom";

export interface LeaderboardsCallbacks {
  /** Open somebody's profile. */
  readonly onPlayer: (id: string) => void;
}

export interface Leaderboards {
  readonly element: HTMLElement;
  update(categories: readonly BoardCategory[], selfId: string, daily?: DailyStats): void;
  /** Whether anything has ever been loaded into it. */
  readonly hasData: boolean;
}

const SCOPE_WORDS: Readonly<Record<string, string>> = {
  server: "This server",
  everyone: "Everyone, all time",
};

/** "7th", so a rank reads as a rank rather than as a quantity. */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** What a row's number means, so the column is never a bare integer. */
function measure(value: number, word: string): string {
  return `${value} ${value === 1 ? word.replace(/s$/, "") : word}`;
}

export function createLeaderboards(callbacks: LeaderboardsCallbacks): Leaderboards {
  const tabs = el("div", { class: "boards__tabs" });
  const scope = el("p", { class: "note boards__scope", text: "" });
  const list = el("div", { class: "board-list boards__list" });
  /**
   * How today landed as a field: four rows, one per tier, `solved of filed`.
   *
   * Every other board here is a ranking, and a ranking has no denominator — so
   * none of them can answer the question a daily player actually has after
   * filing, which is "was I the only one who could not do the extreme?". It
   * sits above the Today list and only under that tab: the other four boards
   * are all-time or a different mode and have no today to describe.
   */
  const day = el("div", { class: "boards__day" });
  const dayCard = panel("Today's four", { class: "boards__day-card" }, day);

  const element = el(
    "div",
    { class: "boards" },
    el("h2", { class: "display boards__title", text: "Leaderboards" }),
    tabs,
    dayCard,
    panel("", { class: "boards__card" }, scope, list),
  );

  const YOU_MARK: Readonly<Record<string, string>> = {
    solved: "you solved it",
    missed: "you missed it",
    none: "",
  };

  /** Draws the day panel, or hides it when this tab is not about today. */
  function drawDay(stats: DailyStats | null, forToday: boolean): void {
    dayCard.hidden = !forToday || stats === null || stats.tiers.length === 0;
    if (dayCard.hidden || !stats) return;

    replaceChildren(
      day,
      ...stats.tiers.map((tier) =>
        el(
          "div",
          { class: `boards__tier boards__tier--${tier.you}` },
          el("span", { class: "boards__tier-name", text: tier.tier }),
          // The bar is the shape of the day at a glance; the numbers under it
          // are what stops a 1-of-1 reading as a hundred per cent.
          el(
            "span",
            { class: "boards__bar" },
            el("span", {
              class: "boards__bar-fill",
              style: {
                width: `${tier.filed === 0 ? 0 : Math.round((tier.solved / tier.filed) * 100)}%`,
              },
            }),
          ),
          el("span", {
            class: "boards__tier-count",
            text: tier.filed === 0 ? "nobody yet" : `${tier.solved} of ${tier.filed}`,
          }),
          el("span", { class: "boards__tier-you", text: YOU_MARK[tier.you] ?? "" }),
        ),
      ),
      el("p", {
        class: "note boards__day-note",
        text: stats.standing
          ? `You are ${ordinal(stats.standing.rank)} of ${stats.standing.of} today. ` +
            `Counts are hand-ins — anyone who opened a tier and never filed it is in none of them.`
          : "You have not filed anything today. Counts are hand-ins.",
      }),
    );
  }

  let shown: readonly BoardCategory[] = [];
  let active = 0;
  let self = "";
  let today: DailyStats | null = null;

  // Drawn once, and replaced the moment anything arrives. The screen is shown
  // before the request is made — see `enterLeaderboards` — so this is what
  // stands in during the round trip, and only on the very first visit: after
  // that the previous boards stay on screen while the new ones are fetched,
  // which is both instant and very nearly right.
  scope.textContent = "Reading the boards…";

  function row(entry: BoardEntry, index: number, category: BoardCategory): HTMLElement {
    const detail =
      entry.detailMs != null ? formatDuration(entry.detailMs) : (entry.detail ?? "");
    return el(
      "button",
      {
        class:
          "board-list__row boards__row" +
          (entry.player.id === self ? " board-list__row--self" : ""),
        title: `Open ${entry.player.username}'s profile`,
        on: { click: () => callbacks.onPlayer(entry.player.id) },
      },
      el("span", { class: "board-list__rank", text: `${index + 1}` }),
      playerAvatar(entry.player, { size: 20 }),
      el("span", { class: "board-list__name", text: entry.player.username }),
      detail ? el("span", { class: "boards__detail", text: detail }) : null,
      el("span", {
        class: "board-list__score",
        text: measure(entry.value, category.measure),
      }),
    );
  }

  function draw(): void {
    const category = shown[active];
    replaceChildren(
      tabs,
      ...shown.map((one, index) =>
        el("button", {
          class: "btn btn--small" + (index === active ? " btn--primary" : ""),
          text: one.label,
          on: {
            click: () => {
              if (index === active) return;
              active = index;
              draw();
            },
          },
        }),
      ),
    );
    drawDay(today, category?.key === "today");
    if (!category) return;

    scope.textContent = SCOPE_WORDS[category.scope] ?? "";
    if (category.entries.length === 0) {
      replaceChildren(
        list,
        el("p", { class: "note", text: "Nobody is on this one yet. Be first." }),
      );
      return;
    }
    replaceChildren(list, ...category.entries.map((entry, i) => row(entry, i, category)));
  }

  return {
    element,
    get hasData() {
      return shown.length > 0;
    },
    update(categories, selfId, daily) {
      shown = categories;
      self = selfId;
      if (daily !== undefined) today = daily;
      // Clamped rather than reset: a reader who was on "Discoveries" when this
      // refreshed should still be on Discoveries.
      active = Math.min(active, Math.max(0, categories.length - 1));
      draw();
    },
  };
}
