# The bot, command by command

Every slash command in detail — what it does, what it needs, and why it is
shaped the way it is. For the short version, see the commands table in the
[README](../README.md).

Run the bot from `client/`, so the sibling modules import cleanly. See
[DEPLOY.md](../DEPLOY.md) for running it properly.

---

### Replay highlights

```
/highlights top_x:5        attach a .ttrm file
!highlights 5              the prefix form; bare !highlights gives the top 3
```

Returns each player's biggest attack bursts as monospace boards, so the stacks
line up in Discord's proportional font.

### `/puzzle` — the daily puzzle

```
/puzzle               today's three sheets, and a link that opens the activity
```

One command, not a group. It used to be four; the other three rendered in
Discord what the activity now shows on its own front screen — boards, rush and
the rules all live one click away — and each was a second place for a board to
be wrong. The one job left is the one Discord is actually for: announcing the
day in a channel, with a way in.

The bot owns none of the game. It reads the activity server and formats what
comes back, so the two can never disagree about a score. Needs
`PUZZLE_APP_ID`, `PUZZLE_API` and `PUZZLE_API_KEY`; without them the command
still registers and explains what is missing rather than failing shut.

Once a day, after the puzzle turns over, the bot replies to that server's own
`/puzzle` message with how yesterday went — who solved which of the day's puzzles
and how fast, who missed, and how long the server's run of solves is. It happens
once per server per day, and only in servers that announced the puzzle in the
first place, because the reply needs something to reply to.

### Versions, and how a server hears about them

The project carries a version — `beta 0.3` at the time of writing — in
`changelog.json` at the repository root, next to the list of what each one changed.
Read by the bot's `/puzzle` announcement, below.

**A server is told the first time somebody runs `/puzzle` on a build it has not
heard about**, as a plain message behind the puzzle embed. Not on a timer and
not at boot: a deploy should not wake a channel up, so the note rides along
behind something a person actually asked for, and only the first person to ask
sees it arrive. It sends with `AllowedMentions.none()`, so a release note can
never ping a room however it is worded.

**It names every version the server missed, not just the newest one.**
Production pulls when somebody deploys, which may be several releases after the
last deploy — announcing only the tip would drop the middle ones silently. Past
three releases the message says how many older ones it is not listing, because a
server that has never heard from the bot is owed the entire history and nobody
typing `/puzzle` asked to read it — and it is trimmed by *length* as well, since
counting releases is not counting characters. Before that cap existed, three
releases of eight wordy notes rendered to 2,029 characters, which Discord
rejects outright; the same input now fits.

Releasing is adding a `Release` at the top of `RELEASES`; `VERSION` follows it,
and a test fails if it does not. Order in that tuple *is* the version order —
comparing `beta 0.10` against `beta 0.9` as text is wrong and as numbers is a
parser nobody needs.

What each server has been told lives in `bot_versions`, one row per guild, and
the claim is taken before the message is sent — the write is what stops a second
caller, so it has to happen where two callers can still both be running.

A send that fails therefore loses those notes **permanently**: the row already
says the server has heard, and the next release names only what came after it.
That is a trade, not a mitigation, and it is the right one only because nobody
depends on a changelog. Something that mattered would claim after the send and
dedupe instead.

### `/report` — a bug, without a GitHub account

```
/report category:<Bugged puzzle | UI issue | …> description:<what happened>
```

Files a GitHub issue on the player's behalf, so somebody can say "puzzle 46 is
unsolvable" without making an account. The title is their Discord display name
and the category; the body is what they wrote, followed by a line saying who
sent it and from which server.

Its own command rather than `/puzzle report`: Discord will not let a command be
both invocable and a group, and `/puzzle` is the one people already type.

Needs `GITHUB_TOKEN` and `GITHUB_REPO`; without them the command still
registers and explains what is missing. **It publishes text typed by anybody in
the server, under the bot's identity, to whatever repository you name** — so the
token should be fine-grained, scoped to Issues on that one repository, and able
to do nothing else. `@mentions` and `#references` are defanged so a report
cannot become a stranger's notification, the description is capped, and one
player may file fifteen reports an hour, and one server sixty.

### `/archive sync` — pull the spreadsheet in, officers only

```
/archive sync [dry_run:True]
```

Runs `bun run sync-archive` against the club's sheet and reports what moved:
what was added, what changed content, and what would not replay. Everything it
writes lands **unpublished**, so a sync on its own changes nothing a player is
served — publishing stays a decision somebody makes at a terminal, and neither
`publish-archive` nor `bun run puzzles` is reachable from Discord. `dry_run`
reads the sheet and writes nothing at all.

A group of its own rather than `/puzzle sync`, for the same reason `/report` is
top-level: Discord will not let a command be both invocable and a group, and
`/puzzle` is the one people already type.

**Who may run it is a file, not a role.** `puzzle-admins.json` at the
repository root holds Discord user ids, one per officer, and is **gitignored** —
this repository is public and its history is append-only, so an id committed by
mistake could not be taken back. Copy `puzzle-admins.example.json` to start
one. It is read fresh on every command, so adding somebody takes effect
immediately with no restart, and a missing or malformed file means *nobody*
rather than everybody. Anyone not on it is turned away privately.

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

### `/internships` — the tracker

```
/internships recent [days] [us_only]    recently posted tech internships
/internships info <role>                salary and description for one role
/internships ping                       subscribe yourself to notices
/internships pinglist                   who is subscribed
/internships debug                      sweep health, DB size, Gemini quota
```

Swept every 15 minutes, with notices batched to at most one an hour. A new
posting produces one quiet, mention-free message per subscribed channel with a
button on it; pressing the button replies ephemerally, so a good sweep never
floods a channel.

### `/bennxt` — retired

`roles`, `recent`, `notify`, `notifylist` and `debug` all reply *"bennxt is no
longer bummxt"*. The civil and mechanical job tracker behind them was removed
once bennxt got hired. The commands and their descriptions are kept so old
invocations still resolve and the picker looks unchanged.
