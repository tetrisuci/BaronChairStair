# Deploying the activity, and turning on the review tool

Written for whoever is doing the upgrade on the production VPS — including
Claude Code with a shell on that box. It assumes you have not seen this
codebase before and cannot ask anyone questions.

Everything here runs from `activity/`, not the repository root. The two are
different projects with different `package.json` files, and running the wrong
one is the commonest way this goes sideways.

---

## What is new

The activity now takes puzzles written by players, and gives a club officer a
web tool to review them.

| | |
|---|---|
| **Submitting** | A Submit control in the in-app puzzle builder. A player must solve their own puzzle before they can send it; the server replays their keystrokes and derives the target and the answer key from what it sees. |
| **Reviewing** | A second page at `/review`, outside Discord, reached by a link minted on this box. It shows the board, steps the author's solution, and accepts or rejects. |
| **Accepting** | An accepted puzzle joins the archive and the daily/rush rotation at the next restart. |

Two things changed underneath that matter to a deployment:

1. **The build now produces two pages**, `dist/index.html` and
   `dist/review/index.html`. A deploy script that checks only the first will
   pass while `/review` silently serves the game instead.
2. **A day's three puzzles and its rush pool are now recorded in SQLite** the
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
on its own loses recent writes. Use SQLite's own backup, which takes a
consistent snapshot:

```sh
# Adjust the path if DATABASE_PATH is set in .env.
bun -e 'const {Database}=require("bun:sqlite");
        new Database("data/daily.sqlite").exec("VACUUM INTO \"data/daily.sqlite.bak\"")'
ls -la data/
```

---

## The upgrade

```sh
cd /path/to/BaronChairStair/activity

git pull                 # or however this box gets code
bun install
bunx tsc --noEmit        # must be silent
bun test                 # must be all pass, 0 fail
bun run build            # writes dist/, including dist/review/index.html
```

Then restart the service the way this box already starts it.

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
puzzle — day 247, 138 puzzles, resetting at midnight America/Los_Angeles
```

Once anything has been accepted it reads `139 puzzles (1 from players)`. If a
page is missing from the build there is a second line naming it — that warning
is one you can act on.

**2. The backfill ran.** This is the ordering rule, checked.

```sh
bun -e 'const {Database}=require("bun:sqlite");
        const db=new Database("data/daily.sqlite",{readonly:true});
        console.log("day_puzzles:", db.query("SELECT count(*) c FROM day_puzzles").get().c);
        console.log("day_rush:   ", db.query("SELECT count(*) c FROM day_rush").get().c);'
```

Expect `day_puzzles` to be roughly three times the current day number, and
`day_rush` to be at least 1. **If `day_puzzles` is 0 the server has not started
successfully** — fix that before doing anything else, and before rebuilding the
puzzle data.

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

**5. The review routes are switched on** (only if you set `REVIEW_SECRET`):

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://your-host/api/review/submissions
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
by default, and the page trades it once for a two-hour session. Those two
windows add up rather than overlap: a link spent in its last second still buys a
full two hours, so the worst case is fifteen minutes plus two hours. **Send it
in a DM, not a channel** — anywhere it can be seen is somewhere it can be used.

The name you pass is recorded against every accept and reject. It is an
attribution, not an authentication: nothing checks who ran the command. The
person with SSH to this box is the officer, and that is the real trust root.

**To revoke every outstanding link:** change `REVIEW_SECRET` and restart.

---

## Rolling back

The new tables are additive and the old code ignores them, so a rollback is
ordinary:

```sh
git checkout <the commit you noted>
bun install && bun run build
# restart
```

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
- **An accepted puzzle not appearing immediately.** The archive is read once at
  start-up. It appears at the next restart, and the review tool says so when you
  accept.
- **`day_puzzles` growing by three rows a day forever.** That is the design. It
  is a few hundred kilobytes a decade.

## Things that are wrong

- **The service will not boot, and the error names a puzzle.** An accepted
  puzzle failed validation at load. The message gives its id. Undo that
  acceptance and restart:

  ```sh
  bun -e 'const {Database}=require("bun:sqlite");
          new Database("data/daily.sqlite").run(
            "UPDATE submissions SET status = ?, puzzle_id = NULL WHERE puzzle_id = ?",
            ["pending", Number(process.argv[1])])' <the id from the error>
  ```

  Then report it, because the accept route is meant to make that impossible.
- **`day_puzzles` is empty after a start that otherwise looked fine.** The
  backfill did not run. Do not accept anything and do not rebuild the puzzle
  data until you know why.
