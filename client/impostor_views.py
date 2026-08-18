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
    DELIVERY_BUTTON, GUESS_TIMEOUT_SECONDS, LOBBY_TIMEOUT_SECONDS,
    MAX_SELECT_OPTIONS, NO_MENTIONS, ROUND_TIMEOUT_SECONDS,
    VOTE_TIMEOUT_SECONDS, Game, _clear, _dm_role, _games, _lobby_text,
    _may_manage_game, _mentions, _resolve_members, _round_text, _store,
    _vote_text, word_packs,
)

async def _deal(interaction: discord.Interaction, game: Game) -> None:
    """Pick a word, assign impostors, hand out roles, rewrite the lobby message.

    Two ways to hand out a role, see impostor_game.DELIVERY_*: push a DM to
    everyone, or post one button they each press for an ephemeral copy. The
    button path cannot half-fail the way DMs can, so it is the default.

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
        # One list serves both the public board and the guess menu, so they
        # can never disagree about what the possible words are.
        candidates = ()
        if game.guessing or game.wordlist:
            candidates = impostor.build_candidates(
                picked.word, picked.group,
                pool=word_packs().words(picked.pack),
                limit=impostor.BOARD_SIZE)
        rnd = impostor.assign_roles(
            game.players, pack=picked.pack, word=picked.word,
            impostors=game.impostors, show_category=game.show_category,
            decoy=picked.decoy, blind=game.blind, candidates=candidates,
            show_words=game.wordlist, allow_guess=game.guessing)
    except (WordPackError, RoundError) as e:
        await interaction.followup.send(f"Cannot deal: {e}", ephemeral=True)
        return

    if game.delivery == DELIVERY_BUTTON:
        # Nothing to send: every player pulls their own copy from the round
        # message, so there is no delivery step that can fail for some of them.
        running = _store(dataclasses.replace(game, round=rnd))
        await _show_round(interaction, running)
        await interaction.followup.send(
            f"✅ Dealt — press **See my word** above. {len(rnd.player_ids)} "
            f"players, {len(rnd.impostor_ids)} impostor"
            f"{'s' if len(rnd.impostor_ids) != 1 else ''}.",
            allowed_mentions=NO_MENTIONS)
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
            "members**, then the host presses **Deal** again — or start the "
            "next round without `delivery:dm`, which needs no DMs at all.",
            allowed_mentions=NO_MENTIONS)
        return

    running = _store(dataclasses.replace(game, round=rnd))
    await _show_round(interaction, running)
    await interaction.followup.send(
        f"✅ Dealt — check your DMs. {len(rnd.player_ids)} players, "
        f"{len(rnd.impostor_ids)} impostor"
        f"{'s' if len(rnd.impostor_ids) != 1 else ''}.",
        allowed_mentions=NO_MENTIONS)


async def _refresh_lobby(interaction: discord.Interaction,
                         game: Game | None) -> None:
    """Rewrite the lobby message to match `game` (or retire it when None).

    A dealt round goes through _show_round instead: it has buttons to keep
    alive, so it cannot be allowed to fail quietly the way a lobby edit can.
    """
    view = LobbyView.active.get(interaction.channel_id)
    if view is None or view.message is None:
        return
    try:
        if game is None:
            view.stop()
            LobbyView.active.pop(interaction.channel_id, None)
            await view.message.edit(content="🕵️ **Impostor** — lobby closed.",
                                    view=None, allowed_mentions=NO_MENTIONS)
        else:
            await view.message.edit(content=_lobby_text(game), view=view,
                                    allowed_mentions=NO_MENTIONS)
    except discord.HTTPException as e:
        # The lobby message was deleted, or Discord hiccuped. Game state is
        # still authoritative, and /impostor status can show it.
        print(f"impostor: lobby edit failed: {type(e).__name__}: {e}",
              file=sys.stderr)


async def _show_round(interaction: discord.Interaction, game: Game) -> None:
    """Put the dealt round on screen with its buttons, come what may.

    In ephemeral delivery those buttons are the ONLY way a player reads their
    word, so this must not depend on the lobby message still being editable.
    If the lobby message is gone -- deleted by a moderator, or its view
    dropped by a timeout -- a fresh round message is posted instead of
    silently leaving a live round with nothing to press.
    """
    round_view = RoundView(interaction.channel_id,
                           guessing=(game.round is not None
                                     and game.round.guessing_allowed),
                           word_button=game.delivery == DELIVERY_BUTTON,
                           voting=game.voting)
    if not round_view.children:
        round_view = None      # DM delivery, no voting, no guessing
    text = _round_text(game)

    lobby = LobbyView.active.pop(interaction.channel_id, None)
    if lobby is not None:
        lobby.stop()

    message = None
    if lobby is not None and lobby.message is not None:
        try:
            await lobby.message.edit(content=text, view=round_view,
                                     allowed_mentions=NO_MENTIONS)
            message = lobby.message
        except discord.HTTPException as e:
            print(f"impostor: lobby->round edit failed, posting fresh: "
                  f"{type(e).__name__}: {e}", file=sys.stderr)

    if message is None:
        try:
            message = await interaction.followup.send(
                text, view=round_view, wait=True,
                allowed_mentions=NO_MENTIONS)
        except discord.HTTPException as e:
            # Nothing left to try. The round is dealt and still readable with
            # /impostor myword, so say that rather than dying silently.
            print(f"impostor: could not post the round message: "
                  f"{type(e).__name__}: {e}", file=sys.stderr)
            return

    if round_view is not None:
        round_view.message = message
        RoundView.active[interaction.channel_id] = round_view


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
        await _retire_vote_view(self.channel_id,
                                "🗳️ Vote abandoned — the impostor guessed "
                                "instead.")
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
    """The buttons on a live round's message.

    "See my word" is what makes ephemeral delivery possible at all: a bot
    cannot push an ephemeral message at somebody, because ephemeral only
    exists as a reply to that person's own interaction. So the round posts one
    button and each player presses it for their own private copy. Unlike a DM
    it cannot be blocked by their privacy settings, and pressing again
    re-sends it.
    """

    active: dict[int, "RoundView"] = {}

    def __init__(self, channel_id: int, guessing: bool = True,
                 word_button: bool = True, voting: bool = True):
        super().__init__(timeout=ROUND_TIMEOUT_SECONDS)
        self.channel_id = channel_id
        self.message: discord.Message | None = None
        if not word_button:
            self.remove_item(self.word)
        if not voting:
            self.remove_item(self.call_vote)
        if not guessing:
            self.remove_item(self.guess)

    async def on_timeout(self) -> None:
        RoundView.active.pop(self.channel_id, None)

    @discord.ui.button(label="See my word", emoji="🔍",
                       style=discord.ButtonStyle.primary)
    async def word(self, interaction: discord.Interaction,
                   button: discord.ui.Button):
        game = _games.get(self.channel_id)
        if game is None or game.round is None:
            await interaction.response.send_message("That round is over.",
                                                    ephemeral=True)
            return
        try:
            text = impostor.role_message(game.round, interaction.user.id)
        except RoundError:
            await interaction.response.send_message(
                "You are not in this round.", ephemeral=True)
            return
        # ephemeral=True: "Only you can see this message".
        await interaction.response.send_message(text, ephemeral=True,
                                                allowed_mentions=NO_MENTIONS)

    @discord.ui.button(label="Call a vote", emoji="🗳️",
                       style=discord.ButtonStyle.secondary)
    async def call_vote(self, interaction: discord.Interaction,
                        button: discord.ui.Button):
        game = _games.get(self.channel_id)
        if game is None or game.round is None:
            await interaction.response.send_message("That round is over.",
                                                    ephemeral=True)
            return
        if game.vote is not None:
            await interaction.response.send_message(
                "A vote is already running — cast yours on it.",
                ephemeral=True)
            return
        if not impostor.may_call_vote(game.round, interaction.user.id):
            # The impostor is refused so they cannot force a vote before the
            # crew have anything to go on. They already know their own role,
            # so saying why leaks nothing -- except in a blind round, where
            # may_call_vote lets everybody through for exactly that reason.
            await interaction.response.send_message(
                "Only the crew can call a vote." if interaction.user.id
                in game.round.player_ids else "You are not in this round.",
                ephemeral=True)
            return

        _store(dataclasses.replace(game, vote=impostor.Vote()))
        view = VoteView(self.channel_id)
        await interaction.response.send_message(
            _vote_text(_games[self.channel_id]), view=view,
            allowed_mentions=NO_MENTIONS)
        view.message = await interaction.original_response()
        VoteView.active[self.channel_id] = view

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


class BallotSelect(discord.ui.Select):
    """One player's private ballot."""

    def __init__(self, channel_id: int, names: dict[int, str],
                 candidates: tuple[int, ...]):
        super().__init__(
            placeholder="Who is the impostor?", min_values=1, max_values=1,
            options=[discord.SelectOption(label=names.get(uid, str(uid)),
                                          value=str(uid))
                     for uid in candidates[:MAX_SELECT_OPTIONS]])
        self.channel_id = channel_id

    async def callback(self, interaction: discord.Interaction):
        game = _games.get(self.channel_id)
        if game is None or game.round is None or game.vote is None:
            await interaction.response.edit_message(
                content="That vote is already closed.", view=None)
            return
        try:
            vote = game.vote.cast(game.round, interaction.user.id,
                                  int(self.values[0]))
        except RoundError as e:
            await interaction.response.edit_message(content=str(e), view=None)
            return

        game = _store(dataclasses.replace(game, vote=vote))
        await interaction.response.edit_message(
            content=f"Vote recorded: <@{self.values[0]}>. You can change it "
                    "until the vote closes.", view=None)
        await _refresh_vote(self.channel_id)
        if vote.is_complete(game.round):
            await _close_vote(self.channel_id)


