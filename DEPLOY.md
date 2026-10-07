# Deploying — start here

This repository is **two projects and a site**, deployed separately:

| | Where it lives | Its deploy guide |
|---|---|---|
| **The Discord bot** | the repository root and `client/` | this file |
| **The activity** (the puzzle itself) | `activity/` | [`activity/DEPLOY.md`](activity/DEPLOY.md) |
| **The puzzle database site** (db.tetrisatuci.org) | `activity/puzzledb/` — its own process, build and `.env` | [`activity/puzzledb/DEPLOY.md`](activity/puzzledb/DEPLOY.md) |

They have different `package.json` files, different `.env` files, and different
commands. Running one's commands from the other's directory is the commonest way a
deploy goes sideways, and in one direction it does not even fail — see below.

This file is the *operational* half: what to set, how to restart, how to tell whether it
worked. [`README.md`](README.md) describes what the commands do and is the better place
to start if you want to know what `/report` *is*.

**The order, when a deploy touches more than one: the activity, then the site, then
the bot — and the bot only if its own code changed.** The bot calls exactly three of the
activity's routes — it reads `/api/today` and `/api/recap`, and `/archive sync` posts to
`/api/bot/reload-archive` — and the current release changes none of them. An activity
older than the reload route costs only a delay: the sync still publishes, and its reply
says the puzzles go live at the activity's next restart. So neither half can be broken
by the other being older. The activity goes first because it is the half with an
ordering rule inside it, and the half worth having your full attention.

**The bot keeps running throughout a deploy.** A pull does not reach it: the bot holds
the Python and the release notes it loaded when it started, and since `beta 0.17` it
posts no release notes by itself — not when it starts, and not at `/puzzle play`. So
there is nothing to keep stopped across a deploy, and nothing a restart by anyone, for
any reason, could announce. (Two things it runs as fresh subprocesses do come from the
checkout, and are the pulled code from the pull on: `/highlights`' replay bridge, and
the `bun run sync-archive` behind `/archive sync`.)

**Restart it last, briefly, and only when its code or `changelog.json` changed** — once
the game and the site are verified by their own guides. The restart is what makes the
new release notes readable: the bot reads `changelog.json` once, when it starts, and
`/puzzle changelog` shows what it read, privately, to whoever asks. A note that
describes the site or the game should not be readable before what it describes is
verified, which is why the bot comes last; but it is not an announcement, and a
rollback and another restart take it back.

**Whether this deploy needs the restart is a question about the commit the running bot
started on, not the one before this pull.** A deploy that stopped short of its bot step
— a site that failed verification, a sync that would not finish — leaves the checkout
ahead of the bot, and the next pull's own diff does not show what that one brought. So,
from the repository root, find what the bot loaded:

```sh
cat <the bot's STATUS_FILE>; echo     # "buildId": the commit it started on, when the deploy sets BUILD_ID
```

Without a status file, or with `"buildId":"dev"`, use the commit written down when the
bot was last started — **write it down at every restart**, as *Restarting* says. Then:

```sh
git diff --stat <the commit the running bot started on> HEAD -- client changelog.json   # nothing listed: leave the bot running
```

If you have neither, or are unsure, restart it: since `beta 0.17` a restart announces
nothing and costs players only the moment it is down. *Restarting* below has the steps.

On a box migrated to releases the deploy tool makes this check itself and does the restart:
*On a box migrated to releases*, below.

**One exception: a bot that would start on code from before `beta 0.17`.** That code
posts, at each server's next `/puzzle`, every release note the server has not been told
about, in the channel, and a post cannot be withdrawn. Only a rollback can bring that
about; *Rolling the bot back*, below, has the check.

---

## On a box migrated to releases

On a box moved to the release layout — pm2 runs the bot from `~/bcs/releases/<sha>/`
(`pm2 describe <its name> | grep 'exec cwd'`), and `~/bcs/state.json` exists — the bot
goes through the deploy tool, [`activity/tools/deploy/`](activity/tools/deploy/README.md),
not through *Restarting* below. Its README has the detail; what it means for the bot:

