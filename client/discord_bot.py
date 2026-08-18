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

bennxt tracker — civil/mechanical internships AND new-grad roles in California,
screened for visa sponsorship with Gemini (replies are PUBLIC, not ephemeral):
    /bennxt roles [sponsorship] [region] [fit] [evidence]
                                             best matches: SoCal + resume fit
    /bennxt recent [days] [sponsorship] [region] [level] [company] [evidence]
                                             newest postings, most recent first
    /bennxt notify                           toggle new-role notices
    /bennxt notifylist                       show who is subscribed

Activity tracker (backed by presence_tracker.py; samples every 10 minutes):
    /activity graph [days] [breakdown] [guild_id]
                                           PNG graph of online users
                                           (defaults to the last 7 days)
    /activity now [guild_id]               current online/idle/dnd counts

Both accept an optional guild_id to inspect any server the bot is in; the
x-axis is labelled in Pacific time (PST/PDT).

Tetris Impostor party game (backed by impostor.py, impostor_game.py,
impostor_views.py and impostor_commands.py).
Everyone is DM'd a word; the impostor is DM'd a SIMILAR word from the same
group ("T-spin double" vs "T-spin triple") so they can bluff:
    /impostor start [pack] [impostors] [category] [decoy] [blind] [guessing]
                                           open a lobby, then Join / Deal.
                                           pack picks the category (tetris
                                           terms, openers, players, ...);
                                           decoy:false falls back to giving
                                           the impostor no word at all;
                                           blind:true does not tell them;
                                           guessing:true (default) puts a
                                           Guess button on the round message —
                                           the impostor picks the crew's word
                                           from a dropdown and wins outright
                                           if right, loses if wrong
    /impostor myword                       re-read your own role privately
    /impostor status                       who is in / is a round running
    /impostor reveal                       end the round, show word + impostors
    /impostor cancel                       scrap it without revealing
    /impostor words list|add|remove|deletepack
                                           maintain data/impostor_words.json
                                           (Manage Server; hand edits to the
                                           JSON are picked up automatically)

Requires the privileged Server Members and Presence intents to be enabled in
the Discord Developer Portal (Bot > Privileged Gateway Intents); without them
login fails with PrivilegedIntentsRequired.
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
import presence_tracker
from impostor_commands import impostor_group

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

# bennxt: civil/mechanical + new-grad + California + visa sponsorship.
# Public (non-ephemeral) by request, with its own opt-in notify list.
BENNXT_SWEEP_MINUTES = 180   # Gemini free tier — scan far less often than tech
BENNXT_MAX_ROLES = 25        # roles listed per command invocation
SPONSOR_LABEL = {"yes": "✅ sponsors", "likely": "🟢 sponsored before",
                 "unknown": "❔ not stated", "no": "🚫 no sponsorship"}
REGION_LABEL = {"socal": "📍 SoCal", "ca": "CA", "remote": "remote",
                "unknown": "location TBD"}
FIT_LABEL = {"strong": "🎯 strong resume fit", "possible": "🤔 possible fit",
             "weak": "⚠️ weak fit"}

# Presence tracker (/activity) — see client/presence_tracker.py.
PRESENCE_SAMPLE_MINUTES = presence_tracker.SAMPLE_MINUTES
PRESENCE_DAYS_DEFAULT   = presence_tracker.GRAPH_DAYS_DEFAULT
PRESENCE_DAYS_MAX       = presence_tracker.GRAPH_DAYS_MAX

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
# Presence tracking (/activity). Both are PRIVILEGED: they must also be
# toggled on under Bot > Privileged Gateway Intents in the Developer
# Portal, or login fails outright with a PrivilegedIntentsRequired error.
intents.members = True    # member list, so offline members are countable
intents.presences = True  # online/idle/dnd status per member

bot = commands.Bot(command_prefix="!", intents=intents)


# ── No link-preview embeds, anywhere ──────────────────────────────────────────
# Job listings carry apply/company URLs, and Discord would render a preview
# card per link — several per message, burying the text. Rather than passing
# suppress_embeds=True at ~30 call sites (and remembering it forever), patch
# the three send paths once so every message the bot sends defaults to it.
# Callers can still opt out explicitly with suppress_embeds=False.

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
# Filter prefs, added after intern_pings shipped: CREATE TABLE IF NOT EXISTS
# won't touch an existing table, so add the columns separately. NULL means "no
# preference" (match everything) for every one of them.
for _col, _decl in (("categories", "TEXT"),      # CSV of poller.CATEGORIES names
                    ("us_only", "INTEGER"),      # 1 = drop non-US roles
                    ("days", "INTEGER")):        # default look-back for `recent`
    try:
        db.execute(f"ALTER TABLE intern_pings ADD COLUMN {_col} {_decl}")
    except sqlite3.OperationalError:
        pass                                     # already added by a prior boot
db.commit()
db.execute("""
    CREATE TABLE IF NOT EXISTS intern_meta (
        key TEXT PRIMARY KEY,
        value REAL
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS bennxt_pings (
        user_id INTEGER PRIMARY KEY,
        channel_id INTEGER NOT NULL
    )
""")
db.commit()

# presence_samples, owned by client/presence_tracker.py. A schema mismatch
# disables presence tracking instead of taking the whole bot down with it --
# same policy as the internship tracker below.
try:
    presence_tracker.init_db(db)
    presence_error = None
except sqlite3.Error as e:
    presence_error = f"{type(e).__name__}: {e}"
    print(f"presence tracking disabled: {presence_error}", file=sys.stderr)

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
        # Say plainly at boot whether resume matching is on — otherwise a
        # missing PDF only shows up as an empty `fit:strong` much later.
        resume = poller.load_resume()
        print(f"bennxt resume: {'loaded' if resume else 'MISSING'} "
              f"({poller.RESUME_PATH})"
              + ("" if resume else " — /bennxt fit ratings disabled"))
        # Re-attach the digest button so notices posted before a restart stay
        # clickable (registering twice across reconnects is harmless).
        bot.add_view(InternshipDigestView())
        if not internship_sweep.is_running():
            internship_sweep.start()
        if not bennxt_sweep.is_running():
            bennxt_sweep.start()
    if presence_error is None and not presence_sample.is_running():
        presence_sample.start()
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


# poller.classify falls back to "other" when no CATEGORIES regex matches, so
# it's a real stored value and must be filterable even though it has no regex.
CATEGORY_NAMES = [name for name, _ in poller.CATEGORIES] + ["other"]


def _get_prefs(user_id: int) -> dict | None:
    """A subscriber's filters, or None if they aren't subscribed."""
    row = db.execute("SELECT categories, us_only, days FROM intern_pings "
                     "WHERE user_id=?", (user_id,)).fetchone()
    if row is None:
        return None
    cats, us_only, days = row
    return {"categories": [c for c in (cats or "").split(",") if c],
            "us_only": bool(us_only),
            "days": days or RECENT_DAYS_DEFAULT}


