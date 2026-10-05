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

Daily recap (backed by puzzle_recap.py; polled every 5 minutes):
    Once the puzzle day turns over, the bot replies to that server's own
    /puzzle message with yesterday's results — solvers fastest first,
    everyone who missed grouped after them, and the server's streak. Exactly
    once per server per day: the claim is a (guild_id, day) primary key in
    stats.db, not a timer, so a restart at any hour cannot double-post it.
    A server that never ran /puzzle gets no recap; there is nothing to
    reply to. This is the one place the bot mentions people on purpose —
    every player it names is pinged, every day — so it is OFF unless
    PUZZLE_RECAP=on is set in .env.

Activity tracker (backed by presence_tracker.py; samples every 10 minutes):
    /activity graph [days] [breakdown] [guild_id]
                                           PNG graph of online users
                                           (defaults to the last 7 days)
    /activity now [guild_id]               current online/idle/dnd counts

Both accept an optional guild_id to inspect any server the bot is in; the
x-axis is labelled in Pacific time (PST/PDT).

Requires the privileged Server Members and Presence intents to be enabled in
the Discord Developer Portal (Bot > Privileged Gateway Intents); without them
login fails with PrivilegedIntentsRequired.
"""

import logging
import os
import sys

# ── The Python floor, said out loud ──────────────────────────────────────────
#
# This module annotates with PEP 604 unions (`str | None`) at module scope, and
# 3.9 evaluates annotations eagerly at definition time — so importing it there
# dies with `TypeError: unsupported operand type(s) for |` further down, naming
# an operator rather than a version. Nothing in the failure
# says "your Python is too old", which is the one thing the reader needs.
#
# Checked here rather than in a shared module because this is the only entry
# point that breaks: the standalone tools carry no PEP 604 and run on 3.9 today,
# and a guard on those would assert a constraint they do not have. `sys` is
# imported above and the check is written in syntax every version parses, so it
# runs before anything it is protecting.
#
# There is a second, independent reason for 3.10: the `python-dotenv` that
# `pip install` resolves today — named in the README's own install line and
# imported below — declares `Requires-Python: >=3.10`. Older releases of it
# allowed 3.8, so that half of the argument is about what a fresh install gets
# rather than about the package for all time. The syntax above is the hard one.
MINIMUM_PYTHON = (3, 10)
if sys.version_info < MINIMUM_PYTHON:
    running = ".".join(str(part) for part in sys.version_info[:3])
    sys.exit(
        f"discord_bot.py needs Python {MINIMUM_PYTHON[0]}.{MINIMUM_PYTHON[1]} or newer; "
        f"this is {running}. Python 3.9 reached end of life in October 2025."
    )

import asyncio
import io
import sqlite3
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
import presence_tracker
import puzzle_commands
import changelog
import puzzle_recap
from puzzle_commands import puzzle_command
import report_commands
import archive_commands
import sync_window

log = logging.getLogger(__name__)

ROOT = Path(__file__).parent.parent

# Values in .env win over inherited shell exports, so a stale `export
# DISCORD_TOKEN=...` in the terminal can't override the real token. Flip to
# override=False if a deployment ever injects real secrets via the environment.
load_dotenv(ROOT / ".env", override=True)


# ── Config ────────────────────────────────────────────────────────────────────

DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN")
SERVER_DIR    = Path(__file__).parent.parent / "server"

# Discord's hard limit is 2000 chars per message; we leave a buffer for the
# code-fence markers and any surrounding text.
MAX_CHUNK = 1850
TOP_X_MAX = 10
TOP_X_DEFAULT = 3

# Presence tracker (/activity) — see client/presence_tracker.py.
PRESENCE_SAMPLE_MINUTES = presence_tracker.SAMPLE_MINUTES
PRESENCE_DAYS_DEFAULT   = presence_tracker.GRAPH_DAYS_DEFAULT
PRESENCE_DAYS_MAX       = presence_tracker.GRAPH_DAYS_MAX

# Text the bot repeats but did not write — a server's name, above all — could
# contain <@id> or @everyone, and a reply that carries it must never ping
# anyone. The daily recap is the one deliberate exception; see RECAP_MENTIONS.
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
# Presence tracking (/activity). Both are PRIVILEGED: they must also be
# toggled on under Bot > Privileged Gateway Intents in the Developer
# Portal, or login fails outright with a PrivilegedIntentsRequired error.
intents.members = True    # member list, so offline members are countable
intents.presences = True  # online/idle/dnd status per member

bot = commands.Bot(command_prefix="!", intents=intents)


# ── No link-preview embeds, anywhere ──────────────────────────────────────────
# Discord renders a preview card for every link in a message — a filed
# /report's issue URL, for one — and the card buries the text it came with.
# Rather than passing suppress_embeds=True at every call site (and remembering
# it forever), patch the send paths once so every message the bot sends
# defaults to it. A message that brings its own embed is left alone, and
# callers can still opt out explicitly with suppress_embeds=False.

def _no_embeds(send):
    async def wrapper(*args, **kwargs):
        if not kwargs.get("embed") and not kwargs.get("embeds"):
            kwargs.setdefault("suppress_embeds", True)
        return await send(*args, **kwargs)
    return wrapper


discord.abc.Messageable.send = _no_embeds(discord.abc.Messageable.send)
discord.InteractionResponse.send_message = _no_embeds(
    discord.InteractionResponse.send_message)
discord.Webhook.send = _no_embeds(discord.Webhook.send)   # interaction.followup
# Context.send / Message.reply override Messageable.send, so patch them too.
commands.Context.send = _no_embeds(commands.Context.send)
commands.Context.reply = _no_embeds(commands.Context.reply)
discord.Message.reply = _no_embeds(discord.Message.reply)

db = sqlite3.connect(ROOT / "stats.db")  # anchored to the repo root — never CWD

TRACKED_STICKER_ID = 1485928821038383314

db.execute("""
    CREATE TABLE IF NOT EXISTS sticker_stats (
        user_id INTEGER PRIMARY KEY,
        count INTEGER DEFAULT 0
    )
