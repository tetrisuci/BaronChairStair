"""
On-demand recent changes, plus compatibility checks for legacy announcements.

    python3 -m unittest discover -s client

No skip guard: `changelog.py` imports only the standard library, for the same
reason `report_text.py` does — the rule it enforces is worth checking on a box
with none of the bot's dependencies installed, which is most boxes.

On-demand notes count individual changes and never claim a guild announcement.
The older once-per-guild helpers retain their previous behavior for old callers.
"""

import contextlib
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import changelog
from changelog import Release


class RecentChanges(unittest.TestCase):
    """Bounded, stateless changelog replies requested by a player."""

    HISTORY = (
        Release("beta 0.3", ("newest change", "second change", "third change")),
        Release("beta 0.2", ("fourth change", "fifth change", "sixth change")),
        Release("beta 0.1", ("oldest change",)),
    )

    def setUp(self):
        self.history = patch.object(changelog, "RELEASES", self.HISTORY)
        self.history.start()
        self.addCleanup(self.history.stop)

    def test_default_is_five_individual_changes_across_release_boundaries(self):
        text = changelog.format_recent_changes()
        self.assertEqual(changelog.DEFAULT_RECENT_CHANGES, 5)
        self.assertEqual(text.count("• "), 5)
        self.assertIn("5 most recent changes", text)
        self.assertIn("• fifth change", text)
        self.assertNotIn("sixth change", text)
        self.assertNotIn("oldest change", text)

    def test_custom_count_stops_in_the_middle_of_a_release(self):
        text = changelog.format_recent_changes(4)
        self.assertEqual(text.count("• "), 4)
        self.assertIn("• fourth change", text)
        self.assertNotIn("fifth change", text)

    def test_changes_stay_in_newest_first_order_and_group_under_versions(self):
        text = changelog.format_recent_changes(7)
        self.assertEqual(text.count("__beta 0.3__"), 1)
        self.assertEqual(text.count("__beta 0.2__"), 1)
        self.assertEqual(text.count("__beta 0.1__"), 1)
        expected = [
            "__beta 0.3__", "• newest change", "• second change", "• third change",
            "__beta 0.2__", "• fourth change", "• fifth change", "• sixth change",
            "__beta 0.1__", "• oldest change",
        ]
        positions = [text.index(part) for part in expected]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn("since this server last heard", text)

    def test_one_change_has_a_singular_heading(self):
        text = changelog.format_recent_changes(1)
        self.assertIn("1 most recent change**", text)
        self.assertEqual(text.count("• "), 1)

    def test_request_larger_than_history_shows_only_available_changes(self):
        text = changelog.format_recent_changes(changelog.MAX_RECENT_CHANGES)
        self.assertEqual(changelog.MAX_RECENT_CHANGES, 20)
        self.assertEqual(text.count("• "), 7)
        self.assertIn("7 most recent changes", text)
        self.assertNotIn("omitted", text)

    def test_maximum_count_is_supported(self):
        many = (Release("beta 9", tuple(f"change {i}" for i in range(30))),)
        with patch.object(changelog, "RELEASES", many):
            text = changelog.format_recent_changes(20)
        self.assertEqual(text.count("• "), 20)
        self.assertIn("• change 19\n", text + "\n")
        self.assertNotIn("• change 20", text)

    def test_invalid_counts_are_rejected_including_booleans(self):
        for count in (0, -1, 21, True, False, 2.0, "5", None):
            with self.subTest(count=count), self.assertRaises(ValueError):
                changelog.format_recent_changes(count)

    def test_empty_history_returns_a_safe_user_facing_reply(self):
        for history in ((), (Release("beta 0", ()),)):
            with self.subTest(history=history), patch.object(changelog, "RELEASES", history):
                self.assertEqual(
                    changelog.format_recent_changes(),
                    "No changes are available in the puzzle bot changelog yet.",
                )

    def test_request_never_calls_the_legacy_guild_state_helpers(self):
        with patch.object(changelog, "claim_announcement") as claim, \
                patch.object(changelog, "seen_version") as seen, \
                patch.object(changelog, "init_db") as init:
            first = changelog.format_recent_changes(4)
            second = changelog.format_recent_changes(4)
        self.assertEqual(first, second)
        claim.assert_not_called()
        seen.assert_not_called()
        init.assert_not_called()

    def test_wordy_notes_drop_whole_older_bullets_with_an_omission_notice(self):
        wordy = (Release("beta 9", tuple(
            f"Note {i}: " + "a" * 470 + "." for i in range(5)
        )),)
        with patch.object(changelog, "RELEASES", wordy):
            text = changelog.format_recent_changes(5)
        self.assertLessEqual(len(text), changelog.MAX_MESSAGE_CHARS)
        self.assertEqual(text.count("• "), 3)
        self.assertIn("• Note 2: " + "a" * 470 + ".", text)
        self.assertNotIn("Note 3", text)
        self.assertIn("2 requested changes omitted to fit one message", text)
        self.assertNotIn("truncated", text)

    def test_enormous_first_note_is_truncated_with_a_notice(self):
        huge = (Release("beta 9", ("x" * 4000, "older note")),)
        with patch.object(changelog, "RELEASES", huge):
            text = changelog.format_recent_changes(2)
        self.assertLessEqual(len(text), changelog.MAX_MESSAGE_CHARS)
        self.assertIn("__beta 9__", text)
        self.assertEqual(text.count("• "), 1)
        self.assertIn("…\n\n_This change was truncated", text)
        self.assertIn("1 more requested change omitted", text)
        self.assertNotIn("older note", text)
        self.assertTrue(text.endswith("._"))

    def test_untruncated_attachment_text_keeps_all_requested_long_notes(self):
        notes = tuple(f"Long note {i}: " + "🙂" * 600 + "." for i in range(6))
        history = (
            Release("beta 9", notes[:3]),
            Release("beta 8", notes[3:]),
        )
        with patch.object(changelog, "RELEASES", history):
            text = changelog.format_recent_changes(5, truncate=False)
        self.assertGreater(len(text.encode("utf-16-le")) // 2, changelog.MAX_MESSAGE_CHARS)
        self.assertEqual(text.count("• "), 5)
        for note in notes[:5]:
            self.assertIn(f"• {note}", text)
        self.assertNotIn("Long note 5", text)
        self.assertIn("__beta 9__", text)
        self.assertIn("__beta 8__", text)
        self.assertNotIn("omitted", text)
        self.assertNotIn("truncated", text)

    def test_untruncated_attachment_text_keeps_the_complete_version_label(self):
        version = "version-" + "v" * 3000
        with patch.object(changelog, "RELEASES", (Release(version, ("a change",)),)):
            text = changelog.format_recent_changes(1, truncate=False)
        self.assertIn(f"__{version}__", text)

    def test_one_enormous_note_still_mentions_truncation_without_omissions(self):
        with patch.object(changelog, "RELEASES", (Release("beta 9", ("🙂" * 4000,)),)):
            text = changelog.format_recent_changes(1)
        self.assertLessEqual(len(text), changelog.MAX_MESSAGE_CHARS)
        self.assertLessEqual(len(text.encode("utf-16-le")) // 2, changelog.MAX_MESSAGE_CHARS)
        self.assertIn("This change was truncated to fit one message", text)
        self.assertNotIn("omitted", text)

    def test_even_an_oversized_version_label_cannot_exceed_the_message_budget(self):
        with patch.object(changelog, "RELEASES", (Release("v" * 3000, ("x" * 4000,)),)):
            text = changelog.format_recent_changes(1)
        self.assertLessEqual(len(text), changelog.MAX_MESSAGE_CHARS)
        self.assertIn("v" * 99 + "…__", text)
        self.assertIn("truncated", text)


class ReleasesSince(unittest.TestCase):
    """Which versions a server is owed."""

    HISTORY = (
        Release("beta 0.3", ("third",)),
        Release("beta 0.2", ("second",)),
        Release("beta 0.1", ("first",)),
    )

    def setUp(self):
        self._real = changelog.RELEASES
        changelog.RELEASES = self.HISTORY

    def tearDown(self):
        changelog.RELEASES = self._real

    def versions(self, seen):
        return [r.version for r in changelog.releases_since(seen)]

    def test_a_server_that_has_heard_nothing_is_owed_everything(self):
        self.assertEqual(self.versions(None), ["beta 0.3", "beta 0.2", "beta 0.1"])

    def test_a_server_on_the_current_build_is_owed_nothing(self):
        self.assertEqual(self.versions("beta 0.3"), [])

    def test_a_deploy_that_skipped_versions_still_names_them_all(self):
        # The case the feature exists for: production sat on 0.1 while 0.2 and
        # 0.3 were pushed, then pulled once. Announcing only the tip would drop
        # 0.2 on the floor with nothing to say it had happened.
        self.assertEqual(self.versions("beta 0.1"), ["beta 0.3", "beta 0.2"])

    def test_a_version_this_build_has_never_heard_of_is_owed_everything(self):
        # A downgrade, or a hand-edited row. Saying too much is the safe way to
        # be wrong; the alternative is a server that never hears again.
        self.assertEqual(len(self.versions("beta 9.9")), 3)


class Announcement(unittest.TestCase):
    """What the message says."""

    def test_nothing_owed_is_an_empty_message_not_an_empty_shell(self):
        self.assertEqual(changelog.format_announcement(()), "")

    def test_one_release_reads_as_a_list_of_changes(self):
        text = changelog.format_announcement((Release("beta 0.1", ("did a thing",)),))
        self.assertIn("beta 0.1", text)
        self.assertIn("• did a thing", text)
        # No version subheading when there is only one — it would be a form.
        self.assertNotIn("__beta 0.1__", text)

    def test_several_releases_say_how_many_and_head_each_one(self):
        text = changelog.format_announcement((
            Release("beta 0.3", ("c",)), Release("beta 0.2", ("b",))))
        self.assertIn("2 updates since this server last heard", text)
        self.assertIn("__beta 0.3__", text)
        self.assertIn("__beta 0.2__", text)

    def test_a_long_history_is_capped_and_says_what_it_left_out(self):
        many = tuple(Release(f"beta 0.{n}", (f"change {n}",)) for n in range(9, 0, -1))
        text = changelog.format_announcement(many)
        self.assertIn("change 9", text)
        self.assertNotIn("change 1\n", text)
        self.assertIn(f"and {9 - changelog.MAX_RELEASES_IN_MESSAGE} earlier updates", text)

    def test_a_message_always_fits_in_a_discord_message(self):
        """
        Counting releases is not counting characters.

        Three releases of eight wordy notes measured 2,029 characters, which
        Discord rejects with a 400 — and the claim is taken before the send, so
        a rejected message is one a server never hears rather than one it hears
        late. Capping the release count did not cap the length.
        """
        wordy = tuple(
            Release(f"beta 0.{n}", tuple(
                f"A fairly wordy change note number {i} explaining what a player will notice."
                for i in range(8)))
            for n in range(9, 0, -1))

        text = changelog.format_announcement(wordy)

        self.assertLessEqual(len(text), changelog.MAX_MESSAGE_CHARS)
        # And it is still a whole message that says what it left out, rather
        # than a sentence cut in half.
        self.assertIn("earlier update", text)

    def test_a_single_enormous_release_is_truncated_rather_than_rejected(self):
        # Nothing left to drop: one release that is on its own too long. Better
        # a message with an ellipsis than a 400 nobody sees.
        huge = (Release("beta 9.9", tuple("x" * 300 for _ in range(20))),)

        text = changelog.format_announcement(huge)

        self.assertLessEqual(len(text), changelog.MAX_MESSAGE_CHARS)
        self.assertTrue(text.endswith("…"))

    def test_the_shipped_changelog_is_well_formed(self):
        # The real data, not a fixture: a release with no changes, or a version
        # that repeats, is a mistake nobody would see until a deploy.
        versions = [r.version for r in changelog.RELEASES]
        self.assertEqual(len(versions), len(set(versions)), "duplicate version")
        self.assertEqual(changelog.VERSION, versions[0], "VERSION is not the newest")
        for release in changelog.RELEASES:
            self.assertTrue(release.changes, f"{release.version} lists no changes")


class ClaimingOnce(unittest.TestCase):
    """The part that stops a server being told twice."""

    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        changelog.init_db(self.db)

    def tearDown(self):
        self.db.close()

    def test_the_first_call_announces_and_the_second_does_not(self):
        self.assertTrue(changelog.announcement_for(self.db, 1))
        self.assertFalse(changelog.announcement_for(self.db, 1))

    def test_each_server_is_told_separately(self):
        changelog.announcement_for(self.db, 1)
        self.assertTrue(changelog.announcement_for(self.db, 2))

    def test_two_callers_racing_produce_one_announcement(self):
        """
        The real race, not a sequential pair.

        Called one after the other, the second caller sees its own row and
        returns on the `previously == version` check — which is a fine
        shortcut and is *not* the thing that makes this safe. The exclusion is
        the `WHERE` on the write, and it only matters when two callers both
        read the state before either writes. Written the obvious way this test
        passed with that `WHERE` deleted.

        So: both callers are made to see the state as it was *before* either
        wrote, which is exactly what overlapping `/puzzle` calls see.
        """
        stale = {"value": changelog.seen_version(self.db, 7)}
        real = changelog.seen_version
        changelog.seen_version = lambda db, guild_id: stale["value"]
        try:
            first, _ = changelog.claim_announcement(self.db, 7, "beta 0.2")
            second, _ = changelog.claim_announcement(self.db, 7, "beta 0.2")
        finally:
            changelog.seen_version = real

        self.assertEqual([first, second], [True, False])

    def test_the_write_is_what_excludes_the_second_caller(self):
        # Same point from the other side: with the row already at this version,
        # a caller that still believes it has seen nothing must not win.
        changelog.claim_announcement(self.db, 11, "beta 0.2")
        real = changelog.seen_version
        changelog.seen_version = lambda db, guild_id: None
        try:
            claimed, _ = changelog.claim_announcement(self.db, 11, "beta 0.2")
        finally:
            changelog.seen_version = real

        self.assertFalse(claimed)

    def test_the_message_names_every_missed_version_not_just_the_newest(self):
        """
        The headline rule, end to end.

        Everything else here tests `releases_since` and `format_announcement`
        separately. Nothing tested that the legacy `announcement_for` joins
        them up, so replacing its body with
        `format_announcement((RELEASES[0],))` would have announced only the tip
        and left the whole suite green.
        """
        history = (
            Release("beta 0.3", ("the third thing",)),
            Release("beta 0.2", ("the second thing",)),
            Release("beta 0.1", ("the first thing",)),
        )
        real = changelog.RELEASES
        changelog.RELEASES = history
        try:
            changelog.claim_announcement(self.db, 42, "beta 0.1")
            message = changelog.announcement_for(self.db, 42, "beta 0.3")
        finally:
            changelog.RELEASES = real

        self.assertIn("the third thing", message)
        self.assertIn("the second thing", message, "a skipped version was not announced")
        self.assertNotIn("the first thing", message, "a version already heard was repeated")

    def test_legacy_fresh_server_hears_profile_browser_when_it_is_latest(self):
        # Freeze the historical beta 0.15 scenario: later releases should not
        # make this test depend on the legacy three-release preview cap.
        history = changelog.load_releases()
        start = next(i for i, release in enumerate(history) if release.version == "beta 0.15")
        with patch.object(changelog, "RELEASES", history[start:]):
            message = changelog.announcement_for(self.db, 99, "beta 0.15")

        self.assertIn("Players table", message)
        self.assertLessEqual(len(message), changelog.MAX_MESSAGE_CHARS)
        self.assertEqual(changelog.seen_version(self.db, 99), "beta 0.15")

    def test_legacy_server_on_beta_014_hears_profile_browser_when_it_is_latest(self):
        changelog.claim_announcement(self.db, 100, "beta 0.14")
        history = changelog.load_releases()
        start = next(i for i, release in enumerate(history) if release.version == "beta 0.15")
        with patch.object(changelog, "RELEASES", history[start:]):
            message = changelog.announcement_for(self.db, 100, "beta 0.15")

        self.assertIn("Players table", message)
        self.assertEqual(changelog.seen_version(self.db, 100), "beta 0.15")

    def test_a_new_version_is_announced_to_a_server_already_on_an_old_one(self):
        changelog.claim_announcement(self.db, 3, "beta 0.1")
        claimed, previously = changelog.claim_announcement(self.db, 3, "beta 0.2")
        self.assertTrue(claimed)
        self.assertEqual(previously, "beta 0.1")

    def test_the_claim_records_what_was_announced(self):
        changelog.claim_announcement(self.db, 5, "beta 0.4")
        self.assertEqual(changelog.seen_version(self.db, 5), "beta 0.4")

    def test_a_server_nobody_has_told_reads_as_none_not_as_an_error(self):
        self.assertIsNone(changelog.seen_version(self.db, 404))


class LoadingTheNotes(unittest.TestCase):
    """
    The notes are one file, shared with the activity.

    A copy in this module and a copy in the activity is the drift the whole
    arrangement exists to prevent, so the file is the source and this is what
    happens when it is not there or not readable. It must never raise:
    `discord_bot.py` imports this module at top level, outside any `try`, so a
    throw here is a bot that will not start over a changelog.
    """

    def write(self, body):
        path = Path(self.dir.name) / "changelog.json"
        path.write_text(body, encoding="utf-8")
        return path

    def load_quietly(self, path):
        """Loads, swallowing the stderr note so the test output stays readable."""
        with contextlib.redirect_stderr(io.StringIO()) as noise:
            releases = changelog.load_releases(path)
        return releases, noise.getvalue()

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.dir.cleanup()

    def test_the_file_that_ships_is_the_one_this_build_announces(self):
        # Not a fixture: the real file, read the real way. It is the only thing
        # that proves the bot and the activity are reading the same notes.
        self.assertTrue(changelog.CHANGELOG_PATH.is_file(), changelog.CHANGELOG_PATH)
        self.assertTrue(changelog.RELEASES, "the shipped changelog.json parsed as empty")
        self.assertEqual(changelog.VERSION, changelog.RELEASES[0].version)

    def test_releases_come_back_in_file_order(self):
        path = self.write(json.dumps({"releases": [
            {"version": "beta 0.9", "changes": ["newest"]},
            {"version": "beta 0.1", "changes": ["oldest"]},
        ]}))
        self.assertEqual([r.version for r in changelog.load_releases(path)],
                         ["beta 0.9", "beta 0.1"])

    def test_a_missing_file_is_no_announcements_rather_than_a_dead_bot(self):
        releases, noise = self.load_quietly(Path(self.dir.name) / "nothing.json")
        self.assertEqual(releases, ())
        self.assertIn("announcements are off", noise)

    def test_a_malformed_file_is_the_same(self):
        releases, _ = self.load_quietly(self.write("{not json"))
        self.assertEqual(releases, ())

    def test_a_file_with_no_releases_key_is_the_same(self):
        releases, _ = self.load_quietly(self.write(json.dumps({"version": "beta 0.2"})))
        self.assertEqual(releases, ())

    def test_one_bad_release_is_skipped_and_the_rest_are_kept(self):
        # A hand-edited file with one line wrong should cost that line, not the
        # whole announcement.
        releases, noise = self.load_quietly(self.write(json.dumps({"releases": [
            {"version": "beta 0.2"},
            {"version": "beta 0.1", "changes": ["fine"]},
        ]})))
        self.assertEqual([r.version for r in releases], ["beta 0.1"])
        self.assertIn("malformed", noise)


class NothingToAnnounce(unittest.TestCase):
    """What the bot does when the notes could not be read at all."""

    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        changelog.init_db(self.db)
        self._real = changelog.RELEASES
        changelog.RELEASES = ()

    def tearDown(self):
        changelog.RELEASES = self._real
        self.db.close()

    def test_it_says_nothing(self):
        self.assertEqual(changelog.announcement_for(self.db, 1, "unknown"), "")

    def test_and_claims_nothing(self):
        # The row must be untouched. Recording "unknown" would make the next
        # real release look like an upgrade from a version that never existed.
        changelog.announcement_for(self.db, 1, "unknown")
        self.assertIsNone(changelog.seen_version(self.db, 1))


if __name__ == "__main__":
    unittest.main()
