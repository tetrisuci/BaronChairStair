/**
 * What a duel looks like: the card that opens or joins one, and the panel that
 * runs alongside a match.
 *
 * The opponent appears as a bar and a score, never as a board. A board
 * part-way through a puzzle is a partial solution to it, so mirroring one would
 * show the answer to whichever player is losing.
 */

import {
  DUEL_ROUND_MS_DEFAULT,
  DUEL_ROUND_OPTIONS,
  DUEL_RUSH_MS_DEFAULT,
  type DuelMode,
  type DuelProgress,
  type DuelSettings,
  type DuelView,
} from "@shared/duel";
import { el, panel, replaceChildren } from "./dom";

const SECOND_MS = 1000;
/** Under this the clock counts in tenths, as it does in rush. */
const URGENT_S = 30;

/** Clocks a host can pick, in seconds, for each mode. */
const ROUND_SECONDS = [30, 60, 90, 120, 180];
const RUSH_SECONDS = [60, 120, 180, 300, 600];

export interface DuelIntroCallbacks {
  readonly onOpen: (settings: DuelSettings) => void;
  readonly onJoin: (duelId: string) => void;
  readonly onStart: () => void;
  readonly onLeave: () => void;
  readonly onBack: () => void;
}

export interface DuelIntro {
  readonly element: HTMLElement;
  setLobbies(open: readonly DuelView[]): void;
  /** The lobby this player is in, or null while browsing. */
  setCurrent(duel: DuelView | null, selfId: string): void;
}

function choice<T extends string | number>(
  options: readonly T[],
  label: (value: T) => string,
  onPick: (value: T) => void,
): HTMLSelectElement {
  const select = el("select", { class: "spec__select" });
  for (const value of options) {
    select.append(el("option", { text: label(value), attrs: { value: String(value) } }));
  }
  select.addEventListener("change", () => {
    const picked = options.find((value) => String(value) === select.value);
    if (picked !== undefined) onPick(picked);
  });
  return select;
}

export function createDuelIntro(callbacks: DuelIntroCallbacks): DuelIntro {
  let settings: DuelSettings = { mode: "puzzle", rounds: 3, durationMs: DUEL_ROUND_MS_DEFAULT };

  const durationSlot = el("span", { class: "explore__slot" });
  const roundsRow = el("div", { class: "explore__row" });

  const rebuildDuration = () => {
    const seconds = settings.mode === "rush" ? RUSH_SECONDS : ROUND_SECONDS;
    const select = choice(
      seconds,
      (value) => (value >= 60 ? `${value / 60} min` : `${value}s`),
      (value) => {
        settings = { ...settings, durationMs: value * SECOND_MS };
      },
    );
    select.value = String(settings.durationMs / SECOND_MS);
    replaceChildren(durationSlot, select);
  };

  const modeSelect = choice<DuelMode>(
    ["puzzle", "rush"],
    (value) => (value === "puzzle" ? "Puzzle — best of N" : "Rush — most solved"),
    (mode) => {
      settings = {
        mode,
        rounds: settings.rounds,
        durationMs: mode === "rush" ? DUEL_RUSH_MS_DEFAULT : DUEL_ROUND_MS_DEFAULT,
      };
      // Rush is one clock for the whole match, so rounds mean nothing to it.
      roundsRow.hidden = mode === "rush";
      rebuildDuration();
    },
  );

  const roundsSelect = choice(
    DUEL_ROUND_OPTIONS,
    (value) => `Best of ${value}`,
    (rounds) => {
      settings = { ...settings, rounds };
    },
  );
  replaceChildren(
    roundsRow,
    el("span", { class: "explore__label", text: "Rounds" }),
    el("div", { class: "explore__controls" }, roundsSelect),
  );

  const openButton = el("button", { class: "btn btn--primary", text: "Open a lobby" });
  openButton.addEventListener("click", () => callbacks.onOpen(settings));
  const startButton = el("button", { class: "btn btn--primary", text: "Start the match" });
  startButton.addEventListener("click", () => callbacks.onStart());
  const leaveButton = el("button", { class: "btn", text: "Leave the lobby" });
  leaveButton.addEventListener("click", () => callbacks.onLeave());
  const backButton = el("button", { class: "btn", text: "Back to the daily" });
  backButton.addEventListener("click", () => callbacks.onBack());

  const setupRows = el(
    "div",
    { class: "explore__filters" },
    el(
      "div",
      { class: "explore__row" },
      el("span", { class: "explore__label", text: "Mode" }),
      el("div", { class: "explore__controls" }, modeSelect),
    ),
    roundsRow,
    el(
      "div",
      { class: "explore__row" },
      el("span", { class: "explore__label", text: "Clock" }),
      el("div", { class: "explore__controls" }, durationSlot),
    ),
  );

  const openRow = el("div", { class: "btnrow" }, openButton, backButton);
  const lobbyState = el("div", {});
  const lobbyList = el("div", { class: "explore__list" });
  const listHeading = el("p", { class: "explore__count", text: "" });

  const element = panel(
    "1v1",
    { class: "explore" },
    setupRows,
    openRow,
    lobbyState,
    listHeading,
    lobbyList,
  );
  rebuildDuration();

  return {
    element,

    setLobbies(open) {
      listHeading.textContent = open.length
        ? `${open.length} open lobby${open.length === 1 ? "" : " lobbies"} in this server`
        : "No lobbies open here yet — open one and wait.";
      replaceChildren(
        lobbyList,
        ...open.map((duel) => {
          const host = duel.players[0]?.username ?? "someone";
          const detail =
            duel.settings.mode === "rush"
              ? `rush · ${Math.round(duel.settings.durationMs / 60000)} min`
              : `best of ${duel.settings.rounds} · ${duel.settings.durationMs / 1000}s a round`;
          const row = el(
            "button",
            { class: "explore__item" },
            el("span", { class: "explore__id", text: "join" }),
            el("span", { class: "explore__title", text: host }),
            el("span", { class: "explore__meta", text: detail }),
          );
          row.addEventListener("click", () => callbacks.onJoin(duel.id));
          return row;
        }),
      );
    },

    setCurrent(duel, selfId) {
      const browsing = duel === null;
      setupRows.hidden = !browsing;
      openRow.hidden = !browsing;
      listHeading.hidden = !browsing;
      lobbyList.hidden = !browsing;
      if (!duel) {
        replaceChildren(lobbyState);
        return;
      }
      const others = duel.players.filter((player) => player.id !== selfId);
      const waiting = others.length === 0;
      replaceChildren(
        lobbyState,
        el("p", {
          class: "rush__blurb",
          text: waiting
            ? "Lobby open. Anybody in this server can join it from here."
            : `${others[0]!.username} is in. Start when you are both ready.`,
        }),
        el(
          "div",
          { class: "btnrow" },
          duel.hostId === selfId && !waiting ? startButton : null,
          leaveButton,
        ),
      );
    },
  };
}

