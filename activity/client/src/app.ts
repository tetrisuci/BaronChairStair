/**
 * Application wiring.
 *
 * Builds the sheet, runs one attempt at a time, and swaps the rails over to the
 * sign-off when the attempt ends. Everything it knows about the outside world
 * arrives through `Connection`; everything the player changes goes back through
 * `SettingsStore`.
 */

import { BOARD_HEIGHT, type PuzzlePrompt, type SolutionStep } from "@shared/puzzle";
import type { InputEvent } from "@shared/tetris/verify";
import type { Connection } from "./discord";
import type { DailyResponse, RushState, StoredRun } from "./api";
import type { ArchiveListing } from "@shared/puzzle";
import { filterArchive } from "@shared/archive-filter";
import { ApiError } from "./api";
import { InputRouter } from "./game/input";
import { type LocalAction, keyName } from "@shared/keybinds";
import { RushSession, type RushSummary } from "./game/rush";
import { PuzzleRun, type RunSnapshot } from "./game/runner";
import { SolutionPlayer } from "./game/solution-player";
import { BoardRenderer } from "./render/board";
import type { SettingsStore } from "./settings";
import { createCredits, createMasthead } from "./ui/chrome";
import { el, formatCountdown, replaceChildren } from "./ui/dom";
import { createHud } from "./ui/hud";
import {
  createLeaderboardPanel,
  createVerdictBadge,
  createVerdictPanel,
  createWalkthroughPanel,
} from "./ui/results";
import { createExplorer } from "./ui/explorer";
import { DuelClient } from "./game/duel";
import {
  createDuelIntro,
  createDuelLobby,
  createDuelPanel,
  createDuelResult,
} from "./ui/duel";
import {
  createRushBoard,
  createRushIntro,
  createRushPanel,
  createRushResultCard,
} from "./ui/rush";
import { createSettingsDialog } from "./ui/settings-dialog";
import type { ShareFields } from "./ui/share";

const COUNTDOWN_TICK_MS = 1000;
/** Fast enough for a tenth-of-a-second stopwatch to look like one. */
const CLOCK_TICK_MS = 100;
const TOAST_MS = 2200;

export class App {
  private readonly masthead = createMasthead();
  private readonly credits = createCredits();
  private readonly hud = createHud({
    onUndo: () => this.stepHistory("undo"),
    onRedo: () => this.stepHistory("redo"),
  });
  private readonly badge = createVerdictBadge();
  private readonly leaderboard = createLeaderboardPanel();
  private readonly canvas = el("canvas", {
    class: "field",
    attrs: { role: "img", "aria-label": "Puzzle playfield" },
  });
  private readonly renderer = new BoardRenderer(this.canvas);
  private readonly stage = el("div", { class: "stage" }, this.canvas, this.badge.element);
  /**
   * The play area. Rush borrows it whole for its intro and its sign-off, where
   * there is no board to look at and a card marooned in one rail beside an
   * empty stage reads as something having gone wrong.
   */
  private readonly deck = el("div", { class: "deck" });
  private readonly toastNode = el("div", { class: "toast", attrs: { hidden: true } });

  private readonly input: InputRouter;
  private readonly settingsDialog;
  private readonly verdict;
  private readonly walkthrough = createWalkthroughPanel();

  private readonly rushPanel = createRushPanel(() => this.rush?.giveUp());
  private readonly rushBoard = createRushBoard();
  private readonly rushIntro;
  private readonly rushResult;
  private readonly explorer;
  private readonly duelIntro;
  private readonly duelLobby;
  private readonly duelResult;
  private readonly duelPanel = createDuelPanel();
  private duel: DuelClient | null = null;
  private duelState: import("@shared/duel").DuelView | null = null;
  /** The puzzle of the round being played, kept so its reveal can be mounted. */
  private duelPuzzle: PuzzlePrompt | null = null;
  /** When the next round is dealt, while a duel is between rounds. */
  private duelIntermissionAt: number | null = null;
  private duelEndsAt = 0;
  private duelTick: ReturnType<typeof setInterval> | null = null;

