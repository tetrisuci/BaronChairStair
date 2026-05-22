"""
discord_bot.py
~~~~~~~~~~~~~~
Discord bot that parses TETR.IO replays and returns top attack burst highlights.

Setup:
    pip install discord.py

    Set your bot token:
        export DISCORD_TOKEN=your_token_here

Usage (slash command):
    /highlights top_x:5               (attach a .ttrm file)

Usage (prefix command):
    !highlights 5                      (attach a .ttrm file)
    !highlights                        (defaults to top 3)

The bot responds with the top X attack burst highlights for each player,
formatted in a monospace code block so the boards render correctly.
"""

import os
import sys
import asyncio
import io
import sqlite3
from contextlib import redirect_stdout
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands

sys.path.insert(0, str(Path(__file__).parent))

from teto_client import TetoClient, TetoError
from build_snapshots import build_rounds
from render import top_attack_bursts


# ── Config ────────────────────────────────────────────────────────────────────

DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN")
SERVER_DIR    = Path(__file__).parent.parent / "server"

# Discord's hard limit is 2000 chars per message; we leave a buffer for the
# code-fence markers and any surrounding text.
MAX_CHUNK = 1850
TOP_X_MAX = 10
TOP_X_DEFAULT = 3


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


def _split_into_code_blocks(text: str, limit: int = MAX_CHUNK) -> list[str]:
    """
    Wrap text in ``` code blocks and split at line boundaries so each chunk
    fits within Discord's character limit. Boards stay intact because we only
    ever split between lines, never mid-line.
    """
    fence = "```\n"
    close = "\n```"
    usable = limit - len(fence) - len(close)

    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for line in text.splitlines():
        line_len = len(line) + 1  # +1 for the newline
        if current_len + line_len > usable and current:
            chunks.append(fence + "\n".join(current) + close)
            current = []
            current_len = 0
        current.append(line)
        current_len += line_len

    if current:
        chunks.append(fence + "\n".join(current) + close)

    return chunks or [fence + "(no highlights found)" + close]


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

db = sqlite3.connect("stats.db")

TRACKED_STICKER_ID = 1485928821038383314

db.execute("""
    CREATE TABLE IF NOT EXISTS sticker_stats (
        user_id INTEGER PRIMARY KEY,
        count INTEGER DEFAULT 0
    )
""")
db.commit()

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
        user = bot.get_user(user_id) or f"User {user_id}"
        lines.append(f"{i}. {user} — {count} time(s)")

    await ctx.send("**Sticker Leaderboard**\n" + "\n".join(lines))

@bot.event
async def on_ready():
    await bot.tree.sync()
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


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if not DISCORD_TOKEN:
        print("Error: DISCORD_TOKEN environment variable is not set.", file=sys.stderr)
        print("  export DISCORD_TOKEN=your_token_here", file=sys.stderr)
        sys.exit(1)

    bot.run(DISCORD_TOKEN)