"""
discord_bot.py
~~~~~~~~~~~~~~
Discord bot that parses TETR.IO replays and returns top attack burst highlights.

Setup:
    pip install discord.py python-dotenv

    Put your bot token in .env at the repo root (see example.env):
        DISCORD_TOKEN=your_token_here
    It is loaded automatically; .env values override shell exports.

Usage (slash command):
    /highlights top_x:5               (attach a .ttrm file)

Usage (prefix command):
    !highlights 5                      (attach a .ttrm file)
    !highlights                        (defaults to top 3)

The bot responds with the top X attack burst highlights for each player,
formatted in a monospace code block so the boards render correctly.

Internship tracker (backed by ../internship_poller.py; swept every 15 minutes,
notices batched to at most one per hour):
    /internships recent [days] [us_only]   list recently posted tech internships
    /internships info <role>               salary + description for one role
    /internships ping                      toggle notices for yourself
    /internships pinglist                  show who is subscribed

New postings produce one quiet, mention-free notice per subscribed channel
with a button; pressing it replies with the listing as an ephemeral ("only you
can see this") message, so the channel is never flooded.
"""

import os
import sys
import asyncio
import dataclasses
import importlib.util
import io
import sqlite3
import time
from contextlib import redirect_stdout
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands, tasks
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent))

from teto_client import TetoClient, TetoError
from build_snapshots import build_rounds
from render import top_attack_bursts

ROOT = Path(__file__).parent.parent

# Values in .env win over inherited shell exports, so a stale `export
# DISCORD_TOKEN=...` in the terminal can't override the real token. Flip to
# override=False if a deployment ever injects real secrets via the environment.
load_dotenv(ROOT / ".env", override=True)

# The internship poller CLI lives at the repo root; load it by path since the
# client/ directory is what's on sys.path. Its data files (postings.db,
# boards.json) are anchored to its own directory, so CWD never matters.
_spec = importlib.util.spec_from_file_location(
    "internship_poller", ROOT / "internship_poller.py")
poller = importlib.util.module_from_spec(_spec)
sys.modules["internship_poller"] = poller
_spec.loader.exec_module(poller)


# ── Config ────────────────────────────────────────────────────────────────────

DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN")
SERVER_DIR    = Path(__file__).parent.parent / "server"

# Discord's hard limit is 2000 chars per message; we leave a buffer for the
# code-fence markers and any surrounding text.
MAX_CHUNK = 1850
TOP_X_MAX = 10
TOP_X_DEFAULT = 3

# Internship tracker
SWEEP_MINUTES = 15          # how often the background sweep polls the boards
ANNOUNCE_MINUTES = 60       # min gap between subscriber pings; finds in between
                            # accumulate and go out as one batch
ANNOUNCE_MAX = 8            # max postings listed per ping announcement
RECENT_DAYS_DEFAULT = 7     # default look-back for `internships recent`
RECENT_MAX_ROLES = 40       # cap on roles listed per command invocation
DESC_SNIPPET_MAX = 1200     # description excerpt length for `internships info`

# Posting titles/locations come from external APIs and could contain <@id>
# text, and announcements are deliberately silent — nothing this bot sends
# about internships should ever ping anyone.
NO_MENTIONS = discord.AllowedMentions.none()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _capture_highlights(replay_json: str, top_x: int) -> str:
    """
    Parse a replay and return the highlights output as a plain string.
    Runs TetoClient synchronously — call from a thread executor.
    """
    with TetoClient(server_dir=SERVER_DIR) as client:
        result = client.parse_replay(replay_json)

    rounds = build_rounds(result["clears"])

    buf = io.StringIO()
    with redirect_stdout(buf):
        top_attack_bursts(rounds, top_x=top_x, show_boards=False)

    return buf.getvalue().strip()


def _pack(items: list[str], limit: int, sep: str) -> list[str]:
    """
    Greedily pack strings into chunks of at most `limit` chars, joined by
    `sep`. An item longer than `limit` is hard-sliced, so no chunk can ever
    exceed the cap — Discord rejects anything over 2000 chars outright.
    """
    chunks: list[str] = []
    current: list[str] = []
    length = 0

    def flush():
        nonlocal current, length
        if current:
            chunks.append(sep.join(current))
            current, length = [], 0

    for item in items:
        if len(item) > limit:
            flush()
            chunks.extend(item[i:i + limit] for i in range(0, len(item), limit))
            continue
        if length + len(item) + len(sep) > limit and current:
            flush()
        current.append(item)
        length += len(item) + len(sep)
    flush()
    return chunks


