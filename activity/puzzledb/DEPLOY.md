# Deploying the puzzle database site (db.tetrisatuci.org)

Written for whoever puts the site up on the production box — including Claude Code
with a shell there. It assumes you have never seen this repository and cannot ask
anyone. Every block runs as given, from `activity/`, once `/path/to/BaronChairStair`
and anything in `<angle brackets>` are filled in.

**This file covers the site only.** The game is [`../DEPLOY.md`](../DEPLOY.md) and
the bot is the repository root's [`DEPLOY.md`](../../DEPLOY.md). The site deploys and
restarts without touching either, and shipping it needs **no game restart**. What
the site is, and why, is in [`README.md`](README.md).

| | |
|---|---|
| **pm2 name** | `puzzle-db` |
| **Runs as** | `bun --env-file=<abs>/activity/puzzledb/.env puzzledb/server/main.ts`, from `activity/`, as the game's OS user |
| **Listens on** | `127.0.0.1:3002`, loopback only (`PUZZLEDB_PORT`) |
| **Settings** | `activity/puzzledb/.env` — its own file, never `activity/.env`, and nothing in it is secret |
| **The page** | `bun run build:puzzledb` writes `activity/puzzledb/dist/`, which is not in git |
| **Its log** | lines begin `[puzzledb]`; the start-up line begins `puzzledb —` |
| **Reads** | the game's database, read-only; `data/puzzles.json` (and `solutions.json` beside it, if present); `data/archive/puzzles.sqlite` |
| **Writes** | nothing. A read-only reader can still create the database's `-wal` and `-shm` files when they are missing, which is why it runs as the game's user |

---

## Two ordering rules

**1. The game's database must already be on this checkout's schema.** The site reads
it with the game's own readers, from this checkout. On a box whose game is older than
the checkout, the site serves nothing and says why, once:

```
[puzzledb] the database is older than this checkout (no such column: …). The game migrates it when it starts on this code: deploy the game first (activity/DEPLOY.md) (nothing to serve yet; retrying every 30 s)
```

Deploy the game first. The site looks again every 30 seconds and picks the database
up by itself once the game has migrated it; nothing needs restarting.

**2. The site first, verified — then the bot.** The commit that ships the site puts
the release note announcing it at the top of `changelog.json`. The bot reads that
file once, when it starts, so its **next restart, for any reason, by anyone**
announces the note in every server at the next `/puzzle` — and an announcement can
never be withdrawn. The bot reads it from the checkout its code is in —
`pgrep -af discord_bot.py` shows its command, and `ls -l /proc/<its PID>/cwd` where
that command starts — and when that is this checkout, a `git pull` is all it takes.
So:

- pull only when you can bring the site up in the same sitting;
- verify it publicly (*Verify it publicly*, below) before the bot restarts for any
  reason;
- if you cannot finish, take the site down and `git checkout <the commit you noted>`
  before you leave the box (*Rolling back*): the note goes with it, and nothing is
  announced.

What the bot's next restart would announce, from `activity/`:

```sh
bun -e 'console.log((await Bun.file("../changelog.json").json()).releases[0].version)'
```

---

## Before you start

These read state and settings, and print no secrets.

```sh
cd /path/to/BaronChairStair/activity
git log --oneline -1          # note this — it is your rollback target
bun --version
bun -e 'import {Database} from "bun:sqlite"; console.log(typeof new Database(":memory:").serialize, typeof Map.groupBy)'   # function function
pm2 list                      # every app by name. Never `pm2 restart all` or `pm2 stop all`: DIAYN shares this box
ps -o user=,pid=,args= -C bun # the game is the one running server/index.ts: note its user and PID
grep -E '^(DATABASE_PATH|DAILY_RESET_TIMEZONE)=' .env   # the game's own settings, if it sets them
ss -ltnp | grep -E ':(3001|3002)\b'                     # the game on 3001; 3002 must be free
```

If pm2 runs the game, `pm2 pid <its name>` gives the same PID. Then ask the running
game what it actually uses — as its user, or with `sudo`:

```sh
ls -l /proc/<the game's PID>/cwd                     # the checkout it runs from: it must be this one
ls -l /proc/<the game's PID>/fd | grep -F .sqlite    # the database file it has open
```

**Run the site from the game's checkout, as the game's user, against that database.**
The site reads `data/puzzles.json` and the tracked archive from beside its own code,
so from another checkout it would list puzzles the game does not deal. As another
user, it can fail to open the database, or create a `-wal` or `-shm` file the game
then cannot write.

---

## Checks, then the build

