"""
The company blocklist: companies whose jobs the tracker never shows.

    python3 -m unittest discover -s client     # no install needed

Two halves, and both are needed for a block to actually hold:

  * the registry — a blocked company's board is never polled, so nothing new
    is fetched, stored or announced;
  * the stored rows — `postings` keeps up to `PRUNE_DAYS` of history, so a
    company blocked today still has rows in the table tomorrow. Every reader
    of that table filters them out rather than waiting for the pruner.

`internship_poller` imports aiohttp at module scope and a box running the
suite with bare `python3` has none, so it is stubbed with the surface the
import touches. Nothing here makes a request.
"""

import asyncio
import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def _stub_aiohttp() -> bool:
    """Fakes `aiohttp`, unless the real one is installed."""
    try:
        import aiohttp  # noqa: F401
        return False
    except ModuleNotFoundError:
        pass
    aiohttp = types.ModuleType("aiohttp")
    aiohttp.ClientError = type("ClientError", (Exception,), {})
    aiohttp.ClientTimeout = lambda **kwargs: None
    aiohttp.ClientSession = object
    aiohttp.TCPConnector = lambda **kwargs: None
    sys.modules["aiohttp"] = aiohttp
    return True


_stub_aiohttp()

import internship_poller as poller  # noqa: E402


class BlockedNames(unittest.TestCase):
    def test_rocket_lab_is_blocked(self):
        # The club asked for this one by name; it is why the list exists.
        self.assertTrue(poller.is_blocked_company("Rocket Lab"))

    def test_spelling_does_not_get_a_company_back_in(self):
        # Board labels and ATS payloads disagree about spacing and case, so the
        # match is on letters and digits only — otherwise a block is one stray
        # hyphen away from doing nothing.
        for spelling in ("rocket lab", "ROCKET LAB", "Rocket-Lab", "RocketLab",
                         "  Rocket  Lab  "):
            with self.subTest(spelling=spelling):
                self.assertTrue(poller.is_blocked_company(spelling))

    def test_an_unblocked_company_is_left_alone(self):
        for name in ("SpaceX", "Astranis", "", None):
            with self.subTest(name=name):
                self.assertFalse(poller.is_blocked_company(name))

    def test_something_that_is_not_a_name_is_never_blocked(self):
        # boards.json is edited by hand, so a column can hold anything JSON can.
        # Not a string means not a company name: never blocked, and never an
        # exception — a raise here, reached from `load_boards` while the module
        # is imported, is a bot that will not start.
        for value in (12345, 3.5, True, ["Rocket Lab"], {"company": "Rocket Lab"}):
            with self.subTest(value=value):
                self.assertFalse(poller.is_blocked_company(value))

    def test_the_company_is_caught_under_its_longer_legal_name(self):
        # Rocket Lab files as "Rocket Lab USA, Inc." and `discover` finds boards
        # under whatever the ATS slug says. An exact match blocks the seed row
        # and nothing else, which is the shape of a block that quietly stops
        # working; a blocked name is matched as the START of a candidate.
        for name in ("Rocket Lab USA", "Rocket Lab USA, Inc.", "rocketlabusa",
                     "rocketlabinc", "rocket-lab-usa"):
            with self.subTest(name=name):
                self.assertTrue(poller.is_blocked_company(name))

    def test_a_workday_triple_is_matched(self):
        # A Workday board's slug is a tenant/wd-instance/site path, so it never
        # equals the company name. Every Workday board in SEED_BOARDS is like
        # this, which is why an exact match would be a no-op for all of them.
        self.assertTrue(
            poller.is_blocked_company("rocketlab/wd1/RocketLab_Careers"))

    def test_a_name_that_only_contains_a_blocked_one_is_left_alone(self):
        # The boundary of the rule above, stated so a future edit cannot widen
        # it by accident: the block matches a prefix, not any substring.
        for name in ("Astro Rocket Labs", "Not Rocket Lab", "Mini-Rocket Lab"):
            with self.subTest(name=name):
                self.assertFalse(poller.is_blocked_company(name))


def boards_from(rows=None, raw=None):
    """`load_boards()` against a boards.json holding `rows` (or the text `raw`),
    or with no boards.json at all.

    Never the real file. On the box BOARDS_FILE is whatever `discover` last
    wrote, so a test that reads it tests the box rather than the code: it goes
    red on a healthy deploy the day `discover` records a seed company under its
    slug, and CLAUDE.md's stop-on-red rule then halts that deploy for a fault
    that is not in the code.
    """
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "boards.json")
        if raw is not None:
            with open(path, "w") as f:
                f.write(raw)
        elif rows is not None:
            with open(path, "w") as f:
                json.dump(rows, f)
        original = poller.BOARDS_FILE
        poller.BOARDS_FILE = path
        try:
            return poller.load_boards()
        finally:
            poller.BOARDS_FILE = original


