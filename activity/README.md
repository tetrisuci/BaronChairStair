# Puzzle — the daily Tetris puzzle

Three modern Tetris puzzles a day — an easy, a medium and a hard — played
inside Discord as an
[Activity](https://discord.com/developers/docs/activities/overview). Everyone
in the server gets the same three, they change at midnight, solving any one of
them keeps a streak, and the result pastes into a channel as a spoiler-light
grid. Alongside them run puzzle rush (five minutes, one sequence everyone
shares, as many puzzles as you can solve), 1v1 duels, and a builder for writing
new puzzles.

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
| `shared/blueprint/` | Blueprint `b1@…` codes both ways: bit reader and writer, opcodes, playfield geometry |
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
   with `/puzzle`.

The activity asks for two OAuth scopes. `identify` names the player on the
leaderboard. `guilds` lets the server confirm a player is really in the server
whose leaderboard they are writing to — without it, the guild is whatever the
client claims, and anyone could post into any server's standings.

### The bot commands

`client/puzzle_commands.py` adds one command, `/puzzle`, which announces the
day in a channel with a way in. It used to be a group of four; the other three
rendered in Discord what the activity now shows on its own front screen, each
in its own embed, each a second place for a board to be wrong. The bot owns
none of the game — it reads the activity server so the two can never disagree.
Set these in the repo-root `.env`:

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

## The puzzle builder

Paint a board, say which pieces the solver gets, write down what they are
aiming for, and take a `b1@…` code away with you. It is behind **Build** on the
front screen.

**The code is the artefact, which is why the screen ends at a text field rather
than a save button.** The club authors every puzzle on
[bp.tali.software](https://bp.tali.software) and keeps them in a spreadsheet as
Blueprint codes, so the only output worth anything is one that site and this
decoder both read. `shared/blueprint/encode.ts` is the inverse of the decoder
and writes four opcodes — SetCells, PushBack, SwapHold and Comment. What makes
it trustworthy is not the four opcodes but the check behind them: all 138
archived codes decode, re-encode, and decode again to the same page.

**Two limits, before they are discovered.** A code written here carries no
active piece, so a reader opens it with the first preview in hand rather than
on the board — which is why the first glyph in the queue strip is boxed and
says so — and for the same reason `bun run puzzles` refuses one, because the
pipeline requires an active piece. It is a code to paste into blueprint or the
club's sheet, not a pipeline input. Nothing local can show that tali's own site
reads what we write; the round trip is proven against *this* decoder.

**The goal is a sentence with a parser behind it, not a set of fields.** A
blueprint code carries exactly one free-text comment and that comment *is* the
goal — `tools/build-puzzles.ts` reads it straight into `Puzzle.goal` — so
counters have nowhere to live but inside the sentence. The wording is therefore
the club's own rather than ours: `Clear 2 TSDs and 1 TST` is written verbatim
on archived puzzles, and `Clear 1 TSS, 2 TSDs, and 1 TST` — Oxford comma
included — on two more. Two rules keep the round
trip from eating anybody's work. Parsing is all-or-nothing, because `3TSD not
in one combo` is a real archived goal carrying a condition the counters have no
room for and rounding it down to "3 TSDs" would be worse than having no
counters at all. And nothing rewrites the text on its own — the sentence is
rebuilt only when a control moves, never on load. Of the 138 archived goals, 73
fill the counters and 64 stay prose; all 138 load unchanged.

**Undo is for the board.** A step is a stroke, a Clear board, or a Load. Typing
in the fields is not: a text field has the browser's own undo inside it, and a
forty-character goal used to evict the whole stack one keystroke at a time. A
Load is the one change that replaces the fields as well, so undoing one puts
those back and redoing one takes them away again. `Ctrl+Z`, `Ctrl+Shift+Z` and
`Ctrl+Y` all answer on the board; arrows move a cursor, space fills, backspace
clears.

**Test plays the draft on the board it was painted on.** The grid is already
ten cells by twenty with row 0 on the floor, which is the shape and the
direction a rendered frame arrives in — so a test needs no second playfield.
The palette steps aside and the run is painted into the cells that were being
clicked on. It is the real engine under the player's own handling, and nothing
about it is filed or scored. What it tells the author:

- **A solve exists**, because they just played one. That is the question no
  static check can answer, and this screen makes no other claim about
  solvability: a board nobody has solved is unknown, not broken.
- **Whether the goal was met, clear by clear.** The run names every clear it
  made, so `Clear 2 TSDs and 1 TST` is checked as two TSDs and one TST rather
  than as the one number underneath it. A prose goal cannot be checked and says
  so instead of quietly passing.
- **What the run sent**, which is the number a draft does not otherwise have. A
  shipped puzzle's target comes from replaying the author's reference solution,
  and a draft has no solution until somebody plays one — so a goal naming no
  attack has no target, the run plays its queue out, and the end of it offers
  the attack it sent as the figure to adopt. A target of zero would instead be
  met before the first piece landed, ending the test having proved nothing.

One rough edge, named because it looks like a bug: a quad that empties the
board is reported by the engine as a perfect clear and by nothing else, so a
goal asking for a quad reads as unmet. The clears the goal never asked for are
listed underneath, which is where that shows.

**Cells above the twentieth row are kept but not drawn.** Blueprint's field is
forty rows and this screen paints twenty, so a code brought in from elsewhere
can carry cells the grid cannot reach. They survive re-encoding rather than
being quietly dropped — Copy would otherwise hand back a smaller puzzle than
the one that was pasted in — and the warning line says how many there are and
that Clear board is what removes them.

## Letting an officer at the review queue

A puzzle a player submits from the builder lands in `submissions` with
`status = 'pending'`, and an officer decides it at `/review`.

**Set `REVIEW_SECRET` or the door is not there.** Unset, `/api/review/*` answers
`404 Review access is not enabled` — switched off rather than left open, the
same stance `BOT_API_KEY` takes for the bot routes. It is deliberately not a
required secret, so pulling this change does not stop an existing deployment
from booting.

**It is its own secret and must stay that way.** Nothing in this repo can revoke
one issued link: there is no denylist, no `jti` and no used-token table, so the
only revocation is rotating the key and restarting. Signed with
`SESSION_SECRET`, that single act would also sign out every player and
invalidate every open rush ticket — and a rush ticket is the only record that a
rush is in progress, so rotating would destroy runs mid-flight. With its own
secret, "kill every review link" costs one `unset` and a restart and no player
notices.

**Minting a link.** On the VPS, from `activity/`:

```sh
bun run review-link -- hannah              # 15 minutes
bun run review-link -- hannah --minutes 5
```

It signs a string, prints it and exits — it never opens the database, because
constructing a `Store` runs the schema and a table rebuild on every
construction and nothing in this repo sets `busy_timeout`, so a second writer
against the live WAL file fails instantly rather than waiting. It reads
`REVIEW_SECRET` straight out of the environment for the same kind of reason:
`server/config.ts` throws at import under `NODE_ENV=production` unless the whole
production environment is present, which is not a thing a one-off command should
depend on.

**What the link is worth.** Whoever holds it is the reviewer — it is a bearer
capability with nothing written down behind it. The link itself lasts fifteen
minutes, and the page trades it once, in a POST body, for a two-hour token that
never appears in a URL. Those two windows add up rather than overlap: a link
spent in its last second still buys a full sitting, so the worst case is fifteen
minutes plus two hours. Send it in a DM, not a channel. That token is what every
review call carries, and when it runs out the officer asks for another link.

**The trust root is SSH, and the audit column says so.** `<who>` is typed by
whoever ran the command and lands in `submissions.reviewed_by`. Nothing
validates it. The person who can run this is the person with a shell on the box,
and that — not the string — is the authentication. Discord OAuth plus a role
check is the real answer, and it becomes worth its cost when more than about
three people review, or when reviewers change over time.

## The review page

`/review` is a second page out of the same build — `client/review/`, its own
Vite entry — and not a mode of the activity. It is opened in an ordinary
browser tab, outside Discord, by whoever the link was sent to.

**Two tabs, one sitting: Queue and Archive.** The archive browser is a second
screen of the same page rather than a page of its own, because a page of its own
would need its own link minted on the VPS and its own kind of token — two
credentials for one officer, expiring at different times. They are two ordinary
buttons over one body, switched the way the queue and a submission already are;
`aria-current` marks the one you are on rather than `role="tab"`, because a real
tablist comes with a keyboard contract and half a tablist reads worse to a
screen reader than two plain buttons. The queue is where the tool lands and
stays landing: a submission waiting on a decision is time-sensitive in a way a
typo in a title is not.

**The reviewer sees what they are judging.** The board is drawn by the same
`BoardRenderer` the game uses and the solve is stepped by `SolutionPlayer`,
which locks each stored placement into a board copy and clears full rows
itself — no engine, no second board renderer. Beside the goal sentence is the
list of clears the author's solve actually made, because that pairing is the
only goal check that ever happens: there is no goal checker on the server, and
most goals are prose. The attack is labelled as the author's own solve rather
than as a target, since a community target is what a person really did —
reachable and beatable — where an archive target is the best line a pathfinder
could find.

**The token is held in a variable and nowhere else** — never `localStorage`,
never `sessionStorage`, never a cookie. A cookie would manufacture CSRF in a
codebase that has no answer to one: there are no cookies anywhere here, no
`SameSite` configuration, no CORS middleware and no Origin check, which is
exactly why nothing needs a CSRF token today. Authentication is a header a
browser never attaches by itself, so a cross-site POST arrives unauthenticated
and Accept and Reject cannot be reached from another origin. The link is taken
out of the address bar with `replaceState` before the first request goes out,
and the page renders no outbound links at all, so the token never rides out in
a `Referer`. A refresh signs you out, which is the intended lifetime.

**Deploying it, and the upgrade order that matters,** are in
[DEPLOY.md](DEPLOY.md) — written for whoever is doing it on the VPS, including
an agent with a shell and no other context.

**Two things to check after a deploy**, because the ways this page goes wrong
are all silent successes — a 200 with the game on it:

```sh
curl -sI "$HOST/review/" | grep -i -e content-type -e x-frame-options
curl -s  "$HOST/review/" | grep -o '<title>[^<]*'   # Review queue — Daily Tetris
```

`dist` is gitignored, so the ordinary cause is a deploy that skipped `bun run
build`; the server says so at start-up when a page the build should have
produced is missing. The other cause is structural and is why the entry lives
at `client/review/index.html`: Hono's static middleware appends `index.html`
only for a directory and never tries `<path>.html`, so a flat `dist/review.html`
would fall through to the single-page fallback and answer `/review` with the
Tetris game. `tests/review-page.test.ts` builds both arrangements and drives
them.

## Deciding a submission

The page does this with two buttons. The same two routes, behind the review
token, for an officer with `curl`:

```sh
curl -sX POST "$HOST/api/review/submissions/7/accept" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"difficulty": 6, "note": "Lovely little opener."}'

curl -sX POST "$HOST/api/review/submissions/7/reject" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"note": "The solve does not fit this board — resubmit from the one you played."}'
```

**Both are terminal, and the second officer is told so.** `WHERE status =
'pending'` on the write is what makes that true rather than polite: two links can
be out at once and nothing coordinates them, so without it the second click
would overwrite the first one's note, rating and allocated id and still look
like a clean decision. A second attempt answers `409` naming who got there
first.

**Accept's note is optional; reject's is not.** A rejection is the only thing
the author ever hears back about a puzzle they wrote. An acceptance needs no
note because the puzzle turning up in the archive is the message.

**The reviewer's difficulty is the one that counts**, and under full rotation it
routes: `dailyTierOf` reads it to pick which of the day's three a puzzle can be,
and `rushBand` to place it on the ladder. The author's own rating is kept beside
it as `claimed_difficulty` and is a hint, never a control — a self-rated field
that routed would hand the person being routed the switch.

**Accepting replays the stored solve first.** The row keeps the author's input
log next to the solution derived from it, and accepting re-runs that log against
the stored board and refuses unless the attack *and* the piece count still match
what is written down. That is the only thing standing between a stale log — play
the puzzle, paint one more cell, submit — and an archive entry whose target
nobody can reach and whose reveal plays a line that does not work. Nothing else
would catch it: the shape check does not look at solutions and says so.

**Accepted puzzles are ids 100000 and up, allocated at accept.** The club sheet
runs 1–140 with gaps and keeps allocating, so the band keeps the two allocators
from ever having to know about each other; the number comes from the current
maximum inside the same transaction as the write, so an id is never issued twice
and never reused. Do not renumber the sheet into the band — the archive refuses
to load at all if two puzzles claim one id, which is the loud version of a
failure that is otherwise silent and unrecoverable (the archive keys by id, so
one copy wins every lookup while both stay in the rotation, and `runs.puzzle_id`
has no foreign key to notice two puzzles' history merging).

**A puzzle becomes playable at the next restart, not at accept.** The archive is
loaded once at module scope and never reloaded, deliberately: an archive that
grew mid-day would re-deal a day underneath the players holding its prompt. The
startup banner says how many of the puzzles came from players, so a restart that
did not pick one up does not look like a restart that did.

**Growing the archive does not move a day anybody has played.** It moves almost
every one of them in the raw derivation — one extra easy-band puzzle re-deals
the easy puzzle for most days ever played, and one extra rush-eligible puzzle
moves 38 of the 40 slots in every stack. `day_puzzles` and `day_rush` are what
hold history still: a day is derived once, the first time anybody asks, and
written down. Days that have not arrived yet are deliberately not written down,
and that floating edge is what "joins the rotation" means.
Pinned by `tests/review-decide.test.ts`, which accepts a submission, restarts,
and checks every finished day and every pinned rush pool against what they were.

## Correcting a puzzle

A puzzle already in the archive can have its metadata fixed, and the fix
survives the next `bun run puzzles`.

**The Archive tab does this.** Every puzzle in one scrolling list — searchable
by title, author or number, showing where each came from and which have been
corrected — and beside it a form for the five fields. Each field that a
correction has changed shows what its source says underneath, with a Revert of
its own; `Revert all` puts the whole puzzle back. The list scrolls inside its own
card rather than growing the page, which is not a detail: 139 rows is three
screens, and a list that pushes the form off the bottom makes the officer scroll
away from the thing they are editing to pick the thing they are editing.
`tests/review-archive.test.ts` drives all of it, including that the form posts
only the fields that actually moved — a body of all five would record a
correction on four nobody touched, and every one of them would stop tracking the
club's sheet from then on.

The same three routes, behind the same token, for an officer with `curl`:

```sh
curl -s "$HOST/api/review/puzzles" -H "Authorization: Bearer $TOKEN"

curl -sX PATCH "$HOST/api/review/puzzles/12" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title": "Tuck the T", "difficulty": 9}'

# Put one field back to what its source says, leaving the rest of the correction.
curl -sX PATCH "$HOST/api/review/puzzles/12" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title": null}'

# Put all of them back.
curl -sX DELETE "$HOST/api/review/puzzles/12/override" \
  -H "Authorization: Bearer $TOKEN"
```

**Editing `data/puzzles.json` is the fix that does not work.** That file is
generated wholesale from the club's CSVs, so an edit to it is gone at the next
rebuild with nothing anywhere to say it ever happened. Corrections are rows in
`puzzle_overrides` instead, and `PuzzleArchive.load` lays them over the rebuilt
file — the file is the *source*, never the last word.

**One mechanism, both sources.** Accepted player puzzles are rows in the same
database and could have been UPDATEd in place; they are not, because a
correction written one way for the club's puzzles and another way for players'
is two things to keep in step. The same PATCH corrects either.

**Five fields: title, author, goal, difficulty, set.** Board, queue, hold,
target and solution are what a puzzle *is*, and a run is filed against a
`puzzle_id` with no record of the board it was played on — so editing one would
silently invalidate every leaderboard row standing against that puzzle and every
past day that dealt it. A body naming one of them is refused rather than ignored,
because a `200` to somebody who thinks they have just fixed a board is worse than
a `400`. The five that are allowed cannot change what a solve was worth.

**A field nobody names is left alone, and `null` reverts that one field.** So a
title can be fixed without saying anything about the difficulty, and put back
without disturbing it. `DELETE` reverts the lot; it is one row, and it is
idempotent — reverting a puzzle that has no correction is a `200`, and only a
puzzle that does not exist is a `404`.

**Correcting a difficulty moves the rotation, forwards only.** `dailyTierOf`
reads it, `byTier` partitions the archive with it, and the daily rotation is an
index into those pools derived from their size — so re-rating one puzzle out of
the easy band changes which easy puzzle a future day deals. Days already played
are pinned in `day_puzzles` and do not move, which is the same protection an
accepted puzzle relies on. `tests/puzzle-override.test.ts` proves it, with a
control showing the untouched derivation really did shift.

**A correction reaches players at the next restart**, like an accepted puzzle
and for the same reason. The list and PATCH responses are computed from the
source plus the row on file rather than read off the running archive, so the
officer sees the result of their own correction immediately and it is the same
thing the next boot will serve.

**A correction the server cannot use is ignored, not fatal.** Every rule is
enforced on the write — the same title, goal and difficulty rules a submission
is held to — because `PuzzleArchive.load` runs at module scope and throws, and a
rule enforced only at the merge would take the whole server down for every
player over one typo. The merge is defensive anyway: a row that could only have
been hand-edited is dropped whole, logged with the `DELETE` that clears it, and
the puzzle is served exactly as its source has it.

**`updated_by` is the review grant's subject**, which is an attribution the
operator typed and not an identity — worth what `submissions.reviewed_by` is
worth, and for the same reason.

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

### Pointing and touching

The board speaks the same language to a mouse and a finger — tap to rotate
clockwise, **drag the piece to a square and let go to place it there**, press
and hold to swap into hold. A drag is not a teleport: letting go commits the
keys that put the piece on the square you saw, so the server replays a dragged
placement exactly like a typed one, and a square reachable only by a kick is
placed with the kick that reaches it — the spin credit follows the route, not
the finger.

Spins work the same way: tap first to set the rotation — twice for a TSD —
then drag to the slot, and the engine credits what the route earned. While a
drag is under way the piece shows where it would land: a solid outline on a
square it can reach, dashed where nothing lands.

The same actions have buttons: undo and redo sit in the Progress panel, and
hold has its key. Pointers and keys share one log, so an undo takes back a
dragged placement exactly like a pressed one.

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
