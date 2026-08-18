"""
impostor.py
~~~~~~~~~~~
Word packs and round logic for the Tetris Impostor party game.

Deliberately free of any `discord` import so the rules can be unit-tested on
their own (see test_impostor.py); the command/DM layer lives in
client/impostor_commands.py.

A round can post a *board* of possible words for the whole table to read
(Round.show_words). It is the same frozen list the impostor guesses from, so
the board and the guess menu cannot disagree about what is in play.

Words are stored in *groups* of confusable terms, because the impostor gets a
near-miss word rather than nothing: the crew get "T-spin double" and the
impostor gets "T-spin triple", so they can talk without immediately outing
themselves. A group is one JSON list; a bare string is a group of one (usable
only with decoys turned off).

    {
      "tetris terms": [
        ["T-spin double", "T-spin triple"],
        ["DAS", "ARR", "SDF"],
        "finesse"
      ]
    }

Two ways to maintain the file, and they cannot fight each other:

  * Edit the JSON by hand (best for bulk additions). The file's mtime is
    checked before every read and write, so the bot picks changes up on the
    next command -- no restart, and a hand edit is never clobbered by a
    later /impostor words add.
  * /impostor words add|remove, which rewrites the same file atomically.
    Adding a group that shares a word with an existing group MERGES into it,
    which is how you extend a group without hand-editing.

Deleting the file resets it to DEFAULT_PACKS on next use.
"""

from __future__ import annotations

import dataclasses
import json
import os
import random
import re
import tempfile
from pathlib import Path
from typing import Iterable, Mapping, Sequence

# ── Limits ────────────────────────────────────────────────────────────────────

MIN_PLAYERS = 3
MAX_PLAYERS = 25          # one DM per player; keep a round dealable in seconds

MAX_WORD_LENGTH = 64
MAX_PACK_NAME_LENGTH = 32
PACK_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9 _-]*$")

# A group needs two words before one of them can be the impostor's decoy.
MIN_DECOY_GROUP = 2

# ...and three before an impostor holding a decoy still has to *guess*. With a
# pair, the decoy tells them the crew's word outright -- "my word is the other
# one" -- so an early guess would be a free win. Three keeps it a gamble.
MIN_GUESS_GROUP = 3

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

# Seeded on first run. Grouped so the impostor's decoy is plausible: same
# family of term, same era of player. Every group holds MIN_GUESS_GROUP or
# more, so early guessing works out of the box. Supplement freely -- these are
# a starting point, not a canon.
DEFAULT_PACKS: Mapping[str, Sequence[Sequence[str] | str]] = {
    "tetris terms": [
        ["T-spin single", "T-spin double", "T-spin triple", "T-spin mini"],
        ["all-spin", "S-spin", "Z-spin"],
        ["SRS", "SRS+", "ARS"],
        ["wall kick", "floor kick", "180 kick"],
        ["DAS", "ARR", "SDF"],
        ["IRS", "IHS", "ARE"],
        ["hard drop", "soft drop", "sonic drop"],
        ["hold", "next queue", "preview"],
        ["quad", "tetris", "triple", "double"],
        ["perfect clear", "all clear", "back-to-back"],
        ["combo", "spike", "counterattack"],
        ["downstack", "upstack", "dig"],
        ["cheese garbage", "clean garbage", "messy garbage"],
        ["APM", "PPS", "VS"],
        ["finesse", "misdrop", "finesse fault"],
        ["7-bag", "14-bag", "bag randomizer"],
        ["lock delay", "gravity", "20G"],
        ["overhang", "well", "T-slot"],
        ["I-piece", "T-piece", "S-piece", "Z-piece", "L-piece", "J-piece",
         "O-piece"],
        ["40 lines", "blitz", "zen"],
    ],
    "openers": [
        ["PCO", "TKI", "MKO"],
        ["DT cannon", "Albatross", "Jaws"],
        ["LST stacking", "C-spin", "hachi-spin", "san-chan"],
    ],
    # One group on purpose: every name here is a well-known player, so any of
    # them is a plausible decoy for any other. Split into sub-groups (by era,
    # by playstyle, by region) if you want the near-miss to bite harder.
    "players": [
        ["Icly", "Firestorm", "Blaarg", "VinceHD", "Promooooooo",
         "Czsmall0402", "Wumbo", "Bennxt", "Gohan", "Doremy"],
    ],
}


