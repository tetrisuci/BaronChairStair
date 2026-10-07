# Deploying the activity, and turning on the review tool

Written for whoever is doing the upgrade on the production VPS — including
Claude Code with a shell on that box. It assumes you have not seen this
codebase before and cannot ask anyone questions.

Everything here runs from `activity/`, not the repository root. The two are
different projects with different `package.json` files, and running the wrong
one is the commonest way this goes sideways.

**This file covers the activity only.** The Discord bot — including `/report`,
which needs its own two GitHub keys before it does anything — is deployed
separately: see [`../DEPLOY.md`](../DEPLOY.md), which indexes both halves.

---

## What is new

The activity now takes puzzles written by players, and gives a club officer a
web tool to review them.

| | |
|---|---|
| **Submitting** | A Submit control in the in-app puzzle builder. A player must solve their own puzzle before they can send it; the server replays their keystrokes and derives the target and the answer key from what it sees. |
| **Reviewing** | A second page at `/review`, outside Discord, reached by a link minted on this box. It shows the board, steps the author's solution, and accepts or rejects. |
| **Accepting** | An accepted puzzle joins the archive and the daily/rush rotation at the next restart, or at the next Discord `/archive sync` without `dry_run`, which reloads the archive in place. |

Two things changed underneath that matter to a deployment:

1. **The build now produces two pages**, `dist/index.html` and
   `dist/review/index.html`. A deploy script that checks only the first will
   pass while `/review` silently serves the game instead.
2. **A day's puzzles and its rush pool are now recorded in SQLite** the
   first time anyone asks for them, rather than derived from the archive on
   every request. That is what lets the archive grow without changing which
   puzzle was "day 200". It brings one ordering rule, below, and it is the only
   part of this upgrade that is awkward to undo.

---

## The one ordering rule

**Start the new code before the puzzle pool next changes.**

On its first start the new code writes down what every past day dealt. For days
somebody played it takes that from the `runs` table, which is a recorded fact
and is right whatever has happened since. For days nobody played it re-derives
from the pool it finds — which is correct only while that pool is still the one
those days were derived from.

So, in order:

1. Deploy the new code and start it. **Do not run `bun run puzzles` first.**
2. Confirm the backfill ran (verification step 2).
3. After that, rebuild the puzzle data or accept submissions whenever you like.

Getting this wrong is not a crash. It writes plausible, wrong history for days
nobody played, and nothing will tell you. Getting it right costs nothing but
doing the steps in this order.

---

## Before you start

```sh
cd /path/to/BaronChairStair/activity
bun --version          # 1.2 or newer
git log --oneline -1   # note this — it is your rollback target
```

Find out how the service is currently run — `systemctl status`, `pm2 list`, a
`tmux` session, whatever it is — and confirm you can stop and start it. Look;
do not guess.

**Back up the database first.** It is in WAL mode, so copying the `.sqlite` file
on its own does not lose *some* recent writes — on this project it loses very
nearly everything. Measured on a working checkout: `data/daily.sqlite` was 4 KB
while `data/daily.sqlite-wal` beside it was 997 KB, so a `cp` of the main file
produced a database in which `day_puzzles` did not exist at all, while
`VACUUM INTO` of the same database gave all 741 rows. The `-wal` file is where
your data is until something checkpoints it.

Use SQLite's own backup, which takes a consistent snapshot. Note the connection
is deliberately *not* opened read-only: `VACUUM INTO` creates the output file,
and SQLite refuses that on a read-only connection with
`SQLITE_CANTOPEN: unable to open database file`.

```sh
bun -e 'import {Database} from "bun:sqlite";
        import {resolve} from "node:path";
        const p = resolve(process.env.DATABASE_PATH ?? "data/daily.sqlite");
        const out = `${p}.bak-${new Date().toISOString().slice(0, 10)}`;
        new Database(p).exec(`VACUUM INTO "${out}"`);
        console.log("backed up ->", out);'
ls -la data/*.bak-*
```

**It must print a path, and that file must exist.** No output means it failed.

