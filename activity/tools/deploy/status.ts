/**
 * `status [--wait-quiet]`: one line per app, so "is anybody playing?" is read
 * from the apps rather than guessed from database writes and open sockets.
 *
 *     game (puzzle-activity, abc1234): serving · 1 duel, 0 lobbies, 0 rushes, 3 sessions, 0 in flight
 *     bot (bcs-bot, abc1234): ready · idle 14 min · no sync
 *     site (puzzle-db, abc1234): online
 *
 * Only the config's apps, and only counts: a status file holds nothing else,
 * and pm2's environments are dropped before anything here sees them. The
 * build shown is the one the process says it runs, which is the truth even
 * when state.json has moved on (a bot recorded without a restart).
 */

import type { Context } from "./host";
import { botStatusFile, slotStatusFile } from "./layout";
import { findProcess, isOnline, pm2List, type Pm2Process } from "./pm2";
import { botOf, botQuiet, describeBotActivity, describeGameCounts, gameOf, gameQuiet, unusableReason } from "./readiness";
import { shortSha } from "./release";
import { loadState, type DeployState } from "./state";
import { waitUntil } from "./wait";

const QUIET_POLL_MS = 5_000;
const PROGRESS_EVERY_MS = 30_000;
const MINUTE_MS = 60_000;

function processWord(process: Pm2Process | undefined): string | null {
  if (!process) return "not running";
  return isOnline(process) ? null : process.status;
}

function gameLine(ctx: Context, state: DeployState, processes: readonly Pm2Process[], slot: string, now: number): string {
  const reading = ctx.host.readStatus(slotStatusFile(ctx.layout, slot));
  const status = gameOf(reading);
  const recorded = slot === state.game.activeSlot ? state.game.release : null;
  const head = `game (${slot}, ${shortSha(status?.buildId ?? recorded)})`;
  const word = processWord(findProcess(processes, slot));
  if (word !== null) return `${head}: ${word}`;
  const unusable = unusableReason(reading, now);
  if (unusable !== null || status === null) return `${head}: online · ${unusable ?? "not a game status"}`;
  return `${head}: ${status.state} · ${describeGameCounts(status)}`;
}

function botLine(ctx: Context, state: DeployState, processes: readonly Pm2Process[], now: number): string {
  const name = ctx.config.pm2.bot;
  const reading = ctx.host.readStatus(botStatusFile(ctx.layout));
  const status = botOf(reading);
  const head = `bot (${name}, ${shortSha(status?.buildId ?? state.bot.release)})`;
  const word = processWord(findProcess(processes, name));
  if (word !== null) return `${head}: ${word}`;
  const unusable = unusableReason(reading, now);
  if (unusable !== null || status === null) return `${head}: online · ${unusable ?? "not a bot status"}`;
  return `${head}: ${status.state} · ${describeBotActivity(status, now)}`;
}

function siteLine(ctx: Context, state: DeployState, processes: readonly Pm2Process[]): string {
  const name = ctx.config.pm2.site;
  return `site (${name}, ${shortSha(state.site.release)}): ${processWord(findProcess(processes, name)) ?? "online"}`;
}

/** The slots worth a line: any running, and the one state calls live; the live one first. */
function shownSlots(ctx: Context, state: DeployState, processes: readonly Pm2Process[]): readonly string[] {
  const slots = ctx.config.pm2.gameSlots.filter(
    (slot) => isOnline(findProcess(processes, slot)) || slot === state.game.activeSlot,
  );
  return [...slots].sort((a, b) => Number(b === state.game.activeSlot) - Number(a === state.game.activeSlot));
}

function describeAll(ctx: Context, state: DeployState, processes: readonly Pm2Process[]): readonly string[] {
  const now = ctx.host.clock.now();
  const slots = shownSlots(ctx, state, processes);
  const games = slots.length > 0 ? slots.map((slot) => gameLine(ctx, state, processes, slot, now)) : ["game: not running"];
  return [...games, botLine(ctx, state, processes, now), siteLine(ctx, state, processes)];
}

export async function statusLines(ctx: Context): Promise<readonly string[]> {
  return describeAll(ctx, loadState(ctx), await pm2List(ctx));
}

/**
 * Wait until a restart would interrupt nobody: no match going and no rush
 * that could still be handed in on any running slot, and a quiet bot. A slot
 * or bot whose status cannot be read is never quiet. True if it got there.
 */
export async function waitQuiet(ctx: Context, timeoutMinutes: number): Promise<boolean> {
  const { host, config, layout } = ctx;
  const state = loadState(ctx);
  const processes = await pm2List(ctx);
  const slots = config.pm2.gameSlots.filter((slot) => isOnline(findProcess(processes, slot)));
  const botRunning = isOnline(findProcess(processes, config.pm2.bot));
  const quiet = (): boolean => {
    const now = host.clock.now();
    const games = slots.every((slot) => gameQuiet(gameOf(host.readStatus(slotStatusFile(layout, slot))), now));
    const bot = !botRunning || botQuiet(botOf(host.readStatus(botStatusFile(layout))), now, config.botQuietSeconds);
    return games && bot;
  };
  const print = () => describeAll(ctx, state, processes).forEach((line) => host.out(line));
  print();
  const reached = await waitUntil(ctx, quiet, {
    timeoutMs: timeoutMinutes * MINUTE_MS,
    intervalMs: QUIET_POLL_MS,
    progressEveryMs: PROGRESS_EVERY_MS,
    onProgress: print,
  });
  host.out(reached ? "quiet: no duel, no open rush, bot idle" : `not quiet after ${timeoutMinutes} min`);
  return reached;
}
