"""
test_sync_window.py
~~~~~~~~~~~~~~~~~~~
The ten-minute window on `/archive sync`, without Discord.

Anybody may run the command, so this window is the only thing between the
club's archive and a member pressing it in a loop. `sync_window` imports
nothing outside the stdlib, so this suite runs on a bare `python3` like
`test_changelog` does.
"""

import re
import sqlite3
import tempfile
import unittest
from pathlib import Path

import sync_window

START = 1_700_000_000.4


def _db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    sync_window.init_db(db)
    return db


class TheStoredStart(unittest.TestCase):
    def test_a_box_that_has_never_synced_has_no_start(self):
        self.assertIsNone(sync_window.last_started(_db()))

    def test_a_recorded_start_reads_back(self):
        db = _db()
        sync_window.record_start(db, START)
        self.assertEqual(sync_window.last_started(db), START)

    def test_a_later_start_replaces_the_earlier_one(self):
        # One global window, so one row — not a log that grows forever.
        db = _db()
        sync_window.record_start(db, START)
        sync_window.record_start(db, START + 900)
        self.assertEqual(sync_window.last_started(db), START + 900)
        count = db.execute("SELECT COUNT(*) FROM archive_sync_window").fetchone()[0]
        self.assertEqual(count, 1)

    def test_init_db_twice_is_harmless_and_keeps_the_start(self):
        # It runs at every boot.
        db = _db()
        sync_window.record_start(db, START)
        sync_window.init_db(db)
        self.assertEqual(sync_window.last_started(db), START)

    def test_the_start_survives_a_restart(self):
        # The point of keeping it in stats.db: restarting the bot must not
        # hand out a fresh sync.
        with tempfile.TemporaryDirectory() as here:
            path = Path(here) / "stats.db"
            first = sqlite3.connect(path)
            sync_window.init_db(first)
            sync_window.record_start(first, START)
            first.close()

            second = sqlite3.connect(path)
            sync_window.init_db(second)
            self.assertEqual(sync_window.last_started(second), START)
            second.close()


class TheWindow(unittest.TestCase):
    def test_it_is_ten_minutes(self):
        self.assertEqual(sync_window.COOLDOWN_S, 10 * 60)

    def test_it_is_open_when_nothing_has_run(self):
        self.assertTrue(sync_window.is_open(None, now=START))

    def test_it_is_shut_inside_ten_minutes(self):
        self.assertFalse(sync_window.is_open(START, now=START + 599))

    def test_it_opens_at_ten_minutes(self):
        self.assertTrue(sync_window.is_open(START, now=START + 600))

    def test_the_next_start_is_ten_minutes_after_the_last(self):
        self.assertEqual(sync_window.next_start(START), START + 600)

    def test_a_start_in_the_future_does_not_hold_the_window(self):
        # The box's clock ran ahead when the start was stored and has since
        # been put right. Trusting the row would shut the window for the
        # clock's error on top of the ten minutes, and nobody can clear it.
        self.assertTrue(sync_window.is_open(START + 7200, now=START + 600))
        self.assertTrue(sync_window.is_open(START + 1, now=START))


class WhatTheMemberIsTold(unittest.TestCase):
    def test_a_refusal_gives_both_times_as_discord_timestamps(self):
        said = sync_window.refusal(START, running=False, now=START + 60)
        last, nxt = int(START), int(START) + 601  # rounded up, never early
        self.assertIn(f"<t:{last}:R>", said)
        self.assertIn(f"<t:{last}:t>", said)
        self.assertIn(f"<t:{nxt}:R>", said)
        self.assertIn(f"<t:{nxt}:t>", said)
        self.assertIn("10 minutes", said)

    def test_the_next_start_is_never_shown_early(self):
        # Floor would print a time a few hundred milliseconds before the window
        # opens, and somebody who trusts it to the second is refused again.
        said = sync_window.next_line(START)
        self.assertIn(f"<t:{int(START) + 601}:R>", said)

    def test_a_running_sync_says_so_and_still_gives_the_times(self):
        said = sync_window.refusal(START, running=True, now=START + 5)
        self.assertIn("already running", said)
        self.assertIn(f"<t:{int(START)}:R>", said)
        self.assertIn(f"<t:{int(START) + 601}:t>", said)

    def test_a_sync_still_launching_has_no_start_to_name(self):
        # Between taking the lock and launching the process there is no start
        # time yet, and an old one would name the wrong sync.
        for last in (None, START - 3600):
            said = sync_window.refusal(last, running=True, now=START)
            self.assertNotIn("<t:", said)
            self.assertIn("10 minutes", said)

    def test_a_refusal_never_says_a_sync_started_in_the_future(self):
        # Discord would render it as "in 2 hours", which is a reply wrong
        # about the one thing it is there to say.
        ahead = START + 7200
        for running in (True, False):
            said = sync_window.refusal(ahead, running=running, now=START)
            self.assertNotIn(str(int(ahead)), said)
            for stamp in re.findall(r"<t:(\d+):", said):
                self.assertLessEqual(int(stamp), int(START) + 601, said)

    def test_the_next_line_names_the_next_start(self):
        said = sync_window.next_line(START)
        self.assertIn(f"<t:{int(START) + 601}:R>", said)
        self.assertIn(f"<t:{int(START) + 601}:t>", said)

    def test_no_message_carries_anything_shaped_like_an_id(self):
        # The timestamps are ten digits; a Discord id is seventeen or more.
        for said in (
            sync_window.refusal(START, running=False, now=START + 1),
            sync_window.refusal(START, running=True, now=START + 1),
            sync_window.refusal(None, running=True, now=START),
            sync_window.next_line(START),
        ):
            self.assertIsNone(re.search(r"\d{17,}", said), said)


if __name__ == "__main__":
    unittest.main()
