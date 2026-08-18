"""
impostor_commands.py
~~~~~~~~~~~~~~~~~~~~
The /impostor slash commands.

The game is split four ways so no one file carries all of it:
    impostor.py         round rules, no discord import (tested)
    impostor_words.py   the word file: packs, groups, ownership (tested)
    impostor_game.py    lobby state, message text, DM delivery
    impostor_views.py   buttons, the guess dropdown, dealing
    impostor_vote.py    the voting round and its tally
    impostor_help.py    the /impostor help text, also discord-free
    impostor_commands.py (this file) the slash commands themselves

Playing:
    /impostor start [players] [delivery] [pack] [impostors] [category]
                    [decoy] [blind] [guessing] [voting] [wordlist]
                                   open a lobby; players press Join, host
                                   presses Deal and everyone is DM'd.
                                   players: @mention the roster up front
                                     instead of waiting for Join. Bots and
                                     non-members are dropped with a note, and
                                     the list is taken verbatim -- a host who
                                     leaves themselves out runs the game
                                     without playing. Join/Leave still work.
                                   delivery (default in-channel): each
                                     player presses **See my word** for an
                                     ephemeral copy. A bot cannot push an
                                     ephemeral message at anybody -- it only
                                     exists as a reply to that person's own
                                     interaction -- so the button is how it is
                                     done. delivery:dm pushes instead, but
                                     only reaches players who accept DMs.
                                   voting (default on): the crew get a **Call
                                     a vote** button. Everyone votes, impostor
                                     included; eject the impostor and the crew
                                     win, eject a crewmate and they lose. A
                                     tie or an empty vote ejects nobody and
                                     the round carries on.
                                   wordlist (default on): post the board of
                                     possible words for everyone to read. It
                                     is the SAME list the impostor guesses
                                     from, so the two can never disagree; see
                                     impostor.BOARD_SIZE.
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
    /impostor help [topic] [share]
                                   how to play / round options / word upkeep.
                                   Text lives in impostor_help.py and reads
                                   its numbers off the constants, so it cannot
                                   drift from the rules.
    /impostor myword               re-send your own word privately (ephemeral)
    /impostor status               who is in, and whether a round is running
    /impostor reveal               end the round, announce word + impostors
    /impostor cancel               scrap the lobby/round without revealing

Words. `scope:server` (default) edits the shared packs and needs Manage
Server, since every guild the bot is in reads the same file. `scope:mine`
edits your own pack instead: no permission needed, and only you can
/impostor start with it.
    /impostor words list [pack]    packs and their sizes, or one pack's groups
    /impostor words add <pack> <words>      commas = one group of similar
                                            words; \n starts another group
    /impostor words remove <pack> <words>
    /impostor words deletepack <pack>
    /impostor words import <pack> <file>    bulk add from an uploaded .txt
                                            or .json

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

import dataclasses
import sys

import discord
from discord import app_commands

import impostor
from impostor import WordPackError
import impostor_help
from impostor_game import (
    AUTOCOMPLETE_LIMIT, DELIVERY_BUTTON, DELIVERY_DM, LOBBY_TIMEOUT_SECONDS,
    MESSAGE_LIMIT, NO_MENTIONS, VOTE_TIMEOUT_SECONDS, Game, _clear, _games,
    _lobby_text, _may_edit_words, _may_manage_game, _mentions,
    _resolve_members, _round_text, _store, word_packs,
)
from impostor_views import (
    LobbyView, PlayAgainView, _retire_round_view, _retire_vote_view,
    open_lobby,
)

# ── Command group ─────────────────────────────────────────────────────────────

impostor_group = app_commands.Group(
    name="impostor",
    description="Impostor word game — everyone gets a word except the impostor")


SCOPE_SERVER = "server"
SCOPE_MINE = "mine"

_SCOPE_CHOICES = [
    app_commands.Choice(name="Server pack — everyone, needs Manage Server",
                        value=SCOPE_SERVER),
    app_commands.Choice(name="My pack — only you can edit or play it",
                        value=SCOPE_MINE),
]


def _target_ref(interaction: discord.Interaction, pack: str,
                scope: str) -> impostor.PackRef:
    """Which pack an edit is aimed at.

    A pack chosen from autocomplete carries which one it is, and that wins
    over `scope`: the picker said "memes (yours)", and scope defaults to
    server, so trusting scope would point a delete at the shared pack the user
    never selected. A typed bare name has no such information, and there scope
    decides.
    """
    ref, explicit = impostor.parse_pack_selection(pack)
    if explicit:
        if ref.is_personal and ref.owner_id != interaction.user.id:
            raise WordPackError("That pack belongs to someone else.")
        return ref
    if scope == SCOPE_MINE:
        return impostor.PackRef(ref.name, interaction.user.id)
    return impostor.PackRef(ref.name)


def _guard_edit(interaction: discord.Interaction, pack: str,
                scope: str) -> "impostor.PackRef | str":
    """The pack this edit targets, or the reason it is refused."""
    try:
        ref = _target_ref(interaction, pack, scope)
    except WordPackError as e:
        return str(e)
    return _may_edit_ref(interaction, ref) or ref


def _may_edit_ref(interaction: discord.Interaction,
                  ref: impostor.PackRef) -> str | None:
    """None if the edit is allowed, else the reason it is not.

    Your own packs need no permission -- they only affect you. Shared packs
    need Manage Server, because every guild the bot is in reads the same file.
    """
    if ref.is_personal:
        if ref.owner_id != interaction.user.id:
            return "That pack belongs to someone else."
        return None
    if _may_edit_words(interaction):
        return None
    return ("Editing a server pack needs the **Manage Server** permission — "
            "the packs are shared by every server this bot is in.\n"
            "Use `scope:mine` to make your own pack instead: only you can "
            "edit it, and only you can start a round with it.")


async def _pack_autocomplete(interaction: discord.Interaction, current: str
                             ) -> list[app_commands.Choice[str]]:
    try:
        counts = word_packs().counts(interaction.user.id)
    except WordPackError:
        return []                 # a broken file is reported by the command
    needle = current.casefold()
    return [app_commands.Choice(
                name=f"{ref.label(interaction.user.id)} "
                     f"({st.words} words, {st.guess_groups} groups)",
                value=(ref.key if ref.is_personal
                       else impostor.SHARED_MARKER + ref.key))
            for ref, st in counts.items()
            if needle in ref.name.casefold()][:AUTOCOMPLETE_LIMIT]


@impostor_group.command(
    name="start",
    description="Open an Impostor lobby; everyone is DM'd a word except the impostor.")
@app_commands.choices(delivery=[
    app_commands.Choice(name="In channel — press a button, only you see it",
                        value=DELIVERY_BUTTON),
    app_commands.Choice(name="Direct message — pushed, needs DMs open",
                        value=DELIVERY_DM),
])
@app_commands.describe(
    players="@mention everyone playing (default: an open lobby people join)",
    delivery="How each player receives their word (default: in channel)",
    pack="Word pack to draw from (default: any pack)",
    impostors="How many impostors (default: scales with player count)",
    category="Tell everyone which pack the word came from (default: yes)",
    decoy="Give the impostor a similar word instead of nothing (default: yes)",
    blind="Do not tell the impostor they are it — they must work it out",
    guessing="Let the impostor guess the crew's word early to win (default: yes)",
    voting="Let the crew call a vote to eject someone (default: yes)",
    wordlist="Show everyone the list of possible words (default: yes)",
)
@app_commands.autocomplete(pack=_pack_autocomplete)
async def impostor_start(
    interaction: discord.Interaction,
    players: str | None = None,
    delivery: str = DELIVERY_BUTTON,
    pack: str | None = None,
    impostors: app_commands.Range[int, 1, 5] | None = None,
    category: bool = True,
    decoy: bool = True,
    blind: bool = False,
    guessing: bool = True,
    voting: bool = True,
    wordlist: bool = True,
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

    clash = _option_clash(decoy=decoy, blind=blind, guessing=guessing)
    if clash is not None:
        await interaction.response.send_message(clash, ephemeral=True)
        return

    # Resolve first: a personal pack belongs to one person, and only they may
    # start a round with it. Then draw a throwaway word, so a pack that cannot
    # support this round is caught where the host can fix it rather than after
    # everyone has joined.
    ref = None
    try:
        if pack is not None:
            ref = word_packs().resolve(pack, interaction.user.id)
        word_packs().pick(ref, decoy=decoy,
                          min_group=impostor.MIN_GUESS_GROUP if guessing else 1)
    except WordPackError as e:
        await interaction.response.send_message(
            f"{e}\nSee `/impostor words list` for what you can use.",
            ephemeral=True)
        return

    roster, complaint = ((interaction.user.id,), None) if players is None \
        else await _resolve_roster(interaction, players)
    if complaint is not None and not roster:
        await interaction.response.send_message(complaint, ephemeral=True,
                                                allowed_mentions=NO_MENTIONS)
        return

    game = Game(channel_id=interaction.channel_id,
                host_id=interaction.user.id,
                pack=ref,
                impostors=impostors,
                show_category=category,
                players=roster,
                decoy=decoy,
                blind=blind,
                guessing=guessing,
                delivery=delivery,
                voting=voting,
                wordlist=wordlist)

    await open_lobby(interaction, game)
    if complaint is not None:
        # The lobby stands; this only says who did not make it into it.
        await interaction.followup.send(complaint, ephemeral=True,
                                        allowed_mentions=NO_MENTIONS)


def _option_clash(*, decoy: bool, blind: bool, guessing: bool) -> str | None:
    """Which combinations of round options cannot coexist, and why.

    Kept out of the command body so the rule and its reason sit together --
    both of these are about `blind` leaking the impostor's own role back to
    them, which is the one thing blind mode exists to prevent.
    """
    if blind and not decoy:
        return ("`blind:true` needs `decoy:true` — a blind impostor has to be "
                "holding a word, or they have nothing to play with.")
    if blind and guessing:
        return ("`blind:true` cannot be combined with `guessing:true` — the "
                "guess button would tell the impostor they are the impostor. "
                "Pick one.")
    return None


async def _resolve_roster(interaction: discord.Interaction, players: str
                          ) -> tuple[tuple[int, ...], str | None]:
    """Turn a mention string into a player list, plus a note on who was cut.

    Returns the roster verbatim -- the host is not added silently. Someone
    running the game for other people is a real case, and the lobby message
    shows the roster before anyone deals, so an omission is visible rather
    than surprising.
    """
    wanted = impostor.parse_user_ids(players)
    if not wanted:
        return (), ("No players found in that — @mention them, e.g. "
                    "`players: @ana @ben @cleo`.")

    notes: list[str] = []
    if len(wanted) > impostor.MAX_PLAYERS:
        notes.append(f"⚠️ Only the first {impostor.MAX_PLAYERS} were taken — "
                     f"that is the round limit.")
        wanted = wanted[:impostor.MAX_PLAYERS]

    found, gone = await _resolve_members(interaction.guild, wanted)
    if gone:
        notes.append(f"⚠️ Not in this server: {_mentions(gone)}")

    # Bots cannot receive a DM from another bot, so they can never get a word.
    bots = tuple(uid for uid in wanted
                 if uid in found and found[uid].bot)
    if bots:
        notes.append(f"⚠️ Skipped bots (they cannot be DM'd): {_mentions(bots)}")

    roster = tuple(uid for uid in wanted if uid in found and uid not in bots)
    if not roster:
        notes.append("Nobody playable was left, so no lobby was opened.")
    return roster, ("\n".join(notes) if notes else None)


@impostor_group.command(name="help",
                        description="How Impostor works, and what the options do.")
@app_commands.choices(topic=[
    app_commands.Choice(name="How to play", value=impostor_help.TOPIC_PLAY),
    app_commands.Choice(name="Round options",
                        value=impostor_help.TOPIC_OPTIONS),
    app_commands.Choice(name="Managing words",
                        value=impostor_help.TOPIC_WORDS),
])
@app_commands.describe(
    topic="Which part to explain (default: how to play)",
    share="Post it in the channel for everyone (default: only you)",
)
async def impostor_help_command(interaction: discord.Interaction,
                                topic: str = impostor_help.TOPIC_PLAY,
                                share: bool = False):
    # Private by default so a "what are the rules again" mid-round does not
    # bury the board, but shareable, because explaining to a table is the
    # normal reason to open it.
    body = impostor_help.help_text(
        topic,
        lobby_minutes=LOBBY_TIMEOUT_SECONDS // 60,
        vote_minutes=VOTE_TIMEOUT_SECONDS // 60)
    chunks = _chunk(body.splitlines())
    await interaction.response.send_message(chunks[0], ephemeral=not share,
                                            allowed_mentions=NO_MENTIONS)
    for chunk in chunks[1:]:
        await interaction.followup.send(chunk, ephemeral=not share,
                                        allowed_mentions=NO_MENTIONS)


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
    await _retire_vote_view(interaction.channel_id,
                            "🗳️ Vote abandoned — the round was revealed.")
    plural = "s" if len(rnd.impostor_ids) != 1 else ""
    was = "were" if len(rnd.impostor_ids) != 1 else "was"
    decoy = (f"The impostor{plural} had **{rnd.decoy}** instead.\n"
             if rnd.decoy else "")
    rematch = PlayAgainView(dataclasses.replace(game, round=None, vote=None))
    await interaction.response.send_message(
        f"🕵️ **Reveal** — the word was **{rnd.word}** (`{rnd.pack}`).\n"
        f"{decoy}"
        f"The impostor{plural} {was}: {_mentions(rnd.impostor_ids)}\n"
        f"Crew: {_mentions(rnd.crew_ids)}",
        view=rematch, allowed_mentions=NO_MENTIONS)
    rematch.message = await interaction.original_response()


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
    await _retire_vote_view(interaction.channel_id, "🗳️ Vote cancelled.")
    view = LobbyView.active.pop(interaction.channel_id, None)
    if view is not None:
        view.stop()
        if view.message is not None:
            try:
                await view.message.edit(content="🕵️ **Impostor** — cancelled.",
                                        view=None)
            except discord.HTTPException:
                pass            # message gone; the game is cleared regardless
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


def _pack_footer(ref: impostor.PackRef) -> str:
    """One line of "where the pack stands now", after an edit."""
    try:
        stats = impostor.group_stats(word_packs().groups(ref))
    except WordPackError:
        return ""               # pack vanished under us; the counts above stand
    pack = ref.name
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
            # Shared packs plus your own -- never anybody else's.
            counts = word_packs().counts(interaction.user.id)
            if not counts:
                await interaction.response.send_message(
                    "No word packs yet — make one with "
                    "`/impostor words add scope:mine pack:animals "
                    "words:cat, dog`.", ephemeral=True)
                return
            total = sum(st.words for st in counts.values())
            lines = [f"**Word packs** ({total} words total)"]
            lines += [f"• `{ref.label(interaction.user.id)}` — {st.words} "
                      f"words in {st.groups} group"
                      f"{'s' if st.groups != 1 else ''} "
                      f"({st.decoy_groups} decoy-ready, "
                      f"{st.guess_groups} guess-ready)"
                      for ref, st in counts.items()]
            mine = word_packs().personal_pack_count(interaction.user.id)
            lines.append(f"_Your packs: {mine}/{impostor.MAX_PERSONAL_PACKS}. "
                         f"File: `{word_packs().path}`_")
            body = _chunk(lines)
        else:
            ref = word_packs().resolve(pack, interaction.user.id)
            groups = word_packs().groups(ref)
            stats = impostor.group_stats(groups)
            header = (f"**`{ref.label(interaction.user.id)}`** — "
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
@app_commands.choices(scope=_SCOPE_CHOICES)
@app_commands.describe(
    scope="Whose pack: the server's, or your own (default: server)",
    pack="Pack to add to — a new name creates the pack",
    words=("Similar words, comma-separated: `T-spin double, T-spin triple`. "
           "Use \\n between groups to add several at once."),
)
@app_commands.autocomplete(pack=_pack_autocomplete)
async def words_add(interaction: discord.Interaction, pack: str, words: str,
                    scope: str = SCOPE_SERVER):
    ref = _guard_edit(interaction, pack, scope)
    if isinstance(ref, str):                  # a refusal, not a pack
        await interaction.response.send_message(ref, ephemeral=True)
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
        result = word_packs().add(ref, candidates)
    except WordPackError as e:
        await interaction.response.send_message(str(e), ephemeral=True)
        return

    lines = []
    if result.added:
        created = " (new pack)" if result.pack_created else ""
        lines.append(f"✅ Added **{len(result.added)}** word"
                     f"{'s' if len(result.added) != 1 else ''} to "
                     f"`{result.pack.label(interaction.user.id)}`{created}: "
                     f"{_preview(result.added)}")
    else:
        lines.append("Nothing added to "
                     f"`{result.pack.label(interaction.user.id)}`.")
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
@app_commands.choices(scope=_SCOPE_CHOICES)
@app_commands.describe(scope="Whose pack: the server's, or your own",
                       pack="Pack to remove from",
                       words="Words, separated by commas, semicolons or newlines")
@app_commands.autocomplete(pack=_pack_autocomplete)
async def words_remove(interaction: discord.Interaction, pack: str,
                       words: str, scope: str = SCOPE_SERVER):
    ref = _guard_edit(interaction, pack, scope)
    if isinstance(ref, str):
        await interaction.response.send_message(ref, ephemeral=True)
        return

    candidates = impostor.parse_words(words)
    if not candidates:
        await interaction.response.send_message(
            "Nothing to remove — pass words separated by commas.",
            ephemeral=True)
        return

    try:
        result = word_packs().remove(ref, candidates)
    except WordPackError as e:
        await interaction.response.send_message(str(e), ephemeral=True)
        return

    lines = []
    if result.removed:
        lines.append(f"🗑️ Removed **{len(result.removed)}** word"
                     f"{'s' if len(result.removed) != 1 else ''} from "
                     f"`{result.pack.label(interaction.user.id)}`: "
                     f"{_preview(result.removed)}")
    else:
        lines.append("Nothing removed from "
                     f"`{result.pack.label(interaction.user.id)}`.")
    if result.missing:
        lines.append(f"❓ Not in the pack ({len(result.missing)}): "
                     f"{_preview(result.missing)}")
    if result.pack_deleted:
        lines.append(f"_`{result.pack.label(interaction.user.id)}` is now "
                     "empty and was dropped._")
    else:
        lines.append(_pack_footer(result.pack))

    await interaction.response.send_message("\n".join(lines), ephemeral=True)


@words_group.command(
    name="import",
    description="Bulk-add words to a pack from an uploaded .txt or .json file.")
@app_commands.choices(scope=_SCOPE_CHOICES)
@app_commands.describe(
    scope="Whose pack: the server's, or your own",
    pack="Pack to import into — a new name creates the pack",
    file=(".txt: one group per line, commas inside a group. "
          '.json: a list of groups, e.g. [["a", "b"], ["c", "d"]]'),
)
@app_commands.autocomplete(pack=_pack_autocomplete)
async def words_import(interaction: discord.Interaction, pack: str,
                       file: discord.Attachment,
                       scope: str = SCOPE_SERVER):
    ref = _guard_edit(interaction, pack, scope)
    if isinstance(ref, str):
        await interaction.response.send_message(ref, ephemeral=True)
        return

    # Reject on the declared size before downloading anything: the point of
    # the cap is not to pull a 25 MB attachment into memory to measure it.
    if file.size > impostor.MAX_IMPORT_BYTES:
        await interaction.response.send_message(
            f"That file is {file.size // 1024} KB — the limit is "
            f"{impostor.MAX_IMPORT_BYTES // 1024} KB.", ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True, thinking=True)
    try:
        data = await file.read()
    except discord.HTTPException as e:
        print(f"impostor: import download failed: {type(e).__name__}: {e}",
              file=sys.stderr)
        await interaction.followup.send(
            "Could not download that file — try uploading it again.",
            ephemeral=True)
        return

    try:
        groups = impostor.parse_import(data, file.filename)
        result = word_packs().add(ref, groups)
    except WordPackError as e:
        await interaction.followup.send(str(e), ephemeral=True)
        return

    lines = [f"📥 **Imported `{file.filename}`** into "
             f"`{ref.label(interaction.user.id)}`"]
    # "from N groups" -- what the file held. How many groups the pack gained
    # is not the same number, because add() merges into existing ones.
    lines.append(f"✅ Added **{len(result.added)}** word"
                 f"{'s' if len(result.added) != 1 else ''} from "
                 f"{len(groups)} group{'s' if len(groups) != 1 else ''} "
                 "in the file"
                 + (" (new pack)" if result.pack_created else "")
                 + (f": {_preview(result.added)}" if result.added else "."))
    for group in result.merged:
        lines.append(f"🔗 Merged into an existing group: {' / '.join(group)}")
    if result.duplicates:
        lines.append(f"↩️ Already there ({len(result.duplicates)}): "
                     f"{_preview(result.duplicates)}")
    if result.invalid:
        lines.append(f"⚠️ Skipped ({len(result.invalid)}) — blank or over "
                     f"{impostor.MAX_WORD_LENGTH} characters: "
                     f"{_preview(result.invalid)}")
    lines.append(_pack_footer(ref))

    for chunk in _chunk(lines):
        await interaction.followup.send(chunk, ephemeral=True)


@words_group.command(name="deletepack",
                     description="Delete a whole word pack.")
@app_commands.choices(scope=_SCOPE_CHOICES)
@app_commands.describe(scope="Whose pack: the server's, or your own",
                       pack="Pack to delete, words and all")
@app_commands.autocomplete(pack=_pack_autocomplete)
async def words_deletepack(interaction: discord.Interaction, pack: str,
                           scope: str = SCOPE_SERVER):
    ref = _guard_edit(interaction, pack, scope)
    if isinstance(ref, str):
        await interaction.response.send_message(ref, ephemeral=True)
        return
    try:
        size = word_packs().delete_pack(ref)
    except WordPackError as e:
        await interaction.response.send_message(str(e), ephemeral=True)
        return
    await interaction.response.send_message(
        f"🗑️ Deleted `{ref.label(interaction.user.id)}` and its "
        f"{size} word{'s' if size != 1 else ''}.", ephemeral=True)
