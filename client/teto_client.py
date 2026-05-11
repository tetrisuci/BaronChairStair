"""
teto_client.py
~~~~~~~~~~~~~~
Python client for the teto-python bridge server.

Spawns a Bun subprocess running server.ts and communicates with it
over stdin/stdout using newline-delimited JSON (NDJSON).

Usage:
    from teto_client import TetoClient

    with TetoClient() as client:
        result = client.parse_replay(open("game.ttrm").read())
        for clear in result["clears"]:
            print(f"{clear['username']} {clear['clearType']} at {clear['timeSeconds']}s")
"""

from __future__ import annotations

import json
import subprocess
import threading
import itertools
from pathlib import Path
from typing import Any


# ─── Exceptions ───────────────────────────────────────────────────────────────

class TetoError(Exception):
    """Raised when the teto server returns an error response."""


class TetoServerNotRunning(RuntimeError):
    """Raised when a request is made but the server is not started."""


# ─── Client ───────────────────────────────────────────────────────────────────

class TetoClient:
    """
    Manages a long-lived Bun subprocess running server.ts.

    All public methods are thread-safe — a lock ensures that only one
    request is in flight at a time (the underlying protocol is serial).

    Args:
        server_dir: Path to the directory containing server.ts.
                    Defaults to a 'server' folder next to this file.
        bun_path:   Path to the bun executable. Defaults to 'bun' (assumes
                    it is on PATH).
    """

    def __init__(
        self,
        server_dir: str | Path | None = None,
        bun_path: str = "bun",
    ):
        if server_dir is None:
            server_dir = Path(__file__).parent / "server"
        self.server_dir = Path(server_dir)
        self.bun_path = bun_path

        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._id_counter = itertools.count(1)

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def start(self) -> "TetoClient":
        """
        Spawn the Bun server subprocess and wait for it to signal readiness.
        Returns self so you can write: client = TetoClient().start()
        """
        self._proc = subprocess.Popen(
            [self.bun_path, "server.ts"],
            cwd=self.server_dir,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,  # line-buffered
        )

        # Wait for the ready signal
        ready_line = self._proc.stdout.readline()
        if not ready_line:
            stderr = self._proc.stderr.read()
            raise RuntimeError(
                f"Server exited before sending ready signal.\nstderr:\n{stderr}"
            )

        ready = json.loads(ready_line.strip())
        if ready.get("type") != "ready":
            raise RuntimeError(f"Unexpected server startup message: {ready}")

        return self

    def stop(self) -> None:
        """Terminate the Bun subprocess cleanly."""
        if self._proc is not None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None

    def __enter__(self) -> "TetoClient":
        return self.start()

    def __exit__(self, *_: Any) -> None:
        self.stop()

    # ── Core RPC ──────────────────────────────────────────────────────────────

    def _request(self, action: str, **kwargs: Any) -> dict:
        """Send one request and return the parsed response. Thread-safe."""
        if self._proc is None:
            raise TetoServerNotRunning(
                "Call .start() (or use 'with TetoClient()') before making requests."
            )

        req_id = str(next(self._id_counter))
        payload = json.dumps({"id": req_id, "action": action, **kwargs})

        with self._lock:
            self._proc.stdin.write(payload + "\n")
            self._proc.stdin.flush()
            raw = self._proc.stdout.readline()

        if not raw:
            stderr = self._proc.stderr.read()
            raise RuntimeError(
                f"Server closed stdout unexpectedly.\nstderr:\n{stderr}"
            )

        response = json.loads(raw.strip())

        if response.get("status") == "error":
            raise TetoError(response.get("message", "Unknown server error"))

        return response

    # ── Public API ────────────────────────────────────────────────────────────

    def parse_replay(self, replay_json: str) -> dict:
        """
        Parse a TETR.IO replay and return all line clear events with timestamps.

        Args:
            replay_json: The raw JSON string from a .ttrm replay file.

        Returns:
            A dict with a 'clears' key containing a list of clear event dicts.
            Each clear event has:
                playerId    str   — internal TETR.IO player ID
                username    str   — display name
                round       int   — which round of the match (0-indexed)
                frame       int   — game frame (60fps)
                timeSeconds float — frame / 60, i.e. in-game clock in seconds
                piece       str   — piece that caused the clear (I/O/T/L/J/S/Z)
                clearType   str   — one of: single, double, triple, quad,
                                   tspinSingle, tspinDouble, tspinTriple,
                                   allspin, perfectClear
                linesCleared    int
                garbageCleared  int   — garbage lines cleared
                attack          int   — attack generated before cancels
                attackSent      int   — attack actually sent after cancels
                isBTB           bool
                b2b             int   — BTB counter at time of clear (-1 = none)
                combo           int   — combo counter (-1 = none)

        Raises:
            TetoError: if the server cannot parse the replay.
        """
        return self._request("parse_replay", replay=replay_json)

    def parse_replay_file(self, path: str | Path) -> dict:
        """
        Convenience wrapper: read a .ttrm file from disk and parse it.

        Args:
            path: Path to the .ttrm file.
        """
        content = Path(path).read_text(encoding="utf-8")
        return self.parse_replay(content)