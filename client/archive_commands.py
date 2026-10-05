"""
archive_commands.py
~~~~~~~~~~~~~~~~~~~
`/archive sync` — pull the club's spreadsheet into the puzzle database.

A group rather than `/puzzle sync`, and that is worth recording because it is
the second time the decision has been made. Discord will not let one name be
both invocable and a group, so `/puzzle` becoming a parent would rename the
command everybody already types — the command that also announces each new
version to a server. `puzzle_commands.py` collapsed four subcommands into one
for that reason, and `/report` is top-level for the same one. `/archive` is a
name nobody types today, so it costs nothing and leaves room for the siblings
this will want later: a status, and one day a publish.

**A sync from here is a published sync.** `bun run sync-archive` reads the
sheet and upserts every puzzle it can replay; from a terminal everything it
writes lands *unpublished*, the review gate. From Discord it is run with
`--publish`, and there is no review step: anybody may run this, so what the
sheet holds is what players get. Edit access to the sheet is the gate now;
the ten-minute window bounds how often a sync runs and reviews nothing.
Then the activity is asked to reload in place (`POST /api/bot/reload-archive`),
so what was synced is playable at once, with no restart to drop anybody's
duel. A dry run does neither.

**Anybody may run it, once every ten minutes.** It used to sit behind a
hand-kept list of officers; the owner opened it to every member, and what
bounds it now is time rather than a name — one window across every server and
every member, dry runs included. `sync_window.py` holds the window and says
why it is shaped the way it is.

The two neighbouring tools stay unreachable from Discord: `publish-archive` by
id at a terminal, and `bun run puzzles`, which has already caused a boot
failure by dropping a puzzle a rush pool referenced.

Environment (see example.env):
    PUZZLE_ACTIVITY_DIR   Where the activity checkout lives. Defaults to the
                          `activity/` beside this repository, which is right
                          whenever the bot and the activity are deployed from
                          one tree, as they are on the club's box.
"""

import asyncio
import os
import sqlite3
import sys
import time
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
import discord
from discord import app_commands

import sync_window

#: The activity half of this repository, where `bun run sync-archive` lives.
#:
#: Set explicitly as the subprocess's working directory, not merely assumed:
#: Bun reads `.env` from the process working directory only and does not walk
#: up, so a sync started from the repository root would run with none of
#: `activity/.env` loaded.
DEFAULT_ACTIVITY_DIR = Path(__file__).resolve().parent.parent / "activity"

#: Long enough for a cold run over the whole sheet, short enough that a wedged
#: sync gives whoever ran it an answer rather than a spinner. A local dry run over
#: 163 puzzles takes a few seconds; the ceiling is for a slow network and a
#: database the live server is holding, which `sync-archive` waits out with its
#: own `busy_timeout`.
SYNC_TIMEOUT_S = 300

#: Discord's own ceiling is 2000 characters. The reply spends the rest on the
#: framing around the tool's output, the verdict, and what went live.
MAX_OUTPUT_CHARS = 1200

#: Where the activity takes its reload, and how long to give it. The reload
#: itself is milliseconds; the rest is a round trip through the proxy.
RELOAD_PATH = "/api/bot/reload-archive"
RELOAD_TIMEOUT_S = 15

#: How many ids a line of the reply will spell out before counting the rest.
MAX_IDS_LISTED = 15

#: `sync-archive` distinguishes its exits, and treating any non-zero as failure
#: would report the tool's expected work as a fault. 1 means rows it could not
#: write, which is the sync not doing its job; 2 means content edits landed,
#: which is normal but is the one thing somebody has to go and read.
EXIT_OK = 0
EXIT_UNWRITTEN = 1
EXIT_EDITED = 2

#: One sync at a time, in this process.
#:
#: `sync-archive` is re-runnable and takes a `busy_timeout` against the live
#: server, so a second run would not corrupt anything — it would do the same
#: work twice and report two half-truths to two people. Refusing is kinder
#: than surviving.
_running = asyncio.Lock()

#: The bot's own database, assigned by `discord_bot.py` once
#: `sync_window.init_db` has made the table — the arrangement
#: `puzzle_commands.recap_db` uses. None when the table could not be made.
sync_db: "sqlite3.Connection | None" = None

#: The last start this process saw, kept beside the one in `sync_db`.
#:
#: The window is the only thing bounding a command anybody may run, so it has
#: to hold when the database cannot be read or written too. Then it lasts
#: until the next restart, rather than not at all.
_started_here: float | None = None


def _now() -> float:
    """Wall-clock UTC epoch seconds. A function so a test can own the clock."""
    return time.time()


