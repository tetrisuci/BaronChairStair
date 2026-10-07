"""
Where `stats.db` lives: `STATS_DB` when it is set, beside the code when not.

    python3 -m unittest discover -s client     # no install needed

A release directory per deploy means a `stats.db` beside the code would be a
fresh, empty file every release — the recap claims that keep a recap from
posting twice, the archive sync window, the presence history and the command
sync hash all gone at once. So the path can come from outside the checkout,
and every place that opens the file has to take it from the one resolver, or
the bot ends up writing half its state to each.

The bot is read rather than imported, for the reason `test_puzzle_recap.py`
gives: importing `discord_bot.py` loads the repository's real .env and opens
its real database.
"""

import ast
import pathlib
import unittest

import stats_db

CLIENT = pathlib.Path(__file__).resolve().parent
ROOT = CLIENT.parent


class Resolving(unittest.TestCase):
    def test_unset_is_beside_the_code_as_before(self):
        self.assertEqual(stats_db.resolve(ROOT, {}), ROOT / "stats.db")

    def test_blank_counts_as_unset(self):
        # `STATS_DB=` left empty in a .env is somebody who has not decided yet,
        # not somebody asking for a file named "".
        for blank in ("", "   "):
            with self.subTest(value=blank):
                self.assertEqual(stats_db.resolve(ROOT, {"STATS_DB": blank}), ROOT / "stats.db")

    def test_an_absolute_path_is_used_as_given(self):
        shared = pathlib.Path("/srv/bcs/shared/stats.db")
        self.assertEqual(stats_db.resolve(ROOT, {"STATS_DB": str(shared)}), shared)

    def test_surrounding_whitespace_is_not_part_of_the_path(self):
        self.assertEqual(stats_db.resolve(ROOT, {"STATS_DB": " /srv/stats.db "}),
                         pathlib.Path("/srv/stats.db"))

    def test_a_relative_path_is_refused_rather_than_resolved_against_the_cwd(self):
        # A relative path would land wherever pm2 happened to be started from,
        # which is what "anchored to the repo root — never CWD" refused.
        for relative in ("stats.db", "shared/stats.db", "~/stats.db"):
            with self.subTest(value=relative):
                with self.assertRaises(stats_db.StatsDbPathError) as raised:
                    stats_db.resolve(ROOT, {"STATS_DB": relative})
                self.assertIn("absolute", str(raised.exception))
                self.assertIn(relative, str(raised.exception))


def _docstring_ids(tree: ast.AST) -> set[int]:
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            first = node.body[0] if node.body else None
            if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                    and isinstance(first.value.value, str)):
                found.add(id(first.value))
    return found


def _bot_sources() -> list[pathlib.Path]:
    """Every module the bot or its root tools are made of, tests aside."""
    modules = [p for p in CLIENT.glob("*.py") if not p.name.startswith("test_")]
    return sorted(modules + list(ROOT.glob("*.py")))


class EveryOpenerUsesTheOnePath(unittest.TestCase):
    """
    Read, not imported. A second `sqlite3.connect(ROOT / "stats.db")` anywhere
    would silently split the bot's state between the shared file and a fresh
    one beside the release, and nothing would fail until a recap posted twice.
    """

    BOT = CLIENT / "discord_bot.py"

    def test_the_file_name_is_spelled_only_by_the_resolver(self):
        offenders = []
        for path in _bot_sources():
            if path.name == "stats_db.py":
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            docs = _docstring_ids(tree)
            for node in ast.walk(tree):
                if (isinstance(node, ast.Constant) and isinstance(node.value, str)
                        and id(node) not in docs and "stats.db" in node.value):
                    offenders.append(f"{path.name}:{node.lineno}")
        self.assertEqual(offenders, [], "stats.db named outside stats_db.resolve")

    def test_the_bot_opens_exactly_one_database_and_it_is_the_resolved_one(self):
        tree = ast.parse(self.BOT.read_text(encoding="utf-8"))
        connects = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Attribute) and n.func.attr == "connect"
                    and isinstance(n.func.value, ast.Name) and n.func.value.id == "sqlite3"]
        self.assertEqual(len(connects), 1)
        (argument,) = connects[0].args
        self.assertIsInstance(argument, ast.Name)
        resolved = [n for n in tree.body if isinstance(n, (ast.Assign, ast.Try))]
        assigned_from_resolver = False
        for node in ast.walk(ast.Module(body=resolved, type_ignores=[])):
            if (isinstance(node, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id == argument.id for t in node.targets)
                    and isinstance(node.value, ast.Call)
                    and isinstance(node.value.func, ast.Attribute)
                    and node.value.func.attr == "resolve"
                    and isinstance(node.value.func.value, ast.Name)
                    and node.value.func.value.id == "stats_db"):
                assigned_from_resolver = True
        self.assertTrue(assigned_from_resolver,
                        f"{argument.id} is not assigned from stats_db.resolve(...)")

    def test_no_root_tool_opens_a_database_of_its_own(self):
        # sync_guilds.py loads discord_bot.py by path and so shares its opener;
        # nothing at the root should grow a connect of its own.
        for path in ROOT.glob("*.py"):
            with self.subTest(tool=path.name):
                self.assertNotIn("sqlite3.connect", path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
