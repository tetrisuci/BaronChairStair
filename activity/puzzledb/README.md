# The puzzle database — db.tetrisatuci.org

The club's puzzle archive, and how every finished day of the daily went, open to
anybody with a browser: every club puzzle the daily deals from, with its board, its
goal, its maker's answer and the other lines players have found through it; the
puzzles each finished day dealt, and each Discord server's boards for that day; the
all-time boards; every player who has not chosen to hide, in a table and on a page
of their own; every daily solve, newest first; and all of it as one SQLite file to
download. No sign-in, no cookies, and nothing it does can write to
the game.

The owner's aim is that players play in the Discord activity and look things up
here. Until players prefer the site, the game keeps its own leaderboards, profile and
solutions, and does not link from them to this site: players asked to keep browsing
in the activity. Its only link here is beside the *Hide me* setting.

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
| `/puzzle/:id` | One puzzle: its board and next pieces, its facts and goal, how it went on the finished days that dealt it (hand-ins, solves, solve rate, fastest and median time), its answers behind **Show the answer** (**answers** once players have found more) — the maker's first, then each line players found, as chips over one replay, with the day the line on screen was found beneath it — and the finished days that dealt it. `#answer` opens the maker's; `#lines` scrolls to them and leaves them shut; `#line-N` opens them on line N, or, for a line the puzzle does not have, does what `#lines` does |
| `/days` | Every finished day, newest first, with what each tier dealt |
| `/day/:day` | One finished day: a card per tier, then how it went — each tier's field, the day's board across tiers, each tier's board and the rush board — for every server at once or for one |
| `/leaderboards` | The all-time boards over finished days, top fifty each: rush records, daily solves, current streak, best streak, puzzles cleared and Discoveries |
| `/players` | Every listed player in a table: days solved, best streak, puzzles cleared, lines found and best rush, sorted by any of them, searched by name and narrowed to a server |
| `/player/:key` | One listed player: their totals; each tier's solves of hand-ins, rate, best time and median; a calendar of the finished days; their last thirty days with a hand-in; the listed puzzles they have cleared; and their rushes |
| `/solves` | Every daily solve on a finished day, by every player, newest day first, filtered by tier, server and puzzle. Rush is not here: each day's page has its rush board |
| `/alternates` | Every line players found, across every listed puzzle, in one table: puzzle, difficulty, the day it was found, attack, pieces and clears, sorted by date found, difficulty, puzzle name, puzzle number, attack or pieces, either way. Each row links to its line, `/puzzle/:id#line-N`. The maker's answers are not here |
| `/puzzles.json` | The index every page reads: the puzzles, the days, the listed players and the servers (shape below) |
| `/data/…` | One page's body, for the pages that need more than the index: `/data/day/:day.json`, `/data/puzzle/:id.json`, `/data/player/:key.json`, `/data/leaderboards.json`, `/data/players.json`, `/data/solves.json` and `/data/alternates.json` |
| `/puzzles.sqlite` | Every public row, the boards included, as a SQLite file, saved as `tetrisatuci-puzzles.sqlite` |
| `/health` | `{"ok":true,"puzzles":…,"days":…,"throughDay":…,"builtAt":…,"checkedAt":…}`, or `503 {"ok":false,"checkedAt":…}` before the first build. Counts and times only, never an error's text |
| `/assets/*`, `/fonts/*` | The built page's own files: its script, stylesheet and icon, and its fonts with their OFL licence texts and README, which the OFL asks to travel with the fonts |

**Everything else is a 404, and that is a decision.** Every miss gets the same 404
document, byte for byte: a puzzle that is unpublished, written by a player, or never
existed, a day that is today, in the future or before history, and a player who chose
to hide, a key nobody holds or a key from before a hide, are indistinguishable, so
nobody can ask the server what it is holding back. Under `/data/` a body exists
exactly where its page does, and every other path there gets one JSON document,
`{"error":"Not found"}`, also byte for byte. There is no catch-all static serving —
Hono's static handler serves dotfiles from its root — so `/.env`, `/index.html` and
the build's `petr.png` are as missing as anything else. A name no file can have under
`/assets/` or `/fonts/` — an encoded NUL, or one past the system's length limit — is
a miss too rather than a fault, and so is a page asked for under a `Host` header no
URL can be made of: the same document, and nothing in the log. Only GET and HEAD are
answered, a HEAD with the `Content-Length` its GET would send; any other method gets
`Not found`.

