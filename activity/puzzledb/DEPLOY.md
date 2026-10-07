# Deploying the puzzle database site (db.tetrisatuci.org)

Written for whoever puts the site up on the production box — including Claude Code
with a shell there. It assumes you have never seen this repository and cannot ask
anyone. Every block runs as given, from `activity/`, once `/path/to/BaronChairStair`
and anything in `<angle brackets>` are filled in.

**This file covers the site only.** The game is [`../DEPLOY.md`](../DEPLOY.md) and
the bot is the repository root's [`DEPLOY.md`](../../DEPLOY.md). What the site is,
and why, is in [`README.md`](README.md).

**The site shares its checkout with the game and the bot, so a pull is an activity
deploy** whenever it brings anything for the activity: the activity's guide does it,
from the pull to its verification, and the site's own steps follow (rule 1, below).
The commit that brought this site did bring the activity something: two of the
game's own files, though not what the game does. The commit that brings its player
data (beta 0.13) brings the activity a great deal — a migration, two routes and a new
setting, with its one link to the site — so it is an activity deploy with a
build, and the site cannot publish a player until the game has run it. The site's
own steps restart neither the game nor the bot.
The only ones that can touch the game are a cloudflared restart and a Caddy reload,
both for the hostname, and each says so where it comes.

| | |
|---|---|
| **Its name** | `puzzle-db`, as a pm2 app or a systemd unit |
| **Runs as** | `bun --env-file=<abs>/activity/puzzledb/.env puzzledb/server/main.ts`, from `activity/`, as the game's OS user |
| **Listens on** | `127.0.0.1:3002`, loopback only (`PUZZLEDB_PORT`) |
| **Settings** | `activity/puzzledb/.env` — its own file, never `activity/.env`, and nothing in it is secret |
| **The page** | `bun run build:puzzledb` writes `activity/puzzledb/dist/`, which is not in git |
| **Its log** | lines begin `[puzzledb]`; the start-up line begins `puzzledb —` |
| **Reads** | the game's database, read-only; `data/puzzles.json` (and `solutions.json` beside it, if present); `data/archive/puzzles.sqlite` |
| **Writes** | nothing. A read-only reader can still create the database's `-wal` and `-shm` files when they are missing, which is why it runs as the game's user |

---

## On a box migrated to releases

On a box moved to the release layout — pm2 runs the site from
`~/bcs/releases/<sha>/activity` (`pm2 describe <its name> | grep 'exec cwd'`), and
`~/bcs/state.json` exists — the site goes through the deploy tool,
[`../tools/deploy/`](../tools/deploy/README.md). Its README has the detail; what it
changes in the table above and the steps below:

| This guide | On a migrated box |
|---|---|
| *Checks, then the build*, and *After every activity deploy* | `prepare <ref>` runs the checks and `bun run build:puzzledb` in the new release. `switch site <ref>` replaces the process — delete, a check that nothing else answers the port, start, `/health`, then pm2 must show it online on one pid 5 seconds later. The `pm2 restart` step goes away |
| *Start it under pm2*, `puzzledb/ecosystem.config.cjs` | `shared/ecosystem.config.cjs`, written by the tool and never edited by hand, with `interpreter: "none"` and `--env-file` in the arguments, for the reasons given there |
| `puzzledb/.env` | `shared/puzzledb.env`, with the absolute `DATABASE_PATH=<home>/shared/daily.sqlite`. The commands below that read `puzzledb/.env` read that file instead |
| `data/solutions.json` beside the code | `shared/solutions.json`, linked into each release |
| The name `puzzle-db`, port 3002 | `pm2.site` and `sitePort` in `shared/deploy.json` |
| *Rolling back* a later deploy | `rollback site`: code only, with the same checks |

Both rules hold as switches, one at a time, from the current release's `activity/`:
`switch site` only once `switch game` and the activity's *Verification* have passed
(rule 1), and `switch bot` only once *Verify it publicly* has (rule 2). The tool's
README, *A deploy, in the guides' order*, has the commands. `bun run deploy deploy <ref>`
runs the same switches back to back, with only the tool's own checks between them, so
it switches the site before the game is verified and restarts the bot before the site
is: do the stricter thing and switch one at a time. *Check it on loopback*, *Verify it
publicly* and the rest stay as they are, on `sitePort`, run from the release's
`activity/`. The switch's gap is from the delete until the new process has built its
first dataset and bound the port, during which db.tetrisatuci.org answers 502.