class Registry(unittest.TestCase):
    def test_a_blocked_company_is_never_polled(self):
        # The strongest half of the block: no board, no request, no row, so
        # nothing can be announced in the first place. Both identifying columns
        # are checked, because a discovered board only has its slug.
        self.assertFalse([b for b in boards_from()
                          if poller.is_blocked_company(b[1])
                          or poller.is_blocked_company(b[2])])

    def test_the_rest_of_the_registry_survives(self):
        # Against the seed list alone, so the display names are the hand-written
        # ones. A boards.json row with the same (platform, slug) replaces its
        # seed row and `discover` writes the slug as the company, so on a box
        # where `discover` has found SpaceX the real file says "spacex" — and
        # this assertion would fail while SpaceX was still being polled.
        boards = boards_from()
        companies = {b[2] for b in boards}
        self.assertIn("SpaceX", companies)
        self.assertNotIn("Rocket Lab", companies)
        # Exactly one seed row is blocked today. Blocking another seeded company
        # changes this number on purpose: it is the only check that a prefix
        # entry did not take an unrelated seed board with it.
        self.assertEqual(len(boards), len(poller.SEED_BOARDS) - 1)

    def test_a_discovered_board_cannot_reintroduce_a_blocked_company(self):
        # The row shape is the whole point of this test. `cmd_discover` appends
        # [plat, slug, slug, "unknown", n] and dumps r[:4], so a discovered
        # board carries its SLUG in the company column and its sector is always
        # "unknown" — a fixture with a tidy display name in column 2 is a shape
        # discover never writes, and passes while the real thing leaks.
        boards = boards_from([["lever", "rocketlabusa", "rocketlabusa", "unknown"],
                              ["workday", "rocketlab/wd1/Careers",
                               "rocketlab/wd1/Careers", "unknown"],
                              ["greenhouse", "anduril", "anduril", "unknown"]])
        self.assertEqual([b[1] for b in boards if b[3] == "unknown"], ["anduril"])
        self.assertFalse([b for b in boards
                          if poller.is_blocked_company(b[1])
                          or poller.is_blocked_company(b[2])])

    def test_a_malformed_row_costs_that_row_not_the_boot(self):
        # A board is exactly [platform, slug, company, sector], all strings: the
        # only shape SEED_BOARDS holds and the only one `discover` writes.
        # boards.json is edited by hand, so anything else is dropped — named on
        # stderr — and the rest of the file still loads. Keeping such a row is
        # worse than it looks: fetch_all spreads every row into a five-argument
        # call, so one row of the wrong length raises before a single board is
        # polled, on every sweep (see Sweep below).
        good = ["greenhouse", "anduril", "anduril", "unknown"]
        bad = [["greenhouse", "acme"],
               ["greenhouse", "acme", "Acme", "tech", "extra"],
               ["greenhouse", "acmetwo", 7, "tech"],
               ["lever", 12345, "Some Co", "misc"],
               ["greenhouse"], [], 5, "notalist", {"slug": "acme"}]
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            boards = boards_from([good] + bad)
        self.assertIn(tuple(good), boards)
        for row in bad:
            with self.subTest(row=row):
                self.assertNotIn(tuple(row) if isinstance(row, list) else row, boards)
                self.assertIn(repr(row), err.getvalue())

    def test_a_malformed_row_cannot_smuggle_a_blocked_company_in(self):
        # The block holds whatever shape a row arrives in: a Rocket Lab row with
        # a bad partner column, or too few columns, must not survive either way.
        with contextlib.redirect_stderr(io.StringIO()):
            boards = boards_from([["greenhouse", "rocketlabusa", 7, "defense"],
                                  ["workday", 99, "Rocket Lab", "defense"],
                                  ["lever", "rocketlabinc"]])
        self.assertEqual([b for b in boards
                          if b[1] in ("rocketlabusa", 99, "rocketlabinc")], [])

    def test_an_unreadable_boards_json_falls_back_to_the_seed_boards(self):
        # A trailing comma is the classic hand edit. This runs while the module
        # is imported and discord_bot.py loads it at import with no try, so a
        # raise here would stop the whole bot — the puzzle included — over a
        # file the tracker can run without. puzzle_admins.py already describes
        # boards.json this way: it "falls back to a seed list". A top level that
        # is not a list — an object, null, a bare number — gets the same.
        for raw in ('[["greenhouse", "acme", "Acme", "tech"],]', "",
                    '{"boards": []}', "null", "5"):
            with self.subTest(raw=raw):
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    boards = boards_from(raw=raw)
                self.assertEqual(len(boards), len(poller.SEED_BOARDS) - 1)
                self.assertIn("boards.json", err.getvalue())


