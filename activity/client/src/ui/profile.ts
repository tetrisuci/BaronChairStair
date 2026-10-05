/**
 * What one player has done, all of it, on one screen.
 *
 * Every other board in this app answers "how did this club do today". This one
 * answers "what have I done", which is a different question and the only one
 * nobody could ask before: the day's tallies reset each morning, the rush board
 * keeps a best rather than a total, and until `puzzle_clears` existed nothing
 * anywhere knew which puzzles a person had ever solved.
 *
 * Nothing here knows that the player being shown is the one reading it. The
 * route only answers for the caller today, and the plan is a screen for reading
 * other people's — so the shape that makes that cheap is the one that never
 * says "you".
 *
 * Read-only and static — no polling, no timers, nothing to tear down. That is
 * deliberate: `disposeActiveMode` knows about runs, rushes, duels and the
 * builder, and a screen that quietly held a live thing would be the one it
 * forgot.
 *
 * The two counts that look like the same number and are not: `puzzlesCleared`
 * is distinct puzzles ever solved, `daysSolved` is distinct days on which
 * anything was solved. A player who solves all four tiers on ten days is 40 and
 * 10. Both labels say which, because a screen with two unexplained numbers that
 * disagree is a screen nobody trusts.
 *
 * Your own profile also links to your page on db.tetrisatuci.org, and only
 * your own: the game knows the site's name for the player reading, from
 * `/api/site-visibility`, and for nobody else. That answer and the profile
 * arrive by different requests in either order, so each is kept and the link
 * is redrawn from both whenever either lands. It is drawn only when the site
 * would actually show this player — `profilePath` decides — so a player who
 * chose to be hidden is never handed a link to the page they asked not to have.
 */

import type { PlayerProfile, SiteVisibility } from "../api";
import { playerAvatar } from "./avatar";
import { el, formatDuration, panel, replaceChildren, stat } from "./dom";
import { type OpenLink, profilePath, siteLink } from "./site-link";

/** One line this player found, as their profile lists it. */
export interface FoundLine {
  readonly puzzleId: number;
  readonly title: string;
  readonly attack: number;
  readonly clears: readonly string[];
  readonly foundAt: number;
  /** The board it was played on has since been edited away. */
  readonly voided: boolean;
  /** Whether the *reader* may step it — they must have solved that puzzle. */
  readonly openable: boolean;
}

export interface ProfileStats {
  readonly player: PlayerProfile;
  /** Whether this is the reader's own record. Absent on older payloads. */
  readonly isSelf?: boolean;
  readonly puzzlesCleared: number;
  readonly clearsTotal: number;
  readonly bestMsTotal: number;
  readonly rushSolved: number;
  readonly rushRuns: number;
  readonly bestRush: number;
  readonly discoveries: number;
  readonly archiveSize: number;
  readonly streak: number;
  readonly daysSolved: number;
  /** Newest first, capped by the server. Absent on older payloads. */
  readonly found?: readonly FoundLine[];
}

export interface Profile {
  readonly element: HTMLElement;
  /**
   * @param onBack shown as a control when this is somebody else's profile,
   *   because the reader arrived from a board and wants to go back to it.
   *   Nothing is drawn for your own.
   */
  /**
   * Blanks the screen while a profile is fetched.
   *
   * The subject of this screen changes — one row on a board leads to one
   * person — so the previous occupant's numbers must not sit under a new name
   * for the length of a round trip.
   */
  loading(): void;
  /** Says the read failed, rather than leaving "Reading…" up for ever. */
  failed(): void;
  update(
    stats: ProfileStats,
    onBack?: () => void,
    /** Opens a puzzle's solutions. Only ever called for an `openable` line. */
    onOpen?: (puzzleId: number) => void,
  ): void;
  /** Where the reader stands on db.tetrisatuci.org; null when unknown. */
  setSiteVisibility(visibility: SiteVisibility | null): void;
}

export interface ProfileOptions {
  /** Opens a db.tetrisatuci.org link. Without it the profile draws no link. */
  readonly openSite?: OpenLink;
}

/** "3 days ago", roughly. A list of finds wants an age, not a timestamp. */
function ago(at: number, now: number): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return "";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

/**
 * Hours and minutes, because a profile's total is not a stopwatch.
 *
 * `formatDuration` is `mm:ss.d` — right for one solve, unreadable at
 * "412:07.3". Zero reads as "not recorded" rather than "0:00": a player whose
 * every solve predates the timing column has no total, and printing one would
 * be inventing it.
 */
function totalTime(ms: number): string {
  if (ms <= 0) return "not recorded";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
}

