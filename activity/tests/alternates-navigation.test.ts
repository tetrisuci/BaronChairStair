/**
 * An alternate opens asynchronously, while its list and Home remain usable.
 * Exercise the real App transitions through the row, masthead and daily-card
 * callbacks: an old response must not dispose the run started in the meantime
 * or replace the gallery chosen by a newer request.
 *
 * As in selection-model.test.ts, take App's prototype instead of building the
 * whole app. Rendering and navigation run normally; the network is held by
 * hand, and a small disposable run stands in for the live Tetris loop.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { GalleryLine } from "../client/src/api";
import { createAlternates } from "../client/src/ui/alternates";
import { createMasthead } from "../client/src/ui/chrome";
import { createHome } from "../client/src/ui/home";
import { createSolutionsMenu } from "../client/src/ui/solutions-menu";
import { createSolutionsPanel } from "../client/src/ui/solutions";
import type { DailyTier } from "../shared/daily";
import type { ArchiveListing, PuzzlePrompt, SolutionStep } from "../shared/puzzle";

let window: Window;
let App: (typeof import("../client/src/app"))["App"];
const saved = {
  document: globalThis.document,
  window: globalThis.window,
  getComputedStyle: globalThis.getComputedStyle,
};

beforeAll(async () => {
  window = new Window({ url: "https://local.test/" });
  globalThis.document = window.document as unknown as Document;
  globalThis.window = window as unknown as typeof globalThis.window;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window) as unknown as typeof getComputedStyle;
  App = (await import("../client/src/app")).App;
});

afterAll(async () => {
  globalThis.document = saved.document;
  globalThis.window = saved.window;
  globalThis.getComputedStyle = saved.getComputedStyle;
  await window.happyDOM.close();
});

function deferred<T>() {
  let resolve!: (answer: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const puzzle = (id: number): PuzzlePrompt => ({
  id, title: `Synthetic ${id}`, author: "Fixture", difficulty: 3, goal: "Send 4",
  set: null, board: [], queue: ["T"], hold: null, targetAttack: 4,
});

const STEPS: readonly SolutionStep[] = [
  { piece: "T", cells: [[3, 0], [4, 0], [5, 0], [4, 1]], clear: null, attack: 0 },
];

const line = (solutionId: number): GalleryLine => ({
  solutionId, placements: STEPS, attack: 4, clears: [], source: "player",
  finder: { id: "finder", username: "Finder", avatarUrl: null }, foundAt: 1,
  solvedStrict: true,
});

interface HarnessApp {
  solutionRequest: number;
  archive: readonly ArchiveListing[] | null;
  solutionsFor: PuzzlePrompt | null;
  solutionsLines: readonly GalleryLine[];
  sheet: { puzzle: PuzzlePrompt; solution: readonly SolutionStep[] | null; scored: boolean } | null;
  run: { dispose(): void } | null;
  openAlternate(puzzleId: number, solutionId: number): Promise<void>;
  openSolutions(puzzleId: number): Promise<void>;
  showHome(): void;
  showDailyTier(tier: DailyTier): void;
  leaveExplorer(): void;
}

function harness() {
  const node = () => document.createElement("div");
  const deck = node();
  const root = node();
  const pending: Promise<void>[] = [];
  const requested: number[] = [];
  const toasts: string[] = [];
  const archive = deferred<{ puzzles: readonly ArchiveListing[]; cleared: number[] }>();
  const requests = new Map([11, 12].map((id) => [id, {
    puzzle: deferred<{ puzzle: PuzzlePrompt; solution: null }>(),
    gallery: deferred<{ solutions: readonly GalleryLine[] }>(),
  }]));
  let disposed = 0;
  const app = Object.assign(Object.create(App.prototype), {
    solutionRequest: 0, mode: "explore", archive: [], cleared: new Set([11, 12]),
    solutionsFor: null, solutionsLines: [], sheet: null,
    daily: { day: 281, puzzles: [{ tier: "easy", puzzle: puzzle(22), run: null, solution: null }], streak: 0 },
    dailyTier: "easy", run: null, rush: null, duel: null, duelTick: null, builder: null,
    solutionPlayer: null, deck, stage: node(),
    connection: {
      player: { id: "reader" },
      api: {
        archive: () => archive.promise,
        archivePuzzle: (id: number) => {
          requested.push(id);
          return requests.get(id)!.puzzle.promise;
        },
        puzzleSolutions: (id: number) => requests.get(id)!.gallery.promise,
      },
    },
    badge: { hide() {} }, input: { setGameInputEnabled() {} }, credits: { update() {} },
    hud: { left: node(), right: node(), panels: { hold: node(), goal: node(), queue: node() }, setPuzzle() {} },
    walkthrough: createSolutionsPanel(),
    solutionsMenu: createSolutionsMenu({ onOpen: () => {}, onClose: () => {} }),
    dailyBoard: { element: node() }, discoveryBoard: { element: node() },
    endBuilderRun() {}, startedToday: () => new Set(),
    loadDiscoveries: async () => {}, loadLeaderboard: async () => {},
    playSolution() {}, relayout() {}, toast: (message: string) => toasts.push(message),
    startRun() {
      app.run = { dispose() { disposed += 1; } };
    },
  }) as HarnessApp;
  const home = createHome({
    onPick: (tier) => app.showDailyTier(tier),
    onRush() {}, onDuel() {}, onExplore() {}, onBuild() {},
  });
  Object.assign(app, { home });
  const masthead = createMasthead(() => app.showHome());
  const alternates = createAlternates({
    onOpen: (row) => pending.push(app.openAlternate(row.puzzleId, row.solutionId)),
    onClose: () => app.leaveExplorer(),
  });
  alternates.update([11, 12].map((puzzleId) => ({
    ...line(puzzleId), puzzleId, title: `Synthetic ${puzzleId}`, difficulty: 3,
    set: null, locked: false, pieces: STEPS.length,
  })), "reader");
  deck.append(alternates.element);
  root.append(masthead.element, deck);
  document.body.append(root);
  return {
    app, root, deck, pending, requested, toasts, archive,
    disposed: () => disposed,
    click(id: number) {
      root.querySelector<HTMLButtonElement>(`[data-solution="${id}"]`)!.click();
    },
    answer(id: number) {
      const held = requests.get(id)!;
      held.puzzle.resolve({ puzzle: puzzle(id), solution: null });
      held.gallery.resolve({ solutions: [line(id)] });
    },
    fail(id: number) {
      const held = requests.get(id)!;
      held.puzzle.reject(new Error("offline"));
      held.gallery.resolve({ solutions: [] });
    },
    async sent() {
      // openAlternate first awaits the archive, even when it is already cached.
      await Promise.resolve();
    },
    close() { root.remove(); },
  };
}

describe("opening an alternate across navigation", () => {
  test("a late gallery does not replace or dispose a daily started from Home", async () => {
    const made = harness();
    try {
      made.click(11);
      await made.sent();
      expect(made.requested).toEqual([11]);
      made.root.querySelector<HTMLButtonElement>(".masthead__home")!.click();
      made.root.querySelector<HTMLButtonElement>(".today__sheet")!.click();
      const run = made.app.run;
      expect(run).not.toBeNull();
      expect(made.app.sheet?.puzzle.id).toBe(22);

      made.answer(11);
      await made.pending[0];

      expect(made.app.run).toBe(run);
      expect(made.disposed()).toBe(0);
      expect(made.app.sheet?.puzzle.id).toBe(22);
      expect(made.app.solutionsFor).toBeNull();
      expect(made.app.solutionsLines).toEqual([]);
    } finally { made.close(); }
  });

  test("leaving before the archive arrives never starts a gallery request", async () => {
    const made = harness();
    try {
      made.app.archive = null;
      made.click(11);
      made.root.querySelector<HTMLButtonElement>(".masthead__home")!.click();
      made.archive.resolve({ puzzles: [], cleared: [11, 12] });
      await made.pending[0];

      expect(made.requested).toEqual([]);
      expect(made.deck.querySelector(".home")).not.toBeNull();
      expect(made.app.solutionsFor).toBeNull();
    } finally { made.close(); }
  });

  test("the last alternate chosen wins when responses arrive in reverse order", async () => {
    const made = harness();
    try {
      made.click(11);
      await made.sent();
      made.click(12);
      await made.sent();
      made.answer(12);
      await made.pending[1];
      made.answer(11);
      await made.pending[0];

      expect(made.app.sheet?.puzzle.id).toBe(12);
      expect(made.app.solutionsFor?.id).toBe(12);
      expect(made.app.solutionsLines.map((one) => one.solutionId)).toEqual([12]);
    } finally { made.close(); }
  });

  test("a newer Solutions menu wins over a pending alternate", async () => {
    const made = harness();
    try {
      made.click(11);
      await made.sent();
      const menu = made.app.openSolutions(12);
      made.answer(12);
      await menu;
      made.answer(11);
      await made.pending[0];

      expect(made.deck.querySelector(".solutions-menu")).not.toBeNull();
      expect(made.app.sheet).toBeNull();
      expect(made.app.solutionsFor?.id).toBe(12);
      expect(made.app.solutionsLines.map((one) => one.solutionId)).toEqual([12]);
    } finally { made.close(); }
  });

  test("a superseded Solutions request cannot replace a newer alternate or show its failure", async () => {
    const made = harness();
    try {
      const menu = made.app.openSolutions(11);
      made.click(12);
      await made.sent();
      made.answer(12);
      await made.pending[0];
      made.fail(11);
      await menu;

      expect(made.app.sheet?.puzzle.id).toBe(12);
      expect(made.app.solutionsFor?.id).toBe(12);
      expect(made.app.solutionsLines.map((one) => one.solutionId)).toEqual([12]);
      expect(made.toasts).toEqual([]);
    } finally { made.close(); }
  });
});
