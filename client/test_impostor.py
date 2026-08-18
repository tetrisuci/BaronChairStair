"""
test_impostor.py
~~~~~~~~~~~~~~~~
Unit tests for the Impostor game rules and word storage.

stdlib unittest, so no new dependency:

    python -m unittest discover -s client -p 'test_*.py'
"""

import json
import random
import tempfile
import unittest
from pathlib import Path

import impostor
import impostor_help
from impostor import RoundError, WordPackError


class ParsingTests(unittest.TestCase):

    def test_newlines_separate_groups_commas_stay_inside_one(self):
        self.assertEqual(
            impostor.parse_groups("T-spin double, T-spin triple\nDAS; ARR"),
            (("T-spin double", "T-spin triple"), ("DAS", "ARR")))

    def test_parse_words_flattens_every_group(self):
        self.assertEqual(impostor.parse_words("cat, dog;\nhamster"),
                         ("cat", "dog", "hamster"))

    def test_collapses_inner_whitespace_and_drops_blanks(self):
        self.assertEqual(impostor.parse_words("wall  kick, ,  , floor   kick"),
                         ("wall kick", "floor kick"))

    def test_rejects_oversized_and_empty_words(self):
        self.assertIsNone(impostor.normalize_word(""))
        self.assertIsNone(
            impostor.normalize_word("x" * (impostor.MAX_WORD_LENGTH + 1)))
        self.assertEqual(impostor.normalize_word("  fine  "), "fine")

    def test_pack_names_are_lowercased_and_validated(self):
        self.assertEqual(impostor.normalize_pack_name("  My Pack "), "my pack")
        with self.assertRaises(WordPackError):
            impostor.normalize_pack_name("bad/name")
        with self.assertRaises(WordPackError):
            impostor.normalize_pack_name("")


class RosterParsingTests(unittest.TestCase):
    """Turning a typed "@ana @ben" option into player IDs."""

    ANA = 123456789012345678
    BEN = 223456789012345678

    def test_reads_plain_and_nickname_mentions(self):
        self.assertEqual(
            impostor.parse_user_ids(f"<@{self.ANA}> <@!{self.BEN}>"),
            (self.ANA, self.BEN))

    def test_reads_bare_snowflakes(self):
        self.assertEqual(impostor.parse_user_ids(f"{self.ANA}, {self.BEN}"),
                         (self.ANA, self.BEN))

    def test_keeps_the_order_they_were_written_in(self):
        self.assertEqual(impostor.parse_user_ids(f"<@{self.BEN}> <@{self.ANA}>"),
                         (self.BEN, self.ANA))

    def test_naming_someone_twice_collapses(self):
        self.assertEqual(
            impostor.parse_user_ids(f"<@{self.ANA}> <@{self.ANA}>"),
            (self.ANA,))

    def test_ignores_numbers_too_short_to_be_a_user(self):
        self.assertEqual(impostor.parse_user_ids("play with 5 people at 12pm"),
                         ())

    def test_ignores_role_and_channel_mentions(self):
        # <@&...> is a role and <#...> a channel; neither can hold a word.
        self.assertEqual(
            impostor.parse_user_ids(f"<@&{self.ANA}> <#{self.BEN}>"), ())

    def test_survives_surrounding_prose(self):
        self.assertEqual(
            impostor.parse_user_ids(f"me and <@{self.ANA}> plus <@{self.BEN}>!"),
            (self.ANA, self.BEN))


