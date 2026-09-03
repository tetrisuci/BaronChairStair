"""
puzzle_commands.py
~~~~~~~~~~~~~~~~~~
The /puzzle slash commands: a thin wrapper around the daily-puzzle
Discord Activity that lives in activity/.

The bot deliberately owns none of the game. It knows two things: the URL that
launches the activity, and the read-only endpoints the activity server exposes
for exactly this purpose. The day's puzzle, the rotation, and the scores all
stay in one place — the activity — so the bot can never disagree with it.

Environment (see example.env):
    PUZZLE_APP_ID   Discord application id of the activity. Without it
                       the commands explain how to set it and do nothing else.
    PUZZLE_API      Base URL of the activity server, e.g.
                       https://puzzle.example.com
    PUZZLE_API_KEY  Shared secret matching the server's BOT_API_KEY.
                       Only needed for /puzzle standings and /puzzle rush.
"""

import logging
import os
import sqlite3
from collections.abc import Callable
from urllib.parse import urlparse

import aiohttp
import discord
from discord import app_commands

import puzzle_recap

log = logging.getLogger(__name__)

# Discord resolves this to "launch this activity here" when clicked from a
# guild channel; there is no other public URL form for an embedded app.
ACTIVITY_LAUNCH_URL = "https://discord.com/activities/{app_id}"

HTTP_TIMEOUT = aiohttp.ClientTimeout(total=8)

# The club's own yellow, so the embed matches tetrisatuci.org and the activity.
PUZZLE_COLOUR = discord.Colour.from_rgb(0xFC, 0xD7, 0x50)
MISSING_COLOUR = discord.Colour.from_rgb(0xC8, 0x40, 0x2F)

# The archive's difficulty is a loose vibe scale, so it is shown as a band.
GRADE_BANDS = (
    (2, "I · gentle"),
    (4, "II · steady"),
    (6, "III · firm"),
    (8, "IV · hard"),
    (10, "V · severe"),
)

STANDINGS_SHOWN = 10

# Both boards are per guild, and both can be handed a reply they cannot read,
# so the two sentences live in one place rather than drifting apart.
SERVER_ONLY = "Standings are per server, so this only works in a server."
UNEXPECTED_REPLY = "The puzzle server sent something unexpected. Try again later."

# Lent by discord_bot at boot so /puzzle play can note where it announced the
# day. Left as None when nothing wired it up: this module stays importable on
# its own, and a missing recap must never stop the commands working.
recap_db: "sqlite3.Connection | None" = None


def _app_id() -> str:
    return os.environ.get("PUZZLE_APP_ID", "").strip()


def _api_base() -> str:
    return os.environ.get("PUZZLE_API", "").rstrip("/")


def _grade(difficulty: float) -> str:
    if difficulty <= 0:
        return "ungraded"
    for ceiling, label in GRADE_BANDS:
        if difficulty <= ceiling:
            return label
    return "VI · brutal"


# One definition, shared with the recap that formats the same times.
_duration = puzzle_recap.format_duration


def _not_configured(missing: str) -> str:
    return (f"The daily puzzle isn't wired up yet — `{missing}` is unset. "
            "See activity/README.md for the two-minute version.")


class PuzzleServerUnavailable(Exception):
    """The activity server could not answer. Carries a message for the user."""


async def _get(path: str, *, api_key: str | None = None) -> dict:
    """
    GET a JSON endpoint on the activity server.

    Raises PuzzleServerUnavailable rather than returning None so that "not
    configured" and "server is down" stay distinguishable — the first is
    something the operator can fix, the second is something to wait out.
    """
    base = _api_base()
    if not base:
        raise PuzzleServerUnavailable(_not_configured("PUZZLE_API"))
    host = urlparse(base).hostname or ""
    if not base.startswith("https://") and host not in ("localhost", "127.0.0.1", "::1"):
        log.warning("PUZZLE_API is not https; the API key would go out in the clear")
        raise PuzzleServerUnavailable(
            "The puzzle server's API URL must be https (or localhost). Refusing to send the key.")

    headers = {"X-Api-Key": api_key} if api_key else {}
    try:
        async with aiohttp.ClientSession(timeout=HTTP_TIMEOUT) as session:
            async with session.get(base + path, headers=headers) as response:
                if response.status != 200:
                    log.warning("puzzle %s -> HTTP %s", path, response.status)
                    raise PuzzleServerUnavailable(
                        "Couldn't reach the puzzle server. Try again in a minute.")
                return await response.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError) as exc:
        log.warning("puzzle %s failed: %s", path, exc)
        raise PuzzleServerUnavailable(
            "Couldn't reach the puzzle server. Try again in a minute.") from exc