def _describe_prefs(prefs: dict) -> str:
    bits = [", ".join(prefs["categories"]) if prefs["categories"]
            else "all categories"]
    if prefs["us_only"]:
        bits.append("US/remote only")
    bits.append(f"{prefs['days']}d look-back")
    return " · ".join(bits)


def _write_prefs(user_id: int, channel_id: int, prefs: dict,
                 categories: str | None, us_only: bool | None,
                 days: int | None) -> dict:
    """Apply the given options over `prefs` and persist. Shared by `ping` and
    `filters` so the two can't drift apart."""
    if categories is not None:
        # "all" is the escape hatch back to unfiltered.
        prefs["categories"] = [] if categories == "all" else [categories]
    if us_only is not None:
        prefs["us_only"] = us_only
    if days is not None:
        prefs["days"] = days
    db.execute("INSERT OR REPLACE INTO intern_pings VALUES (?, ?, ?, ?, ?)",
               (user_id, channel_id, ",".join(prefs["categories"]),
                int(prefs["us_only"]), prefs["days"]))
    db.commit()
    return prefs


def _set_ping(user_id: int, channel_id: int, categories: str | None,
              us_only: bool | None, days: int | None) -> str:
    """Subscribe or update filters. A bare call (no filters) toggles off, so
    unsubscribing still works; passing any filter never unsubscribes, since
    "change my filters" and "turn this off" are different intents."""
    prefs = _get_prefs(user_id)
    given = [v for v in (categories, us_only, days) if v is not None]
    if prefs is not None and not given:
        db.execute("DELETE FROM intern_pings WHERE user_id=?", (user_id,))
        db.commit()
        return "Removed you from the internship notify list."

    if prefs is None:
        prefs = {"categories": [], "us_only": False, "days": RECENT_DAYS_DEFAULT}
    prefs = _write_prefs(user_id, channel_id, prefs, categories, us_only, days)
    summary = f"Filters: {_describe_prefs(prefs)}."
    return (f"You're on the internship notify list — I'll DM you new tech "
            f"internships that match (nothing is posted in the channel). "
            f"{summary} Make sure DMs from server members are enabled, or the "
            f"notice can't reach you. Run `/internships ping` with no options "
            f"to unsubscribe.")


def _update_filters(user_id: int, channel_id: int, categories: str | None,
                    us_only: bool | None, days: int | None) -> str:
    """`filters` only ever edits prefs — it can never unsubscribe, so a bare
    call just reports the current settings."""
    prefs = _get_prefs(user_id)
    if prefs is None:
        return ("You're not subscribed yet — run `/internships ping` first, "
                "then use this to change your filters.")
    given = [v for v in (categories, us_only, days) if v is not None]
    if not given:
        return (f"Your current filters: {_describe_prefs(prefs)}. Pass an "
                "option to change one.")
    prefs = _write_prefs(user_id, channel_id, prefs, categories, us_only, days)
    return f"Updated. Your filters: {_describe_prefs(prefs)}."


def _recent_internships(days: int, us_only: bool, categories: list[str] | None = None):
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
        if categories and cat not in categories:
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


async def _send_recent(send, days: int, us_only: bool,
                       categories: list[str] | None = None) -> None:
    """`send` must already be bound to ephemeral delivery — see _private."""
    days = max(1, min(days, poller.MAX_AGE_DAYS))
    roles = _recent_internships(days, us_only, categories)
    if not roles:
        extra = (f" matching {', '.join(categories)}" if categories else "")
        await send(content=f"No tech internships{extra} on record for the last "
                           f"{days} day(s). The tracker sweeps every "
                           f"{SWEEP_MINUTES} minutes — check back soon.")
        return
    scope = ", US/remote" if us_only else ""
    if categories:
        scope += ", " + "/".join(categories)
    header = f"**{len(roles)} recent tech internship roles** (last {days}d{scope})"
    if len(roles) > RECENT_MAX_ROLES:
        header += f" — showing the newest {RECENT_MAX_ROLES}"
    blocks = [_format_role(p, c, dupes, seen_at)
              for p, c, seen_at, dupes in roles[:RECENT_MAX_ROLES]]
    await send(content=header, allowed_mentions=NO_MENTIONS)
    for chunk in _split_blocks(blocks):
        await send(content=chunk, allowed_mentions=NO_MENTIONS)


def _format_bennxt(p, v, show_evidence: bool = False) -> str:
    """One listing block for a bennxt role, led by its sponsorship verdict."""
    status = SPONSOR_LABEL.get(v.get("sponsorship"), "❔ not stated")
    posted = f"posted {poller.age_str(p)} ago" if p.published else "date unknown"
    # resolved_location is Gemini's reading for postings whose location field
    # was blank or collapsed ("4 Locations").
    loc = (v.get("resolved_location") or p.location
           or REGION_LABEL.get(v.get("region"), "location not stated"))
    if v.get("resolved_location") and not (p.location or "").strip():
        loc = f"{loc} (from posting text)"
    if v.get("region") == "socal":
        loc = f"📍 {loc}"
    bits = [loc]
    if v.get("salary"):
        bits.append(v["salary"])
    bits.append(posted)
    head = status
    if v.get("fit"):
        head += " · " + FIT_LABEL[v["fit"]]
    block = (f"**{p.company}** — {p.title}\n"
             f"{head} · " + " · ".join(bits))
    h1b = v.get("h1b")
    if h1b:
        where = f"{h1b['ca']} in CA" if h1b.get("ca") else "none in CA"
        block += (f"\n_H-1B: {h1b['total']} certified filing(s) for similar "
                  f"roles in the last 2 years ({where})._")
    if v.get("fit_reason"):
        block += f"\n_{v['fit_reason'][:200]}_"
    if show_evidence and v.get("evidence"):
        ev = v["evidence"].replace("`", "'")[:180]
        block += f"\n> {ev}"
    links = []
    if p.url:
        links.append(f"[apply]({p.url})")
    if v.get("company_site"):
        # The employer's own site — for researching the company, and for
        # applying there directly when its careers page carries the role.
        links.append(f"[company site]({v['company_site']})")
    if links:
        block += "\n" + " · ".join(links)
    return block


# Latest bennxt scan, kept in memory: the scan costs Gemini calls, so commands
# read this rather than re-scanning per invocation.
_bennxt_cache: dict = {"at": 0.0, "roles": []}


# Single-flight: one scan at a time, process-wide. Without this, two people
# running /bennxt roles during a cold scan each start their OWN full scan —
# doubling ~1800 HTTP requests and ~122 Gemini calls for identical results.
# Late callers await the in-flight scan and watch its progress instead.
_bennxt_lock = asyncio.Lock()
# Progress of the scan currently running, so latecomers can render it too.
# `subs` holds callbacks belonging to each waiting interaction.
_bennxt_progress: dict = {"phase": None, "done": 0, "total": None,
                          "started": 0.0, "subs": []}


