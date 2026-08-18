"""
impostor_commands.py
~~~~~~~~~~~~~~~~~~~~
The /impostor slash commands.

The game is split four ways so no one file carries all of it:
    impostor.py         rules and word storage, no discord import (tested)
    impostor_game.py    lobby state, message text, DM delivery
    impostor_views.py   buttons, the guess dropdown, dealing
    impostor_commands.py (this file) the slash commands themselves

Playing:
    /impostor start [pack] [impostors] [category] [decoy] [blind] [guessing]
                                   open a lobby; players press Join, host
                                   presses Deal and everyone is DM'd.
                                   pack: which word pack to draw from
                                   decoy (default on): the impostor gets a
                                     word from the SAME group as the crew's --
                                     "T-spin double" vs "T-spin triple" -- so
                                     they can bluff instead of sitting mute
                                   blind: do not tell the impostor they are
                                     it; they hold a word like everyone else
                                     and have to work out that theirs is odd
                                   guessing (default on): the impostor may
                                     end the round early by picking the crew's
                                     word from a dropdown -- right, they win;
                                     wrong, the crew do. Needs groups of 3+
                                     (see impostor.MIN_GUESS_GROUP) and cannot
                                     be combined with blind, because pressing
                                     the button would out them to themselves
    /impostor myword               re-send your own word privately (ephemeral)
    /impostor status               who is in, and whether a round is running
    /impostor reveal               end the round, announce word + impostors
    /impostor cancel               scrap the lobby/round without revealing

Words (needs Manage Server, since the packs are shared by every guild the bot
is in):
    /impostor words list [pack]    packs and their sizes, or one pack's groups
    /impostor words add <pack> <words>      commas = one group of similar
                                            words; \n starts another group
    /impostor words remove <pack> <words>
    /impostor words deletepack <pack>

Words live in groups of similar terms, because the impostor is handed a
near-miss from the same group. `add` merges into an existing group when they
share a word, so extending a group needs no hand-editing.

The word file itself is data/impostor_words.json (override with
IMPOSTOR_WORDS_PATH); hand edits are picked up automatically.

One game at a time per channel. State is in memory only: a restart drops
lobbies and in-flight rounds, which is fine -- a round is a few minutes long
and players still have their DMs.
"""

from __future__ import annotations

import discord
from discord import app_commands

import impostor
from impostor import WordPackError
from impostor_game import (
    AUTOCOMPLETE_LIMIT, MESSAGE_LIMIT, NO_MENTIONS, Game, _clear, _games,
    _lobby_text, _may_edit_words, _may_manage_game, _mentions, _round_text,
    _store, word_packs,
)
from impostor_views import LobbyView, _retire_round_view

# ── Command group ─────────────────────────────────────────────────────────────

impostor_group = app_commands.Group(
    name="impostor",
    description="Impostor word game — everyone gets a word except the impostor")


async def _pack_autocomplete(interaction: discord.Interaction, current: str
                             ) -> list[app_commands.Choice[str]]:
    try:
        counts = word_packs().counts()
    except WordPackError:
        return []                 # a broken file is reported by the command
    needle = current.casefold()
    return [app_commands.Choice(
                name=f"{name} ({st.words} words, {st.guess_groups} groups)",
                value=name)
            for name, st in counts.items()
            if needle in name.casefold()][:AUTOCOMPLETE_LIMIT]


@impostor_group.command(
    name="start",
    description="Open an Impostor lobby; everyone is DM'd a word except the impostor.")