**Taking the site down is still `pm2 stop <its name>`, but it stays down only while
nothing switches the site.** `switch site` starts it whatever pm2 shows, a stopped
entry or none, even after `pm2 delete` and `pm2 save`, and `deploy <ref>` and
`rollback site` both run it. While the site must stay down, deploy with `prepare`,
`backup`, `switch game` and `switch bot` alone, and never run `switch site`,
`rollback site` or `deploy <ref>` until whoever took it down says it may come back.

A box not yet migrated follows this guide as it stands; the site moves with the game
and the bot in the tool's *First-time migration*. The manual steps stay the path for a
box not yet migrated, and the fallback for one whose migration was rolled back; nothing
here is run inside `releases/`, where a fix is a new release.

---

## Two ordering rules

**1. The activity's deploy comes first, because the pull is the game's.** The site
runs from the game's checkout (*Before you start* says why), and that checkout holds
the bot's code as well, so a pull moves all three. When it brings the activity
anything, it is an activity deploy, and [`../DEPLOY.md`](../DEPLOY.md) does it, from
its *Before you start* through its *Verification*. A bare pull would leave the game
to boot the new server against its old page at its next restart, whoever causes it,
with nothing checked and no error anywhere. *Checks, then the build* shows how to
tell, and the site's own steps follow that deploy.

On the commit that brings the site, the game's `server/limits.ts` and
`server/public-routes.ts` take the rate limiter and the Blueprint link from two new
modules the site shares, `server/rate-limit.ts` and `shared/blueprint/viewer.ts`.
The game behaves exactly as before, and it is deployed all the same.

A database the game has not migrated yet is the one gap the site catches by itself.
It reads the database with the game's own readers, from this checkout, so when a
table or column they need is missing it serves nothing and says why, once:

```
[puzzledb] the database is older than this checkout (no such column: …). The game migrates it when it starts on this code: deploy the game first (activity/DEPLOY.md) (nothing to serve yet; retrying every 30 s)
```

The site looks again every 30 seconds and picks the database up by itself once the
game has migrated it; nothing needs restarting. A game that is merely older on the
same schema says nothing at all, which is why this is a rule and not an answer to
that line.

Since beta 0.13 this is also how the site meets a game that has not yet started on
the player-data code: the site reads the `guilds` and `site_facts` tables and two
columns of `players` (`site_hidden`, `public_key`), and the game adds all four when
it starts. Until then the line above names whichever it missed first. A site already
running keeps serving its last good dataset meanwhile; a site started afresh serves
503 until the game is up.

**2. The bot last, and only if its own code changed.** The bot reads `changelog.json`
once, when it starts, and shows release notes only when somebody asks for them,
privately, with `/puzzle changelog`; since `beta 0.17` it posts none by itself (the
root guide has the one exception, a rollback to older code). So neither a pull nor a
restart announces anything, and the bot keeps running through the activity's deploy and
this one. Its restart comes after *Verify it publicly* has passed, because that restart
is what makes the notes that describe this site readable — `beta 0.12`'s address,
`beta 0.13`'s boards and setting, `beta 0.15`'s Players and Solves — and a note should
not describe a site that is not up yet. Whether the bot needs a restart at all, and how,
is the root [`DEPLOY.md`](../../DEPLOY.md); *Last, the bot*, below, is where it comes.

---

## Before you start

These read state and settings, and print no secrets.