export function createProfile(options: ProfileOptions = {}): Profile {
  const name = el("h2", { class: "display profile__name", text: "" });
  const site = el("span", { class: "profile__site" });
  /** Whether the profile on screen is the reader's own; false while one is fetched. */
  let showingSelf = false;
  let visibility: SiteVisibility | null = null;

  function drawSite(): void {
    const path = showingSelf ? profilePath(visibility) : null;
    const open = options.openSite;
    replaceChildren(
      site,
      path && open ? siteLink("Your page on db.tetrisatuci.org", path, open) : null,
    );
  }

  /** Replaced on every update: the picture belongs to whoever is being shown. */
  const portrait = el("div", { class: "profile__portrait" });
  /** First and leftmost when it is shown, as every way out on this app is. */
  const back = el("div", { class: "profile__back" });
  const archive = el("div", { class: "profile__stats" });
  const rush = el("div", { class: "profile__stats" });
  const daily = el("div", { class: "profile__stats" });
  const note = el("p", { class: "note profile__note", text: "" });
  /**
   * The lines this player found, under the number that counts them.
   *
   * A count on its own is a claim; this is the evidence for it. It also turns
   * the discovery board from a ranking into something you can follow: a name at
   * the top of it now leads somewhere, and what it leads to is a list of
   * boards you can go and read.
   */
  const found = el("div", { class: "board-list profile__found" });
  const foundCard = panel("Lines found", { class: "profile__found-card" }, found);

  const element = el(
    "div",
    { class: "profile" },
    el("div", { class: "profile__head" }, back, portrait, name, site),
    el(
      "div",
      { class: "profile__cards" },
      panel("The archive", { class: "profile__card" }, archive),
      panel("Rush", { class: "profile__card" }, rush),
      panel("The daily", { class: "profile__card" }, daily),
    ),
    note,
    foundCard,
  );

  return {
    element,
    failed() {
      note.textContent = "Could not read that profile.";
    },
    loading() {
      name.textContent = "";
      replaceChildren(portrait);
      replaceChildren(back);
      replaceChildren(archive);
      replaceChildren(rush);
      replaceChildren(daily);
      replaceChildren(found);
      foundCard.hidden = true;
      note.textContent = "Reading…";
      showingSelf = false;
      drawSite();
    },
    setSiteVisibility(next) {
      visibility = next;
      drawSite();
    },
    update(stats, onBack, onOpen) {
      showingSelf = stats.isSelf === true;
      drawSite();
      replaceChildren(
        back,
        onBack && stats.isSelf === false
          ? el("button", { class: "btn", text: "← Back", on: { click: () => onBack() } })
          : null,
      );
      name.textContent = stats.player.username;
      replaceChildren(portrait, playerAvatar(stats.player, { size: 56 }));
      replaceChildren(
        archive,
        stat("Puzzles solved", `${stats.puzzlesCleared} of ${stats.archiveSize}`),
        // Times solved, not puzzles: a player who replays a favourite twenty
        // times has solved one puzzle and made twenty solves, and the gap
        // between the two numbers is the interesting part.
        stat("Solves in total", stats.clearsTotal),
        stat("Time on solved puzzles", totalTime(stats.bestMsTotal)),
        stat("Lines nobody had found", stats.discoveries),
      );
      replaceChildren(
        rush,
        stat("Rush puzzles solved", stats.rushSolved),
        stat("Rushes filed", stats.rushRuns),
        stat("Best rush", stats.bestRush === 0 ? "—" : `${stats.bestRush} solved`),
      );
      replaceChildren(
        daily,
        stat("Days solved", stats.daysSolved),
        stat("Current streak", stats.streak === 0 ? "—" : `${stats.streak} days`),
      );
      // Only the empty state says anything. A profile with numbers on it does
      // not need a sentence underneath explaining what numbers are.
      // The empty state reads differently for somebody else: telling a stranger
      // to go and solve something is advice they cannot act on.
      note.textContent =
        stats.puzzlesCleared > 0
          ? ""
          : stats.isSelf === false
            ? "No record yet."
            : "Nothing here yet. Solve anything — a daily, a rush puzzle, or one from Explore — and it lands here.";

      const lines = stats.found ?? [];
      // Hidden rather than shown empty: on most profiles this card would be an
      // empty box under a zero, saying the same nothing twice.
      foundCard.hidden = lines.length === 0;
      const now = Date.now();
      replaceChildren(
        found,
        ...lines.map((line) => {
          const label = line.title ? `#${line.puzzleId} ${line.title}` : `#${line.puzzleId}`;
          const why = line.voided
            ? "that board has been edited since"
            : line.openable
              ? "read it"
              : "solve it yourself to read it";
          const row = el(
            line.openable ? "button" : "div",
            {
              class: "board-list__row profile__found-row" + (line.openable ? " profile__found-row--open" : ""),
              title: line.openable ? `Open the solutions to ${label}` : why,
              ...(line.openable ? { on: { click: () => onOpen?.(line.puzzleId) } } : {}),
            },
            el("span", { class: "board-list__name", text: label }),
            el("span", {
              class: "profile__found-when",
              text: ago(line.foundAt, now),
            }),
            el("span", {
              class: "board-list__score",
              text: `${line.attack} atk`,
            }),
          );
          return row;
        }),
      );
    },
  };
}
