"""
tracked_tree.py
~~~~~~~~~~~~~~~
Connects `lifecycle.py` to discord.py: every command is counted from the
moment it starts to the moment it ends, and refused while the bot is stopping.

**Only hooks discord.py documents.** The slash-command half is a
`CommandTree` subclass: `interaction_check` runs before any command and is
where a command is admitted (counted) or refused, and the end is reported by
whichever of discord.py's own exits the command takes — the
`app_command_completion` event when it succeeds, the tree's `on_error` when
it raises or does not exist. The prefix half (`!highlights`, `!yauna`) uses
the bot's before- and after-invoke hooks; the after hook runs in a `finally`,
so a prefix command that raises still ends. Overriding the tree's private
`_call` would be one try/finally instead, and would break silently on the
next discord.py that renames it, which `command_sync.global_payload` already
shows can happen.

**Refused, not dropped.** A command that arrives while the bot stops is
answered privately with "Restarting — try again in a few seconds." and never
runs; the person knows to retry rather than watching "the application did not
respond". A prefix command gets the same words as a reply, since a message
cannot be answered privately.

Autocomplete is never counted: it is answered in milliseconds and has nobody
to tell "restarting". This bot has no buttons or modals, which reach the bot
outside the tree; a view added later would want counting of its own.
"""

import sys

import discord
from discord import app_commands
from discord.ext import commands

from lifecycle import RESTARTING_MESSAGE, Lifecycle

#: The refusal pings nobody, in a reply or anywhere else.
_NO_MENTIONS = discord.AllowedMentions.none()


def app_key(interaction: discord.Interaction) -> tuple[str, int]:
    """What a slash command is tracked under. Kept in memory only."""
    return ("interaction", interaction.id)


def prefix_key(ctx: commands.Context) -> tuple[str, int]:
    """What a prefix command is tracked under: the message that invoked it."""
    return ("message", ctx.message.id)


async def admit(lifecycle: Lifecycle, interaction: discord.Interaction) -> bool:
    """
    The tree's gate. True runs the command, counted; False means it was
    refused (and told so) because the bot is stopping.
    """
    if interaction.type is discord.InteractionType.autocomplete:
        return not lifecycle.stopping
    if lifecycle.admit(app_key(interaction)):
        return True
    try:
        await interaction.response.send_message(
            RESTARTING_MESSAGE, ephemeral=True, allowed_mentions=_NO_MENTIONS)
    except Exception as exc:  # noqa: BLE001 — the refusal is best-effort
        # Raised from here it would escape discord.py's invoker task, which
        # catches only command errors. The command is refused either way.
        print(f"stopping: refused a command but could not say so "
              f"({type(exc).__name__}: {exc})", file=sys.stderr)
    return False


def tree_class(lifecycle: Lifecycle) -> type[app_commands.CommandTree]:
    """
    A `CommandTree` that counts into `lifecycle`, for `commands.Bot(tree_cls=…)`.

    A class made per lifecycle, rather than a module-level one reading a
    global, because discord.py builds the tree itself (`tree_cls(bot)`) and
    passes it nothing else — and a test then gets a tree of its own.
    """

    class TrackedCommandTree(app_commands.CommandTree):
        async def interaction_check(self, interaction: discord.Interaction, /) -> bool:
            return await admit(lifecycle, interaction)

        async def on_error(self, interaction: discord.Interaction,
                           error: app_commands.AppCommandError, /) -> None:
            lifecycle.finish(app_key(interaction))
            await super().on_error(interaction, error)

    return TrackedCommandTree


def track(bot: commands.Bot, lifecycle: Lifecycle) -> None:
    """
    Installs the other ends: a slash command's success, and both ends of a
    prefix command. The tree from `tree_class` handles admission and errors.
    """

    async def app_command_finished(interaction: discord.Interaction, _command) -> None:
        lifecycle.finish(app_key(interaction))

    async def prefix_started(ctx: commands.Context) -> None:
        # Counted even while stopping: by now its checks have passed and it is
        # about to run, and a before-invoke hook cannot turn it back.
        lifecycle.begin(prefix_key(ctx))

    async def prefix_finished(ctx: commands.Context) -> None:
        lifecycle.finish(prefix_key(ctx))

    bot.add_listener(app_command_finished, "on_app_command_completion")
    bot.before_invoke(prefix_started)
    bot.after_invoke(prefix_finished)


async def refuse_prefix_while_stopping(bot: commands.Bot, message: discord.Message,
                                       lifecycle: Lifecycle) -> bool:
    """
    While stopping, answers a prefix command with the restarting line instead
    of running it. True if it did; False for anything that should carry on,
    which is every message when the bot is not stopping, and every message
    that is not a command when it is.
    """
    if not lifecycle.stopping:
        return False
    ctx = await bot.get_context(message)
    if ctx.command is None:
        return False
    try:
        await message.reply(RESTARTING_MESSAGE, mention_author=False,
                            allowed_mentions=_NO_MENTIONS)
    except Exception as exc:  # noqa: BLE001 — the refusal is best-effort
        print(f"stopping: refused a prefix command but could not say so "
              f"({type(exc).__name__}: {exc})", file=sys.stderr)
    return True