def _bennxt_scan_running() -> bool:
    return _bennxt_lock.locked()


async def _bennxt_roles(force: bool = False, on_progress=None):
    """Cached bennxt results, refreshed at most every BENNXT_SWEEP_MINUTES.

    on_progress: optional callable(phase, done, total) for live updates. It is
    registered for the duration of the call, so a caller that arrives while a
    scan is already running still sees that scan's progress.
    """
    def _fresh() -> bool:
        age = time.time() - _bennxt_cache["at"]
        return not (force or (not _bennxt_cache["roles"] and age > 60)
                    or age > BENNXT_SWEEP_MINUTES * 60)

    if _fresh():
        return _bennxt_cache["roles"]

    if on_progress:
        _bennxt_progress["subs"].append(on_progress)
        # A latecomer joins mid-scan, so replay the current state immediately
        # rather than leaving them on a blank message until the next tick.
        if _bennxt_scan_running() and _bennxt_progress["phase"]:
            try:
                on_progress(_bennxt_progress["phase"], _bennxt_progress["done"],
                            _bennxt_progress["total"])
            except Exception:
                pass
    try:
        async with _bennxt_lock:
            # Re-check inside the lock: while we waited, the scan we were
            # queued behind may have just filled the cache. Doing the work
            # again would spend a second scan's quota for nothing.
            if _fresh():
                return _bennxt_cache["roles"]

            def _fanout(phase, done, total):
                _bennxt_progress.update(phase=phase, done=done, total=total)
                for cb in list(_bennxt_progress["subs"]):
                    try:
                        cb(phase, done, total)
                    except Exception:
                        pass

            _bennxt_progress.update(phase=None, done=0, total=None,
                                    started=time.time())
            roles = await poller.bennxt_scan(pconn, verbose=True,
                                             on_progress=_fanout)
            _bennxt_cache.update(at=time.time(), roles=roles)
        return _bennxt_cache["roles"]
    finally:
        if on_progress and on_progress in _bennxt_progress["subs"]:
            _bennxt_progress["subs"].remove(on_progress)



# Live progress for long scans. The scan takes minutes on a cold cache, and a
# silent "thinking..." for that long is indistinguishable from a hung bot.
BENNXT_PROGRESS_EVERY = 3.0     # seconds between message edits (rate limits)
# Discord invalidates an interaction token 15 minutes after the command was
# invoked. Stop editing before that so a cold scan can't die on an expired
# token; the result is then delivered as a normal channel message instead.
BENNXT_TOKEN_TTL = 13 * 60

_PHASE_LABEL = {
    "boards":  "Polling job boards",
    "details": "Fetching descriptions",
    "sites":   "Looking up company sites",
    "llm":     "Checking sponsorship with Gemini",
    "done":    "Done",
}


def _bar(done: int, total, width: int = 10) -> str:
    if not total:
        return "▓" * width if done else "░" * width
    # Any real progress shows at least one block: round() renders 5/106 as an
    # empty bar, which reads as "stuck" during the slowest phase of the scan.
    # Likewise, only a genuinely finished phase gets a full bar.
    filled = max(0, min(width, round(width * done / total)))
    if done and filled == 0:
        filled = 1
    if filled == width and done < total:
        filled = width - 1
    return "▓" * filled + "░" * (width - filled)


class _ScanProgress:
    """Throttled progress display for one interaction.

    The scan calls update() thousands of times; this records state cheaply and
    lets a background task do the actual editing every few seconds, so message
    edits never gate the scan and never trip Discord's rate limits.
    """

    def __init__(self, interaction: discord.Interaction):
        self.interaction = interaction
        self.started = time.time()
        self.state = None            # (phase, done, total)
        self.dirty = False
        self._task = None
        self._stop = asyncio.Event()

    def update(self, phase, done, total):
        """Called from the scan. Must stay cheap and never block or raise."""
        self.state = (phase, done, total)
        self.dirty = True

    @staticmethod
    def _mmss(seconds: float) -> str:
        s = max(0, int(seconds))
        return f"{s // 60}m {s % 60:02d}s" if s >= 60 else f"{s}s"

    def _render(self) -> str:
        phase, done, total = self.state or ("boards", 0, None)
        clock = self._mmss(time.time() - self.started)
        label = _PHASE_LABEL.get(phase, phase)
        count = f"{done}/{total}" if total else str(done)
        pct = f" ({100 * done / total:.0f}%)" if total else ""
        line = f"{_bar(done, total)} {count}{pct}"
        note = ""
        if phase == "llm" and total:
            # The slowest phase by far and the one people wait on, so give a
            # real ETA instead of just a bar. Gemini calls are paced by the
            # RPM limiter, which makes remaining time genuinely predictable.
            left = total - done
            eta = self._mmss(left / max(1, poller.LLM_RPM) * 60)
            note = (f"\n*Gemini allows {poller.LLM_RPM} requests/min, so this "
                    f"phase takes a while — about {eta} left.*")
            if not _bennxt_cache["roles"]:
                note += ("\n*First scan after a restart or database reset, so "
                         "every posting is classified from scratch. Later "
                         "scans reuse these results and finish in seconds.*")
        return (f"⏳ **Scanning civil/mech California roles…**\n"
                f"{label} · {line} · {clock} elapsed{note}")

    async def _loop(self):
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(),
                                       timeout=BENNXT_PROGRESS_EVERY)
                return                      # stopped
            except asyncio.TimeoutError:
                pass
            if not self.dirty:
                continue
            if time.time() - self.started > BENNXT_TOKEN_TTL:
                return                      # token about to expire; stop editing
            self.dirty = False
            try:
                await self.interaction.edit_original_response(
                    content=self._render())
            except discord.HTTPException:
                # A failed progress edit must never affect the scan or the
                # final reply — the token may have expired or the message
                # been deleted.
                return

    def start(self):
        self._task = asyncio.create_task(self._loop())
        return self

    async def stop(self):
        self._stop.set()
        if self._task:
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def token_expired(self) -> bool:
        return time.time() - self.started > BENNXT_TOKEN_TTL


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

    batch.sort(key=lambda pc: -(pc[0].published or 0))
    _last_batch[:] = batch      # still what `/internships recent` fell back on
    # DM'd to each subscriber rather than posted in a channel: a channel message
    # is visible to everyone who can read the channel, and the ephemeral flag
    # exists only on interaction replies (which need a click), so a DM is the
    # only way a background sweep can reach subscribers without public noise.
    # Each subscriber's `/internships ping` filters are applied to the batch, so
    # the listing is built per-recipient rather than once.
    for uid in {uid for uid, _ in subs}:
        # One subscriber failing (left the server, DMs closed) must not stop the
        # other subscribers' notices or kill the loop.
        try:
            prefs = _get_prefs(uid)
            if prefs is None:
                continue                    # unsubscribed since `subs` was read
            mine = [(p, c) for p, c in batch
                    if (not prefs["categories"]
                        or c.get("category") in prefs["categories"])
                    and not (prefs["us_only"] and c.get("region") == "non-us")]
            if not mine:
                continue                    # nothing matched their filters
            n = len(mine)
            header = f"**{n} new tech internship posting{'s' if n != 1 else ''}**"
            blocks = [_format_role(p, c) for p, c in mine[:ANNOUNCE_MAX]]
            if n > ANNOUNCE_MAX:
                blocks.append(f"...and {n - ANNOUNCE_MAX} more — run "
                              "`/internships recent` for the full list.")
            user = bot.get_user(uid) or await bot.fetch_user(uid)
            await user.send(content=header, allowed_mentions=NO_MENTIONS)
            for chunk in _split_blocks(blocks):
                await user.send(content=chunk, allowed_mentions=NO_MENTIONS)
        except Exception as e:
            print(f"internship notice to user {uid} failed: "
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
    days="Look-back window in days (defaults to your /internships ping filters)",
    us_only="Only show US / remote roles",
    category="Only show one category of role",
)
@app_commands.choices(category=[
    app_commands.Choice(name=c, value=c) for c in CATEGORY_NAMES])
