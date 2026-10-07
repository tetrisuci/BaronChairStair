"""
lifecycle.py
~~~~~~~~~~~~
What the bot is doing right now, and how it stops.

A deploy that restarts the bot has two questions it cannot answer from
outside the process: is anybody in the middle of a command, and will a stop
be polite about it. This module answers both. It keeps the bot's state —
`starting` until Discord says ready, `ready`, then `stopping` — and a count
of the commands being handled, which `runtime_status.py` writes out for the
deploy to read. And it owns the stop: on SIGTERM or SIGINT the bot refuses
new commands with a one-line "restarting", lets the ones already running
finish for up to `BOT_SHUTDOWN_GRACE_S`, closes its Discord connection, and
exits 0. A second signal stops waiting.

Not SIGUSR1 or SIGUSR2, which `activity/shared/runtime-status.ts` rules out
for the whole repository, and not SIGHUP, which means "hand over" to the game
and has nothing to mean here: one Discord token delivers each command to one
connection, so the bot cannot hand over, only stop and start again.

**Why the count is keyed and has a ceiling.** discord.py reports the end of a
command through more than one hook — success, an error, a refusal — so a
plain counter would drift with every path reported twice or not at all. Each
command is tracked under its own key (its interaction's or message's id;
these stay in memory and never reach the status file), so finishing one twice
changes nothing. And a command no hook ever finished — a future discord.py
path that reports nothing — would hold the count above zero for good, making
every stop wait out its whole grace and every deploy believe the bot is busy.
So a command older than `ABANDONED_AFTER_S` stops being counted, with a line
in the log saying so.

Stdlib only, so it is testable on a box with no discord.py; `tracked_tree.py`
connects it to discord.py's hooks.
"""

import asyncio
import contextlib
import math
import signal
import sys
import time
from collections.abc import Awaitable, Callable, Hashable, Mapping
from dataclasses import dataclass
from typing import Literal, Protocol

State = Literal["starting", "ready", "stopping"]
STARTING: State = "starting"
READY: State = "ready"
STOPPING: State = "stopping"

#: What a command sent during a stop is told, privately. The restart is a few
#: seconds of boot, so "a few seconds" is the honest promise.
RESTARTING_MESSAGE = "Restarting — try again in a few seconds."

#: How long a stop waits for commands already running, in seconds.
GRACE_ENV = "BOT_SHUTDOWN_GRACE_S"

#: Long enough for every ordinary command — a replay parse, a GitHub call, a
#: graph — and short enough that a deploy is not held up by somebody's typing.
#: Not long enough for `/archive sync`, which can run five minutes: the deploy
#: reads `syncRunning` from the status file and waits for it before signalling.
DEFAULT_GRACE_S = 20.0

#: A command older than this is one no hook will ever finish. Twice anything
#: the bot does on purpose — `/archive sync`'s 300 s plus its 15 s reload, with
#: room — so a real command is never dropped from the count while it runs.
ABANDONED_AFTER_S = 15 * 60

#: pm2's own stop sends SIGINT; systemd and `kill` send SIGTERM. Both mean
#: "stop politely", as they do for the game (`SIGNALS.stop` in the contract).
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT)


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class Snapshot:
    """The part of the bot's state the status file reports. Counts only."""

    state: State
    inflight: int
    #: Epoch ms of the last command started or finished; None before the first.
    last_interaction_at: int | None


