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

Two projects, separate deploys, different `.env` files. Follow the guide for the half
you are touching, in the order it gives — the order is load-bearing in both.

Where this file and a guide differ, **do the stricter thing and say so in your report.**
Do not treat either as licence to skip a step the other requires.

## The one thing the guides cannot tell you, because it is about you

**When a check goes red, stop and report. Do not restart through it.** That is this
project's own precedent and it has caught real bugs. A check that is red on a box where
CI was green usually means the box differs from CI in a way worth understanding.

Two exceptions worth knowing so you do not stop on a healthy deploy:

- `bun test` in `activity/` reports **around 83 skips** on a box without
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

**Add one whenever a change is visible to a player.** The file's own rule for what
counts: "Refactored the planner" is not a change to announce; "the drag lands where
the preview showed" is. A new tier, a fixed error message, a button that now asks
before doing something irreversible — all of those.

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
  every future day deals. (`bun run sync-archive` is safe and re-runnable by contrast —
  everything it writes lands unpublished, and that is the review gate.) Both live in
  `activity/`, not the root.
- **`GOAL_ENFORCEMENT`.** Controls whether clear requirements are shown and enforced.
  Check what the box actually sets (`grep -E '^GOAL_ENFORCEMENT=' activity/.env`) rather
  than assuming; it defaults to `log`, which shows and enforces nothing. Turning it `on`
  needs the current bundle deployed first, or players are judged against a requirement
  their client never showed them.
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
- **Leave two bot processes running.** Two instances on one token double-handle every
  command, which presents as the bot answering everything twice. Stop the old one before
  starting the new one — `DEPLOY.md` has the commands for finding how it runs.
- **Assume `.env` is loaded.** Bun reads `.env` from the process working directory only;
  it does not look beside the entrypoint and does not walk up.

## Couplings that are easy to miss

- `PUZZLE_API_KEY` in the root `.env` must match `BOT_API_KEY` in `activity/.env` —
  **different names on either side.** A mismatch is a 401, an unset key a 404, and the
  daily recap simply never posts.
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
  three places — `activity/data/puzzles.json` (what the game shows, and what an
  unpublished puzzle is judged by), the tracked archive's `solution` and
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