def _split_into_code_blocks(text: str, limit: int = MAX_CHUNK) -> list[str]:
    """
    Wrap text in ``` code blocks fitting Discord's character limit, splitting
    between lines so boards stay intact (mid-line only for a pathological one).
    """
    fence = "```\n"
    close = "\n```"
    chunks = _pack(text.splitlines(), limit - len(fence) - len(close), "\n")
    return [fence + c + close for c in chunks] or [fence + "(no highlights found)" + close]


async def _parse_and_respond(
    send,           # coroutine: send(content=...) or followup.send(content=...)
    attachment: discord.Attachment,
    top_x: int,
) -> None:
    """
    Core handler shared by both the prefix command and the slash command.

    Args:
        send:       An async callable that sends a message (channel.send or
                    interaction.followup.send).
        attachment: The uploaded .ttrm file attachment.
        top_x:      Number of highlights to return per player.
    """
    if not attachment.filename.endswith(".ttrm"):
        await send(content="Please attach a `.ttrm` replay file.")
        return

    if top_x < 1 or top_x > TOP_X_MAX:
        await send(content=f"top_x must be between 1 and {TOP_X_MAX}.")
        return

    # Download the replay file bytes
    replay_bytes = await attachment.read()
    try:
        replay_json = replay_bytes.decode("utf-8")
    except UnicodeDecodeError:
        await send(content="Could not read the replay file — is it a valid `.ttrm`?")
        return

    # Run the blocking parse in a thread so the event loop stays free
    loop = asyncio.get_running_loop()
    try:
        highlights = await loop.run_in_executor(
            None, _capture_highlights, replay_json, top_x
        )
    except TetoError as e:
        await send(content=f"Replay parse error: {e}")
        return
    except Exception as e:
        await send(content=f"Unexpected error: {e}")
        return

    if not highlights:
        await send(content="No attack bursts found in this replay.")
        return

    # Send in code-block chunks respecting Discord's character limit
    chunks = _split_into_code_blocks(highlights)
    header = f"**Top {top_x} attack burst{'s' if top_x != 1 else ''}** from `{attachment.filename}`"
    await send(content=header)
    for chunk in chunks:
        await send(content=chunk)


# ── Bot setup ─────────────────────────────────────────────────────────────────

intents = discord.Intents.default()
intents.message_content = True  # required for prefix commands and attachment access

bot = commands.Bot(command_prefix="!", intents=intents)

db = sqlite3.connect(ROOT / "stats.db")  # pinned like postings.db — never CWD

TRACKED_STICKER_ID = 1485928821038383314

db.execute("""
    CREATE TABLE IF NOT EXISTS sticker_stats (
        user_id INTEGER PRIMARY KEY,
        count INTEGER DEFAULT 0
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS intern_pings (
        user_id INTEGER PRIMARY KEY,
        channel_id INTEGER NOT NULL
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS intern_meta (
        key TEXT PRIMARY KEY,
        value REAL
    )
""")
db.commit()

# Postings DB shared with the CLI poller (schema owned by
# internship_poller.db_init). A schema mismatch disables the internship
# tracker instead of taking the whole bot down with it.
try:
    pconn = poller.db_init()
    pconn_error = None
except poller.SchemaMismatch as e:
    pconn, pconn_error = None, str(e)
    print(f"internship tracker disabled: {e}", file=sys.stderr)

@bot.event
async def on_message(message):
    if message.author.bot:
        return

    if any(s.id == TRACKED_STICKER_ID for s in message.stickers):
        db.execute("""
            INSERT INTO sticker_stats (user_id, count)
            VALUES (?, 1)
            ON CONFLICT(user_id) DO UPDATE SET count = count + 1
        """, (message.author.id,))
        db.commit()

    await bot.process_commands(message)

@bot.group()
async def yauna(ctx):
    if ctx.invoked_subcommand is None:
        valid = ", ".join(sorted(cmd.name for cmd in yauna.commands))
        await ctx.reply(f"Unknown command. Valid commands: {valid}")