class Lifecycle:
    """
    The bot's state and the commands in flight, on the event loop's thread.

    `admit` is the gate for slash commands: it refuses once the bot is
    stopping, so the tree can answer "restarting" instead of running the
    command. `begin` counts unconditionally, for a prefix command that was
    already past its checks when the stop began and cannot be turned back.
    The mapping of running commands is replaced, never edited, on each change.
    """

    def __init__(
        self,
        *,
        wall_ms: Callable[[], int] = _now_ms,
        monotonic: Callable[[], float] = time.monotonic,
    ):
        self._wall_ms = wall_ms
        self._monotonic = monotonic
        self._state: State = STARTING
        self._running: Mapping[Hashable, float] = {}
        self._last_interaction_at: int | None = None
        self._listeners: tuple[Callable[[Snapshot], None], ...] = ()
        self._idle = asyncio.Event()
        self._idle.set()

    @property
    def state(self) -> State:
        return self._state

    @property
    def stopping(self) -> bool:
        return self._state == STOPPING

    def snapshot(self) -> Snapshot:
        return Snapshot(self._state, self._count(), self._last_interaction_at)

    def on_change(self, listener: Callable[[Snapshot], None]) -> None:
        """Calls `listener` with a snapshot each time the state changes."""
        self._listeners = (*self._listeners, listener)

    def mark_ready(self) -> None:
        """Discord said ready. Called from every on_ready; only the first moves it."""
        if self._state == STARTING:
            self._move(READY)

    def begin_stop(self) -> bool:
        """Stopping from now on, for good. False if it already was."""
        if self.stopping:
            return False
        self._move(STOPPING)
        return True

    def admit(self, key: Hashable) -> bool:
        """Counts a new slash command, unless the bot is stopping."""
        if self.stopping:
            return False
        self.begin(key)
        return True

    def begin(self, key: Hashable) -> None:
        """Counts a command whatever the state."""
        self._running = {**self._running, key: self._monotonic()}
        self._idle.clear()
        self._last_interaction_at = self._wall_ms()

    def finish(self, key: Hashable) -> None:
        """A command ended. Unknown or already finished keys change nothing."""
        if key not in self._running:
            return
        self._running = {k: v for k, v in self._running.items() if k != key}
        self._last_interaction_at = self._wall_ms()
        if not self._running:
            self._idle.set()

    async def wait_idle(self, timeout_s: float) -> bool:
        """Waits until nothing is in flight, for at most `timeout_s`. True if idle."""
        if self._count() == 0:
            return True
        try:
            await asyncio.wait_for(self._idle.wait(), timeout_s)
        except asyncio.TimeoutError:
            return self._count() == 0
        return True

    def _count(self) -> int:
        """The commands in flight, after dropping any past the ceiling."""
        cutoff = self._monotonic() - ABANDONED_AFTER_S
        abandoned = {k for k, started in self._running.items() if started < cutoff}
        if abandoned:
            self._running = {k: v for k, v in self._running.items() if k not in abandoned}
            # The number only: the keys are Discord ids.
            print(f"lifecycle: {len(abandoned)} command(s) ran past "
                  f"{ABANDONED_AFTER_S // 60} minutes with no end reported; "
                  "no longer counted", file=sys.stderr)
            if not self._running:
                self._idle.set()
        return len(self._running)

    def _move(self, state: State) -> None:
        self._state = state
        snapshot = self.snapshot()
        for listener in self._listeners:
            # A listener is the status file. A full disk must not stop a stop.
            try:
                listener(snapshot)
            except Exception as exc:  # noqa: BLE001 — reported, never raised
                print(f"lifecycle: a listener failed on {state}: "
                      f"{type(exc).__name__}: {exc}", file=sys.stderr)


def shutdown_grace_s(environ: Mapping[str, str]) -> float:
    """
    `BOT_SHUTDOWN_GRACE_S`, in seconds, or the default.

    Zero is allowed and means "close at once". Anything that is not a finite,
    non-negative number falls back to the default with a line saying so,
    rather than stopping the bot from starting over a deploy setting.
    """
    raw = environ.get(GRACE_ENV, "").strip()
    if not raw:
        return DEFAULT_GRACE_S
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or value < 0:
        print(f"{GRACE_ENV}={raw!r} is not a number of seconds; "
              f"using {DEFAULT_GRACE_S:g}", file=sys.stderr)
        return DEFAULT_GRACE_S
    return value


async def stop_gracefully(
    lifecycle: Lifecycle,
    close: Callable[[], Awaitable[object]],
    grace_s: float,
    hurry: asyncio.Event | None = None,
) -> None:
    """
    Refuse new commands, wait for running ones up to `grace_s`, then close.

    `hurry`, once set, ends the wait early: the second signal. Either way the
    close happens here, once, so a second signal never races the first one's
    close.
    """
    lifecycle.begin_stop()
    running = lifecycle.snapshot().inflight
    if running:
        print(f"stopping: waiting up to {grace_s:g}s for {running} command(s)",
              file=sys.stderr)
    waits = [asyncio.ensure_future(lifecycle.wait_idle(grace_s))]
    if hurry is not None:
        waits.append(asyncio.ensure_future(hurry.wait()))
    _, pending = await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    left = lifecycle.snapshot().inflight
    if left:
        print(f"stopping: {left} still running; closing anyway", file=sys.stderr)
    await close()


