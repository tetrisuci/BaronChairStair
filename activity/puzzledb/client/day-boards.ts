/**
 * How one finished day went: the field, the day's board, each tier's board,
 * and the rush — under the day's deal cards on `/day/:day`.
 *
 * **One server choice scopes all four.** The game shows a day per server, and
 * a reader who picked their server wants their server's day, not one card of
 * it. So the chips sit above the cards and every card is redrawn from the same
 * choice: the day board from that server's own scope (the build ranked it
 * from the hand-ins made there), and the tier and rush boards as their rows
 * filtered by server, in the same order. The chips offer only servers that
 * played that day; a key the day does not know reads as every server.
 *
 * **A hand-in reads as the game reads it.** A solve is its time; a miss is
 * what it sent against what was asked, `8/12 atk` (`client/src/ui/results.ts`).
 * The day board's score is tiers solved of tiers dealt, and the solved
 * tiers' summed time — `3/4 · 5:12.3` — beside the game's marks.
 *
 * **Counts are hand-ins.** Anybody who opened a tier and never handed it in
 * is on none of these boards, as in the game, and the field says so.
 */

import { DAILY_TIERS, type DailyTier } from "../../shared/daily";
import { el, formatDuration, panel } from "../../client/src/ui/dom";
import {
  ALL_SERVERS,
  displayRanks,
  sameHandIn,
  sameRush,
  type SiteDay,
  type SiteDayBody,
  type SiteDayBoardRow,
  type SiteTierRow,
} from "../wire";
import { boardRow, cappedList, tierMarks } from "./board-rows";
import type { SiteIndex, ViewContext } from "./data";
import { serverChips, serversAmong } from "./server-chips";

/** Rows a day's board shows before "Show all": about a club's evening. */
const TOP = 25;

/** Which rows of the day are on screen: the server chosen and the tier tab. */
interface Scope {
  readonly server: string | null;
  readonly tier: DailyTier;
}

/** Every server some row of the day names. */
function serverKeysIn(body: SiteDayBody): Set<string> {
  const keys = new Set(Object.keys(body.boards).filter((scope) => scope !== ALL_SERVERS));
  for (const row of [...body.tiers, ...body.rush]) if (row.serverKey !== null) keys.add(row.serverKey);
  return keys;
}

function inScope<T extends { readonly serverKey: string | null }>(rows: readonly T[], server: string | null): T[] {
  return server === null ? [...rows] : rows.filter((row) => row.serverKey === server);
}

function rushWords(n: number): string {
  return n === 1 ? "1 rush ran." : `${n} rushes ran.`;
}

/** Per tier: solved of handed in, as a bar and as numbers, and the fastest solve. */
function fieldCard(body: SiteDayBody, tiers: readonly DailyTier[], server: string | null): HTMLElement {
  const rows = tiers.map((tier) => {
    const handed = inScope(body.tiers, server).filter((row) => row.tier === tier);
    const solved = handed.filter((row) => row.solved);
    const fastest = solved.reduce<number | null>((best, row) => (best === null || row.timeMs! < best ? row.timeMs : best), null);
    const share = handed.length === 0 ? 0 : Math.round((solved.length / handed.length) * 100);
    return el(
      "div",
      { class: "boards__tier" },
      el("span", { class: "boards__tier-name", text: tier }),
      el("span", { class: "boards__bar" }, el("span", { class: "boards__bar-fill", style: { width: `${share}%` } })),
      el("span", { class: "boards__tier-count", text: handed.length === 0 ? "nobody" : `${solved.length} of ${handed.length}` }),
      el("span", { class: "boards__tier-you", text: fastest === null ? "" : `fastest ${formatDuration(fastest)}` }),
    );
  });
  return panel(
    "The field",
    { class: "pdb-field" },
    el("div", { class: "boards__day" }, ...rows),
    el("p", { class: "note boards__day-note", text: `${rushWords(inScope(body.rush, server).length)} Counts are hand-ins.` }),
  );
}

const sameDay = (a: SiteDayBoardRow, b: SiteDayBoardRow) => a.solved === b.solved && a.timeMs === b.timeMs;

