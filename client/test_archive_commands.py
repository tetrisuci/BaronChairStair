"""
test_archive_commands.py
~~~~~~~~~~~~~~~~~~~~~~~~
`/archive sync`: open to everybody, once every ten minutes, and the process
handling under it.

Anybody may run the command, so the window is the only thing that stops it
being run in a loop, and most of what follows is about the window refusing.
A limit that is never tested is a limit that quietly stops limiting.

Importing `test_changelog_wiring` first is deliberate and is not a dependency
between suites. That module owns `_install_stubs`, which fakes discord.py and
aiohttp for a box with neither installed, and it returns early when the real
libraries are present. Reusing it is the alternative to a second, drifting copy
of the same fakes — its own comment explains why the fake `app_commands` is as
small as it is. This module then adds the two attributes it needs on top, since
`archive_commands` is the first module in the repository to use a Group.
"""

import asyncio
import contextlib
import io
import os
import sqlite3
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
import sync_window  # noqa: E402


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


#: A fixed wall clock, in UTC epoch seconds, so the timestamps are checkable.
START = 1_700_000_000.0


class Callback(unittest.IsolatedAsyncioTestCase):
    """Drives the command with no subprocess, no network and a clock it owns."""

    def setUp(self):
        self.now = START
        self._swap("_now", lambda: self.now)
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        sync_window.init_db(db)
        self.db = db
        self._swap("sync_db", db)
        # What this process remembers, apart from the database: a fresh bot.
        self._swap("_started_here", None)
        self.calls: list[dict] = []

        async def fake_sync(dry_run, by, cwd=None, on_start=None):
            self.calls.append({"dry_run": dry_run, "by": by})
            on_start()  # the process launched
            return 0, "added 0, amended 0, unchanged 163"

        self._swap("run_sync", fake_sync)
        self.reloads = 0

        async def fake_reload():
            self.reloads += 1
            return "**Live now:** #167"

        self._swap("reload_activity", fake_reload)

    def _swap(self, name, value):
        self.addCleanup(setattr, archive_commands, name, getattr(archive_commands, name))
        setattr(archive_commands, name, value)

    def later(self, seconds):
        self.now += seconds


class AnybodyMaySync(Callback):
    async def test_any_member_gets_through(self):
        interaction = Interaction(User(2002))
        await CALLBACK(interaction)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(interaction.response.deferred, "the work is announced publicly")
        self.assertEqual(len(interaction.followup.sent), 1)

    async def test_the_old_allowlist_is_gone(self):
        # A puzzle-admins.json left on a box must be harmless and unread: no
        # module reads it, and the command does not mention it.
        here = Path(archive_commands.__file__).resolve().parent
        self.assertFalse((here / "puzzle_admins.py").exists())
        self.assertFalse((here.parent / "puzzle-admins.example.json").exists())
        body = Path(archive_commands.__file__).read_text(encoding="utf-8")
        self.assertNotIn("puzzle_admins", body)
        self.assertNotIn("puzzle-admins", body)

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
        async def poisoned(dry_run, by, cwd=None, on_start=None):
            on_start()
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
        async def missing_bun(dry_run, by, cwd=None, on_start=None):
            return -1, "`bun` is not on this bot's PATH"

        archive_commands.run_sync = missing_bun
        await CALLBACK(Interaction(User(1001)))
        self.assertEqual(self.reloads, 0)