```sh
cd /path/to/BaronChairStair/activity
git log --oneline -1          # note this before any pull — the rollback target, the activity's too
bun --version
bun -e 'import {Database} from "bun:sqlite"; console.log(typeof new Database(":memory:").serialize, typeof Map.groupBy)'   # function function
pm2 list                      # every app by name. Never `pm2 restart all` or `pm2 stop all`: DIAYN shares this box
ps -o user=,pid=,args= -C bun # the game is the one running server/index.ts (one, unless a handover is under way): note its user and PID
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

*The path for a box not yet migrated to releases, and the fallback. On a migrated box,
`prepare` and `switch site` (above).*

First, what a pull would bring the activity besides the site (rule 1):

```sh
git fetch
git diff --stat HEAD @{upstream} -- . ':!puzzledb' ':!tests/puzzledb-*'
```

**Anything listed makes the pull an activity deploy**, and on the commit that
brings the site it lists the game's files and more. Deploy the activity by
[`../DEPLOY.md`](../DEPLOY.md), from its *Before you start* through its
*Verification*, then come back here. That deploy pulls, installs, type-checks and
runs `bun test`, the site's tests included, so the build below is all that is left.

**Nothing listed**, as for a later change to the site alone, and the pull is the
site's:

```sh
git pull                  # or however this box gets code
bun install
bunx tsc --noEmit         # must print nothing
bun test                  # 0 fail. Skips are expected — see below
```

Either way, then:

```sh
bun run build:puzzledb    # writes puzzledb/dist/ and nothing else
```

**If the site is already running, restart it now**, so the server matches the page
it serves: the build is live the moment it finishes, but the server keeps running
the code it started with.

```sh
pm2 restart puzzle-db                          # under systemd: sudo systemctl restart puzzle-db
pm2 logs puzzle-db --lines 5 --nostream        # a fresh "puzzledb —" line, and no "not starting"
```

On a first deploy there is nothing to restart yet; carry on below.

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

*The path for a box not yet migrated to releases, and the fallback. On a migrated box
the tool writes the ecosystem file and starts the site from it (above).*

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

**First, check that this user's pm2 comes back after a reboot.** `pm2 save`, below,
only writes the list down. What reads it back at boot is the systemd unit that
`pm2 startup` installs for a user, `pm2-<user>`, which runs `pm2 resurrect`. As the
game's user:

```sh
systemctl is-enabled "pm2-$(id -un)"   # must print: enabled
```

Anything else, and look for the unit under another name before deciding there is
none: `systemctl list-unit-files 'pm2*'` lists them, and
`systemctl cat <that unit> | grep -E '^(User|Environment=PM2_HOME)='` says whose list
one restores. If this user has one, carry on, and never run `pm2 startup` again: the
root [`DEPLOY.md`](../../DEPLOY.md) says so. Nor is it a way to find out, since run
as root it writes and enables a unit on the spot, without looking for one already
there. If this user has none, a site started under its pm2 is gone after the next
reboot and nothing says so: use *Or under systemd*, below, instead.

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

Then `pm2 list`, but hold `pm2 save` until the loopback check below has passed: a
saved app is what pm2 brings back at the next boot, and a site that fails its checks
should not come back. Never `pkill -f`; stop a stray process by its exact PID.

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
with. Every later step that stops, starts, restarts or reads the site through pm2
gives the `systemctl` or `journalctl` form beside it.

---

## Check it on loopback, before any DNS

```sh
curl -s 127.0.0.1:3002/health; echo
curl -sI 127.0.0.1:3002/ | grep -iE '^(HTTP|content-security-policy|x-frame-options)'
curl -s 127.0.0.1:3002/puzzle/1 | grep -o '<title>[^<]*</title>'
```

Expect `"ok":true` with the banner's counts; `HTTP/1.1 200 OK` and both headers; and
`<title>#1 first — Puzzle archive</title>`.

**The boards, and the page bodies:**

```sh
curl -s 127.0.0.1:3002/leaderboards | grep -o '<title>[^<]*</title>'                 # <title>Leaderboards — Puzzle archive</title>
curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:3002/data/leaderboards.json        # 200
curl -s 127.0.0.1:3002/solves | grep -o '<title>[^<]*</title>'                       # <title>Recent solves — Puzzle archive</title>
curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:3002/solves/                        # 404: one spelling per page
for b in players solves; do curl -s -o /dev/null -w "$b %{http_code} %{content_type}\n" "127.0.0.1:3002/data/$b.json"; done   # each 200 application/json; charset=utf-8
curl -s 127.0.0.1:3002/data/no-such-thing.json; echo                                   # {"error":"Not found"}
curl -s 127.0.0.1:3002/puzzles.json | bun -e 'const d = await Bun.stdin.json(); console.log(`schema ${d.about.schema}: ${d.players.length} players listed, ${d.servers.length} servers (${d.servers.filter((s) => s.name === null).length} unnamed)`)'
```

