"""
build_snapshots.py
~~~~~~~~~~~~~~~~~~
Parses a TETR.IO replay and saves a 2D list of SecondSnapshot objects to disk.

Usage:
    python build_snapshots.py <path/to/replay.ttrm>

Output:
    <replay_name>.pkl  — a pickle file in the same directory as the replay.

Structure of the saved object:
    rounds: list[list[SecondSnapshot]]

    rounds[r]    — all SecondSnapshots for round r, sorted by (second, username).
    rounds[r][i] — the i-th snapshot in that round (a single player's window).

    For a match with R rounds and P players, each lasting T seconds, rounds[r]
    will contain P × T SecondSnapshot objects (one per player per second).

Loading the saved file:
    import pickle
    from build_snapshots import SecondSnapshot   # needed for unpickling

    with open("replay.pkl", "rb") as f:
        rounds = pickle.load(f)

    snap = rounds[0][0]   # first second, first player, round 0
    print(snap.username, snap.second, snap.total_attack)
"""

import sys
import pickle
from pathlib import Path
from math import floor
from collections import defaultdict
from dataclasses import dataclass, field

sys.path.insert(0, str(Path(__file__).parent))

from teto_client import TetoClient, TetoError


# ── SecondSnapshot (mirrored from example.py for standalone use) ──────────────

@dataclass
class SecondSnapshot:
    """
    All line clears that occurred within a single one-second window of a replay,
    for one player in one round.
    """
    username: str
    round: int
    second: int
    clears: list[dict] = field(default_factory=list)

    @property
    def total_lines(self) -> int:
        return sum(c["linesCleared"] for c in self.clears)

    @property
    def total_attack(self) -> int:
        return sum(c["attack"] for c in self.clears)

    @property
    def clear_types(self) -> dict[str, int]:
        counts: dict[str, int] = defaultdict(int)
        for c in self.clears:
            counts[c["clearType"]] += 1
        return dict(counts)

    @property
    def boards(self) -> list[list[list[str | None]]]:
        """Board state after each clear in this window, in chronological order."""
        return [c["board"] for c in self.clears]

    @property
    def board_after(self) -> list[list[str | None]] | None:
        """Board state after the last clear in this window, or None."""
        return self.boards[-1] if self.boards else None

    def __repr__(self) -> str:
        return (
            f"SecondSnapshot(username={self.username!r}, round={self.round}, "
            f"second={self.second}, clears={len(self.clears)}, "
            f"attack={self.total_attack})"
        )


# ── Core logic ────────────────────────────────────────────────────────────────

def build_rounds(clears: list[dict]) -> list[list[SecondSnapshot]]:
    """
    Build the 2D SecondSnapshot structure from a flat list of clear events.

    Returns:
        rounds[r][i] — the i-th snapshot in round r, sorted by (second, username).
        Every second from 0 to the last clear second is represented for each
        player, including seconds where no clears occurred.
    """
    # Find how many rounds exist and the last active second per (round, username)
    last_second: dict[tuple[int, str], int] = {}
    for c in clears:
        key = (c["round"], c["username"])
        last_second[key] = max(last_second.get(key, 0), floor(c["timeSeconds"]))

    num_rounds = max((r for r, _ in last_second), default=-1) + 1

    # Pre-populate every (round, username, second) bucket
    buckets: dict[tuple[int, str, int], SecondSnapshot] = {}
    for (round_, username), end in last_second.items():
        for s in range(end + 1):
            buckets[(round_, username, s)] = SecondSnapshot(
                username=username,
                round=round_,
                second=s,
            )

    # Fill in the clears
    for c in clears:
        key = (c["round"], c["username"], floor(c["timeSeconds"]))
        buckets[key].clears.append(c)

    # Group into rounds, sorted by (second, username) within each round
    rounds: list[list[SecondSnapshot]] = [[] for _ in range(num_rounds)]
    for snap in sorted(buckets.values(), key=lambda s: (s.round, s.second, s.username)):
        rounds[snap.round].append(snap)

    return rounds


def main(replay_path: str) -> None:
    path = Path(replay_path)
    server_dir = Path(__file__).parent.parent / "server"
    output_path = path.with_suffix(".pkl")

    with TetoClient(server_dir=server_dir) as client:
        try:
            result = client.parse_replay_file(path)
        except TetoError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)

    rounds = build_rounds(result["clears"])

    with open(output_path, "wb") as f:
        pickle.dump(rounds, f)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python build_snapshots.py <path/to/replay.ttrm>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1])