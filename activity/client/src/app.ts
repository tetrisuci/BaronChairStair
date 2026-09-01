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
import type { ArchiveEntry, DailyResponse, StoredRun } from "./api";
import { ApiError } from "./api";
import { InputRouter } from "./game/input";
import type { LocalAction } from "@shared/keybinds";
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
import { createSettingsDialog } from "./ui/settings-dialog";
import type { ShareFields } from "./ui/share";

const COUNTDOWN_TICK_MS = 1000;
/** Fast enough for a tenth-of-a-second stopwatch to look like one. */
const CLOCK_TICK_MS = 100;
const TOAST_MS = 2200;

export class App {
  private readonly masthead = createMasthead();
  private readonly credits = createCredits();
  private readonly hud = createHud();
  private readonly badge = createVerdictBadge();
  private readonly leaderboard = createLeaderboardPanel();
  private readonly canvas = el("canvas", {
    class: "field",
    attrs: { role: "img", "aria-label": "Puzzle playfield" },
  });
  private readonly renderer = new BoardRenderer(this.canvas);
  private readonly stage = el("div", { class: "stage" }, this.canvas, this.badge.element);
  private readonly toastNode = el("div", { class: "toast", attrs: { hidden: true } });

  private readonly input: InputRouter;
  private readonly settingsDialog;
  private readonly verdict;
  private readonly walkthrough = createWalkthroughPanel();

  private run: PuzzleRun | null = null;
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
  private archive: readonly ArchiveEntry[] | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly connection: Connection,
    private readonly settings: SettingsStore,
  ) {
    this.input = new InputRouter(settings.value.keybinds, {
      onGameKey: (key, down) => this.run?.input(key, down),
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
  private async startPractice(): Promise<void> {
    try {
      this.archive ??= (await this.connection.api.archive()).puzzles;
      const choices = this.archive.filter((entry) => entry.id !== this.sheet?.puzzle.id);
      const pick = choices[Math.floor(Math.random() * choices.length)];
      if (!pick) {
        this.toast("The archive has nothing else to draw");
        return;
      }
      const { puzzle, solution } = await this.connection.api.archivePuzzle(pick.id);
      this.sheet = { puzzle, solution, scored: false };
      this.credits.update({ day: this.daily?.day ?? 0, puzzle });
      this.startRun();
      this.toast(`Practice · ${puzzle.title || `sheet ${puzzle.id}`}`);
    } catch (error) {
      this.toast(error instanceof ApiError ? error.message : "Could not open the archive");
    }
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

  private mount(): void {
    const deck = el(
      "div",
      { class: "deck" },
      this.hud.left,
      this.stage,
      this.hud.right,
    );
    replaceChildren(
      this.root,
      this.masthead.element,
      deck,
      this.credits.element,
      this.settingsDialog.element,
      this.toastNode,
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
      onLock: () => undefined,
    },
    carriedResets,
    this.sheetOpenedAt);

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

  private handleLocalAction(action: LocalAction): void {
    if (action === "settings") {
      if (this.settingsDialog.isOpen) this.settingsDialog.close();
      else this.openSettings();
      return;
    }
    if (this.settingsDialog.isOpen) return;
    this.restartAttempt();
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
    this.renderer.layout(Math.max(160, box.width), Math.max(200, box.height), rows);
    if (this.solutionPlayer) this.renderer.draw(this.solutionPlayer.view());
    else this.run?.renderOnce();
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