Expect `schema 2`. Servers the game knew before this deploy have no name until a
player signs in from them, so on the first deploy most or all may be unnamed; that
fills in as people play.

**Nothing shaped like a Discord id.** No run of seventeen digits may appear in the
index or any body; each line must print `0`:

```sh
curl -s 127.0.0.1:3002/puzzles.json | grep -cE '[0-9]{17}'
for b in leaderboards players solves; do curl -s "127.0.0.1:3002/data/$b.json" | grep -cE '[0-9]{17}'; done
```

A `1` is a stop: `pm2 stop puzzle-db` (under systemd, `sudo systemctl stop puzzle-db`)
and report it, without pasting the matching text anywhere.

**The spoiler check.** The site must never show today. This works out today the way
the game does — Bun reads the game's zone from `activity/.env` — then asks the site
for the newest day it shows, and for today's page:

```sh
TODAY=$(bun -e 'import {dayNumber} from "./shared/daily"; console.log(dayNumber(Date.now(), {timeZone: process.env.DAILY_RESET_TIMEZONE?.trim() || "America/Los_Angeles"}))')
curl -s 127.0.0.1:3002/health | bun -e 'const {throughDay} = await Bun.stdin.json(); console.log(`today is day '"$TODAY"'; history runs through day ${throughDay}`)'
curl -s -o /dev/null -w '%{http_code}\n' "127.0.0.1:3002/day/$TODAY"    # must print 404
curl -s -o /dev/null -w '%{http_code}\n' "127.0.0.1:3002/data/day/$TODAY.json"    # must print 404
```

History must end **before** today, and today's page and today's boards must each be
a `404`. The site also cuts by the game's own zone, which the game writes into its
database at every start; it must name the same zone as `$TODAY` above was worked out
in (America/Los_Angeles unless the game sets `DAILY_RESET_TIMEZONE`):

```sh
bun -e 'import {Database} from "bun:sqlite"; const db = new Database(process.argv[1], {readonly: true}); console.log(db.query("SELECT value FROM site_facts WHERE name = ?1").get("time_zone")?.value ?? "no zone recorded")' "$(grep -E '^DATABASE_PATH=' puzzledb/.env | cut -d= -f2-)"
```

If any of these is wrong, `pm2 stop puzzle-db` (under systemd, `sudo systemctl stop puzzle-db`) and
report it. Do not put the site in front of anybody.

**The download** holds these twelve tables and nothing else:

```sh
DL=$(mktemp -d)/tetrisatuci-puzzles.sqlite
curl -s 127.0.0.1:3002/puzzles.sqlite -o "$DL"
bun -e 'import {Database} from "bun:sqlite"; const db = new Database(process.argv[1], {readonly: true}); console.log(db.query("SELECT name FROM sqlite_master WHERE type = ?1 ORDER BY name").all("table").map((t) => t.name).join(" "))' "$DL"   # about day_boards day_puzzles lines player_clears players puzzle_stats puzzles rush_boards servers standings tier_boards
```

**Only now, under pm2, `pm2 save`**, and only once `pm2 list` shows every app as
you want it kept: `pm2 save` records all of them, DIAYN's included.

---

## Put db.tetrisatuci.org in front of it

The site listens on loopback only, so whatever answers for db.tetrisatuci.org must
run on this box: a cloudflared connector on another machine cannot reach it. What
does this box have?

```sh
ps -ww -o user=,pid=,args= -C cloudflared | sed -E 's/(--token[ =])[^ ]+/\1<redacted>/'
sudo grep -ls '^ingress:' ~<the user it runs as>/{.cloudflared,.cloudflare-warp,cloudflare-warp}/config.y{,a}ml {/etc,/usr/local/etc}/cloudflared/config.y{,a}ml 2>/dev/null
```