@yauna.command(name="cancer")
async def yauna_cancer(ctx):
    rows = db.execute(
        "SELECT user_id, count FROM sticker_stats ORDER BY count DESC LIMIT 10"
    ).fetchall()

    if not rows:
        await ctx.send("No one has cancer yet!")
        return

    lines = []
    for i, (user_id, count) in enumerate(rows, start=1):
        try:
            member = await ctx.guild.fetch_member(user_id)
            name = member.display_name
        except discord.NotFound:
            name = f"Unknown User ({user_id})"
        lines.append(f"{i}. {name} — {count} time(s)")

    await ctx.send("**Cancer Leaderboard**\n" + "\n".join(lines))

@bot.event
async def on_ready():
    await bot.tree.sync()
    if pconn is not None:
        # Re-attach the digest button so notices posted before a restart stay
        # clickable (registering twice across reconnects is harmless).
        bot.add_view(InternshipDigestView())
        if not internship_sweep.is_running():
            internship_sweep.start()
    print(f"Logged in as {bot.user} (id: {bot.user.id})")


# ── Slash command ─────────────────────────────────────────────────────────────

@bot.tree.command(
    name="highlights",
    description="Upload a TETR.IO .ttrm replay to see the top attack burst highlights.",
)
@app_commands.describe(
    replay=".ttrm replay file to analyse",
    top_x=f"Number of top bursts to show per player (1–{TOP_X_MAX}, default {TOP_X_DEFAULT})",
)
async def highlights_slash(
    interaction: discord.Interaction,
    replay: discord.Attachment,
    top_x: int = TOP_X_DEFAULT,
):
    # Defer immediately — parsing can take several seconds
    await interaction.response.defer(thinking=True)
    await _parse_and_respond(interaction.followup.send, replay, top_x)


# ── Prefix command ────────────────────────────────────────────────────────────

@bot.command(
    name="highlights",
    help=f"Attach a .ttrm file and optionally specify how many bursts to show (default {TOP_X_DEFAULT}).",
)
async def highlights_prefix(ctx: commands.Context, top_x: int = TOP_X_DEFAULT):
    if not ctx.message.attachments:
        await ctx.send("Please attach a `.ttrm` replay file to your message.")
        return

    attachment = ctx.message.attachments[0]
    async with ctx.typing():
        await _parse_and_respond(ctx.send, attachment, top_x)


# ── Internship tracker ────────────────────────────────────────────────────────

def _format_role(p, c, dupes: int = 0, first_seen: float | None = None) -> str:
    """One listing/announcement block for a posting and its classification."""
    if p.published:
        posted = f"posted {poller.age_str(p)} ago"
    elif first_seen:
        stamp = dataclasses.replace(p, published=first_seen,
                                    approx_date=False, unbounded=False)
        posted = f"seen {poller.age_str(stamp)} ago"
    else:
        posted = "date unknown"
    term = f" · {c['term']}" if c.get("term") else ""
    region = f" · {c['region']}" if c.get("region") else ""
    extra = f"  (+{dupes} more location{'s' if dupes != 1 else ''})" if dupes else ""
    block = (f"**{p.company}** — {p.title}\n"
             f"{p.location or 'location unknown'} · {c['category']}{term}{region}"
             f" · {posted}{extra}")
    if p.url:
        block += f"\n<{p.url}>"
    return block


def _split_blocks(blocks: list[str], limit: int = MAX_CHUNK) -> list[str]:
    """Pack formatted blocks into messages under Discord's length limit."""
    return _pack(blocks, limit, "\n\n")


def _toggle_ping(user_id: int, channel_id: int) -> str:
    if db.execute("SELECT 1 FROM intern_pings WHERE user_id=?",
                  (user_id,)).fetchone():
        db.execute("DELETE FROM intern_pings WHERE user_id=?", (user_id,))
        db.commit()
        return "Removed you from the internship notify list."
    db.execute("INSERT INTO intern_pings VALUES (?, ?)", (user_id, channel_id))
    db.commit()
    return ("Added you to the internship notify list — when new tech "
            "internships are found, this channel gets one quiet notice with a "
            "button, and pressing it shows you the list privately (no pings, "
            "nobody else sees it). Run the command again to unsubscribe.")


