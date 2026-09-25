#!/usr/bin/env bun
/**
 * Makes synced puzzles playable, and visible to everything downstream.
 *
 *     bun run publish-archive --by <name> [--dry-run] [--db <path>] [--ids 1,2,3 | --all]
 *
 * `sync-archive` writes every row with `published_at` NULL on purpose: the
 * archive's review gate used to be a diff in a pull request, and a database
 * write has no such gate. This is the gate. Nothing a sync brings in reaches a
 * player, or the public API, until somebody runs this.
 *
 * **Publishing moves the daily rotation.** The pool's *length* is what decides
 * which puzzle each future day draws, so adding to it reshuffles every day from
 * tomorrow on. Past days are pinned and do not move. That is why `--all`
 * exists and dripping a few rows at a time is discouraged: one deliberate
 * change beats a churn of small ones.
 *
 * **A restart is what serves them, from here.** The activity lays published
 * rows over `data/puzzles.json` when it starts. Discord's `/archive sync` does
 * not wait for one — it asks the running server to reload in place — but this
 * tool has no key to ask with. Published rows appear in the public API at once.
 *
 * Like `sync-archive`, this never constructs a `Store` — that would run the
 * whole schema and the runs rebuild against a live database.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { archiveCounts, pendingArchive, publishArchive } from "../server/archive-rows";
import { migrateArchive } from "../server/db";

const BUSY_TIMEOUT_MS = Number(process.env.SYNC_BUSY_TIMEOUT_MS ?? 10_000);

interface Options {
  db: string;
  by: string;
  ids: number[] | "all" | null;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    db: process.env.DATABASE_PATH
      ? resolve(process.env.DATABASE_PATH)
      : resolve(import.meta.dir, "../data/daily.sqlite"),
    by: "",
    ids: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") { options.dryRun = true; continue; }
    if (flag === "--all") { options.ids = "all"; continue; }
    const value = argv[i + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--db") options.db = resolve(value);
    else if (flag === "--by") options.by = value;
    else if (flag === "--ids") {
      options.ids = value.split(",").map((part) => {
        const id = Number.parseInt(part.trim(), 10);
        if (!Number.isFinite(id)) throw new Error(`Not a puzzle id: ${part}`);
        return id;
      });
    } else throw new Error(`Unknown flag ${flag}`);
    i += 1;
  }
  // An attribution, not an identity — the same thing `reviewed_by` holds
  // elsewhere. Required because "who made this playable" is the one question
  // the log exists to answer, and a default would answer it wrongly.
  if (!options.by) throw new Error("--by <name> is required: publishing is a decision somebody owns");
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = new Database(options.db, { create: true });
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    migrateArchive(db);

    const pending = pendingArchive(db);
    const before = archiveCounts(db);
    console.log(`${before.published} published, ${before.pending} waiting`);

    if (pending.length === 0) {
      console.log("Nothing to publish.");
      return;
    }

    if (options.ids === null) {
      console.log("\nwaiting:");
      for (const entry of pending) {
        console.log(`  #${entry.puzzle.id} "${entry.puzzle.title}" — ${entry.puzzle.author}`);
      }
      console.log(
        `\nPass --all to publish all ${pending.length}, or --ids 1,2,3 for some of them.\n` +
          "Publishing changes which puzzle every future day draws, so prefer one\n" +
          "deliberate --all over a drip of small batches.",
      );
      return;
    }

    const wanted = options.ids === "all" ? pending.map((e) => e.puzzle.id) : options.ids;
    if (options.dryRun) {
      console.log(`\n--dry-run: would publish ${wanted.length} — ${wanted.join(", ")}`);
      return;
    }

    const published = publishArchive(db, wanted, options.by, Date.now());
    const after = archiveCounts(db);
    console.log(`\npublished ${published.length}: ${published.join(", ") || "none"}`);
    const already = wanted.filter((id) => !published.includes(id));
    if (already.length) {
      console.log(`already published, left alone: ${already.join(", ")}`);
    }
    console.log(`now ${after.published} published, ${after.pending} waiting`);
    console.log(
      "\nThe public API serves these immediately. Players see them when the activity\n" +
        "next starts, or at once after an /archive sync from Discord, which reloads\n" +
        "it in place. The daily rotation has moved, so tomorrow draws differently.",
    );
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
