"""
impostor.py
~~~~~~~~~~~
Round rules for the Tetris Impostor party game: dealing roles, the word board,
early guessing, and voting.

Word-pack storage lives in impostor_words.py, and is re-exported here so
callers have one import for the game. Neither module imports discord, so all
of this is testable without an event loop; the Discord layer is
impostor_game.py / impostor_views.py / impostor_commands.py.

Everyone is dealt the same word except the impostor, who gets a *similar* one
from the same group ("T-spin double" vs "T-spin triple") so they can bluff.
The crew win by voting them out; the impostor wins by surviving the vote or by
guessing the crew's word off the board.
"""

from __future__ import annotations

import dataclasses
import random
import re
from typing import Sequence

# Re-exported so callers say `impostor.WordPacks` / `impostor.MIN_GUESS_GROUP`
# rather than importing two modules to run one game.
from impostor_words import (  # noqa: F401  (re-export)
    DEFAULT_PACKS, MAX_IMPORT_BYTES, MAX_IMPORT_WORDS, MAX_PACK_NAME_LENGTH,
    MAX_PERSONAL_PACKS, MAX_WORD_LENGTH, MIN_DECOY_GROUP, MIN_GUESS_GROUP,
    AddResult, PackRef, PackStats, PickedWord, RemoveResult, WordPackError,
    SHARED_MARKER, WordPacks, coerce_packs, dump_packs, group_stats,
    normalize_pack_name, normalize_word, parse_groups, parse_import,
    parse_pack_key, parse_pack_selection, parse_words,
)

# ── Limits ────────────────────────────────────────────────────────────────────

MIN_PLAYERS = 3
MAX_PLAYERS = 25          # one DM per player; keep a round dealable in seconds

# Discord caps a select menu at 25 options.
MAX_GUESS_OPTIONS = 25

# How many words go on the public board. Also the size of the impostor's guess
# menu -- they are deliberately the SAME list, so the board cannot offer a word
# the guess menu lacks or the other way round. 16 reads at a glance in chat;
# 25 is a wall of text.
BOARD_SIZE = 16

# Impostor counts that keep the game playable: always at least two players who
# share the word, so the impostors can never outnumber or tie the crew.
_TWO_IMPOSTOR_MIN_PLAYERS = 7
_THREE_IMPOSTOR_MIN_PLAYERS = 12


class RoundError(Exception):
    """A round cannot be dealt with the given players/settings."""


# Discord renders a picked user as "<@123>"; a pasted one is a bare snowflake.
# Snowflakes are 17-20 digits -- shorter runs are someone typing a number.
#
# The role and channel branches come first and capture nothing: alternation is
# tried left to right, so they swallow "<@&123>" and "<#123>" before the bare
# -snowflake branch can mistake the digits inside for a player. A role mention
# read as a user ID would silently put a nonexistent member on the roster.
_MENTION_RE = re.compile(
    r"<@&\d{17,20}>"                      # role mention: consume, ignore
    r"|<#\d{17,20}>"                      # channel mention: consume, ignore
    r"|<@!?(\d{17,20})>"                  # user mention: capture
    r"|(?<![\d<@#&!])(\d{17,20})(?!\d)"   # bare snowflake: capture
)


def parse_user_ids(text: str) -> tuple[int, ...]:
    """Pull user IDs out of a mention string, in the order they were written.

    Lives here rather than in the Discord layer because it is pure string
    work, and the whole point of this module is that such things are testable
    without an event loop. Duplicates collapse: naming someone twice is a
    typo, not a request for two roles.
    """
    seen: set[int] = set()
    ids: list[int] = []
    for mention, bare in _MENTION_RE.findall(text):
        if not (mention or bare):
            continue                       # a role or channel mention
        user_id = int(mention or bare)
        if user_id not in seen:
            seen.add(user_id)
            ids.append(user_id)
    return tuple(ids)


# ── Round logic ───────────────────────────────────────────────────────────────

@dataclasses.dataclass(frozen=True)
class Round:
    """One dealt round. Immutable: a re-deal produces a new Round."""

    pack: str
    word: str
    player_ids: tuple[int, ...]
    impostor_ids: tuple[int, ...]
    show_category: bool
    decoy: str | None = None     # the impostor's near-miss word, if any
    blind: bool = False          # impostors are not told that they are it
    candidates: tuple[str, ...] = ()   # the word board, frozen at deal time
    show_words: bool = False     # ...and shown to the table
    allow_guess: bool = False    # ...and open to an early guess

    @property
    def guessing_allowed(self) -> bool:
        # Both halves matter: the board and the guess menu are the same list,
        # so a round can hold candidates purely to display them. Without the
        # explicit flag, turning the board on would switch guessing back on.
        return self.allow_guess and bool(self.candidates)

    def is_impostor(self, user_id: int) -> bool:
        return user_id in self.impostor_ids

    @property
    def crew_ids(self) -> tuple[int, ...]:
        return tuple(p for p in self.player_ids if p not in self.impostor_ids)


