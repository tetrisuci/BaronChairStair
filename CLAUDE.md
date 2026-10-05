# Working in this repository

**This file does not contain deploy instructions. It tells you where they are, and
carries the few rules that live nowhere else.**

That split is deliberate. An earlier version of this file restated the deploy
sequences and got the activity's build order backwards, which would have shipped an
unverified client bundle to players. Two documents describing the same procedure will
drift, and the copy loaded into every session is the one that drifts unnoticed.

## Read the real guide before deploying

| | Lives in | Its guide |
|---|---|---|
| **The Discord bot** | repository root, `client/` | [`DEPLOY.md`](DEPLOY.md) |
| **The activity** (the puzzle itself) | `activity/` | [`activity/DEPLOY.md`](activity/DEPLOY.md) |
| **The puzzle database site** (db.tetrisatuci.org) | `activity/puzzledb/` — its own process, build and `.env` | [`activity/puzzledb/DEPLOY.md`](activity/puzzledb/DEPLOY.md) |

Two projects and a site: three deploys, different `.env` files. Follow the guide for the
one you are touching, in the order it gives — the order is load-bearing in all three.

Where this file and a guide differ, **do the stricter thing and say so in your report.**
Do not treat either as licence to skip a step the other requires.

## The one thing the guides cannot tell you, because it is about you

**When a check goes red, stop and report. Do not restart through it.** That is this
project's own precedent and it has caught real bugs. There is no CI — the suites are
run by hand before a pull request, as `README.md`'s *Contributing* asks — so a check
that is red on a box when it passed for the author usually means the box differs from
the author's machine in a way worth understanding.

Two exceptions worth knowing so you do not stop on a healthy deploy:

- `bun test` in `activity/` reports **around 100 skips** on a box without
  `data/solutions.json`, which is gitignored and not in git. Skips are expected;
  `0 fail` is the thing to check.
- A bot suite run with a bare `python3` skips or stubs anything needing `discord.py`.
  Use the interpreter that actually runs the bot.

## Client-side changes need a build, and fail silently without one

`activity/dist/` is gitignored, so `git pull` never updates it and the server serves
whatever bundle is on the box (`activity/server/config.ts` → `clientBuild: ../dist`).
A pull and a restart give you the new server and the old client, with no error anywhere:
the page loads, nothing throws, and the behaviour is simply the old one.

This applies to everything under `activity/client/` — both the game (`client/src/`)
and the officer review tool (`client/review/`), which build together.

`activity/DEPLOY.md` has the sequence and the verification steps, including how to tell
whether a *specific* change reached the bundle. Use them; a restart is not a deploy.

The puzzle database site is a second, separate build of the same code:
`bun run build:puzzledb` compiles `client/src` and `shared/` into `activity/puzzledb/dist/`,
and its server runs `server/puzzles.ts`. So an activity deploy leaves the site on the old
code until it too is rebuilt and restarted —
`activity/puzzledb/DEPLOY.md`, "After every activity deploy", says how.

## A player-visible change needs a release note, and nothing will remind you

`changelog.json` at the repository root is both the version and the changelog:
`releases` is a newest-first list, the version is just the first entry's, and shipping
a version means putting a new entry at the top of that file.

`/puzzle` announces to a server every version it has not been told about, so the note
is how players find out anything changed.

It is a JSON file rather than a Python literal because the activity briefly showed the
same notes on its own front screen. That card is gone — eight release notes pushed the
day itself off the bottom of the screen — but the file stays where it is: one list, in
one place, read by the half that announces it.

**Add one whenever a change is visible to a player.** The rule for what counts, from
`client/changelog.py`: "Refactored the planner" is not a change to announce; "the drag
lands where the preview showed" is. A new tier, a fixed error message, a button that
now asks before doing something irreversible — all of those.

This is the easiest rule in the repository to skip, because skipping it breaks
nothing. No test fails, no deploy stops, the bot simply goes quiet and players are
never told. It has already happened: **seven merged PRs — #58 through #64 — shipped
four daily tiers, a restored answer walkthrough, a confirmation on "Hand it in" and
three fixed player-facing bugs, and not one of them wrote a note.** The whole lot had
to be written up afterwards as `beta 0.2`, from the git log, by somebody guessing what
a player would have noticed.