| This guide | On a migrated box |
|---|---|
| The `git diff` above, deciding whether the bot restarts | `switch bot <ref>` decides: it restarts the bot only if a `botFiles` file changed (by default `client/**`, `server/**`, `package.json`, `bun.lock`, `changelog.json`), and otherwise records the release and leaves the bot running |
| *Restarting*: `py_compile`, a quiet moment, the old one stopped before the new, `kill_timeout` | `prepare` compiles and tests the bot with the venv in `deploy.json`. The switch waits for quiet from the bot's status file (`--now` skips the wait), deletes the old bot and confirms its pid is gone before starting the new one, and waits for `ready` on the new build. The ecosystem gives it a 30-second `kill_timeout` |
| *Rolling the bot back* | `rollback bot [--now]`, to the release `state.json` recorded. Every release the tool prepared carries `beta 0.17`, so that check matters only for going back past the migration, to the old checkout |
| The root `.env` | `shared/bot.env`, linked into each release. It must not set `DATABASE_PATH`, `BUILD_ID`, `STATUS_FILE`, `STATS_DB`, `PATH` or `PUZZLE_ACTIVITY_DIR`: the deploy sets them, and the bot loads `.env` over them. `prepare` and `switch bot` refuse a file that does |
| `stats.db` at the repository root | `shared/stats.db`, which the deploy names in `STATS_DB` |

**This guide's order is the switches one at a time, with the checks between them:**
`prepare`, `backup`, `switch game` and the activity's *Verification*, `switch site` and
the site's *Verify it publicly*, and only then `switch bot`, from the current release's
`activity/`, `--dry-run` first each time (the tool's README, *A deploy, in the guides'
order*, has the commands). `bun run deploy deploy <ref>` runs the same switches back to
back, with only the tool's own checks between them, so it restarts the bot, and makes
the new release notes readable, before anyone has verified the game or the site. Do the
stricter thing and switch one at a time. Either way, *Verifying the bot* below still
applies, and the pm2 name is the one in `shared/deploy.json`, never DIAYN's.