@app_commands.describe(
    pack="Word pack to draw from (default: any pack)",
    impostors="How many impostors (default: scales with player count)",
    category="Tell everyone which pack the word came from (default: yes)",
    decoy="Give the impostor a similar word instead of nothing (default: yes)",
    blind="Do not tell the impostor they are it — they must work it out",
    guessing="Let the impostor guess the crew's word early to win (default: yes)",
)
@app_commands.autocomplete(pack=_pack_autocomplete)
async def impostor_start(
    interaction: discord.Interaction,
    pack: str | None = None,
    impostors: app_commands.Range[int, 1, 5] | None = None,
    category: bool = True,
    decoy: bool = True,
    blind: bool = False,
    guessing: bool = True,
):
    if interaction.guild is None:
        await interaction.response.send_message(
            "Impostor needs a server — a DM has nobody to play with.",
            ephemeral=True)
        return

    existing = _games.get(interaction.channel_id)
    if existing is not None:
        what = "round" if existing.is_running else "lobby"
        await interaction.response.send_message(
            f"There is already an Impostor {what} in this channel — "
            f"`/impostor cancel` (or `/impostor reveal`) to end it first.",
            ephemeral=True)
        return

    if blind and not decoy:
        # Blind with no decoy leaves the impostor holding nothing at all.
        await interaction.response.send_message(
            "`blind:true` needs `decoy:true` — a blind impostor has to be "
            "holding a word, or they have nothing to play with.",
            ephemeral=True)
        return
    if blind and guessing:
        # Pressing Guess would tell the impostor which side they are on.
        await interaction.response.send_message(
            "`blind:true` cannot be combined with `guessing:true` — the guess "
            "button would tell the impostor they are the impostor. Pick one.",
            ephemeral=True)
        return

    # Draw a throwaway word now, so a pack that cannot support this round is
    # caught where the host can fix it rather than after everyone has joined.
    try:
        word_packs().pick(pack, decoy=decoy,
                          min_group=impostor.MIN_GUESS_GROUP if guessing else 1)
    except WordPackError as e:
        await interaction.response.send_message(
            f"{e}\nSee `/impostor words list` for what exists.",
            ephemeral=True)
        return

    game = _store(Game(channel_id=interaction.channel_id,
                       host_id=interaction.user.id,
                       pack=impostor.normalize_pack_name(pack) if pack else None,
                       impostors=impostors,
                       show_category=category,
                       players=(interaction.user.id,),
                       decoy=decoy,
                       blind=blind,
                       guessing=guessing))

    view = LobbyView(interaction.channel_id)
    await interaction.response.send_message(_lobby_text(game), view=view,
                                            allowed_mentions=NO_MENTIONS)
    view.message = await interaction.original_response()
    LobbyView.active[interaction.channel_id] = view


@impostor_group.command(
    name="myword",
    description="Privately re-send your word (or your impostor role).")
async def impostor_myword(interaction: discord.Interaction):
    game = _games.get(interaction.channel_id)
    if game is None or game.round is None:
        await interaction.response.send_message(
            "No round is running in this channel.", ephemeral=True)
        return
    try:
        text = impostor.role_message(game.round, interaction.user.id)
    except RoundError:
        await interaction.response.send_message("You are not in this round.",
                                                ephemeral=True)
        return
    await interaction.response.send_message(text, ephemeral=True,
                                            allowed_mentions=NO_MENTIONS)


@impostor_group.command(name="status",
                        description="Show the Impostor game in this channel.")
async def impostor_status(interaction: discord.Interaction):
    game = _games.get(interaction.channel_id)
    if game is None:
        await interaction.response.send_message(
            "No Impostor game here — start one with `/impostor start`.",
            ephemeral=True)
        return
    text = _round_text(game) if game.is_running else _lobby_text(game)
    await interaction.response.send_message(text, ephemeral=True,
                                            allowed_mentions=NO_MENTIONS)


@impostor_group.command(
    name="reveal",
    description="End the round and reveal the word and the impostors.")
async def impostor_reveal(interaction: discord.Interaction):
    game = _games.get(interaction.channel_id)
    if game is None or game.round is None:
        await interaction.response.send_message(
            "No round is running in this channel.", ephemeral=True)
        return
    if not _may_manage_game(interaction, game):
        await interaction.response.send_message(
            f"Only the host (<@{game.host_id}>) can reveal.", ephemeral=True,
            allowed_mentions=NO_MENTIONS)
        return

    rnd = game.round
    _clear(interaction.channel_id)
    await _retire_round_view(interaction.channel_id)
    plural = "s" if len(rnd.impostor_ids) != 1 else ""
    was = "were" if len(rnd.impostor_ids) != 1 else "was"
    decoy = (f"The impostor{plural} had **{rnd.decoy}** instead.\n"
             if rnd.decoy else "")
    await interaction.response.send_message(
        f"🕵️ **Reveal** — the word was **{rnd.word}** (`{rnd.pack}`).\n"
        f"{decoy}"
        f"The impostor{plural} {was}: {_mentions(rnd.impostor_ids)}\n"
        f"Crew: {_mentions(rnd.crew_ids)}",
        allowed_mentions=NO_MENTIONS)


@impostor_group.command(name="cancel",
                        description="Scrap the lobby or round without revealing.")