class BallotView(discord.ui.View):
    """Ephemeral wrapper around one BallotSelect."""

    def __init__(self, channel_id: int, names: dict[int, str],
                 candidates: tuple[int, ...]):
        super().__init__(timeout=VOTE_TIMEOUT_SECONDS)
        self.add_item(BallotSelect(channel_id, names, candidates))


class VoteView(discord.ui.View):
    """The public vote message: a button each player presses to cast."""

    active: dict[int, "VoteView"] = {}

    def __init__(self, channel_id: int):
        super().__init__(timeout=VOTE_TIMEOUT_SECONDS)
        self.channel_id = channel_id
        self.message: discord.Message | None = None

    async def on_timeout(self) -> None:
        # Close on whatever came in; an AFK player must not stall the round
        # forever. Too few votes simply tallies as inconclusive.
        await _close_vote(self.channel_id, timed_out=True)

    @discord.ui.button(label="Cast my vote", emoji="🗳️",
                       style=discord.ButtonStyle.primary)
    async def cast(self, interaction: discord.Interaction,
                   button: discord.ui.Button):
        game = _games.get(self.channel_id)
        if game is None or game.round is None or game.vote is None:
            await interaction.response.send_message("That vote is closed.",
                                                    ephemeral=True)
            return
        rnd = game.round
        if interaction.user.id not in rnd.player_ids:
            await interaction.response.send_message(
                "You are not in this round.", ephemeral=True)
            return

        candidates = impostor.vote_candidates(rnd, interaction.user.id)
        names = await _display_names(interaction.guild, candidates)
        await interaction.response.send_message(
            "Pick who you think has the odd word out.",
            view=BallotView(self.channel_id, names, candidates),
            ephemeral=True)