**Every `bun -e` in this file uses `import`, and none of them may be changed to
`require`.** With `require`, Bun swallows an uncaught exception in a `-e`
script: the process prints nothing and exits `0`. Measured — opening a database
that does not exist, and deleting from a table that does not exist, both exit
`0` in silence under `require`, and both print `SQLiteError: …` under `import`.
Every command here is one whose failure you must see: this backup, the check
that the backfill ran, and the two recovery commands at the end that write to
the database. A silent backup is the worst of them, because the next step
assumes it worked.

---

## The upgrade

```sh
cd /path/to/BaronChairStair/activity

git pull                 # or however this box gets code
bun install
bunx tsc --noEmit        # must be silent
bun test                 # 0 fail. Skips are normal — see below
bun run build            # writes dist/, including dist/review/index.html and dist/build.json
```

**Skips are expected here.** `data/solutions.json` holds the answer keys and is
not in git, so a box without it reports around 100 tests skipped rather than
failed — the ones that need a reference solution to build a solving log. `0
fail` is the thing to check. A number of skips that is suddenly zero means the
answers are on this box; a *failure* is what stops a deploy.

Then restart the service the way this box already starts it, **straight after the
build**. The server reads `dist/build.json` once, when it starts, and names that build on
every response; until the restart, pages loaded from the new bundle are told the old
build is serving, offer *Update ready* for nothing, and a reload does not clear it.
*Restarts and handovers*, below, says what a restart costs players now, and what to set
before the first restart onto this code.

*If this box also runs the puzzle database site (the pm2 app or systemd unit `puzzle-db`), rebuild and restart
it once the activity is verified —
[`puzzledb/DEPLOY.md`](puzzledb/DEPLOY.md), "After every activity deploy".
Restarting it never touches the game.*

### The site's player data (`beta 0.13`)

The commit that carries `beta 0.13` in `../changelog.json` is the one that lets
db.tetrisatuci.org publish leaderboards and a page per player, and it changes this
half in three ways:

- **A migration**, run by the restart above, before the server listens. It adds two
  columns to `players` — `site_hidden` (a player's *Hide me on db.tetrisatuci.org*,
  NULL until they choose) and `public_key` (the site's random name for them) — with a
  unique index on the key, and two tables: `guilds` (each server's key, and its name
  from the last sign-in there) and `site_facts` (the game's time zone, rewritten at
  every start, which the site cuts finished days by). It gives every existing player
  and every server that has filed a run a key. Everything is added and nothing is
  dropped, so the older code still runs on the migrated database. **No new
  environment variable.**
- **Two routes**, `GET` and `PUT /api/site-visibility`: the setting's read and its
  save, twenty saves a minute per caller.
- **The page**: an *On the web* section in Settings, whose one link goes to the site.
  The game's own leaderboards, profile and solutions do not link to the site; players
  asked to keep browsing them in the activity. So `bun run build` is part of this
  deploy, as always, and the bundle check below has a string to look for.

**The site goes up in the same sitting**, straight after this guide's verification:
the setting's link points at the new site, and the setting hides players there. The bot
comes last, and only if its own code changed — the root [`../DEPLOY.md`](../DEPLOY.md).

### Rate limiting behind the proxy

**If anything sits in front of this server — cloudflared, nginx, Caddy — put
this in `activity/.env`:**

```
TRUST_PROXY=true
```

It decides whether the rate limiter believes `Cf-Connecting-Ip` and
`X-Forwarded-For`. Those headers are how one player is told from another behind
a proxy, but they are written by whoever is talking to us, so trusting them
where nothing rewrites them lets a caller mint a fresh bucket per request and
have no limit at all — including on `/api/submissions`, which replays a board
through the engine.

So it is off unless you say otherwise, and the failure that causes is the loud
one: every player counts as one caller, they share one bucket, and somebody
reports 429s within the hour. The server warns at start-up when it is unset in
production:

```
[limits] TRUST_PROXY is not set, so rate limits are keyed on the socket's peer
address. ...
```

If you see that line and there *is* a proxy in front, set it and restart. If
there is no proxy, the warning is the correct state and you can ignore it.

### Turning the review tool on

The review routes answer `404` until a secret exists, so this step is optional
and everything else works without it.

```sh
openssl rand -hex 32     # copy the output
```

Add to `activity/.env`:

```
REVIEW_SECRET=<the string you just generated>
REVIEW_BASE_URL=https://your-public-host
```

`REVIEW_BASE_URL` is cosmetic — without it the link command prints a path and
tells you to put your host in front of it.

**Use its own secret. Never reuse `SESSION_SECRET`.** There is no way to revoke
one review link, so the only revocation is rotating the secret and restarting.
If review links were signed with the session key, doing that would also sign out
every player and destroy every rush in progress — a rush ticket being the only
record that a rush is open. Rotating `REVIEW_SECRET` kills every review link and
nobody else notices.

Restart again after editing `.env`.

---

## Restarts and handovers

### What a restart costs players

The server stops politely. On SIGINT — pm2's own stop and restart — or SIGTERM —
systemd's, and `kill`'s — it stops listening, gives the requests in flight up to 8
seconds, closes every duel socket with "The server restarted, so the duel ended.",
writes its last status and exits 0. A second signal exits at once. Around that:

- **Hand-ins ride out the gap.** A page built from this code retries a daily filing, a
  rush hand-in or a practice clear on a lost connection, a 502, 503 or 504, for about
  15 seconds in all (after 0.5, 1, 2, 3, 4 and 4 seconds), saying "Reconnecting…"
  meanwhile. A restart that is listening again inside that loses nobody's solve. A
  rush ended by the buzzer has less — about 9 seconds, the server's 10-second grace
  less one — so a slow restart can still cost a ranked rush.
- **Duels end.** Every lobby and every match in progress closes, and a match gets no
  result. The page says why, and Duel works again at once.
- **A sheet finished before the reset and handed in after it** is refused — "That day
  is over — today's puzzles are new. Open the daily again." — rather than judged
  against the new day's puzzle. A page from before this code sends no day, and is
  judged as before.
- **Open pages are offered the new build.** Every response names the build that
  answered it (`X-Build-Id`), and a page that hears a build other than its own shows
  *Update ready — reload when you're done*: never during a run, a rush, a duel, a
  builder test or a hand-in still retrying, and it never reloads by itself.

**Under pm2, the game's `kill_timeout` must be at least 10000.** pm2's default is
1600 ms, after which it kills the server part-way through those 8 seconds, the hand-in
it was answering included. The root [`../DEPLOY.md`](../DEPLOY.md), *Restarting*, shows
how to see each app's value without printing its environment, and how to set it; it is
the same for the game. Under systemd nothing is needed: `TimeoutStopSec` defaults to 90
seconds.

### The first restart onto this code needs a quiet moment

Two things the above relies on are not there yet the first time:

- **The process being stopped is the old code**, which has no handler: SIGINT ends it
  at once, whatever it was answering. That restart is the last one that cuts a request
  off.
- **Open pages keep the bundle they loaded**, and until each is reloaded it has none
  of this: no retries, no *Update ready*, and the old duel behaviour, in which a dropped
  duel leaves the Duel button doing nothing until the player switches mode.

So make the first restart at a quiet hour, as every restart was before it, and set the
`kill_timeout` and `STATUS_FILE` (below) in the same sitting.

### Signals

| Signal | What the game does |
|---|---|
| `SIGINT`, `SIGTERM` | Stops, as above: up to 8 seconds for the requests in flight, then exit 0 |
| `SIGHUP` | **Drains**, for a handover: stops listening, keeps every match to its end, and never exits by itself |
| `SIGUSR1`, `SIGUSR2` | **Never send these.** On Bun 1.3.13 one crashes the process and the other ends it before any handler runs |

Send any of them by exact PID — `pm2 pid <its name>`, or the `ps` line in
[`puzzledb/DEPLOY.md`](puzzledb/DEPLOY.md), *Before you start* — never with `pkill -f`.

**A terminal that goes away sends SIGHUP.** A game run in the foreground, in `tmux`, or
under `nohup` — which no longer protects it, because the game handles the signal —
drains when its terminal closes: the process stays up and nothing listens. Run it under
pm2 or systemd.

### The handover

The server can be replaced on one port with no gap. Both copies bind the port with
`SO_REUSEPORT` (`reusePort: true` in `server/index.ts`), so:

1. start the new release on the same `PORT` while the old one serves, with a status
   file of its own;
2. wait for that file to say `"state":"serving"`;
3. send the old process SIGHUP, by exact PID. It stops listening, after which every new
   connection reaches the new one; sends each lobby away with "The server is updating —
   open the lobby again"; keeps each match to its end, with no rematch; answers what
   still arrives on an old connection with `Connection: close`; and reports `draining`;
4. wait for its file to say `"state":"draining"` with `"duelsInMatch":0` and
   `"inflight":0`, or for 20 minutes at most, since it never exits by itself;
5. send it SIGTERM.

It needs a second process-manager entry for the game, with its own `STATUS_FILE`, and
the new release built where the new process serves it from. Nothing on this box is set
up that way yet; until it is, a deploy restarts the game as above.

**`reusePort` has a cost: a second copy no longer fails to start.** A stray second game
used to die with `EADDRINUSE`. Now it binds beside the first and quietly takes about
half the connections. Outside a handover, exactly one process listens:

```sh
ss -ltnp | grep ':3001\b'      # one pid. Two is a stray copy: stop it by its name or its exact PID
```

The puzzle database site does the opposite on purpose (`reusePort: false`): it never
hands over, so a second copy of it is always a mistake, and a refused bind is how that
gets noticed.

**The store waits for another writer.** Two game processes share `daily.sqlite` during
a handover, and `sync-archive` and `publish-archive` write to it too, so the store sets
`busy_timeout` to 5 seconds: a write that meets another's lock waits for it rather than
failing at once (`STORE_BUSY_TIMEOUT_MS` in `server/db.ts`).

### The status file — `STATUS_FILE`

With `STATUS_FILE` set to an absolute path, the game writes a small JSON file there
every 5 seconds, and at once on every change: its `pid`, `buildId` and `port`; its
`state` — `starting` while it migrates and loads, then `serving`, `draining` or
`stopping`; and counts — `duelsInMatch`, `lobbies`, `rushTicketsRecent` (rushes started
in the last 5 minutes 10 seconds, which may still be handed in), `sessionsRecent`
(players seen in the last 10 minutes) and `inflight`. Counts only: never an id or a
name. Its last write, at exit, says `stopping`. A file whose `updatedAt` is more than
20 seconds old belongs to a process that has stopped writing, and says nothing about
who is playing.

```sh
cat <the game's STATUS_FILE>; echo     # is anybody playing? duelsInMatch, lobbies, rushTicketsRecent
```

Set it in the process manager's environment — `env: { STATUS_FILE: "<abs path>" }` in
a pm2 ecosystem entry, `Environment=STATUS_FILE=<abs path>` in a systemd unit — and not
in `activity/.env`: every process needs a file of its own, and a second game started
from this directory would read the same `.env`. Put it outside the checkout, in a
directory the game's user can write, since each write goes to a temporary file beside
it and is renamed over the old one. Only the process that is the entrypoint writes it,
so `bun test`, which loads `activity/.env` too, never touches the live one.

### Which build it serves — `BUILD_ID`, `dist/build.json`, `X-Build-Id`

`bun run build` names the build: the id is `BUILD_ID` if that is set, else the
checkout's short commit (`git rev-parse --short HEAD`), else `dev`. It is compiled into
the page and written to `dist/build.json`, which the server reads once, at start-up —
falling back to `BUILD_ID`, then `dev`, when there is no file — and sends back as
`X-Build-Id` on every response, and in `/api/health`. A `BUILD_ID` that is not 1–64
letters, digits, dots, dashes or underscores fails the build, on purpose.

- **On a git checkout, set nothing**: the commit is the right id.
- **A `dev` build is never offered an update, and never offers one.** A box that builds
  with neither git nor `BUILD_ID` leaves every open page on its old bundle, silently.
- **Never put `BUILD_ID` in `activity/.env`.** It changes with every release, and a
  value there would name every build alike.
- **The site's build takes no part**: `build:puzzledb` writes no `build.json`, and the
  site's pages never offer an update.
- **`bun run dev:client` compiles in no id**, so a dev page never shows *Update ready*.
  To see the chip locally, build, then restart the server on a build with another
  `BUILD_ID`.

`GET /api/health` answers `{"ok":true,"buildId":"…","state":"serving"}` without touching
the database. It counts against the game's rate limit of 240 requests a minute, like
`/api/config`, so do not poll it fast.

---

## Verification

Run all of these. Each fails in a way the others do not catch.

**1. The server came up and knows what it is serving.** In the service log:

```
puzzle — day 247, 138 puzzles, resetting at midnight America/Los_Angeles, listening on :3001
```

Once anything has been accepted it reads `139 puzzles (1 from players)`. If a
page is missing from the build, a warning just above it names the page
(`[puzzle] the build at … is missing …`) — that warning is one you can act on.

**2. The backfill ran.** This is the ordering rule, checked.

```sh
bun -e 'import {Database} from "bun:sqlite";
        import {resolve} from "node:path";
        const p = resolve(process.env.DATABASE_PATH ?? "data/daily.sqlite");
        const db = new Database(p, {readonly: true});
        console.log("db:         ", p);
        console.log("day_puzzles:", db.query("SELECT count(*) c FROM day_puzzles").get().c);
        console.log("day_rush:   ", db.query("SELECT count(*) c FROM day_rush").get().c);
        console.log("runs:       ", db.query("SELECT count(*) c FROM runs").get().c);'
```

Expect `day_puzzles` to be roughly four times the current day number — three
times for any stretch of days pinned before the `extreme` tier existed — and
`day_rush` to be at least 1. **If `day_puzzles` is 0 the server has not started
successfully** — fix that before doing anything else, and before rebuilding the
puzzle data.

Check the other two lines as well. `db:` is the file actually being read, and
`runs:` must match the history this server really has — a `runs` of 0 on a
server that has been live means you are looking at a fresh empty database, not
at yours. That happens when `DATABASE_PATH` is set to a *relative* path and the
service does not run from `activity/`: the path resolves against the working
directory, and the store creates a new database rather than refusing. Nothing
else reports it. Stop and fix the path before restarting again, because the
backfill will pin history into the blank file.

**3. The game still works.**

```sh
curl -sI https://your-host/ | grep -i content-type      # text/html
curl -s  https://your-host/ | grep -o '<title>[^<]*'    # the game's title
```

**4. The review page is a different page from the game.** This catches a deploy
that skipped `bun run build`: `dist` is not in git, and the single-page fallback
answers `200` with the game for any path it cannot find.

```sh
curl -s  https://your-host/review | grep -o '<title>[^<]*'     # "Review queue — …"
curl -sI https://your-host/review | grep -i x-frame-options    # DENY
```

If the title is the game's, the build is stale. Re-run `bun run build`, restart.

That check answers "did a build ever run", which is not the same question as "does
this build contain the change I just deployed". Any bundle built since the review page
existed passes it, however old.

**On the box**, in `activity/`, you can ask the narrower question directly when the
change introduces a string only it has — a `localStorage` key, a new endpoint path:

```sh
grep -rlo "puzzle\.sittings\.v" dist/assets/*.js   # example: the sittings store
```

A filename means that string is in the bundle; nothing means it is not.

**Most client changes add no such string**, and then this tells you nothing — a
correct build looks identical to a stale one. Do not read a missing match as a stale
bundle unless you know the change adds the string you are grepping for. When it does
not, compare what the box is actually running instead:

```sh
git -C .. rev-parse HEAD          # the commit the box is on
ls -l dist/assets/*.js            # and whether dist is newer than that pull
```

This matters because a client-side fix fails quietly. The server is new, the page
loads, nothing errors, and the behaviour is simply the old one. It has happened here:
a player-reported fix was merged, the box was pulled and restarted, and players still
saw the bug because `dist` had not been rebuilt.

**For `beta 0.13`, the narrower check has its string**, and the migration has its own:

```sh
grep -l "Hide me on db.tetrisatuci.org" dist/assets/*.js    # a filename: the setting is in the bundle
grep -l "Every line on db.tetrisatuci.org" dist/assets/*.js  # nothing: the game's screens link nowhere
bun -e 'import {Database} from "bun:sqlite";
        import {resolve} from "node:path";
        const p = resolve(process.env.DATABASE_PATH ?? "data/daily.sqlite");
        const db = new Database(p, {readonly: true});
        console.log("players keyed:", db.query("SELECT COUNT(*) c FROM players WHERE public_key IS NULL").get().c === 0);
        console.log("servers:      ", db.query("SELECT COUNT(*) servers, COUNT(name) named FROM guilds").get());
        console.log("zone:         ", db.query("SELECT value FROM site_facts WHERE name = ?").get("time_zone")?.value);'
```

Expect `players keyed: true`, and the zone the start-up line names. Servers start
with no names — a name is recorded when a player signs in from that server — so
`named` grows as people open the activity. Counts only: never print `guild_id` or a
player's `id`.

The profile browser is the separate `beta 0.15` release. Its site checks are in
[`puzzledb/DEPLOY.md`](puzzledb/DEPLOY.md), *Verify it publicly*.

**5. The review routes are switched on** (only if you set `REVIEW_SECRET`):

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://your-host/api/review/queue
# 401 = on, and refusing you because you have no token. Correct.
# 404 = REVIEW_SECRET is unset, or the service did not pick up the .env change.
```

**6. The server serves the build you just made.**

```sh
cat dist/build.json; echo                                                    # {"buildId":"<short commit>"}
curl -s -D - -o /dev/null https://your-host/api/health | grep -i x-build-id  # the same id
curl -s https://your-host/api/health; echo                                    # {"ok":true,"buildId":"<the same>","state":"serving"}
```

The ids must match. Another one means the server started before the build finished,
or the process answering is not the one you restarted: restart it, and check that one
process listens (`ss -ltnp | grep ':3001\b'`). `dev` means the build found neither
`BUILD_ID` nor git, and no page will ever be offered the update. With `STATUS_FILE`
set, `cat` it too: `"state":"serving"`, the same `buildId`, and a fresh `updatedAt`.

Once, from inside the Discord activity if you can open its developer tools, check that
a response from `/api/…` carries `X-Build-Id`. If Discord's proxy or the tunnel strips
it, *Update ready* never appears and nothing else breaks; say so in your report.

---

## Using the review tool

From `activity/`, on this box:

```sh
bun run review-link -- zhiyuan
bun run review-link -- zhiyuan --minutes 30
```

It reads `REVIEW_SECRET` from `activity/.env`, prints a link, and exits. It
never opens the database, so it is safe to run while the service is up.

**What the link is worth.** Whoever holds it is the reviewer — it is a bearer
capability with nothing written down behind it. The link lasts fifteen minutes
by default and up to an hour with `--minutes 60`, the most the command accepts,
and the page trades it once for a two-hour session. Those two windows add up
rather than overlap: a link spent in its last second still buys a full two
hours, so the worst case is the link's own life plus two hours — three hours for
a sixty-minute link. **Send it in a DM, not a channel** — anywhere it can be
seen is somewhere it can be used.

The token rides in the URL *fragment* (`/review#t=…`), which a browser never
sends to the server. That keeps it out of the one copy nobody can be careful
with: the reverse proxy's access log. If you are shipping logs somewhere
central, links minted by older builds used `?t=` and are in there — rotating
`REVIEW_SECRET` retires them.

The name you pass is recorded against every accept and reject. It is an
attribution, not an authentication: nothing checks who ran the command. The
person with SSH to this box is the officer, and that is the real trust root.

**To revoke every outstanding link:** change `REVIEW_SECRET` and restart.

### The two tabs

**Queue** is the landing screen: puzzles players have sent, waiting on a
verdict. Accepting one assigns it an id in the community band (100000 and up)
and it joins the archive and the rotation **at the next restart**, or sooner if
somebody runs Discord's `/archive sync` without `dry_run`: that reloads the
whole archive in place, accepted puzzles included. The tool mentions only the
restart when you accept. Anyone may run a sync, at most once every 10 minutes,
but it is not a way to hurry one puzzle along: it also publishes whatever the
club's sheet holds.

**Archive** lists every puzzle, club and community, and corrects its metadata:
title, author, goal, difficulty and set. Nothing else — a board, queue, hold,
target or solution cannot be edited here, because runs are filed against a
puzzle id with no record of the board they were played on, so changing one
would rewrite what every solve already on the leaderboard was worth.

Three things to know before you use it:

- **Corrections live in SQLite, not in `data/puzzles.json`.** That file is
  rewritten wholesale by `bun run puzzles`, so a correction written there would
  die at the next rebuild. Surviving that rebuild is the whole reason the
  override layer exists.
- **Difficulty is rotation input.** It decides which of the four daily pools
  (easy, medium, hard, extreme) a puzzle is dealt from, and the order a rush
  stack comes in. Changing it moves the puzzle for **future** days only: every
  day already played is written down in `day_puzzles`, and a pinned rush stack
  keeps the difficulty it was dealt with.
- **Corrections reach players at the next restart**, like an accepted puzzle,
  or at the next Discord `/archive sync` without `dry_run`, which reloads the
  archive in place and reads every saved correction afresh. Neither reshuffles
  a day under players holding its prompt: the reload pins today's tiers and
  rush pool from the old pool before it swaps anything in. A correction still
  waits for the restart if its puzzle's board, queue, hold, target or clear
  requirement has changed since the server began serving it: that puzzle is
  served as it was, title and all.

Every correction and every revert is recorded per field in
`puzzle_override_log`, append-only, with the name from the review link. A
correction cannot stop the server booting. One the archive cannot use is
ignored, and if the corrections together would leave a daily tier empty,
every one of them is ignored; either way the puzzle is served as its source
wrote it, the service log says `[puzzle] ignoring …`, and the tool marks the
correction as on file but not in force. `puzzle_override_log` is how you find
out what changed and who changed it; the fix is one `DELETE` through the tool,
then a restart.

---

## Rolling back

The new tables are additive and the old code ignores them, so a rollback is
ordinary:

```sh
cd /path/to/BaronChairStair/activity
git checkout <the commit you noted>
bun install && bun run build
```

**Then restart the service.** `bun run build` rewrites `dist/` in place, so between
that command and the restart the box is serving the old server against the rolled-back
client. Do not stop after the build.

Rolling back to a commit whose `../changelog.json` has no `beta 0.21` takes this code's
restart behaviour with it: the stop is instant again, the status file stops being
written and goes stale, and pages loaded from the newer bundle hear no build and offer
nothing. Hand-ins from those pages still retry. If the bot had been restarted onto the
commit you are leaving, the root [`../DEPLOY.md`](../DEPLOY.md), *Rolling the bot back*,
has the one check to make before restarting it again.

Rolling back past the `beta 0.13` commit leaves its columns and tables in place, which
the older code ignores. A player that code signs in for the first time gets no key,
and the site treats a player with no key as hidden until this code is deployed again
and keys them. Roll the site back with it, by rebuilding and restarting it on the
older checkout: [`puzzledb/DEPLOY.md`](puzzledb/DEPLOY.md), *Rolling back*.

One thing to know: if you have already accepted a submission, the old code will
not load it — it reads puzzles only from `data/puzzles.json` — so the archive
returns to its previous size and the rotation returns to deriving from that
pool. That is consistent with the days already pinned, so nothing breaks.
Accept nothing until you are confident in the upgrade, and rollback stays free.

---

## Things that look wrong and are not

- **`serving the client build from /abs/path, which is outside the working
  directory`** at start-up. It loads fine; the message means this process is
  pinned to one checkout rather than to wherever it was started.
- **`/review` serving a page while `/api/review/*` answers 404.** The page is a
  static file and is always served; the routes behind it are what
  `REVIEW_SECRET` switches on.
- **An accepted puzzle not appearing immediately.** The archive is read at
  start-up, and again only when Discord's `/archive sync` (without `dry_run`)
  asks the activity to reload it. The puzzle appears at whichever comes first;
  the review tool, when you accept, mentions only the restart.
- **`day_puzzles` growing by four rows a day forever.** That is the design. It
  is a few hundred kilobytes a decade.
- **`[lifecycle] draining: no longer listening, 1 match(es) still being played`,
  and a process that stays up afterwards.** That is a drain, after SIGHUP. It never
  exits by itself; SIGTERM ends it. If nobody meant to start a handover, see the first
  item under *Things that are wrong*.
- **`[lifecycle] stopping with 2 request(s) unanswered`.** A stop's 8 seconds ran out
  with requests still open; they were cut. Rare, and logged so that it is not silent.
- ***Update ready* on open pages after a deploy.** That is the point of it. It goes once
  the player reloads.
- **A status file that says `stopping`** after the game has exited. That is its last
  write.

## Things that are wrong

- **The game's process is running but nothing listens on 3001**, and its log's last
  `[lifecycle]` line says `draining`. It was sent SIGHUP: its terminal closed (`tmux`,
  `nohup`), or somebody sent it. Stop it with SIGTERM by its exact PID, and start it
  under its service.
- **Two processes listen on 3001, and no handover is under way.** A stray second copy:
  `reusePort` let it bind without an error, and it takes about half the connections.
  Stop the one that is not the service, by its name or its exact PID.
- **Every page shows *Update ready* right after a build, and reloading does not clear
  it.** The server was not restarted after the build, and still names the old one.
  Restart it.
- **The service will not boot, and the error names an accepted puzzle** (an id
  of 100000 or more). It failed validation at load. The message gives its id. Undo that
  acceptance and restart:

  ```sh
  bun -e 'import {Database} from "bun:sqlite";
          import {resolve} from "node:path";
          const p = resolve(process.env.DATABASE_PATH ?? "data/daily.sqlite");
          const done = new Database(p).run(
            "UPDATE submissions SET status = ?, puzzle_id = NULL WHERE puzzle_id = ?",
            ["pending", Number(process.argv[1])]);
          console.log("rows changed:", done.changes);' <the id from the error>
  ```

  Then report it, because the accept route is meant to make that impossible.
- **`day_puzzles` is empty after a start that otherwise looked fine.** The
  backfill did not run. Do not accept anything and do not rebuild the puzzle
  data until you know why.
- **The service will not boot, and the error names a *rush pool member*.** A
  puzzle a pinned day was dealt has left `data/puzzles.json` — almost always
  because `bun run puzzles` rebuilt the file from a sheet that no longer has it.
  The pin refuses to re-derive rather than quietly deal a different puzzle, so
  the failure is loud on purpose. Two exits, and the first is the right one: a
  start checks only today's pool, so the day in the error is always today, and
  its rush is still being played:

  ```sh
  # Preferred: put the puzzle back in the sheet, re-export its two tabs as CSV
  # into tmp/ at the repository root (this reads those files, not the sheet),
  # and rebuild.
  bun run puzzles

  # Or, if that puzzle is genuinely gone for good, drop that day's pinned pool.
  # The day's four are unaffected; only the rush stack is re-derived. But that
  # day is today: everyone who plays its ranked rush from now on is dealt a
  # different forty from the runs already on its board, and a run started in
  # the last five minutes is scored against boards it was never shown.
  bun -e 'import {Database} from "bun:sqlite";
          import {resolve} from "node:path";
          const p = resolve(process.env.DATABASE_PATH ?? "data/daily.sqlite");
          const done = new Database(p).run("DELETE FROM day_rush WHERE day = ?", [Number(process.argv[1])]);
          console.log("rows changed:", done.changes);' <the day from the error>
  ```