```sh
git pull                  # or however this box gets code
bun install
bunx tsc --noEmit         # must print nothing
bun test                  # 0 fail. Skips are expected — see below
bun run build:puzzledb    # writes puzzledb/dist/ and nothing else
```

**Skips are expected.** `data/solutions.json` holds the answer keys and is not in
git, so a box without it skips the tests that need one. `0 fail` is the check. A
failure is a stop: report it, and do not start the site through it.

The build comes after the checks because a running site reads
`puzzledb/dist/index.html` from disk on every request, so a build is live the moment
it finishes. It never touches the game's `dist/`.

---

## The env file

```sh
DB=$(bun -e 'import {resolve} from "node:path"; console.log(resolve(process.env.DATABASE_PATH || "data/daily.sqlite"))')
sed "s|^DATABASE_PATH=.*|DATABASE_PATH=$DB|" puzzledb/.env.example > puzzledb/.env
grep -E '^DAILY_RESET_TIMEZONE=' .env >> puzzledb/.env    # the game's zone, when it sets one
grep -E '^[A-Z_]+=' puzzledb/.env
```

The first line works out the database path the way the game's own config does: Bun
reads `activity/.env` for that one command because it runs from `activity/`, and a
relative path is taken from `activity/`. **It must equal the file from the `/proc`
line above.** A game started from another directory with a relative `DATABASE_PATH`
opens a different file; if the two differ, put the `/proc` path in `puzzledb/.env`.

The last line should show an absolute `DATABASE_PATH`, `PUZZLEDB_PORT=3002`, and the
game's `DAILY_RESET_TIMEZONE` if it sets one (unset, both default to
America/Los_Angeles). Nothing else belongs in this file.

---

## A trial in the foreground

```sh
bun --env-file=puzzledb/.env puzzledb/server/main.ts
```

With this box's own numbers and path, it prints:

```
[puzzledb] now serving 138 puzzles and 31 finished days through day 275.
puzzledb — 138 puzzles and 31 finished days through day 275 (America/Los_Angeles), from /path/to/BaronChairStair/activity/data/daily.sqlite, on http://127.0.0.1:3002/
```

Press Ctrl-C; it exits cleanly. Anything else — `[puzzledb] not starting:`, an owner
warning, `not serving data yet` — is under *Things that are wrong*, below. Fix it
before going on.

---

## Start it under pm2, as the game's user

Two things about pm2 decide the shape of this step, and both fail quietly:

- **pm2 must run Bun on the file itself.** pm2 6 and later start an app whose
  interpreter is `bun` through a loader of their own, and the site starts only when
  it is the program Bun was asked to run. Started that way, pm2 shows `puzzle-db`
  **online** while nothing listens on 3002 and its log stays empty (measured on
  pm2 7.0.4). So pm2 is told the program is Bun itself: `interpreter: "none"`.
- **`--env-file=` stays off pm2's command line.** Some Node releases read
  `--env-file=` anywhere on a command line as their own flag — pm2's own command
  line included — and die with `node: …/puzzledb/.env: not found` before pm2 has
  started anything. So the arguments go in a file.

From `activity/`, as the game's user:

```sh
cat > puzzledb/ecosystem.config.cjs <<EOF
module.exports = {
  apps: [{
    name: "puzzle-db",
    script: "$(command -v bun)",
    args: ["--env-file=$PWD/puzzledb/.env", "puzzledb/server/main.ts"],
    interpreter: "none",
    exec_mode: "fork",
    cwd: "$PWD",
  }],
};
EOF
cat puzzledb/ecosystem.config.cjs     # bun's real path, and this checkout's absolute paths
pm2 start puzzledb/ecosystem.config.cjs
```

The file is this box's own: the root `.gitignore` ignores every
`ecosystem.config.cjs`, so `git status` stays clean. If the box already keeps its
apps in one ecosystem file, add the same entry there instead, and start only this one
with `pm2 start <that file> --only puzzle-db`.

```sh
pm2 describe puzzle-db | grep -E 'status|script path|script args|interpreter|exec cwd'
ps -o user=,args= -p "$(pm2 pid puzzle-db)"   # the game's user, running bun --env-file=…/puzzledb/.env puzzledb/server/main.ts
ss -ltnp | grep ':3002'                       # 127.0.0.1:3002 — never 0.0.0.0 or *
pm2 logs puzzle-db --lines 20 --nostream      # the puzzledb — line, and no "not starting"
```

Then `pm2 list`, and `pm2 save` only once it shows every app as you want it kept:
`pm2 save` records all of them, DIAYN's included. Never `pkill -f`; stop a stray
process by its exact PID.

### Or under systemd

