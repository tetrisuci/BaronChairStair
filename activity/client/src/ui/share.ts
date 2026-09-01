/**
 * The shareable result.
 *
 * A daily puzzle is only social if the result can be pasted into the channel
 * without spoiling the solve, so this renders the *shape* of the attempt — how
 * far into the piece order the clears landed — and never the placements.
 *
 * The squares are the colours of the pieces that earn them, which is the joke
 * and also what makes the line readable at a glance in a chat window.
 */

import type { ClearName } from "@shared/puzzle";
import { formatDuration } from "./dom";

const CLEAR_MARKS: Readonly<Record<ClearName, string>> = {
  single: "🟩",
  double: "🟩",
  triple: "🟩",
  quad: "🟦",
  tss: "🟪",
  tsd: "🟪",
  tst: "🟪",
  tsmini: "🟫",
  spin: "🟫",
  "perfect clear": "⭐",
};

const EMPTY_MARK = "⬜";

export interface ShareFields {
  readonly day: number;
  readonly puzzleId: number;
  readonly solved: boolean;
  readonly attack: number;
  readonly targetAttack: number;
  readonly durationMs: number;
  readonly resets: number;
  readonly piecesPlaced: number;
  readonly clears: readonly ClearName[];
}

/**
 * Marks are laid out by piece count with the clears bunched at the end, because
 * which piece produced which clear is exactly the part worth not spoiling.
 */
function marks(fields: ShareFields): string {
  const scored = fields.clears.map((clear) => CLEAR_MARKS[clear] ?? EMPTY_MARK);
  const blanks = Math.max(0, fields.piecesPlaced - scored.length);
  return EMPTY_MARK.repeat(blanks) + scored.join("");
}

/** Three short lines: what, how it went, how long. Narrow enough to paste anywhere. */
export function shareText(fields: ShareFields): string {
  const restarts = `${fields.resets} restart${fields.resets === 1 ? "" : "s"}`;
  return [
    `Puzzle #${fields.day} ${fields.solved ? "✅" : "❌"} ${fields.attack}/${fields.targetAttack}`,
    marks(fields),
    `${formatDuration(fields.durationMs)} · ${restarts}`,
  ].join("\n");
}

/**
 * Copies text, falling back to a hidden textarea where the clipboard API is
 * unavailable — which includes some embedded-activity webviews.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy path below.
  }
  try {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.append(scratch);
    scratch.select();
    const copied = document.execCommand("copy");
    scratch.remove();
    return copied;
  } catch {
    return false;
  }
}
