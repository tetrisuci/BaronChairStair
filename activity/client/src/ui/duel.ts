/**
 * The three screens a duel passes through, and the panel beside a live match.
 *
 * They are separate screens rather than one card that hides parts of itself.
 * Setting up a match, waiting in a room, and reading a result are three
 * different moments, and a single panel toggling its own children made the
 * room look like a half-empty version of the create form.
 *
 * The opponent appears as a bar and a score, never as a board. A board
 * part-way through a puzzle is a partial solution to it, so mirroring one
 * would show the answer to whichever player is losing.
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

function labelled(text: string, control: HTMLElement): HTMLElement {
  return el(
    "div",
    { class: "explore__row" },
    el("span", { class: "explore__label", text }),
    el("div", { class: "explore__controls" }, control),
  );
}

/** How a match is described in one line, wherever it needs describing. */
function describe(settings: DuelSettings): string {
  return settings.mode === "rush"
    ? `Rush · ${Math.round(settings.durationMs / 60_000)} min · most solved wins`
    : `Best of ${settings.rounds} · ${settings.durationMs / SECOND_MS}s a round`;
}

// ── Screen one: set one up, or join one ──────────────────────────────────────

export interface DuelIntroCallbacks {
  readonly onOpen: (settings: DuelSettings) => void;
  readonly onJoin: (duelId: string) => void;
  readonly onBack: () => void;
}

export interface DuelIntro {
  readonly element: HTMLElement;
  setLobbies(open: readonly DuelView[]): void;
}

export function createDuelIntro(callbacks: DuelIntroCallbacks): DuelIntro {
  let settings: DuelSettings = { mode: "puzzle", rounds: 3, durationMs: DUEL_ROUND_MS_DEFAULT };

  const durationSlot = el("span", { class: "explore__slot" });
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

  const roundsRow = labelled(
    "Rounds",
    choice(
      DUEL_ROUND_OPTIONS,
      (value) => `Best of ${value}`,
      (rounds) => {
        settings = { ...settings, rounds };
      },
    ),
  );

  const modeRow = labelled(
    "Mode",
    choice<DuelMode>(
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
    ),
  );

  const openButton = el("button", { class: "btn btn--primary", text: "Open a room" });
  openButton.addEventListener("click", () => callbacks.onOpen(settings));
  const backButton = el("button", { class: "btn", text: "Back to the daily" });
  backButton.addEventListener("click", () => callbacks.onBack());

  const heading = el("p", { class: "explore__count", text: "" });
  const list = el("div", { class: "explore__list" });

  const element = panel(
    "1v1",
    { class: "explore" },
    el("div", { class: "explore__filters" }, modeRow, roundsRow, labelled("Clock", durationSlot)),
    el("div", { class: "btnrow" }, openButton, backButton),
    heading,
    list,
  );
  rebuildDuration();

  return {
    element,
    setLobbies(open) {
      heading.textContent = open.length
        ? `${open.length} open room${open.length === 1 ? "" : "s"} in this server`
        : "No rooms open here. Open one and wait for somebody.";
      replaceChildren(
        list,
        ...open.map((duel) => {
          const row = el(
            "button",
            { class: "explore__item" },
            el("span", { class: "explore__id", text: "join" }),
            el("span", { class: "explore__title", text: duel.players[0]?.username ?? "someone" }),
            el("span", { class: "explore__meta", text: describe(duel.settings) }),
          );
          row.addEventListener("click", () => callbacks.onJoin(duel.id));
          return row;
        }),
      );
    },
  };
}

// ── Screen two: the room ─────────────────────────────────────────────────────

export interface DuelLobbyCallbacks {
  readonly onStart: () => void;
  readonly onLeave: () => void;
}

export interface DuelLobby {
  readonly element: HTMLElement;
  update(duel: DuelView, selfId: string): void;
}

