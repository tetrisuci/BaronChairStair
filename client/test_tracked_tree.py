"""
Every command counted from start to finish, and refused while the bot stops.

    .venv/bin/python -m unittest discover -s client   # the discord.py half skips without it

The counting rides on hooks discord.py documents — the tree's
`interaction_check` and `on_error`, the `app_command_completion` event, and a
prefix command's before- and after-invoke hooks — so these tests drive real
discord.py: an interaction is fed in where the gateway would feed it
(`ConnectionState.parse_interaction_create`) and goes through the library's
own dispatch, its own error handling and its own completion event. A test
that called the hooks by hand would pass with them wired to nothing.

Skipped rather than failed without discord.py, as `test_puzzle_recap.py`
does, and only for that reason. The last class reads `discord_bot.py` rather
than importing it, so it runs everywhere.
"""

import ast
import asyncio
import contextlib
import io
import pathlib
import types
import unittest
from unittest import mock

import lifecycle

try:
    import discord
    from discord.ext import commands
    from discord.ext.commands.view import StringView

    import tracked_tree
except ModuleNotFoundError as missing:  # pragma: no cover - depends on the environment
    if missing.name not in {"discord", "discord.ext", "aiohttp"}:
        raise
    discord = None

#: `test_changelog_wiring` installs a stub `discord` on a bare box; the stub
#: has no gateway types, and these tests are about the real dispatch.
REAL_DISCORD = discord is not None and hasattr(discord, "InteractionType")
needs_discord = unittest.skipUnless(REAL_DISCORD, "discord.py is not installed")

CLIENT = pathlib.Path(__file__).resolve().parent


def gateway_interaction(interaction_id: int, name: str, kind: int = 2) -> dict:
    """An INTERACTION_CREATE payload, as much of one as discord.py 2.7.1 reads."""
    return {
        "id": str(interaction_id), "application_id": "2", "type": kind, "token": "t",
        "version": 1, "data": {"id": "3", "name": name, "type": 1, "options": []},
        "user": {"id": "4", "username": "someone", "discriminator": "0",
                 "avatar": None, "global_name": None},
        "locale": "en-US", "channel_id": "5", "app_permissions": "0",
        "authorizing_integration_owners": {}, "entitlements": [],
        "attachment_size_limit": 8_388_608,
    }