async def _display_names(guild: discord.Guild | None,
                         user_ids: tuple[int, ...]) -> dict[int, str]:
    """Names for a select menu, which cannot render a <@id> mention."""
    names: dict[int, str] = {}
    for uid in user_ids:
        member = guild.get_member(uid) if guild else None
        names[uid] = member.display_name if member else f"User {uid}"
    return names


async def _refresh_vote(channel_id: int) -> None:
    """Rewrite the public vote message with the current turnout."""
    view = VoteView.active.get(channel_id)
    game = _games.get(channel_id)
    if view is None or view.message is None or game is None:
        return
    try:
        await view.message.edit(content=_vote_text(game), view=view,
                                allowed_mentions=NO_MENTIONS)
    except discord.HTTPException as e:
        print(f"impostor: vote refresh failed: {type(e).__name__}: {e}",
              file=sys.stderr)


async def _close_vote(channel_id: int, timed_out: bool = False) -> None:
    """Tally the ballots and end the round, or reopen play if inconclusive."""
    view = VoteView.active.pop(channel_id, None)
    game = _games.get(channel_id)
    if view is not None:
        view.stop()
    if game is None or game.round is None or game.vote is None:
        return

    rnd, outcome = game.round, game.vote.outcome(game.round)
    closing = "⏱️ Vote timed out." if timed_out else "🗳️ Vote closed."

    if not outcome.is_conclusive:
        # Nobody ejected: put the round back the way it was so the crew can
        # talk it over and call another vote.
        _store(dataclasses.replace(game, vote=None))
        reason = (f"tie between {_mentions(outcome.tied)}"
                  if outcome.tied else "nobody voted")
        body = (f"{closing} **No ejection** — {reason}. The round carries on; "
                "call another vote when you are ready.")
        await _edit_vote_message(view, body)
        return

    _clear(channel_id)
    await _retire_round_view(channel_id)
    tally = ", ".join(f"<@{uid}> ×{n}" for uid, n in
                      sorted(game.vote.counts().items(), key=lambda kv: -kv[1]))
    if outcome.crew_won:
        body = (f"{closing} **<@{outcome.ejected}> was the impostor — crew "
                f"win.**\nThe word was **{rnd.word}** (`{rnd.pack}`).\n"
                f"Crew: {_mentions(rnd.crew_ids)}\nVotes: {tally}")
    else:
        body = (f"{closing} **<@{outcome.ejected}> was innocent — impostor"
                f"{'s' if len(rnd.impostor_ids) != 1 else ''} win.**\n"
                f"The word was **{rnd.word}** (`{rnd.pack}`) and the "
                f"impostor{'s' if len(rnd.impostor_ids) != 1 else ''} "
                f"{'were' if len(rnd.impostor_ids) != 1 else 'was'} "
                f"{_mentions(rnd.impostor_ids)}.\nVotes: {tally}")
    await _edit_vote_message(view, body)


async def _retire_vote_view(channel_id: int, text: str) -> None:
    """Kill an open vote because the round ended some other way."""
    view = VoteView.active.pop(channel_id, None)
    if view is None:
        return
    view.stop()
    await _edit_vote_message(view, text)


async def _edit_vote_message(view: "VoteView | None", body: str) -> None:
    if view is None or view.message is None:
        return
    try:
        await view.message.edit(content=body, view=None,
                                allowed_mentions=NO_MENTIONS)
    except discord.HTTPException as e:
        print(f"impostor: vote close failed: {type(e).__name__}: {e}",
              file=sys.stderr)


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


