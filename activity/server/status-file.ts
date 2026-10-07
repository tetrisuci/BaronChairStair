/**
 * Writes the game's status file, whole or not at all.
 *
 * The deploy reads this file while the game is writing it, so a write must
 * never be seen half done: the status goes to a temporary file in the same
 * directory and is renamed over the real one, which a reader sees either
 * before or after and never during. Same directory, because a rename is only
 * atomic within one filesystem. The temporary's name carries the pid, so two
 * processes pointed at one path — a mistake, but a possible one — never write
 * into each other's half-finished file.
 *
 * A failure to write is reported once and otherwise ignored. A status file is
 * how the deploy watches the game; it must never be the thing that takes the
 * game down, and a log line every five seconds would bury whatever else the
 * log has to say.
 */

import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { GameStatus } from "../shared/runtime-status";

export interface StatusLog {
  log(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
}

export class StatusFile {
  private readonly temporary: string;
  private failing = false;

  constructor(
    private readonly path: string,
    pid: number,
    private readonly log: StatusLog = console,
  ) {
    this.temporary = join(dirname(path), `.${basename(path)}.${pid}.tmp`);
  }

  /** Replaces the file with this status. Never throws; false if it could not. */
  write(status: GameStatus): boolean {
    try {
      writeFileSync(this.temporary, `${JSON.stringify(status)}\n`);
      renameSync(this.temporary, this.path);
    } catch (error) {
      this.reportFailure(error);
      return false;
    }
    if (this.failing) {
      this.failing = false;
      this.log.log(`[lifecycle] writing the status file again: ${this.path}`);
    }
    return true;
  }

  private reportFailure(error: unknown): void {
    try {
      rmSync(this.temporary, { force: true });
    } catch {
      // Tidying after a failure that is reported just below; a temporary that
      // cannot be removed is the same fault, not a second one to report.
    }
    if (this.failing) return;
    this.failing = true;
    this.log.warn(
      `[lifecycle] could not write the status file ${this.path}; the game carries on, ` +
        "but a deploy cannot see it until this is fixed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}
