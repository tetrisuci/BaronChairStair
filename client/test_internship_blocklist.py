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

import os
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


class Registry(unittest.TestCase):
    def test_a_blocked_company_is_never_polled(self):
        # The strongest half of the block: no board, no request, no row, so
        # nothing can be announced in the first place. Both identifying columns
        # are checked, because a discovered board only has its slug.
        self.assertFalse([b for b in poller.load_boards()
                          if poller.is_blocked_company(b[1])
                          or poller.is_blocked_company(b[2])])

    def test_the_rest_of_the_registry_survives(self):
        companies = {b[2] for b in poller.load_boards()}
        self.assertIn("SpaceX", companies)
        self.assertNotIn("Rocket Lab", companies)

    def test_a_discovered_board_cannot_reintroduce_a_blocked_company(self):
        # The row shape is the whole point of this test. `cmd_discover` appends
        # [plat, slug, slug, "unknown", n] and dumps r[:4], so a discovered
        # board carries its SLUG in the company column and its sector is always
        # "unknown" — a fixture with a tidy display name in column 2 is a shape
        # discover never writes, and passes while the real thing leaks.
        import json
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "boards.json")
            with open(path, "w") as f:
                json.dump([["lever", "rocketlabusa", "rocketlabusa", "unknown"],
                           ["workday", "rocketlab/wd1/Careers",
                            "rocketlab/wd1/Careers", "unknown"],
                           ["greenhouse", "anduril", "anduril", "unknown"]], f)
            original = poller.BOARDS_FILE
            poller.BOARDS_FILE = path
            try:
                boards = poller.load_boards()
            finally:
                poller.BOARDS_FILE = original
        self.assertEqual([b[1] for b in boards if b[3] == "unknown"], ["anduril"])
        self.assertFalse([b for b in boards
                          if poller.is_blocked_company(b[1])
                          or poller.is_blocked_company(b[2])])


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
