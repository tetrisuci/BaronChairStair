"""
impostor_views.py
~~~~~~~~~~~~~~~~~
The Impostor game's Discord components: the lobby buttons, the live round's
Guess button, and the impostor's guess dropdown.

Dealing lives here too, because it ends by rewriting the lobby message into a
round message -- it is component work, not rules.

None of these views are registered with bot.add_view: they are short-lived by
design and a restart drops the in-memory game along with them.
"""

from __future__ import annotations

import asyncio
import dataclasses
import sys

import discord

import impostor
from impostor import RoundError, WordPackError
from impostor_game import (
    GUESS_TIMEOUT_SECONDS, LOBBY_TIMEOUT_SECONDS, NO_MENTIONS,
    ROUND_TIMEOUT_SECONDS, Game, _clear, _dm_role, _games, _lobby_text,
    _may_manage_game, _mentions, _resolve_members, _round_text, _store,
    word_packs,
)

async def _deal(interaction: discord.Interaction, game: Game) -> None:
    """Pick a word, assign impostors, DM everyone, then update the lobby message.

    The caller has already deferred the interaction response.
    """
    guild = interaction.guild
    if guild is None:                          # a lobby cannot exist outside one
        await interaction.followup.send("Impostor only runs in a server.",
                                        ephemeral=True)
        return

    members, gone = await _resolve_members(guild, game.players)
    if gone:
        # Drop them and make the host press Deal again rather than dealing a
        # round whose player list is already wrong.
        remaining = tuple(p for p in game.players if p not in gone)
        _store(dataclasses.replace(game, players=remaining))
        await interaction.followup.send(
            f"{_mentions(gone)} left the server — removed from the lobby. "
            "Press **Deal** again.", allowed_mentions=NO_MENTIONS)
        await _refresh_lobby(interaction, _games.get(game.channel_id))
        return

    try:
        picked = word_packs().pick(
            game.pack, decoy=game.decoy,
            min_group=impostor.MIN_GUESS_GROUP if game.guessing else 1)
        candidates = ()
        if game.guessing:
            candidates = impostor.build_candidates(
                picked.word, picked.group,
                pool=word_packs().words(picked.pack))
        rnd = impostor.assign_roles(
            game.players, pack=picked.pack, word=picked.word,
            impostors=game.impostors, show_category=game.show_category,
            decoy=picked.decoy, blind=game.blind, candidates=candidates)
    except (WordPackError, RoundError) as e:
        await interaction.followup.send(f"Cannot deal: {e}", ephemeral=True)
        return

    failed_ids = await asyncio.gather(*(
        _dm_role(members[uid], impostor.role_message(rnd, uid))
        for uid in rnd.player_ids))
    failed = tuple(uid for uid in failed_ids if uid is not None)

    if failed:
        # Some players already hold a word. Void the round loudly rather than
        # play on with a half-dealt table; the next Deal draws a fresh word, so
        # the DMs already sent are worthless to whoever has them.
        await interaction.followup.send(
            f"⚠️ Could not DM {_mentions(failed)} — this round is **void**.\n"
            "Everyone: ignore the DM you just got. Fix it under "
            "**Privacy Settings → Direct Messages → allow DMs from server "
            "members**, then the host presses **Deal** again for a new word.",
            allowed_mentions=NO_MENTIONS)
        return

    running = _store(dataclasses.replace(game, round=rnd))
    await _refresh_lobby(interaction, running)
    await interaction.followup.send(
        f"✅ Dealt — check your DMs. {len(rnd.player_ids)} players, "
        f"{len(rnd.impostor_ids)} impostor"
        f"{'s' if len(rnd.impostor_ids) != 1 else ''}.",
        allowed_mentions=NO_MENTIONS)


async def _refresh_lobby(interaction: discord.Interaction,
                         game: Game | None) -> None:
    """Rewrite the lobby message to match `game` (or retire it when None)."""
    view = LobbyView.active.get(interaction.channel_id)
    if view is None or view.message is None:
        return
    try:
        if game is None:
            view.stop()
            LobbyView.active.pop(interaction.channel_id, None)
            await view.message.edit(content="🕵️ **Impostor** — lobby closed.",
                                    view=None, allowed_mentions=NO_MENTIONS)
        elif game.is_running:
            view.stop()
            LobbyView.active.pop(interaction.channel_id, None)
            # The lobby buttons retire, but a guessable round needs one of its
            # own, so the impostor has somewhere to press.
            round_view = None
            if game.round is not None and game.round.guessing_allowed:
                round_view = RoundView(interaction.channel_id)
                round_view.message = view.message
                RoundView.active[interaction.channel_id] = round_view
            await view.message.edit(content=_round_text(game),
                                    view=round_view,
                                    allowed_mentions=NO_MENTIONS)
        else:
            await view.message.edit(content=_lobby_text(game), view=view,
                                    allowed_mentions=NO_MENTIONS)
    except discord.HTTPException as e:
        # The lobby message was deleted, or Discord hiccuped. Game state is
        # still authoritative, and /impostor status can show it.
        print(f"impostor: lobby edit failed: {type(e).__name__}: {e}",
              file=sys.stderr)


