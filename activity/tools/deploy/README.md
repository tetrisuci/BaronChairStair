# The deploy tool

`bun run deploy` ships a commit to the production box without dropping a duel.
It builds each release in its own directory while players use the old one,
hands the game's port from one process to the next while the old one finishes
its matches, replaces the site outright, and restarts the bot only when the
bot changed and nobody is using it.

This file is the tool's reference. The deploy guides (`DEPLOY.md`,
`activity/DEPLOY.md`, `activity/puzzledb/DEPLOY.md`) each open with *On a box
migrated to releases*, which says which of these commands that guide's app
goes through, and they keep what to verify afterwards; where they and this
file differ, do the stricter thing. A box still running all three apps from
one checkout moves to this layout once, by *First-time migration*, at the
end of this file; until then the guides' manual steps apply unchanged.

## How it works

- **One directory per release.** `prepare` checks out `releases/<sha>/`,
  installs, runs every check and both builds there, and only then links the
  shared env files into it, so no check can load a secret or reach the live
  database. Nothing running is touched. A marker beside the release is
  written only when everything passed; nothing switches to a release without
  one.
- **The game hands over on one port.** Both game slots bind the port with
  `reusePort`. The idle slot starts on the new release; once its status file
  says it serves that exact build, and says so again from the same pid 5 s
  later, the live slot gets `SIGHUP`: it stops listening (every new
  connection now reaches the new process), keeps its matches going, and
  reports when it is drained. The new slot is watched all the while; once
  the old one has drained and the new one still serves, the old one is
  stopped. If the new slot never comes up, or does not stay up, it is
  stopped and the live slot was never touched. (The exception is a live slot
  running code from before the status contract: see `--allow-cold`.) If it
  dies once the drain has begun, the old slot is left running — it no longer
  listens, but its matches go on — and the switch stops, saying how to
  recover (*If a switch is interrupted*).
- **The site is replaced** (delete, start, wait for `/health`): it is
  stateless, and refuses to share its port, so a second or two of 502 is the
  whole cost. Its `/health` names no build, so an ok proves only that
  *something* answers the port — a site started by hand answers it while the
  new one dies with EADDRINUSE. So the port must be silent before the new
  site starts, and pm2 must show the new site online on one pid, and the same
  pid 5 s after `/health` first said ok.
- **The bot is restarted only if its files changed, and only when quiet.**
  One token cannot run two copies — they would answer every command twice —
  so the old process is deleted, confirmed gone, and only then is the new one
  started.

Everything the tool decides about a running process comes from that
process's status file (`activity/shared/runtime-status.ts`). Anything it
cannot read — missing, stale, written by a dead pid, naming another build —
counts as "no", so the tool waits or stops instead of guessing. A draining
slot whose status goes stale is *unknown*, not idle: the tool keeps waiting,
to the drain limit if need be, and ends the wait early only when the process
is gone (its pid dead, or a fresh status from a new pid because pm2 restarted
it).

## Layout

```
<home>/                        e.g. ~/bcs
  repo/                        a clone, used only to fetch and add worktrees
  releases/<sha>/              one detached worktree per release
    .env -> shared/bot.env                    linked once every check passed
    activity/.env -> shared/activity.env      linked once every check passed
    activity/data/solutions.json -> shared/solutions.json   (only if the box has one)
  releases/<sha>.prepared      the marker, beside its release: written only when every check passed
  shared/
    activity.env  bot.env  puzzledb.env
    daily.sqlite  stats.db  solutions.json
    backups/                   written by `backup`
    run/                       status files (<slot>.json, bot.json) and deploy.lock
    deploy.json                this tool's config
    ecosystem.config.cjs       generated; never edit it
  state.json                   which release each app runs, and the one before
```

## Configuration: `shared/deploy.json`

The tool reads `--config <file>`, else `$BCS_DEPLOY_CONFIG`, else
`~/bcs/shared/deploy.json`. Start from `deploy.example.json`. Every field is
checked, unknown fields are errors, and all problems are reported together.

| Field | Required | Meaning |
|---|---|---|
| `home` | yes | Absolute path of the layout above. |
| `pm2.bot`, `pm2.site` | yes | pm2 names of the bot and the site. |
| `pm2.gameSlots` | yes | Exactly two pm2 names that take turns on the game's port. |
| `gamePort`, `sitePort` | yes | The ports the proxy points at. They must differ. |
| `botPython` | yes | Absolute path of the bot's venv interpreter, outside any release. |
| `bun` | no | Absolute path of bun for every check and app. Default: the bun running the tool. |
| `drainLimitMinutes` | no, 20 | How long a draining game slot may keep its matches. |
| `botQuietSeconds` | no, 60 | How long the bot must have handled nothing to count as quiet. |
| `botQuietLimitMinutes` | no, 30 | How long a bot switch waits for quiet before giving up. |
| `keepReleases` | no, 3 | How many of the newest releases `prune` keeps. |
| `botFiles` | no | Globs; a change to a matching file means the bot changed. Default `client/**`, `server/**`, `package.json`, `bun.lock`, `changelog.json`. |

The four pm2 names must all differ, start with a letter, and not be `all`.
**The tool refuses to act on any pm2 app this file does not name.** DIAYN
runs under the same pm2 and must never be in it.

## Commands

Run from any prepared release (the tool is part of each one), inside `tmux`
or `screen`: a drain can take twenty minutes, and an SSH session that drops
meanwhile takes the tool with it (*If a switch is interrupted*). The apps
run under pm2 and never notice the terminal. The release the game runs now:

```
cd ~/bcs/releases/"$(bun -e 'console.log((await Bun.file(`${process.env.HOME}/bcs/state.json`).json()).game.release)')"/activity
bun run deploy <command>
```

