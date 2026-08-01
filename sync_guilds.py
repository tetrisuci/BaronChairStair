#!/usr/bin/env python3
"""One-off tool: push the bot's slash commands into specific guilds — instant,
no waiting for global propagation.

    python sync_guilds.py SERVER_ID [SERVER_ID ...]          # copy + sync
    python sync_guilds.py --clear SERVER_ID [SERVER_ID ...]  # remove guild copies

Use --clear once the global commands have propagated, so the picker doesn't
show each command twice (guild copy + global copy). Safe to run while the
pm2/production bot is online; this logs in briefly and exits.
"""
import importlib.util
import sys
from pathlib import Path

import discord

# Load the real bot module so the command tree (and .env token) come from the
# single source of truth in client/discord_bot.py.
spec = importlib.util.spec_from_file_location(
    "discord_bot", Path(__file__).parent / "client" / "discord_bot.py")
m = importlib.util.module_from_spec(spec)
sys.modules["discord_bot"] = m
spec.loader.exec_module(m)

args = sys.argv[1:]
clear = "--clear" in args
guild_ids = [a for a in args if a != "--clear"]
if not guild_ids or not all(a.isdigit() for a in guild_ids):
    print(__doc__.strip(), file=sys.stderr)
    sys.exit(2)
if not m.DISCORD_TOKEN:
    print("DISCORD_TOKEN is not set — put it in .env at the repo root.",
          file=sys.stderr)
    sys.exit(1)


@m.bot.event
async def on_ready():
    try:
        for gid in guild_ids:
            guild = discord.Object(id=int(gid))
            if clear:
                m.bot.tree.clear_commands(guild=guild)
            else:
                m.bot.tree.copy_global_to(guild=guild)
            cmds = await m.bot.tree.sync(guild=guild)
            verb = "cleared" if clear else "synced"
            print(f"{verb} guild {gid}: {[c.name for c in cmds] or 'no commands'}")
    finally:
        await m.bot.close()


m.bot.run(m.DISCORD_TOKEN)
