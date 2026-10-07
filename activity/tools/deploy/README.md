# The deploy tool

`bun run deploy` ships a commit to the production box without dropping a duel.
It builds each release in its own directory while players use the old one,
hands the game's port from one process to the next while the old one finishes
its matches, replaces the site outright, and restarts the bot only when the
bot changed and nobody is using it.

This file is the tool's reference. The deploy guides (`DEPLOY.md`,
`activity/DEPLOY.md`, `activity/puzzledb/DEPLOY.md`) say when to use it and
what to verify afterwards; where they and this file differ, do the stricter
thing.

## How it works

- **One directory per release.** `prepare` checks out `releases/<sha>/`,
  links the shared env files into it, installs, runs every check and both
  builds there. Nothing running is touched. A marker file is written only
  when everything passed; nothing switches to a release without one.
- **The game hands over on one port.** Both game slots bind the port with
  `reusePort`. The idle slot starts on the new release; once its status file
  says it serves that exact build, the live slot gets `SIGHUP`: it stops
  listening (every new connection now reaches the new process), keeps its
  matches going, and reports when it is drained. Then it is stopped. If the
  new slot never comes up, it is stopped and the live slot was never touched.
- **The site is replaced** (delete, start, wait for `/health`): it is
  stateless, and refuses to share its port, so a second or two of 502 is the
  whole cost.
- **The bot is restarted only if its files changed, and only when quiet.**
  One token cannot run two copies — they would answer every command twice —
  so the old process is deleted, confirmed gone, and only then is the new one
  started.

Everything the tool decides about a running process comes from that
process's status file (`activity/shared/runtime-status.ts`). Anything it
cannot read — missing, stale, written by a dead pid, naming another build —
counts as "no", so the tool waits or stops instead of guessing.

## Layout