| Command | What it does |
|---|---|
| `prepare <ref>` | `git fetch`; resolve `<ref>` (a branch means `origin/<branch>`); add the worktree; link `solutions.json`, if the box has one; `bun install --frozen-lockfile` at the root and in `activity/`; `py_compile` of `client/*.py` and the bot's `unittest`; `bun x tsc --noEmit`; `DATABASE_PATH=<release>/activity/data/prepare-test.sqlite bun test` (must report `0 fail`); `BUILD_ID=<sha> bun run build` (must record the sha in `dist/build.json`); `bun run build:puzzledb`; only then link `activity.env` and `bot.env`; the marker. Stops at the first failure, shows its output, and leaves the release no link into `shared/`. Re-running rechecks a failed release in place, its env links taken out first. Preparing a prepared release runs nothing, and puts back a link that went missing. |
| `backup [<ref>]` | `VACUUM INTO shared/backups/<daily\|stats>-<UTC time>-<sha>.sqlite` from a read-only connection. Refuses to overwrite a file, and refuses if either database is not in `shared/`. |
| `switch game <ref> [--allow-cold] [--force]` | The handover above. Timeouts: 90 s for the new slot to serve, then 5 s on one pid to show it stays up; `drainLimitMinutes` for the drain (progress every 30 s, saying "status stale" when the old slot has stopped writing). At the limit the old slot is stopped anyway, which ends its remaining matches with a "restarted" notice. If its process exits, or pm2 restarts it, mid-drain, it is stopped at once. If the new slot's process exits, or pm2 restarts it, mid-drain, or it does not serve again within 30 s once the drain is over, the switch stops with exit 1 and leaves the old slot running. Run again on the release `state.json` already records, it finishes an interrupted switch (*If a switch is interrupted*), and starts a slot if pm2 runs none on it. |
| `switch site <ref> [--force]` | Delete; refuse, with nothing started, if anything still answers the site's port after 10 s; start; wait up to 60 s for `/health` to answer `ok: true`; then confirm through pm2 that the new app is `online` on a live pid and on the same pid 5 s later. A failed check leaves the new app in pm2 for its logs, runs no `pm2 save`, keeps `rollback site` recorded, and says how to find what holds the port (`ss -ltnp`, `lsof`). |
| `switch bot <ref> [--now] [--force]` | If no `botFiles` file differs from the bot's release, records the new release without restarting. Otherwise waits up to `botQuietLimitMinutes` for quiet, deletes the old bot, checks its pid is gone, starts the new one and waits up to 120 s for `ready` on the new build. A bot pm2 does not run — stopped, errored or gone — is started, even on the release `state.json` already records. Refuses, changing nothing, when pm2 lists no bot but a fresh `shared/run/bot.json` names a live pid: a bot running out of this pm2's sight. |
| `deploy <ref> [--allow-cold] [--now] [--force]` | `prepare`, `backup`, then switch the game, the site and the bot. Stops at the first failure, saying what already moved and the `rollback` commands that move it back. It does not pause for the guides' checks between switches: see *A deploy, in the guides' order*. |
| `rollback game [--allow-cold]`, `rollback site`, `rollback bot [--now]` | Switches the app to the release `state.json` recorded as its previous one, with the same checks. Code goes back; data does not — that is what the backups are for. |
| `status [--wait-quiet [--timeout <minutes>]]` | One line per app. `--wait-quiet` waits (`--timeout`, default `botQuietLimitMinutes`) until no duel is in a match, no rush can still be handed in, and the bot is quiet; exit 1 if the time runs out. |
| `ecosystem` | Rewrite `shared/ecosystem.config.cjs` from `state.json`. |
| `prune [--keep <n>]` | Remove release worktrees beyond the newest `n` (default `keepReleases`), never one `state.json` names (current or previous), one a pm2 app runs from, or the one the tool runs from. `git worktree remove` takes each with its links (a link, never what it points at), then its marker goes. One git refuses — a locked worktree — is left whole, still prepared; one git gave up on part-way loses its marker, so nothing switches to what is left. |

Flags:

- `--dry-run` (any command): prints every command and file write that would
  change something — `would run: …`, `would write …` — and does none of them.
  Reads (pm2 jlist, git rev-parse and diff, status files) still run, so the
  plan is computed from the real box. The fetch is skipped, so refs resolve
  to what was fetched last.
- `--allow-cold`: the live game slot writes no status file (code from before
  the status contract, or hung), so it cannot drain — and code from before
  the contract binds the port without `reusePort`, so nothing can start
  beside it. The flag accepts a restart: the old slot is stopped *first*
  (`pm2 stop`), then the new one started, so the game is down until the new
  one serves and its duels end like a restart. The old slot's pm2 entry is
  deleted only once the new one serves; if the new one never does, the tool
  says the game is down, and `pm2 start <old name>` brings the old process
  back. Prefer the first-time migration's way: `pm2 stop` the old game
  yourself at a quiet hour, and switch with nothing running.
- `--now`: switch the bot without waiting for quiet. Required when the running
  bot writes no status file.
- `--force`: switch even when the app already runs that release (for the game,
  a restart that drops no duel), or the bot's files did not change.

A flag the command does not take (`switch bot main --timeout 5`,
`prune --force`) is refused with exit 2, never ignored. `--config` and
`--dry-run` go with any command.

Exit codes: 0 done; 1 the deploy stopped, and the message says why and what to
do; 2 the command line was wrong.

Example status:

```
game (puzzle-activity, abc1234): serving · 1 duel, 0 lobbies, 0 rushes, 3 sessions, 0 in flight
bot (bcs-bot, abc1234): ready · idle 14 min · no sync
site (puzzle-db, abc1234): online
```

## A deploy, in the guides' order

