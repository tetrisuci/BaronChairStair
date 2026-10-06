"""
changelog.py
~~~~~~~~~~~~
What the bot is, what version it is, and recent player-facing changes.

Split from the commands for the same reason `report_text.py` is: it is data and
string building with no Discord in it, so it can be tested with bare `python3`
on a box that has none of the bot's dependencies installed.

`/puzzle changelog` reads the newest individual changes on demand. Formatting is
stateless: viewing the notes never records a guild as having seen a version.
The older announcement and database helpers remain for compatibility, but the
puzzle command no longer uses them or posts notes automatically.

The notes themselves are **not** in this file. They live in `changelog.json` at
the repository root. That was so the activity could show them too; that card was
removed, and the file stayed where it is — one list, in one place, and nothing
to keep in step with a second copy.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Release:
    """One version, and what a player would notice about it."""

    version: str
    #: Short, player-facing lines. Not commit subjects — what changed for them.
    changes: tuple[str, ...]


#: Where the notes live. Beside this file's *project*, not beside this file:
#: `client/` is half of a repository the activity shares.
CHANGELOG_PATH = Path(__file__).resolve().parent.parent / "changelog.json"


def load_releases(path: Path = CHANGELOG_PATH) -> tuple[Release, ...]:
    """
    Reads the notes off disk, newest first.

    Order in the file *is* the version order, deliberately: comparing
    "beta 0.10" against "beta 0.9" as text is wrong and as numbers is a parser
    nobody needs. Adding a release means putting it at the top of the file.

    Keep `changes` to things a player can see. "Refactored the planner" is not a
    change to announce; "the drag lands where the preview showed" is.

    **Never raises.** A missing or malformed file means no announcements, said
    on stderr, and the bot starts anyway. `discord_bot.py` imports this module
    at top level and not inside a `try`, so raising here would take the whole
    bot down over a changelog — which is the one feature in the repository that
    breaks nothing when it is absent.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        entries = raw["releases"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"changelog: cannot read {path} ({exc}); announcements are off",
              file=sys.stderr)
        return ()

    releases: list[Release] = []
    for entry in entries:
        try:
            version = str(entry["version"])
            changes = tuple(str(line) for line in entry["changes"])
        except (KeyError, TypeError) as exc:
            print(f"changelog: skipping a malformed release in {path} ({exc})",
                  file=sys.stderr)
            continue
        releases.append(Release(version=version, changes=changes))
    return tuple(releases)


#: Newest first. Read once, at import, like the rest of this module's data.
RELEASES: tuple[Release, ...] = load_releases()

#: What this build is. Read by the puzzle command and legacy announcement API.
#:
#: `"unknown"` only when the notes could not be read at all, which
#: `load_releases` has already said on stderr. Nothing announces under that name
#: — `announcement_for` refuses before it claims — so it never reaches a channel
#: and never lands in `bot_versions` to be compared against later.
VERSION: str = RELEASES[0].version if RELEASES else "unknown"

#: Default and upper bound for individual changes requested on demand.
DEFAULT_RECENT_CHANGES = 5
MAX_RECENT_CHANGES = 20

#: How many releases a legacy announcement will spell out in full.
#:
#: A server that has never heard from the bot has "not been told" about every
#: version there has ever been, and reading the project's whole history is not
#: what somebody typing `/puzzle` asked for. Past this, the message says how
#: many older ones it is not listing.
MAX_RELEASES_IN_MESSAGE = 3

#: The ceiling a Discord message actually has, less room to be wrong about it.
#:
#: Counting releases is not counting characters. Three releases of eight wordy
#: notes measured 2,029 characters, which Discord rejects with a 400 — and since
#: the claim is taken before the send, a rejected message is one a server never
#: hears, not one it hears late. So the message is trimmed by length as well as
#: by release count, and says what it dropped.
MAX_MESSAGE_CHARS = 1900


