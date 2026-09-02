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
  DEFAULT_DUEL_SETTINGS,
  DUEL_ROUND_MS_DEFAULT,
  DUEL_ROUND_OPTIONS,
  DUEL_RUSH_MS_DEFAULT,
  type DuelMode,
  type DuelProgress,
  type DuelSettings,
  type DuelView,
} from "@shared/duel";
import { MAX_DIFFICULTY, MIN_DIFFICULTY } from "@shared/archive-filter";
import { el, panel, replaceChildren, setToggleLabel } from "./dom";

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

/** A bounded whole number. Commits on change, not on every keystroke. */
function numberBox(low: number, high: number, onPick: (value: number) => void): HTMLInputElement {
  const input = el("input", {
    class: "explore__number",
    attrs: { type: "number", min: String(low), max: String(high), inputmode: "numeric" },
  });
  input.addEventListener("change", () => {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) return;
    onPick(Math.min(high, Math.max(low, Math.round(parsed))));
  });
  return input;
}

/** The same on/off button the explorer uses, so one control means one thing. */
function toggle(label: string, onPick: () => void): HTMLButtonElement {
  const button = el("button", { class: "btn btn--small explore__toggle" });
  setToggleLabel(button, label, true);
  button.addEventListener("click", () => onPick());
  return button;
}

interface RulesForm {
  readonly element: HTMLElement;
  /** Show rules that came from the referee, which is always the authority. */
  set(settings: DuelSettings): void;
  /** The guest sees the same rows, inert. Rules are the host's to set. */
  setEditable(editable: boolean): void;
}

/**
 * The lobby's rule controls, which only its host ever sees.
 *
 * `onChange` fires per edit and is what the lobby sends upstream. It is not
 * called from {@link RulesForm.set}, so echoing the referee's answer back into
 * the form cannot start a loop.
 */
/**
 * The rules a mode switch should ask for.
 *
 * Pulled out of the form because it is the one part of it with a wrong answer
 * that no document is needed to see: rush has no rounds and the referee pins
 * the field to 1 for it, so carrying the referee's 1 back out of rush turns a
 * best-of-5 into a best-of-1 that the control still reads as 5.
 */
export function rulesForMode(
  settings: DuelSettings,
  mode: DuelMode,
  puzzleRounds: number,
): DuelSettings {
  return {
    ...settings,
    mode,
    // Each mode has its own clock range, so the old value is not carried
    // across — 30s is a round, and a rush of it is nothing.
    durationMs: mode === "rush" ? DUEL_RUSH_MS_DEFAULT : DUEL_ROUND_MS_DEFAULT,
    rounds: mode === "rush" ? settings.rounds : puzzleRounds,
  };
}