Write the note in the same commit as the change, while you still know what a player
would see.

There is only one version, and it is the top of that file. `activity/package.json`
carries a `"version": "1.0.0"` that nothing reads — do not bump it and do not go
looking for a second place. (`preferences.version` and `SETTINGS_VERSION` are schema
versions for stored data, unrelated to what the bot announces.)

Nothing will stop you shipping without a note: a missing or malformed
`changelog.json` costs the announcement and the bot starts anyway. That is deliberate
— a changelog must never be what keeps the bot from booting — and it is also why
nothing will remind you.

## Decisions that are not yours to make

Report these and stop; do not act on them unasked.

- **`bun run puzzles`** rebuilds `data/puzzles.json` from the club's spreadsheet.
  `activity/DEPLOY.md` forbids running it before the backfill, and it has caused a boot
  failure by dropping a puzzle a rush pool referenced.
- **`bun run publish-archive`** makes synced puzzles playable, which changes which puzzle
  every future day deals. **`bun run sync-archive`** is not the safe half it looks like:
  a new row lands unpublished, but a sheet edit to a puzzle already published is written
  over that row in the live database and the row stays published. Players are served
  the edit from the next restart (a title or goal fix sooner, if `/archive sync` reloads
  first), and a changed board, queue, hold, target or answer voids that puzzle's
  discovered lines at once. `sync-archive --dry-run` is the safe, re-runnable one: run
  it and report what it would move. Both live in `activity/`, not the root.
- **Discord's `/archive sync` (without `dry_run`)**, or `sync-archive --publish`. Unlike
  a plain terminal sync, these **publish** every row left waiting, so they change what
  players are dealt from tomorrow on. From Discord the running activity is then
  reloaded; run by hand, `--publish` does not reload, and the activity serves it from
  its next restart. Anyone in Discord may run `/archive sync` now — there is no
  allowlist — at most once every 10 minutes across every server, dry runs included,
  and it still publishes. That any member may run it does not make it yours to run
  unasked.
- **`GOAL_ENFORCEMENT`.** Controls whether clear requirements are shown and enforced.
  Check what the box actually sets (`grep -E '^GOAL_ENFORCEMENT=' activity/.env`) rather
  than assuming; it defaults to `log`, which shows and enforces nothing. Turning it `on`
  needs the current bundle deployed first, or players are judged against a requirement
  their client never showed them.
- **`PUBLISH_COMMUNITY_PUZZLES`, `FIRST_TIERED_DAY`, `FIRST_EXTREME_DAY` and
  `HIDDEN_SERVER_KEYS`** (`activity/puzzledb/server/policy.ts`). The first puts
  player-written puzzles and their authors' Discord display names on the open web, with
  no consent step. The next two decide which days the site presents as dealt, and come
  from the production box. The last decides which Discord servers the site will not
  name; adding a key to it or taking one off is the owner's call.
- **A player's "Hide me on db.tetrisatuci.org"** (`players.site_hidden`). It is theirs
  to set, in the activity's settings. Never write it on anybody's behalf — not to tidy a
  board, not to test, not on a request relayed from somebody else — and never print a
  hidden player's name or key while investigating anything.
- **Rotating a secret**, or anything that signs users out.

## Never

- **Commit `activity/data/daily.sqlite`, or its `-wal`/`-shm`.** This repository is
  **public** and that file holds real Discord ids, usernames, run history and
  submissions. It is gitignored; keep it so. `VACUUM INTO` compacts it faithfully and
  redacts *nothing* — a backup tool, not an export. The only database that may be tracked
  is `activity/data/archive/puzzles.sqlite`, built fresh by the sync and never having
  held a player table; `activity/tests/tracked-archive.test.ts` asserts that.
- **`pkill -f` on a broad pattern.** `pkill -f "server/index.ts"` matches more than you
  mean and has already taken down the wrong server. Kill by exact PID.
- **Leave two copies of this bot running.** Two instances on one token double-handle
  every command, which presents as the bot answering everything twice. Stop the old one
  before starting the new one — `DEPLOY.md` has the commands for finding how it runs.
  The box also runs DIAYN, a separate bot with its own service (`diayn`), checkout,
  `.env` and token. It is meant to be there: act on this bot by name, and never
  `pm2 restart all` or `pm2 stop all`, which take DIAYN down too.
