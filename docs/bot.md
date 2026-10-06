# The bot, command by command

Every slash command in detail — what it does, what it needs, and why it is
shaped the way it is. For the short version, see the commands table in the
[README](../README.md).

The bot finds its sibling modules, its `.env` and its `stats.db` from its own
path, so it runs from any working directory. See [DEPLOY.md](../DEPLOY.md) for
running it properly.

---

### Replay highlights

```
/highlights top_x:5        attach a .ttrm file
!highlights 5              the prefix form; bare !highlights gives the top 3
```

Returns each player's biggest attack bursts — the five-second windows that
sent the most — as a monospace list: a line per burst giving its round, its
span in seconds, its attack and its clear and line counts, then one line per
clear in it, so the columns line up in Discord's proportional font. The bot
leaves the boards out; `render.py --highlights`, run by hand on a `.pkl` from
`build_snapshots.py`, still draws them.

### `/puzzle play` — the daily puzzle

```
/puzzle play          a short message and a link that opens the activity
```

`/puzzle` is a group with `play` and `changelog` subcommands. Discord does not
allow a command to be both directly invocable and a group, so `play` replaces
the former bare `/puzzle`. It posts the activity link without release notes.
Boards, rush, rules and scores live in the activity, one click away.

The bot owns none of the game. Puzzle details and scores stay in the activity;
the bot reads only the day number to record where a recap should reply. Needs
`PUZZLE_APP_ID` and `PUZZLE_API`. Without the first the command still
registers and says what is missing rather than failing shut; without the
second it posts the launch link with no puzzle details. `PUZZLE_API_KEY` is
for the recap below and for `/archive sync`, not for `/puzzle play` itself.

The daily recap is **off unless `PUZZLE_RECAP=on`** is set in `.env`, because it
mentions everyone it names — turned on, it pings every player it names, every
day. Turning it on posts the previous day's recap as soon as the bot starts,
then one a day. When it is on, once a day after the puzzle turns over, the bot
replies to that server's own `/puzzle play` message with how yesterday went — who
solved which of the day's puzzles and how fast, who missed, and how long the
server's run of solves is. It happens once per server per day, and only in
servers that announced the puzzle in the first place, because the reply needs
something to reply to.

### `/puzzle changelog` — changes on request

```
/puzzle changelog [count:5]
```

Requests the five most recent individual change bullets by default. `count` accepts
1–20 changes, newest first, across release boundaries; it counts changes rather
than releases. The reply is ephemeral, visible only to the person who requested
it, and uses `AllowedMentions.none()` so release notes cannot ping anyone.
Launching the activity never posts a changelog to the channel.

The command can be used repeatedly. It does not track which releases a server
has seen, and old `bot_versions` records do not hide notes or prevent another
request. Each request produces one private reply with an inline preview capped
at 1,900 UTF-16 units. If the requested changes do not fit, the reply attaches
`puzzle-changelog.txt` containing every selected change in full. The preview
notes any omitted bullets or shortened first bullet; the attachment preserves
the full requested notes without adding channel messages.

The project's version is the first release listed in `changelog.json` at the
repository root — the same list that says what each one changed. Releasing is
adding an entry at the top of `releases`; `VERSION` in `client/changelog.py`
is read from it, and a test fails if it is not. Order in that list *is* the
version order — comparing `beta 0.10` against `beta 0.9` as text is wrong and
as numbers is a parser nobody needs.

### `/report` — a bug, without a GitHub account

```
/report category:<Bugged puzzle | UI issue | …> description:<what happened>
```

Files a GitHub issue on the player's behalf, so somebody can say "puzzle 46 is
unsolvable" without making an account. The title is their Discord display name
and the category; the body is what they wrote, followed by a line saying who
sent it and from which server.

It stays a top-level command so a player can file a report directly without
opening the puzzle command group.

Needs `GITHUB_TOKEN` and `GITHUB_REPO`; without them the command still
registers, and tells the player privately that an officer has yet to finish
setting it up. It does not say which key is unset, and logs nothing, so check
both. **It publishes text typed by anybody in the server, under the bot's
identity, to whatever repository you name** — so the token should be
fine-grained, scoped to Issues on that one repository, and able to do nothing
else. `@mentions` and `#references` are defanged so a report cannot become a
stranger's notification, the description is capped, and one player may file
fifteen reports an hour, and one server sixty.

### `/archive sync` — pull the spreadsheet in, once every 10 minutes

```
/archive sync [dry_run:True]
```

Runs `bun run sync-archive --publish` against the club's sheet, reports what
moved — what was added, what changed content, and what would not replay — and
**makes it playable straight away**. From Discord a sync is also a publish,
and there is no review step: anyone may run it, so what the sheet holds is
what players get. Edit access to the sheet is the gate; the 10-minute window
limits how often a sync runs but reviews nothing. So the sync publishes
every row it leaves waiting, then asks the activity to reload its puzzle pool
in place — no restart, so nobody's duel drops and nobody is signed out.

What players notice, and what they deliberately do not:

- **New puzzles** join Explore at once, and join the daily and rush rotation
  from **tomorrow**. Today's four puzzles and today's rush pool are already
  pinned and do not move, so a rush in flight is scored on what it was dealt.
- **A corrected title, goal or difficulty** on an unchanged board goes live at
  once.
- **A changed board** — the sheet replaced the puzzle behind an id — is held as
  it was until the activity next restarts, and the reply names it. Swapping it
  would score somebody mid-solve against a board they were never shown.

If the activity cannot be reached, the reply says so: the rows are published
all the same, and they go live at its next restart. `dry_run` reads the sheet
and writes and publishes nothing at all. A terminal sync without `--dry-run` or
`--publish` lands new rows unpublished, but it still writes the sheet's edits
over puzzles already published: the public archive feed (`/api/public`) serves
them at once, players get them at the activity's next restart, and a changed
board, queue, hold, target or answer voids that puzzle's discovered lines
straight away. Neither `publish-archive` nor `bun run puzzles` is reachable
from Discord.

It stays in its own group, separate from the player-facing
`/puzzle play` and `/puzzle changelog` commands.

**Anyone may run it, once every 10 minutes.** It used to be limited to an
allowlist of officers; now any member in any server may, and what bounds it is
one window shared by every server and every member, dry runs included. The
window opens when a sync actually starts — a refused request, or one that could
not launch (no `bun`, no activity checkout), does not use it — and a second
request while one is running is refused too. When the last sync started is kept
in `stats.db` (`client/sync_window.py`), so restarting the bot does not reopen
it. A refusal is private and says, in each reader's own timezone, when the last
sync started and when the next may; the public reply under a sync says when the
next may start. A `puzzle-admins.json` left on a box from the allowlist days is
no longer read.

Set `PUZZLE_ACTIVITY_DIR` only if the activity is not the `activity/` beside
this repository; the sync runs with its working directory there, because Bun
reads `.env` from the working directory and does not walk up.

### `/activity` — who is around

```
/activity graph [days] [breakdown] [guild_id]    PNG graph, last 7 days by default
/activity now [guild_id]                         online / idle / dnd right now
```

Backed by `presence_tracker.py`, which samples every 10 minutes. Both accept a
`guild_id` to inspect any server the bot is in. The x-axis is labelled in
Pacific time, because the club is.