Each guide switches its app only once the one before it has passed that
guide's own checks, and the bot last of all, because its restart is what
makes the new release notes readable (`DEPLOY.md`). `deploy <ref>` runs the
three switches back to back, and between them checks only what the tool can
see: the game's status file, the site's `/health` and pm2. So it switches
the site before anyone has run the game's *Verification*, and restarts the
bot, and with it the notes, before anyone has checked what they describe.
On the box, go a step at a time instead, from the current release's
`activity/`, inside `tmux`:

```sh
bun run deploy --dry-run deploy <ref>   # the whole plan, from the real box; changes nothing
bun run deploy prepare <ref>            # ends "prepared <sha> in <its directory>": that sha from here on
bun run deploy backup <sha>
bun run deploy switch game <sha>        # then activity/DEPLOY.md, Verification
bun run deploy switch site <sha>        # then activity/puzzledb/DEPLOY.md, Check it on loopback and Verify it publicly
bun run deploy switch bot <sha>         # then DEPLOY.md, Verifying the bot, if it restarted
```

A check that fails is a stop (`CLAUDE.md`): report it and run nothing after
it. What already switched stays switched until `rollback <app>` takes it
back, latest first. `deploy <ref>` is the same commands without the pauses,
and the guides' order is the stricter of the two.

**A site taken down on purpose comes back at the next switch of the site.**
`switch site` starts the site whatever pm2 shows: a stopped entry is deleted
and started again on the release, and a missing one is simply started;
`deploy <ref>` and `rollback site` run it too. While the site must stay
down, deploy by the steps above without `switch site`, and never run
`switch site` or `rollback site` until whoever took it down says it may
come back.

## What each app is started with

The tool writes `shared/ecosystem.config.cjs` before every start; it lists only
what should run (a stopped slot left in it would start beside the live one on
the next `pm2 start` of the file).

| | script, args | cwd | environment |
|---|---|---|---|
| bot | `botPython client/discord_bot.py` | `releases/<sha>` | `BUILD_ID`, `STATUS_FILE=shared/run/bot.json`, `STATS_DB=shared/stats.db`, `DATABASE_PATH`, `PYTHONUNBUFFERED=1`, `PATH`; `kill_timeout` 30 s; `treekill: false`, so a stop reaches only the bot and its polite wait can let `/archive sync`'s and `/highlights`' child processes finish |
| game slot | `bun run server/index.ts` | `releases/<sha>/activity` | `NODE_ENV=production`, `PORT=gamePort`, `BUILD_ID`, `STATUS_FILE=shared/run/<slot>.json`, `DATABASE_PATH`, `PATH`; `kill_timeout` 15 s |
| site | `bun --env-file=shared/puzzledb.env puzzledb/server/main.ts` | `releases/<sha>/activity` | `PUZZLEDB_PORT=sitePort`, `BUILD_ID`, `DATABASE_PATH`, `PATH` |

All with `interpreter: "none"`, `exec_mode: "fork"`, `watch: false`.

- `DATABASE_PATH` is always `shared/daily.sqlite`. For the game and the site,
  an inherited variable beats both a `.env` Bun loads and an `--env-file`
  (checked on Bun 1.3.13), whatever `activity.env` and `puzzledb.env` say. Set
  the same path in both anyway, so commands run by hand from a release agree.
- **The bot is the other way round.** It loads `.env` (shared/bot.env) with
  `load_dotenv(..., override=True)`, so anything bot.env sets beats the
  ecosystem, for the bot and for the `bun run sync-archive` its `/archive sync`
  starts with the bot's environment. So **bot.env must not set
  `DATABASE_PATH`, `BUILD_ID`, `STATUS_FILE`, `STATS_DB`, `PATH` or
  `PUZZLE_ACTIVITY_DIR`** (unset, the sync runs in the bot's own release).
  `prepare` and `switch bot` refuse a bot.env that sets any of them, naming
  the variable and never its value. Only then is the file the game writes,
  the site reads, the bot's sync writes and `backup` copies one file.
- `PATH` puts bun's directory first (the bot's `/archive sync` and
  `/highlights` run bun), then the tool's own PATH with every
  `node_modules/.bin` taken out: `bun run deploy` puts the release's — and
  every ancestor directory's — in front, and baked into the ecosystem they
  would tie every app to the release the tool ran from, which a prune
  deletes. Commands the tool runs get the same PATH.
- Every command, and so every app pm2 starts, gets a **clean environment**
  (`PATH`, `HOME`, `USER`, locale, `PM2_HOME` and a few more). `bun run deploy`
  loads the `.env` of the directory it is started in — the game's secrets,
  from a release's `activity/` — and pm2 passes the starting shell's
  environment on to the app. Nothing of the tool's own environment is passed
  on, so the site never sees a secret it refuses to start with.

## Safety rules the tool enforces

- pm2 is used only for `jlist`, `start --only`, `stop`, `delete`,
  `sendSignal`, `save` — never `restart`, `reload`, `kill`, or anything for
  `all` — and only on the names in `deploy.json`.
- `pkill` and `killall` are never run. Processes are ended through pm2 by name.
- Only `SIGHUP` is sent. `SIGUSR1`/`SIGUSR2` are refused: Bun 1.3.13 dies on
  them before a handler runs.
- Never two bots: the old one is deleted and its pid confirmed gone before the
  new one starts. When pm2 lists no bot at all but a fresh status file names
  a live pid — `pm2.bot` renamed or mistyped, another user or `PM2_HOME`, or
  an old bot that outlived an earlier switch's `pm2 delete` — the switch
  refuses, naming the pid, before anything changes, and again on every run
  until that bot is gone.
- A switch refuses if the shared database the app would open is missing (the
  game and the bot would quietly create an empty one), and a release without
  its marker.
- `pm2 jlist` carries every app's environment; only name, pid, status and
  working directory are kept, and only for the config's apps. When jlist
  fails or prints something that does not parse, the error gives its exit
  code and the first line of stderr, never its output. Status files hold
  counts only, and bot.env is read for variable names only. Nothing the tool
  prints contains a secret or a Discord id.
