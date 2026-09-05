/**
 * Application wiring.
 *
 * Builds the sheet, runs one attempt at a time, and swaps the rails over to the
 * sign-off when the attempt ends. Everything it knows about the outside world
 * arrives through `Connection`; everything the player changes goes back through
 * `SettingsStore`.
 */

import { BOARD_HEIGHT, type PuzzlePrompt, type SolutionStep } from "@shared/puzzle";
import type { Handling } from "@shared/tetris/handling";
import type { InputEvent } from "@shared/tetris/verify";
import type { Connection } from "./discord";
import type { DailyEntry, DailyResponse, RushState, StoredRun } from "./api";
import type { ArchiveListing } from "@shared/puzzle";
import { filterArchive } from "@shared/archive-filter";
import { ApiError } from "./api";
import { InputRouter } from "./game/input";
import { type LocalAction, keyName } from "@shared/keybinds";
import { RushSession, type RushSummary } from "./game/rush";
import { PuzzleRun, type RunSnapshot } from "./game/runner";
import { createDailyBoard } from "./ui/daily-board";
import { createHome } from "./ui/home";
import type { DailyTier } from "@shared/daily";
import { activeRun, type PlayMode } from "./game/active-run";
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
import { createBuilder, type Builder } from "./ui/builder";
import type { SubmissionVerdict } from "./ui/builder-submit";
import type { SubmissionBody } from "./ui/builder-state";
import { createStartedPuzzles, type StartedPuzzles } from "./started";
import { lockedPuzzleIds } from "./daily-lock";
import { DuelClient } from "./game/duel";
import {
  createDuelIntro,
  createDuelLobby,
  createDuelPanel,
  createDuelResult,
} from "./ui/duel";
import {
  createRushBoard,
  createRushRecords,
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
  private readonly masthead = createMasthead(() => this.showHome());
  private readonly credits = createCredits();
  private readonly hud = createHud({
    onUndo: () => this.stepHistory("undo"),
    onRedo: () => this.stepHistory("redo"),
  });
  private readonly badge = createVerdictBadge();
  private readonly leaderboard = createLeaderboardPanel();
  private readonly dailyBoard = createDailyBoard();
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
  private readonly rushRecords = createRushRecords((scope) => {
    this.rushScope = scope;
    void this.loadRushRecords();
  });
  /** Which population the record book is showing. Not a day; it never resets. */
  private rushScope: import("./api").RushScope = "global";
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
  /** Whether the run on screen was a practice run, as opposed to the day's. */
  private rushPractice = false;
  private rushSkips = 0;
  private rushRanked = true;
  private rushState: RushState | null = null;
  private mode: PlayMode = "daily";
  private solutionPlayer: SolutionPlayer | null = null;
  private readonly home = createHome({
    // Straight onto a board. There was a chooser between the two — the same
    // three rows, one click deeper — and folding it into the front door is
    // half of what this screen is for.
    onPick: (tier) => this.showDailyTier(tier),
    onRush: () => this.enterRush(),
    onDuel: () => this.enterDuel(),
    onExplore: () => this.enterExplorer(),
    onBuild: () => this.enterBuilder(),
  });
  /**
   * Built on first use, then kept for the session.
   *
   * Two hundred grid cells is not something a player who never opens the
   * builder should pay for at boot — and once it exists it holds the board
   * being laid out, which has to survive a trip to the front door and back.
   */
  private builder: Builder | null = null;
  /**
   * The draft being played inside the builder, and the puzzle it was compiled
   * from.
   *
   * Kept apart from `run` on purpose. A test is scored by nobody, files
   * nothing and belongs to no day, so letting it borrow the daily's run would
   * put a draft on the leaderboard's clock — and every one of `finishRun`'s
   * branches reads a `sheet` that a draft has no business having.
   */
  private builderRun: PuzzleRun | null = null;
  private builderPuzzle: PuzzlePrompt | null = null;
  private daily: DailyResponse | null = null;
  /**
   * Which of the day's three is on the board.
   *
   * The day holds three now, and only one can be played at a time — this is
   * the one the sheet, the credits, the submission and the leaderboard are all
   * about. It opens on the easy one: a day should start somewhere anybody can
   * begin, and the other two are a click away.
   */
  private dailyTier: DailyTier = "easy";
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
  /**
   * Which of the day's three this player has opened, across sessions.
   *
   * Assigned in the constructor rather than here because it is keyed on the
   * player, and a field initialiser cannot see a constructor parameter.
   */
  private readonly started: StartedPuzzles;
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
    this.started = createStartedPuzzles(connection.player.id);
    this.input = new InputRouter(settings.value.keybinds, {
      onGameKey: (key, down) => {
        if (this.mode === "duel") this.duel?.input(key, down);
        else if (this.mode === "rush") this.rush?.input(key, down);
        else if (this.mode === "build") this.builderRun?.input(key, down);
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
      () => void this.beginRush(this.rushPractice),
      () => this.leaveRush(),
      (id) => void this.openArchivePuzzle(id),
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

    this.showHome();
  }

  /**
   * The prologue every screen shares.
   *
   * Each `enter*`/`show*` used to hand-roll these four lines, and two of the
   * screens added with the front door forgot the first one — so clicking Home
   * mid-rush left the rush running: its frame loop, its buzzer, and five
   * minutes later a filed run yanking whatever screen you had moved to. A duel
   * left the socket open while the keyboard stopped routing to it, which is a
   * forfeit nobody chose. `disposeActiveMode`'s own comment says it exists so
   * "the next mode added" is not the one that forgets; the next screen added
   * forgot, so the prologue is now one place instead of eight.
   */
  private leaveForScreen(): void {
    this.disposeActiveMode();
    this.mode = "daily";
    this.input.setGameInputEnabled(false);
    this.badge.hide();
  }

  /**
   * The front door: the day's three, where else to go, and a board.
   *
   * Every mode leaves through here and the activity opens on it, so it is the
   * screen most often looked at and the one that had least on it. It is now
   * also the chooser — pressing one of the three goes straight to a board.
   */
  private showHome(): void {
    if (!this.daily) return;
    this.leaveForScreen();
    this.home.update(
      this.daily.day,
      this.daily.puzzles,
      this.daily.streak,
      // What the server cannot know: a daily run is filed only when it solves,
      // so a puzzle somebody opened and walked away from looks untouched from
      // its side of the wire.
      this.startedToday(),
    );
    this.home.mountBoard(this.dailyBoard.element);
    // `full` rather than `wide`+`fill`: two columns want the deck's whole width,
    // and they want a row exactly as tall as the screen so the board beside the
    // day can scroll inside itself instead of stretching the page.
    this.showScreen({ full: true }, this.home.element);
    void this.loadLeaderboard();
  }

  /**
   * Puts one of the day's three on the board.
   *
   * The single funnel for it: the sheet, the credits strip, the goal panel and
   * whether a filed run is shown all have to agree about which puzzle is in
   * front of the player, and they only do that if one place sets them.
   */
  private showDailyTier(tier: DailyTier): void {
    if (!this.daily) return;
    // Clicking the tier you are already playing is a no-op, not a restart:
    // rebuilding here would throw away an attempt in progress. It cannot fire
    // from the front door, which arrives through `leaveForScreen` with the run
    // already disposed, but the masthead and the wordmark are one press away.
    if (tier === this.dailyTier && this.run) return;
    this.dailyTier = tier;
    const entry = this.dailyEntry;
    if (!entry) return;
    this.sheet = { puzzle: entry.puzzle, solution: entry.solution, scored: true };
    this.credits.update(entry.puzzle);
    this.hud.setPuzzle(entry.puzzle);
    // Rebuilt rather than left alone: a filed tier puts the walkthrough in this
    // rail, and switching from it to an unplayed one would otherwise keep the
    // last puzzle's solution where the queue belongs.
    replaceChildren(
      this.hud.right,
      this.hud.panels.goal,
      this.hud.panels.meter,
      this.hud.panels.queue,
    );
    // The board itself. The chooser is a screen and holds the whole deck, so
    // without this the run starts correctly and invisibly, underneath it —
    // which is what clicking a tier appeared to do: nothing.
    this.input.setGameInputEnabled(true);
    this.showPlayfield();
    // Mounted first, painted second, as everywhere else: showPlayfield relays
    // out, a relayout resizes the canvas, and resizing a canvas clears it.
    if (entry.run) this.showFiledRun(entry.puzzle, entry.run, entry.solution);
    else this.startRun();
  }

  // ── Practice ───────────────────────────────────────────────────────────────

  /** The day's puzzles this player has opened, by id. */
  private startedToday(): ReadonlySet<number> {
    const day = this.daily?.day ?? 0;
    return new Set(
      (this.daily?.puzzles ?? [])
        .map((entry) => entry.puzzle.id)
        .filter((id) => this.started.has(day, id)),
    );
  }

  /** The one of the day's three currently on the board. */
  private get dailyEntry(): DailyEntry | null {
    return this.daily?.puzzles.find((entry) => entry.tier === this.dailyTier) ?? null;
  }

  /**
   * The puzzles practice will not open. The rule lives in `daily-lock.ts`.
   *
   * Today's puzzle, while it is still the player's to file: practising it
   * before filing would be a free rehearsal for the one run that counts, so it
   * is kept out of the shuffle and shown greyed in the explorer until the
   * daily is on the board. Afterwards it is just another puzzle.
   */
  private lockedPuzzleIds(): ReadonlySet<number> {
    return lockedPuzzleIds(this.daily?.puzzles ?? []);
  }

  private async loadArchive(): Promise<readonly ArchiveListing[]> {
    this.archive ??= (await this.connection.api.archive()).puzzles;
    return this.archive;
  }

  /** Picks a sheet from the archive at random and plays it unscored. */
  private async startPractice(): Promise<void> {
    try {
      const archive = await this.loadArchive();
      const locked = this.lockedPuzzleIds();
      const choices = filterArchive(archive, this.settings.value.filter).filter(
        // Never the puzzle already on the table, so "random" always changes it.
        (entry) => !locked.has(entry.id) && entry.id !== this.sheet?.puzzle.id,
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
    if (this.lockedPuzzleIds().has(id)) {
      this.toast("That is one of today's three — play it on the daily first");
      return;
    }
    try {
      const { puzzle, solution } = await this.connection.api.archivePuzzle(id);
      this.sheet = { puzzle, solution, scored: false };
      this.credits.update(puzzle);
      // Unconditional. Three things open a puzzle from the archive — the
      // explorer's list, the random-practice button, and the "play it" link on
      // the rush result card — and only the first two were ever in `explore`.
      // From the rush card the mode stayed `rush`, so `activeRun` answered null
      // and the board that had just been opened took no input at all.
      this.mode = "daily";
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

    this.endBuilderRun();
    // Whichever way the screen was left, the builder's board goes back to
    // being something to paint on rather than a frozen last frame with the
    // palette still hidden behind it.
    this.builder?.endTest();
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
    this.explorer.update(this.archive ?? [], this.settings.value.filter, this.lockedPuzzleIds());
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
    // Home, not the last puzzle. Leaving a rush or a duel means leaving the
    // thing you were doing, and the front door is where the next choice gets
    // made — and where the day's three now are.
    this.showHome();
  }

  /**
   * The three-column layout: rails either side of a centre stage.
   *
   * Two things mount this way — the game and the builder — and only the deck
   * knows the shape, so the shape is written once here. Removing
   * `deck--screen` is half of it: without that the deck is still the one
   * stretched column a screen sits in, and the middle of three landed in it
   * alone with the rails stacked below the fold.
   */
  private showColumns(left: HTMLElement, centre: HTMLElement, right: HTMLElement): void {
    this.deck.classList.remove("deck--screen");
    replaceChildren(this.deck, left, centre, right);
  }

  /** The play layout: the HUD rails either side of the game's canvas. */
  private showPlayfield(): void {
    this.showColumns(this.hud.left, this.stage, this.hud.right);
    this.relayout();
  }

  /**
   * The strip credits the puzzle on the board, so it says nothing when there
   * is no board.
   *
   * `showPlayfield` is the only mount that has one, and its four callers set
   * the credits in the breath before it — so blanking them belongs to the two
   * mounts that do not: every screen, and the builder. Without it the strip
   * outlives the board it describes and names yesterday's puzzle at the foot
   * of the front door.
   */
  private clearCredits(): void {
    this.credits.update(null);
  }

  /** One centred column, for a moment when there is nothing to play. */
  private showScreen(
    options: { wide?: boolean; full?: boolean; fill?: boolean },
    ...cards: HTMLElement[]
  ): void {
    this.clearCredits();
    this.deck.classList.add("deck--screen");
    const modifiers = [
      options.wide && "screen--wide",
      options.full && "screen--full",
      options.fill && "screen--fill",
    ]
      .filter(Boolean)
      .join(" ");
    replaceChildren(this.deck, el("div", { class: `screen ${modifiers}`.trim() }, ...cards));
  }

  // ── Builder ────────────────────────────────────────────────────────────────

  /**
   * The authoring screen. No mode of its own: nothing is running behind it, the
   * keyboard belongs to whatever is focused inside it, and `leaveForScreen`
   * has already put away the run, rush or duel that was live when Build was
   * clicked — which is the whole of what a screen has to do here.
   *
   * It takes the play layout rather than a centred card, because the board is
   * what the screen is for and a card gave it a narrow column beside its own
   * controls. Not `showPlayfield`, which mounts the *game's* HUD and relays out
   * a canvas that is not on screen; the builder brings its own three parts.
   * Home and the wordmark still lead out through `showScreen`, which puts
   * `deck--screen` back.
   */
  private enterBuilder(): void {
    this.leaveForScreen();
    this.builder ??= createBuilder(
      {
        onClose: () => this.showHome(),
        onTest: (puzzle) => this.startBuilderTest(puzzle),
        onStopTest: () => this.stopBuilderTest(),
        onSubmit: (draft) => this.submitPuzzle(draft),
      },
      // Read once, at the moment the builder is built, which is safe only
      // because a connection is made before any screen opens and never
      // changes afterwards — `connect` hands back one `Connection` for the
      // life of the page. A guest who signs in reloads the activity.
      this.connection.guest,
    );
    this.clearCredits();
    this.showColumns(this.builder.left, this.builder.board, this.builder.right);
  }

  /**
   * Plays a draft on the builder's own board.
   *
   * The app owns the run because it owns the handling and the keyboard, and
   * because a run built anywhere else would be one `disposeActiveMode` cannot
   * put away. Nothing else about the screen moves: the deck still holds the
   * builder's three columns, and the frames go back to it rather than to the
   * game's canvas, which is not mounted.
   */
  private startBuilderTest(puzzle: PuzzlePrompt): void {
    // Through the same door as every other way out of a test: the run being
    // replaced here is the one a handling change or the R key just restarted,
    // and its log is as much a record of what the author did as the last one's.
    this.endBuilderRun();
    this.builderPuzzle = puzzle;
    this.mode = "build";
    // Read once and carried alongside the log rather than looked up again when
    // the run ends. `PuzzleRun` freezes handling for the life of an attempt,
    // and the server replays a whole log under one handling — so an author who
    // opens the settings between the last piece and Submit would otherwise have
    // their run replayed under controls they never played it with.
    const handling = this.settings.value.handling;
    this.builderRun = new PuzzleRun(puzzle, handling, {
      onFrame: (view, snapshot) => this.builder?.showTest(view, snapshot),
      // The end of a run is the only artefact a submission can be built from.
      // Nothing is filed here — the builder holds it, and holds it only while
      // the draft it was played on is still the draft on the screen.
      onFinish: (snapshot, events) => this.keepBuilderSolve(snapshot, events, handling),
      onLock: () => undefined,
    });
    this.input.setGameInputEnabled(true);
    this.builderRun.renderOnce();
  }

  private stopBuilderTest(): void {
    this.endBuilderRun();
    this.mode = "daily";
    this.input.setGameInputEnabled(false);
    this.builder?.endTest();
  }

  /**
   * Puts the builder's run away, keeping its log on the way past.
   *
   * `dispose` never fires `onFinish`, and every way out of a test but playing
   * the queue to its end goes through it — Stop, the wordmark, the R key, a
   * handling change. **An abandoned run counts.** The log is the same artefact
   * either way: the server derives the target and the reference solution from
   * what it replays, never from a claim about how the attempt ended, and the
   * case being protected is the ordinary one — an author whose goal names no
   * attack figure plays the four pieces that make the shape they wanted out of
   * a queue of ten and presses Stop, because there is nothing left to show.
   * Requiring a finished run would lose exactly those, and leave them told to
   * "play your own puzzle first" having just done it.
   *
   * `log()` is the mid-attempt reader a rush already needed for the same
   * reason, which is why there is nothing new in the runner for this.
   */
  private endBuilderRun(): void {
    const run = this.builderRun;
    // `run.handling`, not the settings: a handling change is one of the things
    // that ends a run this way, and by now the settings hold the new one.
    if (run) this.keepBuilderSolve(run.snapshot(), run.log(), run.handling);
    run?.dispose();
    this.builderRun = null;
    this.builderPuzzle = null;
  }

  /**
   * Hands a run's log to the builder, which keeps it for as long as the draft
   * on the screen is the one it was played on.
   *
   * Copied out of the run rather than passed by reference: `log()` hands back
   * the live array, and a log that changed under the thing holding it would be
   * a solve for a run nobody watched.
   *
   * A run that ends and is then put away arrives here twice carrying the same
   * events, so this replaces rather than accumulates. Whether a log is worth
   * keeping at all is the builder's call, not this one's — it is the side that
   * knows which draft is on the screen.
   */
  private keepBuilderSolve(
    snapshot: RunSnapshot,
    events: readonly InputEvent[],
    handling: Handling,
  ): void {
    this.builder?.keepSolve({ snapshot, events: [...events], handling });
  }

  /**
   * Files a draft the builder compiled.
   *
   * The same split `onTest` is under, read the other way: the builder owns the
   * screen and this owns the network, so what crosses back is the server's own
   * reading of the run and nothing else. No `toast` and no `try` — a failure
   * belongs beside the button that caused it rather than in a strip that times
   * out, and `ApiError` already carries the server's sentence for the builder
   * to print. Letting the rejection through is how it gets there.
   *
   * Nothing about the day, the sheet or the leaderboard moves: a submission is
   * not a run, files no attempt, and the puzzle does not exist until an officer
   * says so.
   */
  private async submitPuzzle(draft: SubmissionBody): Promise<SubmissionVerdict> {
    const response = await this.connection.api.submitPuzzle(draft);
    return { attack: response.verified.attack };
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
    this.credits.update(puzzle);
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
    this.showScreen({}, this.rushIntro.element, this.rushBoard.element, this.rushRecords.element);
    void this.loadRushRecords();
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
      // Which mode this was, kept apart from whether it counted: a second run
      // at the day's own stack is unranked but it is not practice, and "play
      // again" after one should deal that stack rather than a random one.
      this.rushPractice = practice;
      this.rushTicket = start.ticket;
      this.rushSkips = start.skips;
      this.rushRanked = start.ranked;
      this.mode = "rush";
      // The last rush's sign-off is still on the stage: it is shown when a rush
      // ends and deliberately never times out, because the result screen covers
      // the board and it is only ever seen again if the board comes back. "Play
      // again" is exactly that, and it enters here rather than through
      // `enterRush`, which is where the other two ways in clear it.
      this.badge.hide();

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
          this.credits.update(puzzle);
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
        played: response.played,
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
        // The server never answered, so there is no account of which puzzles
        // were solved. Better to show none than to invent one.
        played: [],
        ranked: false,
        isFirst: false,
        best: this.rushState?.best ?? summary.solved,
      });
      this.toast(error instanceof ApiError ? error.message : "Could not file the rush");
    } finally {
      this.rush?.dispose();
      this.rush = null;
      this.rushTicket = null;
      this.showScreen({}, this.rushResult.element, this.rushBoard.element, this.rushRecords.element);
      void this.loadRushRecords();
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
    // First control, and the only one that is a way *back* rather than a way
    // somewhere else: every screen can be left without knowing which one it is.
    this.masthead.mountControl(
      el("button", {
        class: "btn",
        text: "Home",
        title: "The day, the boards, and everything else",
        on: { click: () => this.showHome() },
      }),
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
    // Opening one of the day's counts, whether or not it is ever finished: a
    // daily run reaches the server only when it solves, so this is the only
    // record that a puzzle was ever looked at. Practice is not the day's.
    if (sheet.scored && this.daily) this.started.add(this.daily.day, sheet.puzzle.id);
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
    if (this.mode === "build") {
      if (this.replayBuilderTest()) this.toast("Handling changed — test restarted");
      return;
    }
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
        // Which of the three this log was played on. The server replays it
        // against that board, so naming the wrong one fails to solve rather
        // than filing anything.
        tier: this.dailyTier,
        // The handling the attempt was played under, not whatever is set now.
        handling: this.run?.handling ?? this.settings.value.handling,
        events,
        resets: snapshot.resets,
        totalMs: snapshot.elapsedMs,
      });
      // Remember the filed sheet so returning from practice restores it.
      // Only the tier that was filed. The other two are untouched — and their
      // solutions must stay null, or filing the easy one would reveal them.
      if (this.daily) {
        this.daily = {
          ...this.daily,
          puzzles: this.daily.puzzles.map((entry) =>
            entry.tier === response.tier
              ? { ...entry, run: response.run, solution: response.solution }
              : entry,
          ),
        };
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
    this.walkthrough.bind(this.solutionPlayer, (stepped) => {
      // The badge lands on the board and stays there, which is right for a
      // result and wrong the moment the board becomes something to read. The
      // first press of the walkthrough is where it stops being a verdict and
      // starts being in the way of the answer it is sitting on top of.
      if (stepped) this.badge.hide();
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

  /** The all-time board. Its own call: it does not change when a day does. */
  private async loadRushRecords(): Promise<void> {
    try {
      const { entries, scope } = await this.connection.api.rushRecords(this.rushScope);
      this.rushRecords.update(entries, scope, this.connection.player.id);
    } catch {
      // A record book is not worth an error where somebody's result should be.
    }
  }

  private async loadLeaderboard(): Promise<void> {
    try {
      const { board, rush } = await this.connection.api.leaderboard();
      const self = this.connection.player.id;
      // One call, two readers: the home screen shows the day whole, and the
      // panel beside a board shows the tier being played.
      this.dailyBoard.update(board, rush, self);
      // Second reader of the same response: the front door's Rush row says how
      // busy the mode has been today, which is the one live number any of the
      // four rows there has and is worth no request of its own.
      this.home.setRush(rush);
      // The verdict rail's panel wants per-run rows, which the day board no
      // longer carries; it is refreshed from the submit response instead.
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
        // Rebuilt rather than restarted: `restart` refuses on a solved run,
        // and a draft the author has just solved is exactly the one they want
        // to play again.
        else if (this.mode === "build") this.replayBuilderTest();
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
   * Every caller that repaints the board needs this rather than `this.run`.
   * `this.run` is the daily's, and it is null for the whole of a duel or a
   * rush — so anything that redraws through it draws nothing at all in the two
   * modes that have their own runs. The choice itself lives in `active-run.ts`,
   * where it can be tested without a browser.
   */
  private get activeRun(): PuzzleRun | null {
    return activeRun(this.mode, {
      daily: this.run,
      rush: this.rush?.currentRun,
      duel: this.duel?.currentRun,
      build: this.builderRun,
    });
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

  /** The draft on the board again, from the top. False when none is loaded. */
  private replayBuilderTest(): boolean {
    if (!this.builderPuzzle) return false;
    this.startBuilderTest(this.builderPuzzle);
    return true;
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
