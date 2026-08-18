"""
impostor_words.py
~~~~~~~~~~~~~~~~~
Word-pack storage for the Impostor game: the file, its format, and the edits.

Split out of impostor.py, which now holds only the round rules. No discord
import, so all of this is testable on its own.

A pack is identified by a PackRef -- an (owner, name) pair, not a bare name:

  * a SHARED pack has no owner. Anyone can play it; editing needs Manage
    Server, because every guild the bot is in reads the same file.
  * a PERSONAL pack belongs to one Discord user. Only they can edit it and
    only they can start a round with it.

Two users can both own a pack called "memes", so the storage key carries the
owner: "memes@123456789012345678". "@" is not a legal pack-name character (see
PACK_NAME_RE), so a personal key can never collide with a shared one -- and a
file written before personal packs existed loads unchanged, every pack shared.

Words inside a pack live in *groups* of confusable terms, because the impostor
gets a near-miss word rather than nothing: the crew get "T-spin double" and
the impostor gets "T-spin triple". A group is one JSON list; a bare string is
a group of one (usable only with decoys turned off).

    {
      "tetris terms": [
        ["T-spin double", "T-spin triple"],
        ["DAS", "ARR", "SDF"],
        "finesse"
      ],
      "my memes@123456789012345678": [
        ["stack overflow", "buffer overflow"]
      ]
    }

Two ways to maintain it, and they cannot fight each other:

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

MAX_WORD_LENGTH = 64
MAX_PACK_NAME_LENGTH = 32
PACK_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9 _-]*$")

# Separates a personal pack's name from its owner in the storage key. Chosen
# because PACK_NAME_RE cannot match it, so it is unambiguous.
OWNER_SEPARATOR = "@"

# Marks a pack the user picked from autocomplete rather than typed. A bare
# name is ambiguous -- "memes" could mean yours or the server's -- so the
# picker prefixes shared packs with this, and a typed name keeps the old
# "yours wins" behaviour. Also illegal in a pack name, so it cannot collide.
SHARED_MARKER = "#"

# Per-user cap. One person should not be able to fill the shared file.
MAX_PERSONAL_PACKS = 10

# Bulk import limits. The byte cap is the real guard -- a Discord attachment
# can be tens of megabytes and it is read into memory -- and the word cap
# keeps one import from bloating every later pick().
MAX_IMPORT_BYTES = 256 * 1024
MAX_IMPORT_WORDS = 5000

# A group needs two words before one of them can be the impostor's decoy.
MIN_DECOY_GROUP = 2

# ...and three before an impostor holding a decoy still has to *guess*. With a
# pair, the decoy tells them the crew's word outright -- "my word is the other
# one" -- so an early guess would be a free win. Three keeps it a gamble.
MIN_GUESS_GROUP = 3


class WordPackError(Exception):
    """The word file is unreadable, or an edit to it was rejected."""


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
    # The UCI club. One group again -- and a big one, which is the setting
    # that makes an early guess hardest: 1-in-14 rather than 1-in-2.
    "tetrisatuci": [
        ["Bennxt", "Satilea", "Snorlax", "Yauna", "Inkl1ng", "Awesumsauce",
         "Stqr", "Betanine", "Weeg", "Waifer", "Potatoling2", "Teesa",
         "Flowaa", "BulletShimeji", "Sieradni"],
    ],
}


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




def parse_import(data: bytes, filename: str) -> tuple[tuple[str, ...], ...]:
    """Read an uploaded word file into groups, ready for WordPacks.add.

    Two formats, chosen by extension so the behaviour is predictable rather
    than guessed from content:

      *.json  a list of groups, exactly like one pack's value in the word
              file: [["T-spin double", "T-spin triple"], "finesse"]
      *.txt   the same grammar as the `words` option -- one group per line,
              commas separating the words inside a group.

    Raises WordPackError with something the uploader can act on. Validating
    the words themselves is left to add(), which already reports duplicates,
    over-long entries and merges.
    """
    if len(data) > MAX_IMPORT_BYTES:
        raise WordPackError(
            f"That file is {len(data) // 1024} KB — the limit is "
            f"{MAX_IMPORT_BYTES // 1024} KB.")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise WordPackError(
            "That file is not UTF-8 text. Save it as UTF-8 and try again."
        ) from None

    if filename.lower().endswith(".json"):
        groups = _import_json(text)
    else:
        groups = parse_groups(text)

    if not groups:
        raise WordPackError("There were no words in that file.")
    total = sum(len(g) for g in groups)
    if total > MAX_IMPORT_WORDS:
        raise WordPackError(
            f"That file holds {total:,} words — the limit is "
            f"{MAX_IMPORT_WORDS:,} per import. Split it up.")
    return groups


def _import_json(text: str) -> tuple[tuple[str, ...], ...]:
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as e:
        raise WordPackError(
            f"That .json file is not valid JSON (line {e.lineno}): "
            f"{e.msg}") from None

    if isinstance(raw, dict):
        # A whole word file, rather than one pack's worth. Say so plainly --
        # importing several packs at once would need a scope and an owner for
        # each, which the command cannot infer.
        raise WordPackError(
            "That looks like a whole word file. Import one pack at a time: "
            'the file should be a list like [["a", "b"], ["c", "d"]].')
    if not isinstance(raw, list):
        raise WordPackError(
            'A .json import must be a list of groups, e.g. [["a", "b"]].')

    groups: list[tuple[str, ...]] = []
    for entry in raw:
        if isinstance(entry, str):
            entry = [entry]                    # bare string: a group of one
        elif not isinstance(entry, list):
            raise WordPackError(
                "Every entry must be a word or a list of similar words, not "
                f"{type(entry).__name__}.")
        words = tuple(w for w in entry if isinstance(w, str))
        if len(words) != len(entry):
            raise WordPackError("Every word must be text.")
        if words:
            groups.append(words)
    return tuple(groups)


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


# ── Pack identity ─────────────────────────────────────────────────────────────

@dataclasses.dataclass(frozen=True)
class PackRef:
    """Which pack, and whose.

    `owner_id is None` means a shared pack that everyone can play. Otherwise
    the pack belongs to that Discord user: only they may edit it, and only
    they may start a round with it.
    """

    name: str
    owner_id: int | None = None

    def __post_init__(self):
        # Normalise here, not at each call site: the ref is a dict key, so
        # "Terms" and "terms" arriving as different keys would quietly store
        # the same pack twice. Constructing an invalid name fails outright.
        object.__setattr__(self, "name", normalize_pack_name(self.name))

    @property
    def is_personal(self) -> bool:
        return self.owner_id is not None

    @property
    def key(self) -> str:
        """How this pack is spelled in the JSON file and in a command option."""
        if self.owner_id is None:
            return self.name
        return f"{self.name}{OWNER_SEPARATOR}{self.owner_id}"

    def label(self, viewer_id: int | None = None) -> str:
        """How to show it to `viewer_id`, who may or may not be the owner."""
        if self.owner_id is None:
            return self.name
        return (f"{self.name} (yours)" if viewer_id == self.owner_id
                else f"{self.name} (personal)")

    def owned_by(self, user_id: int | None) -> bool:
        return self.owner_id is None or self.owner_id == user_id


def parse_pack_key(key: str) -> PackRef:
    """Turn a stored key back into a PackRef.

    Only a trailing "@<digits>" counts as an owner. A name cannot contain "@"
    at all, so there is nothing else it could be.
    """
    text = str(key).strip()
    name, sep, owner = text.rpartition(OWNER_SEPARATOR)
    if sep and owner.isdigit():
        return PackRef(name=name, owner_id=int(owner))
    return PackRef(name=text)


def parse_pack_selection(text: str) -> tuple[PackRef, bool]:
    """Split what arrived in a `pack:` option into (ref, was_it_explicit).

    Explicit means the user chose a specific pack from autocomplete, which
    carries an owner for a personal pack and SHARED_MARKER for a shared one.
    A typed bare name is not explicit, and falls back to the preference rules
    in resolve(). Without this, picking the server's "memes" out of the list
    would be indistinguishable from typing "memes" -- and would silently open
    your own pack of the same name instead.
    """
    raw = str(text).strip()
    if raw.startswith(SHARED_MARKER):
        return PackRef(raw[len(SHARED_MARKER):]), True
    ref = parse_pack_key(raw)
    return ref, ref.is_personal


# ── Edit results ──────────────────────────────────────────────────────────────

@dataclasses.dataclass(frozen=True)
class AddResult:
    pack: PackRef
    added: tuple[str, ...]
    duplicates: tuple[str, ...]
    invalid: tuple[str, ...]
    pack_created: bool
    merged: tuple[tuple[str, ...], ...] = ()   # groups an add joined onto


@dataclasses.dataclass(frozen=True)
class RemoveResult:
    pack: PackRef
    removed: tuple[str, ...]
    missing: tuple[str, ...]
    pack_deleted: bool


@dataclasses.dataclass(frozen=True)
class PickedWord:
    pack: PackRef
    word: str
    decoy: str | None = None      # the impostor's near-miss, if one was asked
    group: tuple[str, ...] = ()   # the confusable set `word` was drawn from


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


# ── Storage ───────────────────────────────────────────────────────────────────

class WordPacks:
    """The word file, reloaded whenever it changes underneath us.

    Every public method starts by re-reading the file if its mtime moved, so
    hand edits and slash-command edits stay consistent without a restart.
    Internally the pack map is only ever replaced, never mutated in place.
    """

    def __init__(self, path: str | os.PathLike[str]):
        self._path = Path(path)
        self._packs: dict[PackRef, tuple[tuple[str, ...], ...]] = {}
        self._stamp: tuple[int, int] | None = None   # (mtime_ns, size)

    @property
    def path(self) -> Path:
        return self._path

    # -- reading ---------------------------------------------------------------

    def shared_refs(self) -> tuple[PackRef, ...]:
        self._sync()
        return tuple(sorted((r for r in self._packs if not r.is_personal),
                            key=lambda r: r.name))

    def personal_refs(self, owner_id: int) -> tuple[PackRef, ...]:
        self._sync()
        return tuple(sorted((r for r in self._packs if r.owner_id == owner_id),
                            key=lambda r: r.name))

    def visible_refs(self, viewer_id: int | None = None
                     ) -> tuple[PackRef, ...]:
        """Shared packs, plus the viewer's own. Never anybody else's."""
        own = self.personal_refs(viewer_id) if viewer_id is not None else ()
        return (*self.shared_refs(), *own)

    def groups(self, ref: PackRef) -> tuple[tuple[str, ...], ...]:
        self._sync()
        if ref not in self._packs:
            raise WordPackError(f"No pack named `{ref.name}`.")
        return self._packs[ref]

    def words(self, ref: PackRef) -> tuple[str, ...]:
        """Every word in the pack, groups flattened."""
        return tuple(w for group in self.groups(ref) for w in group)

    def counts(self, viewer_id: int | None = None) -> dict[PackRef, PackStats]:
        self._sync()
        return {ref: group_stats(self._packs[ref])
                for ref in self.visible_refs(viewer_id)}

    def total(self) -> int:
        self._sync()
        return sum(len(g) for groups in self._packs.values() for g in groups)

    def personal_pack_count(self, owner_id: int) -> int:
        return len(self.personal_refs(owner_id))

    def resolve(self, name: str, viewer_id: int | None = None) -> PackRef:
        """Turn what a user typed into a pack they are allowed to play.

        Autocomplete hands back a storage key; a person may type a bare name.
        Their own pack wins over a shared pack of the same name, because that
        is the one they went to the trouble of making. Someone else's personal
        pack is refused rather than silently falling through to a shared one,
        so a name clash never plays the wrong words.
        """
        self._sync()
        asked, explicit = parse_pack_selection(name)

        if explicit and not asked.is_personal:
            # They picked the shared one out of the list; do not substitute
            # their own pack of the same name for it.
            if asked in self._packs:
                return asked
            raise WordPackError(f"No server pack named `{asked.name}`.")

        if asked.is_personal:
            if not asked.owned_by(viewer_id):
                raise WordPackError(
                    f"`{asked.name}` is someone else's personal pack.")
            if asked in self._packs:
                return asked
            raise WordPackError(f"You have no pack named `{asked.name}`.")

        if viewer_id is not None:
            mine = PackRef(asked.name, viewer_id)
            if mine in self._packs:
                return mine
        if asked in self._packs:
            return asked

        others = [r for r in self._packs
                  if r.name == asked.name and r.is_personal]
        if others:
            raise WordPackError(
                f"`{asked.name}` is someone else's personal pack — only they "
                "can start a round with it.")
        raise WordPackError(f"No pack named `{asked.name}`.")

    def pick(self, ref: PackRef | None = None, decoy: bool = True,
             min_group: int = 1,
             rng: random.Random | None = None) -> PickedWord:
        """Pick the crew's word, plus the impostor's near-miss when `decoy`.

        Every eligible *word* is equally likely, so a 5-word pack does not come
        up as often as a 500-word one, and a big group is not under-drawn.
        With `decoy`, only groups holding two or more words are eligible -- the
        decoy is drawn from the rest of the winning word's group. `min_group`
        raises that floor further; see MIN_GUESS_GROUP for why guessing needs
        it.

        With no `ref`, only SHARED packs are drawn from. Sweeping personal
        packs into an unnamed draw would play one person's private words at a
        table that never asked for them.
        """
        self._sync()
        chooser = rng or random

        if ref is not None:
            if ref not in self._packs:
                raise WordPackError(f"No pack named `{ref.name}`.")
            candidates = {ref: self._packs[ref]}
        else:
            candidates = {r: self._packs[r] for r in self.shared_refs()}

        floor = max(min_group, MIN_DECOY_GROUP if decoy else 1)
        pool = [(r, group, word)
                for r, groups in sorted(candidates.items(),
                                        key=lambda kv: kv[0].key)
                for group in groups
                for word in group
                if len(group) >= floor]
        if not pool:
            raise WordPackError(self._empty_pool_reason(candidates, ref, floor))

        chosen_ref, group, word = chooser.choice(pool)
        near_miss = None
        if decoy:
            near_miss = chooser.choice([w for w in group if w != word])
        return PickedWord(pack=chosen_ref, word=word, decoy=near_miss,
                          group=tuple(group))

    @staticmethod
    def _empty_pool_reason(candidates: Mapping[PackRef, tuple],
                           ref: PackRef | None, floor: int) -> str:
        """Say which of the ways a pick can come up empty actually happened."""
        has_words = any(g for groups in candidates.values() for g in groups)
        where = f"Pack `{ref.name}`" if ref is not None else "There"
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

    def add(self, ref: PackRef,
            groups: Iterable[Sequence[str]]) -> AddResult:
        """Add groups of similar words to `ref`, creating the pack if new.

        An incoming group that shares a word with an existing group is merged
        into it rather than stored twice -- that is how you extend a group
        without hand-editing the file, and it makes a "duplicate" useful
        instead of merely rejected.
        """
        self._sync()
        existing = list(self._packs.get(ref, ()))
        known = {w.casefold(): i
                 for i, group in enumerate(existing) for w in group}

        if (ref.is_personal and ref not in self._packs
                and self.personal_pack_count(ref.owner_id)
                >= MAX_PERSONAL_PACKS):
            raise WordPackError(
                f"You already have {MAX_PERSONAL_PACKS} personal packs — "
                "delete one with `/impostor words deletepack scope:mine` "
                "before making another.")

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

        was_new = ref not in self._packs
        # `merged` alone still changes the file: fusing two groups adds no
        # words but is very much an edit.
        if added or merged:
            self._commit({**self._packs, ref: tuple(existing)})
        return AddResult(pack=ref, added=tuple(added),
                         duplicates=tuple(duplicates), invalid=tuple(invalid),
                         pack_created=bool(added) and was_new,
                         merged=tuple(merged))

    def remove(self, ref: PackRef, words: Iterable[str]) -> RemoveResult:
        """Remove words from `ref`. Emptied groups, and an emptied pack, go."""
        self._sync()
        if ref not in self._packs:
            raise WordPackError(f"No pack named `{ref.name}`.")

        wanted: dict[str, str] = {}
        for raw in words:
            word = normalize_word(raw)
            if word is not None:
                wanted[word.casefold()] = word

        kept: list[tuple[str, ...]] = []
        removed: list[str] = []
        for group in self._packs[ref]:
            survivors = tuple(w for w in group if w.casefold() not in wanted)
            removed.extend(w for w in group if w.casefold() in wanted)
            if survivors:
                kept.append(survivors)

        present = {w.casefold() for w in removed}
        missing = tuple(w for key, w in wanted.items() if key not in present)

        pack_deleted = bool(removed) and not kept
        if removed:
            updated = {k: v for k, v in self._packs.items() if k != ref}
            if kept:
                updated[ref] = tuple(kept)
            self._commit(updated)
        return RemoveResult(pack=ref, removed=tuple(removed), missing=missing,
                            pack_deleted=pack_deleted)

    def delete_pack(self, ref: PackRef) -> int:
        """Drop a whole pack. Returns how many words went with it."""
        self._sync()
        if ref not in self._packs:
            raise WordPackError(f"No pack named `{ref.name}`.")
        size = sum(len(g) for g in self._packs[ref])
        self._commit({k: v for k, v in self._packs.items() if k != ref})
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

    def _read(self) -> dict[PackRef, tuple[tuple[str, ...], ...]]:
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
                packs: Mapping[PackRef, tuple[tuple[str, ...], ...]]) -> None:
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




def dump_packs(packs: Mapping[PackRef, tuple[tuple[str, ...], ...]]) -> str:
    """Serialise the word file with one group per line.

    json.dumps(indent=2) puts every single word on its own line, which turns a
    300-word pack into 300 lines and makes the file miserable to hand-edit --
    and hand-editing is half the point of the format.
    """
    blocks = []
    for ref, groups in sorted(packs.items(), key=lambda kv: kv[0].key):
        lines = ",\n".join(f"    {json.dumps(list(g), ensure_ascii=False)}"
                            for g in groups)
        blocks.append(f"  {json.dumps(ref.key, ensure_ascii=False)}: [\n"
                      f"{lines}\n  ]")
    return "{\n" + ",\n".join(blocks) + "\n}\n"


def coerce_packs(raw: object, source: str = "word file"
                 ) -> dict[PackRef, tuple[tuple[str, ...], ...]]:
    """Validate a decoded word file into {pack: ((word, ...), ...)}.

    Keys are storage keys: a bare name for a shared pack, "name@owner_id"
    for a personal one. A pack is a list whose entries are either a group
    (list of similar words) or a bare string (a group of one). A wrong *shape* rejects the whole file
    -- a silently half-loaded pack is worse than a clear failure. Individual
    blank/oversized/duplicate words are dropped instead, so a stray trailing
    comma in a hand-written list does not take the game down.
    """
    if not isinstance(raw, dict):
        raise WordPackError(
            f'{source} must be a JSON object of "pack": [...] entries.')

    packs: dict[PackRef, tuple[tuple[str, ...], ...]] = {}
    for name, entries in raw.items():
        # A key may carry an owner ("memes@123"); a plain name is shared, so
        # a file written before personal packs existed loads unchanged.
        pack = parse_pack_key(name)
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