puzzle_group = app_commands.Group(
    name="puzzle",
    description="The daily Tetris puzzle")


@puzzle_group.command(
    name="play",
    description="Post today's puzzle sheet and a link to open it.")
async def puzzle_play(interaction: discord.Interaction):
    app_id = _app_id()
    if not app_id:
        await interaction.response.send_message(
            _not_configured("PUZZLE_APP_ID"), ephemeral=True)
        return

    await interaction.response.defer(thinking=True)
    launch = ACTIVITY_LAUNCH_URL.format(app_id=app_id)

    try:
        today = await _get("/api/today")
        puzzles = today["puzzles"]
        day = today["day"]
        solved = today["solvedCount"]
    except (PuzzleServerUnavailable, KeyError, TypeError) as exc:
        log.warning("puzzle /api/today unusable: %s", exc)
        await interaction.followup.send(
            f"**Daily puzzle** is up.\n{launch}\n"
            "_(puzzle details are unavailable right now)_")
        return
    embed = discord.Embed(
        title=f"Puzzle #{day}",
        description="Three today — solving any one of them keeps your streak.",
        colour=PUZZLE_COLOUR,
        url=launch)
    # One field per tier rather than three embeds: they are one day's puzzle,
    # and splitting them would read as three announcements to scroll past.
    for entry in puzzles:
        tier = str(entry.get("tier", "")).title() or "Puzzle"
        embed.add_field(
            name=f"{tier} · {_grade(entry.get('difficulty', 0))}",
            value=(f"{entry.get('goal') or 'Match the reference solution.'}\n"
                   f"{entry.get('pieces', '?')} pieces · "
                   f"{entry.get('targetAttack', '?')} attack\n"
                   f"_“{entry.get('title', 'untitled')}” "
                   f"by {entry.get('author', 'unknown')}_"),
            inline=False)
    # People, not results: the server counts players who solved anything today,
    # so this does not treble now that a day holds three puzzles.
    embed.add_field(name="Solved by", value=f"{solved} so far", inline=False)

    # `wait=True` so the send comes back with a message: without it discord.py
    # returns None and there is nothing for tomorrow's recap to reply to.
    message = await interaction.followup.send(
        f"Today's puzzle is up. {launch}", embed=embed, wait=True)
    _remember_play(interaction, day, message)


def _remember_play(interaction: discord.Interaction, day: int,
                   message: discord.Message | None) -> None:
    """
    Notes where a day was announced, for tomorrow's recap to reply to.

    Best effort on purpose. Failing to record costs one server one recap;
    raising here would cost the player the message they actually asked for.
    """
    if recap_db is None or interaction.guild_id is None or message is None:
        return
    try:
        puzzle_recap.record_play(recap_db, interaction.guild_id, day,
                                 message.channel.id, message.id)
    except sqlite3.Error:
        log.warning("could not record the play message for the recap", exc_info=True)


async def current_day() -> int | None:
    """Today's puzzle number, from the activity. None when it is unreachable."""
    try:
        return int((await _get("/api/today"))["day"])
    except (PuzzleServerUnavailable, KeyError, TypeError, ValueError):
        return None


async def recap_payload(guild_id: int, day: int) -> dict:
    """One server's finished day: the board, the streak, and the rush board."""
    api_key = os.environ.get("PUZZLE_API_KEY", "").strip()
    if not api_key:
        raise PuzzleServerUnavailable(_not_configured("PUZZLE_API_KEY"))
    return await _get(f"/api/recap?guild={guild_id}&day={day}", api_key=api_key)