  private run: PuzzleRun | null = null;
  /**
   * The rush in progress, if any. While it exists it owns the board, the input,
   * and the clock, and the daily's own run is put away — the two modes share one
   * stage and must never both be driving it.
   */
  private rush: RushSession | null = null;
  private rushTicket: string | null = null;
  private rushSkips = 0;
  private rushRanked = true;
  private rushState: RushState | null = null;
  private mode: "daily" | "rush" | "explore" | "duel" = "daily";
  private solutionPlayer: SolutionPlayer | null = null;
  private daily: DailyResponse | null = null;
  private submitting = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The sheet on the table. Today's puzzle is scored; an archive sheet picked
   * up afterwards is not, so nothing a player does for fun touches the record.
   */
  private sheet: { puzzle: PuzzlePrompt; solution: readonly SolutionStep[] | null; scored: boolean } | null =
    null;
  private runningPuzzleId: number | null = null;
  /**
   * How long each puzzle has been open and how many restarts it has taken, kept
   * per puzzle so a detour into practice cannot reset the daily's numbers.
   */
  private readonly sittings = new Map<number, { openedAt: number; resets: number }>();
  /** When the current puzzle was put in front of the player. */
  private sheetOpenedAt = Date.now();
  /** Keeps the clock moving before the first input and between attempts. */
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private archive: readonly ArchiveListing[] | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly connection: Connection,
    private readonly settings: SettingsStore,
  ) {
    this.input = new InputRouter(settings.value.keybinds, {
      onGameKey: (key, down) => {
        if (this.mode === "duel") this.duel?.input(key, down);
        else if (this.mode === "rush") this.rush?.input(key, down);
        else this.run?.input(key, down);
      },
      onLocalAction: (action) => this.handleLocalAction(action),
    });

    this.settingsDialog = createSettingsDialog({
      input: this.input,
      onChange: (patch) => {
        this.settings.update(patch);
        if (patch.keybinds) this.input.setKeybinds(patch.keybinds);
      },
      onClose: ({ handling }) => {
        if (handling) this.restartForNewHandling();
      },
      onReset: () => {
        this.settings.resetToDefaults();
        this.settingsDialog.open(this.settings.value.handling, this.settings.value.keybinds);
      },
    });

    this.verdict = createVerdictPanel({
      onRetry: () => this.startRun(),
      onToggleLeaderboard: () => this.toggleLeaderboard(),
      onPractice: () => void this.startPractice(),
      onBackToDaily: () => this.returnToDaily(),
    });

    this.rushIntro = createRushIntro(
      {
        onStart: (practice) => void this.beginRush(practice),
        onBack: () => this.leaveRush(),
      },
      this.skipKeyName(),
    );
    this.rushResult = createRushResultCard(
      () => void this.beginRush(true),
      () => this.leaveRush(),
    );

    this.explorer = createExplorer({
      onChange: (filter) => {
        this.settings.update({ filter });
        this.paintExplorer();
      },
      onPlay: (id) => void this.openArchivePuzzle(id),
      onRandom: () => void this.startPractice(),
      onClose: () => this.leaveExplorer(),
    });

    this.duelIntro = createDuelIntro({
      onOpen: (settings) => this.duel?.open(settings),
      onJoin: (id) => this.duel?.join(id),
      onBack: () => this.leaveDuel(),
    });
    this.duelLobby = createDuelLobby({
      onStart: () => this.duel?.ready(),
      onConfigure: (settings) => this.duel?.configure(settings),
      onLeave: () => {
        this.duel?.leave();
        this.duelState = null;
        this.showDuelIntro();
      },
    });
    this.duelResult = createDuelResult({
      onRematch: () => this.duel?.rematch(),
      onNewRoom: () => {
        this.duel?.leave();
        this.duelState = null;
        this.showDuelIntro();
      },
      onBack: () => this.leaveDuel(),
    });

    this.settings.subscribe((next) => this.input.setKeybinds(next.keybinds));
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.mount();
    this.input.attach();
    window.addEventListener("resize", this.relayout);
    new ResizeObserver(this.relayout).observe(this.stage);
    this.startCountdown();

    try {
      this.daily = await this.connection.api.daily();
    } catch (error) {
      this.showFatal(error);
      return;
    }

    this.masthead.setDay(this.daily.day);
    this.masthead.setStreak(this.daily.streak, this.daily.totalSolved);
    this.credits.update({ day: this.daily.day, puzzle: this.daily.puzzle });
    this.sheet = { puzzle: this.daily.puzzle, solution: this.daily.solution, scored: true };
    this.hud.setPuzzle(this.daily.puzzle);

    if (this.daily.run) {
      this.showFiledRun(this.daily.puzzle, this.daily.run, this.daily.solution);
    } else {
      this.startRun();
    }
  }

  // ── Practice ───────────────────────────────────────────────────────────────

  /** Picks a sheet from the archive at random and plays it unscored. */
  /**
   * Today's puzzle, while it is still the player's to file.
   *
   * Practising it before filing would be a free rehearsal for the one run that
   * counts, so it is kept out of the shuffle and shown greyed in the explorer
   * until the daily is on the board. Afterwards it is just another puzzle.
   */
  private lockedPuzzleId(): number | null {
    if (!this.daily || this.daily.run) return null;
    return this.daily.puzzle.id;
  }

  private async loadArchive(): Promise<readonly ArchiveListing[]> {
    this.archive ??= (await this.connection.api.archive()).puzzles;
    return this.archive;
  }

  private async startPractice(): Promise<void> {
    try {
      const archive = await this.loadArchive();
      const locked = this.lockedPuzzleId();
      const choices = filterArchive(archive, this.settings.value.filter).filter(
        // Never the puzzle already on the table, so "random" always changes it.
        (entry) => entry.id !== locked && entry.id !== this.sheet?.puzzle.id,
      );
      const pick = choices[Math.floor(Math.random() * choices.length)];
      if (!pick) {
        this.toast("Nothing matches your filters");
        return;
      }
      await this.openArchivePuzzle(pick.id);
    } catch (error) {
      this.toast(error instanceof ApiError ? error.message : "Could not open the archive");
    }
  }

  private async openArchivePuzzle(id: number): Promise<void> {
    if (id === this.lockedPuzzleId()) {
      this.toast("That is today's puzzle — play it on the daily first");
      return;
    }
    try {
      const { puzzle, solution } = await this.connection.api.archivePuzzle(id);
      this.sheet = { puzzle, solution, scored: false };
      this.credits.update({ day: this.daily?.day ?? 0, puzzle });
      if (this.mode === "explore") this.mode = "daily";
      replaceChildren(this.hud.left, this.hud.panels.hold, this.hud.panels.progress);
      this.showPlayfield();
      this.startRun();
      this.toast(`Practice · ${puzzle.title || `sheet ${puzzle.id}`}`);
    } catch (error) {
      this.toast(error instanceof ApiError ? error.message : "Could not open that puzzle");
    }
  }

  // ── Modes ──────────────────────────────────────────────────────────────────

  /**
   * Puts away whatever was running, whichever mode it belonged to.
   *
   * The masthead buttons stay live on every screen, so any mode can be started
   * from inside any other — and nothing left behind is idle. An abandoned rush
   * keeps its own frame loop drawing to the shared canvas, disables the
   * keyboard at its buzzer and files the truncated run, which for a ranked
   * rush is the day's only one. An abandoned duel keeps the socket, the clock
   * and first claim on every keystroke. Doing it in one place is what stops
   * the next mode added from being the one that gets forgotten.
   */
  private disposeActiveMode(): void {
    this.run?.dispose();
    this.run = null;
    this.runningPuzzleId = null;

    this.rush?.dispose();
    this.rush = null;
    this.rushTicket = null;

    if (this.duelTick !== null) clearInterval(this.duelTick);
    this.duelTick = null;
    this.duel?.close();
    this.duel = null;
    this.duelState = null;
  }

  // ── Explorer ───────────────────────────────────────────────────────────────

  private enterExplorer(): void {
    if (this.mode === "explore") return;
    this.disposeActiveMode();
    this.mode = "explore";
    this.badge.hide();
    this.input.setGameInputEnabled(false);
    this.paintExplorer();
    this.showScreen({ wide: true, fill: true }, this.explorer.element);
    void this.loadArchive().then(() => this.paintExplorer()).catch((error) => {
      this.toast(error instanceof ApiError ? error.message : "Could not load the archive");
    });
  }

  private paintExplorer(): void {
    this.explorer.update(this.archive ?? [], this.settings.value.filter, this.lockedPuzzleId());
  }

  private leaveExplorer(): void {
    this.disposeActiveMode();
    this.mode = "daily";
    replaceChildren(this.hud.left, this.hud.panels.hold, this.hud.panels.progress);
    this.showPlayfield();
    this.input.setGameInputEnabled(true);
    this.returnToDaily();
  }

  private returnToDaily(): void {
    if (!this.daily) return;
    this.sheet = { puzzle: this.daily.puzzle, solution: this.daily.solution, scored: true };
    this.credits.update({ day: this.daily.day, puzzle: this.daily.puzzle });
    this.hud.setPuzzle(this.daily.puzzle);
    if (this.daily.run) {
      this.showFiledRun(this.daily.puzzle, this.daily.run, this.daily.solution);
    } else {
      this.startRun();
    }
  }

  /** The three-column play layout: rails either side of the board. */
  private showPlayfield(): void {
    this.deck.classList.remove("deck--screen");
    replaceChildren(this.deck, this.hud.left, this.stage, this.hud.right);
    this.relayout();
  }

  /** One centred column, for a moment when there is nothing to play. */
  private showScreen(
    options: { wide?: boolean; fill?: boolean },
    ...cards: HTMLElement[]
  ): void {
    this.deck.classList.add("deck--screen");
    const modifiers = [options.wide && "screen--wide", options.fill && "screen--fill"]
      .filter(Boolean)
      .join(" ");
    replaceChildren(this.deck, el("div", { class: `screen ${modifiers}`.trim() }, ...cards));
  }

  // ── 1v1 ────────────────────────────────────────────────────────────────────

  private enterDuel(): void {
    if (this.mode === "duel") return;
    this.disposeActiveMode();
    this.mode = "duel";
    this.badge.hide();
    this.input.setGameInputEnabled(false);

    const self = () => this.duel?.playerId ?? "";
    this.duel = new DuelClient(
      this.connection.api.socketUrl("/api/duel"),
      // Frozen for the match, like every other run: the server replays every
      // claim under one handling and a change mid-match would rescore rounds
      // already played.
      this.settings.value.handling,
      {
        onFrame: (view, run) => {
          this.renderer.draw(view);
          this.hud.update(run);
        },
        onLobbies: (open) => this.duelIntro.setLobbies(open),
        onState: (duel) => {
          this.duelState = duel;
          // A room of its own, rather than the create form with its middle
          // hidden: setting a match up and waiting in one are different moments.
          if (duel.phase === "lobby") this.showDuelLobby(duel);
          // A finished duel keeps sending these while a rematch is on the
          // table, which is how each side learns the other has asked.
          else if (duel.phase === "over") this.showRematchState(duel);
        },
        onRound: (_round, puzzle, endsAt, duel) => this.beginDuelRound(puzzle, endsAt, duel),
        onRushPuzzle: (puzzle, endsAt, _solved, _skips, duel) => {
          if (puzzle) this.beginDuelRound(puzzle, endsAt, duel);
          else this.duelPanel.say("Stack cleared — wait for the clock.");
        },
        onOpponent: (progress) => this.duelPanel.setOpponent(progress),
        onRoundOver: (winnerId, duel, solution, nextRoundAt) => {
          this.duelState = duel;
          this.input.setGameInputEnabled(false);
          this.badge.show(winnerId === self(), winnerId === self() ? "Round won" : "Round lost");
          window.setTimeout(() => this.badge.hide(), 900);
          this.duelIntermissionAt = nextRoundAt;
          // Both players watch it, the loser most of all: it is the only look
          // they get at the puzzle that just beat them, on the board they were
          // playing it on a second ago.
          //
          // Only when there is a pause to watch it in. The round that decides a
          // match is followed by the result screen, which arrives in the same
          // breath, so a reveal there would be mounted and torn down without
          // ever being seen.
          if (solution && nextRoundAt !== null && this.duelPuzzle) {
            this.attachWalkthrough(this.duelPuzzle, solution);
          }
        },
        onMatchOver: (winnerId, duel) => this.endDuel(winnerId, duel),
        onError: (message) => {
          this.toast(message);
          // A refused rule change gets an error and no duel frame, so the form
          // is left showing rules the referee never accepted — and would keep
          // sending them. Put the last agreed rules back on screen.
          if (this.duelState?.phase === "lobby") this.showDuelLobby(this.duelState);
        },
        onClosed: () => {
          if (this.mode === "duel") this.toast("The duel connection closed");
        },
      },
    );
    this.duel.connect();
    this.showDuelIntro();
  }

  /** A round started: put the board back and hand the keyboard over. */
  private beginDuelRound(
    puzzle: PuzzlePrompt,
    endsAt: number,
    duel: import("@shared/duel").DuelView,
  ): void {
    this.duelState = duel;
    this.duelEndsAt = endsAt;
    this.duelPuzzle = puzzle;
    // The pause is over, and with it the reveal. Dropped before the board is
    // mounted, because relayout draws the solution player whenever there is
    // one and would otherwise paint the last round's answer over this round.
    this.duelIntermissionAt = null;
    this.solutionPlayer = null;
    this.badge.hide();
    this.hud.setPuzzle(puzzle);
    this.credits.update({ day: this.daily?.day ?? 0, puzzle });
    replaceChildren(this.hud.left, this.duelPanel.element, this.hud.panels.hold);
    replaceChildren(this.hud.right, this.hud.panels.goal, this.hud.panels.meter, this.hud.panels.queue);
    this.showPlayfield();
    this.input.setGameInputEnabled(true);
    this.startDuelClock();
  }

  /** The countdown is drawn here; the server is the one enforcing it. */
  private startDuelClock(): void {
    if (this.duelTick !== null) return;
    this.duelTick = setInterval(() => {
      if (!this.duelState) return;
      this.duelPanel.update(
        this.duelState,
        this.duel?.playerId ?? "",
        this.duelEndsAt - Date.now(),
      );
      if (this.duelIntermissionAt === null) return;
      const left = Math.max(0, this.duelIntermissionAt - Date.now());
      this.duelPanel.say(`Next round in ${Math.ceil(left / 1000)}s`);
    }, CLOCK_TICK_MS);
  }

  private showDuelIntro(): void {
    this.duelState = null;
    this.input.setGameInputEnabled(false);
    this.showScreen({ wide: true, fill: true }, this.duelIntro.element);
  }

  private showDuelLobby(duel: import("@shared/duel").DuelView): void {
    this.input.setGameInputEnabled(false);
    this.duelLobby.update(duel, this.duel?.playerId ?? "");
    // Mounted once. Every accepted rule change broadcasts a duel frame, and
    // re-running showScreen would move the lobby into a fresh container each
    // time — which takes the focused control out of the document and hands
    // focus back to the body, mid-edit, on every keystroke that lands.
    if (!this.duelLobby.element.isConnected) {
      this.showScreen({ wide: true, fill: true }, this.duelLobby.element);
    }
  }

  /**
   * Who has asked to go again.
   *
   * `rematchEndsAt` is the only thing that retires the button on time: the
   * sweep that drops a finished duel runs on its own interval and reports
   * later than the offer actually lapses.
   */
  private showRematchState(duel: import("@shared/duel").DuelView): void {
    const self = this.duel?.playerId ?? "";
    const mine = duel.players.find((player) => player.id === self);
    const other = duel.players.find((player) => player.id !== self);
    const open =
      duel.rematchEndsAt !== null &&
      Date.now() < duel.rematchEndsAt &&
      other?.connected === true;
    this.duelResult.setRematch(
      mine?.wantsRematch === true,
      other?.wantsRematch === true,
      open,
    );
  }

  /** The result, with the score both players can read and a way to go again. */
  private endDuel(winnerId: string | null, duel: import("@shared/duel").DuelView): void {
    this.duelState = duel;
    this.input.setGameInputEnabled(false);
    if (this.duelTick !== null) clearInterval(this.duelTick);
    this.duelTick = null;
    // No round is coming, and nothing should still be holding the last one's
    // answer: relayout draws the solution player whenever there is one.
    this.duelIntermissionAt = null;
    this.duelPuzzle = null;
    this.solutionPlayer = null;
    const self = this.duel?.playerId ?? "";
    this.badge.hide();
    this.duelResult.update(duel, self, winnerId);
    this.showRematchState(duel);
    this.showScreen({ wide: true, fill: true }, this.duelResult.element);
  }

  private leaveDuel(): void {
    this.disposeActiveMode();
    this.mode = "daily";
    this.badge.hide();
    replaceChildren(this.hud.left, this.hud.panels.hold, this.hud.panels.progress);
    this.showPlayfield();
    this.input.setGameInputEnabled(true);
    this.returnToDaily();
  }

  // ── Rush ───────────────────────────────────────────────────────────────────

  /** What the skip binding is currently on, for the intro to name. */
  private skipKeyName(): string {
    const bound = this.settings.value.keybinds.skip[0];
    return bound ? keyName(bound) : "the unbound skip key";
  }

  /**
   * Puts the rush intro on the table.
   *
   * The daily's run is disposed rather than paused. A rush takes over the board
   * and the keyboard for five minutes, and a half-live daily attempt underneath
   * it would keep its own frame loop running and its own clock ticking against
   * a puzzle nobody is looking at.
   */
  private enterRush(): void {
    if (this.mode === "rush") return;
    this.disposeActiveMode();
    this.mode = "rush";
    this.badge.hide();
    this.input.setGameInputEnabled(false);

    this.rushIntro.update({
      durationMs: this.rushState?.durationMs ?? 300_000,
      skips: this.rushState?.skips ?? 2,
      best: this.rushState?.best ?? 0,
      playedToday: this.rushState?.run ?? null,
    });
    this.showScreen({}, this.rushIntro.element, this.rushBoard.element);
    void this.loadRushState();
  }

  private async loadRushState(): Promise<void> {
    try {
      const state = await this.connection.api.rush();
      this.rushState = state;
      this.rushBoard.update(state.leaderboard, this.connection.player.id);
      if (this.mode === "rush" && !this.rush) {
        this.rushIntro.update({
          durationMs: state.durationMs,
          skips: state.skips,
          best: state.best,
          playedToday: state.run,
        });
      }
    } catch (error) {
      this.toast(error instanceof ApiError ? error.message : "Could not load the rush board");
    }
  }

  private async beginRush(practice: boolean): Promise<void> {
    if (this.rush) return;
    this.rushIntro.setBusy(true);
    try {
      const start = await this.connection.api.startRush(practice);
      this.rushTicket = start.ticket;
      this.rushSkips = start.skips;
      this.rushRanked = start.ranked;
      this.mode = "rush";

      // The handling is frozen for the whole rush, not per puzzle: the server
      // replays every segment under the one it is given, so a mid-rush change
      // would rescore puzzles the player already finished.
      const handling = this.settings.value.handling;
      this.rush = new RushSession(start.puzzles, handling, start.durationMs, start.skips, {
        onFrame: (view, run, snapshot) => {
          this.renderer.draw(view);
          this.hud.update(run);
          this.rushPanel.update(snapshot, this.rushSkips);
          const live = this.rush?.currentRun;
          this.hud.setHistory(live?.canUndo ?? false, live?.canRedo ?? false);
        },
        onPuzzle: (puzzle) => {
          this.hud.setPuzzle(puzzle);
          this.credits.update({ day: start.day, puzzle });
          this.relayout();
        },
        onSolved: (snapshot) => {
          this.badge.show(true, `${snapshot.solved} solved`);
          window.setTimeout(() => this.badge.hide(), 380);
        },
        onFinish: (summary) => void this.finishRush(summary),
      });

      // Hold belongs in a rush as much as in the daily — more, since the pieces
      // are unfamiliar and there is a clock. `hud.update` has been keeping the
      // bay painted all along; it was simply never put on the rail.
      replaceChildren(this.hud.left, this.rushPanel.element, this.hud.panels.hold);
      replaceChildren(this.hud.right, this.hud.panels.goal, this.hud.panels.meter, this.hud.panels.queue);
      this.showPlayfield();
      this.input.setGameInputEnabled(true);
      this.toast(practice ? "Practice rush — go" : "Today's rush — go");
    } catch (error) {
      this.toast(error instanceof ApiError ? error.message : "Could not start a rush");
      // A refused start means the clock never began, so the intro is still the
      // honest thing to be looking at.
      void this.loadRushState();
    } finally {
      this.rushIntro.setBusy(false);
    }
  }

  private async finishRush(summary: RushSummary): Promise<void> {
    const ticket = this.rushTicket;
    this.input.setGameInputEnabled(false);
    this.badge.show(summary.solved > 0, `${summary.solved} solved`);
    if (!ticket) return;

    try {
      const response = await this.connection.api.submitRush({
        ticket,
        handling: this.settings.value.handling,
        segments: summary.segments.map((segment) => ({ events: segment.events })),
        timeToLastSolveMs: summary.timeToLastSolveMs,
        skipsUsed: summary.skipsUsed,
      });
      this.rushResult.update({
        run: response.run,
        ranked: response.ranked,
        isFirst: response.isFirst,
        best: response.best,
      });
      this.rushBoard.update(response.leaderboard, this.connection.player.id);
      if (response.ranked) this.rushState = null;
    } catch (error) {
      // The run happened even if filing it did not, so the player still sees
      // what they did rather than an error where their score should be.
      this.rushResult.update({
        run: {
          solved: summary.solved,
          attempted: summary.segments.length,
          skipsUsed: summary.skipsUsed,
          timeToLastSolveMs: summary.timeToLastSolveMs,
        },
        ranked: false,
        isFirst: false,
        best: this.rushState?.best ?? summary.solved,
      });
      this.toast(error instanceof ApiError ? error.message : "Could not file the rush");
    } finally {
      this.rush?.dispose();
      this.rush = null;
      this.rushTicket = null;
      this.showScreen({}, this.rushResult.element, this.rushBoard.element);
    }
  }

  /** Leaves rush for the daily, abandoning a run in progress if there is one. */
  private leaveRush(): void {
    this.disposeActiveMode();
    this.mode = "daily";
    this.badge.hide();
    this.input.setGameInputEnabled(true);
    replaceChildren(this.hud.left, this.hud.panels.hold, this.hud.panels.progress);
    this.showPlayfield();
    this.returnToDaily();
  }

  private mount(): void {
    this.showPlayfield();
    replaceChildren(
      this.root,
      this.masthead.element,
      this.deck,
      this.credits.element,
      this.settingsDialog.element,
      this.toastNode,
    );
    this.masthead.mountControl(
      el("button", {
        class: "btn",
        text: "1v1",
        title: "Play somebody in this server",
        on: { click: () => this.enterDuel() },
      }),
    );
    this.masthead.mountControl(
      el("button", {
        class: "btn",
        text: "Explore",
        title: "Browse the whole archive",
        on: { click: () => this.enterExplorer() },
      }),
    );
    this.masthead.mountControl(
      el("button", {
        class: "btn",
        text: "Rush",
        title: "Five minutes, as many puzzles as you can",
        on: { click: () => this.enterRush() },
      }),
    );
    this.masthead.mountControl(
      el("button", {
        class: "btn",
        text: "Settings",
        title: "Handling and key bindings (Esc)",
        on: { click: () => this.openSettings() },
      }),
    );
  }

  // ── Run lifecycle ──────────────────────────────────────────────────────────

  private startRun(): void {
    const sheet = this.sheet;
    if (!sheet) return;

    // The clock and the restart tally belong to a *puzzle*, not to whatever ran
    // last. Keyed on the previous run alone, wandering off to a practice puzzle
    // and back would hand the daily a fresh clock and a zeroed tally — which is
    // a free place at the top of a leaderboard sorted by time.
    const history = this.sittings.get(sheet.puzzle.id) ?? { openedAt: Date.now(), resets: 0 };
    const previous = this.run?.snapshot();
    const resumingSame = previous !== undefined && this.runningPuzzleId === sheet.puzzle.id;
    // Running out of pieces and starting over counts the same as pressing R.
    const carriedResets = resumingSame
      ? previous.resets + (previous.phase === "failed" ? 1 : 0)
      : history.resets;
    this.sittings.set(sheet.puzzle.id, { openedAt: history.openedAt, resets: carriedResets });
    this.sheetOpenedAt = history.openedAt;

    this.runningPuzzleId = sheet.puzzle.id;
    this.run?.dispose();
    this.badge.hide();
    this.leaderboard.setVisible(false);
    this.solutionPlayer = null;
    this.hud.setPuzzle(sheet.puzzle);

    this.run = new PuzzleRun(sheet.puzzle, this.settings.value.handling, {
      onFrame: (view, snapshot) => {
        this.renderer.draw(view);
        this.hud.update(snapshot);
      },
      onFinish: (snapshot, events) => void this.finishRun(snapshot, events),
      // A placement is the only thing that changes what there is to undo.
      onLock: () => this.hud.setHistory(this.run?.canUndo ?? false, this.run?.canRedo ?? false),
    },
    carriedResets,
    this.sheetOpenedAt);

    this.hud.setHistory(false, false);
    const { hold, progress, goal, meter, queue } = this.hud.panels;
    replaceChildren(this.hud.left, hold, progress);
    replaceChildren(this.hud.right, goal, meter, queue);
    this.input.setGameInputEnabled(true);
    this.startClock();
    this.relayout();
  }

  /**
   * Handling cannot change under a running attempt without the score diverging
   * from what was played, so a change starts the attempt over. Nothing is lost
   * once the puzzle is already finished.
   */
  private restartForNewHandling(): void {
    const phase = this.run?.snapshot().phase;
    if (phase !== "ready" && phase !== "playing") return;
    this.startRun();
    this.toast("Handling changed — attempt restarted");
  }

  private async finishRun(snapshot: RunSnapshot, events: readonly InputEvent[]): Promise<void> {
    const sheet = this.sheet;
    if (!sheet || this.submitting) return;
    this.input.setGameInputEnabled(false);
    this.stopClock();
    this.showBadge(snapshot.phase === "solved", snapshot);

    if (!sheet.scored) {
      this.presentVerdict(this.toShareFields(snapshot), null);
      if (sheet.solution) this.attachWalkthrough(sheet.puzzle, sheet.solution);
      return;
    }
    if (snapshot.phase !== "solved") {
      this.presentVerdict(this.toShareFields(snapshot), null);
      return;
    }

    this.submitting = true;
    this.toast("Filing sheet…");
    try {
      const response = await this.connection.api.submitRun({
        // The handling the attempt was played under, not whatever is set now.
        handling: this.run?.handling ?? this.settings.value.handling,
        events,
        resets: snapshot.resets,
        totalMs: snapshot.elapsedMs,
      });
      this.masthead.setStreak(response.streak, response.totalSolved);
      // Remember the filed sheet so returning from practice restores it.
      if (this.daily) {
        this.daily = { ...this.daily, run: response.run, solution: response.solution };
      }
      this.presentVerdict(this.toShareFields(snapshot, response.run), response.run);
      this.leaderboard.update(response.leaderboard, this.connection.player.id);
      this.attachWalkthrough(sheet.puzzle, response.solution);
      if (!response.isFirst) this.toast("Today's sheet was already filed");
    } catch (error) {
      this.presentVerdict(this.toShareFields(snapshot), null);
      this.toast(error instanceof ApiError ? error.message : "Could not file the sheet");
    } finally {
      this.submitting = false;
    }
  }

  /**
   * The board only redraws while a piece is moving, but the clock runs from the
   * moment the puzzle appears — including while the player is just thinking.
   */
  private startClock(): void {
    this.stopClock();
    this.clockTimer = setInterval(() => this.run?.renderOnce(), CLOCK_TICK_MS);
  }

  private stopClock(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  private toShareFields(snapshot: RunSnapshot, run?: StoredRun): ShareFields {
    return {
      day: this.daily?.day ?? 0,
      puzzleId: this.sheet?.puzzle.id ?? 0,
      solved: snapshot.phase === "solved",
      attack: run?.attack ?? snapshot.attack,
      targetAttack: snapshot.targetAttack,
      durationMs: run?.totalMs ?? snapshot.elapsedMs,
      resets: snapshot.resets,
      piecesPlaced: run?.piecesPlaced ?? snapshot.piecesPlaced,
      clears: run?.clears ?? snapshot.clears,
    };
  }

  /** Restores the sign-off for a day the player has already filed. */
  private showFiledRun(
    puzzle: PuzzlePrompt,
    run: StoredRun,
    solution: readonly SolutionStep[] | null,
  ): void {
    this.input.setGameInputEnabled(false);
    this.badge.show(run.solved, `${run.attack} / ${run.targetAttack} attack`);
    this.presentVerdict(
      {
        day: run.day,
        puzzleId: run.puzzleId,
        solved: run.solved,
        attack: run.attack,
        targetAttack: run.targetAttack,
        durationMs: run.totalMs,
        resets: run.resets,
        piecesPlaced: run.piecesPlaced,
        clears: run.clears,
      },
      run,
    );
    if (solution) this.attachWalkthrough(puzzle, solution);
    void this.loadLeaderboard();
  }

  private presentVerdict(fields: ShareFields, run: StoredRun | null): void {
    this.verdict.update(fields, run, { scored: this.sheet?.scored ?? true });
    replaceChildren(this.hud.left, this.verdict.element, this.leaderboard.element);
    this.hud.showFinal(fields.attack, fields.targetAttack);
    this.relayout();
  }

  private attachWalkthrough(puzzle: PuzzlePrompt, solution: readonly SolutionStep[]): void {
    this.solutionPlayer = new SolutionPlayer(puzzle, solution, BOARD_HEIGHT);
    this.walkthrough.bind(this.solutionPlayer, () => {
      if (this.solutionPlayer) this.renderer.draw(this.solutionPlayer.view());
    });
    replaceChildren(
      this.hud.right,
      this.hud.panels.goal,
      this.hud.panels.meter,
      this.walkthrough.element,
    );
    this.relayout();
  }

  private async loadLeaderboard(): Promise<void> {
    try {
      const { entries } = await this.connection.api.leaderboard();
      this.leaderboard.update(entries, this.connection.player.id);
    } catch {
      // The result card is still useful without the leaderboard.
    }
  }

  private toggleLeaderboard(): void {
    const showing = !this.leaderboard.element.hidden;
    this.leaderboard.setVisible(!showing);
    if (!showing) void this.loadLeaderboard();
  }

  /** The badge names what happened; the subtitle says how close it was. */
  private showBadge(solved: boolean, snapshot: RunSnapshot): void {
    this.badge.show(solved, `${snapshot.attack} / ${snapshot.targetAttack} attack`);
  }

  // ── Chrome ─────────────────────────────────────────────────────────────────

  /**
   * Dispatched per action rather than by falling through to restart.
   *
   * The fallthrough was fine while `reset` and `settings` were the only local
   * actions, but it meant any action added later silently wiped the board
   * instead of doing nothing — and the types could not catch it, because every
   * `LocalAction` reached the same statement.
   */
  private handleLocalAction(action: LocalAction): void {
    if (action === "settings") {
      if (this.settingsDialog.isOpen) this.settingsDialog.close();
      else this.openSettings();
      return;
    }
    // A dialog is on top; the keys under it belong to whoever is typing in it.
    if (this.settingsDialog.isOpen) return;

    switch (action) {
      case "reset":
        if (this.mode === "duel") this.duel?.restart();
        else if (this.mode === "rush") this.rush?.restart();
        else this.restartAttempt();
        return;
      case "skip":
        this.skipPuzzle();
        return;
      case "undo":
        this.stepHistory("undo");
        return;
      case "redo":
        this.stepHistory("redo");
        return;
      default: {
        const unreachable: never = action;
        throw new Error(`Unhandled local action: ${String(unreachable)}`);
      }
    }
  }

  /**
   * Takes a placement back, or puts it back.
   *
   * Works wherever a run is live, daily included. It is a gentler restart, and
   * a restart already undoes everything at once, so this opens no door that
   * was not already wide open — it just costs the player less to walk through.
   */
  /**
   * The run the player is actually looking at, if there is one.
   *
   * Keyed on the mode rather than on whichever session is still non-null, and
   * deliberately not `??`: a rush between two puzzles has no live run, and that
   * has to read as nothing rather than reaching past it to the daily attempt
   * waiting underneath.
   *
   * Every caller that repaints the board needs this rather than `this.run`.
   * `this.run` is the daily's, and it is null for the whole of a duel or a
   * rush — so anything that redraws through it draws nothing at all in the two
   * modes that have their own runs.
   */
  private get activeRun(): PuzzleRun | null {
    if (this.mode === "duel") return this.duel?.currentRun ?? null;
    if (this.mode === "rush") return this.rush?.currentRun ?? null;
    return this.run;
  }

  private stepHistory(direction: "undo" | "redo"): void {
    const run = this.activeRun;
    if (!run) return;
    const moved = direction === "undo" ? run.undo() : run.redo();
    if (!moved) this.toast(direction === "undo" ? "Nothing to undo" : "Nothing to redo");
    this.hud.setHistory(run.canUndo, run.canRedo);
  }

  /** Rush only. In the daily there is nothing after the puzzle you are on. */
  private skipPuzzle(): void {
    // A rush duel has skips too, bounded by the server rather than by us.
    if (this.mode === "duel") {
      this.duel?.skip();
      return;
    }
    if (this.mode !== "rush" || !this.rush) return;
    if (this.rush.skip()) return;
    this.toast("No skips left");
  }

  /**
   * `R` during a run wipes the attempt; after a run it starts a new one. Once a
   * scored sheet is solved and filed there is nothing left to redo.
   */
  private restartAttempt(): void {
    const snapshot = this.run?.snapshot();
    if (!snapshot) return;
    if (snapshot.phase === "solved" && this.sheet?.scored) return;
    if (snapshot.phase === "ready" || snapshot.phase === "playing") this.run?.restart();
    else this.startRun();
  }

  private openSettings(): void {
    this.settingsDialog.open(this.settings.value.handling, this.settings.value.keybinds);
  }

  private readonly relayout = (): void => {
    const rows = BOARD_HEIGHT;
    const box = this.stage.getBoundingClientRect();
    // The 200 matches `.stage { min-height }`; if it were larger the renderer
    // would draw a board the stage then clipped.
    // Resizing the canvas clears it, so every layout has to be followed by a
    // repaint of whatever should be on it. This runs from a ResizeObserver on
    // the stage, which fires just after the playfield is mounted — so on the
    // first puzzle of a duel or a rush it lands immediately after that puzzle
    // was painted, wipes it, and used to redraw nothing, because the run it
    // asked for was the daily's and the daily is not what is on screen.
    this.renderer.layout(Math.max(160, box.width), Math.max(200, box.height), rows);
    if (this.solutionPlayer) this.renderer.draw(this.solutionPlayer.view());
    else this.activeRun?.renderOnce();
  };

  private startCountdown(): void {
    const tick = () => {
      if (this.daily) {
        this.credits.setCountdown(formatCountdown(this.daily.resetsAt - Date.now()));
      }
    };
    tick();
    setInterval(tick, COUNTDOWN_TICK_MS);
  }

  private toast(message: string): void {
    this.toastNode.textContent = message;
    this.toastNode.hidden = false;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastNode.hidden = true;
    }, TOAST_MS);
  }

  private showFatal(error: unknown): void {
    const message = error instanceof ApiError ? error.message : "Could not load today's puzzle.";
    replaceChildren(
      this.root,
      el(
        "div",
        { class: "fatal" },
        el("p", { class: "fatal__title", text: "No puzzle today" }),
        el("p", { class: "fatal__detail", text: message }),
      ),
    );
  }
}