def build_candidates(answer: str, group: Sequence[str],
                     pool: Sequence[str] = (),
                     limit: int = MAX_GUESS_OPTIONS,
                     rng: random.Random | None = None) -> tuple[str, ...]:
    """The menu the impostor guesses from: `answer` plus plausible company.

    The confusable group comes first because that is the set an impostor
    holding a decoy has already reasoned their way to; the rest of the pack
    pads it out so the group is not conspicuous by being the whole menu.

    Built ONCE per round and frozen on the Round. Re-sampling per click would
    let an impostor open the menu repeatedly and intersect the option lists --
    the answer is the one word that appears every time.
    """
    chooser = rng or random

    # Deduped case-insensitively: Discord rejects a select with repeated
    # options, and a word can legitimately appear in both group and pool.
    seen = {answer.casefold()}

    def take(words: Sequence[str]) -> list[str]:
        out = []
        for word in words:
            if word.casefold() not in seen:
                seen.add(word.casefold())
                out.append(word)
        return out

    chosen = take(group)[:limit - 1]
    extras = take(pool)
    chooser.shuffle(extras)
    chosen.extend(extras[:max(0, limit - 1 - len(chosen))])

    menu = [answer, *chosen]
    chooser.shuffle(menu)
    return tuple(menu)


def resolve_guess(rnd: Round, guess: str) -> bool:
    """True if the impostor guessed the crew's word.

    Rejects anything that was not on the menu: the only guesses that can reach
    here come from the select, so an off-menu value is a malformed interaction
    rather than a player being clever.
    """
    if not rnd.guessing_allowed:
        raise RoundError("Early guessing is off for this round.")
    cleaned = " ".join(str(guess).split())
    if not any(cleaned.casefold() == c.casefold() for c in rnd.candidates):
        raise RoundError("That word was not on the list.")
    return cleaned.casefold() == rnd.word.casefold()


def default_impostor_count(player_count: int) -> int:
    """How many impostors a table this size gets when the host says nothing."""
    if player_count >= _THREE_IMPOSTOR_MIN_PLAYERS:
        return 3
    if player_count >= _TWO_IMPOSTOR_MIN_PLAYERS:
        return 2
    return 1


