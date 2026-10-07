"""
The global command tree is written to Discord only when it has changed.

    python3 -m unittest discover -s client     # no install needed

`on_ready` fires on every start and on every reconnect, and it used to read
the global commands back and overwrite them every time: two rate-limited
calls, a slower restart, and a propagation flicker for a tree that had not
changed. Now a hash of what would be sent is kept in `stats.db`, and a match
skips both calls. What the tests pin is the other side of that bargain: a
changed tree, a missing hash, a failed sync and a forced one all still sync,
and Discord's own Entry Point command is still carried over when they do.
"""

import ast
import asyncio
import contextlib
import io
import pathlib
import sqlite3
import types
import unittest

import command_sync

PING = {"name": "ping", "type": 1, "description": "pong", "options": []}
ECHO = {"name": "echo", "type": 1, "description": "says it back",
        "options": [{"name": "text", "type": 3, "description": "what", "required": True}]}
ENTRY_POINT = {"id": "9", "name": "launch", "type": 4, "handler": 2}


class Discord:
    """The two calls a sync makes, recorded."""

    def __init__(self, existing=None, fail=False):
        self.existing = existing if existing is not None else []
        self.fail = fail
        self.fetches = 0
        self.written: list[list[dict]] = []

    async def fetch(self):
        self.fetches += 1
        return self.existing

    async def overwrite(self, payload):
        if self.fail:
            raise RuntimeError("429 Too Many Requests")
        self.written.append(payload)


class Hashing(unittest.TestCase):
    def test_the_same_tree_hashes_the_same_however_it_was_built(self):
        reordered = {"options": [], "description": "pong", "type": 1, "name": "ping"}
        self.assertEqual(command_sync.payload_hash([PING, ECHO]),
                         command_sync.payload_hash([ECHO, reordered]))

    def test_any_change_discord_would_see_changes_the_hash(self):
        renamed = {**PING, "description": "pong!"}
        reordered_options = {**ECHO, "options": list(reversed(
            ECHO["options"] + [{"name": "loud", "type": 5, "description": "caps"}]))}
        base = command_sync.payload_hash([PING, ECHO])
        for changed in ([PING], [renamed, ECHO], [PING, reordered_options]):
            with self.subTest(changed=changed):
                self.assertNotEqual(command_sync.payload_hash(changed), base)

    def test_option_order_is_part_of_the_tree(self):
        # Discord shows options in the order sent, so two orders are two trees.
        two = {**ECHO, "options": [{"name": "a", "type": 3, "description": "a"},
                                   {"name": "b", "type": 3, "description": "b"}]}
        swapped = {**two, "options": list(reversed(two["options"]))}
        self.assertNotEqual(command_sync.payload_hash([two]), command_sync.payload_hash([swapped]))

    def test_the_scope_names_the_application(self):
        # A stats.db copied from a test application must not vouch for this one.
        self.assertNotEqual(command_sync.scope_for(111), command_sync.scope_for(222))


