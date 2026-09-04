# BaronChairStair

The Discord bot for the Tetris at UCI club, the daily puzzle activity it
launches, and the TETR.IO replay engine both of them lean on.

It started as a bridge that let Python drive the `@haelp/teto` engine to pull
highlights out of a replay. That bridge is still here and still does that job,
but it is now one part of four:

| | |
|---|---|
| **The bot** — `client/` | Slash commands: replay highlights, the daily puzzle, server activity graphs, an internship tracker |
| **The activity** — `activity/` | A Discord Activity: one modern Tetris puzzle a day, plus a five-minute puzzle rush. Has [its own README](activity/README.md) |
| **The engine bridge** — `server/`, `client/teto_client.py` | A Bun process wrapping the TETR.IO engine, spoken to over NDJSON from Python |
| **The internship tracker** — `internship_poller.py` | Unrelated to Tetris; it lives here because the bot fronts it |

---

## Layout

```
BaronChairStair/
├── server/server.ts          Bun NDJSON stdio server — the engine side
├── client/
│   ├── discord_bot.py        the bot: commands, schedulers, entry point
│   ├── teto_client.py        Python client for the engine bridge
│   ├── build_snapshots.py    replay JSON → per-round board snapshots
│   ├── render.py             attack-burst highlight boards
│   ├── presence_tracker.py   samples who is online, every 10 minutes
│   ├── puzzle_commands.py    the /puzzle group; talks to the activity server
│   └── puzzle_recap.py       yesterday's results, replied to yesterday's post
├── activity/                 the Discord Activity (own README, own tests)
├── internship_poller.py      Greenhouse / Lever / Ashby / Workday poller
├── resolve_boards.py         careers URL → validated job-board endpoint
├── sync_guilds.py            push slash commands into one guild, instantly
├── check_dupes.py            find commands registered twice
└── example.env               every environment variable, documented
```

---

## The bot

Run from `client/`, so the sibling modules import cleanly:

```bash
pip install discord.py python-dotenv aiohttp matplotlib
cd client && python discord_bot.py
```

The token comes from `.env` at the repo root — copy `example.env` and fill it
in. `.env` values override shell exports, which is usually what you want when a
production shell has a stale one lying around.

The **Server Members** and **Presence** privileged intents must be enabled in
the Discord developer portal (Bot → Privileged Gateway Intents). Without them
login fails outright with `PrivilegedIntentsRequired`, rather than degrading.

### Replay highlights

```
/highlights top_x:5        attach a .ttrm file
!highlights 5              the prefix form; bare !highlights gives the top 3
```

Returns each player's biggest attack bursts as monospace boards, so the stacks
line up in Discord's proportional font.

### `/puzzle` — the daily puzzle

```
/puzzle play          today's sheet, and a link that opens the activity
/puzzle standings     today's leaderboard for this server
/puzzle rush          today's five-minute rush board for this server
/puzzle help          what the daily is and how it is scored
```

The bot owns none of the game. It reads four endpoints on the activity server
and formats what comes back, so the two can never disagree about a score.
Needs `PUZZLE_APP_ID`, `PUZZLE_API` and `PUZZLE_API_KEY`; without them the
commands still register and explain what is missing rather than failing shut.

Once a day, after the puzzle turns over, the bot replies to that server's own
`/puzzle play` message with how yesterday went — who solved it and how fast,
who missed, and how long the server's run of solves is. It happens once per
server per day, and only in servers that announced the puzzle in the first
place, because the reply needs something to reply to.

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

---

## The daily puzzle activity

`activity/` is a self-contained Bun + TypeScript app served as a Discord
Activity: one puzzle a day from the club's archive, scored on the server by
replaying the keys you actually pressed, plus a five-minute puzzle rush and an
explorer for the whole archive.

It has its own README, its own tests, and its own `.env`. Start there:

```bash
cd activity
bun install
bun run puzzles     # decode the archive into data/puzzles.json
bun run build
bun run dev
```