async def internships_recent_slash(
    interaction: discord.Interaction,
    days: app_commands.Range[int, 1, 30] | None = None,
    us_only: bool | None = None,
    category: app_commands.Choice[str] | None = None,
):
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    await interaction.response.defer(thinking=True, ephemeral=True)
    # Saved ping filters are the defaults; an option passed explicitly wins.
    prefs = _get_prefs(interaction.user.id) or {
        "categories": [], "us_only": False, "days": RECENT_DAYS_DEFAULT}
    cats = [category.value] if category else prefs["categories"]
    await _send_recent(_private(interaction),
                       prefs["days"] if days is None else days,
                       prefs["us_only"] if us_only is None else us_only,
                       cats)


@internships.command(
    name="ping",
    description="Subscribe to internship DMs, or set your filters.")
@app_commands.describe(
    category="Only get pinged for this category ('all' clears the filter)",
    us_only="Only get pinged for US / remote roles",
    days=f"Default look-back for /internships recent (default {RECENT_DAYS_DEFAULT})",
)
@app_commands.choices(category=[
    app_commands.Choice(name=c, value=c)
    for c in CATEGORY_NAMES + ["all"]])
async def internships_ping_slash(
    interaction: discord.Interaction,
    category: app_commands.Choice[str] | None = None,
    us_only: bool | None = None,
    days: app_commands.Range[int, 1, 30] | None = None,
):
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    await interaction.response.send_message(
        _set_ping(interaction.user.id, interaction.channel_id,
                  category.value if category else None, us_only, days),
        ephemeral=True)


@internships.command(name="help",
                     description="What the internship tracker does and how to use it.")
async def internships_help_slash(interaction: discord.Interaction):
    # Categories and defaults come from the live constants so this text can't
    # drift as the classifier or the sweep interval change.
    cats = ", ".join(f"`{c}`" for c in CATEGORY_NAMES)
    lines = [
        "**Internship tracker**",
        f"Sweeps job boards every {SWEEP_MINUTES} min for tech internships and "
        "DMs you the new ones. Every reply is private — nothing is posted in "
        "the channel.",
        "",
        "**Commands**",
        "· `/internships recent` — list what's been posted recently. "
        "Options: `days`, `us_only`, `category` (all optional; they default to "
        "your saved filters).",
        "· `/internships ping` — subscribe. Run it again with **no options** to "
        "unsubscribe. Pass options to subscribe and set filters at once.",
        "· `/internships myfilters` — show the filters you've set.",
        "· `/internships filters` — change a filter. Never unsubscribes you; "
        "with no options it just shows your current settings.",
        "· `/internships info <role>` — salary and description for one posting. "
        "Start typing a company or title and pick a suggestion.",
        "· `/internships pinglist` — who's subscribed, and their filters.",
        "",
        "**Filters**",
        f"· `category` — one of {cats}. Use `all` to clear it.",
        "· `us_only` — drop roles tagged non-US.",
        f"· `days` — default look-back for `recent` (default {RECENT_DAYS_DEFAULT}, max 30).",
        "",
        "Your filters do double duty: they decide which postings get DM'd to "
        "you, and they're the defaults for `/internships recent` — where any "
        "option you pass explicitly wins for that one call.",
        "",
        "**Heads up:** DMs from server members must be enabled or the notices "
        "can't reach you.",
    ]
    await interaction.response.send_message("\n".join(lines), ephemeral=True,
                                            allowed_mentions=NO_MENTIONS)


@internships.command(name="myfilters",
                     description="Show the internship filters you've set.")
async def internships_myfilters_slash(interaction: discord.Interaction):
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    prefs = _get_prefs(interaction.user.id)
    if prefs is None:
        msg = ("You're not subscribed to internship notices. `/internships "
               "ping` signs you up; until then `/internships recent` shows "
               "everything unfiltered.")
    else:
        msg = (f"**Your internship filters**\n"
               f"· Categories: "
               f"{', '.join(prefs['categories']) if prefs['categories'] else 'all'}\n"
               f"· US/remote only: {'yes' if prefs['us_only'] else 'no'}\n"
               f"· Default look-back: {prefs['days']}d\n"
               f"These filter your DM notices and are the defaults for "
               f"`/internships recent`. Change them with `/internships filters`.")
    await interaction.response.send_message(msg, ephemeral=True)


@internships.command(name="filters",
                     description="Update your internship filters.")
@app_commands.describe(
    category="Only get pinged for this category ('all' clears the filter)",
    us_only="Only get pinged for US / remote roles",
    days=f"Default look-back for /internships recent (default {RECENT_DAYS_DEFAULT})",
)
@app_commands.choices(category=[
    app_commands.Choice(name=c, value=c)
    for c in CATEGORY_NAMES + ["all"]])
async def internships_filters_slash(
    interaction: discord.Interaction,
    category: app_commands.Choice[str] | None = None,
    us_only: bool | None = None,
    days: app_commands.Range[int, 1, 30] | None = None,
):
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    await interaction.response.send_message(
        _update_filters(interaction.user.id, interaction.channel_id,
                        category.value if category else None, us_only, days),
        ephemeral=True)


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

    # Notices are DMs now, so the channel a user subscribed from no longer
    # affects delivery — list each subscriber with their filters instead.
    lines = [f"**{len(subs)} subscribed to internship notices**"]
    for uid, _cid in subs:
        prefs = _get_prefs(uid)
        lines.append(f"<@{uid}> — {_describe_prefs(prefs)}" if prefs
                     else f"<@{uid}>")

    # NO_MENTIONS renders the <@id>/<#id> chips without pinging anyone.
    chunks = _pack(lines, MAX_CHUNK, "\n")
    await interaction.response.send_message(chunks[0], ephemeral=True,
                                            allowed_mentions=NO_MENTIONS)
    send = _private(interaction)
    for chunk in chunks[1:]:
        await send(chunk)