The first line is each connector's own command line. The second lists the files
cloudflared reads its routes from when it is given no `--config`, in the order it
looks, and only those that have routes; `~` there is the home of the user it runs
as, not yours. What each signal means:

- **`--token` or `--token-file` on the first line** is how a **remotely managed**
  tunnel runs: its routes live in Cloudflare, not on this box. Use (a).
- **`--config <file>` on the first line** names the file a **locally managed**
  tunnel reads its routes from, if that file has an `ingress:` section. Use (b),
  with that file.
- **Neither flag, and a file from the second line**: a locally managed tunnel,
  reading the first file listed. Use (b), with that file.
- **No cloudflared at all**: (c).

**Anything else, and do not guess.** A token can also reach cloudflared through its
environment, which the first line cannot show. This prints `token` if it did, which
is (a), and never the token itself:

```sh
sudo grep -qzE '^TUNNEL_TOKEN(_FILE)?=' /proc/<its PID>/environ && echo token
```

If it prints nothing, open this box's tunnel in Cloudflare's Zero Trust dashboard,
which knows which kind it is. A remotely managed tunnel lets you add a public
hostname: (a). A locally managed one offers to migrate instead: that is (b) with a
file none of this found, so stop and report it. **Never migrate the game's
tunnel**: that moves the game's own routes off this box and into the dashboard.

**(a) A remotely managed tunnel.** In Cloudflare's Zero Trust dashboard, open this
box's tunnel and add a public hostname: subdomain `db`, domain `tetrisatuci.org`,
service type `HTTP`, URL `127.0.0.1:3002`. Cloudflare creates the DNS record and
sends the route to the connector itself — nothing restarts and nothing on the box
changes. The tetrisatuci.org zone must be on the same Cloudflare account as the
tunnel.

