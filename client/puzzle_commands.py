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
#: The same file, set separately.
#:
#: Not `recap_db` reused. That one is assigned inside the try that creates the
#: recap's table, so a recap failure would switch version announcements off too
#: — two unrelated features sharing one failure, and a boot log pointing at the
#: wrong one. Each is set only if its own table was made.
version_db: "sqlite3.Connection | None" = None


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


# One command, not a group.
#
# There were four: play, standings, rush and help. Discord will not let a
# command be both invocable and a group, so `/puzzle` being a thing you can
# type at all means the subcommands cannot exist — and they should not. Three
# of them rendered in Discord what the activity itself now shows on its own
# front screen, each in its own embed, each a second place for a board to be
# wrong. The one job left here is the one Discord is actually for: announcing
# the day in a channel, with a way in.
@app_commands.command(
    name="puzzle",
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
        # The changelog describes *this bot's* version, not the puzzle server's
        # health, so an unreachable activity is no reason to withhold it. It
        # used to be announced only on the happy path, which meant the whole of
        # an outage went unannounced — and a server that cannot reach the
        # activity is the one most likely to want to know what just changed.
        await _announce_new_version(interaction)
        return
    # `wait=True` so the send comes back with a message: without it discord.py
    # returns None and there is nothing for tomorrow's recap to reply to.
    message = await interaction.followup.send(
        f"Today's puzzle is up. {launch}", wait=True)
    _remember_play(interaction, day, message)
    await _announce_new_version(interaction)


async def _announce_new_version(interaction: discord.Interaction) -> None:
    """
    Tells a server what changed, the first time somebody runs `/puzzle` on a
    build it has not heard about.

    Here rather than on a timer or at boot because a deploy should not wake a
    channel up. It rides along behind the thing somebody actually asked for, and
    only the first person to ask sees it arrive.

    **No pings**, explicitly: this is an announcement nobody opted into, and the
    text is written by us rather than by a player, so the one thing it must not
    do is notify a room. `AllowedMentions.none()` rather than trusting the
    content — a future release note containing `@everyone` would otherwise be a
    server-wide ping shipped in a string literal.

    Best effort, like `_remember_play`: a server missing a changelog is a
    nuisance, and raising here would cost the player the puzzle they asked for.
    The claim happens before the send, so a failure loses that announcement
    rather than repeating it — see `changelog.claim_announcement`.
    """
    if version_db is None or interaction.guild_id is None:
        return
    try:
        message = changelog.announcement_for(version_db, interaction.guild_id)
    except sqlite3.Error:
        log.warning("could not read the changelog state", exc_info=True)
        return
    if not message:
        return
    try:
        await interaction.followup.send(
            message, allowed_mentions=discord.AllowedMentions.none())
    except discord.HTTPException:
        log.warning("could not post the changelog", exc_info=True)


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
