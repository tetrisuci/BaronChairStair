"""
Yesterday's results, posted as a reply to yesterday's ``/puzzle``.

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

# The day's three, in the order they are always shown.
TIER_ORDER = ("easy", "medium", "hard")

# One mark per tier, in that order. Three states, not two: a puzzle somebody
# filed and failed is a different day from one they never opened, and the grid
# is the only place that difference is visible.
MARK_SOLVED = "\N{LARGE GREEN SQUARE}"
MARK_MISSED = "\N{LARGE RED SQUARE}"
MARK_ABSENT = "\N{BLACK LARGE SQUARE}"
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

    ``OR IGNORE`` rather than ``OR REPLACE``: running ``/puzzle`` again
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


def _rows(payload_daily: dict) -> list[dict]:
    """
    The day's board, already merged by the server.

    This used to be a second implementation of the merge, keyed on the player
    id and sorted the same way — and it had the same defect as its TypeScript
    twin: each tier arrived under its own limit, so a player near the bottom of
    one and the top of another lost a mark. The grouping is one SQL query now
    and both renderers only format.
    """
    return list(payload_daily.get("rows") or [])


def _grid(marks: dict) -> str:
    """The three marks, always three and always in the same order."""
    return "".join(
        MARK_SOLVED if marks.get(tier) else MARK_MISSED if tier in marks else MARK_ABSENT
        for tier in TIER_ORDER
    )


def _daily_lines(rows: list[dict]) -> list[str]:
    """
    Everybody once, best first, with their three marks beside them.

    No grouping by score, unlike the Wordle bot it borrows from: a time is
    continuous, so no two players ever share a bucket and grouping would put
    one name on every line anyway.
    """
    if not rows:
        return []

    # No crown on the leader. It was written before the grid was, and a prefix
    # on one line only is what knocks that line out of alignment: the winner's
    # three marks started an emoji-width right of everybody else's, so the one
    # column the recap has ran crooked down the whole message. The board is the
    # thing being read here, and order already says who won.
    lines = []
    for row in rows[:RANKED_SHOWN]:
        tail = (
            f" — {format_duration(row.get('totalMs', 0))}"
            if row.get("solved", 0) > 0
            else ""
        )
        lines.append(f"{_grid(row.get('marks') or {})} {_mention(row)}{tail}")

    rest = rows[RANKED_SHOWN:]
    if rest:
        lines.append(f"also played — {_names(rest)}")

    swept = [row for row in rows if row.get("solved", 0) == len(TIER_ORDER)]
    if swept:
        lines.append(f"All three: {_names(swept)}")
    return lines


def _rush_lines(rush: dict) -> list[str]:
    """The rush board, when anybody ran one. `solved` there is a count."""
    ran = [entry for entry in (rush.get("entries") or []) if entry.get("solved")]
    if not ran:
        return []
    lines = ["", "**Rush**"]
    for entry in ran[:RUSH_SHOWN]:
        count = entry.get("solved", 0)
        plural = "" if count == 1 else "s"
        # Unprefixed, like the daily board above and for the same reason: these
        # are already in order, and the crown only pushed the first name out of
        # line with the ones under it.
        lines.append(f"{_mention(entry)} — {count} puzzle{plural}")
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
    rows = _rows(daily)
    if not rows:
        return ""

    lines = [_headline(
        payload.get("day", 0),
        payload.get("streak", 0),
        any(row.get("solved", 0) > 0 for row in rows),
    )]
    lines += _daily_lines(rows)

    # The board is capped server-side and misses sort last, so a very busy
    # server would lose exactly the people this message exists to tease.
    hidden = (daily.get("total") or len(rows)) - len(rows)
    if hidden > 0:
        lines.append(f"…and {hidden} more who played.")

    lines += _rush_lines(payload.get("rush") or {})
    return _fit(lines)
