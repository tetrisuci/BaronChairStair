"""
impostor_game.py
~~~~~~~~~~~~~~~~
Lobby state and message text for the Impostor game.

The layer between impostor.py (pure rules, no discord import) and
impostor_views.py / impostor_commands.py (buttons and slash commands). It owns
the per-channel game registry, the word store, the public message text, and
the mechanics of getting a role into somebody's DMs -- everything that is not
a Discord component or a command signature.

One game at a time per channel. State is in memory only: a restart drops
lobbies and in-flight rounds, which is fine -- a round is a few minutes long
and players still have their DMs.
"""

from __future__ import annotations

import dataclasses
import os
import sys
from pathlib import Path

import discord

import impostor

ROOT = Path(__file__).parent.parent
DEFAULT_WORDS_PATH = ROOT / "data" / "impostor_words.json"

LOBBY_TIMEOUT_SECONDS = 600      # 10 minutes of nobody pressing anything
ROUND_TIMEOUT_SECONDS = 3600     # abandoned rounds stop holding a live button
GUESS_TIMEOUT_SECONDS = 120      # the impostor's open dropdown
VOTE_TIMEOUT_SECONDS = 300       # a called vote closes itself after 5 minutes
MESSAGE_LIMIT = 1900             # Discord's 2000, minus room for a header
AUTOCOMPLETE_LIMIT = 25          # Discord's hard cap on choices
MAX_SELECT_OPTIONS = 25          # ...and on select-menu options

NO_MENTIONS = discord.AllowedMentions.none()

# How a player gets their word. A bot cannot push an ephemeral message at
# somebody -- ephemeral only exists as a reply to that person's own
# interaction -- so "button" means the round message carries a button each
# player presses to pull their own private copy. "dm" pushes, but only reaches
# players who accept DMs from server members.
DELIVERY_BUTTON = "button"
DELIVERY_DM = "dm"

_packs: impostor.WordPacks | None = None

def _words_path() -> Path:
    override = os.getenv("IMPOSTOR_WORDS_PATH")
    if not override:
        return DEFAULT_WORDS_PATH
    path = Path(override).expanduser()
    # A relative override resolves against the repo, never the working
    # directory -- pm2 starts the bot from wherever pm2 happens to be, and a
    # stray second word file is a confusing way to lose everyone's words.
    return path if path.is_absolute() else ROOT / path


def word_packs() -> impostor.WordPacks:
    """The word store, built on first use.

    Not at import time: discord_bot.py imports this module *before* it calls
    load_dotenv(), so IMPOSTOR_WORDS_PATH from .env is not set yet.
    """
    global _packs
    if _packs is None:
        _packs = impostor.WordPacks(_words_path())
    return _packs

# channel_id -> Game. One channel, one game: two overlapping lobbies in the
# same chat would deal two words to the same people.
_games: dict[int, "Game"] = {}


# ── Lobby state ───────────────────────────────────────────────────────────────

@dataclasses.dataclass(frozen=True)
class Game:
    """A lobby, or a dealt round once `round` is set. Replaced, never mutated."""

    channel_id: int
    host_id: int
    pack: str | None            # None = pick across every pack
    impostors: int | None       # None = scale with the player count
    show_category: bool
    players: tuple[int, ...]
    decoy: bool = True          # impostor gets a near-miss word
    blind: bool = False         # ...and is not told they are the impostor
    guessing: bool = True       # impostor may guess the crew word early
    delivery: str = DELIVERY_BUTTON   # how a player receives their role
    voting: bool = True               # crew may call a vote to eject someone
    wordlist: bool = True             # show everyone the board of candidates
    vote: impostor.Vote | None = None  # the open ballot, if one is running
    round: impostor.Round | None = None

    @property
    def is_running(self) -> bool:
        return self.round is not None


def _store(game: Game) -> Game:
    _games[game.channel_id] = game
    return game


def _clear(channel_id: int) -> None:
    _games.pop(channel_id, None)


def _mentions(user_ids: tuple[int, ...]) -> str:
    # Rendered as names, not pings: every send passes allowed_mentions=none.
    return ", ".join(f"<@{uid}>" for uid in user_ids) or "nobody yet"


def _lobby_text(game: Game) -> str:
    count = len(game.players)
    pack = f"`{game.pack}`" if game.pack else "any pack"
    auto = impostor.default_impostor_count(max(count, impostor.MIN_PLAYERS))
    impostors = (str(game.impostors) if game.impostors is not None
                 else f"auto ({auto})")
    needed = max(0, impostor.MIN_PLAYERS - count)
    status = (f"need {needed} more player{'s' if needed != 1 else ''}"
              if needed else "ready — host can deal")
    mode = ("blind — impostor gets a near-miss word and is NOT told"
            if game.blind else
            "impostor gets a near-miss word" if game.decoy else
            "impostor gets no word")
    if game.guessing:
        mode += " · early guess allowed"
    if game.voting:
        mode += " · crew may call a vote"
    if game.wordlist:
        mode += " · word list shown"
    how = ("press **See my word** on the round message"
           if game.delivery == DELIVERY_BUTTON else "direct message")
    # A host who named a roster without themselves in it runs the game but
    # does not play. Say so here, where Join can still fix it.
    host = (f"host <@{game.host_id}>" if game.host_id in game.players
            else f"host <@{game.host_id}>, not playing")
    return (f"🕵️ **Impostor** — lobby open ({host})\n"
            f"Words: {pack} · impostors: {impostors} · "
            f"category shown: {'yes' if game.show_category else 'no'}\n"
            f"Mode: {mode}\n"
            f"Roles arrive by: {how}\n"
            f"**Players ({count}/{impostor.MAX_PLAYERS}):** "
            f"{_mentions(game.players)}\n"
            f"_{status}. Lobby closes after "
            f"{LOBBY_TIMEOUT_SECONDS // 60} minutes of inactivity._")


