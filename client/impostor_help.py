"""
impostor_help.py
~~~~~~~~~~~~~~~~
The text behind /impostor help.

Every number in here is read from the constant that enforces it -- player
limits, board size, the group size guessing needs -- so the help cannot drift
away from the code the way a hand-written copy does. Timeouts are passed in by
the caller, because they belong to the Discord layer rather than the rules.

No discord import, so the text is testable on its own.
"""

from __future__ import annotations

import impostor

TOPIC_PLAY = "play"
TOPIC_OPTIONS = "options"
TOPIC_WORDS = "words"
TOPICS = (TOPIC_PLAY, TOPIC_OPTIONS, TOPIC_WORDS)


def how_to_play(lobby_minutes: int, vote_minutes: int) -> str:
    return f"""🕵️ **Impostor** — how to play

Everyone gets the same secret word. The impostor gets a **similar** one — the \
crew have `T-spin double`, the impostor has `T-spin triple` — and has to talk \
their way through the round without being spotted.

**Crew win** by voting the impostor out.
**Impostor wins** by surviving the vote, or by guessing the crew's word.

**A round, start to finish**
1. `/impostor start` opens a lobby. People press **Join**, or the host names \
them up front with `players:@ana @ben @cleo`.
2. The host presses **Deal** — {impostor.MIN_PLAYERS}–{impostor.MAX_PLAYERS} \
players. The lobby closes itself after {lobby_minutes} idle minutes.
3. Everyone presses **🔍 See my word** for a private copy only they can see. \
Press it again any time, or use `/impostor myword`.
4. Take turns describing your word without saying it. Too specific and the \
impostor learns it; too vague and you look like the impostor.
5. The crew press **🗳️ Call a vote** when ready. Everyone votes, impostor \
included, and picks privately. Eject the impostor → **crew win**. Eject a \
crewmate → **impostor wins**. A tie ejects nobody and play carries on. The \
vote closes itself after {vote_minutes} minutes.
6. At any point the impostor may press **🎯 Guess the word** and pick from \
the board. Right → they win outright. Wrong → the crew do.
7. When it ends, anyone who played can press **🔁 Play again** to re-open the \
lobby with the same roster and the same settings.

**The other commands**
`/impostor myword` — re-read your own role, privately
`/impostor status` — who is in, and what is running
`/impostor reveal` — end the round and show the answer
`/impostor cancel` — scrap it without revealing anything

More: `/impostor help topic:options` · `/impostor help topic:words`"""


def round_options() -> str:
    return f"""⚙️ **Options on `/impostor start`** — all optional, sane defaults

`players` — @mention the roster up front instead of waiting for **Join**. \
Bots and non-members are dropped with a note. The list is taken as written, \
so a host who leaves themselves out runs the round without playing.

`delivery` — how you receive your word. Default **in channel**: press \
**See my word** for a message only you can see, which needs nothing from your \
privacy settings. `dm` pushes a direct message instead, which persists in \
your DMs but only reaches people who accept DMs from server members.

`pack` — which category to draw from. Leave it empty to draw from every \
**server** pack; a personal pack is only ever used when you name it.

`impostors` — how many. Default scales with the table: 1, then 2 at 7 \
players, 3 at 12. Never enough to reach half the table.

`category` — show which pack the word came from. Default **yes**.

`wordlist` — post the board of {impostor.BOARD_SIZE} possible words for \
everyone to read. Default **yes**. It is the same list the impostor guesses \
from, so the two can never disagree.

`decoy` — give the impostor a similar word instead of nothing. Default \
**yes**; `decoy:false` is the harder, older version where the impostor has no \
word at all.

`guessing` — let the impostor end the round early by picking the crew's word. \
Default **yes**. Needs a group of {impostor.MIN_GUESS_GROUP}+ similar words: \
with only two, the impostor's own word would give the answer away.

`voting` — give the crew the **Call a vote** button. Default **yes**. Only \
the crew can open a vote, so the impostor cannot force one before anybody has \
something to go on.

`blind` — do not tell the impostor they are the impostor; they hold a word \
like everybody else and have to work out that theirs is the odd one. Cannot \
be combined with `guessing`, because pressing that button would tell them."""


def managing_words() -> str:
    return f"""📝 **Managing word packs**

Words live in **groups of similar terms**, and that is the whole trick: the \
impostor's word comes from the same group as the crew's, so it is close \
enough to bluff with.

**Two kinds of pack**, chosen with `scope:`
 • **`scope:server`** (the default) — shared by everyone, and editing needs \
the **Manage Server** permission
 • **`scope:mine`** — your own pack. No permission needed, nobody else can \
edit it, and **only you can `/impostor start` with it**. Up to \
{impostor.MAX_PERSONAL_PACKS} of them.

Names may clash. Typing `pack:memes` picks yours if you have one, otherwise \
the server's — or pick the exact pack from the autocomplete list.

`/impostor words list` — server packs plus your own, with their sizes
`/impostor words list pack:<name>` — spell one pack out, group by group

`/impostor words add pack:<name> words:<words> [scope:mine]`
 • **Commas put words in the same group:** `T-spin double, T-spin triple`
 • **Newlines start another group**, so one command can add several
 • Naming an existing word **merges** into its group — that is how you extend \
one without editing the file
 • A new pack name creates the pack

`/impostor words remove pack:<name> words:<words> [scope:mine]` — emptied \
groups are dropped, and an emptied pack goes with them
`/impostor words deletepack pack:<name> [scope:mine]` — the pack and \
everything in it

`/impostor words import pack:<name> file:<upload> [scope:mine]` — bulk add \
from a file, for when typing them out is not on
 • **`.txt`** — one group per line, commas inside a group
 • **`.json`** — a list of groups: `[["a", "b"], ["c", "d"]]`
 • Up to {impostor.MAX_IMPORT_WORDS:,} words and \
{impostor.MAX_IMPORT_BYTES // 1024} KB per import, and it goes through the \
same merge and duplicate rules as `add`

**Group sizes matter:** {impostor.MIN_DECOY_GROUP}+ words for a decoy, \
{impostor.MIN_GUESS_GROUP}+ for guessing, and the bigger the group the harder \
that guess is. `/impostor words list` flags the ones that fall short.

Hand-editing the JSON works too — the bot re-reads it whenever it changes, \
and never overwrites your edits."""


def help_text(topic: str, lobby_minutes: int, vote_minutes: int) -> str:
    """The help for one topic; anything unrecognised falls back to the basics."""
    if topic == TOPIC_OPTIONS:
        return round_options()
    if topic == TOPIC_WORDS:
        return managing_words()
    return how_to_play(lobby_minutes, vote_minutes)
