"""
Yesterday's results, posted as a reply to yesterday's ``/puzzle play``.

The shape is borrowed from the Wordle bot: when the day turns over, whoever
announced the puzzle gets a reply naming everybody who played, fastest first,
with the people who missed grouped at the end.

Two things make it exactly once per server per day, and neither is a timer.

The activity owns the calendar. Nothing here computes a date, a timezone or a
midnight — the bot asks the activity what day it is and subtracts one. That is
why a restart at 23:59, a host in a different timezone, and a daylight-saving
change are all non-events.

The primary key is the mutual exclusion. ``(guild_id, day)`` plus a guarded
``UPDATE ... WHERE recapped_at IS NULL`` makes the claim a database invariant
rather than something a loop has to remember, so two ticks racing each other
cannot both win. The claim is taken *before* the message is sent, which is the
deliberate trade: a send that fails costs that server that day, because the
alternative is a retry that eventually double-posts.
"""

import sqlite3
import time
from dataclasses import dataclass

import discord

# Solvers named with their time. Past this they keep their ping but lose the
# clock — a wall of times is not a leaderboard anybody reads.
RANKED_SHOWN = 10
# Names on one grouped line, before it becomes a grey slab.
GROUP_CAP = 20
# Discord's own hard limit on message content.
MAX_MESSAGE = 2000
# A run of one is not a streak worth announcing.
MIN_STREAK = 2
# Rush placings named. The rush board is a footnote to the daily here.
RUSH_SHOWN = 3
# Long enough to work out why a recap never arrived, and no longer.
RETAIN_DAYS = 30


@dataclass(frozen=True)
class Play:
    """Where a server announced a day, so the recap knows what to reply to."""

    guild_id: int
    day: int
    channel_id: int
    message_id: int


# ── Storage ──────────────────────────────────────────────────────────────────

def init_db(db: sqlite3.Connection) -> None:
    """Creates the table. Called once at boot, like presence_tracker's."""
    db.execute("""
        CREATE TABLE IF NOT EXISTS puzzle_plays (
            guild_id    INTEGER NOT NULL,
            day         INTEGER NOT NULL,
            channel_id  INTEGER NOT NULL,
            message_id  INTEGER NOT NULL,
            created_at  REAL    NOT NULL,
            recapped_at REAL,
            PRIMARY KEY (guild_id, day)
        )
    """)
    db.commit()


