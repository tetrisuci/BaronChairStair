# Deploying — start here

This repository is **two projects**, deployed separately:

| | Where it lives | Its deploy guide |
|---|---|---|
| **The Discord bot** | the repository root and `client/` | this file |
| **The activity** (the puzzle itself) | `activity/` | [`activity/DEPLOY.md`](activity/DEPLOY.md) |

They have different `package.json` files, different `.env` files, and different
commands. Running one's commands from the other's directory is the commonest way a
deploy goes sideways, and in one direction it does not even fail — see below.

This file is the *operational* half: what to set, how to restart, how to tell whether it
worked. [`README.md`](README.md) describes what the commands do and is the better place
to start if you want to know what `/report` *is*.

If you are upgrading both halves, either order works. The bot reads exactly two of the
activity's routes — `/api/today` and `/api/recap` — and both are unchanged by the
current release, so neither half can be broken by the other being older. Do the activity
first anyway, out of habit: that is the half with an ordering rule inside it, and it is
the half worth having your full attention.

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
`aiohttp` and `python-dotenv`.

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
| `PUZZLE_APP_ID` | the launch link | `/puzzle` cannot build its button |
| `PUZZLE_API` | the recap | the recap has nowhere to read from |
| `PUZZLE_API_KEY` | the recap | the recap silently never posts |
| `GITHUB_TOKEN` | `/report` | `/report` answers "Reports aren't wired up yet" |
| `GITHUB_REPO` | `/report` | as above |

`PUZZLE_API_KEY` must match `BOT_API_KEY` in `activity/.env` — **different names on
either side**, which is easy to get wrong. The two failures look different: a mismatch
is a `401`, an unset key on the server is a `404`.

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

- Three reports per player per hour, twenty per server per hour. Both live in memory, so
  **both reset when the bot restarts**.
- Reporter text is defanged in `client/report_text.py`: `@mentions` and all four of
  GitHub's issue-autolink forms (`#26`, `GH-26`, `owner/repo#26`, and the organisation
  form) are neutralised with an empty HTML comment, so a report cannot ping a team or
  post a backlink into an unrelated repository.
- Control characters are stripped, as are the invisible ranges that let a title read as
  something other than what it says.
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
python3 -m unittest discover -s client     # 36 pass
```

### Restarting, and making a new command appear

Find how the bot actually runs on this box. Look, do not guess:

```sh
systemctl list-units '*bot*'; pm2 list; tmux ls; pgrep -af discord_bot.py
```

Stop the old process before starting the new one. **Two instances on one token
double-handle every command**, which presents as the bot answering everything twice.

Before restarting, confirm every module the bot imports still parses. `discord_bot.py`
imports all of these at module scope, so a syntax error in any one of them is a start-up
crash rather than a degraded feature:

```sh
<venv-python> -m py_compile client/discord_bot.py client/report_commands.py \
  client/report_text.py client/puzzle_commands.py client/puzzle_recap.py sync_guilds.py
```

**A new slash command needs a restart to appear.** The command tree is synced by
`_sync_global_commands()`, called from the `on_ready` handler and nowhere else — there
is no manual sync command and no flag. A global sync can take up to an hour to
propagate. To push the tree into one guild immediately, and tidy up afterwards, see
[README.md](README.md#standalone-tools):

```sh
<venv-python> sync_guilds.py <SERVER_ID>            # instant, one guild
<venv-python> sync_guilds.py --clear <SERVER_ID>    # once the global ones land
```

### Verifying the bot

1. It connected — the log names the bot user and the guilds it is in.
2. `/puzzle` returns the launch button, and the activity opens from it.
3. The daily recap posts. If it silently does not, check `PUZZLE_API_KEY` against
   `BOT_API_KEY` in `activity/.env`.
4. `/report` appears in the command list. Run it, pick a category, type a description,
   and confirm the issue appears at
   <https://github.com/tetrisuci/BaronChairStair/issues>. **Close your test issue
   afterwards.** "Reports aren't wired up yet" means the two GitHub keys did not reach
   the process.

---

## The activity

See [`activity/DEPLOY.md`](activity/DEPLOY.md), which is complete and specific. Four
things from it are worth knowing before you begin, because each fails silently:

- **There is an ordering rule.** Start the new code, and confirm the backfill ran,
  *before* the puzzle pool next changes. Getting it wrong writes plausible but wrong
  history for days nobody played, and nothing reports it.
- **`TRUST_PROXY=true` must be set in `activity/.env` if anything fronts the server**
  (cloudflared, nginx, Caddy). Without it every player shares one rate-limit bucket and
  starts collecting 429s. Only the exact lowercase `true` counts.
- **`DATABASE_PATH` must be absolute, or unset.** A relative value resolves against the
  working directory, and if that is not `activity/` the server creates a brand-new empty
  database rather than refusing — it boots, and every leaderboard is gone.
- **Back up with `VACUUM INTO`, never `cp`.** The database is in WAL mode, and on this
  project the main `.sqlite` file has been measured at 4 KB against a 997 KB `-wal`
  beside it. A `cp` of the main file alone produced a database in which the tables did
  not exist.

The `DATABASE_PATH` trap has a companion worth stating here: **Bun reads `.env` from the
process working directory only.** It does not look beside the entrypoint and does not
walk up. So `activity/.env` reaches the running service only if the unit sets
`WorkingDirectory=<abs>/activity` or passes `EnvironmentFile=<abs>/activity/.env`. Check
which yours does before editing that file, or your edits will have no effect and nothing
will say so:

```sh
systemctl cat <the-unit> | grep -iE 'Environment|WorkingDirectory|ExecStart'
```