async def impostor_cancel(interaction: discord.Interaction):
    game = _games.get(interaction.channel_id)
    if game is None:
        await interaction.response.send_message("No Impostor game here.",
                                                ephemeral=True)
        return
    if not _may_manage_game(interaction, game):
        await interaction.response.send_message(
            f"Only the host (<@{game.host_id}>) can cancel.", ephemeral=True,
            allowed_mentions=NO_MENTIONS)
        return

    _clear(interaction.channel_id)
    await _retire_round_view(interaction.channel_id,
                             "🕵️ **Impostor** — cancelled.")
    view = LobbyView.active.pop(interaction.channel_id, None)
    if view is not None:
        view.stop()
        if view.message is not None:
            try:
                await view.message.edit(content="🕵️ **Impostor** — cancelled.",
                                        view=None)
            except discord.HTTPException:
                pass
    await interaction.response.send_message(
        f"🛑 Impostor game cancelled by <@{interaction.user.id}>.",
        allowed_mentions=NO_MENTIONS)


# ── Word maintenance ──────────────────────────────────────────────────────────

words_group = app_commands.Group(
    name="words", description="Add, remove and inspect Impostor word packs",
    parent=impostor_group)


def _chunk(lines: list[str], limit: int = MESSAGE_LIMIT) -> list[str]:
    """Group lines into messages that stay under Discord's length limit."""
    chunks: list[str] = []
    current = ""
    for line in lines:
        if current and len(current) + len(line) + 1 > limit:
            chunks.append(current)
            current = line
        else:
            current = f"{current}\n{line}" if current else line
    if current:
        chunks.append(current)
    return chunks


def _group_lines(groups: tuple[tuple[str, ...], ...]) -> list[str]:
    """One line per group, so the similar-word sets are visible at a glance.

    A solo group is flagged: it can never be drawn in a decoy round, and that
    is exactly the thing a maintainer wants to spot in a listing.
    """
    lines = []
    for group in sorted(groups, key=lambda g: g[0].casefold()):
        joined = " / ".join(group)
        if len(group) >= impostor.MIN_GUESS_GROUP:
            note = ""
        elif len(group) >= impostor.MIN_DECOY_GROUP:
            note = "  ⚠️ too small for guessing"
        else:
            note = "  ⚠️ no decoy"
        lines.append(f"• {joined}{note}")
    return lines


def _pack_footer(pack: str) -> str:
    """One line of "where the pack stands now", after an edit."""
    try:
        stats = impostor.group_stats(word_packs().groups(pack))
    except WordPackError:
        return ""               # pack vanished under us; the counts above stand
    return (f"_`{pack}` now holds {stats.words} words in {stats.groups} "
            f"group{'s' if stats.groups != 1 else ''} "
            f"({stats.decoy_groups} decoy-ready, "
            f"{stats.guess_groups} guess-ready)._")


def _preview(items: tuple[str, ...], limit: int = 15) -> str:
    shown = ", ".join(f"`{w}`" for w in items[:limit])
    return shown + (f" …and {len(items) - limit} more"
                    if len(items) > limit else "")


@words_group.command(name="list",
                     description="List word packs, or the words in one pack.")
@app_commands.describe(pack="Pack to spell out (default: just the pack names)")
@app_commands.autocomplete(pack=_pack_autocomplete)
async def words_list(interaction: discord.Interaction, pack: str | None = None):
    # Ephemeral throughout, so a listing never dumps the word pool into a live
    # game.
    try:
        if pack is None:
            counts = word_packs().counts()
            if not counts:
                await interaction.response.send_message(
                    "No word packs yet — add one with "
                    "`/impostor words add pack:animals words:cat, dog`.",
                    ephemeral=True)
                return
            total = sum(st.words for st in counts.values())
            lines = [f"**Word packs** ({total} words total)"]
            lines += [f"• `{name}` — {st.words} words in {st.groups} group"
                      f"{'s' if st.groups != 1 else ''} "
                      f"({st.decoy_groups} decoy-ready, "
                      f"{st.guess_groups} guess-ready)"
                      for name, st in counts.items()]
            lines.append(f"_File: `{word_packs().path}`_")
            body = _chunk(lines)
        else:
            groups = word_packs().groups(pack)
            stats = impostor.group_stats(groups)
            header = (f"**`{impostor.normalize_pack_name(pack)}`** — "
                      f"{stats.words} words in {stats.groups} group"
                      f"{'s' if stats.groups != 1 else ''} "
                      f"({stats.decoy_groups} decoy-ready, "
                      f"{stats.guess_groups} guess-ready)")
            body = _chunk([header] + _group_lines(groups))
    except WordPackError as e:
        await interaction.response.send_message(str(e), ephemeral=True)
        return

    await interaction.response.send_message(body[0], ephemeral=True)
    for chunk in body[1:]:
        await interaction.followup.send(chunk, ephemeral=True)