**(b) A locally managed tunnel.** Add this rule to that file, **above** the last,
catch-all rule (`- service: http_status:404` or the like), and leave the game's rule
as it is:

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
or `sudo nginx -t && sudo systemctl reload nginx`. A Caddy reload closes every
WebSocket it proxies, so if the game is behind the same Caddy, reload it **at a
quiet hour**: the game's duels go with them. Behind Cloudflare's proxy (an
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
curl -s -o /dev/null -w '%{http_code}\n' https://db.tetrisatuci.org/solves/      # 404
for b in players solves; do curl -s -o /dev/null -w "$b %{http_code} %{content_type}\n" "https://db.tetrisatuci.org/data/$b.json"; done   # each 200 application/json; charset=utf-8
```

Then, in a browser at <https://db.tetrisatuci.org/>, with the developer console open
the whole time:

- search for a title, open a puzzle, press **Show the answer** and step through it
  with the arrow keys, then open **Days** and one day;
- on that day, the boards under the deal cards: pick a server chip and check the
  address gains `?server=`, then switch the tier tabs;
- open **Leaderboards**, then **Players**: press a column's heading and check the
  address gains `?sort=`; then one player's page, which shows *By tier*, a
  *Calendar* and *Puzzles cleared*;
- open **Solves**: pick a tier and check the address gains `?tier=`, then press
  **Show older days** if it is offered;
- the console must show **no Content-Security-Policy errors**, and no 404s: the
  page's icon is `/assets/favicon-<hash>.svg`, so nothing asks for `/favicon.ico`.

Paste `https://db.tetrisatuci.org/puzzle/1?v=1` into a private Discord channel. It
should unfurl with the puzzle's title and description; the `?v=1` gets past anything
Discord cached while you were setting up, so change the number to try again.

**The setting, end to end** — the only check here that needs the game. In Discord,
open the activity, then Settings: the *On the web* section must show its switch rather
than "Couldn't load this setting." Find your key without printing anything but keys and
names — from `activity/`, with your own Discord username:

```sh
bun -e 'import {Database} from "bun:sqlite"; const db = new Database(process.argv[1], {readonly: true}); console.log(db.query("SELECT public_key AS key, site_hidden AS hidden FROM players WHERE username = ?1").all(process.argv[2]))' "$(grep -E '^DATABASE_PATH=' puzzledb/.env | cut -d= -f2-)" '<your username>'
curl -s -o /dev/null -w '%{http_code}\n' https://db.tetrisatuci.org/player/<that key>   # 200 while you are shown
```

A player with nothing on a finished day yet has no page, so use an account that has
played before today. Turn **Hide me on db.tetrisatuci.org** on: within about a
minute the same `curl` prints `404`. Turn it off, and within about a minute it prints
`200` again. Both ways is the test: a switch that only hides proves nothing about
the way back.

Last, `git status` from the repository root must be clean: `puzzledb/dist/`,
`puzzledb/.env` and `puzzledb/ecosystem.config.cjs` are all ignored.

---

## Last, the bot — if its code changed

Only once everything above has passed. The root [`DEPLOY.md`](../../DEPLOY.md) says
whether this deploy needs a bot restart at all — only a change to `client/` or
`changelog.json` since the commit the running bot started on does, which is not
always the commit before this pull — and how: by the bot's own name, never with
`pm2 restart all`, which would take DIAYN down with it. The restart posts nothing. It
makes the new release notes readable through `/puzzle changelog`, to whoever asks.

---

## After every activity deploy

*On a box migrated to releases, the site's switch, `switch site <ref>`, does this
(above). What follows is the path for a box not yet migrated, and the fallback.*

The site is built from the activity's own code. The page compiles `client/src` and
`shared/`, and the server runs `server/puzzles.ts` and the game's other readers, so
whenever the activity is deployed the site needs the same code. `puzzledb/dist/` is
not in git, and a running process keeps the code it started with, so a pull changes
neither. Once the activity is verified ([`../DEPLOY.md`](../DEPLOY.md)):

```sh
cd /path/to/BaronChairStair/activity
bun run build:puzzledb
pm2 restart puzzle-db                      # under systemd: sudo systemctl restart puzzle-db
pm2 logs puzzle-db --lines 5 --nostream    # a fresh puzzledb — line; under systemd: journalctl -u puzzle-db -n 5 --no-pager
```

Restarting it never touches the game, and it takes no part in the game's handover: it
binds 3002 alone (`reusePort: false`), so a second copy is refused rather than sharing
the port, and it writes no status file and no `build.json`, so its pages never offer an
update. To tell whether a specific change reached the page, ask `puzzledb/dist/assets/`
the way the activity's guide asks its own `dist/`:

```sh
ls -l puzzledb/dist/assets/                                  # newer than the pull
grep -l "<a string only the change adds>" puzzledb/dist/assets/*.js
```

Data needs none of this. An accepted puzzle, a correction, a publish or a rebuilt
`puzzles.json` reaches the site by itself within about 30 seconds, and so does a
player hiding or showing themselves.

---

## Naming servers, and not naming one

A server's name comes from the activity's sign-in, so it appears once somebody signs
in from that server and changes when Discord's does. What the game holds, as counts
only — never print `guild_id`:

```sh
bun -e 'import {Database} from "bun:sqlite"; const db = new Database(process.argv[1], {readonly: true}); console.log(db.query("SELECT COUNT(*) AS servers, COUNT(name) AS named FROM guilds").get())' "$(grep -E '^DATABASE_PATH=' puzzledb/.env | cut -d= -f2-)"
```

**Not naming a server** is `HIDDEN_SERVER_KEYS` in `puzzledb/server/policy.ts`, and
which servers go on it is the owner's decision, never an implementer's
(`CLAUDE.md`). The key is the ten characters after `?server=` when that server's
chip is picked on the site, or the `public_key` beside its name here:

```sh
bun -e 'import {Database} from "bun:sqlite"; const db = new Database(process.argv[1], {readonly: true}); console.log(db.query("SELECT public_key AS key, name FROM guilds WHERE name IS NOT NULL ORDER BY name").all())' "$(grep -E '^DATABASE_PATH=' puzzledb/.env | cut -d= -f2-)"
```

The edit is a reviewed commit to the site alone. The list is read when the site starts,
so starting the site on that commit is what applies it; the game is not touched. The
listed server keeps its boards and shows as "Unnamed server".

**On a box migrated to releases**, the commit goes out as a release, from the current
release's `activity/`, with `--dry-run` before each switch:

```sh
bun run deploy prepare <ref>     # ends "prepared <sha> in <its directory>"
bun run deploy status            # "game (<its pm2 name>, <the game's release>): …"
git diff --stat <the game's release> <sha> -- . ':!puzzledb' ':!tests/puzzledb-*'
```

Nothing listed: `bun run deploy switch site <sha>` applies it, then *Check it on
loopback* and *Verify it publicly*. Anything listed means the release brings the game
something too, so it goes out in the order *On a box migrated to releases* gives, game
first. **Never `pm2 restart` the site here**: it restarts the old release's process, on
the old code, so the edit is not applied and nothing says so.

*On a box not yet migrated*, it is the *Nothing listed* path of *Checks, then the
build*, then `pm2 restart puzzle-db` (under systemd, `sudo systemctl restart puzzle-db`).

---

## Rolling back, or taking it down

**Taking it down** is `pm2 stop puzzle-db` (under systemd,
`sudo systemctl stop puzzle-db`), and that step never affects the game. On a box
migrated to releases it stays down only while nothing switches the site, however it
was taken down: *On a box migrated to releases*, above, says which commands to leave
out. With nothing listening on 3002, db.tetrisatuci.org answers only `502`, so the
hostname does no harm left in place while the site is down. Remove it when you want it
gone, at a quiet hour wherever that touches the game:

- **(a) the dashboard route**: at any time. Nothing restarts.
- **(b) the ingress rule**: cloudflared reads its rules only when it starts, and
  that restart drops every connection through the tunnel, the game's duels and open
  activities included. Leave the rule until a quiet hour, and take it out with that
  restart.
- **(c) the proxy block**: with the proxy's next reload, at a quiet hour too if the
  game is behind the same Caddy, whose reload closes the game's duels.

For good: `pm2 delete puzzle-db`, check `pm2 list`, then `pm2 save`
(`pm2 save --force` if puzzle-db was this user's only app: a plain `pm2 save` will
not write an empty list). Under systemd: `sudo systemctl disable --now puzzle-db`.

**This first deploy failed verification.** The bot has not restarted — it comes
last — so `/puzzle changelog` still offers what it offered before. The site's own
rollback is taking it down: the process, and the hostname if you want it gone, as above.

```sh
pm2 delete puzzle-db
pm2 list    # every other app as you found it
pm2 save    # or the next reboot brings puzzle-db back; --force if the list is now empty
```

Under systemd, `sudo systemctl disable --now puzzle-db` instead.

That leaves the checkout where the activity's deploy put it, release notes about the
site and all, so leave the bot running on what it loaded until the site is back. The
checkout is then ahead of the bot, which is why the root guide's restart check compares
against the commit the running bot started on, not the one before the next pull.
Putting the checkout back is the **activity's** rollback, never a step of the site's:
the game runs the pulled code and serves the page built from it, and a bare
`git checkout` would move neither, leaving the game's next restart to boot the old
server against the new page with no error anywhere. So when the checkout must go back,
roll the activity back by [`../DEPLOY.md`](../DEPLOY.md), *Rolling back* — checkout,
install, build and restart, to the commit you noted in *Before you start*.

**The player-data deploy (`beta 0.13`) failed verification.** The checkout goes back,
by the activity's rollback, as above: the game's new setting points players at pages
this site cannot show, so it goes back with them. The game's migration only added
columns and tables, so the older code runs on the migrated database unchanged
(`../DEPLOY.md`, *Rolling back*). Then rebuild and restart the site on the older
checkout (the commands just below).

**The profile-browser deploy (`beta 0.15`) failed verification.** Take the site down,
or back with the activity's rollback, as above.

Players whose results were published in the meantime stay in whatever copies were
taken; a rollback cannot recall them, which is one reason to start this deploy only
when you can finish it.

If the bot had been restarted onto the commit you are leaving, the root
[`DEPLOY.md`](../../DEPLOY.md), *Rolling the bot back*, has the one check to make before
restarting it again.

**A later deploy broke the site.** On a box migrated to releases this is
`bun run deploy rollback site`, which moves the site alone back to the release
`state.json` recorded, with the same checks as any switch; what follows is for a box
not yet migrated. Rolling the checkout back moves the game's code too, so it is the
activity's rollback (`activity/DEPLOY.md`, *Rolling back*), never the site's. Once the
activity is back on a commit that has the site in it:

```sh
bun install && bun run build:puzzledb
pm2 restart puzzle-db                       # under systemd: sudo systemctl restart puzzle-db
```

When only the site is wrong, take it down and report it instead.

---

## Restoring the game's database from a backup

Stop the site first and start it last:

```sh
pm2 stop puzzle-db        # under systemd: sudo systemctl stop puzzle-db
# ... restore the game's database and start the game ...
pm2 start puzzle-db       # under systemd: sudo systemctl start puzzle-db
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
- **History starts at day 247, and days before 252 show three tiers.** Earlier rows
  are the backfill nobody was dealt, and an earlier extreme row is a top-up added
  later. Both numbers are in `puzzledb/server/policy.ts`, and the owner's to change.
- **The site lists more puzzles than `/api/public`.** That route is the published
  record only, uncorrected; the site lists what players are dealt.
- **An accepted or corrected puzzle shows here before the game serves it.** The site
  shows the list the game will deal after its next restart, or after the next
  `/archive sync` reloads it (a changed board still waits for the restart).
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
- **"Unnamed server" on boards.** A server shows its name only once a player has
  signed in from it since the game began keeping names, so right after this deploy
  most servers are unnamed. A name holding a long number, or a key on
  `HIDDEN_SERVER_KEYS`, reads the same.
- **"a player" on boards.** A player who chose *Hide me on db.tetrisatuci.org*, or
  whose username holds seventeen digits in a row. Their results stay, unlabelled, by
  the owner's decision.
- **A streak one lower than the game shows.** The site counts a streak as of the
  newest finished day; the game counts today too, once it is solved.
- **Discoveries counting more lines than the puzzle pages show.** The board counts
  as the game does, voided lines and lines on puzzles the site does not list
  included.
- **A player's *Puzzles cleared* list shorter than their *Puzzles cleared* count.**
  The count is the game's, any puzzle; the list holds only puzzles the site lists,
  and the page says how many more there are.
- **No solves from today in *Solves*, and no rushes at all.** The feed shows finished
  days only, like every page, and daily solves only: each day's page has its rush
  board.

## Things that are wrong

- **`[puzzledb] not starting:` with a line like `SESSION_SECRET is set in this
  process's environment`.** Bun loaded the game's `.env`: the site was started
  without `--env-file=…/puzzledb/.env`, under a unit with an `EnvironmentFile=`, or
  from a shell that exports a secret. Start it as above.
- **`[puzzledb] could not rebuild the public data (the game has not recorded its time
  zone; start the game on this code first)`.** The database has the player-data
  tables but no zone in `site_facts`: something on this code migrated it — a
  maintenance tool opens it without a zone, on purpose — and the game has not
  started on this code since. Deploy and start the game (`../DEPLOY.md`); the site
  picks the zone up at its next check.
- **`DATABASE_PATH is not set`.** The env file was never read — Bun skips a missing
  `--env-file` without a word — or never filled in. Check the path in the pm2 file
  or the unit, and `grep -E '^[A-Z_]+=' puzzledb/.env`.
- **`[puzzledb] cannot open <path> read-only (…) — is the game running, and is
  DATABASE_PATH the game's own?`** A wrong path, a game that has never run there, or
  a user without access to the file and its directory.
- **`[puzzledb] this process runs as uid <X>, but <path> belongs to uid <Y>`.** The
  site runs as the wrong user. Stop it and start it as the game's: a `-wal` or
  `-shm` file made by the wrong user can stop the game writing.
- **`error: Failed to start server. Is port 3002 in use?`**, with
  `code: "EADDRINUSE"` below it. Something already listens on 3002, usually a
  second copy of the site, and this copy exits 1 rather than share the port. A
  `now serving` line just above the error is that copy's own first build, which
  runs before it asks for the port. `ss -ltnp | grep ':3002'` names the holder and
  `pgrep -af puzzledb/server/main.ts` lists copies; stop the extra one by its pm2
  name, its unit or its exact PID. Never `pkill -f`.
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
