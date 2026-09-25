"""
test_archive_commands.py
~~~~~~~~~~~~~~~~~~~~~~~~
The gate on `/archive sync`, and the process handling under it.

The gate is the whole reason this command needed writing carefully, so most of
what follows is about refusing. A permission check that is never tested is a
permission check that quietly stops checking.

Importing `test_changelog_wiring` first is deliberate and is not a dependency
between suites. That module owns `_install_stubs`, which fakes discord.py and
aiohttp for a box with neither installed, and it returns early when the real
libraries are present. Reusing it is the alternative to a second, drifting copy
of the same fakes — its own comment explains why the fake `app_commands` is as
small as it is. This module then adds the two attributes it needs on top, since
`archive_commands` is the first module in the repository to use a Group.
"""

import asyncio
import io
import contextlib
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

import test_changelog_wiring  # noqa: F401 — imported for its stub installation

_app_commands = sys.modules["discord"].app_commands

if not hasattr(_app_commands, "Group"):
    # The stubbed app_commands from a sibling suite defines only `command`.
    # A real discord.py has all of this already and this block is skipped.
    class _Group:
        def __init__(self, name: str, description: str = ""):
            self.name, self.description = name, description

        def command(self, **_kwargs):
            return lambda fn: fn

    _app_commands.Group = _Group

if not hasattr(_app_commands, "describe"):
    _app_commands.describe = lambda **_kwargs: (lambda fn: fn)

import archive_commands  # noqa: E402
import puzzle_admins  # noqa: E402


#: With real discord.py the decorator has replaced the function with a Command
#: object; with the stub it is still the function. Either way this is the code.
CALLBACK = getattr(archive_commands.archive_sync, "callback", archive_commands.archive_sync)


class Response:
    """interaction.response — what a refusal answers on, before any defer."""

    def __init__(self):
        self.messages: list[dict] = []
        self.deferred = False

    async def send_message(self, content=None, **kwargs):
        self.messages.append({"content": content, **kwargs})

    async def defer(self, **kwargs):
        self.deferred = True


class Followup:
    def __init__(self):
        self.sent: list[dict] = []

    async def send(self, content=None, **kwargs):
        self.sent.append({"content": content, **kwargs})


class User:
    def __init__(self, user_id, name="someone"):
        self.id, self.name = user_id, name


class Interaction:
    def __init__(self, user):
        self.user = user
        self.response = Response()
        self.followup = Followup()