""")
db.commit()

# puzzle_plays, owned by client/puzzle_recap.py. Same policy as presence
# below: if the table cannot be made, the daily recap turns itself off and the
# /puzzle commands carry on without it.
try:
    puzzle_recap.init_db(db)
    puzzle_commands.recap_db = db
    recap_error = None
except sqlite3.Error as e:
    recap_error = f"{type(e).__name__}: {e}"
    print(f"puzzle recap disabled: {recap_error}", file=sys.stderr)
if recap_error is None and not puzzle_recap.enabled():
    # Said once, at start-up. DEPLOY.md's verification step 3 points at this
    # line; without it, an operator whose recap is silent chases PUZZLE_API_KEY
    # for a recap that is simply switched off.
    print("puzzle recap off: set PUZZLE_RECAP=on in .env to turn it on",
          file=sys.stderr)

# bot_versions, owned by client/changelog.py. Same policy again: without the
# table nobody is told what changed, and `/puzzle` carries on regardless.
try:
    changelog.init_db(db)
    puzzle_commands.version_db = db
    changelog_error = None
except sqlite3.Error as e:
    changelog_error = f"{type(e).__name__}: {e}"
    print(f"version announcements disabled: {changelog_error}", file=sys.stderr)

# archive_sync_window, owned by client/sync_window.py: when /archive sync
# last started, so a restart does not reopen its ten-minute window. Without
# the table the window still holds, but only until the next restart.
try:
    sync_window.init_db(db)
    archive_commands.sync_db = db
except sqlite3.Error as e:
    print(f"/archive sync window kept in memory only: {type(e).__name__}: {e}",
          file=sys.stderr)

# presence_samples, owned by client/presence_tracker.py. A schema mismatch
# disables presence tracking instead of taking the whole bot down with it --
# same policy as the recap and changelog tables above.
try:
    presence_tracker.init_db(db)
    presence_error = None
except sqlite3.Error as e:
    presence_error = f"{type(e).__name__}: {e}"
    print(f"presence tracking disabled: {presence_error}", file=sys.stderr)

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

# Discord creates this command itself when an application has Activities
# enabled -- it is the entry the app launcher shows. discord.py has no concept
# of it, so a plain tree.sync() leaves it out of the bulk payload, Discord reads
# that as a request to delete it, and rejects the whole update (error 50240).
ENTRY_POINT_COMMAND_TYPE = 4


async def _sync_global_commands():
    """
    Bulk-sync global commands, preserving Discord's own Entry Point command.

    Reaches into discord.py internals because 2.7.1 has no public way to do
    this: `_get_all_commands`, `get_translated_payload` and `to_dict` have all
    changed shape across the 2.x line (`to_dict` took no argument before 2.4),
    so a dependency bump can break this. Written against **discord.py 2.7.1**.
    """
    tree = bot.tree
    commands = tree._get_all_commands(guild=None)
    translator = tree.translator
    if translator:
        payload = [await c.get_translated_payload(tree, translator) for c in commands]
    else:
        payload = [c.to_dict(tree) for c in commands]

    existing = await bot.http.get_global_commands(bot.application_id)
    payload = payload + [c for c in existing
                         if c.get("type") == ENTRY_POINT_COMMAND_TYPE]
    await bot.http.bulk_upsert_global_commands(bot.application_id, payload=payload)


@bot.event
async def on_ready():
    # on_ready fires on every reconnect, and global command writes are rate
    # limited -- a failure here must not take down everything after it, which
    # includes starting the presence sampler and the daily recap.
    try:
        await _sync_global_commands()
    except Exception:
        log.exception("command sync failed; commands may be stale until restart")
    if presence_error is None and not presence_sample.is_running():
        presence_sample.start()
    # Off unless PUZZLE_RECAP=on: it pings every player it names, every day.
    if (recap_error is None and puzzle_recap.enabled()
            and not puzzle_recap_post.is_running()):
        puzzle_recap_post.start()
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


# ── Presence tracker ──────────────────────────────────────────────────────────
# Samples how many members are online in each guild on a fixed interval and
# graphs the history. Storage and rendering live in presence_tracker.py; this
# section is only the Discord surface (sampling loop + /activity commands).


def _count_presences(guild: discord.Guild) -> dict[str, int]:
    """Tally members by presence status for one guild."""
    counts = {status: 0 for status in presence_tracker.STATUSES}
    for member in guild.members:
        if member.bot:
            continue           # bots are always "online"; they'd flatten the graph
        status = member.status.name
        if status not in counts:
            # An untracked discord.Status (or a new one upstream): bucket it as
            # offline, but say so rather than silently deflating the active count.
            print(f"presence: unknown status {status!r} in guild {guild.id}",
                  file=sys.stderr)
            status = "offline"
        counts[status] += 1
    return counts


def _resolve_guild(raw: str) -> "discord.Guild | str":
    """Parse a guild-ID option into a Guild, or return an error message.

    Returns the message as a plain string rather than raising so the caller can
    reply with it directly -- every failure here is user input, not a fault.
    """
    text = raw.strip()
    if not text.isdigit():
        return (f"`{text[:32]}` is not a valid server ID. Right-click a server "
                "→ Copy Server ID (Developer Mode must be on).")
    guild = bot.get_guild(int(text))
    if guild is None:
        # Either a real server this bot was never added to, or a typo. The bot
        # cannot tell them apart, so the wording covers both.
        return (f"I'm not in a server with ID `{text}`, so I have no activity "
                "history for it.")
    return guild


@tasks.loop(minutes=PRESENCE_SAMPLE_MINUTES)
async def presence_sample():
    """Record one presence sample per guild.

    Each guild gets its own try: an unhandled exception would permanently stop
    the tasks.loop and silently end all tracking, and a guild that fails
    persistently must not starve the guilds after it in iteration order.
    record_sample commits per guild, so a failure here leaves earlier guilds'
    samples written -- there is nothing to roll back.
    """
    for guild in bot.guilds:
        try:
            presence_tracker.record_sample(db, guild.id, _count_presences(guild))
        except Exception as e:
            print(f"presence sample failed for guild {guild.id}: "
                  f"{type(e).__name__}: {e}", file=sys.stderr)


@presence_sample.before_loop
async def _presence_wait_ready():
    await bot.wait_until_ready()


# The activity owns the calendar, so the only reliable question is "what day
# is it now" — asked often enough that a restart at any hour still catches the
# turnover, and cheaply enough that asking costs nothing.
RECAP_POLL_MINUTES = 5
# The one place this bot pings on purpose. Users only, so a recap naming
# everyone who played can never reach @everyone through a display name.
#
# `replied_user=False` because a reply pings the author of what it replies to
# by default, and what this replies to is the bot's own announcement — so the
# default is a notification aimed at nobody. Stated rather than inherited: a
# live test showed the bot in the posted message's own mention list.
RECAP_MENTIONS = discord.AllowedMentions(
    everyone=False, roles=False, users=True, replied_user=False)


async def _post_recap(play: puzzle_recap.Play) -> None:
    """
    Reply to one server's announcement with how the day went.

    The board is fetched before the claim is taken, so an activity outage
    leaves the day owed and tries again on the next tick. The claim is taken
    before the message is sent, so a send that fails costs that server that
    day — which is the deliberate half of never posting twice.
    """
    payload = await puzzle_commands.recap_payload(play.guild_id, play.day)
    text = puzzle_recap.format_recap(payload)
    if not text:
        # Announced, and then nobody played it. Claim anyway, or every tick for
        # the rest of the day asks the same question and gets the same nothing.
        puzzle_recap.claim(db, play.guild_id, play.day)
        return
    if not puzzle_recap.claim(db, play.guild_id, play.day):
        return
    channel = bot.get_channel(play.channel_id) or await bot.fetch_channel(play.channel_id)
    message = await channel.fetch_message(play.message_id)
    await message.reply(text, allowed_mentions=RECAP_MENTIONS)


@tasks.loop(minutes=RECAP_POLL_MINUTES)
async def puzzle_recap_post():
    """Post yesterday's results, once per server, as a reply to its own play.

    Each server gets its own try for the same reason presence_sample does: an
    unhandled exception would permanently stop the tasks.loop, and a server
    whose channel was deleted must not starve the servers after it.
    """
    today = await puzzle_commands.current_day()
    if today is None:
        return
    yesterday = today - 1

    for play in puzzle_recap.pending(db, yesterday):
        try:
            await _post_recap(play)
        except Exception as e:
            print(f"recap failed for guild {play.guild_id} day {play.day}: "
                  f"{type(e).__name__}: {e}", file=sys.stderr)

    try:
        puzzle_recap.prune(db, yesterday - puzzle_recap.RETAIN_DAYS)
    except sqlite3.Error as e:
        print(f"recap prune failed: {type(e).__name__}: {e}", file=sys.stderr)


@puzzle_recap_post.before_loop
async def _recap_wait_ready():
    await bot.wait_until_ready()


activity = app_commands.Group(name="activity",
                              description="Server online-activity tracker")


@activity.command(name="graph",
                  description="Graph online users over time (default: 7 days).")
@app_commands.describe(
    days=f"Look-back window in days (default {PRESENCE_DAYS_DEFAULT})",
    breakdown="Split the line into online / idle / do-not-disturb",
    guild_id="Another server's ID (defaults to this server)",
)
async def activity_graph(
    interaction: discord.Interaction,
    days: app_commands.Range[int, 1, PRESENCE_DAYS_MAX] = PRESENCE_DAYS_DEFAULT,
    breakdown: bool = False,
    guild_id: str | None = None,
):
    # Snowflakes exceed the float53 range Discord's client uses for integer
    # options, so the ID arrives as a string and is parsed here.
    if guild_id is not None:
        target = _resolve_guild(guild_id)
        if isinstance(target, str):          # error message rather than a guild
            await interaction.response.send_message(target, ephemeral=True)
            return
    elif interaction.guild is None:
        await interaction.response.send_message(
            "Run this in a server, or pass `guild_id` to graph a specific one.",
            ephemeral=True)
        return
    else:
        target = interaction.guild

    # /activity now still works without the table (it reads live guild state),
    # so only the history path has to bail out.
    if presence_error is not None:
        await interaction.response.send_message(
            "Activity history is unavailable — presence tracking failed to "
            "start. Try `/activity now` for a live count.", ephemeral=True)
        return

    await interaction.response.defer(thinking=True)
    guild = target
    series = presence_tracker.fetch_series(db, guild.id, days)
    # A line needs at least two points to be a line. One sample renders as an
    # empty chart (and used to blow up the axis locator), so report the reading
    # as text instead of sending a blank image.
    if len(series) < presence_tracker.MIN_GRAPH_SAMPLES:
        counts = _count_presences(guild)
        active = sum(counts[s] for s in ("online", "idle", "dnd"))
        await interaction.followup.send(
            f"**{guild.name}** — not enough history to graph yet: "
            f"**{len(series)}** sample"
            f"{'' if len(series) == 1 else 's'} so far, need at least "
            f"{presence_tracker.MIN_GRAPH_SAMPLES}.\n"
            f"Right now: **{active}** members active. Samples are taken every "
            f"{PRESENCE_SAMPLE_MINUTES} minutes — check back shortly.",
            allowed_mentions=NO_MENTIONS)
        return

    # Rendering is CPU-bound matplotlib work; keep it off the event loop.
    loop = asyncio.get_running_loop()
    try:
        png = await loop.run_in_executor(
            None, presence_tracker.render_graph,
            series, days, guild.name, breakdown)
    except Exception as e:
        print(f"activity graph render failed: {type(e).__name__}: {e}",
              file=sys.stderr)
        await interaction.followup.send("Could not render the graph — try again.")
        return

    stats = presence_tracker.summarize(series)
    span = f"{days} day{'s' if days != 1 else ''}"
    header = (f"**{guild.name} — online users, last {span}**\n"
              f"now **{stats['current']}** · peak **{stats['peak']}** · "
              f"avg **{stats['average']:.1f}** · {stats['samples']:,} samples")
    await interaction.followup.send(
        header,
        file=discord.File(io.BytesIO(png), filename="activity.png"),
        allowed_mentions=NO_MENTIONS)


@activity.command(name="now",
                  description="Show the current online / idle / dnd counts.")
@app_commands.describe(guild_id="Another server's ID (defaults to this server)")
async def activity_now(interaction: discord.Interaction,
                       guild_id: str | None = None):
    if guild_id is not None:
        target = _resolve_guild(guild_id)
        if isinstance(target, str):
            await interaction.response.send_message(target, ephemeral=True)
            return
    elif interaction.guild is None:
        await interaction.response.send_message(
            "Run this in a server, or pass `guild_id` to check a specific one.",
            ephemeral=True)
        return
    else:
        target = interaction.guild

    counts = _count_presences(target)
    active = sum(counts[s] for s in ("online", "idle", "dnd"))
    total = active + counts["offline"]
    pct = (active / total * 100) if total else 0.0
    await interaction.response.send_message(
        f"**{target.name}** — **{active}** of {total} members active ({pct:.0f}%)\n"
        f"🟢 {counts['online']} online · 🟡 {counts['idle']} idle · "
        f"🔴 {counts['dnd']} dnd · ⚫ {counts['offline']} offline",
        allowed_mentions=NO_MENTIONS)


bot.tree.add_command(activity)
bot.tree.add_command(puzzle_command)
# Its own top-level command rather than `/puzzle report`: Discord will not
# let a command be both invocable and a group, and `/puzzle` is the one
# people already type. See report_commands.py's header.
bot.tree.add_command(report_commands.report_command)
# A group of its own rather than `/puzzle sync`, for the reason two lines up:
# `/puzzle` is the command people type, and making it a parent would rename it.
# `/archive` is a name nobody types, so the subcommands cost nothing and there
# is room beside `sync` for the status and publish this will want later. See
# archive_commands.py's header.
bot.tree.add_command(archive_commands.archive)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if not DISCORD_TOKEN:
        print("Error: DISCORD_TOKEN is not set.", file=sys.stderr)
        print(f"  Add DISCORD_TOKEN=your_token_here to {ROOT / '.env'}",
              file=sys.stderr)
        sys.exit(1)

    bot.run(DISCORD_TOKEN)