# ── Lobby view ────────────────────────────────────────────────────────────────

class LobbyView(discord.ui.View):
    """Join / Leave / Deal / Cancel on the lobby message.

    Short-lived by design (the timeout closes it), so unlike
    InternshipDigestView it is not registered with bot.add_view -- a restart
    drops the lobby along with its in-memory game.
    """

    active: dict[int, "LobbyView"] = {}

    def __init__(self, channel_id: int):
        super().__init__(timeout=LOBBY_TIMEOUT_SECONDS)
        self.channel_id = channel_id
        self.message: discord.Message | None = None

    async def on_timeout(self) -> None:
        LobbyView.active.pop(self.channel_id, None)
        game = _games.get(self.channel_id)
        # A dealt round outlives its lobby view: only drop a game still waiting.
        if game is not None and not game.is_running:
            _clear(self.channel_id)
        if self.message is None:
            return
        try:
            await self.message.edit(
                content="🕵️ **Impostor** — lobby expired. "
                        "Start a new one with `/impostor start`.",
                view=None, allowed_mentions=NO_MENTIONS)
        except discord.HTTPException:
            pass                  # message gone; nothing left to tidy

    def _game(self) -> Game | None:
        return _games.get(self.channel_id)

    @discord.ui.button(label="Join", emoji="🙋",
                       style=discord.ButtonStyle.primary)
    async def join(self, interaction: discord.Interaction,
                   button: discord.ui.Button):
        game = self._game()
        if game is None or game.is_running:
            await interaction.response.send_message(
                "That lobby is no longer open.", ephemeral=True)
            return
        if interaction.user.id in game.players:
            await interaction.response.send_message("You are already in.",
                                                    ephemeral=True)
            return
        if len(game.players) >= impostor.MAX_PLAYERS:
            await interaction.response.send_message(
                f"The lobby is full ({impostor.MAX_PLAYERS} players).",
                ephemeral=True)
            return

        updated = _store(dataclasses.replace(
            game, players=(*game.players, interaction.user.id)))
        await interaction.response.edit_message(content=_lobby_text(updated),
                                                view=self,
                                                allowed_mentions=NO_MENTIONS)

    @discord.ui.button(label="Leave", emoji="🚪",
                       style=discord.ButtonStyle.secondary)
    async def leave(self, interaction: discord.Interaction,
                    button: discord.ui.Button):
        game = self._game()
        if game is None or game.is_running:
            await interaction.response.send_message(
                "That lobby is no longer open.", ephemeral=True)
            return
        if interaction.user.id not in game.players:
            await interaction.response.send_message("You are not in the lobby.",
                                                    ephemeral=True)
            return

        remaining = tuple(p for p in game.players if p != interaction.user.id)
        if not remaining:
            _clear(self.channel_id)
            LobbyView.active.pop(self.channel_id, None)
            self.stop()
            await interaction.response.edit_message(
                content="🕵️ **Impostor** — everyone left; lobby closed.",
                view=None, allowed_mentions=NO_MENTIONS)
            return

        # Host left: hand the lobby to whoever joined first, so Deal and Cancel
        # do not become unreachable.
        host = (remaining[0] if game.host_id == interaction.user.id
                else game.host_id)
        updated = _store(dataclasses.replace(game, players=remaining,
                                             host_id=host))
        await interaction.response.edit_message(content=_lobby_text(updated),
                                                view=self,
                                                allowed_mentions=NO_MENTIONS)

    @discord.ui.button(label="Deal", emoji="🃏",
                       style=discord.ButtonStyle.success)
    async def deal(self, interaction: discord.Interaction,
                   button: discord.ui.Button):
        game = self._game()
        if game is None or game.is_running:
            await interaction.response.send_message(
                "That lobby is no longer open.", ephemeral=True)
            return
        if not _may_manage_game(interaction, game):
            await interaction.response.send_message(
                f"Only the host (<@{game.host_id}>) can deal.", ephemeral=True,
                allowed_mentions=NO_MENTIONS)
            return
        if len(game.players) < impostor.MIN_PLAYERS:
            await interaction.response.send_message(
                f"Need at least {impostor.MIN_PLAYERS} players — "
                f"there {'is' if len(game.players) == 1 else 'are'} "
                f"{len(game.players)}.", ephemeral=True)
            return

        # DMs take a moment; defer before the 3-second interaction deadline.
        await interaction.response.defer()
        await _deal(interaction, game)

    @discord.ui.button(label="Cancel", emoji="🛑",
                       style=discord.ButtonStyle.danger)
    async def cancel(self, interaction: discord.Interaction,
                     button: discord.ui.Button):
        game = self._game()
        if game is None:
            await interaction.response.send_message(
                "There is no game here.", ephemeral=True)
            return
        if not _may_manage_game(interaction, game):
            await interaction.response.send_message(
                f"Only the host (<@{game.host_id}>) can cancel.",
                ephemeral=True, allowed_mentions=NO_MENTIONS)
            return

        _clear(self.channel_id)
        LobbyView.active.pop(self.channel_id, None)
        self.stop()
        await interaction.response.edit_message(
            content=f"🕵️ **Impostor** — cancelled by <@{interaction.user.id}>.",
            view=None, allowed_mentions=NO_MENTIONS)