function createRulesForm(onChange: (settings: DuelSettings) => void): RulesForm {
  let settings: DuelSettings = DEFAULT_DUEL_SETTINGS;
  /**
   * The best-of the host last chose for a puzzle match.
   *
   * Rush has no rounds and the referee pins the field to 1 for it, so without
   * this a trip through rush and back would quietly turn a best-of-5 into a
   * best-of-1 — the referee's 1 is the honest answer for a rush and the wrong
   * one to carry back out of it.
   */
  let puzzleRounds = settings.rounds;
  /** Which mode the clock control was built for; see {@link paintDuration}. */
  let builtFor: DuelMode | null = null;
  let editable = true;

  const edit = (patch: Partial<DuelSettings>) => {
    settings = { ...settings, ...patch };
    if (settings.mode === "puzzle") puzzleRounds = settings.rounds;
    paint();
    onChange(settings);
  };

  const durationSlot = el("span", { class: "explore__slot" });

  const modeSelect = choice<DuelMode>(
    ["puzzle", "rush"],
    (value) => (value === "puzzle" ? "Puzzle — best of N" : "Rush — most solved"),
    (mode) => edit(rulesForMode(settings, mode, puzzleRounds)),
  );
  const roundsSelect = choice(
    DUEL_ROUND_OPTIONS,
    (value) => `Best of ${value}`,
    (rounds) => edit({ rounds }),
  );
  const minBox = numberBox(MIN_DIFFICULTY, MAX_DIFFICULTY, (v) => edit({ minDifficulty: v }));
  const maxBox = numberBox(MIN_DIFFICULTY, MAX_DIFFICULTY, (v) => edit({ maxDifficulty: v }));
  const unratedBox = toggle("Unrated", () => edit({ includeUnrated: !settings.includeUnrated }));

  const roundsRow = labelled("Rounds", roundsSelect);
  const difficultyRow = el(
    "div",
    { class: "explore__row" },
    el("span", { class: "explore__label", text: "Difficulty" }),
    el(
      "div",
      { class: "explore__controls" },
      minBox,
      el("span", { class: "explore__to", text: "to" }),
      maxBox,
      unratedBox,
    ),
  );

  const element = el(
    "div",
    { class: "explore__filters" },
    labelled("Mode", modeSelect),
    roundsRow,
    labelled("Clock", durationSlot),
    difficultyRow,
  );

  /**
   * Rebuilt only when the mode changes, because each mode offers its own
   * clocks. Replacing the control on every repaint would take the focus of the
   * host who is using it, and a repaint follows every edit.
   */
  const paintDuration = () => {
    if (builtFor !== settings.mode) {
      builtFor = settings.mode;
      const seconds = settings.mode === "rush" ? RUSH_SECONDS : ROUND_SECONDS;
      const select = choice(
        seconds,
        (value) => (value >= 60 ? `${value / 60} min` : `${value}s`),
        (value) => edit({ durationMs: value * SECOND_MS }),
      );
      select.disabled = !editable;
      replaceChildren(durationSlot, select);
    }
    const select = durationSlot.querySelector("select");
    if (!select || select === document.activeElement) return;
    // Left alone rather than blanked if the value is not one of the offered
    // clocks: an empty select says less than a stale one.
    const wanted = String(settings.durationMs / SECOND_MS);
    if ([...select.options].some((option) => option.value === wanted)) select.value = wanted;
  };

  /**
   * Writes the current rules onto the controls.
   *
   * Every control except the one being used. The referee is the authority and
   * a value it clamped, swapped or pinned has to reach the screen — but a host
   * mid-edit should not have the box they are typing in rewritten under them,
   * and that is one control, not the whole form.
   */
  const paint = () => {
    const focused = document.activeElement;
    if (modeSelect !== focused) modeSelect.value = settings.mode;
    if (roundsSelect !== focused) roundsSelect.value = String(settings.rounds);
    if (minBox !== focused) minBox.value = String(settings.minDifficulty);
    if (maxBox !== focused) maxBox.value = String(settings.maxDifficulty);
    setToggleLabel(unratedBox, "Unrated", settings.includeUnrated);
    // Rush is one clock for the whole match, so rounds mean nothing to it.
    roundsRow.hidden = settings.mode === "rush";
    paintDuration();
  };
  paint();

  return {
    element,
    set(next) {
      settings = next;
      if (next.mode === "puzzle") puzzleRounds = next.rounds;
      paint();
    },
    setEditable(next) {
      editable = next;
      for (const control of [modeSelect, roundsSelect, minBox, maxBox, unratedBox]) {
        control.disabled = !editable;
      }
      const select = durationSlot.querySelector("select");
      if (select) select.disabled = !editable;
      element.classList.toggle("explore__filters--locked", !editable);
    },
  };
}

/**
 * How a match is described in one line, wherever it needs describing.
 *
 * This line is the whole of what a guest is told, now that the controls belong
 * to the host — and it is what a room advertises in the browse list — so the
 * band goes in it whenever the band is not simply "everything". A room that
 * draws from the whole archive says nothing about difficulty, because there is
 * nothing there to warn anybody about.
 */
