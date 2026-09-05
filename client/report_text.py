"""
report_text.py
~~~~~~~~~~~~~~
The rules that decide what a stranger's typing looks like on a public tracker.

Split from `report_commands.py` so it can be tested with bare `python3` — this
repository has no Python test harness, and a module that imports `aiohttp` and
`discord` to check a regular expression cannot be run without installing the
bot. Nothing in here talks to Discord or to GitHub; it is text in, text out.

The one sentence everything here follows from: `/report` publishes text typed by
anybody in the server, under the bot's identity, to a public repository.
"""

import re
import time
from collections import defaultdict


# GitHub's own ceiling on an issue title is 256, and the name and separator have
# to fit inside it too — so the name is capped rather than the whole.
MAX_NAME = 60
MAX_TITLE = 256
# Long enough for a real report with a pasted board, short enough that the
# tracker cannot be filled from one message.
MAX_DESCRIPTION = 4000
MIN_DESCRIPTION = 10

# What one player may file, and over how long. Deliberately generous for a
# person and useless for a script: three real reports in an hour is a busy day
# for anybody, and the fourth can wait or go on an issue they already opened.
REPORTS_PER_WINDOW = 3
WINDOW_SECONDS = 60 * 60

#: C0 and DEL, all of it. For a *title*, where a newline breaks the request
#: rather than the formatting.
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")

#: The same, less the newline, for a *body*. A report is usually steps to
#: reproduce, and flattening it into one line loses the thing that made it worth
#: filing — but a tab and a vertical feed carry no meaning here.
BODY_CONTROLS = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")

#: Written by whichever machine the player is on, and never meaningful.
LINE_ENDINGS = re.compile(r"\r\n?")

#: The two things GitHub turns into an action rather than text. `@name` pings a
#: person or a whole team with nothing to do with this club, and `#123` links an
#: unrelated issue and posts a backlink into it. Both are how a report from a
#: stranger becomes somebody else's notification.
MENTION = re.compile(r"(?<![\w/])([@#])(?=[A-Za-z0-9_-])")


def defang(text: str) -> str:
    """
    User text, safe to publish as GitHub markdown.

    An empty HTML comment rather than stripping or escaping the character: it is
    GitHub's own trick, it leaves the text reading exactly as it was typed, and
    nothing the author writes can escape out of it. Replacing `@` outright would
    silently rewrite an email address or a handle somebody meant to quote, which
    is a worse lie than a mention that does not fire.

    The lookbehind leaves `foo@bar` and a URL's `#fragment` alone: GitHub only
    linkifies these at a word boundary, so neither needs defanging and both
    would be disfigured by it.
    """
    normalised = BODY_CONTROLS.sub(" ", LINE_ENDINGS.sub("\n", text))
    return MENTION.sub(r"\1<!---->", normalised.strip())


def one_line(text: str) -> str:
    """Defanged, and guaranteed to stay on the line it is put on."""
    return re.sub(r"\s+", " ", defang(text)).strip()


def issue_title(display_name: str, category: str) -> str:
    """
    "<player> — <category>", which is the format the club asked for.

    The name is squeezed first: it comes from a Discord profile and can be any
    length, in any script, and carrying anything a title cannot. Truncated
    rather than refused, because a long name is not a reason to lose a report.
    """
    name = re.sub(r"\s+", " ", CONTROL_CHARACTERS.sub(" ", display_name)).strip()
    if not name:
        name = "someone"
    if len(name) > MAX_NAME:
        name = name[: MAX_NAME - 1].rstrip() + "…"
    return f"{name} — {category}"[:MAX_TITLE]


def issue_body(description: str, *, reporter: str, guild: "str | None") -> str:
    """
    The report, and enough provenance to answer it.

    The description is quoted rather than inlined. A `#` at the start of a line
    is a heading and `---` is a rule, so unquoted text can style itself into
    looking like part of the template — and the one thing a maintainer has to be
    able to tell at a glance is which words are the player's.

    Deliberately no Discord user id. The repository is public and an id is a
    durable handle to a person; the display name is what the club asked to
    publish, and it is enough to reply to somebody in the server.
    """
    lines = defang(description).splitlines() or [""]
    quoted = "\n".join(f"> {line}" for line in lines)
    where = f"in **{one_line(guild)}**" if guild else "in a direct message"
    return (
        f"{quoted}\n"
        f"\n"
        f"---\n"
        f"Filed through `/report` by **{one_line(reporter)}** {where}. "
        f"They have no GitHub account; reply here and an officer will pass it on."
    )


class ReportLimiter:
    """
    How often one player may file.

    In memory, so it forgets on restart — the right trade for a club bot: the
    cost of forgetting is a handful of extra reports after a deploy, and the
    cost of a table is a migration and a file to back up for a rule nobody will
    ever tune.
    """

    def __init__(self, limit: int = REPORTS_PER_WINDOW, window: int = WINDOW_SECONDS) -> None:
        self._limit = limit
        self._window = window
        self._filed = defaultdict(list)

    def _recent(self, user_id: int, moment: float) -> list:
        recent = [at for at in self._filed[user_id] if moment - at < self._window]
        self._filed[user_id] = recent
        return recent

    def take(self, user_id: int, now: "float | None" = None) -> bool:
        """True when this report is allowed, and counts it. False when it is not."""
        moment = time.monotonic() if now is None else now
        recent = self._recent(user_id, moment)
        if len(recent) >= self._limit:
            return False
        recent.append(moment)
        return True

    def opens_in(self, user_id: int, now: "float | None" = None) -> int:
        """Seconds until this player may file again. Zero when they may now."""
        moment = time.monotonic() if now is None else now
        recent = self._recent(user_id, moment)
        if len(recent) < self._limit:
            return 0
        return max(0, int(self._window - (moment - min(recent))) + 1)