See [activity/README.md](activity/README.md) for the scoring model, what its
timing does and does not prove, and how to point Discord at it.

---

## The engine bridge

`server/server.ts` runs the `@haelp/teto` TETR.IO engine and speaks NDJSON —
one JSON object per line — over stdin and stdout. `client/teto_client.py`
drives it. You never touch the wire format unless you are extending the server.

```python
from teto_client import TetoClient
from pathlib import Path

with TetoClient(server_dir=Path("server")) as client:
    result = client.parse_replay_file("game.ttrm")
    for clear in result["clears"]:
        print(f"[{clear['timeSeconds']:.2f}s] {clear['username']}: "
              f"{clear['clearType']} +{clear['attack']} atk")
```

On start the server writes `{"type":"ready"}` and the client blocks until it
sees it. Then:

```jsonc
// request — `id` is any string, echoed back so responses can be matched
{"id": "1", "action": "parse_replay", "replay": "<minified replay JSON as a string>"}

// success
{"id": "1", "status": "ok", "clears": [ /* one object per line clear */ ]}

// failure
{"id": "1", "status": "error", "message": "Invalid replay structure"}
```

`parse_replay` is the only action. The replay must be a **string**, not nested
JSON, and on a single line — TETR.IO's own files are already minified, so this
has never come up in practice.

Each clear carries `playerId`, `username`, `round`, `frame`, `timeSeconds`,
`piece`, `clearType`, `linesCleared`, `garbageCleared`, `attack`, `attackSent`,
`isBTB`, `b2b` and `combo`. `clearType` is one of `single`, `double`, `triple`,
`quad`, `tspinSingle`, `tspinDouble`, `tspinTriple`, `allspin` (a non-T spin,
or a mini) or `perfectClear`.

To add an action, extend the dispatch in `server.ts` and call it from Python
with `client._request("my_action", field="value")`.

---

## Standalone tools

None of these are needed to run the bot.

```bash
python internship_poller.py verify        # check every job board is still live
python internship_poller.py sweep         # store and print what is new
python internship_poller.py sweep --llm   # classify new postings with Gemini
python internship_poller.py watch         # every 15 minutes until Ctrl-C
python internship_poller.py stats

# careers page → a job board that can actually be polled, validated before it
# is emitted. It never guesses an ATS slug: guessing hits about 1 in 20, and
# asking an LLM is worse — confident, well-formed, entirely fabricated URLs.
python resolve_boards.py https://careers.example.com
python resolve_boards.py --file careers_urls.txt

python sync_guilds.py SERVER_ID           # push commands into one guild, instantly
python sync_guilds.py --clear SERVER_ID   # remove the guild copies afterwards
python check_dupes.py                     # find commands registered twice
```

Global slash commands take up to an hour to propagate; a guild copy is
immediate. Run `sync_guilds.py --clear` once the global ones have landed, or
the picker shows every command twice — which is what `check_dupes.py` detects.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Bun** | ≥ 1.2 | `curl -fsSL https://bun.sh/install \| bash` |
| **Python** | ≥ 3.10 | https://python.org |

`bun install` at the repo root pulls `@haelp/teto` for the engine bridge;
`activity/` has its own dependencies and its own `bun install`.

Python needs `discord.py`, `python-dotenv`, `aiohttp` and `matplotlib`. The
engine bridge itself uses only the standard library.

---

## Environment

Everything is documented inline in `example.env`. Copy it to `.env` at the repo
root and fill in what you need:

- `DISCORD_TOKEN` — the bot. Required.
- `PUZZLE_APP_ID`, `PUZZLE_API`, `PUZZLE_API_KEY` — the `/puzzle` commands.
  `PUZZLE_API_KEY` must match `BOT_API_KEY` in `activity/.env`.
- `GEMINI_API_KEY` and the `GEMINI_*` limits — only for
  `internship_poller.py --llm`.

`.env` is gitignored and must stay that way.

---

## Licence

See [LICENSE](LICENSE).