def _recent_internships(days: int, us_only: bool):
    """Distinct recent roles from the postings DB, newest first.

    Workday's unbounded "30+ days ago" rows are excluded — they are at least a
    month old, which is never recent. Undated rows fall back to when the sweep
    first saw them.
    """
    cutoff = time.time() - days * 86400
    rows = pconn.execute(
        "SELECT platform, external_id, company, sector, title, location, url,"
        "       category, term, region, published, first_seen"
        " FROM postings WHERE is_intern=1 AND is_tech=1 AND unbounded=0"
        "  AND COALESCE(published, first_seen) >= ?", (cutoff,)).fetchall()

    pairs = []
    for (plat, eid, company, sector, title, loc, url,
         cat, term, region, pub, seen_at) in rows:
        if us_only and region == "non-us":
            continue
        # approx_date isn't persisted; only the Workday adapter ever sets it,
        # so infer it from the platform. unbounded is always False here — the
        # WHERE clause already excluded those rows.
        p = poller.Posting(plat, eid, company, sector, title, loc or "", url,
                           pub, plat == "workday")
        pairs.append((p, {"category": cat, "term": term, "region": region},
                      seen_at))

    grouped = poller.group_roles(pairs, ts=lambda it: it[0].published or it[2])
    return [(g[0][0], g[0][1], g[0][2], len(g) - 1) for g in grouped]


async def _send_recent(send, days: int, us_only: bool) -> None:
    """`send` must already be bound to ephemeral delivery — see _private."""
    days = max(1, min(days, poller.MAX_AGE_DAYS))
    roles = _recent_internships(days, us_only)
    if not roles:
        await send(content=f"No tech internships on record for the last {days} "
                           f"day(s). The tracker sweeps every {SWEEP_MINUTES} "
                           "minutes — check back soon.")
        return
    scope = ", US/remote" if us_only else ""
    header = f"**{len(roles)} recent tech internship roles** (last {days}d{scope})"
    if len(roles) > RECENT_MAX_ROLES:
        header += f" — showing the newest {RECENT_MAX_ROLES}"
    blocks = [_format_role(p, c, dupes, seen_at)
              for p, c, seen_at, dupes in roles[:RECENT_MAX_ROLES]]
    await send(content=header, allowed_mentions=NO_MENTIONS)
    for chunk in _split_blocks(blocks):
        await send(content=chunk, allowed_mentions=NO_MENTIONS)


def _private(interaction: discord.Interaction):
    """followup.send bound to ephemeral — every internship reply uses this so
    a listing is only ever visible to the user who asked for it."""
    async def send(content=None, **kw):
        kw.setdefault("allowed_mentions", NO_MENTIONS)
        return await interaction.followup.send(content, ephemeral=True, **kw)
    return send


_ledger_seeded = False  # flips True once `seen` is known non-empty
_pending: list = []     # fresh postings waiting for the next announcement slot
_last_batch: list = []  # the batch the current notice's button hands out


class InternshipDigestView(discord.ui.View):
    """The button on a new-postings notice.

    A bot can only send an ephemeral message as a reply to an interaction, and
    a background sweep has no interaction — so the sweep posts one quiet notice
    per channel and each subscriber presses this to get their own private copy.
    timeout=None + a fixed custom_id makes it survive bot restarts.
    """

    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Show me the new internships",
                       emoji="📋", style=discord.ButtonStyle.primary,
                       custom_id="internships:digest")
    async def digest(self, interaction: discord.Interaction,
                     button: discord.ui.Button):
        if pconn is None:
            await interaction.response.send_message(_tracker_disabled(),
                                                    ephemeral=True)
            return
        if not _last_batch:
            # Restart cleared the in-memory batch, or a newer one replaced it.
            await interaction.response.send_message(
                "That batch is no longer loaded — `/internships recent` has "
                "everything from the last few days.", ephemeral=True)
            return
        # ephemeral=True: "Only you can see this message".
        await interaction.response.defer(thinking=True, ephemeral=True)
        n = len(_last_batch)
        blocks = [_format_role(p, c) for p, c in _last_batch[:ANNOUNCE_MAX]]
        if n > ANNOUNCE_MAX:
            blocks.append(f"...and {n - ANNOUNCE_MAX} more — run "
                          "`/internships recent` for the full list.")
        header = f"**{n} new tech internship posting{'s' if n != 1 else ''}**"
        send = _private(interaction)
        await send(header)
        for chunk in _split_blocks(blocks):
            await send(chunk)