export function createDuelLobby(callbacks: DuelLobbyCallbacks): DuelLobby {
  const summary = el("p", { class: "rush__blurb", text: "" });
  const roster = el("div", {});
  const state = el("p", { class: "note", text: "" });
  const start = el("button", { class: "btn btn--primary", text: "Start the match" });
  start.addEventListener("click", () => callbacks.onStart());
  const leave = el("button", { class: "btn", text: "Leave the room" });
  leave.addEventListener("click", () => callbacks.onLeave());

  const element = panel(
    "Room",
    {},
    summary,
    roster,
    state,
    el("div", { class: "btnrow" }, start, leave),
  );

  return {
    element,
    update(duel, selfId) {
      summary.textContent = describe(duel.settings);
      const opponent = duel.players.find((player) => player.id !== selfId);
      replaceChildren(
        roster,
        ...duel.players.map((player) =>
          el(
            "div",
            { class: "stat" },
            el("span", {
              class: "stat__key",
              text: player.id === duel.hostId ? "host" : "challenger",
            }),
            el("span", {
              class: "stat__value",
              text: player.username + (player.id === selfId ? " (you)" : ""),
            }),
          ),
        ),
        opponent
          ? null
          : el(
              "div",
              { class: "stat" },
              el("span", { class: "stat__key", text: "challenger" }),
              el("span", { class: "stat__value", text: "waiting…" }),
            ),
      );

      const host = duel.hostId === selfId;
      state.textContent = !opponent
        ? "Anybody in this server can join from the 1v1 screen."
        : host
          ? "Both in. Start when you are ready."
          : "Both in. Waiting for the host to start.";
      // Shown to the host either way, so it is obvious who the match is
      // waiting on rather than the button simply not being there.
      start.hidden = !host;
      start.disabled = !opponent;
    },
  };
}

// ── Screen three: how it went ────────────────────────────────────────────────

export interface DuelResultCallbacks {
  readonly onRematch: () => void;
  readonly onNewRoom: () => void;
  readonly onBack: () => void;
}

export interface DuelResult {
  readonly element: HTMLElement;
  update(duel: DuelView, selfId: string, winnerId: string | null): void;
  /** Whether each side has asked to go again. */
  setRematch(asked: boolean, theyAsked: boolean, available: boolean): void;
}

export function createDuelResult(callbacks: DuelResultCallbacks): DuelResult {
  const headline = el("p", { class: "rush__headline", text: "" });
  const score = el("div", {});
  const summary = el("p", { class: "note", text: "" });
  const rematchNote = el("p", { class: "note", text: "" });
  const rematch = el("button", { class: "btn btn--primary", text: "Ask for a rematch" });
  rematch.addEventListener("click", () => callbacks.onRematch());
  const newRoom = el("button", { class: "btn", text: "Back to 1v1" });
  newRoom.addEventListener("click", () => callbacks.onNewRoom());
  const back = el("button", { class: "btn", text: "Back to the daily" });
  back.addEventListener("click", () => callbacks.onBack());

  const element = panel(
    "Match over",
    {},
    headline,
    score,
    summary,
    rematchNote,
    el("div", { class: "btnrow" }, rematch, newRoom, back),
  );

  return {
    element,

    update(duel, selfId, winnerId) {
      headline.textContent =
        winnerId === null ? "Draw" : winnerId === selfId ? "You win" : "You lose";
      summary.textContent = describe(duel.settings);
      // Both scores, always, and the loser's too — a result you cannot read is
      // not a result.
      replaceChildren(
        score,
        ...duel.players.map((player) =>
          el(
            "div",
            { class: `stat${player.id === winnerId ? " board-list__row--self" : ""}` },
            el("span", {
              class: "stat__key",
              text: player.username + (player.id === selfId ? " (you)" : ""),
            }),
            el("span", { class: "stat__value", text: String(player.score) }),
          ),
        ),
      );
    },

    setRematch(asked, theyAsked, available) {
      rematch.hidden = !available;
      rematch.disabled = asked;
      rematch.textContent = asked ? "Rematch asked" : "Ask for a rematch";
      rematchNote.textContent = !available
        ? "Your opponent has left, so there is nobody to play again."
        : theyAsked && !asked
          ? "They want a rematch. Accept and you go straight back in."
          : asked && !theyAsked
            ? "Waiting for them to accept…"
            : "";
    },
  };
}

// ── The panel alongside a live match ─────────────────────────────────────────

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