- **Assume `.env` is loaded.** Bun reads `.env` from the process working directory only;
  it does not look beside the entrypoint and does not walk up.

## Couplings that are easy to miss

- `PUZZLE_API_KEY` in the root `.env` must match `BOT_API_KEY` in `activity/.env` —
  **different names on either side.** A mismatch is a 401, an unset key a 404, and the
  daily recap simply never posts — though check `PUZZLE_RECAP=on` first: the recap
  is off unless it is set.
- A new slash command needs a restart to appear, and a global sync can take an hour.
  `sync_guilds.py <SERVER_ID>` pushes it to one guild at once — then
  `sync_guilds.py --clear <SERVER_ID>` once the global ones land, or the picker shows
  every command twice.

## A puzzle whose goal asks for a spin that clears no lines

Rare, and opt-in. The engine names such a spin, but a puzzle only *requires* one
if its id is in `PUZZLES_REQUIRING_A_SPIN_WITHOUT_LINES`
(`activity/shared/puzzle.ts`). Everywhere else it is ignored on purpose — that
constant's own docstring carries the measurement and the reasoning, and this is
not the place to restate them.

**When the owner names a puzzle, the whole edit is one id in that set.** Two
things follow, and nothing will remind you of either:

- **Re-derive what is stored: `bun run rederive-clears --write`, in `activity/`.**
  The rule lives in code; the requirement a player meets is *written down*, in
  three places — `activity/data/puzzles.json` (what the game shows, and judges
  against, for an unpublished puzzle), the tracked archive's `solution` and
  `required_clears` (where a deploy box gets the answer from, `data/solutions.json`
  being untracked), and this box's own `data/solutions.json`. The flag alone
  changes none of them. That command replays the puzzle's own blueprint through
  the current engine, corrects all three, and refuses to write anything if the
  replay comes back as a different answer rather than a renamed one. It needs no
  spreadsheet and is re-runnable.

  **It is not `bun run sync-archive`, which this file used to say.** The sync
  does re-derive, but into `daily.sqlite` by default and never into
  `data/puzzles.json` — and an unpublished puzzle is served from that file, so a
  sync changes nothing the player sees. Correcting the requirement while leaving
  the stored answer alone is worse than correcting neither:
  `withoutUnmeetableClears` then sees a shortfall and serves the puzzle with
  **no** requirement at all. This is not hypothetical — #123 shipped with the
  flag set, a green suite, and a puzzle still asking for two spins.

  **The three files do not reach a puzzle the deploy box has published.**
  Discord's `/archive sync` runs there and publishes every row it leaves waiting
  in that box's `daily.sqlite`, and a published row is served in place of its
  `data/puzzles.json` entry (`withPublished`), with the requirement stored on
  the row — which `rederive-clears` never writes. So before calling it done,
  check the database the deployed activity serves from, on the box players
  reach: the file `DATABASE_PATH` names, or `activity/data/daily.sqlite` when it
  is unset. Run `SELECT published_at FROM archive_puzzles WHERE id = <id>`
  there; a development checkout's copy says nothing about it. If you cannot
  reach that box, say so in your report rather than calling it done. If `published_at`
  is set, report it rather than syncing: a sync into that database would
  re-derive the row, but it also applies whatever else the sheet has changed to
  every published puzzle, and the new requirement reaches players only at the
  activity's next restart, because a reload holds any puzzle whose requirement
  changed.
- **Write the release note.** A puzzle that starts asking for a third spin is a
  change a player can see, so the rule under *A player-visible change needs a
  release note* applies.

**Do not try to put the flag anywhere else.** `data/puzzles.json` is rewritten
wholesale by `bun run puzzles`, and `puzzle_overrides` carries metadata only —
title, author, goal, difficulty, set — by design. A tracked set in code is the
only home that survives both.

## Further reading

- `README.md`, `activity/README.md` — what the commands *are*, as opposed to how to run them.
- `activity/docs/puzzle-service.md` — the puzzle data layer. **A design plan, not a
  description of the running system**; sections are marked *now* or *planned*, and its
  numbered rules are the things most easily broken by accident.