def format_recent_changes(
    count: int = DEFAULT_RECENT_CHANGES, *, truncate: bool = True
) -> str:
    """Return up to `count` newest changes, grouped by version.

    Changes follow release order and then their order within each release;
    `count` counts individual bullets rather than whole releases. No guild state
    is read or written. When the requested notes exceed the message budget,
    omit whole older bullets first and say how many were omitted. An oversized
    first bullet is shortened with an explicit truncation notice. `truncate=False`
    returns the complete requested notes for an attachment rather than a message.
    """
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_RECENT_CHANGES:
        raise ValueError(f"count must be an integer between 1 and {MAX_RECENT_CHANGES}")

    selected = [
        (release.version, change)
        for release in RELEASES
        for change in release.changes
    ][:count]
    if not selected:
        return "No changes are available in the puzzle bot changelog yet."

    opening = (
        f"**Puzzle bot changelog — {len(selected)} most recent "
        f"{'change' if len(selected) == 1 else 'changes'}**"
    )
    if not truncate:
        return _render_recent(opening, selected, "", limit_versions=False)
    for shown in range(len(selected), 0, -1):
        omitted = len(selected) - shown
        notice = (
            f"_{omitted} requested {'change' if omitted == 1 else 'changes'} "
            "omitted to fit one message._"
        ) if omitted else ""
        text = _render_recent(opening, selected[:shown], notice)
        if _discord_chars(text) <= MAX_MESSAGE_CHARS:
            return text

    # Even one bullet is oversized. Preserve the heading and notice, shortening
    # only the bullet text so Markdown headings cannot be cut open mid-message.
    omitted = len(selected) - 1
    notice = "_This change was truncated to fit one message"
    if omitted:
        notice += (
            f"; {omitted} more requested {'change' if omitted == 1 else 'changes'} omitted"
        )
    notice += "._"
    version, change = selected[0]
    fixed = _render_recent(opening, [(version, "")], notice)
    available = MAX_MESSAGE_CHARS - _discord_chars(fixed) - 1
    prefix = []
    used = 0
    for char in change:
        width = 2 if ord(char) > 0xFFFF else 1
        if used + width > available:
            break
        prefix.append(char)
        used += width
    shortened = "".join(prefix).rstrip() + "…"
    return _render_recent(opening, [(version, shortened)], notice)


def _render_recent(
    opening: str, changes: list[tuple[str, str]], notice: str, *, limit_versions: bool = True
) -> str:
    """Group consecutive notes under their version and append any limit notice."""
    lines = [opening]
    previous_version = None
    for version, change in changes:
        if version != previous_version:
            # Release versions are short labels. Bound even a hand-edited label
            # so there is always room for an oversized-note truncation notice.
            label = version if not limit_versions or len(version) <= 100 else version[:99] + "…"
            lines.extend(("", f"__{label}__"))
            previous_version = version
        lines.append(f"• {change}")
    if notice:
        lines.extend(("", notice))
    return "\n".join(lines)


def _discord_chars(text: str) -> int:
    """Count UTF-16 units, keeping replies safe even with emoji in a note."""
    return sum(2 if ord(char) > 0xFFFF else 1 for char in text)


# ── Legacy announcement API ─────────────────────────────────────────────────
# Kept for old callers and database compatibility; `/puzzle` does not use it.


def releases_since(seen: str | None) -> tuple[Release, ...]:
    """
    Every release newer than `seen`, newest first.

    `None` — a server that has never been told anything — means all of them, and
    so does a version this build has never heard of. That second case is a
    downgrade or a hand-edited row, and announcing too much is the safe way to
    be wrong: the alternative is a server that silently never hears again.
    """
    if seen is None:
        return RELEASES
    for index, release in enumerate(RELEASES):
        if release.version == seen:
            return RELEASES[:index]
    return RELEASES


def is_current(seen: str | None) -> bool:
    """Whether a server has already been told about this build."""
    return seen == VERSION


def format_announcement(releases: tuple[Release, ...]) -> str:
    """
    Legacy announcement text, or `""` when there is nothing to say.

    Preserves the historical plain-text format for old callers. The puzzle
    command now uses `format_recent_changes` only when notes are requested.
    """
    if not releases:
        return ""

    # Longest first, then shorter, until one fits. Trimming a rendered string
    # would cut mid-sentence or mid-release; dropping whole releases and
    # re-rendering keeps every message a well-formed one that says what it left
    # out. At worst this is one release, which is why the last line is a plain
    # truncation rather than another retry.
    for count in range(min(MAX_RELEASES_IN_MESSAGE, len(releases)), 0, -1):
        text = _render(releases, count)
        if len(text) <= MAX_MESSAGE_CHARS:
            return text
    return _render(releases, 1)[: MAX_MESSAGE_CHARS - 1].rstrip() + "…"