class OnceEveryTenMinutes(Callback):
    async def test_a_second_sync_inside_the_window_is_refused(self):
        await CALLBACK(Interaction(User(1001)))
        self.later(60)
        second = Interaction(User(1001))
        await CALLBACK(second)
        self.assertEqual(len(self.calls), 1, "a refused request must not start a sync")
        self.assertEqual(self.reloads, 1)
        self.assertEqual(len(second.response.messages), 1)

    async def test_the_window_is_global_across_members_and_servers(self):
        await CALLBACK(Interaction(User(1001)))
        await CALLBACK(Interaction(User(2002)))
        self.assertEqual(len(self.calls), 1)

    async def test_a_dry_run_uses_the_window_too(self):
        await CALLBACK(Interaction(User(1001)), dry_run=True)
        await CALLBACK(Interaction(User(2002)))
        self.assertEqual(len(self.calls), 1)

    async def test_the_window_opens_after_ten_minutes(self):
        await CALLBACK(Interaction(User(1001)))
        self.later(600)
        await CALLBACK(Interaction(User(2002)))
        self.assertEqual(len(self.calls), 2)

    async def test_the_refusal_is_private_and_answers_before_any_defer(self):
        # Ephemeral, because it is about the person who asked; and before any
        # defer, since deferring first would make every later followup
        # ephemeral too and post a visible "thinking" for a refusal.
        await CALLBACK(Interaction(User(1001)))
        second = Interaction(User(2002))
        await CALLBACK(second)
        self.assertTrue(second.response.messages[0]["ephemeral"])
        self.assertFalse(second.response.deferred)
        self.assertEqual(second.followup.sent, [])

    async def test_the_refusal_says_when_the_last_started_and_the_next_may(self):
        await CALLBACK(Interaction(User(1001)))
        self.later(90)
        second = Interaction(User(2002))
        await CALLBACK(second)
        said = second.response.messages[0]["content"]
        self.assertIn(f"<t:{int(START)}:R>", said)
        self.assertIn(f"<t:{int(START) + 600}:R>", said)
        self.assertIn(f"<t:{int(START) + 600}:t>", said)
        self.assertNotIn("1001", said)
        self.assertNotIn("2002", said)

    async def test_the_window_starts_when_the_sync_starts_not_when_it_ends(self):
        async def slow(dry_run, by, cwd=None, on_start=None):
            self.calls.append({"dry_run": dry_run, "by": by})
            on_start()
            self.later(240)  # four minutes of syncing
            return 0, "done"

        archive_commands.run_sync = slow
        await CALLBACK(Interaction(User(1001)))
        self.later(360)  # ten minutes after it started, six after it ended
        await CALLBACK(Interaction(User(2002)))
        self.assertEqual(len(self.calls), 2)

    async def test_a_sync_that_never_started_does_not_use_the_window(self):
        async def missing_bun(dry_run, by, cwd=None, on_start=None):
            return -1, "`bun` is not on this bot's PATH"

        archive_commands.run_sync = missing_bun
        await CALLBACK(Interaction(User(1001)))
        archive_commands.run_sync = self._fake_that_counts()
        await CALLBACK(Interaction(User(1001)))
        self.assertEqual(len(self.calls), 1, "the retry is not refused")

    async def test_a_refused_request_does_not_use_the_window(self):
        # Asking again inside the window must not push the window back.
        await CALLBACK(Interaction(User(1001)))
        self.later(300)
        await CALLBACK(Interaction(User(2002)))
        self.later(300)
        await CALLBACK(Interaction(User(2002)))
        self.assertEqual(len(self.calls), 2)

    async def test_the_window_survives_a_restart(self):
        await CALLBACK(Interaction(User(1001)))
        archive_commands._started_here = None  # a new process, same stats.db
        await CALLBACK(Interaction(User(2002)))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(sync_window.last_started(self.db), START)

    async def test_a_start_stored_ahead_of_the_clock_does_not_hold_the_window(self):
        # A clock that ran ahead and was stepped back leaves a start in the
        # future in stats.db. No officer can override the window any more, so
        # that row must not lock everybody out until the clock catches up.
        sync_window.record_start(self.db, START + 7200)
        await CALLBACK(Interaction(User(1001)))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(sync_window.last_started(self.db), START, "the row is put right")

        self.later(60)
        second = Interaction(User(2002))
        await CALLBACK(second)
        said = second.response.messages[0]["content"]
        self.assertEqual(len(self.calls), 1)
        self.assertIn(f"<t:{int(START)}:R>", said)
        self.assertIn(f"<t:{int(START) + 600}:R>", said)
        self.assertNotIn(str(int(START + 7200)), said)

    async def test_a_start_this_process_saw_ahead_of_the_clock_does_not_hold_it(self):
        archive_commands.sync_db = None
        archive_commands._started_here = START + 7200
        await CALLBACK(Interaction(User(1001)))
        self.assertEqual(len(self.calls), 1)

    async def test_a_future_stored_start_cannot_hide_the_memory_window_when_writes_fail(self):
        sync_window.record_start(self.db, START + 7200)
        self.db.execute("PRAGMA query_only = ON")
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            await CALLBACK(Interaction(User(1001)))
            self.assertEqual(len(self.calls), 1, "the future row does not prevent a sync")
            self.assertEqual(sync_window.last_started(self.db), START + 7200)

            self.later(60)
            second = Interaction(User(2002))
            await CALLBACK(second)
            self.assertEqual(len(self.calls), 1, "the new in-memory start holds the window")
            self.assertTrue(second.response.messages[0]["ephemeral"])
            self.assertFalse(second.response.deferred)
            said = second.response.messages[0]["content"]
            self.assertIn(f"<t:{int(START)}:R>", said)
            self.assertIn(f"<t:{int(START) + 600}:R>", said)
            self.assertNotIn(str(int(START + 7200)), said)

            self.later(540)
            await CALLBACK(Interaction(User(2002)))
            self.assertEqual(len(self.calls), 2, "the memory window opens at ten minutes")
            self.assertEqual(sync_window.last_started(self.db), START + 7200)

        self.assertIn("cannot record the sync window", errors.getvalue())

    async def test_with_no_database_the_window_still_holds_in_this_process(self):
        archive_commands.sync_db = None
        await CALLBACK(Interaction(User(1001)))
        await CALLBACK(Interaction(User(2002)))
        self.assertEqual(len(self.calls), 1)

    async def test_a_completed_run_says_when_the_next_may_start(self):
        interaction = Interaction(User(1001))
        await CALLBACK(interaction)
        said = interaction.followup.sent[0]["content"]
        self.assertIn(f"<t:{int(START) + 600}:R>", said)

    async def test_a_sync_that_never_started_does_not_promise_a_wait(self):
        async def missing_bun(dry_run, by, cwd=None, on_start=None):
            return -1, "`bun` is not on this bot's PATH"

        archive_commands.run_sync = missing_bun
        interaction = Interaction(User(1001))
        await CALLBACK(interaction)
        self.assertNotIn("<t:", interaction.followup.sent[0]["content"])

    async def test_a_second_sync_while_one_runs_is_refused_privately(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def held(dry_run, by, cwd=None, on_start=None):
            on_start()
            started.set()
            await release.wait()
            return 0, "done"

        archive_commands.run_sync = held
        first = asyncio.create_task(CALLBACK(Interaction(User(1001))))
        await started.wait()

        second = Interaction(User(2002))
        await CALLBACK(second)
        self.assertIn("already running", second.response.messages[0]["content"])
        self.assertTrue(second.response.messages[0]["ephemeral"])
        self.assertFalse(second.response.deferred)

        release.set()
        await first

    def _fake_that_counts(self):
        async def counted(dry_run, by, cwd=None, on_start=None):
            self.calls.append({"dry_run": dry_run, "by": by})
            on_start()
            return 0, "done"

        return counted


class TheCommandSaysSo(unittest.TestCase):
    def test_the_description_names_the_limit_and_fits(self):
        command = archive_commands.archive_sync
        description = getattr(command, "description", None)
        if description is None:
            # The stubbed decorator keeps the function, not the Command.
            self.skipTest("needs the real discord.py")
        self.assertIn("10 minutes", description)
        self.assertLessEqual(len(description), 100, "Discord's ceiling")


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

    async def test_the_start_is_reported_once_the_process_launches(self):
        # The window opens here, at the launch, and not when the sync ends.
        started: list = []

        class Launched:
            returncode = 0

            async def communicate(self):
                self.seen = len(started)
                return b"added 0", None

        launched = Launched()

        async def fake_exec(*argv, **kwargs):
            return launched

        real = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        try:
            with tempfile.TemporaryDirectory() as here:
                code, _ = await archive_commands.run_sync(
                    dry_run=True, by="me", cwd=Path(here),
                    on_start=lambda: started.append(True),
                )
        finally:
            asyncio.create_subprocess_exec = real
        self.assertEqual(code, 0)
        self.assertEqual(started, [True])
        self.assertEqual(launched.seen, 1, "reported before the output is awaited")

    async def test_nothing_is_reported_started_when_it_could_not_launch(self):
        started: list = []

        async def fake_exec(*argv, **kwargs):
            raise FileNotFoundError("no bun here")

        real = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        try:
            with tempfile.TemporaryDirectory() as here:
                await archive_commands.run_sync(
                    dry_run=False, by="me", cwd=Path(here),
                    on_start=lambda: started.append(True),
                )
            await archive_commands.run_sync(
                dry_run=False, by="me", cwd=Path("/nope/not/here"),
                on_start=lambda: started.append(True),
            )
        finally:
            asyncio.create_subprocess_exec = real
        self.assertEqual(started, [])

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