bot.tree.add_command(internships)


# ── bennxt: civil/mechanical + California + visa sponsorship ──────────────────

bennxt = app_commands.Group(
    name="bennxt",
    description="Civil/mechanical internships & new-grad roles in California")


@bennxt.command(name="roles",
                description="Civil/mech CA roles, filtered by visa sponsorship.")
@app_commands.describe(
    sponsorship="Which sponsorship statuses to show (default: hides explicit no)",
    region="Where the role is (default: SoCal first, then rest of California)",
    fit="How well the role matches the resume (default: hides weak matches)",
    days="Only roles posted in the last N days (undated ones are still shown)",
    evidence="Show the quoted sponsorship language from each posting")
@app_commands.choices(
    sponsorship=[
        app_commands.Choice(name="Sponsors or not stated (default)", value="open"),
        app_commands.Choice(name="Known H-1B sponsors only", value="yes"),
        app_commands.Choice(name="Everything, including no-sponsorship", value="all"),
    ],
    region=[
        app_commands.Choice(name="SoCal first, then all CA (default)", value="all"),
        app_commands.Choice(name="SoCal only (Irvine / LA / OC / SD)", value="socal"),
    ],
    fit=[
        app_commands.Choice(name="Hide weak resume matches (default)", value="ok"),
        app_commands.Choice(name="Only strong resume matches", value="strong"),
        app_commands.Choice(name="Everything, regardless of fit", value="all"),
    ])
async def bennxt_roles_slash(
    interaction: discord.Interaction,
    sponsorship: app_commands.Choice[str] = None,
    region: app_commands.Choice[str] = None,
    fit: app_commands.Choice[str] = None,
    days: app_commands.Range[int, 1, 60] = None,
    evidence: bool = False,
):
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    mode = sponsorship.value if sponsorship else "open"
    # Public by design — bennxt replies are visible to the whole channel.
    await interaction.response.defer(thinking=True)
    # Only show progress when a scan will actually run; a warm cache returns
    # instantly and a progress bar would just flicker.
    progress = None
    if not _bennxt_cache["roles"] or _bennxt_scan_running():
        progress = _ScanProgress(interaction).start()
    try:
        roles = await _bennxt_roles(
            on_progress=progress.update if progress else None)
    except Exception as e:
        print(f"bennxt scan failed: {type(e).__name__}: {e}", file=sys.stderr)
        await interaction.followup.send(
            "The bennxt scan failed — try again in a few minutes.",
            allowed_mentions=NO_MENTIONS)
        return
    finally:
        if progress:
            await progress.stop()
    # A scan can outlive the 15-minute interaction token. If it did, followup
    # sends would fail, so reply in the channel instead of losing the result.
    send = interaction.followup.send
    if progress and progress.token_expired():
        chan = interaction.channel
        if chan is not None:
            async def send(content, **kw):
                return await chan.send(f"{interaction.user.mention} {content}"
                                       if content else content, **kw)
    elif progress:
        # The deferred message still shows the last progress frame. Overwrite
        # it with the header rather than leaving "Scanning…" above the results.
        async def send(content, **kw):
            nonlocal progress
            if progress is not None:
                progress = None
                try:
                    return await interaction.edit_original_response(
                        content=content,
                        allowed_mentions=kw.get("allowed_mentions"))
                except discord.HTTPException:
                    pass
            return await interaction.followup.send(content, **kw)

    keep = {"open": ("yes", "likely", "unknown"),
            "yes": ("yes", "likely"),
            "all": ("yes", "likely", "unknown", "no")}[mode]
    sel = [(p, v) for p, v in roles if v.get("sponsorship") in keep]
    if days:
        # Undated postings are KEPT, unlike in `recent`. 68% of the candidate
        # pool has no date at all (iCIMS sitemaps and some Workday feeds carry
        # none), so dropping them would silently hide most of the results and
        # read as "nothing was posted recently". They're counted and disclosed
        # below instead. Anything older than BENNXT_MAX_AGE_DAYS was already
        # excluded during the scan, so an undated role is at worst that old.
        cutoff = time.time() - days * 86400
        sel = [(p, v) for p, v in sel
               if not p.published or p.published >= cutoff]
    if region and region.value == "socal":
        sel = [(p, v) for p, v in sel if v.get("region") == "socal"]
    fit_mode = fit.value if fit else "ok"
    if fit_mode == "strong":
        sel = [(p, v) for p, v in sel if v.get("fit") == "strong"]
    elif fit_mode == "ok":
        # Unscored roles (no resume, or the LLM didn't answer) are kept.
        sel = [(p, v) for p, v in sel if v.get("fit") != "weak"]
    tally = {k: sum(1 for _, v in roles if v.get("sponsorship") == k)
             for k in ("yes", "likely", "unknown", "no")}
    socal_n = sum(1 for _, v in roles if v.get("region") == "socal")
    window = days or poller.BENNXT_MAX_AGE_DAYS
    if not sel:
        extra = (f" Nothing dated within {days} day(s) — try a larger `days`."
                 if days else "")
        await send(
            "No civil/mechanical California roles matched that filter right "
            f"now, among postings from the last {window} "
            f"days (last scan: ✅ {tally['yes']} sponsor · ❔ {tally['unknown']} "
            f"not stated · 🚫 {tally['no']} ruled out).{extra}",
            allowed_mentions=NO_MENTIONS)
        return

    scope = ("in SoCal (Irvine / LA / OC / SD)" if region
             and region.value == "socal" else "in California, SoCal first")
    strong_n = sum(1 for _, v in roles if v.get("fit") == "strong")
    header = (f"**{len(sel)} civil/mechanical roles {scope}** "
              f"(internships + new grad, posted in the last "
              f"{window} days)\n"
              f"Last scan: 📍 {socal_n} SoCal · ✅ {tally['yes']} sponsor · "
              f"🟢 {tally['likely']} sponsored before · "
              f"❔ {tally['unknown']} not stated · 🚫 {tally['no']} ruled out"
              + ("" if mode == "all" else " (hidden)")
              + (f" · 🎯 {strong_n} strong resume matches" if strong_n else ""))
    blocks = [_format_bennxt(p, v, evidence) for p, v in sel[:BENNXT_MAX_ROLES]]
    if len(sel) > BENNXT_MAX_ROLES:
        blocks.append(f"...and {len(sel) - BENNXT_MAX_ROLES} more.")
    note = ("*❔ = the posting never mentions work authorization; verify "
            "with the employer before applying.*")
    # Counted from the final selection, so the number matches what's shown.
    undated_kept = sum(1 for p, _ in sel if not p.published) if days else 0
    if undated_kept:
        # Say so plainly: these passed the filter by not having a date, not by
        # being recent. Silence here would overstate how fresh the list is.
        note += (f"\n*{undated_kept} of these carry no posting date (their "
                 f"job board doesn't publish one) and are shown regardless of "
                 f"`days`. They're at most {poller.BENNXT_MAX_AGE_DAYS} days "
                 f"old — use `/bennxt recent` for dated postings only.*")
    unscored = sum(1 for _, v in sel if not v.get("fit"))
    if unscored:
        # Two very different causes, two very different fixes — don't guess.
        if poller.load_resume() is None:
            note += (f"\n*No resume is loaded, so {unscored} role(s) have no "
                     f"fit rating and `fit:strong` matches nothing. Put a PDF "
                     f"at `{poller.RESUME_PATH}` (and `pip install pypdf`), "
                     "then restart the bot.*")
        else:
            # Local date, matching how the poller keys llm_usage; SQL
            # date('now') is UTC and reads the wrong row for part of each day.
            row = pconn.execute(
                "SELECT n FROM llm_usage WHERE day=?",
                (poller.datetime.now().strftime("%Y-%m-%d"),)).fetchone()
            spent = row[0] if row else 0
            cap = poller.total_rpd()   # whole chain, not one model's cap
            if spent >= cap:
                why = (f"the daily Gemini quota ({cap}/day across "
                       "all models) is used up; it resets at midnight Pacific")
            else:
                why = (f"the scan stopped early ({spent}/{cap} calls "
                       "used today) — usually a Gemini timeout or outage")
            note += (f"\n*{unscored} role(s) here have no resume-fit rating "
                     f"yet: {why}. They get scored on the next run.*")
    blocks.append(note)
    await send(header, allowed_mentions=NO_MENTIONS)
    for chunk in _split_blocks(blocks):
        await send(chunk, allowed_mentions=NO_MENTIONS)