@needs_discord
class SlashCommands(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.life = lifecycle.Lifecycle()
        self.life.mark_ready()
        self.bot = commands.Bot(command_prefix="!", intents=discord.Intents.default(),
                                tree_cls=tracked_tree.tree_class(self.life))
        tracked_tree.track(self.bot, self.life)
        self.release = asyncio.Event()
        self.ran: list[str] = []

        @self.bot.tree.command(name="slow", description="waits to be released")
        async def slow(interaction: discord.Interaction):
            self.ran.append("slow")
            await self.release.wait()

        @self.bot.tree.command(name="broken", description="raises")
        async def broken(interaction: discord.Interaction):
            self.ran.append("broken")
            raise RuntimeError("the command failed")

        self.sent: list[dict] = []

        async def send_message(response, content=None, **kwargs):
            self.sent.append({"content": content, **kwargs})

        patcher = mock.patch.object(discord.InteractionResponse, "send_message", send_message)
        patcher.start()
        self.addCleanup(patcher.stop)
        await self.bot.__aenter__()
        self.addAsyncCleanup(self.bot.__aexit__, None, None, None)
        self.log = io.StringIO()
        quiet = contextlib.redirect_stderr(self.log)
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)

    def arrive(self, interaction_id: int, name: str, kind: int = 2) -> None:
        self.bot._connection.parse_interaction_create(
            gateway_interaction(interaction_id, name, kind))

    async def settle(self) -> None:
        for _ in range(5):
            await asyncio.sleep(0)
        await asyncio.sleep(0.01)

    async def test_a_command_counts_while_it_runs_and_not_after(self):
        self.arrive(11, "slow")
        await self.settle()
        self.assertEqual(self.ran, ["slow"])
        self.assertEqual(self.life.snapshot().inflight, 1)
        self.assertIsNotNone(self.life.snapshot().last_interaction_at)
        self.release.set()
        await self.settle()
        self.assertEqual(self.life.snapshot().inflight, 0)

    async def test_a_command_that_raises_is_finished_by_the_error_path(self):
        with self.assertLogs("discord.app_commands.tree", level="ERROR"):
            self.arrive(12, "broken")
            await self.settle()
        self.assertEqual(self.ran, ["broken"])
        self.assertEqual(self.life.snapshot().inflight, 0)

    async def test_a_command_discord_knows_and_this_bot_does_not_is_finished_too(self):
        # A stale registration after a command is removed: CommandNotFound.
        with self.assertLogs("discord.app_commands.tree", level="ERROR"):
            self.arrive(13, "gone")
            await self.settle()
        self.assertEqual(self.life.snapshot().inflight, 0)

    async def test_several_at_once_are_counted_separately(self):
        self.arrive(14, "slow")
        self.arrive(15, "slow")
        await self.settle()
        self.assertEqual(self.life.snapshot().inflight, 2)
        self.release.set()
        await self.settle()
        self.assertEqual(self.life.snapshot().inflight, 0)

    async def test_while_stopping_a_new_command_is_refused_privately_and_not_run(self):
        self.arrive(16, "slow")
        await self.settle()
        self.life.begin_stop()
        self.arrive(17, "slow")
        await self.settle()
        self.assertEqual(self.ran, ["slow"], "the refused command ran")
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0]["content"], "Restarting — try again in a few seconds.")
        self.assertIs(self.sent[0]["ephemeral"], True)
        self.assertEqual(self.life.snapshot().inflight, 1, "the refusal was counted")
        self.release.set()
        await self.settle()
        self.assertEqual(self.life.snapshot().inflight, 0)

    async def test_a_refusal_that_cannot_be_sent_is_logged_not_raised(self):
        async def expired(response, content=None, **kwargs):
            raise discord.NotFound(types.SimpleNamespace(status=404, reason="Not Found"),
                                   {"code": 10062, "message": "Unknown interaction"})

        self.life.begin_stop()
        with mock.patch.object(discord.InteractionResponse, "send_message", expired):
            self.arrive(18, "slow")
            await self.settle()
        self.assertEqual(self.ran, [])
        self.assertIn("could not say so", self.log.getvalue())

    async def test_autocomplete_is_never_counted(self):
        # Answered in milliseconds, and it has nobody to tell "restarting".
        interaction = types.SimpleNamespace(type=discord.InteractionType.autocomplete, id=19)
        tree = self.bot.tree
        self.assertTrue(await tree.interaction_check(interaction))
        self.assertEqual(self.life.snapshot().inflight, 0)
        self.life.begin_stop()
        self.assertFalse(await tree.interaction_check(interaction))
        self.assertEqual(self.sent, [])

    async def test_the_tree_is_still_a_command_tree(self):
        # sync_guilds.py copies and syncs this tree; it must behave as one.
        self.assertIsInstance(self.bot.tree, discord.app_commands.CommandTree)
        self.assertEqual({c.name for c in self.bot.tree.get_commands()}, {"slow", "broken"})


