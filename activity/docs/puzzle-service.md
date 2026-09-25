# The puzzle service

Where puzzle data lives, who may read it, and what has to stay true while it moves.

This is a plan, not a description of what is built. Sections marked **now** are
true today; sections marked **planned** are not built yet.

---

## Why this document exists

There are three copies of the puzzle archive, and they disagree:

| Copy | Rows | Owner |
|---|---|---|
| the Google Sheet | 200 metadata rows, 151 with blueprint codes | the club, edited by hand in Blueprint |
| `activity/data/puzzles.json` (+ `solutions.json`) | 138 | this repository, committed |
| `var/data/puzzles.json` in the website repo | 140 | that repository, committed |

The two committed copies were cut from the sheet at different times and neither
is refreshed by anything automatic. Every new puzzle currently has to be
imported twice, by hand, into two repositories that decode it differently.

**Measured 2026-09-06** by running the existing build against the live sheet
(`bun run tools/build-puzzles.ts --archive <fetched> --out <scratch>`):

- **148 puzzles build**, against 138 committed — so **10 are new**, not the 62
  the row count suggests. The `Puzzles` tab has 200 rows but only 151 carry a
  blueprint code pair; the rest are metadata without a puzzle behind them yet.
- **3 fail to build and are skipped**, as they should be: #13 and #149 have a
  step the router cannot reach, and #58's answer sends no attack, so there is
  nothing to score against.
- **136 of 148 stated goals match the replayed clears.** The other twelve
  disagree, which is what the frozen clear requirement exists to absorb.
- **12 already-published puzzles have changed content since the last build.**
  That is the finding that matters most, and it has its own rule below.

The fix is one service that owns the archive, and two consumers that read it.

**The service lives here, in BaronChairStair.** The production VPS already runs
this repository's activity server; that is the machine with the database, the
Tetris engine, and the deploy story. Standing up a second service in the
website repository would mean a second deploy, a second database and a second
copy of the engine to verify puzzles with.

---

## What "the service" actually is — **planned**

**It is the activity server.** Not a new process.

That server already has the three things a puzzle service needs, and they are
not cheap to reproduce:

- a SQLite database with a migration path (`activity/server/db.ts`),
- an HTTP layer (Hono) already deployed and fronted on the VPS,
- the real TETR.IO engine, which is the only thing that can tell you what a
  puzzle's answer actually *sends*.

A separate process for two hundred rows would add a deploy, a port and a
failure mode, and buy nothing. What changes is where the archive is read
from, not how many programs are running.

## Data flow — **now** vs **planned**

**Now.** A maintainer downloads two tabs of the sheet as CSV into `../tmp`,
runs `bun run puzzles`, and commits the result:

    Sheet ──manual CSV──▶ tools/build-puzzles.ts ──▶ data/puzzles.json
                                (decode + replay)     data/solutions.json
                                                            │ committed
                                                            ▼
                                                  PuzzleArchive.load  (boot)

**Now, as well** — the first half of the planned flow below is built. The sync
writes rows, Discord's `/archive sync` publishes them, and the activity reads
published rows over the JSON at boot and on a reload. The review UI is not the
gate yet; the allowlist on `/archive sync` is. See step 3 under *Order of work*.

**Planned.** The same decode-and-replay step, run against the sheet directly,
writing rows instead of files:

    Sheet ──gviz CSV──▶ tools/sync-archive.ts ──▶ archive_puzzles  (pending)
                          (decode + replay)             │
                                              review UI │ publishes
                                                        ▼
                                              PuzzleArchive.load  (boot)
                                                        │
                                        ┌───────────────┴───────────────┐
                                        ▼                               ▼
                                 the game                     GET /api/archive
                             (withholds answers)            (public, includes
                                                              answers)

`gviz/tq?tqx=out:csv&sheet=<tab>` exports a public sheet tab as CSV with no
credentials, which is what removes the manual download step. Measured
2026-09-06: both tabs return HTTP 200 and 201 lines — a header and 200
puzzles.

---

## The rules this must not break

These are the things that are load-bearing today. Each one has bitten this
project or is one edit away from doing so.

### 1. The game still withholds the answer