@tasks.loop(minutes=SWEEP_MINUTES)
async def internship_sweep():
    global _ledger_seeded
    # Everything that touches sqlite stays inside this try: an unhandled
    # exception would permanently stop the tasks.loop.
    try:
        # An empty `seen` table means the very first sweep ever: it would flag
        # every open posting as new. Let it seed the dedup ledger silently.
        # (Checked via O(1) EXISTS, and skipped entirely once known seeded.)
        bootstrap = False
        if not _ledger_seeded:
            bootstrap = not pconn.execute(
                "SELECT EXISTS(SELECT 1 FROM seen)").fetchone()[0]
        fresh = await poller.cmd_sweep(pconn, quiet=True)
        if not _ledger_seeded:
            _ledger_seeded = bool(pconn.execute(
                "SELECT EXISTS(SELECT 1 FROM seen)").fetchone()[0])

        if not bootstrap:
            # Unbounded "30d+" rows are at least a month old — never worth a
            # ping (and /internships recent excludes them for the same reason).
            _pending.extend(pc for pc in fresh if not pc[0].unbounded)
        if not _pending:
            return

        # Throttle: sweeps stay frequent so the DB is fresh, but subscribers
        # get pinged at most once per ANNOUNCE_MINUTES, as one batch. The
        # timestamp lives in stats.db so a restart can't reset the clock.
        now = time.time()
        row = db.execute("SELECT value FROM intern_meta "
                         "WHERE key='last_announce'").fetchone()
        if now - (row[0] if row else 0) < ANNOUNCE_MINUTES * 60:
            return
        subs = db.execute("SELECT user_id, channel_id FROM intern_pings").fetchall()
        if not subs:
            # Nobody to tell; same semantics as pre-throttle — postings found
            # while nobody subscribed are never pinged retroactively.
            _pending.clear()
            return
        batch, _pending[:] = list(_pending), []
        db.execute("INSERT OR REPLACE INTO intern_meta VALUES('last_announce', ?)",
                   (now,))
        db.commit()
    except Exception as e:
        # Roll back so a half-written sweep can't hold the DB lock until the
        # next iteration or leak uncommitted `seen` rows into it.
        pconn.rollback()
        print(f"internship sweep failed: {type(e).__name__}: {e}", file=sys.stderr)
        return

    by_channel: dict[int, list[int]] = {}
    for uid, cid in subs:
        by_channel.setdefault(cid, []).append(uid)

    batch.sort(key=lambda pc: -(pc[0].published or 0))
    _last_batch[:] = batch      # what the button will show, until the next batch
    n = len(batch)
    # One quiet notice per channel, no mentions. Subscribers click the button
    # to get the listing as an ephemeral ("only you can see this") reply, so
    # the channel never fills with pings or posting dumps.
    header = (f"**{n} new tech internship posting{'s' if n != 1 else ''}** — "
              f"{len(subs)} subscriber{'s' if len(subs) != 1 else ''} notified. "
              "Press the button for your private list.")
    for cid in by_channel:
        # One channel failing (deleted, no send permission) must not stop the
        # other channels' announcements or kill the loop.
        try:
            channel = bot.get_channel(cid) or await bot.fetch_channel(cid)
            await channel.send(content=header, view=InternshipDigestView(),
                               allowed_mentions=NO_MENTIONS)
        except Exception as e:
            print(f"internship notice to channel {cid} failed: "
                  f"{type(e).__name__}: {e}", file=sys.stderr)


@internship_sweep.before_loop
async def _sweep_wait_ready():
    await bot.wait_until_ready()


def _tracker_disabled() -> str:
    return (f"The internship tracker is disabled: {pconn_error} "
            "Fix the postings database and restart the bot.")


internships = app_commands.Group(name="internships",
                                 description="Tech internship tracker")


@internships.command(name="recent",
                     description="List recently posted tech internships.")
@app_commands.describe(
    days=f"Look-back window in days (default {RECENT_DAYS_DEFAULT})",
    us_only="Only show US / remote roles",
)
async def internships_recent_slash(
    interaction: discord.Interaction,
    days: app_commands.Range[int, 1, 30] = RECENT_DAYS_DEFAULT,
    us_only: bool = False,
):
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    await interaction.response.defer(thinking=True, ephemeral=True)
    await _send_recent(_private(interaction), days, us_only)


@internships.command(
    name="ping",
    description="Toggle internship pings for yourself in this channel.")
async def internships_ping_slash(interaction: discord.Interaction):
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    await interaction.response.send_message(
        _toggle_ping(interaction.user.id, interaction.channel_id), ephemeral=True)


_INFO_COLS = ("platform, external_id, company, sector, title, location, url,"
              " category, term, region, published, first_seen")


