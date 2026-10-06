"""Puzzle command behavior without a Discord connection or activity HTTP calls.

The same small stubs keep archive/recap tests importable on a bare Python box.
Run with real discord.py to also verify Discord's registered command schema.
"""

import asyncio
import ast
import os
from pathlib import Path
import sqlite3
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch


def _install_stubs() -> bool:
    try:
        import discord  # noqa: F401
        import aiohttp  # noqa: F401
        return False
    except ModuleNotFoundError:
        pass

    discord = types.ModuleType("discord")

    class AllowedMentions:
        def __init__(self, everyone=True, users=True, roles=True):
            self.everyone, self.users, self.roles = everyone, users, roles

        @classmethod
        def none(cls):
            return cls(everyone=False, users=False, roles=False)

    class Embed:
        def __init__(self, **kwargs):
            self.fields = []
            self.__dict__.update(kwargs)

        def add_field(self, **kwargs):
            self.fields.append(kwargs)

        def set_footer(self, **kwargs):
            self.footer = kwargs

    class Colour:
        @staticmethod
        def from_rgb(*rgb):
            return rgb

    class HTTPException(Exception):
        def __init__(self, response, message=None):
            super().__init__(message or "http error")
            self.response, self.text = response, message

    class File:
        def __init__(self, fp, filename):
            self.fp, self.filename = fp, filename

        def close(self):
            self.fp.close()

    class Group:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)
            self.commands = []

        def command(self, **kwargs):
            def decorate(fn):
                fn.name = kwargs["name"]
                self.commands.append(fn)
                return fn
            return decorate

        def get_command(self, name):
            return next((command for command in self.commands if command.name == name), None)

    class Range:
        def __class_getitem__(cls, parameters):
            return parameters[0]

    discord.AllowedMentions = AllowedMentions
    discord.Embed = Embed
    discord.Colour = Colour
    discord.HTTPException = HTTPException
    discord.File = File
    discord.Interaction = object
    discord.Message = object
    app_commands = types.ModuleType("discord.app_commands")
    app_commands.command = lambda **_kwargs: (lambda fn: fn)
    app_commands.describe = lambda **_kwargs: (lambda fn: fn)
    app_commands.Group = Group
    app_commands.Range = Range
    discord.app_commands = app_commands
    sys.modules["discord"] = discord
    sys.modules["discord.app_commands"] = app_commands
    aiohttp = types.ModuleType("aiohttp")
    aiohttp.ClientError = type("ClientError", (Exception,), {})
    aiohttp.ClientTimeout = lambda **_kwargs: None
    aiohttp.ClientSession = object
    sys.modules["aiohttp"] = aiohttp
    return True


_STUBBED = _install_stubs()

import changelog  # noqa: E402
import puzzle_commands  # noqa: E402
import puzzle_recap  # noqa: E402


class Response:
    def __init__(self):
        self.sent = []
        self.deferred = []

    async def send_message(self, content=None, **kwargs):
        self.sent.append({"content": content, **kwargs})

    async def defer(self, **kwargs):
        self.deferred.append(kwargs)


class Followup:
    def __init__(self):
        self.sent = []
        self.message = types.SimpleNamespace(channel=types.SimpleNamespace(id=22), id=33)

    async def send(self, content=None, **kwargs):
        self.sent.append({"content": content, **kwargs})
        return self.message


class Interaction:
    def __init__(self, guild_id=1):
        self.guild_id = guild_id
        self.response = Response()
        self.followup = Followup()


def invoke(command, interaction, **kwargs):
    callback = getattr(command, "callback", command)
    asyncio.run(callback(interaction, **kwargs))