```ini
# /etc/systemd/system/puzzle-db.service
[Unit]
Description=Tetris at UCI puzzle database (db.tetrisatuci.org)
After=network.target

[Service]
User=<the game's user>
WorkingDirectory=/path/to/BaronChairStair/activity
ExecStart=<bun's absolute path> --env-file=/path/to/BaronChairStair/activity/puzzledb/.env puzzledb/server/main.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now puzzle-db
systemctl status puzzle-db --no-pager
journalctl -u puzzle-db -n 20 --no-pager
```

`command -v bun`, run as the game's user, gives the path for `ExecStart`. No
`EnvironmentFile=`: the env file is Bun's to read, and one pointing at
`activity/.env` would hand the site the game's secrets, which it refuses to start
with.

---

## Check it on loopback, before any DNS

```sh
curl -s 127.0.0.1:3002/health; echo
curl -sI 127.0.0.1:3002/ | grep -iE '^(HTTP|content-security-policy|x-frame-options)'
curl -s 127.0.0.1:3002/puzzle/1 | grep -o '<title>[^<]*</title>'
```

Expect `"ok":true` with the banner's counts; `HTTP/1.1 200 OK` and both headers; and
`<title>#1 first — Puzzle archive</title>`.

**The spoiler check.** The site must never show today. This works out today the way
the game does — Bun reads the game's zone from `activity/.env` — then asks the site
for the newest day it shows, and for today's page:

```sh
TODAY=$(bun -e 'import {dayNumber} from "./shared/daily"; console.log(dayNumber(Date.now(), {timeZone: process.env.DAILY_RESET_TIMEZONE?.trim() || "America/Los_Angeles"}))')
curl -s 127.0.0.1:3002/health | bun -e 'const {throughDay} = await Bun.stdin.json(); console.log(`today is day '"$TODAY"'; history runs through day ${throughDay}`)'
curl -s -o /dev/null -w '%{http_code}\n' "127.0.0.1:3002/day/$TODAY"    # must print 404
```

History must end **before** today, and today's page must be a `404`. If either is
wrong, `pm2 stop puzzle-db` and report it. Do not put the site in front of anybody.

**The download** holds three tables and nothing else:

```sh
DL=$(mktemp -d)/tetrisatuci-puzzles.sqlite
curl -s 127.0.0.1:3002/puzzles.sqlite -o "$DL"
bun -e 'import {Database} from "bun:sqlite"; const db = new Database(process.argv[1], {readonly: true}); console.log(db.query("SELECT name FROM sqlite_master WHERE type = ?1 ORDER BY name").all("table").map((t) => t.name).join(" "))' "$DL"   # about day_puzzles puzzles
```

---

## Put db.tetrisatuci.org in front of it

The site listens on loopback only, so whatever answers for db.tetrisatuci.org must
run on this box: a cloudflared connector on another machine cannot reach it. What
does this box have?

```sh
ps -o args= -C cloudflared | sed -E 's/(--token[ =])[^ ]+/\1<redacted>/'
grep -ls '^ingress:' /etc/cloudflared/config.yml /etc/cloudflared/config.yaml ~/.cloudflared/config.yml ~/.cloudflared/config.yaml 2>/dev/null
```

A `--token` on the first line, or a `tunnel run` with no file from the second, is a
**remotely managed** tunnel: use (a). A file from the second line is a **locally
managed** one: use (b). No cloudflared at all: (c).

**(a) A remotely managed tunnel.** In Cloudflare's Zero Trust dashboard, open this
box's tunnel and add a public hostname: subdomain `db`, domain `tetrisatuci.org`,
service type `HTTP`, URL `127.0.0.1:3002`. Cloudflare creates the DNS record and
sends the route to the connector itself — nothing restarts and nothing on the box
changes. The tetrisatuci.org zone must be on the same Cloudflare account as the
tunnel.

**(b) A locally managed tunnel.** Add this rule to the file the second line printed,
**above** the last, catch-all rule (`- service: http_status:404` or the like), and
leave the game's rule as it is:

```yaml
  - hostname: db.tetrisatuci.org
    service: http://127.0.0.1:3002
```

```sh
cloudflared tunnel --config <that file> ingress validate
cloudflared tunnel --config <that file> ingress rule https://db.tetrisatuci.org   # must name the new rule and http://127.0.0.1:3002
cloudflared tunnel route dns <the tunnel id from that file's tunnel: line> db.tetrisatuci.org
```

`route dns` needs the `cert.pem` of the account that made the tunnel; without it, add
a proxied CNAME from `db` to `<tunnel id>.cfargotunnel.com` in the DNS dashboard
instead. cloudflared reads its rules only when it starts, so restart it by its own
name — the unit or pm2 app the first line belongs to — **at a quiet hour**. The
restart drops every connection through the tunnel, the game's duels and open
activities included.

