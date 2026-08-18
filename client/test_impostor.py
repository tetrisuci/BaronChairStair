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


class WordPackFileTests(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "words.json"
        self.packs = impostor.WordPacks(self.path)

    def read_file(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def test_seeds_defaults_when_the_file_is_missing(self):
        # Arrange: nothing on disk.
        # Act
        names = self.packs.packs()
        # Assert
        self.assertEqual(names, tuple(sorted(impostor.DEFAULT_PACKS)))
        self.assertTrue(self.path.exists())

    def test_add_creates_a_pack_and_persists_it(self):
        result = self.packs.add("Terms", [["T-spin", "S-spin"]])

        self.assertEqual(result.pack, "terms")
        self.assertEqual(result.added, ("T-spin", "S-spin"))
        self.assertTrue(result.pack_created)
        self.assertEqual(self.read_file()["terms"], [["T-spin", "S-spin"]])

    def test_add_stores_each_line_as_its_own_group(self):
        self.packs.add("terms", impostor.parse_groups("DAS, ARR\nquad, tetris"))

        self.assertEqual(self.packs.groups("terms"),
                         (("DAS", "ARR"), ("quad", "tetris")))

    def test_add_reports_duplicates_case_insensitively(self):
        self.packs.add("terms", [["quad"]])

        result = self.packs.add("terms", [["QUAD", "tetris"]])

        self.assertEqual(result.added, ("tetris",))
        self.assertEqual(result.duplicates, ("QUAD",))
        self.assertEqual(self.packs.words("terms"), ("quad", "tetris"))

    def test_a_shared_word_merges_into_the_existing_group(self):
        self.packs.add("terms", [["T-spin double", "T-spin triple"]])

        result = self.packs.add("terms", [["T-spin triple", "T-spin single"]])

        # One group, not two: the shared word joined them up.
        self.assertEqual(
            self.packs.groups("terms"),
            (("T-spin double", "T-spin triple", "T-spin single"),))
        self.assertEqual(len(result.merged), 1)

    def test_an_add_can_fuse_two_existing_groups(self):
        self.packs.add("terms", impostor.parse_groups("DAS, ARR\nSDF, ARR2"))

        self.packs.add("terms", [["DAS", "SDF"]])

        self.assertEqual(len(self.packs.groups("terms")), 1)

    def test_add_reports_invalid_words_without_storing_them(self):
        result = self.packs.add("terms", [["ok", "  ", "y" * 200]])

        self.assertEqual(result.added, ("ok",))
        self.assertEqual(len(result.invalid), 2)

    def test_remove_drops_words_and_reports_misses(self):
        self.packs.add("terms", [["DAS", "ARR", "SDF"]])

        result = self.packs.remove("terms", ["arr", "llama"])

        self.assertEqual(result.removed, ("ARR",))
        self.assertEqual(result.missing, ("llama",))
        self.assertEqual(self.packs.words("terms"), ("DAS", "SDF"))

    def test_emptying_a_group_drops_only_that_group(self):
        self.packs.add("terms", impostor.parse_groups("DAS, ARR\nquad, tetris"))

        self.packs.remove("terms", ["DAS", "ARR"])

        self.assertEqual(self.packs.groups("terms"), (("quad", "tetris"),))

    def test_emptying_a_pack_deletes_it(self):
        self.packs.add("terms", [["quad"]])

        result = self.packs.remove("terms", ["quad"])

        self.assertTrue(result.pack_deleted)
        self.assertNotIn("terms", self.packs.packs())
        self.assertNotIn("terms", self.read_file())

    def test_remove_from_unknown_pack_raises(self):
        with self.assertRaises(WordPackError):
            self.packs.remove("ghosts", ["boo"])

    def test_delete_pack_returns_its_size(self):
        self.packs.add("terms", [["quad", "tetris"]])

        self.assertEqual(self.packs.delete_pack("terms"), 2)
        self.assertNotIn("terms", self.packs.packs())

    def test_hand_edits_are_picked_up_without_a_restart(self):
        self.packs.add("terms", [["quad"]])

        # Someone edits the JSON by hand while the bot is running.
        self.path.write_text(json.dumps({"terms": [["quad", "tetris"]]}),
                             encoding="utf-8")

        self.assertEqual(self.packs.words("terms"), ("quad", "tetris"))

    def test_hand_edits_are_not_clobbered_by_a_later_add(self):
        self.packs.add("terms", [["quad"]])
        self.path.write_text(json.dumps({"terms": [["quad"], ["DAS"]]}),
                             encoding="utf-8")

        self.packs.add("terms", [["ARR"]])

        self.assertEqual(self.read_file()["terms"], [["quad"], ["DAS"], ["ARR"]])

    def test_corrupt_json_raises_a_readable_error(self):
        self.path.write_text("{not json", encoding="utf-8")

        with self.assertRaises(WordPackError):
            self.packs.packs()

    def test_wrong_shape_is_rejected_whole(self):
        self.path.write_text(json.dumps({"terms": "quad"}), encoding="utf-8")

        with self.assertRaises(WordPackError):
            self.packs.packs()

    def test_a_bare_string_loads_as_a_group_of_one(self):
        self.path.write_text(json.dumps({"terms": ["finesse", ["DAS", "ARR"]]}),
                             encoding="utf-8")

        self.assertEqual(self.packs.groups("terms"),
                         (("finesse",), ("DAS", "ARR")))

    def test_duplicate_entries_in_a_hand_edit_are_dropped(self):
        self.path.write_text(
            json.dumps({"terms": [["quad", "QUAD", "", "tetris"]]}),
            encoding="utf-8")

        self.assertEqual(self.packs.words("terms"), ("quad", "tetris"))

    def test_pick_from_a_named_pack_stays_in_that_pack(self):
        self.packs.add("terms", [["quad", "tetris"]])
        self.packs.add("players", [["diao", "garbo"]])

        picked = self.packs.pick("terms", rng=random.Random(1))

        self.assertEqual(picked.pack, "terms")
        self.assertIn(picked.word, ("quad", "tetris"))

    def test_the_decoy_is_a_different_word_from_the_same_group(self):
        self.packs.add("terms", impostor.parse_groups(
            "T-spin double, T-spin triple\nDAS, ARR"))
        rng = random.Random(5)

        for _ in range(50):
            picked = self.packs.pick("terms", decoy=True, rng=rng)
            group = next(g for g in self.packs.groups("terms")
                         if picked.word in g)
            self.assertIn(picked.decoy, group)
            self.assertNotEqual(picked.decoy, picked.word)

    def test_solo_groups_are_skipped_when_a_decoy_is_wanted(self):
        self.packs.add("terms", impostor.parse_groups(
            "finesse\nDAS, ARR"))
        rng = random.Random(11)

        drawn = {self.packs.pick("terms", decoy=True, rng=rng).word
                 for _ in range(40)}

        self.assertNotIn("finesse", drawn)
        self.assertEqual(drawn, {"DAS", "ARR"})

    def test_solo_groups_are_fine_without_a_decoy(self):
        self.packs.add("terms", [["finesse"]])

        picked = self.packs.pick("terms", decoy=False, rng=random.Random(1))

        self.assertEqual(picked.word, "finesse")
        self.assertIsNone(picked.decoy)

    def test_a_pack_with_no_pairs_says_so_rather_than_dealing(self):
        self.packs.add("terms", impostor.parse_groups("finesse\nmisdrop"))

        with self.assertRaises(WordPackError) as caught:
            self.packs.pick("terms", decoy=True)

        self.assertIn("similar", str(caught.exception))

    def test_pick_across_packs_is_weighted_by_word_count(self):
        self.path.write_text(
            json.dumps({"big": [[f"w{i}" for i in range(99)]],
                        "tiny": [["only", "one"]]}),
            encoding="utf-8")
        rng = random.Random(7)

        tiny_hits = sum(1 for _ in range(400)
                        if self.packs.pick(rng=rng).pack == "tiny")

        # 2 words in 101: a pack-first pick would land near 200.
        self.assertLess(tiny_hits, 40)

    def test_pick_from_an_unknown_or_empty_pack_raises(self):
        with self.assertRaises(WordPackError):
            self.packs.pick("ghosts")

    def test_pick_with_no_words_at_all_raises(self):
        self.path.write_text("{}", encoding="utf-8")

        with self.assertRaises(WordPackError):
            self.packs.pick()

    def test_pack_stats_count_words_groups_and_usable_groups(self):
        self.packs.add("terms", impostor.parse_groups(
            "DAS, ARR\nfinesse"))

        stats = self.packs.counts()["terms"]

        self.assertEqual((stats.words, stats.groups, stats.decoy_groups),
                         (3, 2, 1))

    def test_a_failed_write_leaves_the_original_file_untouched(self):
        self.packs.add("terms", [["quad"]])
        before = self.path.read_text(encoding="utf-8")
        # A path that cannot be created: the write must fail, not half-happen.
        broken = impostor.WordPacks(self.path / "words.json")

        with self.assertRaises(WordPackError):
            broken.add("terms", [["quad"]])

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

    def make_round(self, candidates=None, blind=False, decoy="T-spin triple"):
        if candidates is None:
            candidates = self.GROUP
        return impostor.Round(pack="tetris terms", word="T-spin double",
                              player_ids=(1, 2, 3), impostor_ids=(2,),
                              show_category=True, decoy=decoy, blind=blind,
                              candidates=tuple(candidates))

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
                                  candidates=("quad", "tetris"))

    def test_the_impostor_dm_mentions_guessing_only_when_offered(self):
        self.assertIn("Guess", impostor.role_message(self.make_round(), 2))
        self.assertNotIn(
            "Guess", impostor.role_message(self.make_round(candidates=()), 2))


class GuessGroupSizeTests(unittest.TestCase):
    """A pair leaks the answer to a decoy-holding impostor; three does not."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.packs = impostor.WordPacks(Path(self.dir.name) / "words.json")

    def test_pairs_are_skipped_when_guessing_needs_a_gamble(self):
        self.packs.add("terms", impostor.parse_groups(
            "quad, tetris\nDAS, ARR, SDF"))
        rng = random.Random(9)

        drawn = {self.packs.pick("terms", min_group=impostor.MIN_GUESS_GROUP,
                                 rng=rng).word for _ in range(40)}

        self.assertEqual(drawn, {"DAS", "ARR", "SDF"})

    def test_a_pack_of_only_pairs_explains_the_refusal(self):
        self.packs.add("terms", [["quad", "tetris"]])

        with self.assertRaises(WordPackError) as caught:
            self.packs.pick("terms", min_group=impostor.MIN_GUESS_GROUP)

        self.assertIn("guessing:false", str(caught.exception))

    def test_the_pick_reports_the_group_it_drew_from(self):
        self.packs.add("terms", [["DAS", "ARR", "SDF"]])

        picked = self.packs.pick("terms", rng=random.Random(1))

        self.assertEqual(set(picked.group), {"DAS", "ARR", "SDF"})
        self.assertIn(picked.word, picked.group)

    def test_every_seeded_group_supports_guessing(self):
        # The default packs must work with the default options.
        packs = impostor.coerce_packs(impostor.DEFAULT_PACKS)

        for name, groups in packs.items():
            stats = impostor.group_stats(groups)
            self.assertEqual(stats.guess_groups, stats.groups,
                             f"{name} has groups too small for guessing")


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


if __name__ == "__main__":
    unittest.main()