- One deploy at a time (`shared/run/deploy.lock`); a lock left by a dead run is
  taken over. A dry run takes none.
- A stopped game slot is deleted from pm2, and `pm2 save` runs only after a
  switch succeeds, so a reboot never brings old code up beside new. A switch
  run again on the release `state.json` records takes out what an
  interrupted one left and saves. The old slot is never stopped while the new
  one is not serving.

## What a deploy looks like

Measured in a rehearsal on a Mac: the real tool, game and site, a stand-in
pm2, and a tiny database. The box is slower and its database larger, so read
these as shapes, not promises.

| Step | Took | What you see |
|---|---|---|
| `prepare` | about 33 s, `bun test` about 21 s of it | One `ok:` line per check. Nothing running is touched. |
| `switch game`, nothing to drain | about 1–1.5 s, plus the 5 s steadiness check added since | The new slot serves about 1 s after `pm2 start`. `rollback game` took 1.4 s. |
| `switch game` with a match going | as long as the match, up to `drainLimitMinutes` | New requests reach the new release from about 0.2 s after the drain signal, and none failed. A lobby on the old slot is closed (WebSocket close 1012, "handover") with "The server is updating"; a new lobby lands on the new slot; the match keeps going on the old one. `status` shows the new slot `serving · 0 duels` and the old `draining · 1 duel`. The old slot is stopped within about 5 s of its last match ending: the tool looks every 5 s. |
| `switch site` | about 1 s, then 5 s of pm2 checks | db.tetrisatuci.org answers 502 from the delete until the new site has built its first dataset and bound the port: under 200 ms on the tiny database, longer on the box's. The pm2 checks after that cost no gap. |
| `switch bot` | up to `botQuietLimitMinutes` for quiet, then up to 120 s for `ready` | Not rehearsed: the bot was never started there. |

What the rehearsal showed that is easy to misread:

- **A drain that runs to its limit.** The rehearsal's laptop slept mid-drain.
  On waking, the old slot's status was stale; the tool waited to the limit,
  then stopped it, and both players in the match got close 1012
  ("restart"). That is the design: a draining slot whose status goes stale
  is waited out, never cut short. On the box the same happens to a draining
  process that stalls.
- **Linux is not macOS while both slots are up.** macOS sent every new
  connection to the old process until it stopped listening; Linux spreads
  new connections across both. So on the box some reach the new slot in the
  seconds before the drain signal, which is harmless — it already serves — but
  was not rehearsed.
- **`0 sessions` during a duel.** Sessions are counted from HTTP requests, so
  a match played over its WebSocket alone shows none. Read the duels.
- **`/api/health` is rate limited** with the rest of `/api/*`, 240 a minute
  per caller: a prober at 5 a second got 429 after about 280 requests. Do not
  aim a fast external check at it from one address.
- **A stopped slot's status file stays** in `shared/run/` until that slot
  starts again. `status` asks pm2 first, so it misleads nothing.
