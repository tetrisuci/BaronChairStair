# The puzzle database — db.tetrisatuci.org

The club's puzzle archive, open to anybody with a browser: every club puzzle the
daily deals from, with its board, its goal and its maker's answer; the puzzles each
finished day dealt; and all of it as one JSON file and one SQLite file to download.
No sign-in, no cookies, and nothing it does can write to the game.

It is a third long-running process in this tree, beside the game and the bot, and
not more routes in the game server. Four reasons, each of which would be lost by
folding it in:

- **It is read-only by construction.** It opens the game's database with SQLite's
  own read-only flag, so a write is refused by SQLite rather than by a rule
  somebody has to remember.
- **Its own builds and restarts never touch the game.** Restarting the game drops
  every live duel; restarting this drops nothing but its own page for a second. Its
  code does live in the game's checkout, though, so a pull that brings the game
  anything is the game's deploy first ([`DEPLOY.md`](DEPLOY.md), rule 1).
- **Strangers' traffic stays off the event loop that verifies runs.**
- **The game needs no routing by hostname.** A second hostname pointed at the
  game's port would also serve the game, `/review`, every `/api` route and the duel
  socket.

How to deploy it is in [`DEPLOY.md`](DEPLOY.md). This file says what it is, what it
promises, and why it is shaped the way it is.

---

## What it serves

| Path | What it is |
|---|---|
| `/` | The archive: the latest finished day first, then every puzzle as a card, with the game's own search and filters |
| `/puzzle/:id` | One puzzle: its board and next pieces, its facts and goal, its answer behind **Show the answer**, and the finished days that dealt it |
| `/days` | Every finished day, newest first, with what each tier dealt |
| `/day/:day` | One finished day, a card per tier |
| `/puzzles.json` | Everything above as one document (shape below) |
| `/puzzles.sqlite` | The same rows as a SQLite file, saved as `tetrisatuci-puzzles.sqlite` |
| `/health` | `{"ok":true,"puzzles":…,"days":…,"throughDay":…,"builtAt":…,"checkedAt":…}`, or `503 {"ok":false,"checkedAt":…}` before the first build. Counts and times only, never an error's text |
| `/assets/*`, `/fonts/*` | The built page's own files: its script, stylesheet and icon, and its fonts with their OFL licence texts and README, which the OFL asks to travel with the fonts |

**Everything else is a 404, and that is a decision.** Every miss gets the same 404
document, byte for byte: a puzzle that is unpublished, written by a player, or never
existed, and a day that is today, in the future or before history, are
indistinguishable, so nobody can ask the server what it is holding back. There is no
catch-all static serving — Hono's static handler serves dotfiles from its root — so
`/.env`, `/index.html` and the build's `petr.png` are as missing as anything else.
A name no file can have under `/assets/` or `/fonts/` — an encoded NUL, or one past
the system's length limit — is a miss too rather than a fault, and so is a page
asked for under a `Host` header no URL can be made of: the same document, and
nothing in the log. Only GET and HEAD are answered, a HEAD with the
`Content-Length` its GET would send; any other method gets `Not found`.

**Each page has one address.** `/puzzle/12`, never `/puzzle/012` or `/puzzle/12/`.
The server writes each page's `<title>`, description and Open Graph tags into the
document, escaped, so a link pasted into Discord unfurls as the puzzle or day it
names; Discord runs no script. The page then takes over in the browser from
`/puzzles.json` and moves between pages without reloading. The browse filter lives
in the query string, so a filtered list is a link: `q` (search), `d=3-7`
(difficulty), `u=0` (hide unrated), `p=5-9` (pieces), `set` and `by` (repeatable),
and `sort=difficulty`, `pieces` or `title`.