def max_impostor_count(player_count: int) -> int:
    """Cap that always leaves at least two players sharing the word."""
    return max(1, (player_count - 1) // 2)


def assign_roles(player_ids: Sequence[int], pack: str, word: str,
                 impostors: int | None = None,
                 show_category: bool = True,
                 decoy: str | None = None,
                 blind: bool = False,
                 candidates: Sequence[str] = (),
                 show_words: bool = False,
                 allow_guess: bool = False,
                 rng: random.Random | None = None) -> Round:
    """Deal a round, raising RoundError if the table cannot support it."""
    players = tuple(player_ids)
    if len(set(players)) != len(players):
        raise RoundError("The same player was added twice.")
    if len(players) < MIN_PLAYERS:
        raise RoundError(
            f"Need at least {MIN_PLAYERS} players — there "
            f"{'is' if len(players) == 1 else 'are'} {len(players)}.")
    if len(players) > MAX_PLAYERS:
        raise RoundError(f"At most {MAX_PLAYERS} players per round.")
    if blind and decoy is None:
        # Otherwise the impostor is told nothing at all and cannot play.
        raise RoundError(
            "A blind round needs a decoy word for the impostor to hold.")
    if decoy is not None and decoy.casefold() == word.casefold():
        raise RoundError("The decoy word must differ from the crew's word.")
    if candidates and not any(word.casefold() == c.casefold()
                              for c in candidates):
        # An unwinnable guess menu is worse than no menu at all.
        raise RoundError("The guess list must contain the crew's word.")
    if allow_guess and blind:
        # The guess button would out the impostor to themselves. A board with
        # no guessing is fine in a blind round: it is just public reading.
        raise RoundError("A blind round cannot offer early guessing.")
    if allow_guess and not candidates:
        raise RoundError("Early guessing needs a list to guess from.")
    if show_words and not candidates:
        raise RoundError("There is no word board to show.")

    count = (default_impostor_count(len(players)) if impostors is None
             else int(impostors))
    ceiling = max_impostor_count(len(players))
    if count < 1:
        raise RoundError("A round needs at least one impostor.")
    if count > ceiling:
        raise RoundError(
            f"{len(players)} players can have at most {ceiling} "
            f"impostor{'s' if ceiling != 1 else ''}.")

    chooser = rng or random
    chosen = set(chooser.sample(list(players), count))
    return Round(pack=pack, word=word, player_ids=players,
                 # Keep join order so the reveal reads consistently.
                 impostor_ids=tuple(p for p in players if p in chosen),
                 show_category=show_category, decoy=decoy, blind=blind,
                 candidates=tuple(candidates), show_words=show_words,
                 allow_guess=allow_guess)


# ── Voting ────────────────────────────────────────────────────────────────────

@dataclasses.dataclass(frozen=True)
class Ballot:
    voter_id: int
    target_id: int


@dataclasses.dataclass(frozen=True)
class VoteOutcome:
    """How a closed vote ended.

    `crew_won` is None for an inconclusive vote -- a tie, or nobody voting at
    all. Those eject no one and leave the round running, rather than handing
    the win to a side that did not earn it.
    """

    ejected: int | None
    tied: tuple[int, ...]
    crew_won: bool | None

    @property
    def is_conclusive(self) -> bool:
        return self.crew_won is not None


@dataclasses.dataclass(frozen=True)
class Vote:
    """One round of balloting. Immutable: casting returns a new Vote."""

    ballots: tuple[Ballot, ...] = ()

    @property
    def voter_ids(self) -> tuple[int, ...]:
        return tuple(b.voter_id for b in self.ballots)

    def has_voted(self, user_id: int) -> bool:
        return any(b.voter_id == user_id for b in self.ballots)

    def cast(self, rnd: Round, voter_id: int, target_id: int) -> "Vote":
        """Record a ballot, replacing this voter's previous one if any."""
        if voter_id not in rnd.player_ids:
            raise RoundError("You are not in this round.")
        if target_id not in rnd.player_ids:
            raise RoundError("That player is not in this round.")
        if target_id == voter_id:
            raise RoundError("You cannot vote for yourself.")
        kept = tuple(b for b in self.ballots if b.voter_id != voter_id)
        return Vote(ballots=(*kept, Ballot(voter_id, target_id)))

    def counts(self) -> dict[int, int]:
        tally: dict[int, int] = {}
        for ballot in self.ballots:
            tally[ballot.target_id] = tally.get(ballot.target_id, 0) + 1
        return tally

    def is_complete(self, rnd: Round) -> bool:
        """True once every player in the round has a ballot in."""
        return set(self.voter_ids) >= set(rnd.player_ids)

    def outcome(self, rnd: Round) -> VoteOutcome:
        """Tally by plurality; a tie ejects nobody.

        Ejecting any impostor wins it for the crew -- with more than one
        impostor that is generous, but it matches "vote out the impostor and
        you win" rather than quietly moving the goalposts.
        """
        tally = self.counts()
        if not tally:
            return VoteOutcome(ejected=None, tied=(), crew_won=None)
        top = max(tally.values())
        leaders = tuple(sorted(uid for uid, n in tally.items() if n == top))
        if len(leaders) > 1:
            return VoteOutcome(ejected=None, tied=leaders, crew_won=None)
        ejected = leaders[0]
        return VoteOutcome(ejected=ejected, tied=(),
                           crew_won=rnd.is_impostor(ejected))


def word_board(rnd: Round) -> str:
    """The public list of possible words, or "" when the board is off.

    Sorted rather than left in the dealt order: the order was random, so
    sorting leaks nothing and a scannable list is the whole point.
    """
    if not rnd.show_words or not rnd.candidates:
        return ""
    return " · ".join(f"`{w}`" for w in sorted(rnd.candidates,
                                               key=str.casefold))


def may_call_vote(rnd: Round, user_id: int) -> bool:
    """Who may *open* a vote: the crew, so an impostor cannot force one early.

    A blind round is the exception -- there the impostor does not know they
    are the impostor, so refusing them would tell them. Everybody in the round
    may call one, which costs nothing: they were going to play along anyway.
    """
    if user_id not in rnd.player_ids:
        return False
    return rnd.blind or not rnd.is_impostor(user_id)


def vote_candidates(rnd: Round, voter_id: int) -> tuple[int, ...]:
    """Who `voter_id` may vote for: everyone else still in the round."""
    return tuple(p for p in rnd.player_ids if p != voter_id)


def role_message(rnd: Round, user_id: int) -> str:
    """The DM one player gets. Raises RoundError if they are not in the round."""
    if user_id not in rnd.player_ids:
        raise RoundError("That player is not in this round.")

    total = len(rnd.player_ids)
    impostors = len(rnd.impostor_ids)
    category = f"Category: **{rnd.pack}**\n" if rnd.show_category else ""
    table = (f"{total} players · {impostors} "
             f"impostor{'s' if impostors != 1 else ''}")

    if not rnd.is_impostor(user_id):
        hint = ("Describe it without saying it — someone here has a slightly "
                "different word." if rnd.decoy else
                "Describe it without saying it — one of you does not have it.")
        return (f"🧩 Your word is: **{rnd.word}**\n{category}{hint}\n_{table}_")

    if rnd.blind:
        # Same shape as the crew's DM on purpose: the impostor must not be able
        # to tell which side they are on from the formatting alone.
        return (f"🧩 Your word is: **{rnd.decoy}**\n{category}"
                "Describe it without saying it — someone here has a slightly "
                f"different word.\n_{table}_")

    guess = ("\nThink you know theirs? **Guess the word** on the round "
             "message — right and you win it outright, wrong and the crew "
             "take it.\n" if rnd.guessing_allowed else "")
    if rnd.decoy:
        return ("🕵️ **You are the IMPOSTOR.**\n"
                f"Everyone else has a different word. Yours is: **{rnd.decoy}**\n"
                f"{category}"
                "Close, but not theirs — use it to blend in."
                f"{guess}\n"
                f"_{table}_")
    return ("🕵️ **You are the IMPOSTOR.**\n"
            f"{category}"
            "You do not get a word. Listen, bluff, and blend in."
            f"{guess}\n"
            f"_{table}_")
