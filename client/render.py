"""
render.py
~~~~~~~~~
Renders a .pkl file produced by build_snapshots.py to terminal output.

Usage:
    python render.py <path/to/replay.pkl>
    python render.py <path/to/replay.pkl> --highlights [top_x]
"""

import sys
import pickle
from pathlib import Path
from itertools import groupby

sys.path.insert(0, str(Path(__file__).parent))

from build_snapshots import SecondSnapshot


# ── Mino display characters ───────────────────────────────────────────────────

MINO_CHARS: dict[str, str] = {
    "i": "I",
    "o": "O",
    "t": "T",
    "l": "L",
    "j": "J",
    "s": "S",
    "z": "Z",
    "gb":   "░",
    "bomb": "✕",
}


# ── Rendering helpers ─────────────────────────────────────────────────────────

def render_board(board: list[list[str | None]], indent: str = "      ") -> str:
    lines = []
    for row in reversed(board):
        cells = "".join(MINO_CHARS.get(cell, ".") if cell else "." for cell in row)
        lines.append(indent + cells)
    return "\n".join(lines)


def render_clears(clears: list[dict], boards: list, show_boards: bool = True) -> None:
    for clear, board in zip(clears, boards):
        btb_str   = f" (BTB {clear['b2b']})" if clear["isBTB"] and clear["b2b"] >= 0 else ""
        combo_str = f" combo {clear['combo']}" if clear["combo"] > 0 else ""
        print(f"      {clear['timeSeconds']:>8.3f}s  {clear['clearType']}{btb_str}{combo_str}")
        if show_boards:
            print(render_board(board))


# ── Full render ───────────────────────────────────────────────────────────────

def render_rounds(rounds: list[list[SecondSnapshot]]) -> None:
    for round_idx, snapshots in enumerate(rounds):
        print(f"\n{'=' * 54}")
        print(f"  Round {round_idx + 1}")
        print(f"{'=' * 54}")

        current_second = None

        for snap in snapshots:
            if snap.second != current_second:
                current_second = snap.second
                print(f"\n  [{snap.second:>4}s – {snap.second + 1}s]")

            if snap.clears:
                types_str = ", ".join(f"{ct}×{n}" for ct, n in snap.clear_types.items())
                print(f"    {snap.username:<20} +{snap.total_attack} atk  [{types_str}]")
                render_clears(snap.clears, snap.boards)
            else:
                print(f"    {snap.username:<20} —")


# ── Highlights ────────────────────────────────────────────────────────────────

WINDOW = 5  # seconds


def _player_snapshots(rounds: list[list[SecondSnapshot]]) -> dict[tuple[str, int], dict[int, SecondSnapshot]]:
    """
    Return a nested dict:  (username, round) → {second: SecondSnapshot}
    Makes window lookups O(1).
    """
    index: dict[tuple[str, int], dict[int, SecondSnapshot]] = {}
    for round_idx, snapshots in enumerate(rounds):
        for snap in snapshots:
            key = (snap.username, round_idx)
            index.setdefault(key, {})[snap.second] = snap
    return index


def _score_window(by_second: dict[int, SecondSnapshot], start: int) -> int:
    """Total attack generated in [start, start + WINDOW)."""
    return sum(
        by_second[s].total_attack
        for s in range(start, start + WINDOW)
        if s in by_second
    )


def _window_clears(by_second: dict[int, SecondSnapshot], start: int) -> list[tuple[dict, list]]:
    """All (clear, board) pairs in [start, start + WINDOW), in time order."""
    pairs = []
    for s in range(start, start + WINDOW):
        snap = by_second.get(s)
        if snap:
            for clear, board in zip(snap.clears, snap.boards):
                pairs.append((clear, board))
    return pairs


def top_attack_bursts(rounds: list[list[SecondSnapshot]], top_x: int = 3, show_boards: bool = True) -> None:
    """
    Find and print the top_x highest-attack 5-second windows for each player
    across the entire replay (all rounds combined).

    Windows are non-overlapping within each round — two selected highlights
    from the same round cannot share any seconds, but a window in round 1 and
    a window in round 2 are always independent. The top_x are ranked globally
    across rounds, so the best highlights from a dominant round will naturally
    surface above quieter ones.

    Args:
        rounds: The 2D list loaded from a .pkl file.
        top_x:  How many highlight windows to show per player total.
    """
    index = _player_snapshots(rounds)

    # Group (username, round_idx) entries by username
    by_username: dict[str, dict[tuple[str, int], dict[int, SecondSnapshot]]] = {}
    for (username, round_idx), by_second in index.items():
        by_username.setdefault(username, {})[(username, round_idx)] = by_second

    for username, round_map in sorted(by_username.items()):
        # Build a flat candidate list across all rounds:
        # each entry is (score, round_idx, start_second)
        candidates: list[tuple[int, int, int]] = []
        for (_, round_idx), by_second in round_map.items():
            if not by_second:
                continue
            last_second = max(by_second)
            for start in range(last_second - WINDOW + 2):
                score = _score_window(by_second, start)
                if score > 0:
                    candidates.append((score, round_idx, start))

        if not candidates:
            continue

        # Greedy non-overlapping selection across all rounds.
        # blocked is keyed by (round_idx, second) so windows in different
        # rounds never block each other.
        candidates.sort(key=lambda x: -x[0])
        selected: list[tuple[int, int, int]] = []  # (score, round_idx, start)
        blocked: set[tuple[int, int]] = set()

        for score, round_idx, start in candidates:
            if any((round_idx, s) in blocked for s in range(start, start + WINDOW)):
                continue
            selected.append((score, round_idx, start))
            for s in range(start - WINDOW + 1, start + WINDOW):
                blocked.add((round_idx, s))
            if len(selected) >= top_x:
                break

        if not selected:
            continue

        print(f"\n{'=' * 54}")
        print(f"  {username}  ·  top {len(selected)} burst{'s' if len(selected)!=1 else ''} across all rounds")
        print(f"{'=' * 54}")

        # Display in descending attack order (best burst first)
        for rank, (score, round_idx, start) in enumerate(selected, 1):
            by_second = round_map[(username, round_idx)]
            end = start + WINDOW - 1
            clears = _window_clears(by_second, start)
            total_lines = sum(c["linesCleared"] for c, _ in clears)

            print(f"\n  #{rank}  Round {round_idx + 1}  [{start}s – {end}s]  "
                  f"+{score} atk  "
                  f"{len(clears)} clear{'s' if len(clears)!=1 else ''}  "
                  f"{total_lines} line{'s' if total_lines!=1 else ''}")

            if clears:
                render_clears([c for c, _ in clears], [b for _, b in clears], show_boards=show_boards)
            else:
                print("      (no clears)")


# ── Entry point ───────────────────────────────────────────────────────────────

def main(pkl_path: str, highlights: bool = False, top_x: int = 3) -> None:
    with open(pkl_path, "rb") as f:
        rounds = pickle.load(f)

    if highlights:
        top_attack_bursts(rounds, top_x=top_x)
    else:
        render_rounds(rounds)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:", file=sys.stderr)
        print("  python render.py <replay.pkl>", file=sys.stderr)
        print("  python render.py <replay.pkl> --highlights [top_x]", file=sys.stderr)
        sys.exit(1)

    pkl_path = sys.argv[1]
    highlights = "--highlights" in sys.argv
    top_x = 3
    if highlights:
        idx = sys.argv.index("--highlights")
        if idx + 1 < len(sys.argv) and sys.argv[idx + 1].isdigit():
            top_x = int(sys.argv[idx + 1])

    main(pkl_path, highlights=highlights, top_x=top_x)