function describe(settings: DuelSettings): string {
  const shape =
    settings.mode === "rush"
      ? `Rush · ${Math.round(settings.durationMs / 60_000)} min · most solved wins`
      : `Best of ${settings.rounds} · ${settings.durationMs / SECOND_MS}s a round`;
  const whole =
    settings.minDifficulty === MIN_DIFFICULTY &&
    settings.maxDifficulty === MAX_DIFFICULTY &&
    settings.includeUnrated;
  if (whole) return shape;
  const rated = settings.includeUnrated ? "" : ", rated only";
  return `${shape} · difficulty ${settings.minDifficulty}–${settings.maxDifficulty}${rated}`;
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
  // No rule controls here. This screen is for finding a room, and the rules of
  // a room belong to whoever is hosting it — a form on the way in offers them
  // to everybody, including the people about to join somebody else's game. A
  // room opens on the defaults and is set up in its own lobby.
  const openButton = el("button", { class: "btn btn--primary", text: "Open a room" });
  openButton.addEventListener("click", () => callbacks.onOpen(DEFAULT_DUEL_SETTINGS));
  const backButton = el("button", { class: "btn", text: "Back to the daily" });
  backButton.addEventListener("click", () => callbacks.onBack());

  const heading = el("p", { class: "explore__count", text: "" });
  const list = el("div", { class: "explore__list" });

  const element = panel(
    "1v1",
    { class: "explore" },
    el("div", { class: "btnrow" }, openButton, backButton),
    heading,
    list,
  );

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
  /** The host changed a rule. The referee decides whether it stands. */
  readonly onConfigure: (settings: DuelSettings) => void;
}

export interface DuelLobby {
  readonly element: HTMLElement;
  update(duel: DuelView, selfId: string): void;
}

export function createDuelLobby(callbacks: DuelLobbyCallbacks): DuelLobby {
  const rules = createRulesForm((settings) => callbacks.onConfigure(settings));
  const summary = el("p", { class: "rush__blurb", text: "" });
  const pool = el("p", { class: "note", text: "" });
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
    rules.element,
    pool,
    roster,
    state,
    el("div", { class: "btnrow" }, start, leave),
  );

  return {
    element,
    update(duel, selfId) {
      const host = duel.hostId === selfId;
      summary.textContent = describe(duel.settings);
      rules.set(duel.settings);
      // The guest gets the one-line summary above and nothing to touch. They
      // still need to know what they are about to play; they do not need the
      // controls for a decision that is not theirs. Disabled as well as hidden,
      // so revealing the element could never be the whole of an exploit.
      rules.setEditable(host);
      rules.element.hidden = !host;
      pool.textContent = host
        ? `${duel.poolSize} puzzle${duel.poolSize === 1 ? "" : "s"} match these rules, ` +
          `and this match needs ${duel.poolNeeded}`
        : "The host sets the rules.";

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

      state.textContent = !opponent
        ? "Waiting for somebody to join."
        : host
          ? "Set the rules, then start when you are ready."
          : "Waiting for the host to start.";
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

/**
 * How full to draw the opponent's bar, for a peer who may have sent anything.
 *
 * A socket frame meets no HTTP middleware on its way here, so the five numbers
 * the type promises can arrive missing, null, negative or not numbers at all.
 * Every one of those has to land somewhere between empty and full: a NaN width
 * is a string the browser drops, freezing the bar on the last honest reading.
 */
export function opponentRatio(progress: DuelProgress | null | undefined): number {
  const attack = Number(progress?.attack);
  const target = Number(progress?.targetAttack);
  if (!Number.isFinite(attack) || !Number.isFinite(target) || target <= 0) return 0;
  return Math.max(0, Math.min(1, attack / target));
}

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
      opponentBar.style.width = `${opponentRatio(progress) * 100}%`;
    },

    say(message) {
      note.textContent = message;
    },
  };
}