class LaunchWithoutAutomaticNotes(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"PUZZLE_APP_ID": "123"})
        self.environment.start()
        self.db = sqlite3.connect(":memory:")
        puzzle_recap.init_db(self.db)
        self.database = patch.object(puzzle_commands, "recap_db", self.db)
        self.database.start()
        self.no_announcements = patch.object(changelog, "announcement_for", side_effect=AssertionError("automatic changelog"))
        self.no_announcements.start()
        self.no_notes = patch.object(changelog, "format_recent_changes", side_effect=AssertionError("notes during launch"))
        self.no_notes.start()

    def tearDown(self):
        self.no_notes.stop()
        self.no_announcements.stop()
        self.database.stop()
        self.db.close()
        self.environment.stop()

    def test_launch_posts_once_and_still_records_recap_reply(self):
        interaction = Interaction()
        with patch.object(puzzle_commands, "_get", AsyncMock(return_value={"day": 17})):
            invoke(puzzle_commands.puzzle_command, interaction)
        self.assertEqual(interaction.response.sent, [])
        self.assertEqual(interaction.response.deferred, [{"thinking": True}])
        self.assertEqual(interaction.followup.sent, [{
            "content": "Today's puzzle is up. https://discord.com/activities/123", "wait": True,
        }])
        row = self.db.execute("SELECT day, channel_id, message_id FROM puzzle_plays").fetchone()
        self.assertEqual(row, (17, 22, 33))

    def test_outage_also_posts_only_the_launch_reply(self):
        interaction = Interaction()
        with patch.object(puzzle_commands, "_get", AsyncMock(side_effect=puzzle_commands.PuzzleServerUnavailable("offline"))):
            with self.assertLogs("puzzle_commands", level="WARNING"):
                invoke(puzzle_commands.puzzle_command, interaction)
        self.assertEqual(len(interaction.followup.sent), 1)
        self.assertIn("https://discord.com/activities/123", interaction.followup.sent[0]["content"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM puzzle_plays").fetchone()[0], 0)

    def test_missing_configuration_has_one_private_error(self):
        interaction = Interaction()
        with patch.dict(os.environ, {"PUZZLE_APP_ID": ""}):
            with patch.object(puzzle_commands, "_get", AsyncMock(side_effect=AssertionError("network"))):
                invoke(puzzle_commands.puzzle_command, interaction)
        self.assertEqual(len(interaction.response.sent), 1)
        self.assertTrue(interaction.response.sent[0]["ephemeral"])
        self.assertEqual(interaction.followup.sent, [])


class NotesOnlyWhenRequested(unittest.TestCase):
    def setUp(self):
        self.history = patch.object(changelog, "RELEASES", (
            changelog.Release("new", ("first change", "second change @everyone")),
            changelog.Release("old", ("third change", "fourth change", "fifth change", "sixth change")),
        ))
        self.history.start()
        self.no_network = patch.object(puzzle_commands, "_get", AsyncMock(side_effect=AssertionError("changelog must be offline")))
        self.no_network.start()
        self.no_state = patch.object(changelog, "announcement_for", side_effect=AssertionError("no seen-version state"))
        self.no_state.start()

    def tearDown(self):
        self.no_state.stop()
        self.no_network.stop()
        self.history.stop()

    def test_requested_number_of_changes_is_private_and_cannot_ping(self):
        interaction = Interaction()
        invoke(puzzle_commands.puzzle_changelog, interaction, count=2)
        self.assertEqual(len(interaction.response.sent), 1)
        message = interaction.response.sent[0]
        self.assertIn("first change", message["content"])
        self.assertIn("second change", message["content"])
        self.assertNotIn("third change", message["content"])
        self.assertTrue(message["ephemeral"])
        for flag in ("everyone", "users", "roles"):
            self.assertFalse(getattr(message["allowed_mentions"], flag))
        self.assertEqual(interaction.followup.sent, [])

    def test_repeat_requests_and_direct_messages_work_without_configuration(self):
        interaction = Interaction(guild_id=None)
        with patch.dict(os.environ, {"PUZZLE_APP_ID": "", "PUZZLE_API": ""}):
            for _ in range(2):
                invoke(puzzle_commands.puzzle_changelog, interaction)
        self.assertEqual(len(interaction.response.sent), 2)
        for message in interaction.response.sent:
            self.assertIn("fifth change", message["content"])
            self.assertNotIn("sixth change", message["content"])
            self.assertTrue(message["ephemeral"])
        self.assertEqual(interaction.response.sent[0]["content"], interaction.response.sent[1]["content"])

    def test_invalid_direct_callback_count_gets_private_error(self):
        interaction = Interaction()
        invoke(puzzle_commands.puzzle_changelog, interaction, count=0)
        self.assertEqual(len(interaction.response.sent), 1)
        self.assertIn("between 1 and 20", interaction.response.sent[0]["content"])
        self.assertTrue(interaction.response.sent[0]["ephemeral"])

    def test_empty_history_still_answers_the_request(self):
        interaction = Interaction()
        with patch.object(changelog, "RELEASES", ()):
            invoke(puzzle_commands.puzzle_changelog, interaction)
        self.assertEqual(len(interaction.response.sent), 1)
        self.assertTrue(interaction.response.sent[0]["content"])
        self.assertTrue(interaction.response.sent[0]["ephemeral"])

    def test_long_request_attaches_every_selected_change_in_one_private_reply(self):
        interaction = Interaction()
        changes = tuple(f"change-{index}: " + "🌱" * 700 for index in range(4))
        with patch.object(changelog, "RELEASES", (changelog.Release("long", changes),)):
            invoke(puzzle_commands.puzzle_changelog, interaction, count=3)
        self.assertEqual(len(interaction.response.sent), 1)
        reply = interaction.response.sent[0]
        self.assertTrue(reply["ephemeral"])
        self.assertEqual(interaction.followup.sent, [])
        self.assertLessEqual(len(reply["content"].encode("utf-16-le")) // 2, 2000)
        self.assertIn("full requested changelog is attached", reply["content"])
        attachment = reply["file"]
        self.assertEqual(attachment.filename, "puzzle-changelog.txt")
        full_text = attachment.fp.read().decode("utf-8")
        attachment.close()
        for change in changes[:3]:
            self.assertIn(change, full_text)
        self.assertNotIn("change-3:", full_text)


class SlashCommandRegistration(unittest.TestCase):
    def test_group_contains_launch_and_changelog(self):
        self.assertEqual(puzzle_commands.puzzle.name, "puzzle")
        self.assertEqual({command.name for command in puzzle_commands.puzzle.commands}, {"play", "changelog"})
        self.assertIs(puzzle_commands.puzzle.get_command("play"), puzzle_commands.puzzle_command)
        self.assertIs(puzzle_commands.puzzle.get_command("changelog"), puzzle_commands.puzzle_changelog)
        source = Path(puzzle_commands.__file__).with_name("discord_bot.py").read_text()
        module = ast.parse(source)
        registered = [node.args[0].id for node in ast.walk(module)
                      if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                      and node.func.attr == "add_command" and node.args and isinstance(node.args[0], ast.Name)]
        self.assertIn("puzzle", registered)
        self.assertNotIn("puzzle_command", registered)

    @unittest.skipIf(_STUBBED, "Install discord.py to check Discord's command schema")
    def test_real_discord_schema_has_optional_bounded_count(self):
        import discord
        from discord import app_commands

        async def schema():
            client = discord.Client(intents=discord.Intents.none())
            tree = app_commands.CommandTree(client)
            tree.add_command(puzzle_commands.puzzle)
            result = puzzle_commands.puzzle.to_dict(tree)
            await client.close()
            return result

        registered = asyncio.run(schema())
        subcommands = {command["name"]: command for command in registered["options"]}
        self.assertEqual(set(subcommands), {"play", "changelog"})
        options = subcommands["changelog"]["options"]
        self.assertEqual(len(options), 1)
        count = options[0]
        self.assertEqual(count["name"], "count")
        self.assertFalse(count["required"])
        self.assertEqual(count["min_value"], 1)
        self.assertEqual(count["max_value"], 20)


if __name__ == "__main__":
    unittest.main()
