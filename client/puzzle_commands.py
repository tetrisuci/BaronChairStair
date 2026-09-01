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
                       Only needed for /puzzle standings.
"""

import logging
import os
from urllib.parse import urlparse

import aiohttp
import discord
from discord import app_commands

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


def _duration(ms: int) -> str:
    """mm:ss.d, growing an hours field rather than running the minutes up."""
    seconds = ms / 1000
    hours, rest = divmod(int(seconds // 60), 60)
    if hours:
        return f"{hours}:{rest:02d}:{seconds % 60:04.1f}"
    return f"{rest}:{seconds % 60:04.1f}"


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
        puzzle = today["puzzle"]
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
        description=puzzle.get("goal") or "Match the reference solution.",
        colour=PUZZLE_COLOUR,
        url=launch)
    embed.add_field(name="Difficulty", value=_grade(puzzle.get("difficulty", 0)))
    embed.add_field(name="Pieces", value=str(puzzle.get("pieces", "?")))
    embed.add_field(name="Target", value=f"{puzzle.get('targetAttack', '?')} attack")
    embed.add_field(name="Solved by", value=f"{solved} so far", inline=False)
    embed.set_footer(
        text=f"“{puzzle.get('title', 'untitled')}” by {puzzle.get('author', 'unknown')}")

    await interaction.followup.send(f"Today's puzzle is up. {launch}", embed=embed)


def _standings_lines(entries: list[dict]) -> list[str]:
    """One line per player. Raises KeyError/TypeError on an unexpected shape."""
    lines = []
    for rank, entry in enumerate(entries[:STANDINGS_SHOWN], start=1):
        # Display names are player-chosen and embeds render masked links, so a
        # username like "[Free Nitro](https://…)" would become a live link.
        name = discord.utils.escape_markdown(entry["player"]["username"])
        if entry["solved"]:
            detail = _duration(entry["totalMs"])
            if entry["resets"]:
                detail += f" · {entry['resets']} restart{'s' if entry['resets'] != 1 else ''}"
        else:
            detail = f"unsolved · {entry['attack']}/{entry['targetAttack']}"
        lines.append(f"`{rank:>2}` **{name}** — {detail}")
    return lines


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
        await interaction.response.send_message(
            "Standings are per server, so this only works in a server.",
            ephemeral=True)
        return

    await interaction.response.defer(thinking=True)
    try:
        data = await _get(f"/api/standings?guild={interaction.guild_id}",
                          api_key=api_key)
        entries = data["entries"]
        day = data["day"]
    except PuzzleServerUnavailable as exc:
        await interaction.followup.send(str(exc))
        return
    except (KeyError, TypeError) as exc:
        log.warning("puzzle /api/standings unusable: %s", exc)
        await interaction.followup.send("The puzzle server sent something unexpected. Try again later.")
        return

    if not entries:
        await interaction.followup.send(f"Nobody has solved #{day} yet. Be first.")
        return

    # Built inside its own guard: the interaction is already deferred, so an
    # unexpected shape here would leave the user watching a spinner forever.
    try:
        lines = _standings_lines(entries)
    except (KeyError, TypeError) as exc:
        log.warning("puzzle standings entry unusable: %s", exc)
        await interaction.followup.send("Puzzle sent something unexpected. Try again later.")
        return

    embed = discord.Embed(
        title=f"Puzzle #{day} — leaderboard",
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
        name="Controls",
        value=("Fully rebindable, with TETR.IO-style handling: DAS, ARR, DCD, "
               "SDF, safe lock, DAS cancel, and initial rotation/hold. Open "
               "**Settings** in the activity, or press Esc."),
        inline=False)
    embed.add_field(
        name="Leaderboard",
        value=("`/puzzle standings` ranks today's solvers in this server by "
               "total time on the puzzle. Times come from the player's own "
               "client, so treat them as a friendly scoreboard, not a record "
               "book."),
        inline=False)
    if app_id:
        embed.add_field(
            name="Open it",
            value=ACTIVITY_LAUNCH_URL.format(app_id=app_id),
            inline=False)
    else:
        embed.set_footer(text=_not_configured("PUZZLE_APP_ID"))
    await interaction.response.send_message(embed=embed, ephemeral=True)
