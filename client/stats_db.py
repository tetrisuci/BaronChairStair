"""
stats_db.py
~~~~~~~~~~~
Where the bot's `stats.db` lives: `STATS_DB` when it is set, beside the code
when it is not.

The file is the bot's memory across restarts — the recap claims that stop a
recap posting twice, when `/archive sync` last started, the presence history,
and the hash of the last command sync. Beside the code was the right home
while the bot ran from one checkout that `git pull` moved. It is the wrong
one once every release gets a directory of its own: each release would open
a fresh, empty file, and the first recap after a deploy could post again a
day already posted. So the deploy names one file outside every release, by
absolute path, and the bot uses it.

**Absolute only.** A relative path resolves against the process's working
directory, which is whatever pm2 was started from — the very thing the old
`# anchored to the repo root — never CWD` refused. A relative `STATS_DB` is
refused at start-up with a message saying so, rather than silently opening a
second database somewhere nobody looks.

This module is the one place the file's name is spelled; `test_stats_db.py`
fails if another module spells it, so nothing can open a second copy beside
the shared one. Stdlib only, so it is testable on a box with no discord.py.
"""

from collections.abc import Mapping
from pathlib import Path

#: The variable the deploy sets. Named in `activity/shared/runtime-status.ts`
#: (`ENV.statsDb`) too, since the deploy that sets it is TypeScript.
ENV = "STATS_DB"

#: Beside the code, as it has always been, when the variable is unset.
FILENAME = "stats.db"


class StatsDbPathError(ValueError):
    """`STATS_DB` is set to something the bot will not guess at."""


def resolve(root: Path, environ: Mapping[str, str]) -> Path:
    """
    The database the bot opens: `STATS_DB` if set, else `root / stats.db`.

    Blank counts as unset — `STATS_DB=` in a .env is somebody who has not
    decided yet, not somebody asking for a file named "". Read once, at
    start-up, after `.env` has been loaded, so `.env` may set it too.
    """
    raw = environ.get(ENV, "").strip()
    if not raw:
        return root / FILENAME
    path = Path(raw)
    if not path.is_absolute():
        raise StatsDbPathError(
            f"{ENV} must be an absolute path; {raw!r} would be read against "
            "whatever directory the bot happened to be started from. "
            f"Give the full path, or unset it to use {root / FILENAME}."
        )
    return path