- **A release's `git status` is clean.** The marker used to sit in the
  release's root, the one untracked file there, which made the site guide's
  last check (*Verify it publicly*: "`git status` from the repository root
  must be clean") red on every release. It is now `releases/<sha>.prepared`,
  beside the checkout; the links, `node_modules`, both builds and the test
  run's scratch database are all ignored.
- **Not rehearsed:** pm2 restarting a crashed app, and a reboot
  (`pm2 resurrect`); the stand-in pm2 did neither. Watch both the first time
  they happen on the box.

## If a switch is interrupted

`state.json` names the new slot as soon as it serves steadily, before the
drain, and pm2's list is saved only at the very end. If the tool stops in
between — Ctrl-C, an SSH session that drops while it runs outside `tmux`, a
pm2 command that failed — the old slot is left in pm2: still draining (it
never exits by itself, so its matches go on and nothing is lost), stopped,
or deleted with pm2's list not yet saved, so a reboot would bring the old
code back. **Run the same switch again** (`bun run deploy switch game <sha>`,
or the same `deploy <ref>`). When the slot `state.json` names is up and
serves that release, it finishes the job: an old slot still running is told
to drain again (harmless: one already draining ignores it) and waited for,
to the usual limit, then stopped; one stopped is deleted; and pm2's list is
saved. With nothing left over it only saves. The slot `state.json` names is
never the one taken out.

It refuses instead, touching nothing, when both slots run and it cannot
tell which to keep: `state.json` names neither, the switch asked for is to
another release, the slot it names does not serve, or the other writes no
status and so cannot be told to drain. The refusal names the slot to take
out when it can. Run `bun run deploy status`, and once that slot shows no
duel, take it out of pm2 — all three commands, by its name:

```
pm2 stop <the other slot>
pm2 delete <the other slot>
pm2 save
```

Stopped alone, it stays in pm2's table, and pm2's saved list brings it back
on old code at the next reboot. If `state.json` names neither running slot,
`status` shows which build each one serves, and the one to remove is the one
not on the release you meant.

**If the new slot dies mid-drain**, the switch stops at once with exit 1,
and the old slot is not stopped: it no longer listens, but it keeps its
matches to their end. Nothing may be answering the game's port. The error
names both ways back:

- **Start the new slot again.** pm2 may be restarting it already; if
  `status` shows it stopped or errored, `pm2 start <home>/shared/ecosystem.config.cjs
  --only <the new slot>`. Once `status` shows it serving the new build, run
  the same `switch game <sha>` again: it finishes the old slot's drain.
- **Roll back.** `pm2 stop <the new slot>`, then `bun run deploy rollback
  game`: it starts that slot on the previous release beside the old one,
  and only then finishes the old one's drain.

## Known limits

- **The bot's `/archive sync` runs the activity's tools from the bot's own
  release**, which a deploy that does not restart the bot leaves where it was.
  `botFiles` does not list `activity/**` by default. If a release changes the
  sync (`activity/tools/sync-archive.ts` or what it imports), switch the bot
  with `--force`, or add those paths to `botFiles`.
- A release from before the status contract cannot be switched to: the tool
  waits for a status file that never comes, then stops the new process.
- `pm2 logs <name>` stops working once an app is deleted; its output stays in
  `~/.pm2/logs/<name>-out.log` and `-error.log`.

## First-time migration, from the single checkout

Today the bot, the game and the site run from one checkout under pm2. The
move to this layout happens once. Steps 1–6 prepare it while everything keeps
running, and touch nothing that runs. Steps 7–11 are one sitting at a quiet
hour: each database must move into `shared/` while nothing has it open, and
the old game cannot hand over. Do every step on the box, as the user that
owns pm2's daemon, which is the game's user. Never touch DIAYN, and never run
`pm2 restart all`, `pm2 stop all` or `pm2 startup`.

**What the box runs is a claim until step 1 confirms it.** A survey on
2026-10-06 reported the bot as the pm2 app `yauna-badge`, the game as
`puzzle-activity` on port 3002 and the site as `puzzle-db` on port 3003,
behind nginx; the guides' own examples say 3001 and 3002. Use what step 1
finds, and stop if what it finds disagrees with itself.

**The release must carry the status contract** for the game, the bot and the
client — `beta 0.21` or later in `changelog.json`, and this tool in
`activity/tools/deploy/` — or the tool cannot switch to it (*Known limits*).

1. **Find how each app runs, and write it down.** This is also the way back
   if the move fails (*If the migration fails part-way*): the first switch of
   each app replaces its pm2 entry. In the checkout the apps run from:

   ```sh
   mkdir -p ~/bcs
   cd <checkout>
   git log --oneline -1    # the commit they run: the way back for code
   git status --short --untracked-files=no    # nothing: no tracked file changed on the box
   git log --oneline @{upstream}..HEAD        # nothing: no commit the remote lacks
   pm2 ls                  # every app by name, DIAYN's among them
   pm2 jlist | bun -e '
     import {existsSync} from "node:fs";
     const text = await Bun.stdin.text();
     const line = text.split("\n").filter((l) => l.trim().startsWith("[{") || l.trim() === "[]").pop();
     let apps;
     try { apps = JSON.parse(line ?? ""); } catch { console.log("pm2 jlist printed no list (output withheld); use pm2 ls"); process.exit(1); }
     const dir = process.argv[1];
     const SHOWN = ["NODE_ENV", "PORT", "PUZZLEDB_PORT", "PYTHONUNBUFFERED"];   // never secret: their values are kept
     for (const p of apps) {
       const e = p.pm2_env ?? {};
       const env = e.env ?? {};
       const ours = e.pm_cwd === dir || String(e.pm_cwd).startsWith(`${dir}/`);
       const how = ours ? {
         script: e.pm_exec_path, args: e.args, interpreter: e.exec_interpreter, kill_timeout: e.kill_timeout ?? "unset",
         env: Object.fromEntries(SHOWN.filter((k) => k in env).map((k) => [k, env[k]])),
         bunOnPath: String(env.PATH ?? "").split(":").some((d) => d !== "" && existsSync(`${d}/bun`)),
         envNames: Object.keys(env).sort(),
       } : {};
       console.log(JSON.stringify({ name: p.name, status: e.status, pid: p.pid, cwd: e.pm_cwd, ...how }));
     }' "$PWD" | tee ~/bcs/before-migration.txt
   chmod 400 ~/bcs/before-migration.txt
   ```

   **If either `git` check lists anything, stop and report it.** Step 6
   builds the release from the remote, so a tracked file changed on the box
   — `data/puzzles.json` from `bun run puzzles`, the tracked archive from
   `rederive-clears --write` or `sync-archive --db` — or a commit made here
   would be dropped without a word at the switch, and that can change which
   puzzles players are dealt: not the implementer's decision (`CLAUDE.md`).
   An error from the second (no upstream, or a detached head) is a stop too:
   it has not shown that nothing is unpushed.

   `pm2 jlist` on its own prints every app's environment, tokens included;
   this prints names, states and working directories, and, only for the apps
   that run from this checkout, how each is started: its script, arguments,
   interpreter and `kill_timeout`, the values of the four variables above
   that it has, whether its PATH has bun on it, and the **names** of the
   rest of its environment, never their values. pm2 gave each app the
   environment of the shell that started it; rollback step 3 needs to know
   what that was.

   **`~/bcs/before-migration.txt` is written once, here, and is the only
   record of the way back.** By step 10 the switched apps no longer run from
   the checkout, so a second run of this line would record nothing of how
   they started. Never run it again with its `tee`, and never edit, move or
   overwrite the file: the `chmod 400` makes a second `tee` fail
   ("Permission denied") rather than replace it. The re-checks below run the
   same line without the `| tee …`. Confirm from it:

   - **Exactly three apps run from this checkout**: the bot
     (`client/discord_bot.py`), the game (`server/index.ts`, from
     `activity/`) and the site (`puzzledb/server/main.ts`, from `activity/`).
     Their names are what `deploy.json` will use. If any of the three runs
     some other way — systemd, tmux — this procedure does not cover it: stop
     and report.
   - **DIAYN's app runs from its own checkout.** Its name never goes in
     `deploy.json`.
   - **One bot**: `pgrep -af 'discord_bot[.]py'` prints one line.

   Then the ports and the files:

   ```sh
   ss -ltnp | grep -E 'bun|python'                                 # each listening port, with its pid
   pm2 pid <the game>; pm2 pid <the site>                          # whose pids those are
   sudo nginx -T 2>/dev/null | grep -nE 'server_name|proxy_pass'   # which hostname goes to which port
   ls -l /proc/"$(pm2 pid <the game>)"/fd | grep -F .sqlite        # the game's database: the file that moves
   ls -l /proc/"$(pm2 pid <the site>)"/fd | grep -F .sqlite        # the same file
   grep -cE '^[[:space:]]*(export[[:space:]]+)?STATS_DB=' .env     # 0: the bot's stats are <checkout>/stats.db
   ```

   `gamePort` and `sitePort` are the ports the proxy sends each hostname to,
   and the apps must listen on those now: the tool sets each app's port
   itself, whatever the env files say. If a hostname goes through cloudflared
   instead of nginx, its ingress names the port (`activity/puzzledb/DEPLOY.md`,
   *Put db.tetrisatuci.org in front of it*, shows how to find it). If
   `STATS_DB` is set, the path it names is the bot's stats file wherever this
   says `<checkout>/stats.db`, and step 3 takes the line out.

2. **Make the home**, and clone:

   ```sh
   mkdir -p ~/bcs/releases ~/bcs/shared/run ~/bcs/shared/backups
   chmod 700 ~/bcs/shared    # it will hold the env files, the databases and their backups
   git clone "$(git -C <checkout> remote get-url origin)" ~/bcs/repo
   ```

   The tool looks for `~/bcs/shared/deploy.json` by default. A home anywhere
   else needs `BCS_DEPLOY_CONFIG=<home>/shared/deploy.json` on every command.

3. **Copy the env files and the answer keys** — copy, not move: the old
   checkout keeps running on its own until the sitting.

   ```sh
   cp <checkout>/activity/.env          ~/bcs/shared/activity.env
   cp <checkout>/.env                   ~/bcs/shared/bot.env
   cp <checkout>/activity/puzzledb/.env ~/bcs/shared/puzzledb.env
   chmod 600 ~/bcs/shared/*.env
   [ -f <checkout>/activity/data/solutions.json ] && cp <checkout>/activity/data/solutions.json ~/bcs/shared/solutions.json
   ```

   - **`DATABASE_PATH`, absolute**, in `activity.env` and `puzzledb.env`:
     `<home>/shared/daily.sqlite`, written out (`/home/<user>/bcs/…`), never
     `~` or a relative path. The ecosystem gives every app that path anyway,
     and for the game and the site it beats the files; the files are what
     the guides' commands read when run by hand from a release.
   - **What the deploy owns, out of `bot.env`.** The bot loads bot.env over
     the environment the ecosystem gives it, so an old `PUZZLE_ACTIVITY_DIR`
     or `DATABASE_PATH` there would send `/archive sync` to the old
     checkout's database. By name only, never a value, then delete them and
     check again:

     ```sh
     grep -nE '^[[:space:]]*(export[[:space:]]+)?(DATABASE_PATH|BUILD_ID|STATUS_FILE|STATS_DB|PATH|PUZZLE_ACTIVITY_DIR)[[:space:]]*=' ~/bcs/shared/bot.env | cut -d= -f1
     sed -i -E '/^[[:space:]]*(export[[:space:]]+)?(DATABASE_PATH|BUILD_ID|STATUS_FILE|STATS_DB|PATH|PUZZLE_ACTIVITY_DIR)[[:space:]]*=/d' ~/bcs/shared/bot.env
     ```

     `prepare` and `switch bot` refuse the file while any of them is there.
   - **`BUILD_ID` and `STATUS_FILE`, out of `activity.env`** too, where
     `activity/DEPLOY.md` never puts them: the ecosystem sets both per slot.
     `grep -nE '^(BUILD_ID|STATUS_FILE)=' ~/bcs/shared/activity.env | cut -d= -f1`
     should print nothing.

4. **A venv outside any release** for `botPython`. The bot needs
   `discord.py`, `aiohttp`, `python-dotenv` and `matplotlib`
   (`DEPLOY.md`, *What it needs*); install the discord.py version the bot
   runs today (`<its interpreter> -m pip show discord.py`), so the move
   changes nothing else:

   ```sh
   python3 -m venv ~/bcs/shared/venv
   ~/bcs/shared/venv/bin/pip install discord.py==<that version> aiohttp python-dotenv matplotlib
   ~/bcs/shared/venv/bin/python -c 'import discord, aiohttp, dotenv, matplotlib; print("ok", discord.__version__)'
   ```

   The venv the bot uses now may serve instead if it lives outside the old
   checkout. One inside it does not: that checkout goes away eventually.

5. **Write `shared/deploy.json`** from `deploy.example.json`, with what step 1
   found. With the survey's names it would read:

   ```json
   {
     "home": "/home/<user>/bcs",
     "pm2": { "bot": "yauna-badge", "gameSlots": ["puzzle-activity", "puzzle-activity-b"], "site": "puzzle-db" },
     "gamePort": 3002,
     "sitePort": 3003,
     "botPython": "/home/<user>/bcs/shared/venv/bin/python"
   }
   ```

   - The bot's and the site's names as they are, so nothing else that knows
     them changes.
   - The game's name as `gameSlots[0]`, which the first switch starts the new
     game under, and as `gameSlots[1]` a name no pm2 app has.
   - **Never DIAYN's name.** The tool acts on every name this file gives it,
     and on nothing else.

6. **Prepare the first release.** The tool lives inside releases, so this
   one run uses the clone; every later one runs from a release.

   ```sh
   cd ~/bcs/repo/activity
   bun install --frozen-lockfile
   bun run deploy status                   # reads deploy.json and pm2; changes nothing
   bun run deploy --dry-run prepare main
   bun run deploy prepare main             # ends "prepared <short sha> in <its directory>": note both
   ls ~/bcs/shared/daily.sqlite 2>/dev/null && echo STOP || echo absent
   ```

   - The release's directory is named by the full commit,
     `~/bcs/releases/<40 characters>`; the short sha before it is only
     a label. Steps 10 and 11 `cd` into that directory, and give the short
     sha to the switches, which take either.

   - `status` names the three apps, the game and the bot `online · no status
     file`: old code writes none. A config error is reported here, all
     problems at once.
   - `prepare` took about 33 s on a Mac, `bun test` about 21 s of it; expect
     longer here, and about 100 skips if no `solutions.json` was copied
     (`0 fail` is the check). A red step is a stop (`CLAUDE.md`): report it.
   - The last line must say `absent`. `bun test` ran with `DATABASE_PATH`
     set to a scratch file in the release, and `activity.env`, which names
     `shared/daily.sqlite`, was linked only after it, so no test can have
     made that file; if one is there all the same, step 9 would move the
     live database onto it. Remove nothing, and report it.

   The switches cannot be dry-run yet: each refuses until the databases are
   in `shared/`, which is step 9.

7. **At a quiet hour, stop all three.** The old game predates the drain: it
   cannot hand over, has no handler for pm2's stop, and ends at once whatever
   it was answering, duels included. Old code writes no status file, so
   nothing tells you who is playing: the quiet hour is the only check, as it
   was for every restart before the status files.

   ```sh
   pgrep -af 'sync[-]archive'           # nothing: no /archive sync is running
   pm2 stop <the bot>
   pm2 stop <the site>
   pm2 stop <the game>
   pm2 ls                               # those three stopped, DIAYN as it was
   pgrep -af 'discord_bot[.]py'         # nothing
   ss -ltnp | grep -E ':(<gamePort>|<sitePort>)\b'    # nothing
   ```

   By name, never `all`. **The bot too, before anything moves:** while it
   runs from the old checkout, an `/archive sync` runs `sync-archive` against
   the old database path, and once that file has moved, the sync creates a
   new empty one there and writes into it.

   This is the first game switch's cold start, done by hand. `--allow-cold`
   is the tool's way of stopping an old game it finds running, and here none
   may be running: the database cannot move while the game has it open. From
   here until step 10's switches serve, the game, the site and the bot are
   down.

8. **Back up both databases**, before anything moves. From
   `<checkout>/activity`, with the paths step 1 found:

   ```sh
   bun -e 'import {Database} from "bun:sqlite";
           import {existsSync} from "node:fs";
           const [from, to] = process.argv.slice(1);
           if (!existsSync(from)) throw new Error(`${from} is not there`);
           if (existsSync(to)) throw new Error(`${to} exists already`);
           const db = new Database(from, {readonly: true});
           db.run("VACUUM INTO ?", [to]);
           db.close();
           console.log("backed up", from, "->", to);' <the game's database> ~/bcs/shared/backups/daily-before-migration.sqlite
   ```

   The same again with `<checkout>/stats.db` and
   `~/bcs/shared/backups/stats-before-migration.sqlite`. Each must print its
   line, and `ls -l ~/bcs/shared/backups/` must show both files. `VACUUM
   INTO`, never `cp` (`activity/DEPLOY.md`, *Before you start*, has the
   measurement), and `import`, never `require`, so a failure is printed
   rather than swallowed. It is what `backup` does: a read-only connection,
   which cannot change the database it copies, and the target bound as a
   parameter, so no path can break the statement. These copies hold real
   Discord ids: they stay in `shared/backups/`.

9. **Move the databases into `shared/`**, each with its `-wal` and `-shm`
   when they exist. The `-wal` can hold nearly all the data
   (`activity/DEPLOY.md` measured 4 KB beside 997 KB), so a main file moved
   without it loses it:

   ```sh
   DB=<the game's database>
   ST=<checkout>/stats.db
   ls ~/bcs/shared/daily.sqlite* ~/bcs/shared/stats.db* 2>/dev/null     # nothing: never move onto a file
   for s in "" -wal -shm; do [ -e "$DB$s" ] && mv -n "$DB$s" ~/bcs/shared/daily.sqlite"$s"; done
   for s in "" -wal -shm; do [ -e "$ST$s" ] && mv -n "$ST$s" ~/bcs/shared/stats.db"$s"; done
   ls -l ~/bcs/shared/daily.sqlite* ~/bcs/shared/stats.db*              # both, with whatever came beside them
   ls "$DB"* "$ST"* 2>/dev/null                                         # nothing left behind
   ```

   If the first `ls` lists anything, stop: something made a database there,
   and moving onto it would lose one of the two.

10. **Switch, in the guides' order, checking as you go**, from the release:
    each app only once the one before it has passed its own guide's checks,
    and the bot last of all. A check that fails is a stop (`CLAUDE.md`): go
    to *If the migration fails part-way* rather than retrying blind.

    The game first:

    ```sh
    cd <the directory step 6's last line named>/activity    # ~/bcs/releases/<the full sha>/activity
    bun run deploy --dry-run switch game <sha>
    bun run deploy switch game <sha>
    ```

    With nothing running, a switch simply starts its app: the stopped entry
    of the same name is deleted and replaced, and a stopped bot is not waited
    on for quiet. Then all of `activity/DEPLOY.md`'s *Verification*, from
    this release's `activity/` (its `.env` is `shared/activity.env`): "Run all
    of these. Each fails in a way the others do not catch." In step 2 the
    backfill's `runs:` line must also match the history this box has, or the
    database did not move with its data.

    Only once that has passed, the site:

    ```sh
    bun run deploy --dry-run switch site <sha>
    bun run deploy switch site <sha>
    ```

    Then `activity/puzzledb/DEPLOY.md`'s *Check it on loopback* and *Verify
    it publicly*, on `sitePort`, from this release's `activity/`, all the
    way to its last check, that `git status` from the repository root is
    clean.

    Only once *Verify it publicly* has passed, the bot (rule 2 of the site's
    guide: its start is what makes the new release notes readable, and a
    note should not describe a site that is not up yet). The guides restart
    the bot only if its own code changed; here it did by construction — the
    release carries the status contract the old bot's code lacks — and step 7
    stopped it, so it is switched whatever `git diff` says. Then
    `DEPLOY.md`'s *Verifying the bot*:

    ```sh
    bun run deploy --dry-run switch bot <sha>
    bun run deploy switch bot <sha>
    bun run deploy status    # the game serving, the bot ready, the site online, all on <sha>
    ```

    The site stays down while the game is verified, and the bot until the
    site has been verified publicly: at a quiet hour that is the price of the
    guides' order. If a switch fails, it says what it stopped; go on to *If
    the migration fails part-way*.

11. **Finish.**

    ```sh
    pm2 ls                                  # the bot, one game slot and the site online; DIAYN as it was
    pm2 save                                # each switch saved already; once more, with the list as it should stay
    systemctl is-enabled "pm2-$(id -un)"    # enabled. Never run pm2 startup again
    ```

    Step 1's `jlist` line, run again from `<checkout>` **without its
    `| tee ~/bcs/before-migration.txt`** (ending at `"$PWD"`), shows each
    app's `cwd` under `~/bcs/releases/<the full sha>`; to keep that too,
    end it `| tee ~/bcs/after-migration.txt` instead. `before-migration.txt`
    stays as step 1 wrote it. Keep the old checkout, untouched, until the new
    layout has run through a few deploys: it is the only way back to code
    from before the move. Do not pull it, build in it or start anything from
    it; its `activity/puzzledb/ecosystem.config.cjs` is superseded by
    `shared/ecosystem.config.cjs`. A database that appears again at the old
    path (`ls "$DB"`) means something still runs from the old checkout.

After this, a deploy goes from the current release a step at a time, with
each guide's checks between the switches (*A deploy, in the guides' order*),
`--dry-run` first, inside `tmux`; each guide's *On a box migrated to
releases* says what is left to check.

