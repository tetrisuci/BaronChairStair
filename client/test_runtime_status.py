"""
The bot's half of the status-file contract (`activity/shared/runtime-status.ts`).

    python3 -m unittest discover -s client     # no install needed

The deploy reads this file to decide whether restarting the bot would cut
somebody off, so the things worth pinning are the ones a deploy would act on
wrongly: a field missing or misnamed (it reads as unknown and waits forever),
a torn file (the same), a write that throws (the bot goes down for the sake
of a report about the bot), and anything identifying in a file the deploy
prints. `activity/tests/runtime-status.test.ts` runs this writer and holds
what it wrote to the TypeScript reader too.
"""

import asyncio
import contextlib
import io
import json
import os
import pathlib
import re
import tempfile
import unittest
from unittest import mock

import lifecycle
import runtime_status

#: The contract's `BotStatus`, field for field, in its order.
CONTRACT_FIELDS = ("app", "pid", "buildId", "state", "startedAt", "updatedAt",
                   "lastInteractionAt", "inflight", "syncRunning")

STARTED_MS = 1_791_300_000_000


class Clock:
    def __init__(self, ms: int):
        self.ms = ms

    def __call__(self) -> int:
        return self.ms


def writer(path, life=None, *, sync=False, clock=None, build="abc1234"):
    life = life or lifecycle.Lifecycle()
    return runtime_status.StatusWriter(
        path,
        read=life.snapshot,
        sync_running=lambda: sync,
        build_id=build,
        pid=4242,
        started_at_ms=STARTED_MS,
        clock_ms=clock or Clock(STARTED_MS + 5_000),
    )


class Directory(unittest.TestCase):
    def setUp(self):
        here = tempfile.TemporaryDirectory()
        self.addCleanup(here.cleanup)
        self.dir = pathlib.Path(here.name)
        self.path = self.dir / "bot.status.json"

    def read(self) -> dict:
        return json.loads(self.path.read_text(encoding="utf-8"))


class WhatIsWritten(Directory):
    def test_every_contract_field_and_nothing_else_in_the_contracts_order(self):
        writer(self.path).write()
        self.assertEqual(tuple(self.read()), CONTRACT_FIELDS)

    def test_a_fresh_bot_is_starting_idle_and_has_handled_nothing(self):
        writer(self.path).write()
        status = self.read()
        self.assertEqual(status["app"], "bot")
        self.assertEqual(status["pid"], 4242)
        self.assertEqual(status["buildId"], "abc1234")
        self.assertEqual(status["state"], "starting")
        self.assertEqual(status["startedAt"], STARTED_MS)
        self.assertEqual(status["updatedAt"], STARTED_MS + 5_000)
        self.assertIsNone(status["lastInteractionAt"])
        self.assertEqual(status["inflight"], 0)
        self.assertIs(status["syncRunning"], False)

    def test_counts_and_state_follow_the_lifecycle(self):
        life = lifecycle.Lifecycle(wall_ms=Clock(STARTED_MS + 1_000))
        life.mark_ready()
        life.admit(("interaction", 1))
        life.admit(("interaction", 2))
        writer(self.path, life).write()
        status = self.read()
        self.assertEqual(status["state"], "ready")
        self.assertEqual(status["inflight"], 2)
        self.assertEqual(status["lastInteractionAt"], STARTED_MS + 1_000)

    def test_sync_running_is_asked_at_each_write(self):
        running = {"now": False}
        status = runtime_status.StatusWriter(
            self.path, read=lifecycle.Lifecycle().snapshot,
            sync_running=lambda: running["now"], build_id="x", pid=1,
            started_at_ms=STARTED_MS, clock_ms=Clock(STARTED_MS))
        status.write()
        self.assertIs(self.read()["syncRunning"], False)
        running["now"] = True
        status.write()
        self.assertIs(self.read()["syncRunning"], True)

    def test_counts_only_never_an_id_or_a_name(self):
        # The keys an interaction was tracked under are snowflakes; none of
        # them may reach a file the deploy prints from the shared directory.
        life = lifecycle.Lifecycle()
        life.admit(("interaction", 1_234_567_890_123_456_789))
        life.begin(("message", 987_654_321_098_765_432))
        writer(self.path, life).write()
        text = self.path.read_text(encoding="utf-8")
        self.assertNotIn("1234567890123456789", text)
        self.assertNotIn("987654321098765432", text)
        for value in self.read().values():
            self.assertIsInstance(value, (int, bool, str, type(None)))
        self.assertEqual({k for k, v in self.read().items() if isinstance(v, str)},
                         {"app", "buildId", "state"})

    def test_epoch_milliseconds_are_whole_numbers(self):
        # The reader accepts any positive finite number for a time, but a pid
        # or a count must be a safe integer; keeping all of them ints is the
        # simple way never to write 1.5 interactions.
        writer(self.path, clock=Clock(STARTED_MS + 5_000)).write()
        for field in ("pid", "startedAt", "updatedAt", "inflight"):
            self.assertIsInstance(self.read()[field], int)
        self.assertEqual(runtime_status.epoch_ms(1_791_300_000.0007), 1_791_300_000_000)


