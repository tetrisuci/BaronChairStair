"""
What the bot is doing, and how it stops: `lifecycle.py`.

    python3 -m unittest discover -s client     # no install needed

Two promises are pinned here. The count of interactions in flight is right —
it rises and falls once per interaction however many times either end is
reported, and it cannot stick above zero forever, because a stuck count would
make every stop wait out its whole grace and every deploy believe the bot is
busy. And a stop is polite: it refuses new work, waits for what is running,
closes, and exits 0 — and a second signal does not wait.

The last class runs a real process and sends it real signals, because a
handler that is installed on the wrong loop, or not at all, passes every test
that only calls it.
"""

import ast
import asyncio
import contextlib
import io
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

import lifecycle

CLIENT = pathlib.Path(__file__).resolve().parent


class Ticks:
    """A clock the test moves by hand."""

    def __init__(self, value: float = 0.0):
        self.value = value

    def __call__(self) -> float:
        return self.value


class Counting(unittest.TestCase):
    def setUp(self):
        self.wall = Ticks(1_791_300_000_000)
        self.mono = Ticks(100.0)
        self.life = lifecycle.Lifecycle(wall_ms=self.wall, monotonic=self.mono)

    def test_a_new_bot_is_starting_with_nothing_in_flight(self):
        self.assertEqual(self.life.snapshot(),
                         lifecycle.Snapshot(state="starting", inflight=0, last_interaction_at=None))

    def test_an_interaction_counts_from_its_start_to_its_finish(self):
        self.assertTrue(self.life.admit(("interaction", 1)))
        self.assertEqual(self.life.snapshot().inflight, 1)
        self.life.finish(("interaction", 1))
        self.assertEqual(self.life.snapshot().inflight, 0)

    def test_finishing_twice_or_finishing_a_stranger_changes_nothing(self):
        # discord.py reports an end through more than one hook; the count must
        # not go below what is really running.
        self.life.admit(("interaction", 1))
        self.life.admit(("interaction", 2))
        self.life.finish(("interaction", 1))
        self.life.finish(("interaction", 1))
        self.life.finish(("interaction", 99))
        self.assertEqual(self.life.snapshot().inflight, 1)

    def test_the_last_interaction_is_stamped_when_one_starts_and_when_it_ends(self):
        self.life.admit(("interaction", 1))
        self.assertEqual(self.life.snapshot().last_interaction_at, 1_791_300_000_000)
        self.wall.value += 4_000
        self.life.finish(("interaction", 1))
        self.assertEqual(self.life.snapshot().last_interaction_at, 1_791_300_004_000)

    def test_ready_once_connected_and_reconnects_change_nothing(self):
        self.life.mark_ready()
        self.life.mark_ready()
        self.assertEqual(self.life.state, "ready")

    def test_stopping_is_final(self):
        self.assertTrue(self.life.begin_stop())
        self.assertFalse(self.life.begin_stop())
        self.life.mark_ready()  # a reconnect during the stop
        self.assertEqual(self.life.state, "stopping")

    def test_while_stopping_new_interactions_are_not_admitted_or_counted(self):
        self.life.begin_stop()
        self.assertFalse(self.life.admit(("interaction", 5)))
        self.assertEqual(self.life.snapshot(),
                         lifecycle.Snapshot(state="stopping", inflight=0, last_interaction_at=None))

    def test_begin_counts_even_while_stopping(self):
        # A prefix command that was already being parsed when the stop began
        # cannot be turned back from its before-invoke hook, so it is counted.
        self.life.begin_stop()
        self.life.begin(("message", 7))
        self.assertEqual(self.life.snapshot().inflight, 1)

    def test_an_interaction_no_hook_ever_finished_stops_counting_after_the_ceiling(self):
        self.life.admit(("interaction", 1))
        self.mono.value += lifecycle.ABANDONED_AFTER_S - 1
        self.assertEqual(self.life.snapshot().inflight, 1)
        self.mono.value += 2
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            self.assertEqual(self.life.snapshot().inflight, 0)
            self.assertEqual(self.life.snapshot().inflight, 0)
        self.assertEqual(log.getvalue().count("no longer counted"), 1)

    def test_the_ceiling_outlasts_the_longest_command(self):
        # /archive sync: its own timeout, then the reload's. Read from the
        # source, because importing archive_commands needs discord.py.
        tree = ast.parse((CLIENT / "archive_commands.py").read_text(encoding="utf-8"))
        constants = {target.id: node.value.value for node in tree.body
                     if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                     for target in node.targets if isinstance(target, ast.Name)}
        longest = constants["SYNC_TIMEOUT_S"] + constants["RELOAD_TIMEOUT_S"]
        self.assertGreater(lifecycle.ABANDONED_AFTER_S, 2 * longest)

    def test_listeners_hear_each_change_of_state_once(self):
        heard = []
        self.life.on_change(heard.append)
        self.life.admit(("interaction", 1))  # a count, not a state
        self.life.mark_ready()
        self.life.mark_ready()
        self.life.begin_stop()
        self.life.begin_stop()
        self.assertEqual([s.state for s in heard], ["ready", "stopping"])

    def test_a_listener_that_raises_does_not_stop_the_change(self):
        def broken(_snapshot):
            raise OSError("disk")

        self.life.on_change(broken)
        with contextlib.redirect_stderr(io.StringIO()):
            self.life.mark_ready()
        self.assertEqual(self.life.state, "ready")


