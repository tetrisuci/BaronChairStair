"""
presence_tracker.py
~~~~~~~~~~~~~~~~~~~
Tracks how many guild members are online over time and renders the history
as a PNG line chart.

Two halves, deliberately kept apart from the bot so both are testable without
a Discord connection:

    record_sample(db, guild_id, counts, ts)   persist one presence sample
    fetch_series(db, guild_id, days)          read samples back as a series
    render_graph(series, ...)                 series -> PNG bytes (blocking)

A "sample" is a single count of members per presence status, taken on a fixed
interval by the bot's background loop. Samples are bucketed to SAMPLE_MINUTES
so an unlucky restart can't write two rows for the same slot -- the primary
key is (guild_id, bucket_ts), so a re-sample overwrites rather than
double-counts.

Rendering needs matplotlib and is CPU-bound; render_graph is synchronous by
design and must be called from a thread executor so the event loop stays free.
"""

from __future__ import annotations

import io
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import matplotlib

# Must be selected before pyplot is imported: the bot is headless and any
# GUI backend would fail outright (or, on macOS, demand the main thread).
matplotlib.use("Agg")

import matplotlib.dates as mdates          # noqa: E402  (after backend select)
import matplotlib.pyplot as plt            # noqa: E402
from matplotlib.ticker import MaxNLocator  # noqa: E402


# ── Config ────────────────────────────────────────────────────────────────────

SAMPLE_MINUTES = 10       # how often the bot records a presence sample
RETENTION_DAYS = 90       # samples older than this are pruned on write
GRAPH_DAYS_DEFAULT = 7    # default look-back for the graph command
GRAPH_DAYS_MAX = 90       # capped at retention -- older data does not exist
MIN_GRAPH_SAMPLES = 2     # a line needs two points; one renders blank
SECONDS_PER_DAY = 86400

# Tolerance for a sample timestamp landing ahead of our clock. Samples are
# stamped from the local clock, so anything meaningfully in the future means
# a bad clock or a corrupt row -- never a real reading. Kept at one interval
# so ordinary NTP drift and bucket rounding stay acceptable.
FUTURE_TOLERANCE = SAMPLE_MINUTES * 60

# Graphs are labelled in Pacific time. The zone (not a fixed -8 offset) is
# what handles PST/PDT, so clock readings stay correct year-round; the axis
# legend prints whichever abbreviation is actually in effect for the window.
DISPLAY_TZ = ZoneInfo("America/Los_Angeles")

# Statuses recorded per sample. "offline" is stored too so the series carries
# the guild's total size for free (sum of all four), which makes a later
# "percent online" view possible without a schema change.
STATUSES = ("online", "idle", "dnd", "offline")

# Plot styling. Colors match Discord's own status dots so the chart reads
# without a legend lookup.
STATUS_COLOR = {"online": "#23a55a", "idle": "#f0b232", "dnd": "#f23f43"}
STATUS_LABEL = {"online": "Online", "idle": "Idle", "dnd": "Do not disturb"}
FIG_SIZE = (10, 4.5)
FIG_DPI = 110
BG_COLOR = "#313338"      # Discord dark-theme surface, so the PNG blends in
FG_COLOR = "#dbdee1"
GRID_COLOR = "#3f4147"


@dataclass(frozen=True)
class Sample:
    """One presence reading: a UTC epoch timestamp and a count per status."""
    ts: float
    online: int
    idle: int
    dnd: int
    offline: int

    @property
    def active(self) -> int:
        """Members not offline -- online + idle + dnd."""
        return self.online + self.idle + self.dnd


# ── Storage ───────────────────────────────────────────────────────────────────

def init_db(db: sqlite3.Connection) -> None:
    """Create the presence table. Safe to call on every boot."""
    db.execute("""
        CREATE TABLE IF NOT EXISTS presence_samples (
            guild_id INTEGER NOT NULL,
            ts       INTEGER NOT NULL,
            online   INTEGER NOT NULL,
            idle     INTEGER NOT NULL,
            dnd      INTEGER NOT NULL,
            offline  INTEGER NOT NULL,
            PRIMARY KEY (guild_id, ts)
        )
    """)
    # The only read pattern is "one guild, recent window, in time order".
    db.execute("""
        CREATE INDEX IF NOT EXISTS presence_guild_ts
        ON presence_samples (guild_id, ts)
    """)
    db.commit()