def _find_posting(role: str):
    """Resolve an `info` argument: rowid from autocomplete, else fuzzy text
    (every typed word must appear somewhere in company + title)."""
    role = role.strip()
    if role.isdigit():
        row = pconn.execute(
            f"SELECT {_INFO_COLS} FROM postings WHERE rowid=?",
            (int(role),)).fetchone()
        if row:
            return row
    tokens = role.lower().split()
    if not tokens:
        return None
    cond = " AND ".join(["(company || ' ' || title) LIKE ?"] * len(tokens))
    return pconn.execute(
        f"SELECT {_INFO_COLS} FROM postings WHERE is_intern=1 AND is_tech=1"
        f"  AND {cond}"
        " ORDER BY COALESCE(published, first_seen) DESC LIMIT 1",
        [f"%{t}%" for t in tokens]).fetchone()


@internships.command(name="info",
                     description="Salary and description for a recent internship.")
@app_commands.describe(role="Start typing a company or title and pick a suggestion")
async def internships_info_slash(interaction: discord.Interaction, role: str):
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    row = _find_posting(role)
    if row is None:
        await interaction.response.send_message(
            "Couldn't find that role — start typing and pick one of the "
            "suggestions, or check `/internships recent` for what's tracked.",
            ephemeral=True)
        return
    await interaction.response.defer(thinking=True, ephemeral=True)
    (plat, eid, company, sector, title, loc, url,
     cat, term, region, pub, seen_at) = row

    try:
        details = await poller.fetch_details(plat, url, eid)
    except Exception as e:
        print(f"detail fetch failed for {company} — {title}: "
              f"{type(e).__name__}: {e}", file=sys.stderr)
        details = {}

    p = poller.Posting(plat, eid, company, sector, title, loc or "", url,
                       pub, plat == "workday")
    blocks = [_format_role(p, {"category": cat, "term": term, "region": region},
                           first_seen=seen_at),
              f"**Salary:** {details.get('salary') or 'not listed'}"]
    desc = (details.get("description") or "").strip()
    if desc:
        if len(desc) > DESC_SNIPPET_MAX:
            desc = desc[:DESC_SNIPPET_MAX].rsplit(" ", 1)[0] + " …"
        blocks.append(desc)
    else:
        blocks.append("No description available — the posting may have closed.")

    send = _private(interaction)
    for chunk in _split_blocks(blocks):
        await send(chunk)


@internships_info_slash.autocomplete("role")
async def internships_info_autocomplete(interaction: discord.Interaction,
                                        current: str):
    if pconn is None:
        return []
    tokens = current.lower().split()
    choices = []
    for rid, company, title in pconn.execute(
            "SELECT rowid, company, title FROM postings"
            " WHERE is_intern=1 AND is_tech=1 AND unbounded=0"
            " ORDER BY COALESCE(published, first_seen) DESC LIMIT 400"):
        label = f"{company} — {title}"
        if not all(t in label.lower() for t in tokens):
            continue
        choices.append(app_commands.Choice(name=label[:100], value=str(rid)))
        if len(choices) == 25:
            break
    return choices


@internships.command(name="pinglist",
                     description="Show who is subscribed to internship notices.")
async def internships_pinglist_slash(interaction: discord.Interaction):
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    subs = db.execute("SELECT user_id, channel_id FROM intern_pings").fetchall()
    if not subs:
        await interaction.response.send_message(
            "Nobody is subscribed yet — sign up with `/internships ping`.",
            ephemeral=True)
        return

    by_channel: dict[int, list[int]] = {}
    for uid, cid in subs:
        by_channel.setdefault(cid, []).append(uid)

    lines = [f"**{len(subs)} subscribed to internship notices**"]
    for cid, uids in sorted(by_channel.items()):
        lines.append(f"<#{cid}>: " + " ".join(f"<@{u}>" for u in uids))

    # NO_MENTIONS renders the <@id>/<#id> chips without pinging anyone.
    chunks = _pack(lines, MAX_CHUNK, "\n")
    await interaction.response.send_message(chunks[0], ephemeral=True,
                                            allowed_mentions=NO_MENTIONS)
    send = _private(interaction)
    for chunk in chunks[1:]:
        await send(chunk)


bot.tree.add_command(internships)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if not DISCORD_TOKEN:
        print("Error: DISCORD_TOKEN is not set.", file=sys.stderr)
        print(f"  Add DISCORD_TOKEN=your_token_here to {ROOT / '.env'}",
              file=sys.stderr)
        sys.exit(1)

    bot.run(DISCORD_TOKEN)