class WaitingForIdle(unittest.IsolatedAsyncioTestCase):
    async def test_idle_already_returns_at_once(self):
        life = lifecycle.Lifecycle()
        self.assertTrue(await life.wait_idle(0))

    async def test_it_returns_when_the_last_interaction_finishes(self):
        life = lifecycle.Lifecycle()
        life.admit(("interaction", 1))
        life.admit(("interaction", 2))
        asyncio.get_running_loop().call_later(0.01, life.finish, ("interaction", 1))
        asyncio.get_running_loop().call_later(0.02, life.finish, ("interaction", 2))
        started = time.monotonic()
        self.assertTrue(await life.wait_idle(5))
        self.assertLess(time.monotonic() - started, 1)

    async def test_it_gives_up_at_the_limit(self):
        life = lifecycle.Lifecycle()
        life.admit(("interaction", 1))
        self.assertFalse(await life.wait_idle(0.02))
        self.assertEqual(life.snapshot().inflight, 1)


class Grace(unittest.TestCase):
    def grace(self, environ):
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            return lifecycle.shutdown_grace_s(environ), log.getvalue()

    def test_twenty_seconds_unless_told(self):
        self.assertEqual(self.grace({}), (20.0, ""))
        self.assertEqual(self.grace({"BOT_SHUTDOWN_GRACE_S": " "}), (20.0, ""))

    def test_a_number_of_seconds_is_taken(self):
        self.assertEqual(self.grace({"BOT_SHUTDOWN_GRACE_S": "45"})[0], 45.0)
        self.assertEqual(self.grace({"BOT_SHUTDOWN_GRACE_S": "2.5"})[0], 2.5)
        self.assertEqual(self.grace({"BOT_SHUTDOWN_GRACE_S": "0"})[0], 0.0)

    def test_nonsense_falls_back_to_the_default_and_says_so(self):
        for value in ("soon", "-5", "nan", "inf"):
            with self.subTest(value=value):
                grace, log = self.grace({"BOT_SHUTDOWN_GRACE_S": value})
                self.assertEqual(grace, 20.0)
                self.assertIn("BOT_SHUTDOWN_GRACE_S", log)


class Closer:
    def __init__(self):
        self.calls = 0

    async def __call__(self):
        self.calls += 1


class StoppingPolitely(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.life = lifecycle.Lifecycle()
        self.life.mark_ready()
        self.close = Closer()
        self.log = io.StringIO()
        quiet = contextlib.redirect_stderr(self.log)
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)

    async def test_with_nothing_in_flight_it_closes_straight_away(self):
        await lifecycle.stop_gracefully(self.life, self.close, grace_s=5)
        self.assertEqual(self.life.state, "stopping")
        self.assertEqual(self.close.calls, 1)

    async def test_it_waits_for_what_is_running_then_closes(self):
        self.life.admit(("interaction", 1))
        stop = asyncio.create_task(lifecycle.stop_gracefully(self.life, self.close, grace_s=5))
        await asyncio.sleep(0.02)
        self.assertEqual(self.life.state, "stopping")
        self.assertEqual(self.close.calls, 0, "closed with an interaction still running")
        self.life.finish(("interaction", 1))
        await asyncio.wait_for(stop, 1)
        self.assertEqual(self.close.calls, 1)

    async def test_past_the_grace_it_closes_anyway_and_says_how_many_it_cut(self):
        self.life.admit(("interaction", 1))
        await asyncio.wait_for(
            lifecycle.stop_gracefully(self.life, self.close, grace_s=0.02), 1)
        self.assertEqual(self.close.calls, 1)
        self.assertIn("1 still running", self.log.getvalue())

    async def test_one_signal_stops_gracefully_and_a_second_closes_at_once(self):
        self.life.admit(("interaction", 1))
        stop = lifecycle.SignalStop(self.life, self.close, grace_s=60)
        stop.handle("SIGTERM")
        await asyncio.sleep(0.02)
        self.assertTrue(stop.requested)
        self.assertEqual(self.close.calls, 0)
        stop.handle("SIGINT")
        await asyncio.sleep(0.02)
        self.assertEqual(self.close.calls, 1)

    async def test_installing_on_the_running_loop_takes_both_stop_signals(self):
        loop = asyncio.get_running_loop()
        stop = lifecycle.SignalStop(self.life, self.close, grace_s=1)
        self.addCleanup(loop.remove_signal_handler, signal.SIGTERM)
        self.addCleanup(loop.remove_signal_handler, signal.SIGINT)
        self.assertTrue(stop.install(loop))
        self.assertEqual(lifecycle.STOP_SIGNALS, (signal.SIGTERM, signal.SIGINT))