**`/archive sync` runs the activity's `sync-archive` from the bot's own release**, which
moves only when the bot is switched. A release that changes `activity/tools/sync-archive.ts`,
or what it imports, reaches `/archive sync` with `switch bot <ref> --force`, or by adding
those paths to `botFiles` in `shared/deploy.json`, after which a plain `switch bot`
restarts the bot for them (the tool's README, *Known limits*).

A box not yet migrated follows this guide as it stands, and moves by the tool's
*First-time migration*. The manual steps below stay the path for a box not yet
migrated, and the fallback for one whose migration was rolled back — never for a bot
running from `releases/`, where a fix is a new release.

---

## Two directories, and one that lies to you

- `bun run build` from the repository root fails loudly — `Script not found "build"`.
  Good. The root `package.json` has no scripts at all.
- **`bunx tsc --noEmit` from the root succeeds and does not check the activity.** The
  root `tsconfig.json` has `include: ["server"]`, which is the *root* `server/`
  directory — `server/server.ts`, the NDJSON engine bridge the bot talks to. It is a
  real check; it is simply not the activity's. The activity's typecheck must be run from
  `activity/`.
- The Python half runs from the repository root: `python3 -m unittest discover -s client`
  is run from the root, not from `client/`.

---

## The bot

### What it needs

**Python 3.10 or newer.** `client/discord_bot.py` exits at start-up on anything older,
with a message naming the version it found. Its dependencies are `discord.py`,
`aiohttp`, `python-dotenv` and `matplotlib`.

`matplotlib` is not optional and is easy to miss: `discord_bot.py:95` imports
`presence_tracker`, which imports it at module scope, so the bot does not start
without it — it is not only needed by the graph command that uses it.

**The replay commands need one more thing.** `/highlights` and
`build_snapshots.py` spawn a TypeScript bridge (`server/server.ts`) that imports
`@haelp/teto`, so run `bun install` **at the repository root** once. Bun can
resolve the package on its own when there is no `node_modules` at all, so a
fresh box may work without this — run it anyway, so the version is the one
`bun.lock` pins rather than whatever the registry serves at the moment somebody
asks for a replay.

**`/archive sync` needs Bun too.** It runs `bun run sync-archive` as a
subprocess inside the activity checkout — the `activity/` beside this file, or
`PUZZLE_ACTIVITY_DIR` — so `bun` must be on the bot process's own PATH (a
systemd unit takes that from its own `Environment=`, not from the shell profile
Bun's installer edits), and that checkout needs its own `bun install`. Anyone
may run it, at most once every 10 minutes; when it last started is kept in
`stats.db`, so a restart does not reopen the window. Nothing to configure — a
`puzzle-admins.json` left over from the old officer allowlist is no longer read
and can be deleted. Everything else runs on Python alone.

Use the interpreter that actually runs the bot, not a bare `python3` — a system
interpreter usually has none of these installed:

```sh
pgrep -af discord_bot.py     # what is running now, and with which interpreter
```

### Environment — the repository-root `.env`

Copy `example.env` to `.env` and fill it in. To see which keys are present without
printing any values:

```sh
grep -oE '^[A-Z_][A-Z0-9_]*=' .env | tr -d '='
```

| Key | Needed for | Unset means |
|---|---|---|
| `DISCORD_TOKEN` | everything | the bot does not start |
| `PUZZLE_APP_ID` | the launch link | `/puzzle play` cannot build its button |
| `PUZZLE_API` | `/puzzle play`'s day number for recap replies; the recap; `/archive sync` telling the activity to reload | `/puzzle play` posts only the launch link, with "puzzle details are unavailable right now"; the recap has nowhere to read from; a sync publishes, but the activity is not told |
| `PUZZLE_API_KEY` | the recap; `/archive sync` telling the activity to reload | the recap never posts; once a day is owed, the log names the key every 5 minutes (`recap failed for guild …`); a sync publishes, but the activity is not told |
| `PUZZLE_RECAP` | the recap | the recap is off — the default, because it pings every player it names |
| `GITHUB_TOKEN` | `/report` | `/report` answers "Reports aren't wired up yet" |
| `GITHUB_REPO` | `/report` | as above |

`PUZZLE_API_KEY` must match `BOT_API_KEY` in `activity/.env` — **different names on
either side**, which is easy to get wrong. The two failures look different: a mismatch
is a `401`, an unset key on the server is a `404`.

### Settings a deploy may set

Five more, all optional, all in [`example.env`](example.env), and each explained in
[`docs/bot.md`](docs/bot.md#under-a-deploy), *Under a deploy*:

| Key | What it is | Unset means |
|---|---|---|
| `STATUS_FILE` | An absolute path the bot rewrites every 5 seconds and on every change: `starting`, `ready` or `stopping`, the commands it is handling (`inflight`), and whether `/archive sync` is running (`syncRunning`). Counts only — no id, name or token | no file. A relative path is logged and no file is written |
| `BUILD_ID` | The release's commit, which that file reports | `dev` |
| `STATS_DB` | An absolute path for `stats.db` | `stats.db` at the repository root, as it always was |
| `BOT_SHUTDOWN_GRACE_S` | How long a stop waits for the commands already running | 20 seconds |
| `FORCE_COMMAND_SYNC` | `1` writes the slash commands at the next start whatever the stored hash says | the commands are written only when they changed |

**Set each in exactly one place: the process manager's environment, or `.env`, never
both.** The bot loads the root `.env` with `override=True`, so a line there beats the
environment pm2 or systemd gives it, for every key on this page. A `STATUS_FILE` in
both, with different values, has the bot writing a file nobody reads. **`BUILD_ID`
never goes in `.env`**: it changes with every release, and a value there would name
one build for all of them. When the process manager sets these, `.env` must not, and
this says so without printing a value:

```sh
grep -cE '^(STATUS_FILE|STATS_DB|BUILD_ID)=' .env    # 0
```

**`STATS_DB` stays unset on a box that runs the bot from one checkout.** If it is ever
set, copy the existing file there first, with the bot stopped —
`sqlite3 stats.db ".backup '<the new path>'"` — or the bot starts on an empty one: it
forgets the recap claims, so a recap can post twice, and the `/archive sync` window
reopens. A relative `STATS_DB` stops the bot at start-up, with a message saying so.

### Turning on `/report`

It ships inert until both keys exist:

```
GITHUB_TOKEN=<fine-grained PAT>
GITHUB_REPO=tetrisuci/BaronChairStair
```

**The token must be a fine-grained personal access token**, scoped to the single
repository named by `GITHUB_REPO`, with **Issues: Read and write**. Not a classic token,
and nothing that can push code. GitHub's own UI will also attach a mandatory,
non-removable **Metadata: Read-only** — expected, not removable, and two permissions is
the correct end state.

Issues are authored by whichever account mints the token. If you would rather player
reports did not appear under a maintainer's name, mint it from a dedicated bot account
with write access to that one repository.

**Understand what you are enabling.** `/report` publishes text typed by anybody in the
Discord server, under the bot's identity, to a public issue tracker. What stands between
that and abuse:

- Fifteen reports per player per hour, sixty per server per hour. Both live in memory, so
  **both reset when the bot restarts**.
- Reporter text is defanged in `client/report_text.py`: `@mentions` and all four of
  GitHub's issue-autolink forms (`#26`, `GH-26`, `owner/repo#26`, and the organisation
  form) are neutralised with an empty HTML comment, so a report cannot ping a team or
  post a backlink into an unrelated repository.
- Control characters become spaces — every one in a title, and all but line breaks in
  the report itself, so steps to reproduce keep their lines. That is C0 and DEL only:
  zero-width and direction-override characters pass through untouched.
- A filed report replies **in the channel**, so the club can see a bug is already
  known. Anything about the *player* replies privately — too long, too often, and
  "not set up yet" — because "you have filed fifteen reports this hour" is not
  something to read out in front of everybody, and neither is your own missing
  `GITHUB_TOKEN`. A GitHub outage is the one public failure, because it is about
  the world rather than about this club and the next person will hit it too. The
  player is told their display name will be public *before* they submit, in the
  command's own field description.
- **Before the keys are set, `/report` answers privately and spends nobody's
  quota.** That is the state you are in while reading this, so it is worth
  knowing the command is safe to leave registered while you finish.

That layer has tests, and they need no install:

```sh
python3 -m unittest discover -s client     # 293 run, 0 fail; a bare python3 without discord.py skips 18
```

### Restarting, and making a new command appear

*Last in a deploy, once the game and the site are verified, and only when `client/` or
`changelog.json` changed — the top of this file says why and how to tell. This is the
path for a box not yet migrated to releases, and the fallback; on a migrated box it is
`switch bot`, above.*

Find how the bot actually runs on this box. Look, do not guess:

```sh
systemctl list-units '*bot*'; pm2 list; tmux ls; pgrep -af discord_bot.py
```

Stop the old process before starting the new one. **Two instances on one token
double-handle every command**, which presents as the bot answering everything twice.

**Write down the commit it starts on**, wherever this box keeps its deploy notes — the
next deploy's restart check, at the top of this file, compares against it when the bot
has no status file or its `buildId` reads `dev`:

```sh
git log --oneline -1     # from the repository root, just before starting the bot
```

**This box runs a second bot, DIAYN, the club's internship finder.** It has its
own service (the pm2 app or systemd unit named `diayn`), its own checkout, its own
`.env` and its own token, and its repository's DEPLOY.md is its guide. Act on this
bot by its own name only:

- never `pm2 restart all` or `pm2 stop all`, which take DIAYN down too;
- `pm2 save` records every app `pm2 list` shows, so check that both are listed as
  you want them before saving;
- `pm2 startup` is set up once per user, so do not run it again.

Before restarting, confirm every module the bot imports still parses. `discord_bot.py`
imports fourteen of the files under `client/` at module scope, so a syntax error in any
one of them is a start-up crash rather than a degraded feature:

```sh
<venv-python> -m py_compile client/*.py sync_guilds.py
```

**A glob, not a list**, and for the reason the section above exists. The list this
replaces named six files and missed four that `discord_bot.py` imports at module scope —
`build_snapshots`, `render`, `teto_client`, and `presence_tracker`, which is the very
import this page has just finished explaining is easy to miss. With a syntax error in
`presence_tracker.py` the old command exited 0 while the bot could not start, which is
precisely the failure it is run to catch. The glob compiles a few files the bot does not
import, which costs nothing, and cannot fall out of step as modules are added.

**Then pick a moment no command would be cut off.** A stop is polite, but it does not
wait for everything:

```sh
pgrep -f 'sync[-]archive' >/dev/null && echo "a sync is running" || echo "no sync"
cat <the bot's STATUS_FILE>; echo     # if it sets one: "syncRunning":false and "inflight":0
```

On SIGINT — pm2's own stop — or SIGTERM — systemd's, and `kill`'s — the bot reports
`stopping`, answers every new slash command privately (a `!` command gets the same
words as a reply) with "Restarting — try again in a few seconds." instead of running
it, waits up to `BOT_SHUTDOWN_GRACE_S` (20 seconds by
default) for the commands already running, closes its Discord connection and exits 0.
A second signal stops the wait. **`/archive sync` can run five minutes, and the stop
does not wait for it**: stopped part-way, the sync loses its reply and its reload, and
can leave rows synced but not published. So stop the bot only while no sync runs. The
`pgrep` line sees the sync's own process whether or not the bot writes a status file;
the brackets keep it from matching a shell that runs it. It prints no command line on
purpose: the sync's own names who ran it (`--by discord:<name>`).

**Never send the bot SIGHUP, SIGUSR1 or SIGUSR2.** It handles none of them, and SIGHUP
kills it outright, with no grace. SIGHUP means "hand over" to the game; the bot cannot
hand over, because one token delivers each command to one connection, so it only stops
and starts.

**Under pm2 or systemd, the stop must reach the bot's own process only.** Two commands
run a child process: `/highlights` (and `!highlights`) runs the replay bridge,
`bun server.ts`, for the length of the command, and `/archive sync` runs
`bun run sync-archive`. pm2's stop signals every process in the app's tree unless the
app has `treekill: false`, and systemd's default `KillMode=control-group` sends SIGTERM
to every process in the unit. Either way the child is signalled at the same moment as
the bot. The bridge has no handler and dies at once, so a `/highlights` the grace was
waiting for fails with "Unexpected error" instead of finishing.

**First check that the process the manager tracks is the bot itself**, because both
settings below send the stop to that one process and no further:

```sh
ps -o args= -p "$(pm2 pid <the bot's name>)"                             # under pm2
ps -o args= -p "$(systemctl show -p MainPID --value <the bot's unit>)"   # under systemd
```

It must show the venv's python running `client/discord_bot.py`. A shell, a script, or
`bash -c 'source .venv/bin/activate && python client/discord_bot.py'` is a wrapper, and
a wrapper does not pass the stop on. Under pm2 with `treekill: false` the bot then never
hears it; once `kill_timeout` runs out pm2 SIGKILLs the wrapper's PID alone, the bot
stays connected, and the restart starts a second bot on the same token. Under systemd
with `KillMode=mixed` the wrapper dies on the SIGTERM and the SIGKILL that follows takes
the bot with no grace at all. So point the entry at the interpreter first — in pm2, the
venv python's absolute path as `script` with `args: ["client/discord_bot.py"]` and
`interpreter: "none"`; in systemd, `ExecStart=<venv python's absolute path>
client/discord_bot.py` — or make the wrapper `exec` the interpreter as its last line.
Then:

- **under pm2, `treekill: false`** — pm2 then signals the bot alone, and only the bot
  decides when its children end: a running `/highlights` finishes inside the grace;
- **under systemd, `KillMode=mixed`** in the unit's `[Service]` — SIGTERM then goes to
  the bot's main process alone, and only the final SIGKILL, once the bot has exited or
  `TimeoutStopSec` has run out, reaches whatever is left in the unit.

Neither saves an `/archive sync`, which the stop does not wait for: it still loses its
reply and its reload, as above. Until the bot's entry has one of these, stop it only
when no child runs: the status file's `"syncRunning":false` and `"inflight":0` (which
counts a `/highlights` while it runs), or, with no status file, the `pgrep` line above
and nobody's `/highlights` in flight.