@needs_discord
class PrefixCommands(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.life = lifecycle.Lifecycle()
        self.bot = commands.Bot(command_prefix="!", intents=discord.Intents.default(),
                                tree_cls=tracked_tree.tree_class(self.life))
        tracked_tree.track(self.bot, self.life)
        self.seen: list[int] = []

        @self.bot.command(name="highlights")
        async def highlights(ctx):
            self.seen.append(self.life.snapshot().inflight)

        @self.bot.command(name="broken")
        async def broken(ctx):
            raise RuntimeError("the command failed")

        await self.bot.__aenter__()
        self.addAsyncCleanup(self.bot.__aexit__, None, None, None)

    def context(self, message_id: int, name: str):
        message = types.SimpleNamespace(
            id=message_id, content=f"!{name}", attachments=[], guild=None, channel=None,
            author=types.SimpleNamespace(bot=False, id=9), _state=self.bot._connection)
        return commands.Context(message=message, bot=self.bot, view=StringView(""),
                                prefix="!", command=self.bot.get_command(name),
                                invoked_with=name)

    async def test_a_prefix_command_counts_while_it_runs(self):
        await self.bot.invoke(self.context(21, "highlights"))
        self.assertEqual(self.seen, [1])
        self.assertEqual(self.life.snapshot().inflight, 0)
        self.assertIsNotNone(self.life.snapshot().last_interaction_at)

    async def test_a_prefix_command_that_raises_still_finishes(self):
        with contextlib.redirect_stderr(io.StringIO()):
            await self.bot.invoke(self.context(22, "broken"))
        self.assertEqual(self.life.snapshot().inflight, 0)


class Message:
    def __init__(self):
        self.replies: list[dict] = []

    async def reply(self, content=None, **kwargs):
        self.replies.append({"content": content, **kwargs})


class Bot:
    def __init__(self, command):
        self.command = command

    async def get_context(self, message):
        return types.SimpleNamespace(command=self.command)


@needs_discord
class PrefixRefusal(unittest.IsolatedAsyncioTestCase):
    async def test_running_normally_nothing_is_refused(self):
        message = Message()
        refused = await tracked_tree.refuse_prefix_while_stopping(
            Bot(command=object()), message, lifecycle.Lifecycle())
        self.assertFalse(refused)
        self.assertEqual(message.replies, [])

    async def test_stopping_a_command_is_answered_and_not_run(self):
        life = lifecycle.Lifecycle()
        life.begin_stop()
        message = Message()
        self.assertTrue(await tracked_tree.refuse_prefix_while_stopping(
            Bot(command=object()), message, life))
        self.assertEqual(message.replies[0]["content"], lifecycle.RESTARTING_MESSAGE)
        self.assertIs(message.replies[0]["mention_author"], False)

    async def test_stopping_an_ordinary_message_is_left_alone(self):
        life = lifecycle.Lifecycle()
        life.begin_stop()
        message = Message()
        self.assertFalse(await tracked_tree.refuse_prefix_while_stopping(
            Bot(command=None), message, life))
        self.assertEqual(message.replies, [])


class TheBotIsWiredToItsLifecycle(unittest.TestCase):
    """
    Read, not imported, for the reason the module docstring gives. Each check
    is about a line that, deleted, would leave every test above green while
    the running bot counted nothing or stopped rudely.
    """

    TREE = ast.parse((CLIENT / "discord_bot.py").read_text(encoding="utf-8"))

    @staticmethod
    def _is_call(node, owner: str, attr: str) -> bool:
        return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == attr and isinstance(node.func.value, ast.Name)
                and node.func.value.id == owner)

    def _function(self, name: str) -> ast.AST:
        (found,) = [n for n in ast.walk(self.TREE)
                    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name]
        return found

    def test_the_bot_is_built_with_the_tracking_tree(self):
        (bot,) = [n for n in ast.walk(self.TREE) if self._is_call(n, "commands", "Bot")]
        (tree_cls,) = [k.value for k in bot.keywords if k.arg == "tree_cls"]
        self.assertTrue(self._is_call(tree_cls, "tracked_tree", "tree_class"))

    def test_the_finish_hooks_are_installed_at_module_level(self):
        calls = [n.value for n in self.TREE.body if isinstance(n, ast.Expr)]
        self.assertTrue(any(self._is_call(c, "tracked_tree", "track") for c in calls))

    def test_on_ready_marks_the_bot_ready(self):
        on_ready = self._function("on_ready")
        self.assertTrue(any(self._is_call(n, "LIFECYCLE", "mark_ready")
                            for n in ast.walk(on_ready)))

    def test_on_message_refuses_prefix_commands_before_processing_them(self):
        on_message = self._function("on_message")
        lines = {}
        for node in ast.walk(on_message):
            if self._is_call(node, "tracked_tree", "refuse_prefix_while_stopping"):
                lines["refuse"] = node.lineno
            if self._is_call(node, "bot", "process_commands"):
                lines["process"] = node.lineno
        self.assertLess(lines["refuse"], lines["process"])

    def _entry_point(self) -> ast.If:
        (main,) = [n for n in self.TREE.body if isinstance(n, ast.If)
                   and isinstance(n.test, ast.Compare)
                   and isinstance(n.test.left, ast.Name) and n.test.left.id == "__name__"]
        return main

    def test_the_entry_point_serves_through_the_lifecycle_not_bot_run(self):
        calls = list(ast.walk(self._entry_point()))
        self.assertTrue(any(self._is_call(n, "lifecycle", "serve") for n in calls))
        self.assertFalse(any(self._is_call(n, "bot", "run") for n in calls),
                         "bot.run installs no signal handlers and writes no status")

    def test_the_entry_point_sets_up_only_discords_logger_as_bot_run_did(self):
        # bot.run calls setup_logging with root_logger=False, its default, so
        # only discord.py's own logger printed. setup_logging's own default is
        # root=True, which would put an INFO handler on the root logger and
        # print every library's INFO lines as well.
        setups = [n for n in ast.walk(self._entry_point())
                  if isinstance(n, ast.Call) and ast.unparse(n.func) == "discord.utils.setup_logging"]
        self.assertEqual(len(setups), 1, "the entry point does not set up discord.py's logging")
        (setup,) = setups
        roots = [k.value for k in setup.keywords if k.arg == "root"]
        self.assertEqual([ast.unparse(r) for r in roots], ["False"],
                         "setup_logging is not given root=False, as bot.run gave it")


if __name__ == "__main__":
    unittest.main()