**Each page has one address.** `/puzzle/12`, never `/puzzle/012` or `/puzzle/12/`; a
player is `/player/` and their ten-character key, lower case. The server writes each
page's `<title>`, description and Open Graph tags into the document, escaped, so a
link pasted into Discord unfurls as the puzzle, day or player it names; Discord runs
no script. The page then takes over in the browser from `/puzzles.json` and moves
between pages without reloading. Filters live in the query string, so a filtered view
is a link, and the server sends the same document whatever the query string says. On
`/leaderboards` and `/day/:day`, `?server=<key>` picks one server's boards; a key the
site does not list reads as every server. On `/`: `q` (search), `d=3-7`
(difficulty), `u=0` (hide unrated), `p=5-9` (pieces), `set` and `by` (repeatable),
and `sort=difficulty`, `pieces` or `title`. On `/players`: `sort=streak`, `cleared`,
`lines` or `rush` (days solved is the default), `q` and `server`. On `/solves`:
`tier=easy`, `medium`, `hard` or `extreme`, `server`, and `puzzle=<id>`. On
`/alternates`: `sort=difficulty`, `title`, `number`, `attack` or `pieces` (date found
is the default) and `dir=asc` or `desc`, left out while it is the sort's natural
direction — newest, hardest, most attack and fewest pieces first, names and numbers
from the top — in the same rule the activity's own list of alternates reads
(`shared/alternate-sort.ts`). **Junk reads as "all", never as an empty list**: an unknown sort is the default, a server no
listed row names is every server, and a puzzle the site does not list, or one no
finished day dealt, is every puzzle.

