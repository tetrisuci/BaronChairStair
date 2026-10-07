"""
runtime_status.py
~~~~~~~~~~~~~~~~~
The bot's status file: the bot's half of the contract in
`activity/shared/runtime-status.ts`, which says what each field means.

A deploy deciding whether it may restart the bot reads this file — the bot
has no HTTP server to ask — and it needs two answers: is this the process and
build it thinks it is, and would a restart cut anybody off. So the file says
which build and pid, whether the bot is starting, ready or stopping, how many
commands are being handled, when it last handled one, and whether
`/archive sync` is running, which a restart would cut short.

**Counts only.** The file sits in the shared directory beside the databases
and the deploy prints it, so it holds no Discord id, no name, no guild and no
token — nothing a command was tracked under reaches it, only how many.

**Written whole.** A reader must never see half a file: a torn status reads
as "unknown" and the deploy waits on it. So each write goes to a temp file in
the same directory and is swapped in with `os.replace`, which is atomic on
one filesystem. Rewritten every `INTERVAL_S` and at once on every change of
state, so a status older than the contract's stale limit means a bot that has
stopped writing — hung or gone — never one that was merely quiet.

**Never the reason the bot stops.** A failed write is logged once, and once
more when writing works again, and is otherwise ignored: the status file is
a report about the bot, and must not be what takes it down.

Stdlib only, so `activity/tests/runtime-status.test.ts` can run it with any
Python and hold its output to the TypeScript reader.
"""

import asyncio
import json
import os
import sys
import tempfile
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - annotations only
    from lifecycle import Snapshot

#: Absolute path of the status file. Unset: none is written.
ENV_STATUS_FILE = "STATUS_FILE"

#: The release's commit, set by the deploy in the process environment.
ENV_BUILD_ID = "BUILD_ID"

#: What a bot started by hand, with no deploy behind it, reports as its build.
DEV_BUILD_ID = "dev"

#: `STATUS_INTERVAL_MS` in the contract, in seconds. `test_runtime_status.py`
#: reads the contract to hold the two together.
INTERVAL_S = 5

#: rw-r--r--, what writing the file in place would have given it.
STATUS_FILE_MODE = 0o644


def epoch_ms(seconds: float) -> int:
    """Wall-clock seconds as whole epoch milliseconds, the contract's unit."""
    return int(seconds * 1000)


def now_ms() -> int:
    return epoch_ms(time.time())


def bot_status(*, pid: int, build_id: str, started_at: int, updated_at: int,
               snapshot: "Snapshot", sync_running: bool) -> dict:
    """The contract's `BotStatus`, field for field and in its order."""
    return {
        "app": "bot",
        "pid": pid,
        "buildId": build_id,
        "state": snapshot.state,
        "startedAt": started_at,
        "updatedAt": updated_at,
        "lastInteractionAt": snapshot.last_interaction_at,
        "inflight": snapshot.inflight,
        "syncRunning": bool(sync_running),
    }


def write_atomically(path: Path, text: str) -> None:
    """
    Replaces `path` with `text` in one step: a reader sees the old file or the
    new one, never part of either. The temp file is in the same directory so
    the rename never crosses a filesystem, and is removed if anything fails.
    """
    descriptor, staged = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.",
                                          suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            # mkstemp makes the file owner-only; a status file is counts only
            # and read by the deploy, so it gets the mode a plain write would.
            os.fchmod(file.fileno(), STATUS_FILE_MODE)
            file.write(text)
        os.replace(staged, path)
    except BaseException:
        try:
            os.unlink(staged)
        except OSError:
            pass
        raise


class StatusWriter:
    """Writes the bot's status to one file, when there is a file to write."""

    def __init__(
        self,
        path: Path | None,
        *,
        read: Callable[[], "Snapshot"],
        sync_running: Callable[[], bool],
        build_id: str,
        pid: int,
        started_at_ms: int,
        clock_ms: Callable[[], int] = now_ms,
    ):
        self.path = path
        self._read = read
        self._sync_running = sync_running
        self._build_id = build_id
        self._pid = pid
        self._started_at = started_at_ms
        self._clock_ms = clock_ms
        self._failing = False

    @classmethod
    def from_environ(cls, environ: Mapping[str, str], *, read: Callable[[], "Snapshot"],
                     sync_running: Callable[[], bool]) -> "StatusWriter":
        """
        `STATUS_FILE` and `BUILD_ID` from the environment, this process's pid,
        and now as its start.

        A relative `STATUS_FILE` is refused with a line in the log rather than
        resolved against the working directory: the deploy would be reading a
        different file from the one written, and would wait on it forever.
        """
        raw = environ.get(ENV_STATUS_FILE, "").strip()
        path = Path(raw) if raw else None
        if path is not None and not path.is_absolute():
            print(f"status file not written: {ENV_STATUS_FILE} must be an absolute "
                  f"path, not {raw!r}", file=sys.stderr)
            path = None
        build_id = environ.get(ENV_BUILD_ID, "").strip() or DEV_BUILD_ID
        return cls(path, read=read, sync_running=sync_running, build_id=build_id,
                   pid=os.getpid(), started_at_ms=now_ms())

    def status(self) -> dict:
        return bot_status(pid=self._pid, build_id=self._build_id,
                          started_at=self._started_at, updated_at=self._clock_ms(),
                          snapshot=self._read(), sync_running=self._sync_running())

    def write(self) -> bool:
        """Writes the status now. True if it was written; never raises."""
        if self.path is None:
            return False
        try:
            write_atomically(self.path, json.dumps(self.status()) + "\n")
        except Exception as exc:  # noqa: BLE001 — a report must not crash the bot
            if not self._failing:
                self._failing = True
                print(f"status file {self.path} not written: "
                      f"{type(exc).__name__}: {exc}", file=sys.stderr)
            return False
        if self._failing:
            self._failing = False
            print(f"status file {self.path} writing again", file=sys.stderr)
        return True

    async def run(self, interval_s: float = INTERVAL_S) -> None:
        """Writes every `interval_s` until cancelled."""
        while True:
            self.write()
            await asyncio.sleep(interval_s)