class WordPackError(Exception):
    """The word file is unreadable, or an edit to it was rejected."""


class RoundError(Exception):
    """A round cannot be dealt with the given players/settings."""


# ── Parsing and validation ────────────────────────────────────────────────────

def parse_groups(text: str) -> tuple[tuple[str, ...], ...]:
    """Split user input into groups of similar words.

    A newline starts a new group; commas and semicolons separate words inside
    one. So a single pasted block adds several groups at once:

        T-spin double, T-spin triple
        DAS, ARR, SDF
    """
    groups = []
    for line in text.splitlines():
        words = tuple(w for w in (" ".join(p.split())
                                  for p in re.split(r"[,;]+", line)) if w)
        if words:
            groups.append(words)
    return tuple(groups)


def parse_words(text: str) -> tuple[str, ...]:
    """Every word in `text`, flattened -- used by /impostor words remove."""
    return tuple(word for group in parse_groups(text) for word in group)


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


def normalize_word(word: str) -> str | None:
    """Return the storable form of `word`, or None if it is not usable."""
    cleaned = " ".join(str(word).split())
    if not cleaned or len(cleaned) > MAX_WORD_LENGTH:
        return None
    # Control characters would break the DM formatting. Markdown characters are
    # left alone: the DM bolds the word rather than putting it in a code span.
    if any(ord(c) < 32 for c in cleaned):
        return None
    return cleaned


def normalize_pack_name(name: str) -> str:
    """Return the canonical pack name, or raise WordPackError."""
    cleaned = " ".join(str(name).split()).lower()
    if not cleaned or len(cleaned) > MAX_PACK_NAME_LENGTH:
        raise WordPackError(
            f"Pack names must be 1-{MAX_PACK_NAME_LENGTH} characters.")
    if not PACK_NAME_RE.match(cleaned):
        raise WordPackError(
            "Pack names may only use letters, digits, spaces, `-` and `_`.")
    return cleaned


# ── Edit results ──────────────────────────────────────────────────────────────

@dataclasses.dataclass(frozen=True)
class AddResult:
    pack: str
    added: tuple[str, ...]
    duplicates: tuple[str, ...]
    invalid: tuple[str, ...]
    pack_created: bool
    merged: tuple[tuple[str, ...], ...] = ()   # groups an add joined onto


@dataclasses.dataclass(frozen=True)
class RemoveResult:
    pack: str
    removed: tuple[str, ...]
    missing: tuple[str, ...]
    pack_deleted: bool


@dataclasses.dataclass(frozen=True)
class PickedWord:
    pack: str
    word: str
    decoy: str | None = None      # the impostor's near-miss, if one was asked
    group: tuple[str, ...] = ()   # the confusable set `word` was drawn from


# ── Storage ───────────────────────────────────────────────────────────────────

