# Puzzle — the daily Tetris puzzle

One modern Tetris puzzle a day, played inside Discord as an
[Activity](https://discord.com/developers/docs/activities/overview). Everyone
in the server gets the same puzzle, it changes at midnight, and the result
pastes into a channel as a spoiler-light grid. Alongside it runs puzzle rush:
five minutes, one sequence everyone shares, as many puzzles as you can solve.

The puzzles come from the Tetris at UCI puzzle archive, which stores each one as
a pair of [Blueprint](https://bp.tali.software) codes — the position and the
author's own solution. This project decodes both, replays the solution through a
real TETR.IO engine to learn what it actually sends, and uses that number as the
day's target.

```
tmp/*.csv ──► tools/build-puzzles.ts ──┬─► data/puzzles.json   ──► server ──► browser
                                       └─► data/solutions.json ──► server (reveals only)
   archive        decode + replay            138 puzzles       daily     the game
```

## What is in here

| Path | What it is |
| --- | --- |
| `shared/blueprint/` | Decoder for Blueprint `b1@…` codes: bit reader, opcodes, playfield geometry |
| `shared/tetris/` | One engine configuration, a placement pathfinder, and the run verifier |
| `shared/puzzle.ts` | The puzzle data model, shared by the build, the server, and the client |
| `shared/daily.ts` | Which puzzle belongs to which day |
| `shared/rush.ts` | Which puzzles a rush deals out, and in what order |
| `shared/rng.ts` | Seeded shuffling, so both of those derive rather than store |
| `tools/` | The build pipeline and its diagnostics |
| `server/` | Hono + Bun: OAuth exchange, daily puzzle, puzzle rush, run verification, SQLite |
| `client/` | The activity itself — canvas playfield and interface |
| `client/public/fonts/` | Archivo and DM Mono, self-hosted (see below) |

## Running it locally

```sh
bun install
bun run puzzles       # tmp/*.csv -> data/puzzles.json (committed)
                      #            -> data/solutions.json (never committed)
bun run build         # client -> dist/
bun run dev           # server on :3001, serving dist/
```

Open <http://localhost:3001>. Outside Discord there is no OAuth handshake, so
the server hands out a single local guest identity and everything else works
normally. For a live-reloading client, run `bun run dev:client` alongside
`bun run dev` and use <http://localhost:3000>.

Useful commands:

```sh
bun test                                 # decoder, verifier, routes, and archive checks
bun run tools/inspect-puzzle.ts 13 70    # why a given archive entry will not build
bun run typecheck
```

**What the suite can and cannot see.** Most of it needs no browser: the engine,
the verifier, the routes and the duel referee are all plain data in and plain
data out. `tests/render.test.ts` adds a document through **happy-dom**, which
builds a real DOM and cascades real stylesheets, so "which rules apply to this
element" and "what did this component actually build" are testable — that is
where the scroll-container and retry-wiring tests live. It is scoped to that one
file rather than registered as a preload, because `bun test` shares a process
and the server suite leans on Bun's own `fetch` and `Request`, which a global
DOM registration would shadow.

happy-dom does **no layout**. Nothing in the suite can tell you that a card
overflowed its screen, that a wheel event chained to a parent, or that resizing
a canvas cleared it. Three bugs of exactly that shape reached a player and were
found by hand; the tests that came out of them pin the causes — the wrong run
being repainted, the wrong scroll rules on a list — and not the symptoms. The
symptoms still have to be looked at.

`tools/e2e-submit.ts` plays today's puzzle against a running server. It signs in
as a guest, so once Discord credentials are configured the deployment guard
switches guest play off and the script can no longer get a session. Point it at
a throwaway instance instead of the real one:

```sh
ALLOW_GUEST_PLAY=true PORT=3998 DATABASE_PATH=/tmp/e2e.sqlite bun run server/index.ts &
bun run tools/e2e-submit.ts http://localhost:3998
```

## Setting it up as a Discord Activity

1. **Create the application.** <https://discord.com/developers/applications> →
   New Application. Under *Activities → Settings*, enable Activities.
2. **Copy the credentials** from *OAuth2* into `activity/.env` as
   `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`, and set a `SESSION_SECRET`.
3. **Add exactly one OAuth2 redirect URI.** The embedded SDK never sends one —
   it expects Discord to resolve it from the application — so an app with none
   registered fails at `authorize()` with `invalid_request: Missing
   "redirect_uri" in request`, and an app with several is ambiguous. The URI is
   never navigated to in this flow, so its value barely matters;
   `https://<application id>.discordsays.com/` is the conventional choice.
4. **Expose the server over HTTPS.** Discord will not load an activity over
   plain HTTP. In development, `cloudflared tunnel --url http://localhost:3001`
   or `ngrok http 3001` is enough.
5. **Add a URL mapping.** *Activities → URL Mappings*: map the root prefix `/`
   to your public host. The client sends everything through `/.proxy` when it
   detects it is running inside Discord; the server accepts both forms, so no
   further configuration is needed.
6. **Launch it** from the activity picker in any voice channel, or post a link
   with `/puzzle play`.

The activity asks for two OAuth scopes. `identify` names the player on the
leaderboard. `guilds` lets the server confirm a player is really in the server
whose leaderboard they are writing to — without it, the guild is whatever the
client claims, and anyone could post into any server's standings.

### The bot commands

`client/puzzle_commands.py` adds `/puzzle play`, `/puzzle standings`,
`/puzzle rush`, and `/puzzle help` to the existing bot. It owns none of the
game — it reads three endpoints on the activity server so the two can never
disagree. Set these in the repo-root `.env`:

```
PUZZLE_APP_ID=<the application id>
PUZZLE_API=https://your-activity-host
PUZZLE_API_KEY=<same value as BOT_API_KEY in activity/.env>
```

Without `PUZZLE_APP_ID` the commands are still registered; they just explain
what is missing.

## How a run is scored

A sheet has a fixed board, a fixed queue, and a damage target taken from the
author's own solution. Reach the target and the sheet is approved. Restart as
often as you like — restarts are counted and shared, but only the attempt that
solves it is filed, and the first filing of the day is the one that sticks.

**The client never reports a score.** It submits the keys it pressed, with frame
and sub-frame timing, and the server replays them through the same engine on the
same puzzle. The number on the leaderboard is one the engine produced from
inputs somebody actually made, using the handling the attempt was played
under — which is frozen when the attempt starts, so changing it mid-run
restarts rather than scoring a game nobody played.

**Times are a claim, not a measurement.** The leaderboard ranks by *total time
on the puzzle* — wall clock from opening it to solving it, across every restart,
which is what a player actually experiences. That number comes from their own
clock and cannot be verified; the server only bounds it, so it can never be less
than the solving attempt provably took nor more than a day. The solving
attempt's own duration *is* verified, by replaying its inputs. Whether a run
solved the puzzle is fully verified; how fast is a friendly scoreboard.

## Puzzle rush

Five minutes, and as many puzzles as fit inside them. A rush deals out a
sequence of forty and you work down it: solve one and the next arrives, or
spend one of two skips on the one you cannot see. A dead board — every piece
placed without reaching the target — ends nothing and deals the same puzzle
again, so a failed attempt costs time and nothing else, and a puzzle is only
ever left behind by being solved or by being skipped. Skip is a rebindable key
like every other, `S` by default; in the daily it does nothing, because there
is nothing to skip to.

**The ramp is by rung, not by rating.** A rush climbs in bands three wide, and
the order inside a band is whatever the shuffle made it. Ordering on the rating
itself gave every run the same strictly ascending ladder — which reads as a
fixed list even when the puzzles on it are new, and on a replay of the same day
it *was* one. Difficulty still only ever climbs: nothing from an easier band
arrives after something from a harder one.

**Everyone gets the same sequence on the same day**, for the run that counts,
which is the only way the board compares like with like. That is the run that goes on the leaderboard,
and the first one filed is the one that sticks: a rush cannot improve on itself
the way an unsolved puzzle can be solved later, so nothing else would stop a
player opening rush after rush and keeping the best.

**Play it as often as you like.** What a filed run spends is the scoring, not
the puzzles. The day's shared sequence belongs to the run that is scored and to
that one only — everyone gets the same forty in the same order for the attempt
that reaches the board, which is the whole basis for comparing two players —
and every run after it draws its own. A replay dealing the identical stack
would be a memory test rather than another go at the mode. `ranked` is decided
by the server when the rush opens and travels inside the signed ticket, so a
fourth run cannot come back claiming to be the first, and the seed is the
server's either way, so nobody can re-roll for a gentle sequence without paying
five minutes for it.

**A rush ends on its own screen**, listing every puzzle it reached in the order
they came, marked solved or not, each one a way back into that puzzle on its
own. Losing one to the clock is the moment you most want another look at it,
and the stack used to disappear with the buzzer. The marks are the verifier's
account rather than the client's — a screen calling something solved that the
server had just refused would be the one place the two disagree in front of the
player.
Ranking is by solves, and between two players on the same count, by whoever
reached their last solve soonest.

**The all-time board never resets.** Beside the day's rush board is a record
book: every player's best run ever, in two scopes — everyone, and this server.
The daily board answers "who ran today" and is empty for most of a morning; a
record that expired at midnight would not be a record. Each row is dated with
the day it was set, because a board that never resets otherwise reads as though
everything on it happened recently. Only ranked runs are ever stored, so
practice and replays cannot reach it.

**The sequence is derived, not stored**, from the day number alone — the same
discipline as the daily rotation, for a stronger reason: the server has to be
able to re-derive exactly what a player was given in order to check a run it
never watched. Anything longer than twenty-four pieces is set aside first,
which excludes exactly one of the 138; it runs to seventy-four, and meeting it
inside five minutes would not be a puzzle in the rush, it would be the rush.
The rest are shuffled by the day's seed, the first forty are taken, and only
then are they sorted by difficulty, so a rush opens gently and ends somewhere
nobody reaches. Sorting before taking rather than after would hand out the same
forty easiest puzzles every single day with only their order changing.

Unrated puzzles — `difficulty` 0 in the archive — are sorted as though they
were 8. Unrated is not the same as easy: the unrated ones ask for things like
"2 TSS, 3 TSD" over a dozen-odd pieces, and taking their zero at face value
would open every rush with a wall.

**The five minutes are measured, not claimed.** Starting a rush mints a signed
ticket carrying the day, the seed, and the instant the server stamped it;
handing the run in is the second instant, and the clock is the subtraction
between the two. The ticket is signed under its own context, so a session token
presented as one fails the signature check, and it is bound to the player it
was minted for. Nothing is written down in between, so there is no clock for
the client to move — only ten seconds of slack at the far end, for a round trip
it does not control. What comes back is inputs and nothing else: one segment
per puzzle attempted, each carrying its key log, with no puzzle id, no solved
flag and no skip flag. Position in the re-derived sequence says which puzzle a
segment was, replaying it says how it went, and skips are counted rather than
believed: an unsolved segment is either a skip or the puzzle the buzzer caught,
there can be only one of the latter, and a run leaving more than three behind
is rejected. Counting by position instead — every unsolved segment but the last
one — was wrong in both directions, excusing a final skip as the buzzer and
quietly handing everybody a third. The two numbers the client still supplies
are how many of those it meant as skips and when its last solve landed, and
both are squeezed the way the daily's *total time on the puzzle* is: the skip
count clamped to what the replay actually left unsolved and to the budget, the
time never less than the play the server replayed to reach it and never more
than the run the server timed.

## The daily recap

`GET /api/recap?guild=<id>&day=<n>` gives the bot everything it needs to look
back on one finished day in one server: which puzzle it was, that server's
board, its rush board, and how many consecutive days somebody there has
solved. Gated on `BOT_API_KEY`, like the other two bot routes.

It is a separate route rather than a `?day=` on the boards because a recap
wants three things about the same day at the same instant, and a board that
answered only the first would leave the streak with no home. The day is
bounded to a *finished* one — a whole number between 1 and yesterday. That is
not defensive habit: SQLite binds `NaN`, `1.5` and `-5` without complaint and
answers every one of them with no rows, which a recap would go on to post as
"nobody played" on a day that people played. Today is refused along with the
future, because the streak counts a gap as a break, which is only honest once
the day is over.

The streak here is deliberately stricter than a player's. `Store.streak`
forgives a missing anchor day, since the player may simply not have played yet;
a recap only ever asks about a day that is already over, so the same
forgiveness would congratulate a server on a run it had just broken.

The board it returns is capped at a hundred rather than the interactive
twenty-five, and carries a `total`. Misses sort last, so the smaller cap would
have quietly deleted exactly the people a recap exists to tease.

## 1v1

Two players in the same server, over a WebSocket. Puzzle duels are best of N on
one shared puzzle a round, first valid claim taking it and the clock expiring
as a draw; rush duels are one clock and one shared stack walked independently,
most solved winning.

The room's rules belong to the host, and only while it is still a room. Mode,
best-of count, clock and a difficulty band are set in the lobby with the guest
watching the same values, and the referee refuses a change from anyone else and
refuses any change once the match is on — otherwise a host losing a best-of
could shorten it to a best-of-one they had already won. A band is checked against what
the match actually consumes, not merely against being empty: a best-of-7 drawn
from one puzzle deals that puzzle seven times, and the log that solved it the
first time solves it every time, so the match is won without playing. Rules
whose pool is smaller than the rounds they deal — or, in rush, than the stack
the clock needs — are refused in the lobby with both numbers named. The lobby
shows the host what their band leaves and what the match needs, counted by the
referee off the pool it actually deals from rather than by the client off a
listing it may have filtered differently.

A client never says it solved something. It sends the log that solves it, and
the server replays that log — verification is what reading a claim *means*,
which is why a claim has no field on it to lie in. Replaying costs about a
fifth of a millisecond, so it happens inside one turn of the event loop, and
that is the whole race resolution: two claims arriving together are decided by
the order the socket delivered them, with no clock from either player involved.
A single `await` in that path would quietly reopen it, which is why the
function carrying it says so.

A puzzle duel rests for a few seconds between rounds, and spends them showing
both players how the round was meant to go — the reference solution, on the
board they were just playing it on, steppable. The loser gets the most out of
it, which is the point: it is the only look they get at the puzzle that beat
them. It is safe only because the round is over and a duel never deals a puzzle
it has already dealt, so the answer buys nothing for the rest of the match; the
archive still refuses the answer to a puzzle in play, and the deciding round
skips the reveal because the result screen follows it in the same breath. Rush
has no such pause and should not — its whole shape is one unbroken clock.

The opponent is a bar and a score, never a board — a board part-way through a
puzzle is a partial solution to it, and losing should not come with a hint. The
archive likewise refuses the answer to a puzzle you are currently duelling on.

**It still cannot prove a human made the log.** The answers are no longer in
this repository — `data/puzzles.json` carries no solutions and
`data/solutions.json` is untracked — but the pathfinder that turns a board into
a keystroke log ships in the client bundle, so a determined player can still
derive one. The scheme proves a submitted log really solves the puzzle it
claims; it cannot prove a person typed it. That is the same trade the daily and
rush make, and it costs more here, because what a scripted opponent takes is
somebody's match rather than a place on a board.

**What that proves, and what it does not.** `GET /api/archive/:id` hands a
signed-in player the solution to a puzzle they have earned, and no longer to
one they have not — and the answers are no longer sitting in the repository
either. The scheme therefore proves exactly
one thing: that the submitted inputs legally solve those puzzles, in that
order, inside five minutes the server measured itself. It does not prove a
human made them, and a scripted client beats it. A fixed sequence per day also
means whoever plays later knows what is coming — the daily's own trade, forty
puzzles at a time.

## Placing a piece

**Only a hard drop places a piece.** There is no lock delay and no limit on
moves or rotations: gravity is zero, so a piece stays exactly where it is put,
for as long as it is left there, and soft drop seats it against the stack
without committing it. A puzzle is a placement problem, and a timer that took
the piece out of the player's hands after a fixed number of frames was a
reaction test hidden inside one ([#8](https://github.com/tetrisuci/BaronChairStair/issues/8)).

This is one config, shared: the browser plays under it and the server replays
every submitted log under it, so the two cannot disagree about when a piece
went down.

## Controls

Fully rebindable, with TETR.IO handling: DAS, ARR, DCD, SDF, safe lock, DAS
cancel, 20G movement, and initial rotation/hold. Lock delay is absent rather
than configurable — see above. Settings are stored locally and
mirrored to the player's Discord account, so they follow them to another device.

**Timings are in milliseconds**, matching the club's own board and every
handling guide worth reading. The engine works in 60Hz frames, and the
conversion happens in exactly one place — inside the engine factory — so a
duration is never accidentally read as a frame count. It is not rounded to whole
frames either: a DAS of 103ms really is 103ms. SDF stays a multiplier, because
it is a speed rather than a time.

Defaults: arrows to move and soft drop, space to hard drop, `Z`/`X` to rotate,
`A` for 180, `C` to hold, `R` to restart, `S` to skip in a rush, `Esc` for
settings.

## Look and feel

The palette, the type, and the shapes come from
[tetrisatuci.org](https://tetrisatuci.org): sun-yellow ground, plum ink, cream
cards, and the club's own seven piece colours. Two rules hold it together —
shadows are hard offsets rather than blurs, so the interface stacks like
stickers on paper, and the corner radius is small and constant.

Fonts are **self-hosted** in `client/public/fonts/`. A Discord activity runs in
a sandboxed iframe that cannot reach `fonts.googleapis.com`, so Archivo (the
heavy display face) and DM Mono (everything numeric) ship with the bundle. Both
are SIL Open Font Licence.

## Regenerating the puzzle data

`data/puzzles.json` is committed, so a checkout runs without the spreadsheet.
`data/solutions.json` is not: an answer key beside its puzzles in a public
repository is a published answer key. Without it every puzzle still loads,
plays and scores — only the reveal has nothing to show, which is the right way
round for the thing that must not leak. Regenerate it with `bun run puzzles`
against the club's archive.
When the archive gains puzzles, re-export the sheets into `tmp/` and run:

```sh
bun run puzzles
```

It reports how many puzzles built, how far the replayed clears agree with the
authors' own descriptions, and every entry it had to skip with the reason. Two
of the current 140 are skipped: one answer is drawn into squares no legal
movement can reach, and one has no answer that its own pieces can produce. Both
are archive-side problems, not decoder bugs — `tools/inspect-puzzle.ts` shows
the working.