Storing solutions publicly and showing them to a player mid-run are different
questions. The club's position is that the answers are already public
elsewhere, so the *service* may serve them — `GET /api/archive` includes the
solution, and the website may render it.

**The run endpoints must not.** A player part-way through today's puzzle must
not be able to fetch the answer from the server that is scoring them.

This is already enforced by the type system, and that is the mechanism to keep:

    export type PuzzlePrompt = Omit<Puzzle, "solution" | "source">;

`Puzzle` carries the answer; `PuzzlePrompt` is the same thing with the answer
and the provenance removed, and it is what the player-facing routes send. The
compiler — not a reviewer's memory — is what stops an answer reaching a player.
Add the archive endpoints as routes that serve `Puzzle`, and leave every
existing route serving `PuzzlePrompt`. Do not "unify" the two types; that
inconsistency is the safety property.

### 2. Every puzzle is engine-verified before it is playable

`tools/build-puzzles.ts` does something irreplaceable: it replays the author's
answer through the real engine to learn what it actually sends, and that number
becomes the puzzle's target. A puzzle whose answer will not replay is skipped,
because a puzzle with no verified target is one nobody can be scored against.

The sync must do exactly this, and must refuse to publish a puzzle that fails
it. A row that reaches the pool unverified is a puzzle that cannot be beaten.

### 3. Something still reviews new puzzles before players see them

Today the review gate is git: a new puzzle arrives as a diff in a tracked JSON
file and a human approves the pull request. A database write has no such gate,
and adding 62 puzzles to the live pool without one is the main risk in this
whole plan.

The replacement: **sync writes rows unpublished**, and the existing review UI
publishes them. Sync is a command somebody runs, not a timer — a cron job that
silently changes what the club plays tomorrow is the thing to avoid.

### 4. Growing the pool reshuffles every future day

The daily rotation is a pure function of the pool's *length*
(`puzzleIndexForDay(day, pool.length, stream)`, `shared/daily.ts`). Going from
138 puzzles to 148 changes which puzzle every future day draws.

Tomorrow's puzzle changes the moment the pool grows, so the pool should grow
**once**, deliberately, rather than a few rows at a time.

### 4b. A puzzle id does not identify a puzzle, and that is allowed

**The club's decision: a creator may go back and edit their own puzzle, so a
published puzzle's content may change.** The sync applies edits. What follows is
what that costs, because a first version of this section overstated it.

`day_puzzles` pins a day to a `puzzle_id` and nothing else:

    CREATE TABLE IF NOT EXISTS day_puzzles (
      day       INTEGER NOT NULL,
      tier      TEXT NOT NULL,
      puzzle_id INTEGER NOT NULL,
      PRIMARY KEY (day, tier)
    );

There is no content snapshot. Rebuilding from the sheet today changes twelve
published puzzles: **#8 is a different puzzle** (board, queue, goal and title —
"fourtris mogs" became "misplaced heart"), **#7 and #109 have different piece
queues**, and the other nine are difficulty ratings and a title typo.

**What an edit does not do.** Existing scores do not change. Every `runs` row
stores the `target_attack` it was judged against (`db.ts:271`), written at
submit and read straight back; no leaderboard or streak query joins a puzzle
table. No rank, time or solved flag moves. The earlier claim here that an edit
"re-files finished scores" was wrong.

**What an edit does do.**

- A finished day's **recap names the wrong puzzle**. `GET /api/recap` resolves
  the pin through the live archive, so it prints the new title, author, goal and
  target above a board of runs played on the old puzzle. This is the one
  user-visible breakage, and it is exactly what `pinPastDays` warns about.
- **Discovered alternate solutions are voided.** A discovered line is a claim
  about a board, and the board has moved. Nothing in the discovery system could
  notice on its own: `puzzle_solutions` is keyed by placements, attack and
  clears with no board in the key, so the rows would keep matching and no code
  path anywhere re-validates them. Left in place they would be shown to makers
  as the evidence for "is my clear requirement too loose?", would inflate the
  line counts on the review Archive tab, and — worst — the unique index on
  `(puzzle_id, canonical_key)` would make the next player to genuinely find one
  of those lines on the *new* board a duplicate, refused credit by `ON CONFLICT
  DO NOTHING`. So the edit deletes them and records how many in the log.