def bucket(ts: float, minutes: int = SAMPLE_MINUTES) -> int:
    """Floor a timestamp to the sampling interval, so slots are stable."""
    step = minutes * 60
    return int(ts // step * step)


def record_sample(
    db: sqlite3.Connection,
    guild_id: int,
    counts: dict[str, int],
    ts: float | None = None,
) -> int:
    """
    Persist one presence sample and prune anything past RETENTION_DAYS.

    Args:
        db:       Open sqlite connection (the bot's stats.db).
        guild_id: Guild the counts belong to.
        counts:   Mapping of status name -> member count. Missing keys are 0.
        ts:       Sample time as a UTC epoch; defaults to now.

    Returns:
        The bucket timestamp the sample was written to.

    Raises:
        ValueError: If `ts` is implausible -- more than FUTURE_TOLERANCE ahead
                    of now, or older than the retention window. Such a value
                    can only come from a bad clock or a corrupt caller, and
                    storing it used to be catastrophic: the retention sweep
                    below derives its cutoff from this sample, so a single
                    future-dated row would delete the entire real history.
    """
    now = time.time()
    slot = bucket(now if ts is None else ts)
    if slot > now + FUTURE_TOLERANCE:
        raise ValueError(
            f"refusing future-dated sample: {slot} is "
            f"{(slot - now) / SECONDS_PER_DAY:.1f} days ahead of now")
    if slot < now - RETENTION_DAYS * SECONDS_PER_DAY:
        raise ValueError(
            f"refusing stale sample: {slot} is older than the "
            f"{RETENTION_DAYS}-day retention window")
    db.execute(
        "INSERT OR REPLACE INTO presence_samples "
        "(guild_id, ts, online, idle, dnd, offline) VALUES (?, ?, ?, ?, ?, ?)",
        (guild_id, slot, *(int(counts.get(s, 0)) for s in STATUSES)),
    )
    # Cutoff comes from `now`, never from `slot`: deriving it from the sample
    # being written made the delete only as trustworthy as that timestamp, so
    # one future-dated row would wipe the guild's entire real history. Scoped
    # per guild so one guild's data can never prune another's.
    db.execute("DELETE FROM presence_samples WHERE guild_id = ? AND ts < ?",
               (guild_id, bucket(now) - RETENTION_DAYS * SECONDS_PER_DAY))
    db.commit()
    return slot


def fetch_series(
    db: sqlite3.Connection,
    guild_id: int,
    days: int = GRAPH_DAYS_DEFAULT,
) -> list[Sample]:
    """Return samples for one guild over the last `days`, oldest first."""
    # Bucket the cutoff too: stored timestamps are floored to the sample
    # interval, so a raw wall-clock cutoff would drop the oldest bucket and
    # make repeated calls disagree on the sample count.
    now = time.time()
    cutoff = bucket(now - days * SECONDS_PER_DAY)
    # Bounded at BOTH ends. The write path now rejects implausible timestamps,
    # but a lower bound alone would let any future-dated row (a clock skew, a
    # hand-edited table) match every window forever and stretch the graph
    # across years, so the read stays defensive rather than trusting the table.
    horizon = bucket(now) + FUTURE_TOLERANCE
    rows = db.execute(
        "SELECT ts, online, idle, dnd, offline FROM presence_samples "
        "WHERE guild_id = ? AND ts >= ? AND ts <= ? ORDER BY ts",
        (guild_id, cutoff, horizon),
    ).fetchall()
    return [Sample(*row) for row in rows]


def summarize(series: list[Sample]) -> dict[str, float]:
    """Peak / average / latest active counts, for the message accompanying
    the graph. Returns zeros for an empty series rather than raising."""
    if not series:
        return {"peak": 0, "average": 0.0, "current": 0, "samples": 0}
    active = [s.active for s in series]
    return {
        "peak": max(active),
        "average": sum(active) / len(active),
        "current": active[-1],
        "samples": len(series),
    }


# ── Rendering ─────────────────────────────────────────────────────────────────

def render_graph(
    series: list[Sample],
    days: int = GRAPH_DAYS_DEFAULT,
    guild_name: str = "",
    breakdown: bool = False,
) -> bytes:
    """
    Render the series as a PNG line chart and return the raw bytes.

    Blocking and CPU-bound -- call via loop.run_in_executor.

    Args:
        series:     Samples, oldest first (as returned by fetch_series).
        days:       Window length, used for the title and x-axis formatting.
        guild_name: Shown in the title when provided.
        breakdown:  Plot online/idle/dnd as separate lines instead of one
                    combined "active" line.

    Raises:
        ValueError: If `series` is empty -- callers should special-case the
                    "no data yet" path with a text reply instead of an image.
    """
    if not series:
        raise ValueError("cannot render a graph from an empty series")

    # Plotted in Pacific time so the x-axis reads in the viewer's local hours;
    # stored timestamps stay UTC epochs and are untouched.
    times = [mdates.date2num(_local_datetime(s.ts)) for s in series]

    fig, ax = plt.subplots(figsize=FIG_SIZE, dpi=FIG_DPI)
    fig.patch.set_facecolor(BG_COLOR)
    ax.set_facecolor(BG_COLOR)

    if breakdown:
        for status in ("online", "idle", "dnd"):
            ax.plot(times, [getattr(s, status) for s in series],
                    color=STATUS_COLOR[status], linewidth=1.6,
                    label=STATUS_LABEL[status])
        legend = ax.legend(loc="upper left", frameon=False)
        for text in legend.get_texts():
            text.set_color(FG_COLOR)
    else:
        active = [s.active for s in series]
        ax.plot(times, active, color=STATUS_COLOR["online"], linewidth=1.8)
        ax.fill_between(times, active, color=STATUS_COLOR["online"], alpha=0.18)

    _style_axes(ax, days, tz_label(series))
    title = f"Online users — last {days} day{'s' if days != 1 else ''}"
    ax.set_title(f"{title}\n{guild_name}" if guild_name else title,
                 color=FG_COLOR, fontsize=13, pad=12)

    buf = io.BytesIO()
    fig.tight_layout()
    # Always close the figure, even if savefig throws: pyplot keeps a global
    # reference to every open figure, so a leak here grows without bound in a
    # long-running bot.
    try:
        fig.savefig(buf, format="png", facecolor=BG_COLOR)
    finally:
        plt.close(fig)
    return buf.getvalue()


def _utc_datetime(ts: float) -> datetime:
    """Epoch seconds -> aware UTC datetime."""
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def _local_datetime(ts: float) -> datetime:
    """Epoch seconds -> aware datetime in DISPLAY_TZ (Pacific)."""
    return datetime.fromtimestamp(ts, tz=DISPLAY_TZ)


def tz_label(series: list[Sample]) -> str:
    """Abbreviation actually in effect over the series -- "PST", "PDT", or
    "PST/PDT" when the window straddles a daylight-saving transition, so a
    winter graph is never mislabelled as summer time."""
    if not series:
        return _local_datetime(time.time()).strftime("%Z")
    first = _local_datetime(series[0].ts).strftime("%Z")
    last = _local_datetime(series[-1].ts).strftime("%Z")
    return first if first == last else f"{first}/{last}"


def _style_axes(ax, days: int, tz_name: str = "") -> None:
    """Apply the dark theme and pick date ticks that suit the window."""
    ax.set_ylabel("Members", color=FG_COLOR, fontsize=10)
    ax.tick_params(colors=FG_COLOR, labelsize=9)
    ax.grid(True, color=GRID_COLOR, linewidth=0.6, alpha=0.8)
    ax.set_axisbelow(True)
    for spine in ax.spines.values():
        spine.set_color(GRID_COLOR)

    # Member counts are whole people; never label the axis 12.5.
    ax.yaxis.set_major_locator(MaxNLocator(integer=True, nbins=6))
    ax.set_ylim(bottom=0)

    # Tick density is driven by AutoDateLocator, which picks its own interval
    # from the axis range and therefore cannot exceed the tick ceiling. This
    # used to be a fixed HourLocator sized from `days`, which assumed the axis
    # actually spanned the requested window. It does not when the series has a
    # single distinct timestamp: matplotlib then pads the axis to ~2275 days,
    # and ticking that every 3 hours emitted ~18k ticks, flooding the logs with
    # MAXTICKS warnings on every render. Only the *label format* keys off
    # `days` now -- spacing always follows the real axis range.
    _widen_degenerate_axis(ax, days)
    span_days = _span_days(ax)
    # Date and time both, stacked on two lines: "Aug 12\n14:00". A single-line
    # "Aug 12 14:00" is ~12 characters and neighbouring labels collide at the
    # tick counts the locator picks, so the newline buys the time-of-day for
    # free. Past 90 days ticks land on month boundaries and a clock reading is
    # noise, so that band stays date-only.
    if span_days <= 90:
        # %-I is the no-zero-pad hour ("2 PM", not "02 PM"); it is a glibc/BSD
        # extension but macOS and Linux both honour it, which covers dev and
        # the deployment box.
        fmt = "%b %d\n%-I:%M %p"
    else:
        fmt = "%b %Y"        # anything longer is unexpected, but stays legible
    ax.xaxis.set_major_locator(mdates.AutoDateLocator(maxticks=8, tz=DISPLAY_TZ))
    ax.xaxis.set_major_formatter(mdates.DateFormatter(fmt, tz=DISPLAY_TZ))
    if tz_name:
        # Say which clock these hours are on -- an unlabelled time axis is
        # ambiguous to anyone not in the bot's timezone.
        ax.set_xlabel(f"Time of day ({tz_name})", color=FG_COLOR, fontsize=10)
    for label in ax.get_xticklabels():
        label.set_rotation(0)


def _span_days(ax) -> float:
    """Width of the x-axis in days, as currently limited by the plotted data."""
    lo, hi = ax.get_xlim()
    return abs(hi - lo)


def _widen_degenerate_axis(ax, days: int) -> None:
    """Give a single-point (or all-same-timestamp) series a sane x range.

    With one distinct x value matplotlib cannot infer a scale, so it pads the
    axis to a default +/-1137 days -- a 2275-day span centred on the sample.
    That is what produced the ~18k-tick MAXTICKS floods: the axis was synthetic
    padding, not real data. AutoDateLocator no longer chokes on it, but the
    chart would still be unreadable, so clamp the range to the requested window
    ending at the sample.
    """
    lo, hi = ax.get_xlim()
    if abs(hi - lo) <= days * 1.5:
        return                      # a normal, data-driven range -- leave it
    centre = (lo + hi) / 2
    ax.set_xlim(centre - days, centre)
