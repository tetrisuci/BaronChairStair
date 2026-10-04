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

If you are upgrading both halves, either order works. The bot calls exactly three of the
activity's routes — it reads `/api/today` and `/api/recap`, and `/archive sync` posts to
`/api/bot/reload-archive` — and the current release changes none of them. An activity
older than the reload route costs only a delay: the sync still publishes, and its reply
says the puzzles go live at the activity's next restart. So neither half can be broken
by the other being older. Do the activity first anyway, out of habit: that is the half
with an ordering rule inside it, and it is the half worth having your full attention.

**One exception, for as long as it holds:** while `changelog.json` carries the
`beta 0.12` entry, which announces https://db.tetrisatuci.org, and that site is not yet
up and verified on this box, do not restart the bot. A restart announces every release a
server has not been told about — not only the newest, so a later release on top changes
nothing — the next time `/puzzle` runs there, and an announcement cannot be withdrawn.
Bring the site up first — [`activity/puzzledb/DEPLOY.md`](activity/puzzledb/DEPLOY.md),
rule 2. From `activity/`:

```sh
bun -e 'const r = (await Bun.file("../changelog.json").json()).releases; console.log(r.some((x) => x.version === "beta 0.12") ? "carries beta 0.12" : "no beta 0.12")'   # "carries beta 0.12": the site must be verified first
```

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
`@haelp/teto`, so run `bun install` **at the repository root** once. Everything
else runs on Python alone. Bun can resolve the package on its own when there is
no `node_modules` at all, so a fresh box may work without this — run it anyway,
so the version is the one `bun.lock` pins rather than whatever the registry
serves at the moment somebody asks for a replay.

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
| `PUZZLE_API` | the recap; `/archive sync` telling the activity to reload | the recap has nowhere to read from; a sync publishes, but the activity is not told |
| `PUZZLE_API_KEY` | the recap; `/archive sync` telling the activity to reload | the recap silently never posts; a sync publishes, but the activity is not told |
| `PUZZLE_RECAP` | the recap | the recap is off — the default, because it pings every player it names |
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

- Fifteen reports per player per hour, sixty per server per hour. Both live in memory, so
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
python3 -m unittest discover -s client     # 173 run, 0 fail; bare python3 skips 3
```

### Restarting, and making a new command appear

*Before any restart, the exception near the top of this file: if `changelog.json`
carries `beta 0.12` and db.tetrisatuci.org is not yet up on this box, stop.*

Find how the bot actually runs on this box. Look, do not guess:

```sh
systemctl list-units '*bot*'; pm2 list; tmux ls; pgrep -af discord_bot.py
```

Stop the old process before starting the new one. **Two instances on one token
double-handle every command**, which presents as the bot answering everything twice.

**This box runs a second bot, DIAYN, the club's internship finder.** It has its
own service (the pm2 app or systemd unit named `diayn`), its own checkout, its own
`.env` and its own token, and its repository's DEPLOY.md is its guide. Act on this
bot by its own name only:

- never `pm2 restart all` or `pm2 stop all`, which take DIAYN down too;
- `pm2 save` records every app `pm2 list` shows, so check that both are listed as
  you want them before saving;
- `pm2 startup` is set up once per user, so do not run it again.

Before restarting, confirm every module the bot imports still parses. `discord_bot.py`
imports nine of the files under `client/` at module scope, so a syntax error in any one
of them is a start-up crash rather than a degraded feature:

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
3. The daily recap is **off unless `PUZZLE_RECAP=on`**, and the log says so at start-up
   (`puzzle recap off: …`). Turning it on posts the previous day's recap as soon as the
   bot starts, then one a day. If it is on and silently does not post, check
   `PUZZLE_API_KEY` against `BOT_API_KEY` in `activity/.env`.
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