def _last_start() -> float | None:
    """
    When the last sync started, by the database or this process, whichever is later.

    Returned as stored, even when it is ahead of the clock: `sync_window` is
    what decides a start in the future cannot hold the window, so the rule
    lives, and is tested, in one place.
    """
    stored = None
    if sync_db is not None:
        try:
            stored = sync_window.last_started(sync_db)
        except sqlite3.Error as exc:
            print(f"archive-sync: cannot read the sync window ({exc})", file=sys.stderr)
    known = [moment for moment in (stored, _started_here) if moment is not None]
    return max(known, default=None)


def _record_start() -> float:
    """Opens a new window from now, and returns when it opened."""
    global _started_here
    started = _now()
    _started_here = started
    if sync_db is not None:
        try:
            sync_window.record_start(sync_db, started)
        except sqlite3.Error as exc:
            # Logged, not raised: the sync is already running, and this
            # process still remembers the start in `_started_here`.
            print(f"archive-sync: cannot record the sync window ({exc})", file=sys.stderr)
    return started


def _activity_dir() -> Path:
    override = os.environ.get("PUZZLE_ACTIVITY_DIR", "").strip()
    return Path(override) if override else DEFAULT_ACTIVITY_DIR


#: Enough to stop a fence closing, invisible to a reader.
#:
#: Discord looks for the next ``` anywhere in the message, not only at the
#: start of a line, so three backticks inside the tool's output would close the
#: block the reply opened and render everything after it as markdown. The
#: output carries puzzle titles straight from the club's spreadsheet
#: (`sync-archive.ts` prints `#42 "the title"`), which is text this bot does
#: not control.
FENCE = "```"
DEFANGED_FENCE = "`\u200b`\u200b`"


def _fence_safe(text: str) -> str:
    return text.replace(FENCE, DEFANGED_FENCE)


def _clip(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    """
    The tail of the tool's output, which is where its summary lives.

    The head is the part to lose: `describe()` prints the counts and then a
    line per puzzle, so a long run's interesting end — the skipped rows, the
    "nothing was written" note — is exactly what head-truncation would cut.
    """
    body = text.strip()
    if len(body) <= limit:
        return body
    return "…\n" + body[-limit:].lstrip()


async def run_sync(
    dry_run: bool,
    by: str,
    cwd: Path | None = None,
    on_start: Callable[[], object] | None = None,
) -> tuple[int, str]:
    """
    Runs `bun run sync-archive` and returns its exit code and combined output.

    Separated from the command callback so the interesting half is testable
    without a Discord interaction, and so the callback reads as policy rather
    than as process handling.

    `--by` is an attribution rather than an identity — `sync-archive` says so
    itself — and it lands in the gitignored working database, never in the
    tracked archive. It is worth passing because a content edit found months
    later with no explanation is a small mystery, and "who ran the sync" is the
    answer to it.

    `on_start` is called once the process has launched and before its output
    is awaited, which is the moment the ten-minute window opens. A run that
    cannot launch — no activity directory, no `bun` — never calls it.
    """
    directory = cwd or _activity_dir()
    argv = ["bun", "run", "sync-archive"]
    # Never both. A dry run's transaction is rolled back before publishing is
    # reached, so passing both would be harmless — but a command that asks for
    # a publish it cannot get reads as a bug to whoever next opens this.
    argv.append("--dry-run" if dry_run else "--publish")
    argv += ["--by", by]

    # Checked before the exec, because `create_subprocess_exec` raises
    # FileNotFoundError for a missing `bun` *and* for a missing cwd, and the
    # two want opposite advice. Telling somebody to install Bun when the real
    # problem is an unset PUZZLE_ACTIVITY_DIR sends them a long way wrong.
    if not directory.is_dir():
        return -1, (
            f"`{directory}` is not there, so the sync has nowhere to run. "
            "Point PUZZLE_ACTIVITY_DIR at the activity checkout."
        )

    # pm2 fork mode runs this bot as a Node child and leaves NODE_CHANNEL_FD
    # (and its serialization-mode sibling) in the environment even though the
    # fd it names does not survive into a grandchild. Bun's own Node
    # compatibility layer honours that variable on trust: `bun run <alias>`
    # does a nested posix_spawn to run the resolved script line, and that
    # spawn fails outright with `EBADF: Bad file descriptor (posix_spawn())`
    # when it tries to wire up an IPC channel on a fd that was never actually
    # open here. Confirmed by reproducing under a throwaway pm2 fork-mode
    # process and clearing these two — nothing else needed changing.
    env = {k: v for k, v in os.environ.items() if not k.startswith("NODE_CHANNEL_")}

    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(directory),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            # Merged rather than kept apart: the tool interleaves its warnings
            # with its report, and two streams shown separately in a Discord
            # message would put a warning about a puzzle a screen away from the
            # line about that puzzle.
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError:
        return -1, (
            "`bun` is not on this bot's PATH, so the sync cannot run here. "
            "It has to be installed for the user the bot runs as."
        )
    except OSError as exc:
        return -1, f"Could not start the sync: {exc}"

    if on_start is not None:
        on_start()

    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=SYNC_TIMEOUT_S)
    except asyncio.TimeoutError:
        # Killed rather than left behind: an abandoned sync still holds a write
        # transaction against the database the live server is reading.
        process.kill()
        await process.wait()
        return -1, (
            f"The sync ran past {SYNC_TIMEOUT_S}s and was stopped. Nothing is "
            "half-written — it writes in one transaction."
        )

    return process.returncode or 0, stdout.decode("utf-8", errors="replace")