class WordPackFileTests(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "words.json"
        self.packs = impostor.WordPacks(self.path)

    def read_file(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    @staticmethod
    def ref(name, owner=None):
        return impostor.PackRef(name, owner)

    def names(self):
        return tuple(r.name for r in self.packs.shared_refs())

    def test_seeds_defaults_when_the_file_is_missing(self):
        # Arrange: nothing on disk.
        # Act
        names = self.names()
        # Assert
        self.assertEqual(names, tuple(sorted(impostor.DEFAULT_PACKS)))
        self.assertTrue(self.path.exists())

    def test_add_creates_a_pack_and_persists_it(self):
        result = self.packs.add(self.ref("Terms"), [["T-spin", "S-spin"]])

        self.assertEqual(result.pack, self.ref("terms"))
        self.assertEqual(result.added, ("T-spin", "S-spin"))
        self.assertTrue(result.pack_created)
        self.assertEqual(self.read_file()["terms"], [["T-spin", "S-spin"]])

    def test_add_stores_each_line_as_its_own_group(self):
        self.packs.add(self.ref("terms"), impostor.parse_groups("DAS, ARR\nquad, tetris"))

        self.assertEqual(self.packs.groups(self.ref("terms")),
                         (("DAS", "ARR"), ("quad", "tetris")))

    def test_add_reports_duplicates_case_insensitively(self):
        self.packs.add(self.ref("terms"), [["quad"]])

        result = self.packs.add(self.ref("terms"), [["QUAD", "tetris"]])

        self.assertEqual(result.added, ("tetris",))
        self.assertEqual(result.duplicates, ("QUAD",))
        self.assertEqual(self.packs.words(self.ref("terms")), ("quad", "tetris"))

    def test_a_shared_word_merges_into_the_existing_group(self):
        self.packs.add(self.ref("terms"), [["T-spin double", "T-spin triple"]])

        result = self.packs.add(self.ref("terms"), [["T-spin triple", "T-spin single"]])

        # One group, not two: the shared word joined them up.
        self.assertEqual(
            self.packs.groups(self.ref("terms")),
            (("T-spin double", "T-spin triple", "T-spin single"),))
        self.assertEqual(len(result.merged), 1)

    def test_an_add_can_fuse_two_existing_groups(self):
        self.packs.add(self.ref("terms"), impostor.parse_groups("DAS, ARR\nSDF, ARR2"))

        self.packs.add(self.ref("terms"), [["DAS", "SDF"]])

        self.assertEqual(len(self.packs.groups(self.ref("terms"))), 1)

    def test_add_reports_invalid_words_without_storing_them(self):
        result = self.packs.add(self.ref("terms"), [["ok", "  ", "y" * 200]])

        self.assertEqual(result.added, ("ok",))
        self.assertEqual(len(result.invalid), 2)

    def test_remove_drops_words_and_reports_misses(self):
        self.packs.add(self.ref("terms"), [["DAS", "ARR", "SDF"]])

        result = self.packs.remove(self.ref("terms"), ["arr", "llama"])

        self.assertEqual(result.removed, ("ARR",))
        self.assertEqual(result.missing, ("llama",))
        self.assertEqual(self.packs.words(self.ref("terms")), ("DAS", "SDF"))

    def test_emptying_a_group_drops_only_that_group(self):
        self.packs.add(self.ref("terms"), impostor.parse_groups("DAS, ARR\nquad, tetris"))

        self.packs.remove(self.ref("terms"), ["DAS", "ARR"])

        self.assertEqual(self.packs.groups(self.ref("terms")), (("quad", "tetris"),))

    def test_emptying_a_pack_deletes_it(self):
        self.packs.add(self.ref("terms"), [["quad"]])

        result = self.packs.remove(self.ref("terms"), ["quad"])

        self.assertTrue(result.pack_deleted)
        self.assertNotIn("terms", self.names())
        self.assertNotIn("terms", self.read_file())

    def test_remove_from_unknown_pack_raises(self):
        with self.assertRaises(WordPackError):
            self.packs.remove(self.ref("ghosts"), ["boo"])

    def test_delete_pack_returns_its_size(self):
        self.packs.add(self.ref("terms"), [["quad", "tetris"]])

        self.assertEqual(self.packs.delete_pack(self.ref("terms")), 2)
        self.assertNotIn("terms", self.names())

    def test_hand_edits_are_picked_up_without_a_restart(self):
        self.packs.add(self.ref("terms"), [["quad"]])

        # Someone edits the JSON by hand while the bot is running.
        self.path.write_text(json.dumps({"terms": [["quad", "tetris"]]}),
                             encoding="utf-8")

        self.assertEqual(self.packs.words(self.ref("terms")), ("quad", "tetris"))

    def test_hand_edits_are_not_clobbered_by_a_later_add(self):
        self.packs.add(self.ref("terms"), [["quad"]])
        self.path.write_text(json.dumps({"terms": [["quad"], ["DAS"]]}),
                             encoding="utf-8")

        self.packs.add(self.ref("terms"), [["ARR"]])

        self.assertEqual(self.read_file()["terms"], [["quad"], ["DAS"], ["ARR"]])

    def test_corrupt_json_raises_a_readable_error(self):
        self.path.write_text("{not json", encoding="utf-8")

        with self.assertRaises(WordPackError):
            self.names()

    def test_wrong_shape_is_rejected_whole(self):
        self.path.write_text(json.dumps({"terms": "quad"}), encoding="utf-8")

        with self.assertRaises(WordPackError):
            self.names()

    def test_a_bare_string_loads_as_a_group_of_one(self):
        self.path.write_text(json.dumps({"terms": ["finesse", ["DAS", "ARR"]]}),
                             encoding="utf-8")

        self.assertEqual(self.packs.groups(self.ref("terms")),
                         (("finesse",), ("DAS", "ARR")))

    def test_duplicate_entries_in_a_hand_edit_are_dropped(self):
        self.path.write_text(
            json.dumps({"terms": [["quad", "QUAD", "", "tetris"]]}),
            encoding="utf-8")

        self.assertEqual(self.packs.words(self.ref("terms")), ("quad", "tetris"))

    def test_pick_from_a_named_pack_stays_in_that_pack(self):
        self.packs.add(self.ref("terms"), [["quad", "tetris"]])
        self.packs.add(self.ref("players"), [["diao", "garbo"]])

        picked = self.packs.pick(self.ref("terms"), rng=random.Random(1))

        self.assertEqual(picked.pack, self.ref("terms"))
        self.assertIn(picked.word, ("quad", "tetris"))

    def test_the_decoy_is_a_different_word_from_the_same_group(self):
        self.packs.add(self.ref("terms"), impostor.parse_groups(
            "T-spin double, T-spin triple\nDAS, ARR"))
        rng = random.Random(5)

        for _ in range(50):
            picked = self.packs.pick(self.ref("terms"), decoy=True, rng=rng)
            group = next(g for g in self.packs.groups(self.ref("terms"))
                         if picked.word in g)
            self.assertIn(picked.decoy, group)
            self.assertNotEqual(picked.decoy, picked.word)

    def test_solo_groups_are_skipped_when_a_decoy_is_wanted(self):
        self.packs.add(self.ref("terms"), impostor.parse_groups(
            "finesse\nDAS, ARR"))
        rng = random.Random(11)

        drawn = {self.packs.pick(self.ref("terms"), decoy=True, rng=rng).word
                 for _ in range(40)}

        self.assertNotIn("finesse", drawn)
        self.assertEqual(drawn, {"DAS", "ARR"})

    def test_solo_groups_are_fine_without_a_decoy(self):
        self.packs.add(self.ref("terms"), [["finesse"]])

        picked = self.packs.pick(self.ref("terms"), decoy=False, rng=random.Random(1))

        self.assertEqual(picked.word, "finesse")
        self.assertIsNone(picked.decoy)

    def test_a_pack_with_no_pairs_says_so_rather_than_dealing(self):
        self.packs.add(self.ref("terms"), impostor.parse_groups("finesse\nmisdrop"))

        with self.assertRaises(WordPackError) as caught:
            self.packs.pick(self.ref("terms"), decoy=True)

        self.assertIn("similar", str(caught.exception))

    def test_pick_across_packs_is_weighted_by_word_count(self):
        self.path.write_text(
            json.dumps({"big": [[f"w{i}" for i in range(99)]],
                        "tiny": [["only", "one"]]}),
            encoding="utf-8")
        rng = random.Random(7)

        tiny_hits = sum(1 for _ in range(400)
                        if self.packs.pick(rng=rng).pack.name == "tiny")

        # 2 words in 101: a pack-first pick would land near 200.
        self.assertLess(tiny_hits, 40)

    def test_pick_from_an_unknown_or_empty_pack_raises(self):
        with self.assertRaises(WordPackError):
            self.packs.pick(self.ref("ghosts"))

    def test_pick_with_no_words_at_all_raises(self):
        self.path.write_text("{}", encoding="utf-8")

        with self.assertRaises(WordPackError):
            self.packs.pick()

    def test_pack_stats_count_words_groups_and_usable_groups(self):
        self.packs.add(self.ref("terms"), impostor.parse_groups(
            "DAS, ARR\nfinesse"))

        stats = self.packs.counts()[self.ref("terms")]

        self.assertEqual((stats.words, stats.groups, stats.decoy_groups),
                         (3, 2, 1))

    def test_a_failed_write_leaves_the_original_file_untouched(self):
        self.packs.add(self.ref("terms"), [["quad"]])
        before = self.path.read_text(encoding="utf-8")
        # A path that cannot be created: the write must fail, not half-happen.
        broken = impostor.WordPacks(self.path / "words.json")

        with self.assertRaises(WordPackError):
            broken.add(impostor.PackRef("terms"), [["quad"]])

        self.assertEqual(self.path.read_text(encoding="utf-8"), before)


class RoundTests(unittest.TestCase):

    PLAYERS = (1, 2, 3, 4, 5)

    def test_everyone_but_the_impostors_shares_the_word(self):
        rnd = impostor.assign_roles(self.PLAYERS, pack="terms", word="quad",
                                    rng=random.Random(3))

        self.assertEqual(len(rnd.impostor_ids), 1)
        self.assertEqual(len(rnd.crew_ids), 4)
        self.assertEqual(set(rnd.impostor_ids) | set(rnd.crew_ids),
                         set(self.PLAYERS))

    def test_impostor_order_follows_join_order(self):
        rnd = impostor.assign_roles(self.PLAYERS, pack="terms", word="quad",
                                    impostors=2, rng=random.Random(0))

        self.assertEqual(list(rnd.impostor_ids), sorted(rnd.impostor_ids))

    def test_impostor_count_scales_with_table_size(self):
        self.assertEqual(impostor.default_impostor_count(3), 1)
        self.assertEqual(impostor.default_impostor_count(6), 1)
        self.assertEqual(impostor.default_impostor_count(7), 2)
        self.assertEqual(impostor.default_impostor_count(12), 3)

    def test_impostors_can_never_reach_half_the_table(self):
        self.assertEqual(impostor.max_impostor_count(3), 1)
        self.assertEqual(impostor.max_impostor_count(5), 2)
        self.assertEqual(impostor.max_impostor_count(10), 4)

    def test_too_few_players_is_refused(self):
        with self.assertRaises(RoundError):
            impostor.assign_roles((1, 2), pack="terms", word="quad")

    def test_too_many_players_is_refused(self):
        players = tuple(range(impostor.MAX_PLAYERS + 1))
        with self.assertRaises(RoundError):
            impostor.assign_roles(players, pack="terms", word="quad")

    def test_duplicate_players_are_refused(self):
        with self.assertRaises(RoundError):
            impostor.assign_roles((1, 1, 2), pack="terms", word="quad")

    def test_impostor_count_above_the_cap_is_refused(self):
        with self.assertRaises(RoundError):
            impostor.assign_roles((1, 2, 3), pack="terms", word="quad",
                                  impostors=2)

    def test_zero_impostors_is_refused(self):
        with self.assertRaises(RoundError):
            impostor.assign_roles(self.PLAYERS, pack="terms", word="quad",
                                  impostors=0)

    def test_a_decoy_matching_the_crew_word_is_refused(self):
        with self.assertRaises(RoundError):
            impostor.assign_roles(self.PLAYERS, pack="terms", word="quad",
                                  decoy="QUAD")

    def test_a_blind_round_without_a_decoy_is_refused(self):
        # Otherwise the impostor is told nothing at all and cannot play.
        with self.assertRaises(RoundError):
            impostor.assign_roles(self.PLAYERS, pack="terms", word="quad",
                                  blind=True)


class GuessTests(unittest.TestCase):

    GROUP = ("T-spin single", "T-spin double", "T-spin triple")

    def make_round(self, candidates=None, blind=False, decoy="T-spin triple",
                   allow_guess=True):
        if candidates is None:
            candidates = self.GROUP
        return impostor.Round(pack="tetris terms", word="T-spin double",
                              player_ids=(1, 2, 3), impostor_ids=(2,),
                              show_category=True, decoy=decoy, blind=blind,
                              candidates=tuple(candidates),
                              allow_guess=allow_guess)

    def test_the_menu_always_contains_the_answer(self):
        rng = random.Random(2)
        pool = [f"filler{i}" for i in range(80)]

        for _ in range(30):
            menu = impostor.build_candidates(
                "T-spin double", self.GROUP, pool=pool, rng=rng)
            self.assertIn("T-spin double", menu)

    def test_the_menu_respects_discord_option_cap(self):
        pool = [f"filler{i}" for i in range(200)]

        menu = impostor.build_candidates("answer", ("answer", "near"),
                                         pool=pool, rng=random.Random(1))

        self.assertLessEqual(len(menu), impostor.MAX_GUESS_OPTIONS)
        self.assertIn("answer", menu)

    def test_the_menu_holds_the_whole_group_before_any_filler(self):
        menu = impostor.build_candidates("T-spin double", self.GROUP,
                                         pool=["quad", "tetris"],
                                         rng=random.Random(3))

        for word in self.GROUP:
            self.assertIn(word, menu)

    def test_the_menu_never_repeats_a_word(self):
        menu = impostor.build_candidates(
            "T-spin double", self.GROUP,
            pool=["T-spin double", "quad", "quad"], rng=random.Random(4))

        self.assertEqual(len(menu), len(set(menu)))

    def test_a_correct_guess_is_a_win(self):
        self.assertTrue(impostor.resolve_guess(self.make_round(),
                                               "T-spin double"))

    def test_guessing_is_case_insensitive(self):
        self.assertTrue(impostor.resolve_guess(self.make_round(),
                                               "t-spin DOUBLE"))

    def test_a_wrong_guess_is_a_loss(self):
        self.assertFalse(impostor.resolve_guess(self.make_round(),
                                                "T-spin triple"))

    def test_a_word_that_was_not_offered_is_refused(self):
        with self.assertRaises(RoundError):
            impostor.resolve_guess(self.make_round(), "quad")

    def test_guessing_a_round_that_disallows_it_is_refused(self):
        with self.assertRaises(RoundError):
            impostor.resolve_guess(self.make_round(candidates=()), "anything")

    def test_a_round_whose_menu_omits_the_answer_is_refused(self):
        # An unwinnable menu is worse than no menu at all.
        with self.assertRaises(RoundError):
            impostor.assign_roles((1, 2, 3), pack="terms", word="quad",
                                  candidates=("tetris", "triple"))

    def test_a_blind_round_cannot_offer_guessing(self):
        with self.assertRaises(RoundError):
            impostor.assign_roles((1, 2, 3), pack="terms", word="quad",
                                  decoy="tetris", blind=True,
                                  candidates=("quad", "tetris"),
                                  allow_guess=True)

    def test_a_blind_round_may_still_show_the_board(self):
        # Reading a public list tells the impostor nothing about their role.
        rnd = impostor.assign_roles((1, 2, 3), pack="terms", word="quad",
                                    decoy="tetris", blind=True,
                                    candidates=("quad", "tetris", "triple"),
                                    show_words=True)

        self.assertTrue(impostor.word_board(rnd))
        self.assertFalse(rnd.guessing_allowed)

    def test_showing_the_board_does_not_switch_guessing_back_on(self):
        # Board and guess menu are the same list, so this is the trap.
        rnd = impostor.assign_roles((1, 2, 3), pack="terms", word="quad",
                                    candidates=("quad", "tetris", "triple"),
                                    show_words=True, allow_guess=False)

        self.assertFalse(rnd.guessing_allowed)
        with self.assertRaises(RoundError):
            impostor.resolve_guess(rnd, "quad")

    def test_guessing_without_a_list_is_refused(self):
        with self.assertRaises(RoundError):
            impostor.assign_roles((1, 2, 3), pack="terms", word="quad",
                                  allow_guess=True)

    def test_the_impostor_dm_mentions_guessing_only_when_offered(self):
        self.assertIn("Guess", impostor.role_message(self.make_round(), 2))
        self.assertNotIn("Guess", impostor.role_message(
            self.make_round(allow_guess=False), 2))


class WordBoardTests(unittest.TestCase):
    """The public list of possible words, shown at the start of the round."""

    def make_round(self, show_words=True, candidates=("quad", "DAS", "tetris")):
        return impostor.Round(pack="tetris terms", word="quad",
                              player_ids=(1, 2, 3), impostor_ids=(2,),
                              show_category=True, decoy="tetris",
                              candidates=tuple(candidates),
                              show_words=show_words)

    def test_the_board_lists_every_candidate(self):
        board = impostor.word_board(self.make_round())

        for word in ("quad", "DAS", "tetris"):
            self.assertIn(word, board)

    def test_the_board_is_sorted_not_left_in_dealt_order(self):
        # Dealt order is random, so sorting leaks nothing and scans better.
        board = impostor.word_board(self.make_round())

        self.assertLess(board.index("DAS"), board.index("quad"))

    def test_the_board_is_empty_when_switched_off(self):
        self.assertEqual(impostor.word_board(self.make_round(show_words=False)),
                         "")

    def test_the_board_is_empty_when_there_are_no_candidates(self):
        self.assertEqual(
            impostor.word_board(self.make_round(candidates=())), "")

    def test_the_board_always_contains_the_crew_word(self):
        rnd = self.make_round()

        self.assertIn(rnd.word, impostor.word_board(rnd))

    def test_a_board_round_refuses_to_deal_with_nothing_to_show(self):
        with self.assertRaises(RoundError):
            impostor.assign_roles((1, 2, 3), pack="terms", word="quad",
                                  show_words=True)


class ImportTests(unittest.TestCase):
    """Bulk word import from an uploaded file."""

    def parse(self, text, filename="words.txt"):
        return impostor.parse_import(text.encode("utf-8"), filename)

    def test_a_text_file_uses_the_same_grammar_as_the_add_option(self):
        groups = self.parse("T-spin double, T-spin triple\nDAS, ARR, SDF")

        self.assertEqual(groups, (("T-spin double", "T-spin triple"),
                                  ("DAS", "ARR", "SDF")))

    def test_a_json_file_takes_a_list_of_groups(self):
        groups = self.parse('[["quad", "tetris"], ["DAS", "ARR"]]',
                            "words.json")

        self.assertEqual(groups, (("quad", "tetris"), ("DAS", "ARR")))

    def test_a_bare_string_in_json_is_a_group_of_one(self):
        groups = self.parse('["finesse", ["DAS", "ARR"]]', "words.json")

        self.assertEqual(groups, (("finesse",), ("DAS", "ARR")))

    def test_the_format_follows_the_extension_not_the_content(self):
        # A .txt holding JSON is read as text, so the result is predictable.
        groups = self.parse('["quad", "tetris"]', "words.txt")

        self.assertNotEqual(groups, (("quad",), ("tetris",)))

    def test_a_whole_word_file_is_refused_with_a_pointer(self):
        with self.assertRaises(WordPackError) as caught:
            self.parse('{"terms": [["quad", "tetris"]]}', "words.json")

        self.assertIn("one pack at a time", str(caught.exception))

    def test_broken_json_names_the_line(self):
        with self.assertRaises(WordPackError) as caught:
            self.parse('[["quad",\n "tetris"', "words.json")

        self.assertIn("valid JSON", str(caught.exception))

    def test_non_text_entries_in_json_are_refused(self):
        with self.assertRaises(WordPackError):
            self.parse('[["quad", 7]]', "words.json")

    def test_an_empty_file_is_refused(self):
        with self.assertRaises(WordPackError) as caught:
            self.parse("   \n\n  ")

        self.assertIn("no words", str(caught.exception))

    def test_a_file_over_the_byte_cap_is_refused(self):
        oversized = b"a\n" * impostor.MAX_IMPORT_BYTES

        with self.assertRaises(WordPackError) as caught:
            impostor.parse_import(oversized, "words.txt")

        self.assertIn("limit", str(caught.exception))

    def test_a_file_over_the_word_cap_is_refused(self):
        many = "\n".join(f"w{i}" for i in range(impostor.MAX_IMPORT_WORDS + 1))

        with self.assertRaises(WordPackError) as caught:
            self.parse(many)

        self.assertIn(f"{impostor.MAX_IMPORT_WORDS:,}", str(caught.exception))

    def test_a_file_that_is_not_utf8_is_refused(self):
        with self.assertRaises(WordPackError) as caught:
            impostor.parse_import(b"\xff\xfe not utf8", "words.txt")

        self.assertIn("UTF-8", str(caught.exception))

    def test_an_import_goes_through_the_normal_add_rules(self):
        # Dedupe, merging and validation are add()'s job, not the parser's.
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        packs = impostor.WordPacks(Path(directory.name) / "w.json")
        ref = impostor.PackRef("terms")
        packs.add(ref, [["quad", "tetris"]])

        result = packs.add(ref, self.parse("quad, triple\nDAS, ARR"))

        self.assertIn("triple", result.added)
        self.assertIn("quad", result.duplicates)
        self.assertEqual(len(result.merged), 1)


class PersonalPackTests(unittest.TestCase):
    """Packs tied to one Discord user: only they edit them, only they play them."""

    ANA = 111111111111111111
    BEN = 222222222222222222

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "words.json"
        # Start empty: a missing file seeds DEFAULT_PACKS, which would muddy
        # the "what can be drawn" assertions below.
        self.path.write_text("{}", encoding="utf-8")
        self.packs = impostor.WordPacks(self.path)
        self.packs.add(impostor.PackRef("shared"), [["quad", "tetris", "triple"]])

    def mine(self, owner, name="memes"):
        return impostor.PackRef(name, owner)

    def read_file(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def test_a_personal_pack_is_stored_under_its_owner(self):
        self.packs.add(self.mine(self.ANA), [["a", "b", "c"]])

        self.assertIn(f"memes@{self.ANA}", self.read_file())

    def test_two_users_can_own_a_pack_of_the_same_name(self):
        self.packs.add(self.mine(self.ANA), [["ana one", "ana two"]])
        self.packs.add(self.mine(self.BEN), [["ben one", "ben two"]])

        self.assertEqual(self.packs.words(self.mine(self.ANA)),
                         ("ana one", "ana two"))
        self.assertEqual(self.packs.words(self.mine(self.BEN)),
                         ("ben one", "ben two"))

    def test_a_personal_pack_never_collides_with_a_shared_one(self):
        self.packs.add(impostor.PackRef("memes"), [["server one", "server two"]])
        self.packs.add(self.mine(self.ANA), [["ana one", "ana two"]])

        self.assertEqual(self.packs.words(impostor.PackRef("memes")),
                         ("server one", "server two"))
        self.assertEqual(self.packs.words(self.mine(self.ANA)),
                         ("ana one", "ana two"))

    def test_you_only_see_shared_packs_and_your_own(self):
        self.packs.add(self.mine(self.ANA), [["a", "b"]])
        self.packs.add(self.mine(self.BEN), [["c", "d"]])

        visible = self.packs.visible_refs(self.ANA)

        self.assertIn(self.mine(self.ANA), visible)
        self.assertNotIn(self.mine(self.BEN), visible)
        self.assertIn(impostor.PackRef("shared"), visible)

    def test_resolving_your_own_name_prefers_your_pack(self):
        self.packs.add(impostor.PackRef("memes"), [["server one", "server two"]])
        self.packs.add(self.mine(self.ANA), [["ana one", "ana two"]])

        self.assertEqual(self.packs.resolve("memes", self.ANA),
                         self.mine(self.ANA))

    def test_resolving_falls_back_to_the_shared_pack(self):
        self.packs.add(impostor.PackRef("memes"), [["server one", "server two"]])

        self.assertEqual(self.packs.resolve("memes", self.BEN),
                         impostor.PackRef("memes"))

    def test_you_cannot_resolve_somebody_elses_pack_by_name(self):
        self.packs.add(self.mine(self.ANA), [["a", "b"]])

        with self.assertRaises(WordPackError) as caught:
            self.packs.resolve("memes", self.BEN)

        self.assertIn("someone else", str(caught.exception))

    def test_you_cannot_resolve_somebody_elses_pack_by_key(self):
        self.packs.add(self.mine(self.ANA), [["a", "b"]])

        with self.assertRaises(WordPackError):
            self.packs.resolve(f"memes@{self.ANA}", self.BEN)

    def test_the_owner_can_resolve_their_pack_by_key(self):
        self.packs.add(self.mine(self.ANA), [["a", "b"]])

        self.assertEqual(self.packs.resolve(f"memes@{self.ANA}", self.ANA),
                         self.mine(self.ANA))

    def test_an_unnamed_draw_never_touches_personal_packs(self):
        # One person's private words must not turn up at a table that did not
        # ask for them.
        self.packs.add(self.mine(self.ANA), [["secret one", "secret two"]])
        rng = random.Random(3)

        drawn = {self.packs.pick(rng=rng).pack for _ in range(60)}

        self.assertEqual(drawn, {impostor.PackRef("shared")})

    def test_a_named_personal_draw_uses_only_that_pack(self):
        self.packs.add(self.mine(self.ANA), [["secret one", "secret two"]])
        rng = random.Random(3)

        drawn = {self.packs.pick(self.mine(self.ANA), rng=rng).word
                 for _ in range(20)}

        self.assertEqual(drawn, {"secret one", "secret two"})

    def test_personal_packs_are_capped_per_user(self):
        for i in range(impostor.MAX_PERSONAL_PACKS):
            self.packs.add(self.mine(self.ANA, f"pack{i}"), [["a", "b"]])

        with self.assertRaises(WordPackError) as caught:
            self.packs.add(self.mine(self.ANA, "one too many"), [["a", "b"]])

        self.assertIn(str(impostor.MAX_PERSONAL_PACKS), str(caught.exception))

    def test_the_cap_is_per_user_not_global(self):
        for i in range(impostor.MAX_PERSONAL_PACKS):
            self.packs.add(self.mine(self.ANA, f"pack{i}"), [["a", "b"]])

        self.packs.add(self.mine(self.BEN, "fine"), [["a", "b"]])

        self.assertEqual(self.packs.personal_pack_count(self.BEN), 1)

    def test_adding_to_a_pack_you_already_own_is_not_capped(self):
        for i in range(impostor.MAX_PERSONAL_PACKS):
            self.packs.add(self.mine(self.ANA, f"pack{i}"), [["a", "b"]])

        result = self.packs.add(self.mine(self.ANA, "pack0"), [["c"]])

        self.assertEqual(result.added, ("c",))

    def test_deleting_your_pack_frees_a_slot(self):
        self.packs.add(self.mine(self.ANA), [["a", "b"]])

        self.packs.delete_pack(self.mine(self.ANA))

        self.assertEqual(self.packs.personal_pack_count(self.ANA), 0)

    def test_a_file_written_before_personal_packs_loads_as_shared(self):
        self.path.write_text(json.dumps({"terms": [["quad", "tetris"]]}),
                             encoding="utf-8")

        refs = self.packs.shared_refs()

        self.assertEqual(refs, (impostor.PackRef("terms"),))
        self.assertIsNone(refs[0].owner_id)

    def test_pack_names_are_normalised_inside_the_ref(self):
        # Two dict keys for one pack would silently store it twice.
        self.assertEqual(impostor.PackRef("  My Pack "),
                         impostor.PackRef("my pack"))

    def test_a_personal_key_round_trips(self):
        ref = self.mine(self.ANA)

        self.assertEqual(impostor.parse_pack_key(ref.key), ref)

    def test_a_shared_key_round_trips(self):
        ref = impostor.PackRef("tetris terms")

        self.assertEqual(impostor.parse_pack_key(ref.key), ref)

    def test_labels_say_whose_pack_it_is(self):
        ref = self.mine(self.ANA)

        self.assertIn("yours", ref.label(self.ANA))
        self.assertNotIn("yours", ref.label(self.BEN))
        self.assertEqual(impostor.PackRef("shared").label(self.ANA), "shared")


class PackSelectionTests(unittest.TestCase):
    """Telling a picked pack apart from a typed one."""

    ANA = 111111111111111111

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        path = Path(self.dir.name) / "words.json"
        path.write_text("{}", encoding="utf-8")
        self.packs = impostor.WordPacks(path)
        self.packs.add(impostor.PackRef("memes"), [["server one", "server two"]])
        self.packs.add(impostor.PackRef("memes", self.ANA),
                       [["ana one", "ana two"]])

    def test_a_typed_name_is_not_explicit(self):
        ref, explicit = impostor.parse_pack_selection("memes")

        self.assertFalse(explicit)
        self.assertIsNone(ref.owner_id)

    def test_a_picked_personal_pack_is_explicit(self):
        ref, explicit = impostor.parse_pack_selection(f"memes@{self.ANA}")

        self.assertTrue(explicit)
        self.assertEqual(ref.owner_id, self.ANA)

    def test_a_picked_shared_pack_is_explicit(self):
        ref, explicit = impostor.parse_pack_selection(
            impostor.SHARED_MARKER + "memes")

        self.assertTrue(explicit)
        self.assertIsNone(ref.owner_id)

    def test_typing_a_name_still_prefers_your_own_pack(self):
        self.assertEqual(self.packs.resolve("memes", self.ANA),
                         impostor.PackRef("memes", self.ANA))

    def test_picking_the_shared_pack_does_not_open_yours_instead(self):
        # The whole point of the marker: the picker said "the server's one".
        resolved = self.packs.resolve(impostor.SHARED_MARKER + "memes",
                                      self.ANA)

        self.assertEqual(resolved, impostor.PackRef("memes"))

    def test_picking_a_shared_pack_that_is_gone_says_so(self):
        with self.assertRaises(WordPackError) as caught:
            self.packs.resolve(impostor.SHARED_MARKER + "ghosts", self.ANA)

        self.assertIn("server pack", str(caught.exception))

    def test_the_marker_cannot_be_typed_as_a_pack_name(self):
        with self.assertRaises(WordPackError):
            impostor.normalize_pack_name(impostor.SHARED_MARKER + "memes")


class GuessGroupSizeTests(unittest.TestCase):
    """A pair leaks the answer to a decoy-holding impostor; three does not."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.packs = impostor.WordPacks(Path(self.dir.name) / "words.json")

    @staticmethod
    def ref(name, owner=None):
        return impostor.PackRef(name, owner)

    def test_pairs_are_skipped_when_guessing_needs_a_gamble(self):
        self.packs.add(self.ref("terms"), impostor.parse_groups(
            "quad, tetris\nDAS, ARR, SDF"))
        rng = random.Random(9)

        drawn = {self.packs.pick(self.ref("terms"), min_group=impostor.MIN_GUESS_GROUP,
                                 rng=rng).word for _ in range(40)}

        self.assertEqual(drawn, {"DAS", "ARR", "SDF"})

    def test_a_pack_of_only_pairs_explains_the_refusal(self):
        self.packs.add(self.ref("terms"), [["quad", "tetris"]])

        with self.assertRaises(WordPackError) as caught:
            self.packs.pick(self.ref("terms"), min_group=impostor.MIN_GUESS_GROUP)

        self.assertIn("guessing:false", str(caught.exception))

    def test_the_pick_reports_the_group_it_drew_from(self):
        self.packs.add(self.ref("terms"), [["DAS", "ARR", "SDF"]])

        picked = self.packs.pick(self.ref("terms"), rng=random.Random(1))

        self.assertEqual(set(picked.group), {"DAS", "ARR", "SDF"})
        self.assertIn(picked.word, picked.group)

    def test_every_seeded_group_supports_guessing(self):
        # The default packs must work with the default options.
        packs = impostor.coerce_packs(impostor.DEFAULT_PACKS)

        for name, groups in packs.items():
            stats = impostor.group_stats(groups)
            self.assertEqual(stats.guess_groups, stats.groups,
                             f"{name} has groups too small for guessing")


class VotingTests(unittest.TestCase):

    PLAYERS = (1, 2, 3, 4, 5)          # 2 is the impostor throughout

    def make_round(self, blind=False):
        return impostor.Round(pack="tetris terms", word="quad",
                              player_ids=self.PLAYERS, impostor_ids=(2,),
                              show_category=True, decoy="tetris", blind=blind)

    def ballots(self, rnd, *pairs):
        vote = impostor.Vote()
        for voter, target in pairs:
            vote = vote.cast(rnd, voter, target)
        return vote

    def test_voting_out_the_impostor_wins_it_for_the_crew(self):
        rnd = self.make_round()

        vote = self.ballots(rnd, (1, 2), (3, 2), (4, 2), (5, 2), (2, 1))

        outcome = vote.outcome(rnd)
        self.assertEqual(outcome.ejected, 2)
        self.assertTrue(outcome.crew_won)

    def test_voting_out_a_crewmate_loses_it(self):
        rnd = self.make_round()

        vote = self.ballots(rnd, (1, 3), (2, 3), (4, 3), (5, 3), (3, 1))

        outcome = vote.outcome(rnd)
        self.assertEqual(outcome.ejected, 3)
        self.assertFalse(outcome.crew_won)

    def test_a_plurality_is_enough(self):
        rnd = self.make_round()

        vote = self.ballots(rnd, (1, 2), (3, 2), (4, 5), (5, 4))

        self.assertEqual(vote.outcome(rnd).ejected, 2)

    def test_a_tie_ejects_nobody_and_settles_nothing(self):
        rnd = self.make_round()

        vote = self.ballots(rnd, (1, 2), (3, 4))

        outcome = vote.outcome(rnd)
        self.assertIsNone(outcome.ejected)
        self.assertEqual(outcome.tied, (2, 4))
        self.assertIsNone(outcome.crew_won)
        self.assertFalse(outcome.is_conclusive)

    def test_an_empty_vote_settles_nothing(self):
        outcome = impostor.Vote().outcome(self.make_round())

        self.assertIsNone(outcome.ejected)
        self.assertIsNone(outcome.crew_won)

    def test_the_impostor_votes_too(self):
        rnd = self.make_round()

        vote = self.ballots(rnd, (2, 3))

        self.assertTrue(vote.has_voted(2))
        self.assertEqual(vote.counts(), {3: 1})

    def test_changing_your_mind_replaces_your_ballot(self):
        rnd = self.make_round()

        vote = self.ballots(rnd, (1, 2), (1, 3))

        self.assertEqual(vote.counts(), {3: 1})
        self.assertEqual(len(vote.ballots), 1)

    def test_casting_returns_a_new_vote_and_leaves_the_old_one_alone(self):
        rnd = self.make_round()
        first = self.ballots(rnd, (1, 2))

        second = first.cast(rnd, 3, 2)

        self.assertEqual(len(first.ballots), 1)
        self.assertEqual(len(second.ballots), 2)

    def test_you_cannot_vote_for_yourself(self):
        rnd = self.make_round()

        with self.assertRaises(RoundError):
            impostor.Vote().cast(rnd, 1, 1)

    def test_outsiders_cannot_vote_or_be_voted_for(self):
        rnd = self.make_round()

        with self.assertRaises(RoundError):
            impostor.Vote().cast(rnd, 99, 1)
        with self.assertRaises(RoundError):
            impostor.Vote().cast(rnd, 1, 99)

    def test_a_vote_is_complete_once_everyone_has_cast(self):
        rnd = self.make_round()
        vote = self.ballots(rnd, (1, 2), (2, 1), (3, 2), (4, 2))

        self.assertFalse(vote.is_complete(rnd))

        self.assertTrue(vote.cast(rnd, 5, 2).is_complete(rnd))

    def test_only_the_crew_may_open_a_vote(self):
        rnd = self.make_round()

        self.assertTrue(impostor.may_call_vote(rnd, 1))
        self.assertFalse(impostor.may_call_vote(rnd, 2))
        self.assertFalse(impostor.may_call_vote(rnd, 99))

    def test_a_blind_round_lets_anyone_open_a_vote(self):
        # Refusing the impostor would tell them they are the impostor.
        rnd = self.make_round(blind=True)

        self.assertTrue(impostor.may_call_vote(rnd, 2))

    def test_you_are_never_offered_yourself_as_a_target(self):
        rnd = self.make_round()

        self.assertEqual(impostor.vote_candidates(rnd, 1), (2, 3, 4, 5))


class RoleMessageTests(unittest.TestCase):

    def make_round(self, show_category=True, decoy=None, blind=False):
        return impostor.Round(pack="tetris terms", word="T-spin double",
                              player_ids=(1, 2, 3), impostor_ids=(2,),
                              show_category=show_category, decoy=decoy,
                              blind=blind)

    def test_crew_are_told_the_word(self):
        text = impostor.role_message(self.make_round(), 1)

        self.assertIn("T-spin double", text)
        self.assertNotIn("IMPOSTOR", text)

    def test_the_impostor_is_never_shown_the_word(self):
        text = impostor.role_message(self.make_round(), 2)

        self.assertIn("IMPOSTOR", text)
        self.assertNotIn("T-spin double", text)

    def test_the_impostor_gets_the_decoy_not_the_crew_word(self):
        rnd = self.make_round(decoy="T-spin triple")

        text = impostor.role_message(rnd, 2)

        self.assertIn("T-spin triple", text)
        self.assertNotIn("T-spin double", text)
        self.assertIn("IMPOSTOR", text)

    def test_crew_never_see_the_decoy(self):
        rnd = self.make_round(decoy="T-spin triple")

        text = impostor.role_message(rnd, 1)

        self.assertIn("T-spin double", text)
        self.assertNotIn("T-spin triple", text)

    def test_a_blind_impostor_is_not_told_they_are_it(self):
        rnd = self.make_round(decoy="T-spin triple", blind=True)

        text = impostor.role_message(rnd, 2)

        self.assertNotIn("IMPOSTOR", text)
        self.assertIn("T-spin triple", text)

    def test_a_blind_round_reads_identically_on_both_sides(self):
        # The impostor must not spot their role from the shape of the DM.
        rnd = self.make_round(decoy="T-spin triple", blind=True)

        crew = impostor.role_message(rnd, 1).replace("T-spin double", "WORD")
        faker = impostor.role_message(rnd, 2).replace("T-spin triple", "WORD")

        self.assertEqual(crew, faker)

    def test_category_can_be_withheld_from_both_sides(self):
        rnd = self.make_round(show_category=False, decoy="T-spin triple")

        for uid in (1, 2):
            self.assertNotIn("tetris terms", impostor.role_message(rnd, uid))

    def test_a_non_player_gets_nothing(self):
        with self.assertRaises(RoundError):
            impostor.role_message(self.make_round(), 99)


class HelpTests(unittest.TestCase):
    """The help must not drift from the constants that enforce the rules."""

    DISCORD_MESSAGE_LIMIT = 2000

    def texts(self):
        return {topic: impostor_help.help_text(topic, lobby_minutes=10,
                                               vote_minutes=5)
                for topic in impostor_help.TOPICS}

    def test_every_topic_returns_something(self):
        for topic, body in self.texts().items():
            self.assertTrue(body.strip(), f"{topic} is empty")

    def test_an_unknown_topic_falls_back_to_how_to_play(self):
        self.assertEqual(impostor_help.help_text("nonsense", 10, 5),
                         impostor_help.help_text(impostor_help.TOPIC_PLAY,
                                                 10, 5))

    def test_player_limits_come_from_the_constants(self):
        body = impostor_help.help_text(impostor_help.TOPIC_PLAY, 10, 5)

        self.assertIn(str(impostor.MIN_PLAYERS), body)
        self.assertIn(str(impostor.MAX_PLAYERS), body)

    def test_board_and_group_sizes_come_from_the_constants(self):
        options = impostor_help.round_options()
        words = impostor_help.managing_words()

        self.assertIn(str(impostor.BOARD_SIZE), options)
        self.assertIn(str(impostor.MIN_GUESS_GROUP), options)
        self.assertIn(str(impostor.MIN_DECOY_GROUP), words)

    def test_timeouts_are_the_ones_passed_in(self):
        body = impostor_help.help_text(impostor_help.TOPIC_PLAY,
                                       lobby_minutes=42, vote_minutes=7)

        self.assertIn("42", body)
        self.assertIn("7", body)

    def test_every_start_option_is_documented(self):
        options = impostor_help.round_options()

        for name in ("players", "delivery", "pack", "impostors", "category",
                     "decoy", "blind", "guessing", "voting", "wordlist"):
            self.assertIn(f"`{name}`", options, f"{name} is undocumented")

    def test_every_command_is_mentioned_somewhere(self):
        joined = "\n".join(self.texts().values())

        for command in ("start", "myword", "status", "reveal", "cancel",
                        "words list", "words add", "words remove",
                        "words deletepack"):
            self.assertIn(f"/impostor {command}", joined,
                          f"{command} is undocumented")

    def test_each_topic_fits_in_one_discord_message(self):
        # _chunk would split it anyway, but a topic that needs splitting is a
        # sign it has grown past being readable.
        for topic, body in self.texts().items():
            self.assertLessEqual(len(body), self.DISCORD_MESSAGE_LIMIT,
                                 f"{topic} is too long")


if __name__ == "__main__":
    unittest.main()
