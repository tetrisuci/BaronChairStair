/**
 * "Hide me on db.tetrisatuci.org", the settings sheet's On the web section.
 *
 * Every other row on the sheet is optimistic: it repaints on the click and
 * saves behind it, because a handling flag that failed to save costs a player
 * one wrong setting on one device. This one decides whether a stranger can read
 * the player's name on a public site, and an optimistic toggle that said "on"
 * while its PUT was failing would tell them they were hidden when they were
 * not — with nothing, ever, to say otherwise. So this row shows nothing it has
 * not been told. It reads "…" until the server answers the GET; a click
 * disables it until the PUT answers; and it repaints from that answer only,
 * which is the state the server now holds, not the one the player asked for.
 * Each failure says so in words, and a failed load offers to try again rather
 * than guessing.
 *
 * It is not part of `Settings`, and that is load-bearing rather than tidy: the
 * preferences payload is rebuilt from known fields, the local copy wins on
 * load, and Reset replaces every setting with its default. Any of the three
 * would quietly un-hide a player. Living on the server, beside the player and
 * behind its own route, it is out of reach of all of them.
 *
 * A guest has no name on the site to hide, so the row is drawn disabled with
 * the reason, and the server is never asked.
 */

import type { SiteVisibility } from "../api";
import { el, replaceChildren } from "./dom";
import { type OpenLink, siteLink } from "./site-link";

export interface SiteVisibilityRowOptions {
  readonly guest: boolean;
  readonly load: () => Promise<SiteVisibility>;
  readonly save: (hidden: boolean) => Promise<SiteVisibility>;
  readonly open: OpenLink;
}

export interface SiteVisibilityRow {
  readonly element: HTMLElement;
  /** Asks the server again. The sheet calls it each time it opens. */
  refresh(): void;
}

const LABEL = "Hide me on db.tetrisatuci.org";
const NOTE =
  "db.tetrisatuci.org shows finished days' leaderboards, each puzzle's stats and a page for " +
  'each player. Hidden, your results there say "a player" and you have no page. A change ' +
  "reaches the site within a few minutes. The game's own boards still show you.";
const LOADING = "…";
const LOAD_FAILED = "Couldn't load this setting.";
const SAVE_FAILED = "Couldn't save — try again.";
const GUEST = "Sign in through Discord to choose.";

/** What the row is showing. `hidden` is null until the server has said. */
interface RowState {
  readonly hidden: boolean | null;
  readonly busy: boolean;
  readonly message: string;
  readonly retry: boolean;
}

/** An answer is only an answer if it says, as a boolean, what the server holds. */
function isVisibility(value: unknown): value is SiteVisibility {
  return typeof (value as { hidden?: unknown } | null)?.hidden === "boolean";
}

export function createSiteVisibilityRow(options: SiteVisibilityRowOptions): SiteVisibilityRow {
  const toggle = el("button", { class: "spec__toggle", attrs: { "aria-label": LABEL } });
  const status = el("p", { class: "spec__note site-visibility__status", attrs: { role: "status" } });
  const retrySlot = el("span", { class: "site-visibility__retry-slot" });
  let state: RowState = { hidden: null, busy: true, message: "", retry: false };
  /** Bumped on every load, so an answer to an older one is recognised and dropped. */
  let generation = 0;

  function paint(next: RowState): void {
    state = next;
    const known = options.guest ? false : state.hidden;
    toggle.textContent = known === null ? LOADING : known ? "on" : "off";
    toggle.classList.toggle("spec__toggle--on", known === true);
    toggle.setAttribute("aria-pressed", String(known === true));
    toggle.disabled = options.guest || state.busy || state.hidden === null;
    status.textContent = options.guest ? GUEST : state.message;
    replaceChildren(
      retrySlot,
      state.retry
        ? el("button", { class: "btn btn--small site-visibility__retry", text: "Retry", on: { click: refresh } })
        : null,
    );
  }

  function accept(answer: SiteVisibility): void {
    paint({ hidden: answer.hidden, busy: false, message: "", retry: false });
  }

  function refresh(): void {
    if (options.guest) return;
    const mine = ++generation;
    paint({ hidden: null, busy: true, message: "", retry: false });
    options
      .load()
      .then((answer) => {
        if (mine !== generation) return;
        if (!isVisibility(answer)) throw new Error("the answer carried no hidden flag");
        accept(answer);
      })
      .catch((cause: unknown) => {
        if (mine !== generation) return;
        console.error("[site-visibility] could not load the setting", cause);
        paint({ hidden: null, busy: false, message: LOAD_FAILED, retry: true });
      });
  }

  function save(): void {
    if (options.guest || state.busy || state.hidden === null) return;
    const before = state.hidden;
    const mine = ++generation;
    paint({ ...state, busy: true, message: "" });
    options
      .save(!before)
      .then((answer) => {
        if (mine !== generation) return;
        if (!isVisibility(answer)) throw new Error("the answer carried no hidden flag");
        accept(answer);
      })
      .catch((cause: unknown) => {
        if (mine !== generation) return;
        console.error("[site-visibility] could not save the setting", cause);
        paint({ hidden: before, busy: false, message: SAVE_FAILED, retry: false });
      });
  }

  toggle.addEventListener("click", save);
  paint(state);

  const element = el(
    "section",
    { class: "site-visibility" },
    el("h3", { class: "spec__title", style: { fontSize: "14px" } }, "On the web"),
    el(
      "div",
      { class: "spec__row spec__row--inline" },
      el("div", { class: "spec__rowhead" }, el("span", { class: "spec__key", text: LABEL }), toggle),
      el("p", { class: "spec__note", text: NOTE }),
      status,
      retrySlot,
      siteLink("What the site shows", "/", options.open),
    ),
  );

  return { element, refresh };
}
