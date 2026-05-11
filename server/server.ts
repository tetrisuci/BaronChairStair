/**
 * teto-python bridge server
 *
 * Reads newline-delimited JSON requests from stdin, runs them through
 * the @haelp/teto engine, and writes newline-delimited JSON responses
 * to stdout. Designed to be spawned and driven by the Python client.
 *
 * Protocol:
 *   Request:  { "id": string, "action": "parse_replay", "replay": "<json string>" }
 *   Response: { "id": string, "status": "ok", "clears": [...] }
 *            |{ "id": string, "status": "error", "message": "..." }
 */

import { createInterface } from "node:readline";
import { Engine, Mino, randomSeed } from "@haelp/teto/engine";
import type { LockRes } from "@haelp/teto/engine";

// ─── Types ────────────────────────────────────────────────────────────────────

type ClearType =
  | "perfectClear"
  | "allspin"
  | "single"
  | "tspinSingle"
  | "double"
  | "tspinDouble"
  | "triple"
  | "tspinTriple"
  | "quad";

interface ClearEvent {
  playerId: string;
  username: string;
  round: number;
  frame: number;
  /** Frame divided by 60 — the in-game clock in seconds */
  timeSeconds: number;
  piece: string;
  clearType: ClearType;
  linesCleared: number;
  garbageCleared: number;
  /** Total attack generated (before cancels) */
  attack: number;
  /** Total attack actually sent (after cancels) */
  attackSent: number;
  isBTB: boolean;
  /** Back-to-back counter at time of clear (-1 = no BTB) */
  b2b: number;
  /** Combo counter at time of clear (-1 = no combo) */
  combo: number;
}

interface ParseResult {
  clears: ClearEvent[];
}

// ─── Clear type detection (ported from minomuncher-core lockResult.ts) ────────

function getClearInfo(
  lockResult: LockRes,
  engine: Engine
): { clearType: ClearType; isBTB: boolean } | null {
  if (lockResult.lines === 0) return null;

  const pc = engine.board.perfectClear;
  const spin = lockResult.spin;
  const lines = lockResult.lines;
  const mino = lockResult.mino;

  if (pc) return { clearType: "perfectClear", isBTB: true };
  if (lines >= 4) return { clearType: "quad", isBTB: true };

  if (lines === 3) {
    if (spin === "none") return { clearType: "triple", isBTB: false };
    if (mino === Mino.T) return { clearType: "tspinTriple", isBTB: true };
    return { clearType: "allspin", isBTB: true };
  }

  if (lines === 2) {
    if (spin === "none") return { clearType: "double", isBTB: false };
    if (mino === Mino.T) return { clearType: "tspinDouble", isBTB: true };
    return { clearType: "allspin", isBTB: true };
  }

  // lines === 1
  if (spin === "none") return { clearType: "single", isBTB: false };
  if (spin === "mini") return { clearType: "allspin", isBTB: true };
  if (mino === Mino.T) return { clearType: "tspinSingle", isBTB: true };
  return { clearType: "allspin", isBTB: true };
}

// ─── Engine config (ported from minomuncher-core engineConfig.ts) ─────────────
// Note: boardheight/boardwidth are intentionally swapped here — this matches
// the original minomuncher source, which preserves a quirk in TETR.IO's
// replay options naming.

function buildEngineConfig(opts: Record<string, any>, opponents: number[]) {
  return {
    board: {
      width: opts.boardheight ?? 10,
      height: opts.boardwidth ?? 20,
      buffer: 20,
    },
    kickTable: opts.kickset ?? "SRS+",
    options: {
      comboTable: opts.combotable ?? "multiplier",
      garbageBlocking: opts.garbageblocking ?? "combo blocking",
      clutch: opts.clutch ?? true,
      garbageTargetBonus: opts.garbagetargetbonus ?? "none",
      spinBonuses: opts.spinbonuses ?? "all-mini+",
      stock: 0,
    },
    queue: {
      minLength: 10,
      seed: opts.seed ?? randomSeed(),
      type: opts.bagtype ?? "7-bag",
    },
    garbage: {
      cap: {
        absolute: opts.garbageabsolutecap ?? 0,
        increase: opts.garbagecapincrease ?? 0,
        max: opts.garbagecapmax ?? 40,
        value: opts.garbagecap ?? 8,
        marginTime: opts.garbagecapmargin ?? 0,
      },
      boardWidth: opts.boardwidth ?? 10,
      garbage: {
        speed: opts.garbagespeed ?? 20,
        holeSize: opts.garbageholesize ?? 1,
      },
      messiness: {
        change: opts.messiness_change ?? 1,
        nosame: opts.messiness_nosame ?? false,
        timeout: opts.messiness_timeout ?? 0,
        within: opts.messiness_inner ?? 0,
        center: opts.messiness_center ?? false,
      },
      multiplier: {
        value: opts.garbagemultiplier ?? 1,
        increase: opts.garbageincrease ?? 0.008,
        marginTime: opts.garbagemargin ?? 10800,
      },
      bombs: opts.usebombs ?? false,
      specialBonus: opts.garbagespecialbonus ?? false,
      openerPhase: opts.openerphase ?? 0,
      seed: opts.seed ?? randomSeed(),
      rounding: opts.roundmode ?? "down",
    },
    gravity: {
      value: opts.g ?? 0.02,
      increase: opts.gincrease ?? 0,
      marginTime: opts.gmargin ?? 0,
    },
    handling: {
      arr: opts.handling?.arr ?? 0,
      das: opts.handling?.das ?? 6,
      dcd: opts.handling?.dcd ?? 0,
      sdf: opts.handling?.sdf ?? 41,
      safelock: opts.handling?.safelock ?? false,
      cancel: opts.handling?.cancel ?? false,
      may20g: opts.handling?.may20g ?? true,
      irs: opts.handling?.irs ?? "tap",
      ihs: opts.handling?.ihs ?? "tap",
    },
    b2b: {
      chaining: !!opts.b2bchaining,
      charging: opts.b2bcharging
        ? { at: 4, base: opts.b2bcharge_base ?? 3 }
        : false,
    },
    pc: {
      b2b: opts.allclear_b2b ?? 0,
      garbage: opts.allclear_garbage ?? 0,
    },
    misc: {
      allowed: {
        hardDrop: opts.allowharddrop ?? true,
        spin180: opts.allow180 ?? true,
        hold: opts.display_hold ?? true,
        undo: false,
        retry: false,
      },
      infiniteHold: opts.infinite_hold ?? false,
      movement: {
        infinite: false,
        lockResets: opts.lockresets ?? 15,
        lockTime: 30,
        may20G: opts.gravitymay20 ?? true,
      },
      stride: false,
      username: opts.username,
    },
    multiplayer: {
      opponents,
      passthrough: opts.passthrough ?? "zero",
    },
  };
}