def _round_text(game: Game) -> str:
    rnd = game.round
    if rnd is None:                       # only reachable via a caller bug
        return _lobby_text(game)
    category = f" from `{rnd.pack}`" if rnd.show_category else ""
    # Say how many words are in play, never which -- this message is public.
    if rnd.decoy:
        dealt = ("everyone got a word — the impostor"
                 f"{'s' if len(rnd.impostor_ids) != 1 else ''} got a "
                 f"different one{category}.")
    else:
        dealt = f"everyone else got a word{category}."
    board = impostor.word_board(rnd)
    return (f"🕵️ **Impostor** — round in play\n"
            + (f"**The word is one of these:**\n{board}\n" if board else "")
            + f"**Players ({len(rnd.player_ids)}):** "
            f"{_mentions(rnd.player_ids)}\n"
            f"{len(rnd.impostor_ids)} impostor"
            f"{'s' if len(rnd.impostor_ids) != 1 else ''} · {dealt}\n"
            + ("_The impostor may guess the word early — right, they win; "
               "wrong, you do._\n" if rnd.guessing_allowed else "")
            + ("_Crew: press **Call a vote** when you are ready to eject "
               "someone._\n" if game.voting else "")
            + ("_Press **See my word** for your own copy — only you see it. "
               "Done? `/impostor reveal`._"
               if game.delivery == DELIVERY_BUTTON else
               "_Lost your DM? `/impostor myword`. Done? "
               "`/impostor reveal`._"))


def _vote_text(game: Game) -> str:
    """The public vote message: who has voted, never who they voted for."""
    rnd, vote = game.round, game.vote
    if rnd is None or vote is None:            # only reachable via caller bug
        return "🗳️ **Vote closed.**"
    voted = tuple(p for p in rnd.player_ids if vote.has_voted(p))
    waiting = tuple(p for p in rnd.player_ids if not vote.has_voted(p))
    return (f"🗳️ **Vote called** — who is the impostor?\n"
            f"Eject the impostor and the crew win; eject a crewmate and they "
            f"lose. Everyone votes, impostor included.\n"
            f"**In ({len(voted)}/{len(rnd.player_ids)}):** "
            f"{_mentions(voted) if voted else 'nobody yet'}\n"
            f"**Waiting on:** {_mentions(waiting) if waiting else 'nobody'}\n"
            f"_Press **Cast my vote** — your pick stays private until the "
            f"tally. Closes after {VOTE_TIMEOUT_SECONDS // 60} minutes._")


# ── Permission helpers ────────────────────────────────────────────────────────

def _may_manage_game(interaction: discord.Interaction, game: Game) -> bool:
    """Host runs the game; a moderator can clean up after an absent host."""
    if interaction.user.id == game.host_id:
        return True
    perms = getattr(interaction.user, "guild_permissions", None)
    return bool(perms and (perms.manage_messages or perms.manage_guild))


def _may_edit_words(interaction: discord.Interaction) -> bool:
    """Word packs are shared across guilds, so gate edits on Manage Server."""
    perms = getattr(interaction.user, "guild_permissions", None)
    return bool(perms and (perms.manage_guild or perms.administrator))


# ── Dealing ───────────────────────────────────────────────────────────────────

async def _resolve_members(guild: discord.Guild, user_ids: tuple[int, ...]
                           ) -> tuple[dict[int, discord.Member], tuple[int, ...]]:
    """Members by id, plus the ids that could not be resolved (left the guild)."""
    found: dict[int, discord.Member] = {}
    gone: list[int] = []
    for uid in user_ids:
        member = guild.get_member(uid)
        if member is None:
            try:
                member = await guild.fetch_member(uid)
            except (discord.NotFound, discord.HTTPException):
                gone.append(uid)
                continue
        found[uid] = member
    return found, tuple(gone)


async def _dm_role(member: discord.Member, text: str) -> int | None:
    """DM one player their role. Returns their id if the DM did not land."""
    try:
        await member.send(text, allowed_mentions=NO_MENTIONS)
        return None
    except discord.Forbidden:
        return member.id                      # DMs closed to server members
    except discord.HTTPException as e:
        print(f"impostor: DM to {member.id} failed: {type(e).__name__}: {e}",
              file=sys.stderr)
        return member.id


