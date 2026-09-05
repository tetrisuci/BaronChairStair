"""
The shape of the daily recap, where "shape" means what lines up with what.

    python3 -m unittest discover -s client     # skips, unless discord.py is installed
    .venv/bin/python -m unittest discover -s client

Skipped rather than failed when `discord` is missing. `puzzle_recap` imports it
at module scope, and the suite has to stay runnable on a box with no bot
dependencies — that is the whole reason `report_text.py` exists as its own
module. This file covers the part of the recap that is pure string building, so
where the dependency *is* installed there is no reason not to check it.
"""

import unittest

try:
    import puzzle_recap
except ModuleNotFoundError:  # pragma: no cover - depends on the environment
    puzzle_recap = None

needs_discord = unittest.skipUnless(
    puzzle_recap is not None, "discord.py is not installed; recap is not importable"
)


def player(identifier: str, name: str) -> dict:
    return {"id": identifier, "username": name, "avatarUrl": None}


def solver(identifier: str, name: str, marks: dict, solved: int, total_ms: int) -> dict:
    return {
        "player": player(identifier, name),
        "marks": marks,
        "solved": solved,
        "totalMs": total_ms,
    }


ALL_THREE = {"easy": True, "medium": True, "hard": True}
EASY_ONLY = {"easy": True, "medium": False, "hard": False}


@needs_discord
class DailyAlignment(unittest.TestCase):
    """
    Every row starts with its grid, in the same column.

    The bug this pins: the leader's line carried a crown prefix that no other
    line had, so their three marks began an emoji-width to the right of
    everybody else's and the one column the recap has ran crooked down the whole
    message. Reported from a real recap.
    """

    def rows(self) -> list:
        return [
            solver("1", "first", ALL_THREE, 3, 61_200),
            solver("2", "second", EASY_ONLY, 1, 21_900),
            solver("3", "third", EASY_ONLY, 1, 84_200),
        ]

    def test_every_board_line_starts_at_the_same_column(self):
        lines = puzzle_recap._daily_lines(self.rows())
        starts = {line.index("<@") for line in lines if "<@" in line and "—" in line}
        # One distinct offset, or the column is not a column. A prefix on any
        # single line is what breaks this, whatever the prefix is.
        self.assertEqual(len(starts), 1, f"mention column is ragged: {starts}")

    def test_the_leader_is_first_without_being_decorated(self):
        lines = puzzle_recap._daily_lines(self.rows())
        self.assertIn("<@1>", lines[0])
        self.assertNotIn("\N{CROWN}", "\n".join(lines))


@needs_discord
class RushAlignment(unittest.TestCase):
    def board(self) -> dict:
        return {
            "entries": [
                {"player": player("1", "first"), "solved": 17},
                {"player": player("2", "second"), "solved": 11},
                {"player": player("3", "third"), "solved": 1},
            ]
        }

    def test_every_line_starts_with_the_mention(self):
        lines = [line for line in puzzle_recap._rush_lines(self.board()) if "<@" in line]
        self.assertEqual(len(lines), 3)
        for line in lines:
            self.assertTrue(line.startswith("<@"), f"decorated: {line!r}")

    def test_one_puzzle_is_singular(self):
        lines = puzzle_recap._rush_lines(self.board())
        self.assertTrue(any(line.endswith("— 1 puzzle") for line in lines))
        self.assertTrue(any(line.endswith("— 17 puzzles") for line in lines))


if __name__ == "__main__":
    unittest.main()
