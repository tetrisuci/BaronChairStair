"""
impostor_vote.py
~~~~~~~~~~~~~~~~
The voting round: the public tally message, and each player's private ballot.

Split out of impostor_views.py, which was carrying six concerns at once. The
crew open a vote from the round message (impostor_views.RoundView), everyone
casts privately here, and closing it either ends the round or hands play back.

Depends on impostor_views one way only -- views imports this module, not the
reverse -- except inside _close_vote, which needs the round-ending helpers
that live over there. See the note at that import.
"""

from __future__ import annotations

import dataclasses
import sys

import discord

import impostor
from impostor import RoundError
from impostor_game import (
    MAX_SELECT_OPTIONS, NO_MENTIONS, VOTE_TIMEOUT_SECONDS, _clear, _games,
    _store, _vote_text,
)


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

    # Imported here rather than at module scope: a round owns its votes and a
    # vote can end its round, so the two modules genuinely point at each
    # other. Deferring the half that runs once per closed vote keeps the
    # import graph one-way (views -> vote) everywhere else.
    from impostor_views import _play_again, _retire_round_view

    _clear(channel_id)
    await _retire_round_view(channel_id)
    rematch = _play_again(dataclasses.replace(game, round=None, vote=None))
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
    await _edit_vote_message(view, body, replacement=rematch)


async def _retire_vote_view(channel_id: int, text: str) -> None:
    """Kill an open vote because the round ended some other way."""
    view = VoteView.active.pop(channel_id, None)
    if view is None:
        return
    view.stop()
    await _edit_vote_message(view, text)


async def _edit_vote_message(view: "VoteView | None", body: str,
                             replacement: discord.ui.View | None = None) -> None:
    if view is None or view.message is None:
        return
    from impostor_views import PlayAgainView   # see the note in _close_vote
    if isinstance(replacement, PlayAgainView):
        replacement.message = view.message  # so its timeout can clear it
    try:
        await view.message.edit(content=body, view=replacement,
                                allowed_mentions=NO_MENTIONS)
    except discord.HTTPException as e:
        print(f"impostor: vote close failed: {type(e).__name__}: {e}",
              file=sys.stderr)