class Atomically(Directory):
    def test_the_file_is_swapped_in_whole_from_a_temp_file_in_the_same_directory(self):
        self.path.write_text("old", encoding="utf-8")
        seen = {}
        real_replace = os.replace

        def replace(source, target):
            seen["source"], seen["target"] = pathlib.Path(source), pathlib.Path(target)
            # Until the swap, a reader still sees the whole old file.
            seen["before"] = self.path.read_text(encoding="utf-8")
            seen["staged"] = pathlib.Path(source).read_text(encoding="utf-8")
            real_replace(source, target)

        with mock.patch.object(runtime_status.os, "replace", side_effect=replace):
            writer(self.path).write()

        # Same directory, so the rename is one filesystem's atomic rename and
        # never a copy across devices.
        self.assertEqual(seen["source"].parent, self.path.parent)
        self.assertEqual(seen["target"], self.path)
        self.assertEqual(seen["before"], "old")
        self.assertEqual(json.loads(seen["staged"])["app"], "bot")

    def test_no_temp_file_is_left_behind(self):
        status = writer(self.path)
        for _ in range(3):
            status.write()
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), [self.path.name])

    def test_a_failed_swap_removes_its_temp_file_and_keeps_the_old_status(self):
        self.path.write_text("old", encoding="utf-8")
        with mock.patch.object(runtime_status.os, "replace", side_effect=OSError("disk")):
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertFalse(writer(self.path).write())
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), [self.path.name])
        self.assertEqual(self.path.read_text(encoding="utf-8"), "old")


class NeverTakesTheBotDown(Directory):
    def test_a_missing_directory_is_logged_once_and_never_raised(self):
        status = writer(self.dir / "missing" / "bot.status.json")
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            for _ in range(5):
                self.assertFalse(status.write())
        self.assertEqual(log.getvalue().count("status file"), 1, log.getvalue())

    def test_a_recovery_is_said_and_a_later_failure_is_logged_again(self):
        target = self.dir / "later" / "bot.status.json"
        status = writer(target)
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            status.write()
            target.parent.mkdir()
            self.assertTrue(status.write())
            with mock.patch.object(runtime_status.os, "replace", side_effect=OSError("full")):
                status.write()
                status.write()
        lines = [line for line in log.getvalue().splitlines() if line]
        self.assertEqual(len(lines), 3, lines)
        self.assertIn("writing again", lines[1])

    def test_unset_writes_nothing_at_all(self):
        status = writer(None)
        self.assertFalse(status.write())
        self.assertEqual(list(self.dir.iterdir()), [])


class FromTheEnvironment(Directory):
    def build(self, environ):
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            status = runtime_status.StatusWriter.from_environ(
                environ, read=lifecycle.Lifecycle().snapshot, sync_running=lambda: False)
        return status, log.getvalue()

    def test_status_file_and_build_id_come_from_the_contracts_variables(self):
        status, _ = self.build({"STATUS_FILE": str(self.path), "BUILD_ID": "8dd0c4d"})
        status.write()
        self.assertEqual(self.read()["buildId"], "8dd0c4d")
        self.assertEqual(self.read()["pid"], os.getpid())

    def test_no_build_id_is_a_development_run(self):
        status, _ = self.build({"STATUS_FILE": str(self.path), "BUILD_ID": "  "})
        status.write()
        self.assertEqual(self.read()["buildId"], "dev")

    def test_unset_status_file_is_no_status_file(self):
        status, log = self.build({})
        self.assertIsNone(status.path)
        self.assertEqual(log, "")

    def test_a_relative_status_file_is_refused_and_said_not_guessed(self):
        status, log = self.build({"STATUS_FILE": "bot.status.json"})
        self.assertIsNone(status.path)
        self.assertIn("absolute", log)


class Periodically(Directory):
    def test_it_rewrites_on_its_interval_until_cancelled(self):
        clock = Clock(STARTED_MS)
        status = writer(self.path, clock=clock)
        updates = []

        async def scenario():
            task = asyncio.create_task(status.run(interval_s=0.01))
            for step in range(3):
                clock.ms = STARTED_MS + step
                await asyncio.sleep(0.03)
                updates.append(self.read()["updatedAt"])
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

        asyncio.run(scenario())
        self.assertEqual(updates, [STARTED_MS, STARTED_MS + 1, STARTED_MS + 2])

    def test_the_interval_is_the_contracts(self):
        # Read from the contract itself rather than restated: a bot that wrote
        # less often than the game expects would read as stale and be waited on.
        contract = (pathlib.Path(__file__).resolve().parent.parent
                    / "activity" / "shared" / "runtime-status.ts").read_text(encoding="utf-8")
        (interval_ms,) = re.findall(r"STATUS_INTERVAL_MS = ([\d_]+);", contract)
        self.assertEqual(runtime_status.INTERVAL_S * 1000, int(interval_ms.replace("_", "")))


if __name__ == "__main__":
    unittest.main()