- **The frozen clear requirement can no longer be trusted.** It is a decision
  about the *old* answer. Left attached to a new board it is still enforced, and
  can demand a clear the new answer never makes — a published puzzle nobody can
  solve. So `upsertArchive` checks the incoming answer against it: kept when it
  still holds, dropped and reported when it does not.

Unaffected, and worth saying so: `rush_runs` stores no puzzle reference at all,
`day_rush` pins ids and difficulty and no past rush is ever re-served, and
`puzzle_overrides` and `submissions` cannot be reached by a club-band edit.

**Because overwriting is not recoverable, the previous content is written to
`archive_content_log` first** — values, not fingerprints, in the same
transaction. After the UPDATE that is the only thing in the database that can
say what a finished score was set on. It is append-only for the reason
`puzzle_override_log` is: the write being recorded is the write that destroys
the evidence.

### 5. `PuzzleArchive.load` runs once, at module scope

`activity/server/index.ts:113`. The pool a process serves is the pool it booted
with, and several modules document that they depend on this. Reading the
archive from the database does not change that and must not: a pool that can
change under a running server means a player's run can be scored against a
different puzzle than it started on. **New rows become playable on restart.**

### 6. Dev may read production, but must never write it

Pointing the dev bot at the production archive is the point of the exercise —
one dataset, not two. Reads only. The public read endpoints need no key, which
makes this easy; nothing else about dev should reach production.

---

## Order of work — **planned**

1. ~~**Schema and sync.**~~ **Done.** `archive_puzzles` in `db.ts`, queries in
   `server/archive-rows.ts`, and `bun run sync-archive`. The decode-and-replay
   both tools share came out of `build-puzzles.ts` into
   `tools/decode-archive.ts`, verified by rebuilding the committed files
   byte-for-byte.

   **Rule 4b is answered, and a sync applies edits.** A published puzzle's
   content change is written, its previous content goes to
   `archive_content_log` in the same transaction, and the run reports each
   edited id with its hashes, the runs already filed against it, and any clear
   requirement that had to be dropped. It exits **2** for that; exit 1 means a
   row the sync could not write.

   So running it today **will** move the twelve changed puzzles — #8, #7 and
   #109 among them. That is allowed, and it is not something to discover
   afterwards: the report is printed after the transaction commits, so use
   `--dry-run` first if you want to see the list before it is applied.

   Still inherited from the build and not yet fixed: sheet columns are read
   **by position**, so a column inserted in either tab shifts every field
   silently. Matching on header names is the fix.
2. **Public read endpoints.** Note `/api/archive` and `/api/archive/:id`
   already exist and are **not** these: both sit behind `requireSession`, and
   the detail route gates the answer through `maySeeSolution`. The public,
   key-less, solution-bearing endpoints are new paths beside them, not a
   relaxation of these — relaxing them is precisely rule 1's failure.
3. ~~**The activity reads the table.**~~ **Done.** `PuzzleArchive.load` lays
   published rows over the committed JSON (`withPublished`), which stays the
   seed. Discord's `/archive sync` publishes what it synced and asks the running
   server to reload in place (`server/archive-reload.ts`): new ids go live at
   once, today's deal and rush pool stay pinned, and a changed board is held as
   it was until the next start. Run endpoints unchanged.
4. **Retire the duplicates.** `activity/data/solutions.json`, and the website's
   `var/data/puzzles.json` seed, once the website consumes the endpoint.

Publishing the 62 new puzzles is a step of its own, taken deliberately, after
1–3 are in and reviewed. See rule 4.

---

## Open questions for the club

- **`hide answer`** is a real column on the `blueprint urls` tab. Nobody has
  said what it means for the public endpoint. The decision that solutions are
  safe to publish was made about the archive as a whole; this column looks like
  a per-puzzle intent that predates it, and it should be honoured or explicitly
  retired rather than ignored.
- ~~**Rule 4b**~~ — **answered.** A creator may edit their own puzzle, so edits
  apply. See rule 4b for what that costs and what is recorded.

## Naming

The database already has `puzzle_solutions`, which holds *discovered alternate*
solutions found by players — a different thing entirely from an author's
answer. The new table is `archive_puzzles`, and the author's answer is a column
on it. Nothing here reuses the word `solutions` on its own.