def verdict(code: int, dry_run: bool) -> str:
    """
    The sentence under the output. Public, so it says what to do next.

    Every branch checks `dry_run`, because a dry run that says "Synced" is a
    lie about the one thing the option exists to promise. Only the clean branch
    used to, which made `verdict(2, dry_run=True)` claim puzzles had changed
    content when nothing had been written at all.

    Exit 1 does **not** say the sheet was read. `sync-archive.ts` invokes
    `main()` as a bare top-level await with no catch, so an uncaught throw —
    the sheet answering an HTML sign-in page because it stopped being shared, a
    renamed tab, a network failure — exits 1 exactly like the rows-would-not-
    write case it documents. The two are indistinguishable from out here, so
    the wording covers both and sends somebody to the output above it rather
    than asserting a successful read. The narrower sentence belongs in the tool,
    behind a distinct exit code.
    """
    if code == EXIT_OK:
        return "Sheet read, nothing left over." if dry_run else "Synced and published."
    if code == EXIT_EDITED:
        if dry_run:
            return (
                "Nothing was written. Some puzzles would change content — the lines "
                "above are worth reading before anybody syncs for real."
            )
        return (
            "Synced and published, and some puzzles changed content — the lines "
            "above are worth reading."
        )
    if code == EXIT_UNWRITTEN:
        return (
            "It stopped short — either some rows would not write, or the sync failed "
            "outright. The output above says which, and this needs a look at a "
            "terminal."
        )
    return "The sync failed."


def _ids(ids: list) -> str:
    shown = ", ".join(f"#{i}" for i in ids[:MAX_IDS_LISTED])
    more = len(ids) - MAX_IDS_LISTED
    return f"{shown} and {more} more" if more > 0 else shown


def describe_reload(result: dict) -> str:
    """
    What the activity's reload did, for whoever asked.

    Says what players will and will not notice, because that is the question
    anybody publishing to a live game has. New puzzles are playable in
    Explore and duels at once but reach the daily rotation only from tomorrow:
    today's four and today's rush pool were pinned before the swap, so nobody
    playing now is re-dealt. A changed board is named rather than buried —
    it is the one thing that did not go live, and whoever ran the sync should know why.
    """
    added = list(result.get("added") or [])
    held = list(result.get("held") or [])
    lines = []
    if added:
        lines.append(
            f"**Live now:** {_ids(added)} — in Explore and duels straight away, and in "
            "the daily rotation from tomorrow. Today's puzzles and rush don't move."
        )
    else:
        lines.append("The activity reloaded; no new puzzles to add.")
    if held:
        lines.append(
            f"**Waiting for the activity's next restart:** {_ids(held)} — the sheet "
            "changed the board itself, and swapping it now would score anyone "
            "mid-solve against a board they were never shown."
        )
    return "\n".join(lines)