def record_play(db: sqlite3.Connection, guild_id: int, day: int,
                channel_id: int, message_id: int) -> None:
    """
    Remembers where a day was announced. The first announcement wins.

    ``OR IGNORE`` rather than ``OR REPLACE``: running ``/puzzle play`` again
    later in the day, or in a second channel, should not move tomorrow's reply
    away from the message everybody already saw.
    """
    db.execute(
        "INSERT OR IGNORE INTO puzzle_plays "
        "(guild_id, day, channel_id, message_id, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (guild_id, day, channel_id, message_id, time.time()))
    db.commit()


def pending(db: sqlite3.Connection, day: int) -> list[Play]:
    """Servers that announced `day` and have not been given its recap yet."""
    rows = db.execute(
        "SELECT guild_id, day, channel_id, message_id FROM puzzle_plays "
        "WHERE day = ? AND recapped_at IS NULL",
        (day,)).fetchall()
    return [Play(*row) for row in rows]


def claim(db: sqlite3.Connection, guild_id: int, day: int) -> bool:
    """
    Takes the right to post one server's recap, once.

    The ``WHERE`` clause is the entire exclusion: two ticks overlapping, or a
    second process sharing the file, both run this and only one of them sees a
    row change. Everything else about ordering follows from claiming here,
    before the send, rather than after it.
    """
    cursor = db.execute(
        "UPDATE puzzle_plays SET recapped_at = ? "
        "WHERE guild_id = ? AND day = ? AND recapped_at IS NULL",
        (time.time(), guild_id, day))
    db.commit()
    return cursor.rowcount == 1


def prune(db: sqlite3.Connection, before_day: int) -> int:
    """Drops rows too old to be worth keeping. Returns how many went."""
    cursor = db.execute("DELETE FROM puzzle_plays WHERE day < ?", (before_day,))
    db.commit()
    return cursor.rowcount


# ── Formatting ───────────────────────────────────────────────────────────────

def format_duration(ms: int) -> str:
    """mm:ss.d, growing an hours field rather than running the minutes up."""
    seconds = ms / 1000
    hours, rest = divmod(int(seconds // 60), 60)
    if hours:
        return f"{hours}:{rest:02d}:{seconds % 60:04.1f}"
    return f"{rest}:{seconds % 60:04.1f}"


def _mention(entry: dict) -> str:
    """
    A ping, built from the id and never from a name the activity supplied.

    Player ids here are Discord user ids, so this is a real mention. Anything
    that is not a snowflake — a guest row from a development server — falls
    back to the escaped name, because ``<@guest>`` renders as literal rubbish
    and a display name is attacker-controlled text.
    """
    player = entry.get("player") or {}
    try:
        return f"<@{int(player['id'])}>"
    except (KeyError, TypeError, ValueError):
        return discord.utils.escape_markdown(str(player.get("username", "someone")))


def _names(entries: list[dict]) -> str:
    """A run of mentions on one line, capped, saying so when it caps."""
    shown = [_mention(entry) for entry in entries[:GROUP_CAP]]
    hidden = len(entries) - len(shown)
    line = " ".join(shown)
    return f"{line} and {hidden} more" if hidden > 0 else line


def _headline(day: int, streak: int, anybody_solved: bool) -> str:
    head = f"**Puzzle #{day}** — yesterday's results."
    if not anybody_solved:
        return f"{head} Nobody solved it."
    if streak >= MIN_STREAK:
        return f"{head} This server is on a {streak} day streak."
    return head


def _daily_lines(entries: list[dict]) -> list[str]:
    """
    Solvers fastest first, then everybody who did not get there.

    No grouping by score, unlike the Wordle bot it borrows from: a time is
    continuous, so no two players ever share a bucket and grouping would put
    one name on every line anyway. The only line that genuinely groups is the
    last one, which is this game's version of Wordle's `X/6`.
    """
    solved = [entry for entry in entries if entry.get("solved")]
    missed = [entry for entry in entries if not entry.get("solved")]

    lines = [
        f"{'👑 ' if index == 0 else ''}{_mention(entry)} — "
        f"{format_duration(entry.get('totalMs', 0))}"
        for index, entry in enumerate(solved[:RANKED_SHOWN])
    ]
    if solved[RANKED_SHOWN:]:
        lines.append(f"also solved — {_names(solved[RANKED_SHOWN:])}")
    if missed:
        lines.append(f"missed — {_names(missed)}")
    elif len(entries) > 1:
        # "opened it", because the board holds no roster. Somebody who never
        # started the puzzle has no row and cannot be counted either way, so
        # this must never read as "everybody in the server".
        lines.append("Everyone who opened it solved it.")
    return lines


def _rush_lines(rush: dict) -> list[str]:
    """The rush board, when anybody ran one. `solved` there is a count."""
    ran = [entry for entry in (rush.get("entries") or []) if entry.get("solved")]
    if not ran:
        return []
    lines = ["", "**Rush**"]
    for index, entry in enumerate(ran[:RUSH_SHOWN]):
        count = entry.get("solved", 0)
        crown = "👑 " if index == 0 else ""
        plural = "" if count == 1 else "s"
        lines.append(f"{crown}{_mention(entry)} — {count} puzzle{plural}")
    return lines


def _fit(lines: list[str]) -> str:
    """
    Trims to Discord's limit by dropping whole lines from the end.

    Never by slicing: a cut in the middle of a mention leaves `<@1234` in the
    message, which renders as exactly that.
    """
    while len(lines) > 1 and len("\n".join(lines)) > MAX_MESSAGE:
        lines.pop()
    return "\n".join(lines)


def format_recap(payload: dict) -> str:
    """
    The whole message, or an empty string when there is nothing to say.

    An empty result is the normal case for a server that announced the puzzle
    and then nobody played it; the caller posts nothing rather than a message
    about no-one.
    """
    daily = payload.get("daily") or {}
    entries = list(daily.get("entries") or [])
    if not entries:
        return ""

    lines = [_headline(
        payload.get("day", 0),
        payload.get("streak", 0),
        any(entry.get("solved") for entry in entries),
    )]
    lines += _daily_lines(entries)

    # The board is capped server-side and misses sort last, so a very busy
    # server would lose exactly the people this message exists to tease.
    hidden = (daily.get("total") or len(entries)) - len(entries)
    if hidden > 0:
        lines.append(f"…and {hidden} more who played.")

    lines += _rush_lines(payload.get("rush") or {})
    return _fit(lines)