class WordPacks:
    """The word file, reloaded whenever it changes underneath us.

    Every public method starts by re-reading the file if its mtime moved, so
    hand edits and slash-command edits stay consistent without a restart.
    Internally the pack map is only ever replaced, never mutated in place.
    """

    def __init__(self, path: str | os.PathLike[str]):
        self._path = Path(path)
        self._packs: dict[str, tuple[tuple[str, ...], ...]] = {}
        self._stamp: tuple[int, int] | None = None   # (mtime_ns, size)

    @property
    def path(self) -> Path:
        return self._path

    # -- reading ---------------------------------------------------------------

    def packs(self) -> tuple[str, ...]:
        self._sync()
        return tuple(sorted(self._packs))

    def groups(self, pack: str) -> tuple[tuple[str, ...], ...]:
        self._sync()
        name = normalize_pack_name(pack)
        if name not in self._packs:
            raise WordPackError(f"No pack named `{name}`.")
        return self._packs[name]

    def words(self, pack: str) -> tuple[str, ...]:
        """Every word in `pack`, groups flattened."""
        return tuple(w for group in self.groups(pack) for w in group)

    def counts(self) -> dict[str, PackStats]:
        self._sync()
        return {name: group_stats(groups)
                for name, groups in sorted(self._packs.items())}

    def total(self) -> int:
        self._sync()
        return sum(len(g) for groups in self._packs.values() for g in groups)

    def pick(self, pack: str | None = None, decoy: bool = True,
             min_group: int = 1,
             rng: random.Random | None = None) -> PickedWord:
        """Pick the crew's word, plus the impostor's near-miss when `decoy`.

        Every eligible *word* is equally likely, so a 5-word pack does not come
        up as often as a 500-word one, and a big group is not under-drawn.
        With `decoy`, only groups holding two or more words are eligible -- the
        decoy is drawn from the rest of the winning word's group. `min_group`
        raises that floor further; see MIN_GUESS_GROUP for why guessing needs
        it.
        """
        self._sync()
        chooser = rng or random

        if pack is not None:
            name = normalize_pack_name(pack)
            if name not in self._packs:
                raise WordPackError(f"No pack named `{name}`.")
            candidates = {name: self._packs[name]}
        else:
            candidates = self._packs

        floor = max(min_group, MIN_DECOY_GROUP if decoy else 1)
        pool = [(name, group, word)
                for name, groups in sorted(candidates.items())
                for group in groups
                for word in group
                if len(group) >= floor]
        if not pool:
            raise WordPackError(self._empty_pool_reason(candidates, pack, floor))

        name, group, word = chooser.choice(pool)
        near_miss = None
        if decoy:
            near_miss = chooser.choice([w for w in group if w != word])
        return PickedWord(pack=name, word=word, decoy=near_miss,
                          group=tuple(group))

    @staticmethod
    def _empty_pool_reason(candidates: Mapping[str, tuple[tuple[str, ...], ...]],
                           pack: str | None, floor: int) -> str:
        """Say which of the ways a pick can come up empty actually happened."""
        has_words = any(group for groups in candidates.values() for group in groups)
        where = f"Pack `{pack}`" if pack else "There"
        if not has_words:
            return (f"{where} has no words yet — add some with "
                    "`/impostor words add`.")
        if floor >= MIN_GUESS_GROUP:
            return (f"{where} has no group of {MIN_GUESS_GROUP}+ similar "
                    "words, which an early guess needs — with only two, the "
                    "impostor's word tells them the answer outright. Add a "
                    "third to a group with `/impostor words add`, or start "
                    "with `guessing:false`.")
        return (f"{where} has no groups of similar words, so there is nothing "
                "for the impostor to be given. Add one with "
                "`/impostor words add` (comma-separated words go in the same "
                "group), or start the round with `decoy:false`.")

    # -- writing ---------------------------------------------------------------

    def add(self, pack: str, groups: Iterable[Sequence[str]]) -> AddResult:
        """Add groups of similar words to `pack`, creating the pack if new.

        An incoming group that shares a word with an existing group is merged
        into it rather than stored twice -- that is how you extend a group
        without hand-editing the file, and it makes a "duplicate" useful
        instead of merely rejected.
        """
        self._sync()
        name = normalize_pack_name(pack)
        existing = list(self._packs.get(name, ()))
        known = {w.casefold(): i
                 for i, group in enumerate(existing) for w in group}

        added: list[str] = []
        duplicates: list[str] = []
        invalid: list[str] = []
        merged: list[tuple[str, ...]] = []

        for raw_group in groups:
            fresh: list[str] = []
            targets: list[int] = []       # existing groups this one touches
            for raw in raw_group:
                word = normalize_word(raw)
                if word is None:
                    invalid.append(str(raw)[:MAX_WORD_LENGTH])
                    continue
                index = known.get(word.casefold())
                if index is not None:
                    duplicates.append(word)
                    if index not in targets:
                        targets.append(index)
                    continue
                if any(word.casefold() == f.casefold() for f in fresh):
                    duplicates.append(word)
                    continue
                fresh.append(word)

            # `fresh` empty but several groups named: the host is telling us
            # those existing words belong together, so fuse them anyway.
            if not fresh and len(targets) < 2:
                continue                  # nothing new and nothing to join

            if targets:
                # Fold every touched group plus the new words into the
                # earliest of them. Sorted, so deleting the rest from the back
                # cannot shift the index we are keeping.
                order = sorted(targets)
                keep = order[0]
                combined = tuple(w for i in order for w in existing[i])
                existing[keep] = (*combined, *fresh)
                for i in reversed(order[1:]):
                    del existing[i]
                merged.append(existing[keep])
            else:
                existing.append(tuple(fresh))
            added.extend(fresh)
            # Indices shifted if groups collapsed, so rebuild the lookup.
            known = {w.casefold(): i
                     for i, group in enumerate(existing) for w in group}

        was_new = name not in self._packs
        # `merged` alone still changes the file: fusing two groups adds no
        # words but is very much an edit.
        if added or merged:
            self._commit({**self._packs, name: tuple(existing)})
        return AddResult(pack=name, added=tuple(added),
                         duplicates=tuple(duplicates), invalid=tuple(invalid),
                         pack_created=bool(added) and was_new,
                         merged=tuple(merged))

    def remove(self, pack: str, words: Iterable[str]) -> RemoveResult:
        """Remove words from `pack`. Emptied groups, and an emptied pack, go."""
        self._sync()
        name = normalize_pack_name(pack)
        if name not in self._packs:
            raise WordPackError(f"No pack named `{name}`.")

        wanted: dict[str, str] = {}
        for raw in words:
            word = normalize_word(raw)
            if word is not None:
                wanted[word.casefold()] = word

        kept: list[tuple[str, ...]] = []
        removed: list[str] = []
        for group in self._packs[name]:
            survivors = tuple(w for w in group if w.casefold() not in wanted)
            removed.extend(w for w in group if w.casefold() in wanted)
            if survivors:
                kept.append(survivors)

        present = {w.casefold() for w in removed}
        missing = tuple(w for key, w in wanted.items() if key not in present)

        pack_deleted = bool(removed) and not kept
        if removed:
            updated = {k: v for k, v in self._packs.items() if k != name}
            if kept:
                updated[name] = tuple(kept)
            self._commit(updated)
        return RemoveResult(pack=name, removed=tuple(removed), missing=missing,
                            pack_deleted=pack_deleted)

    def delete_pack(self, pack: str) -> int:
        """Drop a whole pack. Returns how many words went with it."""
        self._sync()
        name = normalize_pack_name(pack)
        if name not in self._packs:
            raise WordPackError(f"No pack named `{name}`.")
        size = sum(len(g) for g in self._packs[name])
        self._commit({k: v for k, v in self._packs.items() if k != name})
        return size

    # -- file plumbing ---------------------------------------------------------

    def _sync(self) -> None:
        """Load the file if we have never read it, or if it changed on disk."""
        try:
            stat = self._path.stat()
        except FileNotFoundError:
            # First run, or someone deleted the file: seed the defaults so the
            # game is playable out of the box and the file exists to be edited.
            self._commit(coerce_packs(DEFAULT_PACKS, source="defaults"))
            return
        except OSError as e:
            raise WordPackError(f"Cannot read {self._path}: {e}") from e

        stamp = (stat.st_mtime_ns, stat.st_size)
        if stamp == self._stamp:
            return
        self._packs = self._read()
        self._stamp = stamp

    def _read(self) -> dict[str, tuple[tuple[str, ...], ...]]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError) as e:
            raise WordPackError(f"Cannot read {self._path}: {e}") from e
        except json.JSONDecodeError as e:
            raise WordPackError(
                f"{self._path.name} is not valid JSON (line {e.lineno}): "
                f"{e.msg}") from e
        return coerce_packs(raw, source=self._path.name)

    def _commit(self,
                packs: Mapping[str, tuple[tuple[str, ...], ...]]) -> None:
        """Write `packs` to disk atomically, then adopt it in memory.

        Written first: if the write fails the in-memory view still matches the
        file, so a failed edit is a no-op rather than a lie.
        """
        payload = dump_packs(packs)
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            # Same directory as the target, so os.replace stays atomic.
            fd, tmp = tempfile.mkstemp(dir=self._path.parent,
                                       prefix=f".{self._path.name}.",
                                       suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    fh.write(payload)
                os.replace(tmp, self._path)
            except BaseException:
                Path(tmp).unlink(missing_ok=True)
                raise
        except OSError as e:
            raise WordPackError(f"Cannot write {self._path}: {e}") from e

        self._packs = dict(packs)
        stat = self._path.stat()
        self._stamp = (stat.st_mtime_ns, stat.st_size)


def dump_packs(packs: Mapping[str, tuple[tuple[str, ...], ...]]) -> str:
    """Serialise the word file with one group per line.

    json.dumps(indent=2) puts every single word on its own line, which turns a
    300-word pack into 300 lines and makes the file miserable to hand-edit --
    and hand-editing is half the point of the format.
    """
    blocks = []
    for name, groups in sorted(packs.items()):
        lines = ",\n".join(f"    {json.dumps(list(g), ensure_ascii=False)}"
                            for g in groups)
        blocks.append(f"  {json.dumps(name, ensure_ascii=False)}: [\n"
                      f"{lines}\n  ]")
    return "{\n" + ",\n".join(blocks) + "\n}\n"


@dataclasses.dataclass(frozen=True)
class PackStats:
    words: int
    groups: int
    decoy_groups: int          # groups big enough to hide an impostor in
    guess_groups: int          # ...and big enough that guessing stays a gamble


def group_stats(groups: Sequence[Sequence[str]]) -> PackStats:
    return PackStats(
        words=sum(len(g) for g in groups),
        groups=len(groups),
        decoy_groups=sum(1 for g in groups if len(g) >= MIN_DECOY_GROUP),
        guess_groups=sum(1 for g in groups if len(g) >= MIN_GUESS_GROUP))


def coerce_packs(raw: object, source: str = "word file"
                 ) -> dict[str, tuple[tuple[str, ...], ...]]:
    """Validate a decoded word file into {pack: ((word, ...), ...)}.

    A pack is a list whose entries are either a group (list of similar words)
    or a bare string (a group of one). A wrong *shape* rejects the whole file
    -- a silently half-loaded pack is worse than a clear failure. Individual
    blank/oversized/duplicate words are dropped instead, so a stray trailing
    comma in a hand-written list does not take the game down.
    """
    if not isinstance(raw, dict):
        raise WordPackError(
            f'{source} must be a JSON object of "pack": [...] entries.')

    packs: dict[str, tuple[tuple[str, ...], ...]] = {}
    for name, entries in raw.items():
        pack = normalize_pack_name(name)
        if not isinstance(entries, (list, tuple)):
            raise WordPackError(f'{source}: pack "{name}" must be a list.')

        seen: set[str] = set()             # words are unique across the pack
        groups: list[tuple[str, ...]] = []
        for entry in entries:
            if isinstance(entry, str):
                entry = [entry]            # bare string: a group of one
            elif not isinstance(entry, (list, tuple)):
                raise WordPackError(
                    f'{source}: pack "{name}" must hold words or lists of '
                    f"similar words, not {type(entry).__name__}.")
            cleaned: list[str] = []
            for item in entry:
                if not isinstance(item, str):
                    raise WordPackError(
                        f'{source}: pack "{name}" contains a non-string entry.')
                word = normalize_word(item)
                if word is None or word.casefold() in seen:
                    continue
                seen.add(word.casefold())
                cleaned.append(word)
            if cleaned:
                groups.append(tuple(cleaned))
        if groups:
            packs[pack] = tuple(groups)
    return packs


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
