"""
Unit tests for the parts of `/report` that publish user text.

    python3 -m unittest discover -s client     # no install needed
    pytest client/test_report_text.py          # if you have it

Stdlib `unittest` rather than pytest, and deliberately: this repository has no
Python test harness, no pyproject and no requirements file, so a suite that
needs an install is a suite nobody runs. `unittest.TestCase` classes are
discovered and run by pytest unchanged, so this costs the pytest path nothing.

What is covered is the pure half — everything that decides what a stranger's
typing looks like on a public tracker. `report_commands.py` holds the Discord
and GitHub halves and is not importable without the bot's dependencies, which
is why the rules live in their own module.
"""

import unittest

from report_text import (
    MAX_DESCRIPTION,
    MAX_NAME,
    MAX_TITLE,
    ReportLimiter,
    defang,
    issue_body,
    issue_title,
)


class Defanging(unittest.TestCase):
    def test_a_mention_cannot_page_a_stranger(self):
        # The failure this prevents: somebody types "@torvalds" into a Discord
        # box and a person with nothing to do with this club is notified by the
        # club's own bot. The text still reads as it was typed.
        out = defang("cc @torvalds and @github/support")
        self.assertNotIn("@torvalds", out)
        self.assertIn("@<!---->torvalds", out)
        self.assertIn("@<!---->github/support", out)

    def test_a_reference_cannot_backlink_an_unrelated_issue(self):
        self.assertEqual(defang("see #1"), "see #<!---->1")

    def test_an_email_and_a_fragment_are_left_alone(self):
        # GitHub does not linkify these, so defanging them would only disfigure
        # what somebody meant to quote.
        self.assertEqual(defang("mail me at ada@example.com"), "mail me at ada@example.com")
        self.assertEqual(defang("https://x.test/a#frag"), "https://x.test/a#frag")

    def test_control_characters_become_spaces(self):
        self.assertEqual(defang("a\x00b\x1fc\x7fd"), "a b c d")

    def test_the_comment_trick_cannot_be_escaped(self):
        # An author writing the trick themselves does not get to close it: the
        # substitution is on their text, not a template they can break out of.
        self.assertIn("@<!---->", defang("-->@everyone"))


class Titles(unittest.TestCase):
    def test_is_the_name_then_the_category(self):
        self.assertEqual(issue_title("bennxt", "UI issue"), "bennxt — UI issue")

    def test_a_name_that_is_only_whitespace_still_files(self):
        # A report is not worth losing over a profile the bot cannot read.
        self.assertEqual(issue_title("   ", "Suggestion"), "someone — Suggestion")

    def test_a_newline_in_a_name_cannot_reach_the_title(self):
        self.assertEqual(issue_title("ada\nbob", "UI issue"), "ada bob — UI issue")

    def test_a_long_name_is_trimmed_not_refused(self):
        title = issue_title("z" * 400, "Bugged puzzle")
        self.assertLessEqual(len(title), MAX_TITLE)
        self.assertTrue(title.startswith("z" * (MAX_NAME - 1)))
        self.assertTrue(title.endswith("— Bugged puzzle"))

    def test_a_long_category_cannot_overflow_github(self):
        self.assertLessEqual(len(issue_title("ada", "x" * 500)), MAX_TITLE)


class Bodies(unittest.TestCase):
    def test_the_players_words_are_the_body(self):
        # Not a quotation of one. Prefixing every line with `> ` rendered the
        # report as a grey indented aside under the bot's own footer, which is
        # the wrong way round: the report is what the issue is about.
        body = issue_body("it crashed", reporter="ada", guild="Tetris at UCI")
        self.assertTrue(body.startswith("it crashed"))
        self.assertNotIn("> it crashed", body)
        self.assertIn("**ada**", body)
        self.assertIn("Tetris at UCI", body)

    def test_the_report_comes_before_the_provenance(self):
        # A maintainer opening the issue should read the problem first and the
        # bookkeeping second.
        body = issue_body("the board is upside down", reporter="ada", guild=None)
        self.assertLess(body.index("the board is upside down"), body.index("Filed with"))

    def test_every_line_survives_intact(self):
        body = issue_body("one\ntwo\nthree", reporter="ada", guild=None)
        self.assertIn("one\ntwo\nthree", body)

    def test_a_direct_message_says_so_rather_than_naming_nothing(self):
        self.assertIn("in a direct message", issue_body("x" * 20, reporter="ada", guild=None))

    def test_a_mention_in_a_guild_name_is_defanged_too(self):
        # The guild name is not typed by the reporter, but it is still text from
        # outside this repository going onto a public page.
        self.assertIn("@<!---->", issue_body("hi there", reporter="ada", guild="@everyone club"))


