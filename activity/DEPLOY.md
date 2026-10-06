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
bun run build            # writes dist/, including dist/review/index.html
```

**Skips are expected here.** `data/solutions.json` holds the answer keys and is
not in git, so a box without it reports around 100 tests skipped rather than
failed — the ones that need a reference solution to build a solving log. `0
fail` is the thing to check. A number of skips that is suddenly zero means the
answers are on this box; a *failure* is what stops a deploy.

Then restart the service the way this box already starts it.

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
the setting's link points at the new site, the setting hides players there, and the bot must not
restart while `beta 0.13` or `beta 0.15` is unverified — the root [`../DEPLOY.md`](../DEPLOY.md)
and [`puzzledb/DEPLOY.md`](puzzledb/DEPLOY.md), rule 2, have the gate.

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

The profile browser is the separate `beta 0.15` release. Its site checks and bot
restart gate are in [`puzzledb/DEPLOY.md`](puzzledb/DEPLOY.md), rule 2; do not
restart the bot while that note is carried and **Players** and **Solves** have not
been verified publicly.

**5. The review routes are switched on** (only if you set `REVIEW_SECRET`):

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://your-host/api/review/queue
# 401 = on, and refusing you because you have no token. Correct.
# 404 = REVIEW_SECRET is unset, or the service did not pick up the .env change.
```

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

Rolling back past the `beta 0.13` commit leaves its columns and tables in place, which
the older code ignores. A player that code signs in for the first time gets no key,
and the site treats a player with no key as hidden until this code is deployed again
and keys them. Roll back the site with it, and check the note went too:
[`puzzledb/DEPLOY.md`](puzzledb/DEPLOY.md), *Rolling back*.

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

## Things that are wrong

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
