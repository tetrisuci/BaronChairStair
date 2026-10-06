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
                       Needed by the recap, which reads /api/recap, and by
                       /archive sync (archive_commands.py), which posts to
                       /api/bot/reload-archive so the activity reloads.
"""

import logging
import os
import sqlite3
from io import BytesIO
from urllib.parse import urlparse

import aiohttp
import discord
from discord import app_commands

import changelog
import puzzle_recap

log = logging.getLogger(__name__)

# Discord resolves this to "launch this activity here" when clicked from a
# guild channel; there is no other public URL form for an embedded app.
ACTIVITY_LAUNCH_URL = "https://discord.com/activities/{app_id}"

HTTP_TIMEOUT = aiohttp.ClientTimeout(total=8)

# Lent by discord_bot at boot so /puzzle can note where it announced the
# day. Left as None when nothing wired it up: this module stays importable on
# its own, and a missing recap must never stop the commands working.
recap_db: "sqlite3.Connection | None" = None


def _app_id() -> str:
    return os.environ.get("PUZZLE_APP_ID", "").strip()


def _api_base() -> str:
    return os.environ.get("PUZZLE_API", "").rstrip("/")


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
        # The type as well as the message, because the message is usually empty.
        # Four of the five exceptions caught here -- ClientConnectionError,
        # ClientOSError, ClientPayloadError and TimeoutError -- stringify to ""
        # (ServerDisconnectedError is the exception), so this line read
        #
        #     puzzle /api/today failed:
        #
        # and stopped. That is the line somebody reads when the bot cannot see
        # the activity, and it named neither the cause nor even that there was
        # one. Seen in production on 2026-09-07.
        log.warning("puzzle %s failed: %s: %s", path, type(exc).__name__, exc)
        raise PuzzleServerUnavailable(
            "Couldn't reach the puzzle server. Try again in a minute.") from exc


puzzle = app_commands.Group(
    name="puzzle", description="Open the daily puzzle or read recent changes.")


# Discord requires subcommands once a command becomes a group. The launch
# keeps its short public reply under /puzzle play; notes are requested privately.
@puzzle.command(
    name="play",
    description="Open the daily Tetris puzzle.")
async def puzzle_command(interaction: discord.Interaction):
    app_id = _app_id()
    if not app_id:
        await interaction.response.send_message(
            _not_configured("PUZZLE_APP_ID"), ephemeral=True)
        return

    await interaction.response.defer(thinking=True)
    launch = ACTIVITY_LAUNCH_URL.format(app_id=app_id)

    try:
        today = await _get("/api/today")
        day = today["day"]
    except (PuzzleServerUnavailable, KeyError, TypeError) as exc:
        log.warning("puzzle /api/today unusable: %s", exc)
        await interaction.followup.send(
            f"**Daily puzzle** is up.\n{launch}\n"
            "_(puzzle details are unavailable right now)_")
        return
    # `wait=True` so the send comes back with a message: without it discord.py
    # returns None and there is nothing for tomorrow's recap to reply to.
    message = await interaction.followup.send(
        f"Today's puzzle is up. {launch}", wait=True)
    _remember_play(interaction, day, message)


@puzzle.command(name="changelog", description="Read the most recent puzzle changes privately.")
@app_commands.describe(count="Number of recent changes to show (1–20; default 5)")
async def puzzle_changelog(
    interaction: discord.Interaction,
    count: app_commands.Range[int, 1, changelog.MAX_RECENT_CHANGES] = changelog.DEFAULT_RECENT_CHANGES,
) -> None:
    """An on-demand, repeatable response without channel posts or seen state."""
    attachment = None
    try:
        message = changelog.format_recent_changes(count)
        full_text = changelog.format_recent_changes(count, truncate=False)
        if sum(2 if ord(char) > 0xFFFF else 1 for char in full_text) > changelog.MAX_MESSAGE_CHARS:
            attachment = discord.File(BytesIO(full_text.encode("utf-8")), filename="puzzle-changelog.txt")
            message += "\n\nThe full requested changelog is attached."
    except ValueError:
        message = f"Choose a number of changes between 1 and {changelog.MAX_RECENT_CHANGES}."
    options = {"file": attachment} if attachment else {}
    await interaction.response.send_message(
        message, ephemeral=True, allowed_mentions=discord.AllowedMentions.none(), **options)


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