**On every response:** a Content-Security-Policy that allows the page's own scripts,
styles, fonts and images and nothing else (`default-src 'none'`, no inline script,
`frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
and `Referrer-Policy: strict-origin-when-cross-origin`. Documents and both downloads
are revalidated every time (`Cache-Control: no-cache`). Each download carries an
`ETag` of its own bytes, so asking again costs a `304` with no body until those
bytes change. Hashed assets are cached for a year, fonts for a week.

**Limits:** 600 requests a minute per caller across everything, and 30 downloads of
the SQLite file. `/puzzles.json` is as large and counts only against the first: the
page fetches it once a visit, and a cap of thirty would lock out a whole campus
arriving from one address. Past either, `429 {"error":"Slow down a moment."}` with
`Retry-After`. A caller is the address the proxy in front names — `Cf-Connecting-Ip`,
else the last `X-Forwarded-For` entry — always, because the process listens on
127.0.0.1 only and every peer it can see is that proxy. There is no CORS:
`/api/public` on the game server stays the club's cross-origin contract.

---

## What it never shows, and what holds each

A promise here is only as good as the test that fails when it breaks, so each line
names one.

| Never shown | What holds it |
|---|---|
| Players, runs, rushes, clears, preferences, player-found lines — any table about a person | The site reads four tables and no others: `archive_puzzles`, `submissions`, `puzzle_overrides` and `day_puzzles`, in `server/snapshot.ts`, the only SQL it runs against the game. `tests/puzzledb-snapshot.test.ts` drops every other table from a copy and builds anyway. |
| Discord ids, usernames, avatar URLs, officers' `discord:<username>` attributions | The allowlist. Everything served is read back out of a fresh in-memory database with three tables and exactly the columns in `PUBLIC_COLUMNS` (`server/public-db.ts`). `tests/puzzledb-public-db.test.ts` and `tests/puzzledb-app.test.ts` plant a value in every personal column of a game database and scan the file's bytes, every cell, the JSON and every route's body for those values, for any run of 17 or more digits, for `discord:` and for avatar URLs. |
| Puzzles players wrote, and their authors' Discord display names | `PUBLISH_COMMUNITY_PUZZLES = false` in `server/policy.ts` (`tests/puzzledb-dataset.test.ts`). A day that dealt one says a player wrote it, and names neither the puzzle nor its id. |
| Today, or any later day | The cut: a day is shown only when it is before both the club's today and the newest day the game has pinned (`FINISHED_DAYS_SQL`, `tests/puzzledb-snapshot.test.ts`). Nothing marks which puzzles are today's, and no rush pool is read. |
| The game's or the bot's secrets | The process refuses to start with any of seven in its environment, and nothing it loads imports the game's `server/config.ts` (`tests/puzzledb-settings.test.ts`, `tests/puzzledb-isolation.test.ts`). |

**Answers are public by the club's decision** — they are already published beside
every puzzle on the club's website — so each one is here, behind **Show the
answer**, which is puzzle manners rather than secrecy. The sheet's "hide answer"
column is read by nothing, here as in the game.

**Required clears are in the data and never on the page.** The game shows them only
under `GOAL_ENFORCEMENT=on`, which is the owner's call, and a page that showed them
would be making it.

---

## How it differs from `/api/public`

Both are public and both are the archive, but they answer different questions.
`/api/public` is the club's published record, and it stays exactly as it is.

| | db.tetrisatuci.org | `/api/public` on the game server |
|---|---|---|
| Which puzzles | What players are dealt: `PuzzleArchive.load` over the same six inputs the game's next boot reads — the committed `data/puzzles.json`, the published synced rows, the accepted player puzzles — with player puzzles then withheld | Published synced rows only; empty on a box nobody has synced |
| Officers' corrections | Applied | Not applied |
| Unpublished rows | Never | Never |
| Blueprint codes | A puzzle's own; else, for a club puzzle, the tracked archive's for the same board, queue, hold and target — only when that row's answer is the one served | The row's own |
| `addedOn`, `solveCount` | Left out: live values exist only for published rows | Included |
| Tier now, piece count, daily history | Included | Not included |
| Freshness | Rebuilt within about 30 s of a change; revalidated on every use (`ETag`, `304`) | Read per request; cached 300 s |
| CORS | None | `*`, GET only |

On a deploy box, which has no `data/solutions.json`, the tracked archive gives
Blueprint links to 134 of the 138 committed puzzles: #7, #8, #109 and #115 have no
tracked row of their shape. Codes are matched by shape and never by id, because
puzzle 8 is a different puzzle in the two files.

---

## The data

`/puzzles.json`, abridged to one puzzle and one day, its Blueprint codes shortened
and the day's deals made up:

```json
{
  "about": { "schema": 1, "builtAt": "2026-10-03T19:00:00.000Z", "firstDay": 245, "throughDay": 275 },
  "puzzles": [
    {
      "id": 15, "title": "protanopia", "author": "satilea", "difficulty": 1, "tier": "easy",
      "goal": "Clear 1 TSD (2 solutions)", "set": "tspins 101",
      "board": ["GGGG...GGG", "GGG.....GG", "GG.......G"],
      "queue": ["S", "Z", "T"], "hold": null, "pieces": 3, "targetAttack": 4,
      "requiredClears": [{ "clear": "tsd", "count": 1 }],
      "solution": [
        { "piece": "Z", "cells": [[5, 0], [4, 0], [4, 1], [3, 1]], "clear": null, "attack": 0 },
        { "piece": "S", "cells": [[7, 2], [8, 2], [8, 3], [9, 3]], "clear": null, "attack": 0 },
        { "piece": "T", "cells": [[6, 0], [7, 1], [6, 1], [5, 1]], "clear": "tsd", "attack": 4 }
      ],
      "source": { "puzzle": "b1@bZRJVRNYGoY2…", "solution": "b1@bZRJVRNYGmPQ…" },
      "puzzleUrl": "https://bp.tali.software/?b1@bZRJVRNYGoY2…",
      "solutionUrl": "https://bp.tali.software/?b1@bZRJVRNYGmPQ…"
    }
  ],
  "days": [
    { "day": 275, "date": "2026-10-02", "deals": [
      { "tier": "easy", "puzzleId": 51 }, { "tier": "medium", "puzzleId": 53 },
      { "tier": "hard", "puzzleId": 7 }, { "tier": "extreme", "puzzleId": 18 } ] }
  ]
}
```

Puzzles come in id order and days in ascending order, each day's deals in daily
order (easy, medium, hard, extreme). A puzzle:

| Field | |
|---|---|
| `id`, `title`, `author`, `goal` | As players see them, corrections applied |
| `difficulty` | The club's rating, or `null` when unrated (the game stores 0) |
| `tier` | The daily tier it is dealt in now |
| `set` | Its set, or `null` |
| `board` | Rows from the floor up, ten characters each: `.` empty, `IJLOSTZ` a piece, `G` garbage |
| `queue`, `hold` | The pieces in order, and the one starting in hold or `null` |
| `pieces` | What a player places: the queue plus the held piece |
| `targetAttack` | The attack a solve must send |
| `requiredClears` | `null` when nobody has decided, `[]` when somebody decided none applies, else `[{clear, count}]` |
| `solution` | The maker's answer as `[{piece, cells, clear, attack}]`, cells `[x, y]` with `y = 0` at the floor; `null` when none is on file |
| `source`, `puzzleUrl`, `solutionUrl` | The Blueprint codes (`source` only when both are known) and viewer links built from them |

A deal's `puzzleId` is `null` when the day dealt a puzzle a player wrote. An id with
no puzzle beside it is a club puzzle that has since left the archive; it keeps its
number, because it was dealt. A past day shows each puzzle **as it is now**, which
may differ from what that day dealt if somebody has edited it since.

`/puzzles.sqlite` holds the same rows in three tables — `puzzles`, `day_puzzles` and
`about` — with `PRAGMA user_version` equal to the schema number, 1. **It documents
itself:** every column's meaning is a comment inside its `CREATE TABLE`, which is
the only place SQLite keeps one, so `.schema` explains the file. The tables are not
`STRICT`, so a `sqlite3` older than 3.37 still opens them, and the file is a plain
rollback-journal database, so opening it read-only leaves nothing beside it.

```sh
sqlite3 -readonly tetrisatuci-puzzles.sqlite .schema
sqlite3 -readonly tetrisatuci-puzzles.sqlite \
  "SELECT id, title, author, difficulty, pieces FROM puzzles WHERE difficulty IS NOT NULL ORDER BY difficulty DESC, pieces LIMIT 10"
```

`about` has four keys: `schema`, `built_at` (when this file was built), `first_day`
(where history starts) and `through_day` (the newest finished day, or NULL). Day 1
is 2026-01-01 on the club's clock, and `date` is that day's calendar date.

It is built fresh, in memory, from those rows, on every change — never a copy of
the game's file. `VACUUM INTO` and `cp` were the obvious alternatives, and neither
redacts anything: each would publish every table the game keeps, players included.

---

## How fresh it is

Every 30 seconds it asks a cheap question: has the game committed anything
(`PRAGMA data_version`), has the database file been replaced (its inode), has
`data/puzzles.json`, the `solutions.json` beside it or the tracked archive changed,
or has the club's day rolled over? Only a yes costs anything: a snapshot read in one
short transaction, hashed, and a rebuild only when the hash moved — most of the
game's commits are runs, which change nothing public. A rebuild that fails keeps the
last good dataset serving, and the reason is logged once, with what to do about it.

Two consequences look odd until you know them:

- **It shows the game's next-boot list.** An accepted puzzle, a correction or a
  pulled `puzzles.json` appears here at the next rebuild, while the game itself
  serves it from its next restart, or sooner when Discord's `/archive sync` reloads
  it (a puzzle whose board changed still waits for the restart).
- **Yesterday appears once something has pinned today.** The game records a day the
  first time anything asks for it — a player, or the bot's recap, which asks every
  five minutes when `PUZZLE_RECAP=on`. Until then the newest finished day is the one
  before.

---

## Running it locally

From `activity/`:

```sh
bun install
bun run dev        # once, so the game creates and migrates data/daily.sqlite; Ctrl-C once it is up
sed "s|^DATABASE_PATH=.*|DATABASE_PATH=$PWD/data/daily.sqlite|" puzzledb/.env.example > puzzledb/.env
bun run build:puzzledb    # the page -> puzzledb/dist/
bun run puzzledb          # http://127.0.0.1:3002/
```

`bun run puzzledb` is `bun --env-file=puzzledb/.env puzzledb/server/main.ts`, and the
site's settings are only those three in [`.env.example`](.env.example). For the
page's own dev server, run `bun run puzzledb:client` beside it: it serves the page
on port 3003 with hot reload and asks the site on 3002 for `/puzzles.json`,
`/puzzles.sqlite` and `/health`.

On macOS, Bun uses Apple's SQLite, which cannot open a write-ahead-log database
read-only unless its `-wal` and `-shm` files are beside it. Starting the game once
puts them there.

The tests run with the rest (`bun test`), or on their own with `bun test puzzledb`.
They build a game database with a planted value in every personal column
(`tests/puzzledb-fixture.ts`) and never open a real one.

---

## Where the decisions live

`server/policy.ts` holds three constants, each the owner's call and listed as such
in the repository's `CLAUDE.md`:

| | |
|---|---|
| `FIRST_TIERED_DAY = 245` | History starts here. Earlier `day_puzzles` rows are the backfill the game wrote for days nobody was dealt tiers |
| `FIRST_EXTREME_DAY = 251` | Days before it show three tiers. An earlier extreme row is a top-up added later, not something anybody was dealt |
| `PUBLISH_COMMUNITY_PUZZLES = false` | Puzzles players wrote, and their Discord display names, stay off the open web |

They are constants rather than settings on purpose. Each decides what strangers can
read about the club's players and its history, and a setting can be flipped on one
box at two in the morning with no review and no release note.

---

## Mounting it in the game later

`createSiteApp` in `server/app.ts` is a self-contained Hono app built from what it
is handed, so the game server could serve it one day. Only by delegating on the
Host header, though:

```ts
if (host === "db.tetrisatuci.org") return siteApp.fetch(c.req.raw, c.env);
```

Never `app.route()`, which merges middleware by path: a probe showed the game's CORS
`*` reaching `/api/session` that way. The site exports no `register*` function, and
`tests/puzzledb-isolation.test.ts` keeps it so. Mounting it also gives up the four
reasons at the top of this file.

---

## The files

| File | What it does |
|---|---|
| `wire.ts` | The JSON's shape, which paths are pages, what each page is called and how a day becomes a date: everything the server and the page must agree on |
| `server/main.ts` | The entry point. Nothing runs at import |
| `server/settings.ts` | The environment, checked once: the refusals, the port, the zone, the owner warning |
| `server/snapshot.ts` | The only SQL run against the game's database |
| `server/policy.ts` | The three decisions above |
| `server/dataset.ts` | One build: what players are dealt, and the days that are over |
| `server/codes.ts` | Blueprint codes from the tracked archive, by shape |
| `server/public-db.ts` | The allowlist: the public schema, the write, the read-back, the download |
| `server/refresher.ts` | The 30-second question, the last good dataset, and the explanations |
| `server/head.ts` | Each page's escaped `<title>` and tags, put in by position |
| `server/app.ts` | HTTP: the routes, headers and limits |
| `client/` | The page. It reuses the game's board, glyphs and answer stepper from `activity/client/src` |
| `vite.config.ts` | Its own build, into `puzzledb/dist/`, never the game's `dist/` |