class Boot(unittest.TestCase):
    """The poller imports whatever state boards.json is in.

    What this pins is not a wrong answer but a bot that will not start.
    `BOARDS = load_boards()` runs while the module is imported, and
    discord_bot.py loads this module at import with no try around it, so an
    exception there takes every command down with it, the puzzle included.
    Each test loads the poller the way the bot does — exec_module on a copy
    with a hand-edited boards.json beside it — under a name of its own, so the
    module the rest of this file tests is left alone. This imports the poller
    only; the bot itself was checked by hand.
    """

    def _import_with(self, text):
        with tempfile.TemporaryDirectory() as d:
            shutil.copy(poller.__file__, d)
            with open(os.path.join(d, "boards.json"), "w") as f:
                f.write(text)
            spec = importlib.util.spec_from_file_location(
                "internship_poller_import_check",
                os.path.join(d, "internship_poller.py"))
            module = importlib.util.module_from_spec(spec)
            with contextlib.redirect_stderr(io.StringIO()):
                spec.loader.exec_module(module)
        return module

    def test_the_poller_still_imports_with_a_malformed_boards_json(self):
        module = self._import_with(json.dumps(
            [["greenhouse", "acme"], ["greenhouse", "acmetwo", 7, "tech"],
             ["lever", 12345, "Some Co", "misc"], [], 5,
             ["greenhouse", "rocketlabusa", "rocketlabusa", "unknown"],
             ["greenhouse", "anduril", "anduril", "unknown"]]))
        self.assertIn(("greenhouse", "anduril", "anduril", "unknown"), module.BOARDS)
        self.assertFalse([b for b in module.BOARDS
                          if b[1] in ("acme", "acmetwo", 12345, "rocketlabusa")])

    def test_the_poller_still_imports_with_a_boards_json_that_will_not_parse(self):
        module = self._import_with('[["greenhouse", "acme", "Acme", "tech"],]')
        self.assertEqual(len(module.BOARDS), len(module.SEED_BOARDS) - 1)


class Sweep(unittest.TestCase):
    def test_one_bad_row_does_not_stop_the_sweep(self):
        # The failure this pins is silent. fetch_all spreads every row into a
        # five-argument call, so a row of the wrong length used to raise before
        # any board was polled — on every sweep, with the bot's loop catching
        # the error and nothing to show for it but a "last sweep" in
        # /internships debug that kept getting older. Networking is stubbed:
        # nothing is fetched.
        polled = []

        async def adapter(sess, slug, company, sect, etag):
            polled.append(slug)
            return 200, [], None

        class Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

        with contextlib.redirect_stderr(io.StringIO()):
            boards = boards_from([["greenhouse", "one", "One", "tech"],
                                  ["greenhouse", "acme"],
                                  ["lever", "two", "Two", "tech"]])
        saved = poller.BOARDS, poller.ADAPTERS, poller.polite_session
        poller.BOARDS = boards
        poller.ADAPTERS = {b[0]: adapter for b in boards}
        poller.polite_session = lambda **kw: Session()
        try:
            asyncio.run(poller.fetch_all())
        finally:
            poller.BOARDS, poller.ADAPTERS, poller.polite_session = saved
        self.assertIn("one", polled)
        self.assertIn("two", polled)
        self.assertEqual(len(polled), len(boards))


class StoredRows(unittest.TestCase):
    ROWS = [("greenhouse", "1", "SpaceX", "Starship Intern"),
            ("greenhouse", "2", "Rocket Lab", "Avionics Intern"),
            ("greenhouse", "3", "Astranis", "Payload Intern")]

    def test_rows_for_a_blocked_company_are_dropped(self):
        kept = poller.drop_blocked(self.ROWS, company_at=2)
        self.assertEqual([r[2] for r in kept], ["SpaceX", "Astranis"])

    def test_the_company_column_is_the_caller_s_to_name(self):
        rows = [("SpaceX", "x"), ("Rocket Lab", "y")]
        self.assertEqual(poller.drop_blocked(rows, company_at=0),
                         [("SpaceX", "x")])

    def test_the_rows_handed_in_are_not_modified(self):
        rows = list(self.ROWS)
        poller.drop_blocked(rows, company_at=2)
        self.assertEqual(rows, list(self.ROWS))

    def test_order_is_preserved(self):
        # Callers sort by date in SQL and show the result in that order.
        rows = [("Rocket Lab", 3), ("SpaceX", 2), ("Astranis", 1)]
        self.assertEqual(poller.drop_blocked(rows, company_at=0),
                         [("SpaceX", 2), ("Astranis", 1)])


if __name__ == "__main__":
    unittest.main()