def _render(releases: tuple[Release, ...], count: int) -> str:
    """The message with `count` releases spelled out and the rest counted."""
    shown = releases[:count]
    hidden = len(releases) - len(shown)

    if len(releases) == 1:
        opening = f"**Puzzle bot {shown[0].version}**"
    else:
        opening = (
            f"**Puzzle bot {releases[0].version}** — "
            f"{len(releases)} updates since this server last heard"
        )

    lines = [opening, ""]
    for release in shown:
        # The version headed only when there is more than one, so the ordinary
        # single-release case reads as a list of changes rather than a form.
        if len(shown) > 1:
            lines.append(f"__{release.version}__")
        lines.extend(f"• {change}" for change in release.changes)
        lines.append("")
    if hidden > 0:
        lines.append(f"_…and {hidden} earlier {'update' if hidden == 1 else 'updates'}._")

    return "\n".join(lines).strip()


# ── What each server has already been told ───────────────────────────────────
#
# Legacy state, retained rather than deleting existing guild records. In the
# former automatic announcement flow, different servers heard about releases
# at different times, so tracking belonged to the guild rather than the process.
# On-demand viewing does not consult or update any of these records.


def init_db(db: sqlite3.Connection) -> None:
    """Creates the table. Called once at boot, like `puzzle_recap.init_db`."""
    db.execute("""
        CREATE TABLE IF NOT EXISTS bot_versions (
            guild_id     INTEGER PRIMARY KEY,
            version      TEXT    NOT NULL,
            announced_at REAL    NOT NULL
        )
    """)
    db.commit()


def seen_version(db: sqlite3.Connection, guild_id: int) -> str | None:
    """The last version this server was told about, or None if never."""
    row = db.execute(
        "SELECT version FROM bot_versions WHERE guild_id = ?", (guild_id,)).fetchone()
    return None if row is None else str(row[0])


def claim_announcement(
    db: sqlite3.Connection, guild_id: int, version: str = VERSION
) -> tuple[bool, str | None]:
    """
    Takes the right to announce `version` to one server, once.

    Returns ``(claimed, previously_seen)``. `claimed` is false when this server
    has already been told — including when a concurrent announcement caller won
    the race a moment ago.

    Claimed *before* the send and not after, for the reason `puzzle_recap.claim`
    gives: the write is what excludes the second caller, so it has to happen
    where two callers can still both be running.

    The cost is real and worth stating plainly, because it is easy to write down
    as smaller than it is: a send that fails after the claim loses those notes
    **permanently**. `releases_since` reads from the recorded version, so the
    next release names only what came after it — the lost one is not carried
    forward. That is still the right way round for a changelog nobody depends
    on, but it is a trade rather than a mitigation, and a future version of this
    that people *do* depend on wants the claim after the send plus a dedupe.

    The `WHERE` is the whole exclusion. Two calls read the same `previously_seen`
    and both try the write; exactly one changes a row.
    """
    previously = seen_version(db, guild_id)
    if previously == version:
        return False, previously
    cursor = db.execute(
        "INSERT INTO bot_versions (guild_id, version, announced_at) VALUES (?, ?, ?) "
        "ON CONFLICT(guild_id) DO UPDATE SET version = excluded.version, "
        "announced_at = excluded.announced_at "
        "WHERE bot_versions.version IS NOT excluded.version",
        (guild_id, version, time.time()))
    db.commit()
    return cursor.rowcount == 1, previously


def announcement_for(
    db: sqlite3.Connection, guild_id: int, version: str = VERSION
) -> str:
    """
    Legacy message this server should see, or `""` if it should see nothing.

    Claims as it goes, so calling it twice announces once. This is deliberately
    separate from stateless, on-demand viewing and is not used by `/puzzle`.

    With no notes on disk there is nothing to announce and, more to the point,
    nothing that may be *claimed*: recording `"unknown"` against a server would
    make the next real release look like an upgrade from a version that never
    existed. Returning early leaves the row exactly as it was.
    """
    if not RELEASES:
        return ""
    claimed, previously = claim_announcement(db, guild_id, version)
    if not claimed:
        return ""
    return format_announcement(releases_since(previously))