async def reload_activity() -> str:
    """
    Asks the running activity to serve what was just published, and says how
    that went. Never raises: the sync has already happened, and a reply that
    blamed it for the activity being unreachable would be wrong about both.

    Every failure says the same true thing — the rows are published, and the
    activity picks them up whenever it next starts — so whoever ran it knows
    nothing is lost, only delayed.
    """
    later = "They go live when the activity next restarts."
    base = os.environ.get("PUZZLE_API", "").rstrip("/")
    key = os.environ.get("PUZZLE_API_KEY", "").strip()
    if not base or not key:
        return f"Published, but `PUZZLE_API` or `PUZZLE_API_KEY` is unset, so the activity was not told. {later}"
    host = urlparse(base).hostname or ""
    # The same rule `puzzle_commands._get` holds, for the same key.
    if not base.startswith("https://") and host not in ("localhost", "127.0.0.1", "::1"):
        return f"Published, but `PUZZLE_API` is not https, so the key was not sent. {later}"

    try:
        timeout = aiohttp.ClientTimeout(total=RELOAD_TIMEOUT_S)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(base + RELOAD_PATH, headers={"X-Api-Key": key}) as response:
                body = await response.json(content_type=None)
                if response.status == 200 and isinstance(body, dict):
                    return describe_reload(body)
                reason = body.get("error") if isinstance(body, dict) else None
                print(f"archive-sync: reload answered HTTP {response.status}: {reason}",
                      file=sys.stderr)
                if response.status == 422 and reason:
                    return f"Published, but the activity would not take the new pool: {reason}"
                return f"Published, but the activity answered HTTP {response.status}. {later}"
    except (aiohttp.ClientError, TimeoutError, ValueError) as exc:
        # The type too: most of these stringify to "", as `_get` records.
        print(f"archive-sync: reload failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return f"Published, but the activity could not be reached. {later}"


archive = app_commands.Group(
    name="archive",
    description="Tools for the club's puzzle archive.",
)


@archive.command(
    name="sync",
    description="Pull the club's spreadsheet in and make its new puzzles playable. Once every 10 minutes.",
)
@app_commands.describe(
    dry_run="Read the sheet and report what would change, writing nothing.",
)
async def archive_sync(
    interaction: discord.Interaction, dry_run: bool = False
) -> None:
    if await _refused(interaction):
        return

    started_at: float | None = None

    def opened() -> None:
        nonlocal started_at
        started_at = _record_start()

    user = getattr(interaction, "user", None)
    async with _running:
        # Public from here on. The result is a change to the club's archive,
        # and a sync run silently is how two people run it twice.
        await interaction.response.defer()
        label = (
            getattr(user, "name", None)
            or getattr(user, "display_name", None)
            or "discord"
        )
        code, output = await run_sync(
            dry_run=dry_run, by=f"discord:{label}", on_start=opened
        )
        # Inside the lock, so two syncs cannot interleave reloads. Not after a
        # dry run, which published nothing, nor after a sync that never
        # started (-1). Every other exit reloads: rows that did write were
        # published, and reloading an unchanged pool is a no-op.
        live = await reload_activity() if not dry_run and code != -1 else ""

    try:
        await interaction.followup.send(
            _result(code, output, dry_run, live, started_at),
            # The two sibling command modules both pass this on every send, and
            # this one carries text from the spreadsheet, so it needs it most:
            # an @everyone in a puzzle title would otherwise ping the server.
            allowed_mentions=discord.AllowedMentions.none(),
        )
    except Exception as exc:  # noqa: BLE001 — the reply is best-effort
        # The sync itself already happened. Losing the message must not look
        # like losing the work, so this is logged rather than raised into
        # discord.py's handler, which would show a generic failure for a
        # command that succeeded.
        print(f"archive-sync: could not post the result ({exc})", file=sys.stderr)


async def _refused(interaction: discord.Interaction) -> bool:
    """
    Turns the request away if a sync is running or the window is shut.

    The refusal answers before any defer, which is this repository's rule and
    not a style choice: deferring ephemerally would make every later followup
    ephemeral too, and deferring publicly posts a visible "thinking" for a
    command about to be turned away. Reading the window is one small query,
    so there is nothing to wait on yet.

    Private, because it is about the person who asked rather than about the
    world: a "try later" read out in the channel is a scolding with an
    audience. It names times and never a person.

    Nothing between this check and `async with _running` in the caller awaits
    — the send happens only on the path that returns — so two requests cannot
    both find the window open and both start.
    """
    now = _now()
    last = _last_start()
    running = _running.locked()
    if not running and sync_window.is_open(last, now):
        return False
    await interaction.response.send_message(
        sync_window.refusal(last, running=running, now=now),
        ephemeral=True,
        allowed_mentions=discord.AllowedMentions.none(),
    )
    return True


def _result(
    code: int, output: str, dry_run: bool, live: str, started_at: float | None
) -> str:
    """
    The public reply under a sync: the tool's output, the verdict, what went
    live, and — when a sync actually started — when the next one may.

    A run that never launched did not open a window, so it promises no wait.
    """
    heading = "**Dry run** — nothing was written.\n" if dry_run else ""
    body = _fence_safe(_clip(output))
    tail = f"\n{_fence_safe(live)}" if live else ""
    window = f"\n{sync_window.next_line(started_at)}" if started_at is not None else ""
    return f"{heading}```\n{body}\n```\n{verdict(code, dry_run)}{tail}{window}"