```
<home>/                        e.g. ~/bcs
  repo/                        a clone, used only to fetch and add worktrees
  releases/<sha>/              one detached worktree per release
    .env -> shared/bot.env
    activity/.env -> shared/activity.env
    activity/data/solutions.json -> shared/solutions.json   (only if the box has one)
    .bcs-prepared              the marker: written only when every check passed
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

Run from any prepared release (the tool is part of each one):

```
cd ~/bcs/releases/<sha>/activity && bun run deploy <command>
```

| Command | What it does |
|---|---|
| `prepare <ref>` | `git fetch`; resolve `<ref>` (a branch means `origin/<branch>`); add the worktree; link shared files; `bun install --frozen-lockfile` at the root and in `activity/`; `py_compile` of `client/*.py` and the bot's `unittest`; `bun x tsc --noEmit`; `bun test` (must report `0 fail`); `BUILD_ID=<sha> bun run build` (must record the sha in `dist/build.json`); `bun run build:puzzledb`; the marker. Stops at the first failure and shows its output. Re-running rechecks a failed release in place. |
| `backup [<ref>]` | `VACUUM INTO shared/backups/<daily\|stats>-<UTC time>-<sha>.sqlite` from a read-only connection. Refuses to overwrite a file, and refuses if either database is not in `shared/`. |
| `switch game <ref> [--allow-cold] [--force]` | The handover above. Timeouts: 90 s for the new slot to serve, `drainLimitMinutes` for the drain (progress every 30 s). At the limit the old slot is stopped anyway, which ends its remaining matches with a "restarted" notice. |
| `switch site <ref> [--force]` | Delete, start, wait up to 60 s for `/health` to answer `ok: true`. |
| `switch bot <ref> [--now] [--force]` | If no `botFiles` file differs from the bot's release, records the new release without restarting. Otherwise waits up to `botQuietLimitMinutes` for quiet, deletes the old bot, checks its pid is gone, starts the new one and waits up to 120 s for `ready` on the new build. |
| `deploy <ref> [--allow-cold] [--now] [--force]` | `prepare`, `backup`, then switch the game, the site and the bot. Stops at the first failure, saying what already moved and the `rollback` commands that move it back. |
| `rollback game\|site\|bot [--allow-cold] [--now]` | Switches the app to the release `state.json` recorded as its previous one, with the same checks. Code goes back; data does not — that is what the backups are for. |
| `status [--wait-quiet] [--timeout <minutes>]` | One line per app. `--wait-quiet` waits (default `botQuietLimitMinutes`) until no duel is in a match, no rush can still be handed in, and the bot is quiet; exit 1 if the time runs out. |
| `ecosystem` | Rewrite `shared/ecosystem.config.cjs` from `state.json`. |
| `prune [--keep <n>]` | Remove release worktrees beyond the newest `n` (default `keepReleases`), never one `state.json` names (current or previous), one a pm2 app runs from, or the one the tool runs from. |

Flags:

- `--dry-run` (any command): prints every command and file write that would
  change something — `would run: …`, `would write …` — and does none of them.
  Reads (pm2 jlist, git rev-parse and diff, status files) still run, so the
  plan is computed from the real box. The fetch is skipped, so refs resolve
  to what was fetched last.
- `--allow-cold`: the live game slot writes no status file (code from before
  the status contract, or hung), so it cannot drain. Accept stopping it
  outright, which ends its duels like a restart.
- `--now`: switch the bot without waiting for quiet. Required when the running
  bot writes no status file.
- `--force`: switch even when the app already runs that release (for the game,
  a restart that drops no duel), or the bot's files did not change.

Exit codes: 0 done; 1 the deploy stopped, and the message says why and what to
do; 2 the command line was wrong.

Example status:

```
game (puzzle-activity, abc1234): serving · 1 duel, 0 lobbies, 0 rushes, 3 sessions, 0 in flight
bot (bcs-bot, abc1234): ready · idle 14 min · no sync
site (puzzle-db, abc1234): online
```

## What each app is started with

The tool writes `shared/ecosystem.config.cjs` before every start; it lists only
what should run (a stopped slot left in it would start beside the live one on
the next `pm2 start` of the file).

| | script, args | cwd | environment |
|---|---|---|---|
| bot | `botPython client/discord_bot.py` | `releases/<sha>` | `BUILD_ID`, `STATUS_FILE=shared/run/bot.json`, `STATS_DB=shared/stats.db`, `DATABASE_PATH`, `PYTHONUNBUFFERED=1`, `PATH`; `kill_timeout` 30 s |
| game slot | `bun run server/index.ts` | `releases/<sha>/activity` | `NODE_ENV=production`, `PORT=gamePort`, `BUILD_ID`, `STATUS_FILE=shared/run/<slot>.json`, `DATABASE_PATH`, `PATH`; `kill_timeout` 15 s |
| site | `bun --env-file=shared/puzzledb.env puzzledb/server/main.ts` | `releases/<sha>/activity` | `PUZZLEDB_PORT=sitePort`, `BUILD_ID`, `DATABASE_PATH`, `PATH` |

All with `interpreter: "none"`, `exec_mode: "fork"`, `watch: false`.

- `DATABASE_PATH` is always `shared/daily.sqlite`. An inherited variable beats
  both a `.env` Bun loads and an `--env-file` (checked on Bun 1.3.13), so the
  file the game writes, the site reads, the bot's `/archive sync` writes and
  `backup` copies is one file, whatever the env files say. Set the same path
  in `activity.env` and `puzzledb.env` anyway, so commands run by hand from a
  release agree.
- `PATH` puts bun's directory first: the bot's `/archive sync` and
  `/highlights` run bun.
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
  new one starts.
- A switch refuses if the shared database the app would open is missing (the
  game and the bot would quietly create an empty one), and a release without
  its marker.
- `pm2 jlist` carries every app's environment; only name, pid, status and
  working directory are kept, and only for the config's apps. Status files
  hold counts only. Nothing the tool prints contains a secret or a Discord id.
- One deploy at a time (`shared/run/deploy.lock`); a lock left by a dead run is
  taken over. A dry run takes none.
- A stopped game slot is deleted from pm2, and `pm2 save` runs only after a
  switch succeeds, so a reboot never brings old code up beside new.

## If a switch is interrupted

`state.json` names the new slot as soon as it serves, before the drain. If the
tool is stopped mid-drain, both slots stay up — the old one never exits by
itself — and the next switch refuses ("both game slots are running"). Run
`bun run deploy status`; when the slot `state.json` does not name has no duel
left, `pm2 stop <that name>` and `pm2 delete <that name>`, then `pm2 save`.

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

## First-time setup, from the single checkout

Today all three apps run from one checkout under pm2. The move happens once, in
one sitting at a quiet hour, because each database must move into `shared/`
while nothing has it open. Do every step on the box, as the user that owns
pm2's daemon. Do not touch DIAYN.

1. **Find how each app runs**, and write it down: `pm2 jlist` names,
   `pm2 describe <name>` for each one's cwd, script and interpreter, the ports
   the proxy points at (`ss -ltnp`), and that exactly one bot runs
   (`pgrep -af 'discord_bot[.]py'`). Note the commit: `git -C <checkout> log --oneline -1`.
2. **Make the home**: `mkdir -p ~/bcs/releases ~/bcs/shared/run ~/bcs/shared/backups`,
   then `git clone "$(git -C <checkout> remote get-url origin)" ~/bcs/repo`.
3. **Copy the env files** (copy: the old checkout keeps running on its own until
   switched): `<checkout>/activity/.env` to `shared/activity.env`,
   `<checkout>/.env` to `shared/bot.env`, `<checkout>/activity/puzzledb/.env` to
   `shared/puzzledb.env`; `chmod 600 ~/bcs/shared/*.env`. In `activity.env` and
   `puzzledb.env` set `DATABASE_PATH=<home>/shared/daily.sqlite`. Copy
   `<checkout>/activity/data/solutions.json` to `shared/solutions.json` if it
   exists.
4. **A venv outside any release** for `botPython`, e.g.
   `python3 -m venv ~/bcs/shared/venv` and install the bot's packages into it
   (the root README's "Run the bot" lists them; `discord_bot.py` names the
   discord.py version the bot is pinned to). Reusing the venv the bot runs
   with today is fine if it lives outside the old checkout.
5. **Write `shared/deploy.json`** from `deploy.example.json`. Use the existing
   apps' names: the live game's name as `gameSlots[0]` and a new name as
   `gameSlots[1]`, the bot's and the site's names as they are, and the ports
   from step 1. Never DIAYN's.
6. **Prepare the first release.** The tool lives inside releases, so the first
   run uses the clone: `cd ~/bcs/repo/activity && bun install --frozen-lockfile && bun run deploy prepare main`.
   From then on, run it from a release.
7. **At a quiet hour, move the databases and switch.** Check quiet the way the
   guides do today: old code writes no status files.
   - `pm2 stop <site>` and `pm2 stop <game>`; move the game's database — the
     file its `DATABASE_PATH` names, with its `-wal` and `-shm` — to
     `shared/daily.sqlite`; `bun run deploy switch game <sha>`, then
     `bun run deploy switch site <sha>`. With nothing running, each simply
     starts (the stopped entries are replaced).
   - `pm2 stop <bot>`; move `<checkout>/stats.db` (and any `-wal`/`-shm`) to
     `shared/stats.db`; `bun run deploy switch bot <sha>`.
   - `bun run deploy status`, then the guides' verification.
8. **Keep the old checkout** until the new layout has run through a few
   deploys; it is the only way back to code from before the move. Its
   `puzzledb/ecosystem.config.cjs` is superseded by
   `shared/ecosystem.config.cjs`. Confirm `systemctl is-enabled "pm2-$(id -un)"`
   still prints `enabled`; never run `pm2 startup` again.

After this, a deploy is `bun run deploy deploy main` — with `--dry-run` first.