**Under pm2, the app's `kill_timeout` must be longer than the grace** — 25000 for the
default 20 seconds. pm2's own default is 1600 ms, after which it kills the bot part-way
through the wait, and a command in flight is lost again. To see what each app has
without printing anything else (`pm2 jlist` on its own prints every app's environment,
tokens included, so never print it):

```sh
pm2 jlist | bun -e 'let a; try { a = JSON.parse(await Bun.stdin.text()); } catch { console.log("pm2 jlist printed no list (output withheld)"); process.exit(1); } for (const p of a) console.log(p.name, "kill_timeout:", p.pm2_env?.kill_timeout ?? "unset (pm2 uses 1600)", "treekill:", p.pm2_env?.treekill ?? "unset (pm2 uses true)")'
```

Set both where the app is defined: `kill_timeout: 25000` and `treekill: false` in its
ecosystem entry, or `--kill-timeout 25000 --no-treekill` on the `pm2 start` that
created it. pm2 takes them when it starts the app from that definition, which for an
app already running means `pm2 delete <its name>` and starting it afresh. A fresh start
also hands the app this shell's environment and PATH, so check `command -v bun` first
(`/archive sync` needs it), then check the line above shows the new values, then
`pm2 save`.

Under systemd, `TimeoutStopSec` defaults to 90 seconds, longer than the grace, and
`KillMode` is the one line to add. To see both without printing the unit's environment:

```sh
systemctl show <the bot's unit> -p KillMode -p TimeoutStopUSec    # KillMode=mixed
```

Add `KillMode=mixed` under `[Service]` (`sudo systemctl edit <the bot's unit>` keeps it
in a drop-in), then `sudo systemctl daemon-reload`.

**After every restart, `pgrep -af discord_bot.py` must list exactly one process**, and
its PID must be the one the `ps` check above asks the manager for. A second line is
either a wrapper still in front of the bot (go back to that check) or an old bot that
outlived its stop and is still answering beside the new one. Stop the old one by its
exact PID — `kill -TERM <pid>`, which gives it the grace — and never with `pkill -f`.

**A new slash command needs a restart to appear.** The command tree is synced by
`_sync_global_commands()`, called from the `on_ready` handler and nowhere else — there
is no manual sync command. It writes the commands only when they differ from the last
sync, whose hash it keeps in `stats.db`, so a start that changed nothing logs
`commands unchanged since the last sync (…); skipped.` and a start that ships a new
command logs `commands synced (…)`. The hash cannot see Discord's side change — another
copy of the application syncing a different tree, or commands deleted in the developer
portal — so after either, set `FORCE_COMMAND_SYNC=1` for one start and take it out
again. A global sync can take up to an hour to propagate. To push the tree into one
guild immediately, and tidy up afterwards, see [README.md](README.md#standalone-tools):

```sh
<venv-python> sync_guilds.py <SERVER_ID>            # instant, one guild
<venv-python> sync_guilds.py --clear <SERVER_ID>    # once the global ones land
```

### Verifying the bot

1. It connected — the log prints `Logged in as <bot user> (id: …)` at the end of
   `on_ready`, after the command sync's own line (`commands synced (…)` or
   `commands unchanged since the last sync (…); skipped.`); a reconnect can print both
   again. It does not list the guilds. It goes to stdout, unlike the lines below, so a
   bot not run on a terminal and started without `python -u` or `PYTHONUNBUFFERED=1` can
   hold it back for a long time; under a service, `/puzzle play` answering is the surer
   sign. With `STATUS_FILE` set, the file says `"state":"ready"` from the same moment,
   with a fresh `pid`.