class Syncing(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        command_sync.init_db(self.db)
        self.scope = command_sync.scope_for(1234)
        self.log = io.StringIO()

    def sync(self, discord, payload, *, force=False, db="default", now=1_791_300_000):
        with contextlib.redirect_stderr(self.log):
            return asyncio.run(command_sync.sync_if_changed(
                payload=payload, scope=self.scope,
                db=self.db if db == "default" else db, force=force,
                fetch_existing=discord.fetch, overwrite=discord.overwrite,
                now=lambda: now))

    def test_the_first_sync_writes_and_remembers(self):
        discord = Discord()
        self.assertTrue(self.sync(discord, [PING]))
        self.assertEqual(discord.written, [[PING]])
        self.assertEqual(command_sync.stored_hash(self.db, self.scope),
                         command_sync.payload_hash([PING]))

    def test_an_unchanged_tree_makes_no_call_at_all(self):
        self.sync(Discord(), [PING])
        again = Discord()
        self.assertFalse(self.sync(again, [PING]))
        self.assertEqual((again.fetches, again.written), (0, []))
        self.assertIn("unchanged", self.log.getvalue())

    def test_a_changed_tree_syncs_and_moves_the_hash(self):
        self.sync(Discord(), [PING])
        changed = Discord()
        self.assertTrue(self.sync(changed, [PING, ECHO], now=1_791_300_500))
        self.assertEqual(changed.written, [[PING, ECHO]])
        self.assertEqual(command_sync.stored_hash(self.db, self.scope),
                         command_sync.payload_hash([PING, ECHO]))
        synced_at = self.db.execute(
            "SELECT synced_at FROM command_sync WHERE scope = ?", (self.scope,)).fetchone()[0]
        self.assertEqual(synced_at, 1_791_300_500)

    def test_forcing_syncs_an_unchanged_tree(self):
        self.sync(Discord(), [PING])
        forced = Discord()
        self.assertTrue(self.sync(forced, [PING], force=True))
        self.assertEqual(forced.written, [[PING]])

    def test_the_entry_point_command_is_carried_over_and_not_hashed(self):
        # Discord makes it itself for an Activity; leaving it out of the bulk
        # overwrite reads as deleting it and the whole update is rejected.
        discord = Discord(existing=[{**PING, "id": "1"}, ENTRY_POINT])
        self.sync(discord, [PING])
        self.assertEqual(discord.written, [[PING, ENTRY_POINT]])
        self.assertEqual(command_sync.stored_hash(self.db, self.scope),
                         command_sync.payload_hash([PING]))

    def test_a_failed_sync_remembers_nothing_so_the_next_ready_retries(self):
        with self.assertRaises(RuntimeError):
            self.sync(Discord(fail=True), [PING])
        self.assertIsNone(command_sync.stored_hash(self.db, self.scope))
        retry = Discord()
        self.assertTrue(self.sync(retry, [PING]))
        self.assertEqual(retry.written, [[PING]])

    def test_without_the_table_every_ready_syncs_as_it_used_to(self):
        discord = Discord()
        self.assertTrue(self.sync(discord, [PING], db=None))
        self.assertTrue(self.sync(discord, [PING], db=None))
        self.assertEqual(len(discord.written), 2)

    def test_a_database_that_cannot_be_read_or_written_still_syncs(self):
        broken = sqlite3.connect(":memory:")  # no table
        discord = Discord()
        self.assertTrue(self.sync(discord, [PING], db=broken))
        self.assertEqual(discord.written, [[PING]])
        self.assertIn("command_sync", self.log.getvalue())

    def test_init_is_idempotent(self):
        command_sync.init_db(self.db)
        command_sync.init_db(self.db)


class Forcing(unittest.TestCase):
    def test_on_however_it_is_written(self):
        for value in ("1", "true", "YES", " on "):
            with self.subTest(value=value):
                self.assertTrue(command_sync.forced({"FORCE_COMMAND_SYNC": value}))

    def test_off_unless_set(self):
        for environ in ({}, {"FORCE_COMMAND_SYNC": ""}, {"FORCE_COMMAND_SYNC": "0"},
                        {"FORCE_COMMAND_SYNC": "no"}):
            with self.subTest(environ=environ):
                self.assertFalse(command_sync.forced(environ))


class Command:
    def __init__(self, payload):
        self.payload = payload

    def to_dict(self, tree):
        return self.payload

    async def get_translated_payload(self, tree, translator):
        return {**self.payload, "translated_by": translator}


class Tree:
    def __init__(self, translator=None):
        self.translator = translator
        self.asked = []

    def _get_all_commands(self, guild=None):
        self.asked.append(guild)
        return [Command(PING), Command(ECHO)]


class WhatIsSent(unittest.TestCase):
    """The payload is built the way discord.py 2.7.1's own `tree.sync()` builds it."""

    def test_untranslated_global_commands(self):
        tree = Tree()
        self.assertEqual(asyncio.run(command_sync.global_payload(tree)), [PING, ECHO])
        self.assertEqual(tree.asked, [None])

    def test_a_translator_is_used_when_there_is_one(self):
        payload = asyncio.run(command_sync.global_payload(Tree(translator="t")))
        self.assertEqual([p["translated_by"] for p in payload], ["t", "t"])


class TheBotSyncsOnlyThroughIt(unittest.TestCase):
    """`_sync_global_commands` is still what on_ready calls, and it no longer
    reaches Discord's command endpoints itself. Read, not imported: importing
    `discord_bot.py` needs discord.py and loads the repository's .env."""

    @staticmethod
    def _is_call(node, owner: str, attr: str) -> bool:
        return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == attr and isinstance(node.func.value, ast.Name)
                and node.func.value.id == owner)

    def setUp(self):
        source = (pathlib.Path(__file__).resolve().parent / "discord_bot.py").read_text(
            encoding="utf-8")
        (self.sync,) = [n for n in ast.walk(ast.parse(source))
                        if isinstance(n, ast.AsyncFunctionDef)
                        and n.name == "_sync_global_commands"]

    def test_the_bot_hands_the_http_calls_to_sync_if_changed(self):
        names = {n.attr for n in ast.walk(self.sync) if isinstance(n, ast.Attribute)}
        self.assertIn("sync_if_changed", names)
        awaited = [n.value for n in ast.walk(self.sync) if isinstance(n, ast.Await)]
        direct = [c for c in awaited if isinstance(c, ast.Call)
                  and isinstance(c.func, ast.Attribute)
                  and c.func.attr in {"get_global_commands", "bulk_upsert_global_commands"}]
        self.assertEqual(direct, [], "the bot calls Discord directly, past the hash")

    def test_force_command_sync_reaches_the_sync(self):
        # Every test above proves `forced` reads the setting and that
        # `force=True` syncs; this is the line between them. Hard-code
        # `force=False` and FORCE_COMMAND_SYNC=1 is read by nothing, while a
        # tree changed on Discord's side stays wrong until the code changes.
        (call,) = [n for n in ast.walk(self.sync)
                   if self._is_call(n, "command_sync", "sync_if_changed")]
        forces = [k.value for k in call.keywords if k.arg == "force"]
        self.assertEqual(len(forces), 1, "sync_if_changed is called without force=")
        (force,) = forces
        self.assertTrue(self._is_call(force, "command_sync", "forced"),
                        "force= is not command_sync.forced(...)")
        self.assertEqual([ast.unparse(a) for a in force.args], ["os.environ"],
                         "forced() is not reading the process environment")


if __name__ == "__main__":
    unittest.main()