class SignalStop:
    """The first stop signal stops gracefully; the second stops waiting."""

    def __init__(self, lifecycle: Lifecycle, close: Callable[[], Awaitable[object]],
                 grace_s: float):
        self._lifecycle = lifecycle
        self._close = close
        self._grace_s = grace_s
        self._hurry = asyncio.Event()
        self._task: asyncio.Task | None = None

    @property
    def requested(self) -> bool:
        return self._task is not None

    def handle(self, signame: str) -> None:
        """Called on the event loop, from `loop.add_signal_handler`."""
        if self._task is None:
            print(f"{signame}: stopping; new commands are told to try again",
                  file=sys.stderr)
            self._task = asyncio.get_running_loop().create_task(
                stop_gracefully(self._lifecycle, self._close, self._grace_s, self._hurry),
                name="graceful-stop")
            return
        print(f"{signame} again: closing now", file=sys.stderr)
        self._hurry.set()

    def install(self, loop: asyncio.AbstractEventLoop,
                signals: tuple[int, ...] = STOP_SIGNALS) -> bool:
        """
        Takes `signals` on `loop`. False, with a line in the log, where the
        platform cannot: Windows has no `add_signal_handler`, and the bot
        then stops the old way, at once.
        """
        try:
            for number in signals:
                loop.add_signal_handler(number, self.handle, signal.Signals(number).name)
        except (NotImplementedError, RuntimeError) as exc:
            print(f"graceful stop unavailable here ({type(exc).__name__}); "
                  "a stop signal ends the bot at once", file=sys.stderr)
            return False
        return True


def _cancelled_from_outside() -> bool:
    """
    Whether the running task has itself been asked to cancel (3.11+ can tell),
    as opposed to a CancelledError surfacing from something the stop closed.
    """
    task = asyncio.current_task()
    cancelling = getattr(task, "cancelling", None)
    return bool(cancelling and cancelling())


class _Bot(Protocol):
    async def __aenter__(self) -> object: ...
    async def __aexit__(self, *exc: object) -> object: ...
    async def start(self, token: str) -> None: ...
    async def close(self) -> None: ...


class _Status(Protocol):
    def write(self) -> bool: ...
    async def run(self) -> None: ...


async def serve(bot: _Bot, token: str, *, lifecycle: Lifecycle, status: _Status,
                grace_s: float, signals: tuple[int, ...] = STOP_SIGNALS) -> None:
    """
    Runs the bot until it is closed, the way `bot.run` did, plus a status
    file and a polite stop. Returns normally after a stop, so the process
    exits 0.

    The status file is written from the start, while the bot is still
    `starting`: logging in and receiving every member of every server can
    take longer than the twenty seconds after which a deploy stops
    believing a status, and a stale file there would read as "unknown"
    rather than as a bot on its way up.
    """
    stop = SignalStop(lifecycle, bot.close, grace_s)
    stop.install(asyncio.get_running_loop(), signals)
    lifecycle.on_change(lambda _snapshot: status.write())
    writer = asyncio.create_task(status.run(), name="status-file")
    try:
        async with bot:
            await bot.start(token)
    except (Exception, asyncio.CancelledError) as exc:
        # Closing while discord.py is still logging in can fail the login —
        # with a connection error, or, when the session is closed under a DNS
        # lookup, with that lookup's CancelledError. That is the stop that was
        # asked for, not a crash to report as one. A cancellation of this task
        # itself is still a cancellation, and goes on up.
        if not stop.requested or _cancelled_from_outside():
            raise
        print(f"stopped while starting ({type(exc).__name__}: {exc})", file=sys.stderr)
    finally:
        writer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await writer
        lifecycle.begin_stop()
        status.write()