class Limits(unittest.TestCase):
    def test_a_player_may_file_three_then_waits(self):
        limiter = ReportLimiter(limit=3, window=3600)
        self.assertEqual([limiter.take(7, now=0) for _ in range(4)], [True, True, True, False])

    def test_the_window_rolls_rather_than_resetting(self):
        limiter = ReportLimiter(limit=2, window=100)
        self.assertTrue(limiter.take(7, now=0))
        self.assertTrue(limiter.take(7, now=50))
        self.assertFalse(limiter.take(7, now=60))
        # The first one ages out; the second has not.
        self.assertTrue(limiter.take(7, now=101))
        self.assertFalse(limiter.take(7, now=102))

    def test_one_players_limit_is_not_anothers(self):
        limiter = ReportLimiter(limit=1, window=100)
        self.assertTrue(limiter.take(1, now=0))
        self.assertFalse(limiter.take(1, now=0))
        self.assertTrue(limiter.take(2, now=0))

    def test_it_says_how_long_the_wait_is(self):
        limiter = ReportLimiter(limit=1, window=100)
        self.assertEqual(limiter.opens_in(7, now=0), 0)
        limiter.take(7, now=0)
        self.assertGreater(limiter.opens_in(7, now=40), 0)
        self.assertEqual(limiter.opens_in(7, now=101), 0)

    def test_a_refused_report_does_not_spend_a_slot(self):
        # Otherwise being rate limited would extend the rate limit.
        limiter = ReportLimiter(limit=1, window=100)
        limiter.take(7, now=0)
        for _ in range(5):
            limiter.take(7, now=10)
        self.assertEqual(limiter.opens_in(7, now=10), 91)


class Caps(unittest.TestCase):
    def test_the_description_cap_fits_a_github_body(self):
        self.assertLess(MAX_DESCRIPTION, 65_536)


class LineBreaks(unittest.TestCase):
    """The bug these caught: `\\n` is inside C0, so defanging flattened a report."""

    def test_steps_to_reproduce_survive(self):
        # A report is usually a list of steps. Collapsing it into one line loses
        # the thing that made it worth filing, and the first version did.
        body = issue_body("1. open rush\n2. skip twice\n3. it hangs", reporter="ada", guild=None)
        self.assertIn("1. open rush\n2. skip twice\n3. it hangs", body)

    def test_windows_line_endings_do_not_leave_stray_returns(self):
        self.assertEqual(defang("one\r\ntwo\rthree"), "one\ntwo\nthree")

    def test_a_tab_is_still_a_space(self):
        self.assertEqual(defang("a\tb"), "a b")

    def test_a_newline_never_reaches_the_footer(self):
        # The provenance line has to stay one line, or a crafted display name
        # could append a sentence that reads like the bot wrote it.
        body = issue_body("hello there", reporter="ada\n**staff**", guild=None)
        footer = body.split("---\n")[-1]
        self.assertNotIn("\n", footer.strip())
        self.assertIn("ada **staff**", footer)


class Autolinks(unittest.TestCase):
    """
    All four forms GitHub turns into a cross-reference.

    The two carrying a word character before the marker were the gap: every
    lookbehind in the module rejects them, so `owner/repo#1` published verbatim
    and posted a backlink into an unrelated public repository.
    """

    def test_a_bare_issue_number_is_defanged(self):
        self.assertEqual(defang("#26"), "#<!---->26")

    def test_a_cross_repository_reference_is_defanged(self):
        self.assertEqual(defang("rails/rails#1"), "rails/rails#<!---->1")

    def test_a_gh_reference_is_defanged(self):
        self.assertEqual(defang("GH-1234"), "GH-<!---->1234")

    def test_a_gh_reference_keeps_the_case_it_was_typed_in(self):
        # The module's promise is that the text reads exactly as written; a
        # bare replacement rewrote "gh-9" to "GH-9".
        self.assertEqual(defang("gh-9"), "gh-<!---->9")

    def test_a_mention_after_a_slash_is_defanged(self):
        # The `/` exemption belongs to `#` (a URL fragment) and was letting
        # `a/@everyone` through.
        self.assertEqual(defang("a/@everyone"), "a/@<!---->everyone")

    def test_an_email_address_is_left_alone(self):
        self.assertEqual(defang("write to foo@bar.com"), "write to foo@bar.com")

    def test_a_url_fragment_is_left_alone(self):
        self.assertEqual(defang("example.com/#anchor"), "example.com/#anchor")

    def test_an_ordinary_hyphenated_word_is_left_alone(self):
        self.assertEqual(defang("high-5"), "high-5")


class Refunds(unittest.TestCase):
    """A report that was never filed must not cost the player a slot."""

    def test_a_refunded_slot_can_be_used_again(self):
        limiter = ReportLimiter(limit=1)
        self.assertTrue(limiter.take(7))
        self.assertFalse(limiter.take(7))
        limiter.refund(7)
        self.assertTrue(limiter.take(7))

    def test_a_refund_gives_back_only_the_last_slot(self):
        limiter = ReportLimiter(limit=3)
        for _ in range(3):
            limiter.take(7)
        limiter.refund(7)
        self.assertTrue(limiter.take(7))
        self.assertFalse(limiter.take(7))

    def test_refunding_a_player_who_never_filed_is_harmless(self):
        limiter = ReportLimiter(limit=1)
        limiter.refund(99)
        self.assertTrue(limiter.take(99))


if __name__ == "__main__":
    unittest.main()