2. `/puzzle play` returns the launch button, and the activity opens from it.
   `/puzzle changelog count:5` requests five changes privately, attaching all
   selected notes as `puzzle-changelog.txt` if the inline preview is too long.
   Launching the activity posts no release notes to the channel.
3. The daily recap is **off unless `PUZZLE_RECAP=on`**, and the log says so at start-up
   (`puzzle recap off: …`). Turning it on posts the previous day's recap as soon as the
   bot starts, then one a day. If it is on and does not post, read the log. An unset
   `PUZZLE_API_KEY` is named in a `recap failed for guild …` line; a key that does not
   match `BOT_API_KEY` in `activity/.env` shows just above it as
   `puzzle /api/recap… -> HTTP 401` (a `404` if `BOT_API_KEY` is unset).
4. `/report` appears in the command list. Run it, pick a category, type a description,
   and confirm the issue appears at
   <https://github.com/tetrisuci/BaronChairStair/issues>. **Close your test issue
   afterwards.** "Reports aren't wired up yet" means the two GitHub keys did not reach
   the process.

### Rolling the bot back

On a box migrated to releases, `bun run deploy rollback bot` (above). On one that is
not, the bot's code is the checkout's, so moving it back is the activity's rollback —
[`activity/DEPLOY.md`](activity/DEPLOY.md), *Rolling back* — followed by a bot restart
as above, if the bot had been restarted onto the commit you are leaving. Before that
restart, ask the checkout you are going back to, from the repository root:

```sh
bun -e 'const r = (await Bun.file("changelog.json").json()).releases; console.log(r.some((x) => x.version === "beta 0.17") ? "carries beta 0.17: posts no release notes" : "older than beta 0.17: would post release notes")'
```

**`older than beta 0.17` is a stop.** A bot started on that code posts, at each
server's next `/puzzle`, every release note that server has not been told about, in
the channel, and that cannot be withdrawn. Do not restart it: leave the bot running on
the code it loaded, and report it.

---

## The activity

See [`activity/DEPLOY.md`](activity/DEPLOY.md), which is complete and specific. Five
things from it are worth knowing before you begin, because each is easy to get wrong
and four of them fail silently:

- **There is an ordering rule.** Start the new code, and confirm the backfill ran,
  *before* the puzzle pool next changes. Getting it wrong writes plausible but wrong
  history for days nobody played, and nothing reports it.
- **`TRUST_PROXY=true` must be set in `activity/.env` if anything fronts the server**
  (cloudflared, nginx, Caddy). Without it every player shares one rate-limit bucket and
  starts collecting 429s. This is the loud one: in production the server warns at
  start-up (`[limits] TRUST_PROXY is not set …`). Only the exact lowercase `true` counts.
- **`DATABASE_PATH` must be absolute, or unset.** A relative value resolves against the
  working directory, and if that is not `activity/` the server creates a brand-new empty
  database rather than refusing — it boots, and every leaderboard is gone.
- **Back up with `VACUUM INTO`, never `cp`.** The database is in WAL mode, and on this
  project the main `.sqlite` file has been measured at 4 KB against a 997 KB `-wal`
  beside it. A `cp` of the main file alone produced a database in which the tables did
  not exist.
- **A restart waits for hand-ins now, and the process manager must let it.** On SIGINT
  or SIGTERM the game stops listening, gives the requests in flight up to 8 seconds and
  exits 0; pm2's default `kill_timeout` of 1600 ms kills it part-way, so give the game's
  pm2 app at least 10000. And the manager must run Bun on `server/index.ts`, with
  `NODE_ENV=production` in its environment, not `bun run start`: the script runner
  passes the stop on as well, so the game hears one stop twice. It now takes a repeat
  inside 2 seconds as the same stop, but a stop handler from before that exits at
  once on it, and run on the file the manager's PID is the game's own.
  *Restarts and handovers* in that guide has this, the signals, the handover and the
  status file.

The `DATABASE_PATH` trap has a companion worth stating here: **Bun reads `.env` from the
process working directory only.** It does not look beside the entrypoint and does not
walk up. So `activity/.env` reaches the running service only if the process starts in
`<abs>/activity`, or whatever starts it passes the file in some other way. Under systemd
that is `WorkingDirectory=<abs>/activity` or `EnvironmentFile=<abs>/activity/.env`;
under pm2, the app's `cwd`; in a `tmux` session, the directory the command was run from.
Check which yours does before editing that file, or your edits will have no effect and
nothing will say so:

```sh
systemctl cat <the-unit> | grep -iE 'Environment|WorkingDirectory|ExecStart'
pm2 describe <the-app> | grep -iE 'exec cwd|script path'
```