class TheGate(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.path = Path(self._dir.name) / "puzzle-admins.json"
        self.path.write_text(json.dumps({"admins": [{"id": "1001", "who": "x"}]}),
                             encoding="utf-8")
        # Point the module at the temporary allowlist rather than the club's.
        self._real_path = puzzle_admins.ADMINS_PATH
        puzzle_admins.ADMINS_PATH = self.path
        self.addCleanup(setattr, puzzle_admins, "ADMINS_PATH", self._real_path)
        # Nothing in this class should reach a subprocess.
        self.calls: list[dict] = []

        async def fake_sync(dry_run, by, cwd=None):
            self.calls.append({"dry_run": dry_run, "by": by})
            return 0, "added 0, amended 0, unchanged 163"

        self._real_sync = archive_commands.run_sync
        archive_commands.run_sync = fake_sync
        self.addCleanup(setattr, archive_commands, "run_sync", self._real_sync)
        # Nor the network.
        self.reloads = 0

        async def fake_reload():
            self.reloads += 1
            return "**Live now:** #167"

        self._real_reload = archive_commands.reload_activity
        archive_commands.reload_activity = fake_reload
        self.addCleanup(setattr, archive_commands, "reload_activity", self._real_reload)

    async def test_an_unlisted_user_is_refused(self):
        interaction = Interaction(User(2002))
        await CALLBACK(interaction)
        self.assertEqual(len(interaction.response.messages), 1)
        self.assertEqual(self.calls, [], "a refused user must not start a sync")

    async def test_the_refusal_is_private(self):
        # "You are not an officer" read out in the channel is a scolding with
        # an audience; this repository answers refusals ephemerally.
        interaction = Interaction(User(2002))
        await CALLBACK(interaction)
        self.assertTrue(interaction.response.messages[0]["ephemeral"])

    async def test_the_refusal_answers_before_any_defer(self):
        # Deferring first would make every later followup ephemeral too, and
        # would post a visible "thinking" for a command about to be refused.
        interaction = Interaction(User(2002))
        await CALLBACK(interaction)
        self.assertFalse(interaction.response.deferred)

    async def test_the_refusal_says_how_to_be_added(self):
        interaction = Interaction(User(2002))
        await CALLBACK(interaction)
        said = interaction.response.messages[0]["content"]
        self.assertIn(puzzle_admins.ADMINS_PATH.name, said)

    async def test_an_empty_allowlist_refuses_everybody(self):
        self.path.write_text(json.dumps({"admins": []}), encoding="utf-8")
        await CALLBACK(Interaction(User(1001)))
        self.assertEqual(self.calls, [])

    async def test_a_missing_allowlist_refuses_everybody(self):
        self.path.unlink()
        await CALLBACK(Interaction(User(1001)))
        self.assertEqual(self.calls, [])

    async def test_a_malformed_allowlist_refuses_everybody(self):
        # The failure this module exists to avoid: a fat-fingered comma must
        # not hand the archive to whoever types the command next.
        self.path.write_text("{ not json", encoding="utf-8")
        with contextlib.redirect_stderr(io.StringIO()):
            await CALLBACK(Interaction(User(1001)))
        self.assertEqual(self.calls, [])

    async def test_a_listed_user_gets_through(self):
        interaction = Interaction(User(1001))
        await CALLBACK(interaction)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(interaction.response.deferred, "the work is announced publicly")
        self.assertEqual(len(interaction.followup.sent), 1)

    async def test_a_listed_user_added_while_the_bot_runs_gets_through(self):
        # The reason the file is read per call rather than at import: adding an
        # officer must not need a restart, which is the operation DEPLOY.md
        # warns can leave two instances on one token.
        await CALLBACK(Interaction(User(3003)))
        self.assertEqual(self.calls, [])
        self.path.write_text(json.dumps({"admins": ["1001", "3003"]}), encoding="utf-8")
        await CALLBACK(Interaction(User(3003)))
        self.assertEqual(len(self.calls), 1)

    async def test_the_runner_is_told_who_asked(self):
        await CALLBACK(Interaction(User(1001, name="zhiyuan")))
        self.assertIn("zhiyuan", self.calls[0]["by"])

    async def test_dry_run_is_passed_through_and_announced(self):
        interaction = Interaction(User(1001))
        await CALLBACK(interaction, dry_run=True)
        self.assertTrue(self.calls[0]["dry_run"])
        self.assertIn("Dry run", interaction.followup.sent[0]["content"])

    async def test_a_poisoned_title_cannot_escape_the_reply_fence(self):
        # Driven through the callback, not through the helper. Asserting that
        # `_fence_safe` works while the command forgets to call it is the
        # vacuous version of this test, and it is the version I wrote first:
        # deleting the call from the callback left the suite green.
        async def poisoned(dry_run, by, cwd=None):
            return 0, '  #42 "``` @everyone see this" — content'

        archive_commands.run_sync = poisoned
        interaction = Interaction(User(1001))
        await CALLBACK(interaction)
        sent = interaction.followup.sent[0]["content"]
        self.assertEqual(
            sent.count("```"), 2,
            "exactly the reply's own opening and closing fence, and no others",
        )

    async def test_a_real_sync_tells_the_activity_and_says_what_went_live(self):
        interaction = Interaction(User(1001))
        await CALLBACK(interaction)
        self.assertEqual(self.reloads, 1)
        self.assertIn("Live now", interaction.followup.sent[0]["content"])

    async def test_a_dry_run_never_touches_the_activity(self):
        # It published nothing, so a reload would at best be a no-op — and a
        # reply saying "live now" under "nothing was written" would be a lie.
        interaction = Interaction(User(1001))
        await CALLBACK(interaction, dry_run=True)
        self.assertEqual(self.reloads, 0)
        self.assertNotIn("Live now", interaction.followup.sent[0]["content"])

    async def test_a_sync_that_never_started_does_not_reload(self):
        async def missing_bun(dry_run, by, cwd=None):
            return -1, "`bun` is not on this bot's PATH"

        archive_commands.run_sync = missing_bun
        await CALLBACK(Interaction(User(1001)))
        self.assertEqual(self.reloads, 0)

    async def test_a_refused_user_does_not_reload_either(self):
        await CALLBACK(Interaction(User(2002)))
        self.assertEqual(self.reloads, 0)

    async def test_a_second_sync_while_one_runs_is_refused(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_sync(dry_run, by, cwd=None):
            started.set()
            await release.wait()
            return 0, "done"

        archive_commands.run_sync = slow_sync
        first = asyncio.create_task(CALLBACK(Interaction(User(1001))))
        await started.wait()

        second = Interaction(User(1001))
        await CALLBACK(second)
        self.assertIn("already running", second.response.messages[0]["content"])
        self.assertFalse(second.response.deferred)

        release.set()
        await first


class ReadingTheResult(unittest.TestCase):
    def test_the_verdicts_distinguish_the_tools_exit_codes(self):
        # Treating any non-zero as failure would report the tool's expected
        # work — a content edit — as a fault.
        self.assertEqual(archive_commands.verdict(0, dry_run=False), "Synced and published.")
        self.assertIn("changed content", archive_commands.verdict(2, dry_run=False))
        self.assertIn("would not write", archive_commands.verdict(1, dry_run=False))
        self.assertIn("failed", archive_commands.verdict(-1, dry_run=False))

    def test_a_dry_run_says_it_wrote_nothing(self):
        self.assertIn("nothing left over", archive_commands.verdict(0, dry_run=True))

    def test_short_output_is_left_alone(self):
        self.assertEqual(archive_commands._clip("added 1, amended 0"), "added 1, amended 0")

    def test_long_output_keeps_the_tail(self):
        # The summary and the skipped rows are at the end; head-truncation
        # would cut exactly the part somebody needs.
        body = "\n".join(f"line {n}" for n in range(500)) + "\nTHE LAST WORD"
        clipped = archive_commands._clip(body, limit=100)
        self.assertIn("THE LAST WORD", clipped)
        self.assertTrue(clipped.startswith("…"))
        self.assertLessEqual(len(clipped), 104)


class NotTrustingTheSheet(unittest.TestCase):
    """The reply carries text the club types into a spreadsheet."""

    def test_a_title_cannot_close_the_code_fence(self):
        # sync-archive prints `#42 "the title"`, so a title with a fence in it
        # would end the block the reply opened and render the rest as markdown.
        poisoned = '  #42 "``` @everyone" — content'
        safe = archive_commands._fence_safe(poisoned)
        self.assertNotIn("```", safe)
        self.assertIn("@everyone", safe, "the text is defanged, not censored")

    def test_the_public_reply_refuses_mentions(self):
        # Reading the source, because the decorator has replaced the function
        # with a Command object under the real library and the send is three
        # awaits deep. Both sibling command modules do the same on every send.
        body = Path(archive_commands.__file__).read_text(encoding="utf-8")
        sends = body.count("interaction.response.send_message(") + body.count(
            "interaction.followup.send("
        )
        self.assertEqual(
            body.count("allowed_mentions=discord.AllowedMentions.none()"),
            sends,
            "every send must refuse mentions — the bot sets no global default",
        )


class ReportingADryRun(unittest.TestCase):
    def test_no_verdict_claims_a_write_during_a_dry_run(self):
        # The option's whole promise is that nothing was written, so a caption
        # reading "Synced" under it is the one sentence it must never produce.
        for code in (0, 1, 2, -1):
            said = archive_commands.verdict(code, dry_run=True)
            self.assertNotIn("Synced", said, f"exit {code} claims a write")

    def test_exit_one_does_not_assert_the_sheet_was_read(self):
        # sync-archive runs `await main()` with no catch, so an uncaught throw
        # — an unshared sheet, a renamed tab, a dead network — exits 1 exactly
        # like the rows-would-not-write case. From out here they are the same
        # number, so the wording must cover both.
        said = archive_commands.verdict(1, dry_run=False)
        self.assertNotIn("Synced what it could", said)
        self.assertIn("terminal", said, "it still sends somebody to look")


class StartingTheProcess(unittest.IsolatedAsyncioTestCase):
    async def test_a_missing_activity_directory_says_so(self):
        # And does not blame Bun. create_subprocess_exec raises the same
        # FileNotFoundError for a missing executable and a missing cwd.
        code, message = await archive_commands.run_sync(
            dry_run=True, by="test", cwd=Path("/nope/not/here")
        )
        self.assertEqual(code, -1)
        self.assertIn("PUZZLE_ACTIVITY_DIR", message)
        self.assertNotIn("PATH", message)

    async def test_it_runs_the_safe_sync_and_never_publish(self):
        seen: dict = {}

        async def fake_exec(*argv, **kwargs):
            seen["argv"], seen["cwd"] = argv, kwargs.get("cwd")
            raise FileNotFoundError("no bun here")

        real = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        try:
            with tempfile.TemporaryDirectory() as here:
                await archive_commands.run_sync(dry_run=True, by="me", cwd=Path(here))
        finally:
            asyncio.create_subprocess_exec = real

        self.assertEqual(seen["argv"][:3], ("bun", "run", "sync-archive"))
        self.assertIn("--dry-run", seen["argv"])
        # The two tools CLAUDE.md reserves for a terminal must never appear.
        self.assertNotIn("publish-archive", seen["argv"])
        self.assertNotIn("puzzles", seen["argv"])

    async def test_the_pm2_ipc_channel_env_is_stripped(self):
        # pm2 fork mode runs this bot as a Node child and leaves
        # NODE_CHANNEL_FD (and its serialization-mode sibling) in the
        # environment even though the fd it names does not survive into a
        # grandchild. Bun's Node compatibility layer trusts that variable at
        # face value: `bun run <alias>` does a nested posix_spawn to run the
        # resolved script line, and that spawn fails outright with
        # `EBADF: Bad file descriptor (posix_spawn())` when it tries to wire
        # up an IPC channel on a fd that was never actually open here.
        # Reproduced under a throwaway pm2 fork-mode process; this is the fix.
        seen: dict = {}

        async def fake_exec(*argv, **kwargs):
            seen["env"] = kwargs.get("env")
            raise FileNotFoundError("no bun here")

        real = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        os.environ["NODE_CHANNEL_FD"] = "3"
        os.environ["NODE_CHANNEL_SERIALIZATION_MODE"] = "json"
        os.environ["A_VARIABLE_THAT_SHOULD_SURVIVE"] = "yes"
        try:
            with tempfile.TemporaryDirectory() as here:
                await archive_commands.run_sync(dry_run=True, by="me", cwd=Path(here))
        finally:
            asyncio.create_subprocess_exec = real
            del os.environ["NODE_CHANNEL_FD"]
            del os.environ["NODE_CHANNEL_SERIALIZATION_MODE"]
            del os.environ["A_VARIABLE_THAT_SHOULD_SURVIVE"]

        self.assertNotIn("NODE_CHANNEL_FD", seen["env"])
        self.assertNotIn("NODE_CHANNEL_SERIALIZATION_MODE", seen["env"])
        self.assertEqual(seen["env"]["A_VARIABLE_THAT_SHOULD_SURVIVE"], "yes")

    async def test_a_real_sync_publishes_and_a_dry_run_never_does(self):
        # Discord's sync is a published sync; a dry run must not even ask.
        seen: list = []

        async def fake_exec(*argv, **kwargs):
            seen.append(argv)
            raise FileNotFoundError("no bun here")

        real = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        try:
            with tempfile.TemporaryDirectory() as here:
                await archive_commands.run_sync(dry_run=False, by="me", cwd=Path(here))
                await archive_commands.run_sync(dry_run=True, by="me", cwd=Path(here))
        finally:
            asyncio.create_subprocess_exec = real

        self.assertIn("--publish", seen[0])
        self.assertNotIn("--dry-run", seen[0])
        self.assertIn("--dry-run", seen[1])
        self.assertNotIn("--publish", seen[1])

    async def test_a_missing_bun_blames_bun(self):
        async def fake_exec(*argv, **kwargs):
            raise FileNotFoundError("no bun here")

        real = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        try:
            with tempfile.TemporaryDirectory() as here:
                code, message = await archive_commands.run_sync(
                    dry_run=False, by="me", cwd=Path(here)
                )
        finally:
            asyncio.create_subprocess_exec = real
        self.assertEqual(code, -1)
        self.assertIn("PATH", message)


if __name__ == "__main__":
    unittest.main()


class TellingTheActivity(unittest.IsolatedAsyncioTestCase):
    def test_new_puzzles_are_named_with_when_they_reach_the_daily(self):
        said = archive_commands.describe_reload({"added": [167, 168], "held": [], "kept": []})
        self.assertIn("#167, #168", said)
        self.assertIn("from tomorrow", said)
        self.assertNotIn("restart", said)

    def test_a_held_board_is_named_and_explained(self):
        said = archive_commands.describe_reload({"added": [], "held": [8, 96], "kept": []})
        self.assertIn("#8, #96", said)
        self.assertIn("restart", said)

    def test_a_long_list_is_counted_rather_than_spelt_out(self):
        said = archive_commands.describe_reload({"added": list(range(1, 41)), "held": []})
        self.assertIn("and 25 more", said)

    async def test_an_unconfigured_bot_says_the_rows_are_published_anyway(self):
        saved = {k: os.environ.pop(k, None) for k in ("PUZZLE_API", "PUZZLE_API_KEY")}
        try:
            said = await archive_commands.reload_activity()
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v
        self.assertIn("Published", said)
        self.assertIn("next restarts", said)

    async def test_the_key_is_never_sent_in_the_clear(self):
        saved = {k: os.environ.get(k) for k in ("PUZZLE_API", "PUZZLE_API_KEY")}
        os.environ["PUZZLE_API"] = "http://puzzle.example.org"
        os.environ["PUZZLE_API_KEY"] = "secret"
        try:
            said = await archive_commands.reload_activity()
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.assertIn("not https", said)