def _standings_lines(entries: list[dict], detail: Callable[[dict], str]) -> list[str]:
    """
    One line per player, in the order the server sent them.

    What follows the name is the only thing a daily board and a rush board
    disagree about, so it arrives as `detail`. Raises KeyError/TypeError on an
    unexpected shape, whether from here or from inside `detail`.
    """
    lines = []
    for rank, entry in enumerate(entries[:STANDINGS_SHOWN], start=1):
        # Display names are player-chosen and embeds render masked links, so a
        # username like "[Free Nitro](https://…)" would become a live link.
        name = discord.utils.escape_markdown(entry["player"]["username"])
        lines.append(f"`{rank:>2}` **{name}** — {detail(entry)}")
    return lines


def _daily_detail(entry: dict) -> str:
    """Time on the puzzle, or how close an unsolved attempt came."""
    if not entry["solved"]:
        return f"unsolved · {entry['attack']}/{entry['targetAttack']}"
    detail = _duration(entry["totalMs"])
    if entry["resets"]:
        detail += f" · {entry['resets']} restart{'s' if entry['resets'] != 1 else ''}"
    return detail


def _rush_detail(entry: dict) -> str:
    """
    Solves lead, because that is what the rush ranks by; the time only tells
    two players on the same count apart. A run with nothing solved has no such
    time — the server sends zero — so it says what it did instead.
    """
    solved = entry["solved"]
    if not solved:
        return f"no solves · {entry['attempted']} attempted"
    detail = (f"{solved} solve{'s' if solved != 1 else ''}"
              f" · {_duration(entry['timeToLastSolveMs'])}")
    if entry["skipsUsed"]:
        detail += f" · {entry['skipsUsed']} skip{'s' if entry['skipsUsed'] != 1 else ''}"
    return detail


@puzzle_group.command(
    name="standings",
    description="Today's puzzle leaderboard for this server.")
async def puzzle_standings(interaction: discord.Interaction):
    api_key = os.environ.get("PUZZLE_API_KEY", "").strip()
    if not api_key:
        await interaction.response.send_message(
            _not_configured("PUZZLE_API_KEY"), ephemeral=True)
        return
    if interaction.guild_id is None:
        await interaction.response.send_message(SERVER_ONLY, ephemeral=True)
        return

    await interaction.response.defer(thinking=True)
    try:
        data = await _get(f"/api/standings?guild={interaction.guild_id}",
                          api_key=api_key)
        boards = data["boards"]
        day = data["day"]
    except PuzzleServerUnavailable as exc:
        await interaction.followup.send(str(exc))
        return
    except (KeyError, TypeError) as exc:
        log.warning("puzzle /api/standings unusable: %s", exc)
        await interaction.followup.send(UNEXPECTED_REPLY)
        return

    if not any(board.get("entries") for board in boards):
        await interaction.followup.send(f"Nobody has solved #{day} yet. Be first.")
        return

    # Built inside its own guard: the interaction is already deferred, so an
    # unexpected shape here would leave the user watching a spinner forever.
    try:
        embed = discord.Embed(title=f"Puzzle #{day} — leaderboards",
                              colour=PUZZLE_COLOUR)
        for board in boards:
            entries = board.get("entries") or []
            tier = str(board.get("tier", "")).title() or "Puzzle"
            # An empty tier is ordinary rather than an error — the hard one
            # often has nobody on it while the easy one is busy — so it says so
            # instead of being left out and looking like a missing board.
            embed.add_field(
                name=tier,
                value=("\n".join(_standings_lines(entries, _daily_detail))
                       if entries else "_nobody yet_"),
                inline=False)
            if len(entries) > STANDINGS_SHOWN:
                embed.add_field(
                    name="\u200b",
                    value=f"_and {len(entries) - STANDINGS_SHOWN} more on {tier.lower()}_",
                    inline=False)
    except (KeyError, TypeError) as exc:
        log.warning("puzzle standings entry unusable: %s", exc)
        await interaction.followup.send(UNEXPECTED_REPLY)
        return

    await interaction.followup.send(embed=embed)