@words_group.command(
    name="add",
    description="Add a group of similar words to a pack (commas = same group).")
@app_commands.describe(
    pack="Pack to add to — a new name creates the pack",
    words=("Similar words, comma-separated: `T-spin double, T-spin triple`. "
           "Use \\n between groups to add several at once."),
)
@app_commands.autocomplete(pack=_pack_autocomplete)
async def words_add(interaction: discord.Interaction, pack: str, words: str):
    if not _may_edit_words(interaction):
        await interaction.response.send_message(
            "Editing word packs needs the **Manage Server** permission — "
            "the packs are shared by every server this bot is in.",
            ephemeral=True)
        return

    # A literal "\n" typed into a Discord option is two characters, not a
    # newline, so accept both as a group separator.
    candidates = impostor.parse_groups(words.replace("\\n", "\n"))
    if not candidates:
        await interaction.response.send_message(
            "Nothing to add — comma-separate words that belong in the same "
            "group, e.g. `words: T-spin double, T-spin triple`.",
            ephemeral=True)
        return

    try:
        result = word_packs().add(pack, candidates)
    except WordPackError as e:
        await interaction.response.send_message(str(e), ephemeral=True)
        return

    lines = []
    if result.added:
        created = " (new pack)" if result.pack_created else ""
        lines.append(f"✅ Added **{len(result.added)}** word"
                     f"{'s' if len(result.added) != 1 else ''} to "
                     f"`{result.pack}`{created}: {_preview(result.added)}")
    else:
        lines.append(f"Nothing added to `{result.pack}`.")
    for group in result.merged:
        lines.append(f"🔗 Merged into an existing group: "
                     f"{' / '.join(group)}")
    if result.duplicates:
        lines.append(f"↩️ Already there ({len(result.duplicates)}): "
                     f"{_preview(result.duplicates)}")
    if result.invalid:
        lines.append(f"⚠️ Skipped ({len(result.invalid)}) — blank or over "
                     f"{impostor.MAX_WORD_LENGTH} characters: "
                     f"{_preview(result.invalid)}")
    lines.append(_pack_footer(result.pack))

    await interaction.response.send_message("\n".join(lines), ephemeral=True)


@words_group.command(
    name="remove",
    description="Remove words from a pack (comma or newline separated).")
@app_commands.describe(pack="Pack to remove from",
                       words="Words, separated by commas, semicolons or newlines")
@app_commands.autocomplete(pack=_pack_autocomplete)
async def words_remove(interaction: discord.Interaction, pack: str, words: str):
    if not _may_edit_words(interaction):
        await interaction.response.send_message(
            "Editing word packs needs the **Manage Server** permission.",
            ephemeral=True)
        return

    candidates = impostor.parse_words(words)
    if not candidates:
        await interaction.response.send_message(
            "Nothing to remove — pass words separated by commas.",
            ephemeral=True)
        return

    try:
        result = word_packs().remove(pack, candidates)
    except WordPackError as e:
        await interaction.response.send_message(str(e), ephemeral=True)
        return

    lines = []
    if result.removed:
        lines.append(f"🗑️ Removed **{len(result.removed)}** word"
                     f"{'s' if len(result.removed) != 1 else ''} from "
                     f"`{result.pack}`: {_preview(result.removed)}")
    else:
        lines.append(f"Nothing removed from `{result.pack}`.")
    if result.missing:
        lines.append(f"❓ Not in the pack ({len(result.missing)}): "
                     f"{_preview(result.missing)}")
    if result.pack_deleted:
        lines.append(f"_`{result.pack}` is now empty and was dropped._")
    else:
        lines.append(_pack_footer(result.pack))

    await interaction.response.send_message("\n".join(lines), ephemeral=True)


@words_group.command(name="deletepack",
                     description="Delete a whole word pack.")
@app_commands.describe(pack="Pack to delete, words and all")
@app_commands.autocomplete(pack=_pack_autocomplete)
async def words_deletepack(interaction: discord.Interaction, pack: str):
    if not _may_edit_words(interaction):
        await interaction.response.send_message(
            "Deleting word packs needs the **Manage Server** permission.",
            ephemeral=True)
        return
    try:
        size = word_packs().delete_pack(pack)
    except WordPackError as e:
        await interaction.response.send_message(str(e), ephemeral=True)
        return
    await interaction.response.send_message(
        f"🗑️ Deleted `{impostor.normalize_pack_name(pack)}` and its "
        f"{size} word{'s' if size != 1 else ''}.", ephemeral=True)
