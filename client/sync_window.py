"""
sync_window.py
~~~~~~~~~~~~~~
How often `/archive sync` may run: once every ten minutes, for everybody.

The command used to be behind a hand-kept list of officers. The owner opened
it to anybody, and this window is what replaced the list: one limit, global
across every server and every member, dry runs included. A sync reads the
whole sheet and holds a write transaction against the database the live
activity serves from, so the thing worth bounding is how often it runs at
all, not how often any one person runs it.

The window starts when a sync actually starts — when the process is
launched — and nothing else moves it. A request that is refused, or one that
fails before launching (no `bun`, no activity checkout), leaves it where it
was: charging somebody ten minutes for the box's own misconfiguration is not
a limit, it is a fault. `report_commands.py` gives a rate-limit slot back for
the same reason.

The start is kept in `stats.db`, so restarting the bot does not hand out a
fresh sync. Wall-clock UTC epoch seconds, because that is what a Discord
`<t:...>` timestamp takes, and every member reads it in their own timezone.

Stdlib only, and no Discord types in the signatures, so it can be tested on a
box with no discord.py installed — the same reason `report_text.py` holds the
report limiter rather than `report_commands.py`.
"""

import math
import sqlite3

#: Ten minutes. The command's own description says so; change both together.
COOLDOWN_S = 10 * 60


def init_db(db: sqlite3.Connection) -> None:
    """
    Creates the table. Called once at boot, like `changelog.init_db`.

    One row, pinned to `id = 1` by the CHECK: there is one global window, so
    there is one start to remember, not a log that grows with every sync.
    """
    db.execute("""
        CREATE TABLE IF NOT EXISTS archive_sync_window (
            id         INTEGER PRIMARY KEY CHECK (id = 1),
            started_at REAL    NOT NULL
        )
    """)
    db.commit()


def last_started(db: sqlite3.Connection) -> float | None:
    """When the last sync started, or None if this box has never run one."""
    row = db.execute("SELECT started_at FROM archive_sync_window WHERE id = 1").fetchone()
    return None if row is None else float(row[0])


def record_start(db: sqlite3.Connection, started_at: float) -> None:
    """Remembers that a sync started at `started_at`, replacing the last one."""
    db.execute(
        "INSERT OR REPLACE INTO archive_sync_window (id, started_at) VALUES (1, ?)",
        (started_at,),
    )
    db.commit()


def next_start(last: float) -> float:
    """The earliest moment the next sync may start."""
    return last + COOLDOWN_S


def _placed(last: float | None, now: float) -> float | None:
    """
    `last`, unless it is later than `now`, which no start can be.

    A start ahead of the clock means the clock moved: it ran ahead when the
    start was stored and has since been stepped back, or `stats.db` came from
    a box whose clock does. Trusted, it would shut the window for the clock's
    error on top of the ten minutes — hours, perhaps — and with no allowlist
    there is no officer left to override it, only a hand edit of the
    database. Clamping to `now` would not help either: it is re-read at every
    request, so the window would stay shut until the clock caught up anyway.

    So it is set aside. That opens the window at once, and the next sync to
    start writes a start this clock can place over it. The cost is at most one
    sync sooner than the limit, once, after the clock itself went backwards.
    """
    return None if last is None or last > now else last


def is_open(last: float | None, now: float) -> bool:
    """Whether a sync may start at `now`."""
    last = _placed(last, now)
    return last is None or now >= next_start(last)


def _when(moment: float, rounding) -> str:
    """
    A moment as Discord renders it: relative, then the clock time.

    `rounding` is `math.floor` for a start that has happened and `math.ceil`
    for one that has not. A next start rounded down would be shown up to a
    second before the window opens, and somebody who trusts it to the second
    is refused again.
    """
    seconds = rounding(moment)
    return f"<t:{seconds}:R> (<t:{seconds}:t>)"


#: The limit, in the words every message uses for it.
LIMIT = "`/archive sync` runs at most once every 10 minutes"


def next_line(started_at: float) -> str:
    """The line under a sync that started, saying when the next one may."""
    return f"The next sync can start {_when(next_start(started_at), math.ceil)}."


def refusal(last: float | None, running: bool, now: float) -> str:
    """
    What a refused member is told, privately.

    Names when the last sync started and when the next may, and nothing
    about who ran it: the reply is about the window, not a person.

    A sync that holds the lock but has not launched yet has no start of its
    own to name — `last` is then missing, belongs to an earlier sync whose
    window has passed, or lies in the future (`_placed`) — so that case says
    only how the window will run. Never a start in the future: Discord would
    render it as "in 2 hours".
    """
    last = _placed(last, now)
    if is_open(last, now):
        if running:
            return f"A sync is starting right now. {LIMIT}, so the next can start ten minutes after it does."
        return f"{LIMIT}."
    opens = _when(next_start(last), math.ceil)
    started = _when(last, math.floor)
    if running:
        return f"A sync is already running — it started {started}. {LIMIT}, so the next can start {opens}."
    return f"{LIMIT}. The last sync started {started}; the next can start {opens}."