// ── The panel alongside a match ──────────────────────────────────────────────

export interface DuelPanel {
  readonly element: HTMLElement;
  update(duel: DuelView, selfId: string, remainingMs: number): void;
  setOpponent(progress: DuelProgress): void;
  say(message: string): void;
}

export function createDuelPanel(): DuelPanel {
  const clock = el("span", { class: "rush__clock", text: "—" });
  const you = el("span", { class: "stat__value", text: "0" });
  const them = el("span", { class: "stat__value", text: "0" });
  const roundLabel = el("span", { class: "stat__value", text: "—" });
  const opponentBar = el("div", { class: "meter__fill" });
  const note = el("p", { class: "note", text: "" });

  const row = (key: string, value: HTMLElement) =>
    el("div", { class: "stat" }, el("span", { class: "stat__key", text: key }), value);

  const element = panel(
    "Versus",
    { class: "panel--tinted" },
    el("div", { class: "rush__time" }, clock),
    row("Round", roundLabel),
    row("You", you),
    row("Them", them),
    // A bar, never a board: how far along, with no hint of how they got there.
    el("div", { class: "meter__track" }, opponentBar),
    note,
  );

  return {
    element,

    update(duel, selfId, remainingMs) {
      const mine = duel.players.find((player) => player.id === selfId);
      const other = duel.players.find((player) => player.id !== selfId);
      you.textContent = String(mine?.score ?? 0);
      them.textContent = String(other?.score ?? 0);
      roundLabel.textContent =
        duel.settings.mode === "rush" ? "rush" : `${duel.round} of ${duel.settings.rounds}`;
      const seconds = Math.max(0, remainingMs) / SECOND_MS;
      clock.textContent = seconds >= URGENT_S ? String(Math.ceil(seconds)) : seconds.toFixed(1);
      clock.classList.toggle("rush__clock--urgent", seconds < URGENT_S);
      if (other && !other.connected) note.textContent = `${other.username} dropped out.`;
    },

    setOpponent(progress) {
      const ratio =
        progress.targetAttack > 0 ? Math.min(1, progress.attack / progress.targetAttack) : 0;
      opponentBar.style.width = `${ratio * 100}%`;
    },

    say(message) {
      note.textContent = message;
    },
  };
}