function dayScore(row: SiteDayBoardRow): string {
  const dealt = DAILY_TIERS.filter((tier) => row.marks[tier] !== null).length;
  return row.solved > 0 ? `${row.solved}/${dealt} · ${formatDuration(row.timeMs)}` : `${row.solved}/${dealt}`;
}

function leaderboardCard(body: SiteDayBody, server: string | null): HTMLElement {
  const rows = body.boards[server ?? ALL_SERVERS] ?? [];
  const ranks = displayRanks(rows, sameDay);
  const drawn = rows.map((row, at) =>
    boardRow({ rank: ranks[at]!, player: row.player, detail: tierMarks(row.marks, DAILY_TIERS), score: dayScore(row) }),
  );
  return panel("Leaderboard", { class: "pdb-board-card" }, cappedList(drawn, "Nobody handed in a daily this day.", TOP));
}

function tierScore(row: SiteTierRow): string {
  return row.solved && row.timeMs !== null ? formatDuration(row.timeMs) : `${row.attack}/${row.targetAttack} atk`;
}

/** The tier tabs, and the board of the tab that is on. */
function tiersCard(body: SiteDayBody, tiers: readonly DailyTier[], scope: Scope, onTier: (tier: DailyTier) => void) {
  const rows = inScope(body.tiers, scope.server).filter((row) => row.tier === scope.tier);
  const ranks = displayRanks(rows, sameHandIn);
  const tabs = el(
    "div",
    { class: "boards__tabs", attrs: { role: "group", "aria-label": "Tier" } },
    ...tiers.map((tier) =>
      el("button", {
        class: `btn btn--small${tier === scope.tier ? " btn--primary" : ""}`,
        text: tier,
        attrs: { type: "button", "aria-pressed": String(tier === scope.tier) },
        on: { click: () => tier !== scope.tier && onTier(tier) },
      }),
    ),
  );
  const drawn = rows.map((row, at) =>
    boardRow({ rank: ranks[at]!, player: row.player, score: tierScore(row), quiet: !row.solved }),
  );
  return panel("Tiers", { class: "pdb-board-card" }, tabs, cappedList(drawn, `Nobody handed in the ${scope.tier}.`, TOP));
}

function rushCard(body: SiteDayBody, server: string | null): HTMLElement {
  const rows = inScope(body.rush, server);
  const ranks = displayRanks(rows, sameRush);
  const drawn = rows.map((row, at) =>
    boardRow({ rank: ranks[at]!, player: row.player, score: `${row.solved} · ${formatDuration(row.timeMs)}` }),
  );
  return panel(
    "Rush",
    { class: "pdb-board-card" },
    el("p", { class: "note", text: "Each player's first ranked rush of the day: puzzles solved, then the time to the last." }),
    cappedList(drawn, "Nobody ran the rush this day.", TOP),
  );
}

/** The day's boards, redrawn in place when the reader picks a server or a tier. */
export function renderDayBoards(body: SiteDayBody, day: SiteDay, index: SiteIndex, ctx: ViewContext): HTMLElement {
  const tiers = day.deals.map((deal) => deal.tier);
  const servers = serversAmong(index, serverKeysIn(body));
  let scope: Scope = {
    server: servers.some((server) => server.key === ctx.server) ? ctx.server : null,
    tier: tiers[0] ?? "easy",
  };
  const cards = el("div", { class: "pdb-board-grid pdb-board-grid--day" });
  const draw = () => {
    const onTier = (tier: DailyTier) => {
      scope = { ...scope, tier };
      draw();
    };
    cards.replaceChildren(
      fieldCard(body, tiers, scope.server),
      leaderboardCard(body, scope.server),
      tiersCard(body, tiers, scope, onTier),
      rushCard(body, scope.server),
    );
  };
  draw();
  const chips =
    servers.length === 0
      ? null
      : serverChips(servers, scope.server, (server) => {
          scope = { ...scope, server };
          draw();
          ctx.onServer(server);
        });
  return el(
    "section",
    { class: "pdb-stack pdb-day-boards", attrs: { "aria-label": "How the day went" } },
    el("h2", { class: "display pdb-subtitle", text: "How it went" }),
    chips,
    cards,
  );
}