@puzzle_group.command(
    name="rush",
    description="Today's five-minute puzzle rush board for this server.")
async def puzzle_rush(interaction: discord.Interaction):
    api_key = os.environ.get("PUZZLE_API_KEY", "").strip()
    if not api_key:
        await interaction.response.send_message(
            _not_configured("PUZZLE_API_KEY"), ephemeral=True)
        return
    if interaction.guild_id is None:
        await interaction.response.send_message(SERVER_ONLY, ephemeral=True)
        return

    await interaction.response.defer(thinking=True)
    try:
        data = await _get(f"/api/rush/standings?guild={interaction.guild_id}",
                          api_key=api_key)
        entries = data["entries"]
        day = data["day"]
    except PuzzleServerUnavailable as exc:
        await interaction.followup.send(str(exc))
        return
    except (KeyError, TypeError) as exc:
        log.warning("puzzle /api/rush/standings unusable: %s", exc)
        await interaction.followup.send(UNEXPECTED_REPLY)
        return

    if not entries:
        await interaction.followup.send(f"Nobody has run rush #{day} yet. Be first.")
        return

    # Built inside its own guard: the interaction is already deferred, so an
    # unexpected shape here would leave the user watching a spinner forever.
    try:
        lines = _standings_lines(entries, _rush_detail)
    except (KeyError, TypeError) as exc:
        log.warning("puzzle rush entry unusable: %s", exc)
        await interaction.followup.send(UNEXPECTED_REPLY)
        return

    embed = discord.Embed(
        title=f"Puzzle rush #{day} — leaderboard",
        description="\n".join(lines),
        colour=PUZZLE_COLOUR)
    if len(entries) > STANDINGS_SHOWN:
        embed.set_footer(text=f"and {len(entries) - STANDINGS_SHOWN} more")
    await interaction.followup.send(embed=embed)


@puzzle_group.command(
    name="help",
    description="What the daily puzzle is and how it is scored.")
async def puzzle_help(interaction: discord.Interaction):
    app_id = _app_id()
    embed = discord.Embed(
        title="Daily Puzzle",
        description=(
            "One modern Tetris puzzle a day, from the Tetris at UCI archive. "
            "Everyone gets the same puzzle, and it changes at midnight."),
        colour=PUZZLE_COLOUR if app_id else MISSING_COLOUR)
    embed.add_field(
        name="How it is scored",
        value=("Each puzzle has a fixed queue and an attack target taken from "
               "the author's own solution. Reach the target and it counts. "
               "Restart as often as you like — only the attempt that solves "
               "it is recorded."),
        inline=False)
    embed.add_field(
        name="Puzzle rush",
        value=("Five minutes against one shared sequence that ramps in "
               "difficulty, with two skips. A dead board just restarts the "
               "same puzzle, so time is all it costs. One ranked rush each "
               "day; practice rushes are unlimited and never recorded."),
        inline=False)
    embed.add_field(
        name="Controls",
        value=("Fully rebindable, with TETR.IO-style handling: DAS, ARR, DCD, "
               "SDF, safe lock, DAS cancel, and initial rotation/hold. Open "
               "**Settings** in the activity, or press Esc."),
        inline=False)
    embed.add_field(
        name="Leaderboards",
        value=("`/puzzle standings` ranks today's solvers in this server by "
               "total time on the puzzle, and `/puzzle rush` ranks today's "
               "rushes by solves, then by who reached that count soonest. "
               "Times come from the player's own client, so treat them as a "
               "friendly scoreboard, not a record book."),
        inline=False)
    if app_id:
        embed.add_field(
            name="Open it",
            value=ACTIVITY_LAUNCH_URL.format(app_id=app_id),
            inline=False)
    else:
        embed.set_footer(text=_not_configured("PUZZLE_APP_ID"))
    await interaction.response.send_message(embed=embed, ephemeral=True)