#: A stand-in for discord.py's Bot, as much of it as `serve` touches: an async
#: context manager whose `start` runs until `close`. The lifecycle is driven
#: from inside `start`, where on_ready would drive it.
CHILD = textwrap.dedent("""
    import asyncio, os, sys
    sys.path.insert(0, sys.argv[1])
    import lifecycle, runtime_status

    HOLD = sys.argv[3] == "hold"
    CANCEL_ON_CLOSE = sys.argv[3] == "cancel-on-close"
    LIFE = lifecycle.Lifecycle()

    class Bot:
        def __init__(self):
            self.closed = None

        async def __aenter__(self):
            self.closed = asyncio.Event()
            return self

        async def __aexit__(self, *exc):
            await self.close()

        async def start(self, token):
            LIFE.mark_ready()
            if HOLD:
                LIFE.admit(("interaction", 1))
            print("ready", flush=True)
            await self.closed.wait()
            if CANCEL_ON_CLOSE:
                # What aiohttp does when its connector is closed under a DNS
                # lookup: the lookup's CancelledError escapes into the login.
                raise asyncio.CancelledError()

        async def close(self):
            self.closed.set()

    status = runtime_status.StatusWriter.from_environ(
        os.environ, read=LIFE.snapshot, sync_running=lambda: False)
    asyncio.run(lifecycle.serve(Bot(), "token", lifecycle=LIFE, status=status,
                                grace_s=float(sys.argv[2])))
    print("exited cleanly", flush=True)
""")


class ARealProcess(unittest.TestCase):
    def run_child(self, grace: float, hold, signals: list[int]):
        here = tempfile.TemporaryDirectory()
        self.addCleanup(here.cleanup)
        status_path = pathlib.Path(here.name) / "bot.status.json"
        env = {**os.environ, "STATUS_FILE": str(status_path), "BUILD_ID": "test"}
        child = subprocess.Popen(
            [sys.executable, "-c", CHILD, str(CLIENT), str(grace),
             hold if isinstance(hold, str) else ("hold" if hold else "idle")],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        self.addCleanup(child.kill)
        self.assertEqual(child.stdout.readline().strip(), "ready")
        started = time.monotonic()
        for number in signals:
            child.send_signal(number)
            time.sleep(0.2)
        out, err = child.communicate(timeout=15)
        return child.returncode, time.monotonic() - started, out, err, status_path

    def test_sigterm_with_nothing_running_exits_0_at_once(self):
        code, took, out, err, status_path = self.run_child(30, False, [signal.SIGTERM])
        self.assertEqual(code, 0, err)
        self.assertIn("exited cleanly", out)
        self.assertLess(took, 5)
        self.assertEqual(json.loads(status_path.read_text())["state"], "stopping")

    def test_sigint_is_the_same_stop_not_a_keyboard_interrupt(self):
        code, took, out, err, _ = self.run_child(30, False, [signal.SIGINT])
        self.assertEqual(code, 0, err)
        self.assertNotIn("KeyboardInterrupt", err)
        self.assertLess(took, 5)

    def test_an_interaction_that_never_ends_holds_the_stop_for_the_grace_only(self):
        code, took, _, err, _ = self.run_child(1.0, True, [signal.SIGTERM])
        self.assertEqual(code, 0, err)
        self.assertGreaterEqual(took, 0.9)
        self.assertLess(took, 6)
        self.assertIn("1 still running", err)

    def test_a_stop_that_cancels_discords_login_is_still_a_clean_exit(self):
        # Seen against real discord.py: SIGINT during the login closed the
        # HTTP session under a DNS lookup, CancelledError escaped bot.start,
        # and the stop that was asked for exited 1 with a traceback.
        code, took, out, err, _ = self.run_child(30, "cancel-on-close", [signal.SIGINT])
        self.assertEqual(code, 0, err)
        self.assertIn("exited cleanly", out)
        self.assertNotIn("Traceback", err)

    def test_a_second_signal_does_not_wait_out_the_grace(self):
        code, took, _, err, _ = self.run_child(60, True, [signal.SIGTERM, signal.SIGTERM])
        self.assertEqual(code, 0, err)
        self.assertLess(took, 10)


if __name__ == "__main__":
    unittest.main()