**(c) DNS plus Caddy or nginx.** Point a DNS-only (not proxied) record for
db.tetrisatuci.org at this box, and have the proxy **overwrite** both headers the
site counts callers by. A client can send `Cf-Connecting-Ip` itself; passed through,
it would let anybody pick their own rate-limit bucket.

Caddy, which fetches its own certificate:

```
db.tetrisatuci.org {
	reverse_proxy 127.0.0.1:3002 {
		header_up -Cf-Connecting-Ip
		header_up X-Forwarded-For {remote_host}
	}
}
```

nginx, inside the `server` block for db.tetrisatuci.org, beside this box's usual
`listen` and certificate lines:

```nginx
location / {
    proxy_pass http://127.0.0.1:3002;
    proxy_set_header Cf-Connecting-Ip "";
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

Then `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`,
or `sudo nginx -t && sudo systemctl reload nginx`. Behind Cloudflare's proxy (an
orange-cloud record) these lines would count every visitor by a Cloudflare address;
use (a) or (b) there.

**Why there is no `TRUST_PROXY` here.** The game has one because it can be reached
directly. The site listens on 127.0.0.1 only, so every peer it can ever see is the
proxy on this box, and it always counts callers by `Cf-Connecting-Ip`, then the last
`X-Forwarded-For` entry. The proxy's half of that bargain is writing them: cloudflared
does so itself, and Caddy and nginx need the lines above.

---

## Verify it publicly

```sh
curl -sI https://db.tetrisatuci.org/ | grep -iE '^(HTTP|content-security-policy|x-frame-options)'
curl -s https://db.tetrisatuci.org/puzzle/1 | grep -o '<title>[^<]*</title>'
curl -s https://db.tetrisatuci.org/health; echo
```

Then, in a browser at <https://db.tetrisatuci.org/>, with the developer console open
the whole time:

- search for a title, open a puzzle, press **Show the answer** and step through it
  with the arrow keys, then open **Days** and one day;
- the console must show **no Content-Security-Policy errors**. One 404 for
  `/favicon.ico` is expected: there is no icon yet.

Paste `https://db.tetrisatuci.org/puzzle/1?v=1` into a private Discord channel. It
should unfurl with the puzzle's title and description; the `?v=1` gets past anything
Discord cached while you were setting up, so change the number to try again.

Last, `git status` from the repository root must be clean: `puzzledb/dist/`,
`puzzledb/.env` and `puzzledb/ecosystem.config.cjs` are all ignored.

---

## Only now, restart the bot

By its own name, as the root [`DEPLOY.md`](../../DEPLOY.md) describes —
never with `pm2 restart all`, which would take DIAYN down with it. That restart is
what announces the site: the next `/puzzle` in each server carries the release note.

---

## After every activity deploy

The site is built from the activity's own code. The page compiles `client/src` and
`shared/`, and the server runs `server/puzzles.ts` and the game's other readers, so
whenever the activity is deployed the site needs the same code. `puzzledb/dist/` is
not in git, and a running process keeps the code it started with, so a pull changes
neither. Once the activity is verified ([`../DEPLOY.md`](../DEPLOY.md)):

```sh
cd /path/to/BaronChairStair/activity
bun run build:puzzledb
pm2 restart puzzle-db
pm2 logs puzzle-db --lines 5 --nostream    # a fresh puzzledb — line
```

Restarting it never touches the game. To tell whether a specific change reached the
page, ask `puzzledb/dist/assets/` the way the activity's guide asks its own `dist/`:

```sh
ls -l puzzledb/dist/assets/                                  # newer than the pull
grep -l "<a string only the change adds>" puzzledb/dist/assets/*.js
```

Data needs none of this. An accepted puzzle, a correction, a publish or a rebuilt
`puzzles.json` reaches the site by itself within about 30 seconds.

---

## Rolling back, or taking it down

**Taking it down** never affects the game: `pm2 stop puzzle-db`, then remove the
hostname — the dashboard route, the ingress rule (and a cloudflared restart), or the
proxy block. For good: `pm2 delete puzzle-db`, check `pm2 list`, then `pm2 save`.

**This first deploy failed verification**, and the bot has not restarted: take the
site down and put the checkout back, so the release note leaves with it.

```sh
pm2 delete puzzle-db
cd /path/to/BaronChairStair/activity
git checkout <the commit you noted>
```

The game keeps running throughout: it runs the code it started with, which is the
code you just checked out.

