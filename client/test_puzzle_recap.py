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
except ModuleNotFoundError as missing:  # pragma: no cover - depends on the environment
    # Only the bot dependency earns a skip. A bare `except ModuleNotFoundError`
    # also swallows one raised from *inside* puzzle_recap — a typo'd import, a
    # module that moved — and reports it as "discord.py is not installed",
    # turning a broken module into a green suite with a reason that sends the
    # reader somewhere else entirely. Anything but the names below re-raises.
    if missing.name not in {"discord", "aiohttp", "dotenv"}:
        raise
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


#: The three characters a ranked row can begin with, read off the module so a
#: renamed mark is a failure here rather than a filter that quietly matches
#: nothing.
MARKS = (
    ()
    if puzzle_recap is None
    else (puzzle_recap.MARK_SOLVED, puzzle_recap.MARK_MISSED, puzzle_recap.MARK_ABSENT)
)

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
        """
        More players than `RANKED_SHOWN`, so the overflow line is real.

        With three rows the "also played" tail is never emitted, and the column
        check below used to pass without ever meeting the one line in this
        message that legitimately does not start with a grid.
        """
        board = [
            solver("1", "first", ALL_THREE, 3, 61_200),
            solver("2", "second", EASY_ONLY, 1, 21_900),
            solver("3", "third", EASY_ONLY, 1, 84_200),
        ]
        extra = puzzle_recap.RANKED_SHOWN + 1 - len(board)
        board += [solver(str(n + 4), f"p{n}", EASY_ONLY, 1, 90_000) for n in range(extra)]
        return board

    def test_every_board_line_starts_at_the_same_column(self):
        lines = puzzle_recap._daily_lines(self.rows())
        # Only the ranked rows. Selecting on punctuation instead — "<@" and an
        # em dash — also catches "also played — @x @y", which is prose, starts
        # its mentions at a different offset by design, and would have failed
        # this assertion on correct output the moment a board went past the cap.
        ranked = [line for line in lines if line[:1] in MARKS]
        self.assertGreater(len(ranked), 1)
        starts = {line.index("<@") for line in ranked}
        # One distinct offset, or the column is not a column. A prefix on any
        # single line is what breaks this, whatever the prefix is.
        self.assertEqual(len(starts), 1, f"mention column is ragged: {starts}")

    def test_the_overflow_line_is_present_and_deliberately_not_a_row(self):
        # The line the filter above has to exclude. Asserting it exists keeps
        # that exclusion honest: if the tail ever stops being emitted, the
        # filter is guarding against nothing and should be simplified.
        lines = puzzle_recap._daily_lines(self.rows())
        tail = [line for line in lines if line.startswith("also played")]
        self.assertEqual(len(tail), 1)
        self.assertNotIn(tail[0][:1], MARKS)

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