### If the migration fails part-way

Steps 1–6 leave the running apps alone. If one fails, stop and report it;
`~/bcs` holds copies of the secrets, so leave it for whoever looks next, or
delete it once nobody needs it.

From step 7 on, put the box back the way step 1 found it:

1. **Take out what the tool started**: each app whose working directory is
   under `~/bcs/releases/` — `pm2 stop <name>`, then `pm2 delete <name>`, by
   name. Step 1's `jlist` line shows which, run again from `<checkout>`
   **without its `| tee …`** (ending at `"$PWD"`):
   `~/bcs/before-migration.txt` must stay as step 1 wrote it, because step 3
   starts the old apps from it. Leave an entry whose `cwd` is still the old
   checkout: that is the old app, stopped, and step 3 starts it again. Then
   `pgrep -af 'discord_bot[.]py'` prints nothing, and nothing listens on the
   two ports. (Before step 10 the tool has started
   nothing: skip this.)
2. **Put the databases back** where step 1 found them, each with its `-wal`
   and `-shm`: step 9's loops the other way round, with `DB` and `ST` set as
   they were there.

   ```sh
   for s in "" -wal -shm; do [ -e ~/bcs/shared/daily.sqlite"$s" ] && mv -n ~/bcs/shared/daily.sqlite"$s" "$DB$s"; done
   for s in "" -wal -shm; do [ -e ~/bcs/shared/stats.db"$s" ] && mv -n ~/bcs/shared/stats.db"$s" "$ST$s"; done
   ```

   A database the new code opened goes back as it is: this code migrates
   only by adding, which the old code ignores (`activity/DEPLOY.md`,
   *Rolling back*). Use step 8's backups only if a database is damaged —
   copy the backup to the old path, with no `-wal` or `-shm` beside it — and
   say so in your report: whatever was played since step 7 is then lost.