// ─── Replay unwrapper ─────────────────────────────────────────────────────────

function unwrapReplay(raw: any): any | null {
  let x = raw;
  while (true) {
    if (!("replay" in x)) return null;
    if ("replay" in x.replay) {
      x = x.replay;
    } else {
      return x;
    }
  }
}

// ─── Core parser ─────────────────────────────────────────────────────────────

function parseReplay(replayString: string): ParseResult | { error: string } {
  let raw: any;
  try {
    raw = unwrapReplay(JSON.parse(replayString));
    if (!raw) return { error: "Invalid replay structure — missing 'replay' key" };
  } catch (e) {
    return { error: `JSON parse failed: ${e}` };
  }

  const allClears: ClearEvent[] = [];

  for (let roundIdx = 0; roundIdx < raw.replay.rounds.length; roundIdx++) {
    for (const round of raw.replay.rounds[roundIdx]) {
      // Collect opponent game IDs so the engine can handle passthrough correctly
      const opponents: number[] = [];
      for (const event of round.replay.events) {
        const gameid = event.data?.data?.gameid;
        if (gameid != null && !opponents.includes(gameid)) opponents.push(gameid);
        for (const target of event.data?.data?.targets ?? []) {
          if (!opponents.includes(target)) opponents.push(target);
        }
      }

      const engine = new Engine(buildEngineConfig(round.replay.options, opponents) as any);
      const events = [...round.replay.events];

      engine.events.on("falling.lock", (lockResult: LockRes) => {
        const info = getClearInfo(lockResult, engine);
        if (!info) return;

        allClears.push({
          playerId: round.id,
          username: round.username,
          round: roundIdx,
          frame: engine.frame,
          timeSeconds: Math.round((engine.frame / 60) * 1000) / 1000,
          piece: lockResult.mino,
          clearType: info.clearType,
          linesCleared: lockResult.lines,
          garbageCleared: lockResult.garbageCleared,
          attack: lockResult.rawGarbage.reduce((a, b) => a + b, 0),
          attackSent: lockResult.garbage.reduce((a, b) => a + b, 0),
          isBTB: info.isBTB,
          b2b: lockResult.stats.b2b,
          combo: lockResult.stats.combo,
        });
      });

      // Feed events into the engine frame by frame
      loop: while (events.length > 0) {
        // Advance engine to the next event's frame
        while (engine.frame < events[0].frame) engine.tick([]);

        if (events[0].type === "end") break loop;

        // Batch all events on the same frame
        const batch: any[] = [];
        while (events.length > 0 && events[0].frame === engine.frame) {
          if (events[0].type === "end") break loop;
          batch.push(events.shift());
        }
        engine.tick(batch);
      }

      engine.events.removeAllListeners();
    }
  }

  // Sort by round then frame so multi-round replays are chronological
  allClears.sort((a, b) => a.round - b.round || a.frame - b.frame);

  return { clears: allClears };
}

// ─── NDJSON stdio server loop ─────────────────────────────────────────────────

function respond(obj: object) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = createInterface({ input: process.stdin, terminal: false });

// Signal to the Python client that the server is up and ready
respond({ type: "ready" });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let request: any;
  try {
    request = JSON.parse(trimmed);
  } catch {
    respond({ id: null, status: "error", message: "Request is not valid JSON" });
    continue;
  }

  const { id, action, replay } = request;

  if (action === "parse_replay") {
    if (typeof replay !== "string") {
      respond({ id, status: "error", message: "'replay' must be a JSON string" });
      continue;
    }
    const result = parseReplay(replay);
    if ("error" in result) {
      respond({ id, status: "error", message: result.error });
    } else {
      respond({ id, status: "ok", ...result });
    }
  } else {
    respond({ id, status: "error", message: `Unknown action: ${action}` });
  }
}