@bennxt.command(name="recent",
                description="Newest civil/mech CA postings, most recent first.")
@app_commands.describe(
    days=f"Only postings from the last N days (default {RECENT_DAYS_DEFAULT})",
    sponsorship="Which sponsorship statuses to show (default: hides explicit no)",
    region="Where the role is (default: anywhere in California)",
    level="Internships, new-grad roles, or both",
    company="Only this employer (partial name is fine)",
    evidence="Show the quoted sponsorship language from each posting")
@app_commands.choices(
    sponsorship=[
        app_commands.Choice(name="Sponsors or not stated (default)", value="open"),
        app_commands.Choice(name="Known H-1B sponsors only", value="yes"),
        app_commands.Choice(name="Everything, including no-sponsorship", value="all"),
    ],
    region=[
        app_commands.Choice(name="Anywhere in California (default)", value="all"),
        app_commands.Choice(name="SoCal only (Irvine / LA / OC / SD)", value="socal"),
    ],
    level=[
        app_commands.Choice(name="Internships and new grad (default)", value="all"),
        app_commands.Choice(name="Internships only", value="intern"),
        app_commands.Choice(name="New grad / entry level only", value="newgrad"),
    ])
async def bennxt_recent_slash(
    interaction: discord.Interaction,
    days: app_commands.Range[int, 1, 60] = RECENT_DAYS_DEFAULT,
    sponsorship: app_commands.Choice[str] = None,
    region: app_commands.Choice[str] = None,
    level: app_commands.Choice[str] = None,
    company: str = None,
    evidence: bool = False,
):
    """Strictly newest-first, unlike `roles` which ranks SoCal + resume fit."""
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    await interaction.response.defer(thinking=True)
    try:
        roles = await _bennxt_roles()
    except Exception as e:
        print(f"bennxt scan failed: {type(e).__name__}: {e}", file=sys.stderr)
        await interaction.followup.send(
            "The bennxt scan failed — try again in a few minutes.",
            allowed_mentions=NO_MENTIONS)
        return

    cutoff = time.time() - days * 86400
    keep = {"open": ("yes", "likely", "unknown"),
            "yes": ("yes", "likely"),
            "all": ("yes", "likely", "unknown", "no")}[
                sponsorship.value if sponsorship else "open"]

    sel = [(p, v) for p, v in roles
           if v.get("sponsorship") in keep
           and (p.published or 0) >= cutoff]
    if region and region.value == "socal":
        sel = [(p, v) for p, v in sel if v.get("region") == "socal"]
    unrated_level = 0
    if level and level.value != "all":
        # The LLM's level verdict when we have one, else the title heuristic.
        # Most postings have neither (the scan only scores what fits its
        # budget), so this filter is deliberately strict — and we report how
        # many were set aside rather than pretending they didn't match.
        want = level.value
        def _lvl(p, v):
            return v.get("level") or (
                "intern" if poller.bennxt_level_from_title(p.title) == "early"
                else None)
        unrated_level = sum(1 for p, v in sel if _lvl(p, v) is None)
        sel = [(p, v) for p, v in sel if _lvl(p, v) == want]
    if company:
        needle = company.lower().strip()
        sel = [(p, v) for p, v in sel if needle in (p.company or "").lower()]

    # Newest first — the whole point of this command.
    sel.sort(key=lambda pv: -(pv[0].published or 0))

    if not sel:
        await interaction.followup.send(
            f"No civil/mechanical California postings in the last {days} day(s) "
            "matched those filters. Try a longer window or `/bennxt roles`.",
            allowed_mentions=NO_MENTIONS)
        return

    scope = []
    if region and region.value == "socal":
        scope.append("SoCal")
    if level and level.value != "all":
        scope.append("internships" if level.value == "intern" else "new grad")
    if company:
        scope.append(f"company ~ {company}")
    suffix = f" · {' · '.join(scope)}" if scope else ""
    header = (f"**{len(sel)} civil/mechanical posting"
              f"{'s' if len(sel) != 1 else ''} from the last {days} days** "
              f"(newest first{suffix})")
    blocks = [_format_bennxt(p, v, evidence) for p, v in sel[:BENNXT_MAX_ROLES]]
    if len(sel) > BENNXT_MAX_ROLES:
        blocks.append(f"...and {len(sel) - BENNXT_MAX_ROLES} more — narrow the "
                      "window with `days:` or filter by `company:`.")
    note = ("*❔ = the posting never mentions work authorization; verify "
            "with the employer before applying.*")
    if unrated_level:
        note += (f"\n*{unrated_level} posting(s) in this window have no "
                 "intern/new-grad rating yet and are hidden by the `level` "
                 "filter — drop it to see them.*")
    blocks.append(note)
    await interaction.followup.send(header, allowed_mentions=NO_MENTIONS)
    for chunk in _split_blocks(blocks):
        await interaction.followup.send(chunk, allowed_mentions=NO_MENTIONS)