**A later deploy broke the site.** Rolling the checkout back moves the game's code
too, so do it only together with the activity's own rollback (`activity/DEPLOY.md`,
*Rolling back*), to a commit that has the site in it, and then:

```sh
bun install && bun run build:puzzledb
pm2 restart puzzle-db
```

When only the site is wrong, take it down and report it instead.

---

## Restoring the game's database from a backup

Stop the site first and start it last:

```sh
pm2 stop puzzle-db
# ... restore the game's database and start the game ...
pm2 start puzzle-db
```

A reader holds the database's `-wal` and `-shm` files open, and files swapped under
an open connection are how SQLite databases get corrupted. The site would notice the
new file by itself — it watches the file's inode — but there is no reason to have it
reading while the files move.

---

## Things that look wrong and are not

- **Yesterday is missing from history.** It appears once something has pinned
  today: within five minutes when the bot's recap is on (`PUZZLE_RECAP=on`),
  otherwise when the first player opens the day.
- **History starts at day 245, and days before 251 show three tiers.** Earlier rows
  are the backfill nobody was dealt, and an earlier extreme row is a top-up added
  later. Both numbers are in `puzzledb/server/policy.ts`, and the owner's to change.
- **The site lists more puzzles than `/api/public`.** That route is the published
  record only, uncorrected; the site lists what players are dealt.
- **An accepted or corrected puzzle shows here before the game serves it.** The site
  shows the list the game will deal from its next restart.
- **`[puzzle] …` lines in the site's log.** The shared puzzle loader's own warnings,
  the same ones the game prints at boot, said once per rebuild.
- **`[puzzledb] the newest pinned day is <D> and today is <T>: is DATABASE_PATH the
  game's live database?`** Asked once per process, when no day has been pinned for
  more than two days. On a box nobody has played for days with the recap off, that
  is simply true; otherwise check `DATABASE_PATH` against the `/proc` line.
- **503 while the site has nothing built.** Pages answer 503 with `Retry-After: 30`
  and `/health` says `"ok":false` until the first build. The first build normally
  finishes before the port opens; a longer 503 has its reason in the log.
- **The owner warning on a box that shares the database through a group.** It is a
  warning, not a refusal. If the game can still write, nothing is wrong.

## Things that are wrong

- **`[puzzledb] not starting:` with a line like `SESSION_SECRET is set in this
  process's environment`.** Bun loaded the game's `.env`: the site was started
  without `--env-file=…/puzzledb/.env`, under a unit with an `EnvironmentFile=`, or
  from a shell that exports a secret. Start it as above.
- **`DATABASE_PATH is not set`.** The env file was never read — Bun skips a missing
  `--env-file` without a word — or never filled in. Check the path in the pm2 file
  or the unit, and `grep -E '^[A-Z_]+=' puzzledb/.env`.
- **`[puzzledb] cannot open <path> read-only (…) — is the game running, and is
  DATABASE_PATH the game's own?`** A wrong path, a game that has never run there, or
  a user without access to the file and its directory.
- **`[puzzledb] this process runs as uid <X>, but <path> belongs to uid <Y>`.** The
  site runs as the wrong user. Stop it and start it as the game's: a `-wal` or
  `-shm` file made by the wrong user can stop the game writing.
- **`error: Failed to start server. Is port 3002 in use?`** Something already
  listens on 3002, usually a second copy of the site. `ss -ltnp | grep ':3002'` names
  it and `pgrep -af puzzledb/server/main.ts` lists copies; stop the extra one by its
  pm2 name or its exact PID. Never `pkill -f`.
- **pm2 says `puzzle-db` is online, but nothing listens on 3002 and its log is
  empty.** pm2 was given Bun as an interpreter, which pm2 6 and later wrap in a
  loader of their own. `pm2 delete puzzle-db`, then start it from the ecosystem file
  above.
- **A pm2 command dies with `node: …/puzzledb/.env: not found`.** `--env-file=` was
  on pm2's command line, and this Node took it for its own flag. Use the ecosystem
  file.
- **Everyone gets 429s, or a flood never does.** The proxy is not writing the
  caller's address: either every visitor shares the proxy's bucket, or each request
  picks its own. Check the header lines in (c).
- **The log says `[puzzledb] the page is not built`**, and pages answer
  `The page is not built yet.` with a 503 while the data routes still work. Run
  `bun run build:puzzledb`; no restart is needed.
- **Pages answer 500, and the log has `[puzzledb]` with `The page template has no
  <!--puzzledb:head--> placeholder`, or has it more than once.**
  `puzzledb/dist/index.html` is not this checkout's build. Run
  `bun run build:puzzledb`.