class GuessSelect(discord.ui.Select):
    """The impostor's dropdown of candidate words.

    Options are the ones frozen on the Round at deal time -- never re-sampled
    here, or an impostor could reopen the menu and intersect the lists.
    """

    def __init__(self, channel_id: int, candidates: tuple[str, ...]):
        super().__init__(
            placeholder="Guess the crew's word — one shot",
            min_values=1, max_values=1,
            options=[discord.SelectOption(label=word) for word in candidates])
        self.channel_id = channel_id

    async def callback(self, interaction: discord.Interaction):
        game = _games.get(self.channel_id)
        if game is None or game.round is None:
            await interaction.response.edit_message(
                content="That round is already over.", view=None)
            return
        rnd = game.round
        if not rnd.is_impostor(interaction.user.id):
            await interaction.response.edit_message(
                content="Only the impostor can guess.", view=None)
            return

        try:
            correct = impostor.resolve_guess(rnd, self.values[0])
        except RoundError as e:
            await interaction.response.edit_message(content=str(e), view=None)
            return

        # Clear the game first: a second guess arriving while this one is
        # still being sent must find the round already gone. It is an
        # in-memory pop, so it cannot fail part-way.
        _clear(self.channel_id)
        guess = self.values[0]
        # Answer the interaction before any other HTTP call -- Discord gives a
        # component callback three seconds, and the edits below are not free.
        await interaction.response.edit_message(
            content=(f"You guessed **{guess}** — "
                     + ("correct." if correct else "wrong.")), view=None)
        await _retire_round_view(self.channel_id,
                                 "🕵️ **Impostor** — round over.")
        if correct:
            body = (f"🕵️ **The impostor guessed it.** <@{interaction.user.id}> "
                    f"called the word — it was **{rnd.word}** (`{rnd.pack}`).\n"
                    f"**Impostor{'s' if len(rnd.impostor_ids) != 1 else ''} "
                    f"win:** {_mentions(rnd.impostor_ids)}")
        else:
            body = (f"🧩 **The impostor guessed wrong.** "
                    f"<@{interaction.user.id}> said **{guess}** — the word was "
                    f"**{rnd.word}** (`{rnd.pack}`).\n"
                    f"**Crew win:** {_mentions(rnd.crew_ids)}\n"
                    f"Impostor{'s' if len(rnd.impostor_ids) != 1 else ''}: "
                    f"{_mentions(rnd.impostor_ids)}")
        await _announce(interaction, body)


class GuessView(discord.ui.View):
    """Ephemeral wrapper around one GuessSelect."""

    def __init__(self, channel_id: int, candidates: tuple[str, ...]):
        super().__init__(timeout=GUESS_TIMEOUT_SECONDS)
        self.add_item(GuessSelect(channel_id, candidates))


class RoundView(discord.ui.View):
    """The Guess button that sits on a live round's message."""

    active: dict[int, "RoundView"] = {}

    def __init__(self, channel_id: int):
        super().__init__(timeout=ROUND_TIMEOUT_SECONDS)
        self.channel_id = channel_id
        self.message: discord.Message | None = None

    async def on_timeout(self) -> None:
        RoundView.active.pop(self.channel_id, None)

    @discord.ui.button(label="Guess the word", emoji="🎯",
                       style=discord.ButtonStyle.danger)
    async def guess(self, interaction: discord.Interaction,
                    button: discord.ui.Button):
        game = _games.get(self.channel_id)
        if game is None or game.round is None:
            await interaction.response.send_message("That round is over.",
                                                    ephemeral=True)
            return
        rnd = game.round
        if not rnd.is_impostor(interaction.user.id):
            # Crew pressing it learn nothing they did not already know: they
            # know they are crew, and the menu never reaches them.
            await interaction.response.send_message(
                "Only the impostor can guess." if interaction.user.id
                in rnd.player_ids else "You are not in this round.",
                ephemeral=True)
            return

        await interaction.response.send_message(
            "Pick the word you think the crew got. **One shot** — right and "
            "you win, wrong and they do.",
            view=GuessView(self.channel_id, rnd.candidates), ephemeral=True)


async def _announce(interaction: discord.Interaction, body: str) -> None:
    """Post a public result for a round that ended from an ephemeral menu."""
    channel = interaction.channel
    if channel is None:                    # cached-out channel; nothing to do
        return
    try:
        await channel.send(body, allowed_mentions=NO_MENTIONS)
    except discord.HTTPException as e:
        print(f"impostor: result announce failed: {type(e).__name__}: {e}",
              file=sys.stderr)


async def _retire_round_view(channel_id: int, text: str | None = None) -> None:
    """Take the Guess button off a round that has ended."""
    view = RoundView.active.pop(channel_id, None)
    if view is None:
        return
    view.stop()
    if view.message is None:
        return
    try:
        await view.message.edit(content=text or view.message.content,
                                view=None, allowed_mentions=NO_MENTIONS)
    except discord.HTTPException:
        pass                    # message gone; nothing left to tidy


