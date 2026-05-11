"""
example.py
~~~~~~~~~~
Demonstrates using TetoClient to extract and analyse clear events
from one or more TETR.IO replay files.
"""

import sys
from pathlib import Path
from collections import defaultdict

# Make sure the client module is importable from this directory
sys.path.insert(0, str(Path(__file__).parent))

from teto_client import TetoClient, TetoError


def summarise(clears: list[dict]) -> None:
    """Print a simple per-player clear breakdown."""
    by_player: dict[str, list[dict]] = defaultdict(list)
    for c in clears:
        by_player[c["username"]].append(c)

    for username, events in by_player.items():
        print(f"\n── {username} ─────────────────────────────")
        print(f"  Total clears : {len(events)}")

        by_type: dict[str, int] = defaultdict(int)
        for e in events:
            by_type[e["clearType"]] += 1

        for clear_type, count in sorted(by_type.items(), key=lambda x: -x[1]):
            print(f"  {clear_type:<20} {count}")

        btb_clears = [e for e in events if e["isBTB"]]
        print(f"  BTB clears   : {len(btb_clears)}")

        if events:
            avg_attack = sum(e["attack"] for e in events) / len(events)
            print(f"  Avg attack   : {avg_attack:.2f}")


def timeline(clears: list[dict], username: str) -> None:
    """Print a timestamped list of clears for one player, grouped by round."""
    player_clears = [c for c in clears if c["username"] == username]
    print(f"\n── {username} clear timeline ───────────────")

    current_round = None
    for c in player_clears:
        if c["round"] != current_round:
            current_round = c["round"]
            print(f"\n  Round {current_round + 1}")

        btb_str = f" (BTB {c['b2b']})" if c["isBTB"] and c["b2b"] >= 0 else ""
        combo_str = f" combo {c['combo']}" if c["combo"] > 0 else ""
        print(
            f"    {c['timeSeconds']:>8.3f}s  "
            f"{c['clearType']:<20} "
            f"+{c['attack']} atk"
            f"{btb_str}{combo_str}"
        )


def main(replay_path: str) -> None:
    # Point this at the server directory containing server.ts
    server_dir = Path(__file__).parent.parent / "server"

    print(f"Starting teto server (server dir: {server_dir})...")

    with TetoClient(server_dir=server_dir) as client:
        print(f"Parsing: {replay_path}")
        try:
            result = client.parse_replay_file(replay_path)
        except TetoError as e:
            print(f"Parse error: {e}")
            return

        clears = result["clears"]
        print(f"Found {len(clears)} clear events across all rounds.\n")

        summarise(clears)

        # Print a timeline for every player
        usernames = list(dict.fromkeys(c["username"] for c in clears))
        for username in usernames:
            timeline(clears, username)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python example.py <path/to/replay.ttrm>")
        sys.exit(1)
    main(sys.argv[1])