3. **Start the old apps again, game first and bot last.** An app the tool
   never switched still has its stopped entry: `pm2 start <its name>`. An
   app the tool switched has lost its old entry — a switch deletes the
   stopped entry and starts its own under that name — so start it afresh
   from the old checkout as `~/bcs/before-migration.txt` records it:
   `pm2 start <script> --name <name> --cwd <cwd> --interpreter <interpreter> --kill-timeout <ms> -- <args>`,
   leaving out `--kill-timeout` where the record says `"unset"` (pm2's own
   default then applies, as it did). The site goes the way its own guide
   starts it, `pm2 start puzzledb/ecosystem.config.cjs` from
   `<checkout>/activity`, if that is how it ran.

   **The environment does not come back by itself.** pm2 hands the starting
   shell's environment to the app, and the switched app's old entry, which
   held the environment of whatever shell first started it, is gone. So, for
   each app started afresh:

   - Start it from a shell that exports no secret: the site refuses to start
     with the game's.
   - Where the record says `"bunOnPath": true`, `command -v bun` must print a
     path in that shell first (`DEPLOY.md`, *Restarting*): the old bot's
     `/archive sync` and `/highlights` run bun from its PATH.
   - Give it back the record's `env` values on the start's own command line,
     for example `NODE_ENV=production PORT=<the recorded port> pm2 start …`
     for the game, `PYTHONUNBUFFERED=1 pm2 start …` for the bot.
   - A name in its `envNames` that is none of those, not in the app's own
     `.env`, not in the shell you start from, and not pm2's own bookkeeping
     (names beginning `PM2_` or `pm_`, `unique_id`, a key named after a pm2
     app) came from the shell that first started it. Stop and report it, by
     name only: its value was never recorded, and guessing it is not a way
     back.
4. **Check, then save.** `pm2 ls` shows the three online, from the old
   checkout, and `pgrep -af 'discord_bot[.]py'` one bot; then the guides'
   verification; then `pm2 save`. Each switch the tool finished saved the new
   layout, so until this save, a reboot brings back the releases.
5. **Leave `~/bcs` as it is**, and report what failed and what you put back.