@bennxt_recent_slash.autocomplete("company")
async def bennxt_company_autocomplete(interaction: discord.Interaction,
                                      current: str):
    """Suggest employers that actually have postings in the current scan."""
    if pconn is None or not _bennxt_cache["roles"]:
        return []
    cur = current.lower().strip()
    names = sorted({p.company for p, _ in _bennxt_cache["roles"] if p.company})
    return [app_commands.Choice(name=n[:100], value=n[:100])
            for n in names if cur in n.lower()][:25]


@bennxt.command(name="notify",
                description="Toggle notices for new civil/mech CA roles.")
async def bennxt_notify_slash(interaction: discord.Interaction):
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    uid, cid = interaction.user.id, interaction.channel_id
    if db.execute("SELECT 1 FROM bennxt_pings WHERE user_id=?", (uid,)).fetchone():
        db.execute("DELETE FROM bennxt_pings WHERE user_id=?", (uid,))
        db.commit()
        msg = "Removed you from the bennxt notify list."
    else:
        db.execute("INSERT INTO bennxt_pings VALUES (?, ?)", (uid, cid))
        db.commit()
        msg = ("Added you to the bennxt notify list — new civil/mechanical "
               "California roles are posted in this channel. Run the command "
               "again to unsubscribe.")
    await interaction.response.send_message(msg, ephemeral=True)


@bennxt.command(name="notifylist",
                description="Show who is subscribed to bennxt notices.")
async def bennxt_notifylist_slash(interaction: discord.Interaction):
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    subs = db.execute("SELECT user_id, channel_id FROM bennxt_pings").fetchall()
    if not subs:
        await interaction.response.send_message(
            "Nobody is subscribed yet — sign up with `/bennxt notify`.",
            allowed_mentions=NO_MENTIONS)
        return

    by_channel: dict[int, list[int]] = {}
    for uid, cid in subs:
        by_channel.setdefault(cid, []).append(uid)

    lines = [f"**{len(subs)} subscribed to bennxt notices**"]
    for cid, uids in sorted(by_channel.items()):
        lines.append(f"<#{cid}>: " + " ".join(f"<@{u}>" for u in uids))

    # NO_MENTIONS renders the name chips without pinging anyone. Public, like
    # the rest of /bennxt.
    chunks = _pack(lines, MAX_CHUNK, "\n")
    await interaction.response.send_message(chunks[0],
                                            allowed_mentions=NO_MENTIONS)
    for chunk in chunks[1:]:
        await interaction.followup.send(chunk, allowed_mentions=NO_MENTIONS)


def _human_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:,.1f} {unit}"
        n /= 1024


def _db_size(path: Path) -> str:
    """Size of a sqlite database including its -wal/-shm sidecars, which can
    hold megabytes of not-yet-checkpointed data."""
    total = 0
    for suffix in ("", "-wal", "-shm"):
        f = Path(str(path) + suffix)
        if f.exists():
            total += f.stat().st_size
    return _human_bytes(total) if total else "missing"


def _ago(ts: float) -> str:
    if not ts:
        return "never"
    d = max(0, time.time() - ts)
    if d < 90:
        return f"{d:.0f}s ago"
    if d < 5400:
        return f"{d / 60:.0f}m ago"
    if d < 172800:
        return f"{d / 3600:.1f}h ago"
    return f"{d / 86400:.1f}d ago"


@bennxt.command(name="debug",
                description="Scan stats, database size, and Gemini quota usage.")