**On every response:** a Content-Security-Policy that allows the page's own scripts,
styles, fonts and images and nothing else (`default-src 'none'`, no inline script,
`frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
and `Referrer-Policy: strict-origin-when-cross-origin`. Documents, bodies and both
downloads are revalidated every time (`Cache-Control: no-cache`). Each body and each
download carries an `ETag` of its own bytes, so asking again costs a `304` with no
body until those bytes change. Hashed assets are cached for a year, fonts for a week.

**Limits:** 600 requests a minute per caller across everything, and 30 downloads of
the SQLite file. `/puzzles.json` and the bodies count only against the first. A visit
reads the index once, then one body for each page it opens that needs one, and keeps
each body for the rest of the visit; a cap of thirty would lock out a whole campus
arriving from one address. The solves feed reads day bodies seven at a time, and at
most twenty-eight before it stops and offers *Show older days*, through the same
per-visit copy, so a day it has read costs nothing again. Past either limit,
`429 {"error":"Slow down a moment."}` with `Retry-After`. A caller is the address
the proxy in front names — `Cf-Connecting-Ip`, else the last `X-Forwarded-For`
entry — always, because the process listens on
127.0.0.1 only and every peer it can see is that proxy. There is no CORS:
`/api/public` on the game server stays the club's cross-origin contract.

---

## Players, and what the site says about them

Until beta 0.13 the site named nobody. Leaderboards, players' pages and players' own
lines are rows in exactly the tables it used to leave alone, so it now reads them —
through an explicit list of columns, deciding in SQL who may be named.

**A player appears by the Discord username the game shows**, as it was at their last
sign-in to the activity. Never an avatar, whose URL embeds the Discord id, and never
an id. Their page's address is a key: ten characters from
`23456789abcdefghjkmnpqrstuvwxyz`, drawn at random by the game once
(`server/site-identity.ts`) and never changed. The game draws it, not the site,
because the site holds no secret to derive one with, and so that the game can link a
player to their own page if it links to the site again.

**Listed** means a player who has not hidden and has something before today: a daily
hand-in, a solved daily, a rush, a cleared puzzle or a credited line. A listed player
is on `/players`, has a page, and is named on every board.

**"Hide me on db.tetrisatuci.org"** is a switch in the activity's Settings, under
*On the web*. The game keeps it as `players.site_hidden` rather than in the player's
preferences, because every path that writes preferences rebuilds them from the
fields it knows, the client's copy wins on load, and Reset replaces them — any of
which would quietly un-hide somebody. The site treats a player as hidden when:

- they chose to hide;
- they are the guest, which names nobody;
- the game has not given them a key yet — a player older game code inserted after a
  rollback, until this code's next start keys them;
- their username holds seventeen digits in a row, which is what a Discord id looks
  like.

That rule is written once, in SQL (`SHOWN` in `server/snapshot-players.ts`), so a
hidden player's name and key are never even a value in the site's memory: every row
of theirs arrives unlabelled, and every total of theirs is summed inside SQLite. A player
who never touched the switch is shown, because the owner chose an opt-out, and there
was no notice period: player data is published from the site's first build on a
database the game has migrated.

**A change reaches the site within about a minute, either way.** Flipping the switch
is a commit to the game's database, so the site's next 30-second check sees
`PRAGMA data_version` move; `site_hidden` is one of the columns it reads, so the
snapshot's hash changes and the site rebuilds.

### The table, the pages and the feed

**The players table** is the index's names joined by key to `/data/players.json`,
which carries keys and numbers and never a name, so one page can never show one
person under two names from two builds. Its numbers are totals across every server,
as the game keeps them. A server chip only narrows who is listed: a player is listed
under every server they handed in or rushed in on a finished day, and the caption
says the totals count every server. Every sort puts the most first, best rush by
most solved and then fastest, and a tie goes by name, case-folded, then by key.

**A player's page** has three panels beside the totals, recent days and rushes:

- **By tier**: for each of the four tiers, solves of hand-ins, the rate, the fastest
  solve with the earliest day it was set on, and the median. The build works these
  out from the same rows `tier_boards` holds, so the download can reproduce every
  number.
- **Calendar**: a month for each calendar month that holds a finished day, newest
  first, six and then the rest on request. Each finished day is a cell, shaded by how
  many of the tiers that day dealt the player solved. Its range is the index's days,
  so today is never a cell.
- **Puzzles cleared**: the listed puzzles they have cleared, in any mode, in id
  order. A puzzle the site does not list still counts in *Puzzles cleared* and is not
  on the list, so the list can be shorter than the count, and the page says by how
  many.

*Lines found* links to the Discoveries board, never to the lines, which name no
finder.

**The solves feed** is daily solves only. It is steered by `/data/solves.json` —
each finished day with a solve, its solves per tier and the servers they were in —
and carried by the day bodies themselves, so each row is a day body's row and adds
nothing to it. A filter skips, without fetching them, the days that cannot match: by
the steering's counts and servers, and for a puzzle by the days the index says dealt
it. A row's rank is the one the day's page prints under the same server chip, a tie
shared, so the two never disagree about who was second.

### What a player who hid leaves behind

Said plainly, because the setting's promise is only as good as its limits:

- **Their results stay, as "a player".** Every row they earned stays on its board
  with the value and the rank it earned: tier, day and rush boards, the all-time
  boards, Discoveries, and a puzzle's fastest solve. That is the owner's decision —
  taking them out would re-rank everyone else.
- **Those rows are hard to join up.** They carry no id and no key. Ties are ordered
  by published columns only, never by anything SQLite chose, so the order of two
  hidden rows says nothing about who joined Discord first. On the all-time boards a
  hidden row has no `detail`, the second number a shown row carries, so two of their
  rows cannot be matched by it. Nothing on a hidden row is there to tie it to
  another, though the values themselves can coincide, and the server can tie them
  (below).
- **No cleared list, anywhere, ever.** One unlabelled number cannot be traced to
  anybody, but the whole set of puzzles someone has cleared is as good as their name
  to anyone who has seen it once. So a hidden player's clears are counted and never
  listed: SQL lets only a shown player's list out (`CLEARED_PUZZLES_SQL`), and
  `player_clears` has no row of theirs.
- **The players table and the feed.** They have no row in the table, and searching
  for their name finds nobody. In the feed their solves are there as "a player", with
  no link and the server and rank they earned: each is a day body's row, the same row
  the day's page shows. `/data/solves.json` holds counts and server keys only, and is
  the same bytes whether they hid or not.
- **What can still single them out:**
  - **The server.** Per-server rows carry `server_key`, and so do the feed's. In a
    server where only one player hid, every "a player" row of that server is that
    person.
  - **The game.** Its own boards still show the same numbers under their name, to
    anyone signed in to the activity in any server. The switch hides a player on this
    site only.
  - **Copies.** From the site's first build until a player hides, their results are
    public, and the download makes a copy in one click. A hide reaches the site; it
    never reaches a copy somebody already saved, nor whatever a search engine or a
    Discord unfurl took from a page whose title was their name.
  - **Their key does not change.** A link to their page is the site's 404 while they
    are hidden, and answers again if they show themselves later.

### Lines, who found them, and when

Every line players found is public, on its puzzle's page and on `/alternates`,
**with no finder**: no name and no key. **It carries the day it was found, and never
the time.** A line's `position` is publication order — by the day it was filed, then
the order it was filed in — and `day` is the game's day it was filed on, a day number
like every other on the site, worked out inside SQL from a time that never leaves it.

Until schema 3 the site published no day either. The owner reversed that so lines can
be sorted by when they were found: a list of every alternate across the archive, by
date, is the thing players asked for, and a day is all a date sort needs. A time is
not: the millisecond the game stores would pick one finder out of everybody who
played that day, so it stays where it was, used only to work out the day and to cut
at the game's midnight. A line found before the site's history starts keeps its true
day rather than being shown as the first. The lines shown
are the ones the game credits: a line a player actually played that solved the
puzzle or sent more than it asked for, not voided by an edit to the puzzle, filed
before today, on a puzzle the site lists. A line that met the target attack and
missed the goal's named clears is never shown, and neither is whether a line met
them (`solved_strict`), which would give away required clears.

This ends, on the site, what beta 0.3 promised — "Puzzles you have not solved keep
their answers to themselves" — and beta 0.13's release note says so. Inside the game
nothing changed: a puzzle's solutions open once you have solved it.

**The owner accepts that a finder can sometimes be worked out.** The Discoveries board
and each player's lines-found count are published, so a reader can match a tier
board row's attack to a line's on a puzzle dealt that day, notice a day on which only
one player reached the target, or compare two downloads and see a new line appear as
one player's count goes up. The line's day makes the second of these direct: a line
found on a day on which only one player solved that puzzle points at that player.
The owner accepted this when choosing to publish the day. The site does not try to
prevent any of it.

**The counts can add up to more than the lines.** Discoveries counts as the game
counts — every credited line, voided ones included, on any puzzle, a puzzle a player
wrote or one no longer listed among them — less the lines filed today. Only the
lines on listed puzzles, live, are shown.

### Servers

A server is named by what Discord called it at a player's last sign-in from there.
The activity's sign-in already asks Discord for the player's servers, so this costs
no new permission, and the bot is not in every server that has a board. A server
shows as **Unnamed server**, with the first four characters of its key to tell two
apart, when nobody has signed in from it since names were first kept, when its name
holds seventeen digits in a row, or when the owner has put its key on
`HIDDEN_SERVER_KEYS` (*Where the decisions live*). A reader cannot tell which. Only
servers some published row names are listed.

As in the game, the day, tier and rush boards and the rush records are per server;
daily solves, streaks, puzzles cleared and Discoveries are the club's as one. A
hand-in made outside any server the game knows is on the every-server boards only.

---

## What it never shows, and what holds each

A promise here is only as good as the test that fails when it breaks, so each line
names one.

| Never shown | What holds it |
|---|---|
| Discord ids, guild ids, avatar URLs, preferences, input logs, officers' `discord:<username>` attributions | The allowlist, at both ends. The site reads the game's player tables only through `server/snapshot-players.ts`, which names every column it touches; `tests/puzzledb-snapshot.test.ts` builds the very same bytes from a copy stripped to those columns, fails if one of them is not needed, and bans `SELECT *`. The players table, the profile panels and the feed added one column to that list, `puzzle_clears.puzzle_id`; everything else they show is built from rows already published. Everything served is read back out of a fresh in-memory database whose tables and columns are exactly `PUBLIC_COLUMNS` (`server/public-db.ts`, with `server/public-db-players.ts`). `tests/puzzledb-public-db.test.ts`, `tests/puzzledb-app.test.ts` and `tests/puzzledb-app-profiles.test.ts` plant a value in every personal column of a game database and scan the file's bytes, every cell, the index, every body and every route for them, for any run of 17 or more digits, for `discord:` and for avatar URLs — and check that the shown players' names and keys *are* there, so a scan that found nothing because nothing was published cannot pass. |
| A hidden player's name, key, page or cleared list | `SHOWN`, in SQL. `tests/puzzledb-hidden-trace.test.ts` builds twice, differing only in one player's choice, and checks that the hidden build holds them in no byte, gives them no entry and no body, leaves their rows unlabelled and every other row as it was, takes exactly their row out of the players table, moves no byte of `/data/solves.json` or of `/data/alternates.json`, lists their clears nowhere, and orders tied rows the same whoever holds the lowest Discord id. `tests/puzzledb-snapshot.test.ts` scans what the snapshot read for them before anything is built. |
| Who found a line, or the time it was found | `found_by` and `found_at` are used inside SQL and never selected; the day is worked out of `found_at` there (`LINE_DAY`) and is the only thing about when that leaves it. No public table has a column for either (`tests/puzzledb-snapshot-players.test.ts`, *the lines*, pins a line's keys; the allowlist). The fixture plants every line's exact `found_at`, and `tests/puzzledb-public-db.test.ts`, `tests/puzzledb-app.test.ts` and `tests/puzzledb-app-alternates.test.ts` scan every byte served for it, each beside a positive control that the line's day is there — in the download's `lines` table, on the line's puzzle page and in `/data/alternates.json` — and `tests/puzzledb-agreement.test.ts` checks that day against the game's own calendar for every line. |
| Puzzles players wrote, and their authors' Discord display names | `PUBLISH_COMMUNITY_PUZZLES = false` in `server/policy.ts` (`tests/puzzledb-dataset.test.ts`). A day that dealt one says a player wrote it, and names neither the puzzle nor its id; a board row for it keeps its tier and loses the id; it has no stats and no lines. |
| Today, or any later day | The cut: a day is shown only when it is before both the club's today and the newest day the game has pinned (`FINISHED_DAYS_SQL`), and every player read is cut at the same day (`tests/puzzledb-snapshot.test.ts`, *finished days only* and *reads nothing filed today*; `tests/puzzledb-snapshot-players.test.ts`, *the cut*). Nothing marks which puzzles are today's, and no rush pool is read. |
| A server the owner listed, by name | `HIDDEN_SERVER_KEYS` in `server/policy.ts`, applied in the build (`tests/puzzledb-public-db.test.ts`, *the server hide list*; `tests/puzzledb-policy.test.ts` refuses an entry not shaped like a key, which would hide nothing). |
| The game's or the bot's secrets | The process refuses to start with any of seven in its environment, and nothing it loads imports the game's `server/config.ts` or its database code (`tests/puzzledb-settings.test.ts`, `tests/puzzledb-isolation.test.ts`). |

**The boards are the game's boards.** `tests/puzzledb-agreement.test.ts` builds the
site over a game database and compares every board with what the game's own `Store`
answers for it — day, tier and rush boards in every scope, rush records, daily
solves, streaks, Discoveries, each shown player's cleared puzzles (less those the
site does not list) and the solutions gallery — less today. Rows tied on
everything the game ranks by are compared as sets, because the game breaks such ties
by things the site never publishes.

**Answers are public by the club's decision** — they are already published beside
every puzzle on the club's website — so each one is here, behind **Show the
answer**, which is puzzle manners rather than secrecy. The sheet's "hide answer"
column is read by nothing, here as in the game. Players' lines sit behind the same
press.

**Required clears are in the data and never on the page.** The game shows them only
under `GOAL_ENFORCEMENT=on`, which is the owner's call, and a page that showed them
would be making it.

---

## Today, view by view

`cut` is the first day not shown: the earlier of the club's today and the newest day
the game has pinned. Two of the columns cut are milliseconds with no day beside them
— when a line was filed, when a puzzle was first cleared — and those are cut at the
midnight that starts `cut` **in the game's zone**. The game writes its zone into its
own database, `site_facts('time_zone')`, every time it starts, because this site's
`DAILY_RESET_TIMEZONE` may differ from the game's, and a midnight taken in the wrong
zone could publish an hour of today. The game's midnight alone is enough: `cut` is
never past the game's own today, so its midnight can only hold data back.

| What | Shown when |
|---|---|
| Tier, day and rush boards; a player's hand-ins and rushes | from the first tiered day up to `cut` |
| Rush records | any day before `cut` (the game's own board includes today) |
| Days solved, daily solves, streaks | solved days before `cut`, days of the single legacy puzzle included. A current streak counts only if it reaches the newest finished day, so it reads one lower than the game for a player who has already solved today |
| Puzzles cleared, and a player's cleared list | first cleared before the game's midnight starting `cut`, in any mode; the list also only puzzles the site lists |
| Lines, Discoveries and lines found | filed before that midnight |
| A puzzle's stats | daily hand-ins on finished days, in the tiers each day dealt |
| A player's tier summaries | their tier-board rows: finished days, in the tiers each day dealt |
| A player's calendar | the index's days, so never today, a later day or a day before history |
| A players-table row's servers | servers of hand-ins and rushes on finished days |
| The solves feed and its steering | the tier boards' solved rows, so finished days only; the puzzle filter offers only puzzles a finished day dealt. No rush |
| Rush pools | never read |

**A puzzle is never held back because it is today's deal.** Every line a player
files comes from the daily, on the day its puzzle was dealt, so cutting by the day a
line was filed removes exactly today's answers and never makes an old line vanish.
Nothing says a puzzle has lines not yet shown, because the only such lines are
today's, and saying so would mark today's deal. For the same reason a cleared list
never marks today: a puzzle on it was cleared before the newest finished day ended,
which says nothing about whether it is today's deal.

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
| Boards, players, players' lines | Finished days | Not included |
| Freshness | Rebuilt within about 30 s of a change; revalidated on every use (`ETag`, `304`) | Read per request; cached 300 s |
| CORS | None | `*`, GET only |

On a deploy box, which has no `data/solutions.json`, the tracked archive gives
Blueprint links to 134 of the 138 committed puzzles: #7, #8, #109 and #115 have no
tracked row of their shape. Codes are matched by shape and never by id, because
puzzle 8 is a different puzzle in the two files.

---

## The data

`/puzzles.json`, abridged to one puzzle, one day, one player and one server, its
Blueprint codes shortened and the day's deals, the player and the server made up:

```json
{
  "about": { "schema": 3, "builtAt": "2026-10-03T19:00:00.000Z", "firstDay": 247, "throughDay": 275 },
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
  ],
  "players": [{ "key": "7k2mq9xa4b", "name": "ada", "daysSolved": 41, "bestStreak": 21 }],
  "servers": [{ "key": "r8hn3cw2pe", "name": "Tetris at UCI" }]
}
```

Puzzles come in id order and days in ascending order, each day's deals in daily
order (easy, medium, hard, extreme). Players are sorted by name, and servers by name
with the unnamed last. A puzzle:

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
may differ from what that day dealt if somebody has edited it since. A server's
`name` is `null` when it renders "Unnamed server".

**The bodies** are cut from the same public database as the download, so a body can
say nothing the file does not, and every one carries the `builtAt` of the build it
came from. Their shapes are in [`wire.ts`](wire.ts) and
[`wire-profiles.ts`](wire-profiles.ts) and [`wire-alternates.ts`](wire-alternates.ts). Whose row it is, on every board, is
`{ "key", "name" }` or `null` — "a player" — and nothing else; the players table's
rows carry a `key` alone, and take the name from the index.

| Path | What it holds |
|---|---|
| `/data/day/:day.json` | The day's boards across tiers, keyed `all` and by each server that played; every tier's hand-ins, with server, puzzle, time and attack; the rush board |
| `/data/puzzle/:id.json` | `stats` (`null` when no finished day dealt it) and `lines`: each line's position, the day it was found, attack, clears and placements |
| `/data/player/:key.json` | Totals, then every daily hand-in (newest first, with its rank on that tier as the day's board shows it, a tie shared) and every rush, ranked the same way; `tiers`, always four in the daily's order, each with `handIns`, `solves`, `bestMs`, `bestDay` and `medianMs`; and `cleared`, the listed puzzles they have cleared, ascending |
| `/data/leaderboards.json` | The six all-time boards, each keyed `all`, and rush also by server |
| `/data/players.json` | `rows`, one per listed player in the index's order: `key`, `puzzlesCleared`, `linesFound`, `rushBest`, `rushBestMs`, and `servers`, the keys of the servers they handed in or rushed in on a finished day. No name: the index has it |
| `/data/solves.json` | `days`, each finished day with a daily solve, newest first: `day`, `tiers` (solves per tier, "a player"'s included) and `servers` (the keys of the servers with a solve that day). The solves themselves are the day bodies' |
| `/data/alternates.json` | `lines`, every published line by puzzle then position: `puzzleId`, `position`, `day`, `attack`, `pieces` (its placements counted) and `clears`. No placements: each puzzle's own body has them. The page sorts |

**No body is one giant list of history.** A day body is the same bytes however long
history grows, and the players table is one row a player. `/data/solves.json` grows
by one short line for each finished day with a solve: over a synthetic year of a
forty-player club, three servers and four tiers a day, about 118 bytes a day and
43 KB in all, and `tests/puzzledb-profile-bodies.test.ts` fails it past 160 bytes a
day. A player's own body still grows with their hand-ins, as it did before.
`/data/alternates.json` is the one body that lists history row by row, because a
sort needs every line at once: it grows by one row per line found, 80 to 100 bytes
before compression, and `tests/puzzledb-players-dataset.test.ts` fails it past 120
bytes a line.

`/puzzles.sqlite` holds twelve tables, with `PRAGMA user_version` equal to the schema
number, 3 (2 had no `lines.day`):

| Table | |
|---|---|
| `puzzles`, `day_puzzles`, `about` | The archive and the days, as in schema 1 |
| `servers` | Each server's key and name |
| `players` | The listed players and their totals |
| `player_clears` | Which listed puzzles each listed player has cleared: `player_key` and `puzzle_id`, and never when, how often or how fast. A player who hid has no rows |
| `tier_boards`, `day_boards`, `rush_boards` | Every finished day's boards |
| `standings` | The all-time boards, top fifty each |
| `puzzle_stats` | How each listed puzzle went |
| `lines` | Players' lines, with no finder: each with the day it was found, never the time |

**It documents itself:** every column's meaning is a comment inside its
`CREATE TABLE`, which is the only place SQLite keeps one, so `.schema` explains the
file. A stored `rank` is a row's place on its board, unique so it can be part of the
key. Rows tied on the board's own numbers are ordered by name and then by their other
columns, so their stored ranks differ; the page shows them an equal rank, and a reader
of the file should compare those numbers to do the same — `value` and `time_ms` on
`standings`, `solved` and `time_ms` on the day and rush boards, and on `tier_boards`
`solved` and `time_ms`, then `attack` for a miss. The tables are not `STRICT`, so a `sqlite3` older than 3.37 still
opens them, and the file is a plain rollback-journal database, so opening it
read-only leaves nothing beside it.

```sh
sqlite3 -readonly tetrisatuci-puzzles.sqlite .schema
sqlite3 -readonly tetrisatuci-puzzles.sqlite \
  "SELECT id, title, author, difficulty, pieces FROM puzzles WHERE difficulty IS NOT NULL ORDER BY difficulty DESC, pieces LIMIT 10"
sqlite3 -readonly tetrisatuci-puzzles.sqlite \
  "SELECT s.rank, coalesce(p.name, 'a player'), s.value FROM standings s LEFT JOIN players p ON p.key = s.player_key WHERE s.board = 'dailies' AND s.scope = 'all' ORDER BY s.rank LIMIT 10"
sqlite3 -readonly tetrisatuci-puzzles.sqlite \
  "SELECT z.id, z.title, COUNT(c.player_key) AS cleared_by FROM puzzles z LEFT JOIN player_clears c ON c.puzzle_id = z.id GROUP BY z.id ORDER BY cleared_by, z.id LIMIT 10"
```

That last one counts listed players only: a player who hid has cleared puzzles too,
and they are in no row of `player_clears`.

`about` has four keys: `schema`, `built_at` (when this file was built), `first_day`
(where history starts) and `through_day` (the newest finished day, or NULL). Day 1
is 2026-01-01 on the club's clock, and `date` is that day's calendar date.

It is built fresh, in memory, from those rows, on every change — never a copy of
the game's file. `VACUUM INTO` and `cp` were the obvious alternatives, and neither
redacts anything: each would publish every table the game keeps, every player's
Discord id included.

---

## How fresh it is

Every 30 seconds it asks a cheap question: has the game committed anything
(`PRAGMA data_version`), has the database file been replaced (its inode), has
`data/puzzles.json`, the `solutions.json` beside it or the tracked archive changed,
or has the club's day rolled over? Only a yes costs anything: a snapshot read in one
short transaction, hashed, and a rebuild only when the hash moved — most of the
game's commits are today's runs, which change nothing public until the day is over.
A hide does change something public, so it lands at the next check. A rebuild that
fails keeps the last good dataset serving, and the reason is logged once, with what
to do about it.

Two consequences look odd until you know them:

- **It shows the game's next-boot list.** An accepted puzzle, a correction or a
  pulled `puzzles.json` appears here at the next rebuild, while the game itself
  serves it from its next restart, or sooner when Discord's `/archive sync` reloads
  it (a puzzle whose board changed still waits for the restart).
- **Yesterday appears once something has pinned today** — its deals, its boards and
  the lines filed on it alike. The game records a day the first time anything asks
  for it — a player, or the bot's recap, which asks every five minutes when
  `PUZZLE_RECAP=on`. Until then the newest finished day is the one before.

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

`bun run dev` matters for more than creating the file: the site reads the game's zone
from `site_facts`, which the game writes when it starts, and refuses to build without
it. `bun run puzzledb` is `bun --env-file=puzzledb/.env puzzledb/server/main.ts`, and
the site's settings are only those three in [`.env.example`](.env.example). For the
page's own dev server, run `bun run puzzledb:client` beside it: it serves the page
on port 3003 with hot reload and asks the site on 3002 for `/puzzles.json`,
`/puzzles.sqlite`, `/health` and every page's body under `/data/…`.

On macOS, Bun uses Apple's SQLite, which cannot open a write-ahead-log database
read-only unless its `-wal` and `-shm` files are beside it. Starting the game once
puts them there.

The tests run with the rest (`bun test`), or on their own with `bun test puzzledb`.
They build a game database with a planted value in every personal column
(`tests/puzzledb-fixture.ts`) — a hidden player, a name holding a Discord-shaped
number, a server on the hide list, and rows filed just after midnight among them —
and never open a real one.

---

## Where the decisions live

`server/policy.ts` holds four constants, each the owner's call and listed as such in
the repository's `CLAUDE.md`:

| | |
|---|---|
| `FIRST_TIERED_DAY = 247` | History starts here. Earlier `day_puzzles` rows are the backfill the game wrote for days nobody was dealt tiers |
| `FIRST_EXTREME_DAY = 252` | Days before it show three tiers. An earlier extreme row is a top-up added later, not something anybody was dealt |
| `PUBLISH_COMMUNITY_PUZZLES = false` | Puzzles players wrote, and their Discord display names, stay off the open web |
| `HIDDEN_SERVER_KEYS`, empty | Servers whose name the site never prints, by key — the ten characters after `?server=` in the site's own links. A listed server keeps its boards and shows as "Unnamed server" |

They are constants rather than settings on purpose. Each decides what strangers can
read about the club's players and its history, and a setting can be flipped on one
box at two in the morning with no review and no release note.

Whether a *player* is shown is not the site's decision at all. It is the player's,
made in the activity's settings, and nobody else's to make for them.

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
| `wire.ts` | The JSON's shapes, the index's and the bodies', which paths are pages, what each page is called and how a day becomes a date: everything the server and the page must agree on |
| `wire-profiles.ts` | The players table's and the solves feed's body shapes, types only, beside `wire.ts` for length |
| `wire-alternates.ts` | The alternates table's body shape, types only, likewise |
| `server/main.ts` | The entry point. Nothing runs at import |
| `server/settings.ts` | The environment, checked once: the refusals, the port, the zone, the owner warning |
| `server/snapshot.ts` | The one transaction against the game's database, and the puzzle and day reads |
| `server/snapshot-players.ts` | The only SQL run against the game's player tables: the column list, who may be named, the cut |
| `server/policy.ts` | The four decisions above |
| `server/dataset.ts` | One build: what players are dealt, and the days that are over |
| `server/dataset-players.ts` | The boards, standings, stats, lines and cleared lists a build publishes, and the guards that repeat the SQL's rules |
| `server/rank.ts` | The order of a board's rows, over published columns only |
| `server/codes.ts` | Blueprint codes from the tracked archive, by shape |
| `server/public-db.ts`, `server/public-db-players.ts` | The allowlist: the public schema, the write, the read-back, the download |
| `server/bodies.ts` | The `/data/…` bodies, cut from the read-back database |
| `server/bodies-profiles.ts` | Each player's tier summaries, the players table's body and the feed's steering body, from the same read-back rows |
| `server/bodies-alternates.ts` | The alternates table's body: every published line, without its placements, from the same read-back rows |
| `server/refresher.ts` | The 30-second question, the last good dataset, and the explanations |
| `server/head.ts` | Each page's escaped `<title>` and tags, put in by position |
| `server/app.ts` | HTTP: the routes, headers and limits |
| `client/` | The page. It reuses the game's board, glyphs and answer stepper from `activity/client/src`, and draws its own board rows: the game's key rows on Discord ids and draw avatars |
| `client/players.ts` | The players table: the index's names joined to the body's numbers, the sort, the search and the server chips |
| `client/player-view.ts`, `client/profile-panels.ts` | A player's page; the second holds its *By tier*, *Calendar* and *Puzzles cleared* panels |
| `client/solves.ts`, `client/solves-rows.ts` | The feed: which days a filter can match, read seven at a time; and a day's solves, ranked as the day's page ranks them |
| `client/alternates.ts` | The alternates table: every line, ordered by `shared/alternate-sort.ts` as the activity orders its own, each row linked to its line's chip |
| `client/list-queries.ts` | The players table's, the feed's and the alternates table's choices in the query string, junk read as "all" |
| `client/profiles.css` | Those four views' styles, beside `site.css` |
| `vite.config.ts` | Its own build, into `puzzledb/dist/`, never the game's `dist/` |