async def bennxt_debug_slash(interaction: discord.Interaction):
    """Diagnostics for the bennxt pipeline.

    Deliberately read-only: it never triggers a scan. A debug command that
    spent 90 seconds and a chunk of the daily Gemini quota just to report
    quota usage would change the very numbers it exists to report.
    """
    if pconn is None:
        await interaction.response.send_message(_tracker_disabled(), ephemeral=True)
        return
    await interaction.response.defer(thinking=True)

    L = []

    # ── Gemini quota. Per-MODEL daily caps, which is why the fallback chain
    # exists — each model carries its own budget.
    # The poller keys llm_usage by LOCAL date; SQL date('now') is UTC and
    # would read the wrong row for part of each day.
    today = poller.datetime.now().strftime("%Y-%m-%d")
    row = pconn.execute(
        "SELECT n, COALESCE(prompt_tokens,0), COALESCE(output_tokens,0) "
        "FROM llm_usage WHERE day=?", (today,)).fetchone()
    used, ptok, otok = row if row else (0, 0, 0)
    # llm_usage counts calls across every model, so compare against the whole
    # chain's budget, not one model's per-model cap.
    cap = poller.total_rpd()
    pct = 100 * used / cap if cap else 0
    bar = "█" * int(pct // 10) + "░" * (10 - int(pct // 10))
    L.append("**Gemini quota (today)**")
    L.append(f"`{bar}` {used}/{cap} requests ({pct:.0f}%) across the model "
             f"chain · currently on `{poller.GEMINI_MODEL}`")
    if ptok or otok:
        L.append(f"tokens: {ptok:,} in · {otok:,} out · {ptok + otok:,} total")
    else:
        # Distinguishes "no calls yet" from "this build predates the counter".
        L.append("tokens: not recorded yet (counted from the next Gemini call)")
    exhausted = [m for m, day in poller._MODEL_EXHAUSTED.items() if day == today]
    chain = [poller.GEMINI_MODEL] + poller.GEMINI_FALLBACK_MODELS
    L.append("models: " + " → ".join(
        f"~~{m}~~" if m in exhausted else m for m in chain))
    if exhausted:
        L.append(f"*{len(exhausted)} model(s) hit their daily cap; "
                 "each resets at midnight Pacific.*")
    L.append(f"limits: {poller.LLM_RPM} req/min · {poller.LLM_TPM:,} tok/min · "
             f"{poller.LLM_RPD} req/day per model "
             f"({len(chain)} models = {cap} total)")

    # 7-day request history, so a quota surprise has context.
    hist = pconn.execute(
        "SELECT day, n FROM llm_usage ORDER BY day DESC LIMIT 7").fetchall()
    if len(hist) > 1:
        L.append("last 7 days: " + " · ".join(f"{d[5:]} {n}" for d, n in hist))

    # ── Last scan. In-memory, so it describes THIS process only.
    s = poller.BENNXT_LAST_SCAN
    L.append("")
    L.append("**Last bennxt scan**")
    if not s:
        L.append(f"No scan since the bot started. The sweep runs every "
                 f"{BENNXT_SWEEP_MINUTES}m — run `/bennxt roles` to force one.")
    else:
        L.append(f"{_ago(s.get('started'))} · took {s.get('duration', 0):.0f}s "
                 f"· cached for {BENNXT_SWEEP_MINUTES}m")
        L.append(f"boards: {s.get('boards_ok', 0)}/{s.get('boards_total', 0)} ok"
                 f" · {s.get('boards_error', 0)} errored"
                 f" · {s.get('boards_unchanged', 0)} unchanged (304)")
        # The funnel — where postings are actually lost.
        L.append("```")
        L.append(f"{s.get('postings', 0):>6}  scanned from all boards")
        L.append(f"{s.get('prefiltered', 0):>6}  pass civil/mech + CA prefilter")
        if s.get("stale_dropped"):
            L.append(f"{-s['stale_dropped']:>6}  older than {s.get('max_age')}d")
        if s.get("capped"):
            L.append(f"{-s['capped']:>6}  over the {s.get('max_details')} "
                     f"detail-fetch cap")
        L.append(f"{s.get('detailed', 0):>6}  descriptions fetched")
        if s.get("yoe_dropped"):
            L.append(f"{-s['yoe_dropped']:>6}  demand too many years experience")
        L.append(f"{s.get('with_description', 0):>6}  had usable text "
                 f"(-> sent to Gemini)")
        L.append(f"{s.get('results', 0):>6}  final roles")
        L.append("```")
        if s.get("by_region"):
            L.append("candidates by region: " + " · ".join(
                f"{k}={v}" for k, v in sorted(s["by_region"].items())))
        if s.get("sponsorship"):
            L.append("sponsorship: " + " · ".join(
                f"{SPONSOR_LABEL.get(k, k)} {v}"
                for k, v in sorted(s["sponsorship"].items())))
        if s.get("fit"):
            L.append("resume fit: " + " · ".join(
                f"{k}={v}" for k, v in sorted(s["fit"].items())))
        # The single most useful number for "why am I missing roles?".
        if s.get("capped"):
            L.append(f"⚠️ **{s['capped']} candidates went unchecked** "
                     f"({s.get('capped_early', 0)} explicitly intern/new-grad). "
                     f"Raise `BENNXT_MAX_DETAILS` (now {s.get('max_details')}) "
                     "to cover more.")

    # ── Databases.
    L.append("")
    L.append("**Databases**")
    seen_n = pconn.execute("SELECT COUNT(*) FROM seen").fetchone()[0]
    post_n = pconn.execute("SELECT COUNT(*) FROM postings").fetchone()[0]
    cache_n = pconn.execute("SELECT COUNT(*) FROM llm_cache").fetchone()[0]
    L.append(f"`postings.db` {_db_size(poller.DB_PATH)} — {post_n:,} postings · "
             f"{seen_n:,} seen (dedup ledger) · {cache_n:,} cached verdicts")
    pings = db.execute("SELECT COUNT(*) FROM intern_pings").fetchone()[0]
    bpings = db.execute("SELECT COUNT(*) FROM bennxt_pings").fetchone()[0]
    L.append(f"`stats.db` {_db_size(ROOT / 'stats.db')} — {pings} internship "
             f"subscriber(s) · {bpings} bennxt subscriber(s)")

    # Sweep health from the tech poller, which shares the same database.
    sw = pconn.execute("SELECT started, duration, errors, new_rows FROM sweeps "
                       "ORDER BY started DESC LIMIT 1").fetchone()
    if sw:
        L.append(f"last tech sweep: {_ago(sw[0])} · {sw[1]:.0f}s · "
                 f"{sw[2]} errors · {sw[3]} new")

    # ── Config that changes what gets found.
    L.append("")
    L.append("**Config**")
    resume = poller.load_resume()
    L.append(f"resume: " + (f"loaded, {len(resume):,} chars" if resume else
                            f"**not loaded** — no fit ratings "
                            f"(`{poller.RESUME_PATH}`, needs `pypdf`)"))
    try:
        sponsors = poller.load_h1b_sponsors()
        L.append(f"H-1B sponsor list: {len(sponsors):,} companies")
    except Exception:
        L.append("H-1B sponsor list: unavailable")
    L.append(f"boards: {len(poller.BENNXT_BOARDS)} · "
             f"max age {poller.BENNXT_MAX_AGE_DAYS}d · "
             f"detail cap {poller.BENNXT_MAX_DETAILS} · "
             f"cache {len(_bennxt_cache['roles'])} roles "
             f"({_ago(_bennxt_cache['at'])})")

    for chunk in _pack(L, MAX_CHUNK, "\n"):
        await interaction.followup.send(chunk, allowed_mentions=NO_MENTIONS)


bot.tree.add_command(bennxt)


_bennxt_announced: set = set()   # (platform, external_id) already posted


@tasks.loop(minutes=BENNXT_SWEEP_MINUTES)
async def bennxt_sweep():
    """Scan and post genuinely-new civil/mech CA roles to subscribed channels.

    Public messages (per request), no mentions. Runs far less often than the
    tech sweep because every scan spends Gemini calls on the free tier.
    """
    try:
        roles = await _bennxt_roles(force=True)
        subs = db.execute("SELECT user_id, channel_id FROM bennxt_pings").fetchall()
    except Exception as e:
        pconn.rollback()
        print(f"bennxt sweep failed: {type(e).__name__}: {e}", file=sys.stderr)
        return

    first_run = not _bennxt_announced
    fresh = [(p, v) for p, v in roles
             if (p.platform, p.external_id) not in _bennxt_announced
             and v.get("sponsorship") in ("yes", "unknown")]
    _bennxt_announced.update((p.platform, p.external_id) for p, _ in roles)
    # First run seeds the set silently, exactly like the tech tracker.
    if first_run or not fresh or not subs:
        return

    by_channel: dict[int, list[int]] = {}
    for uid, cid in subs:
        by_channel.setdefault(cid, []).append(uid)
    n = len(fresh)
    header = (f"**{n} new civil/mechanical role{'s' if n != 1 else ''} in "
              f"California** — {len(subs)} subscribed")
    blocks = [_format_bennxt(p, v) for p, v in fresh[:ANNOUNCE_MAX]]
    if n > ANNOUNCE_MAX:
        blocks.append(f"...and {n - ANNOUNCE_MAX} more — run `/bennxt roles`.")
    for cid in by_channel:
        try:
            channel = bot.get_channel(cid) or await bot.fetch_channel(cid)
            await channel.send(header, allowed_mentions=NO_MENTIONS)
            for chunk in _split_blocks(blocks):
                await channel.send(chunk, allowed_mentions=NO_MENTIONS)
        except Exception as e:
            print(f"bennxt notice to channel {cid} failed: "
                  f"{type(e).__name__}: {e}", file=sys.stderr)


@bennxt_sweep.before_loop
async def _bennxt_wait_ready():
    await bot.wait_until_ready()



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
bot.tree.add_command(impostor_group)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if not DISCORD_TOKEN:
        print("Error: DISCORD_TOKEN is not set.", file=sys.stderr)
        print(f"  Add DISCORD_TOKEN=your_token_here to {ROOT / '.env'}",
              file=sys.stderr)
        sys.exit(1)

    bot.run(DISCORD_TOKEN)