#!/usr/bin/env python3
"""Diagnose duplicate slash commands: list every place this bot has registered
commands, so you can see whether a guild copy is shadowing the global one.

    python check_dupes.py                 # uses DISCORD_TOKEN from .env
    DISCORD_TOKEN=xxx python check_dupes.py

Discord shows one picker entry per registration. The same command registered
BOTH globally and in a guild therefore appears twice, under the same app name —
that is what this script detects. Clear the guild copies with:

    python sync_guilds.py --clear SERVER_ID
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

env_path = Path(__file__).parent / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

TOKEN = os.environ.get("DISCORD_TOKEN", "").strip()
if not TOKEN:
    sys.exit("DISCORD_TOKEN is not set — put it in .env at the repo root.")

# Discord's edge blocks requests without a real User-Agent (Cloudflare 1010).
HEADERS = {"Authorization": f"Bot {TOKEN}",
           "User-Agent": "DiscordBot (https://github.com/local, 1.0)"}


def get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def subnames(cmd):
    """Subcommand names, so `internships` shows what it actually contains."""
    return [o["name"] for o in cmd.get("options", []) if o["type"] in (1, 2)]


try:
    app = get("https://discord.com/api/v10/oauth2/applications/@me")
except urllib.error.HTTPError as e:
    sys.exit(f"Discord rejected the token ({e.code}). Is DISCORD_TOKEN the "
             "bot you actually see in the server?")

print(f"app: {app['name']}  (id {app['id']})\n")

seen: dict[str, list[str]] = {}

globals_ = get(f"https://discord.com/api/v10/applications/{app['id']}/commands")
print(f"GLOBAL commands ({len(globals_)}):")
for c in sorted(globals_, key=lambda c: c["name"]):
    print(f"  /{c['name']}  subs={subnames(c)}")
    seen.setdefault(c["name"], []).append("global")
if not globals_:
    print("  (none)")

for guild in get("https://discord.com/api/v10/users/@me/guilds"):
    cmds = get(f"https://discord.com/api/v10/applications/{app['id']}"
               f"/guilds/{guild['id']}/commands")
    label = f"{guild['name']} ({guild['id']})"
    print(f"\nGUILD {label} — {len(cmds)} command(s):")
    for c in sorted(cmds, key=lambda c: c["name"]):
        print(f"  /{c['name']}  subs={subnames(c)}")
        seen.setdefault(c["name"], []).append(label)
    if not cmds:
        print("  (none)")

dupes = {n: where for n, where in seen.items() if len(where) > 1}
print("\n" + "=" * 60)
if dupes:
    print("DUPLICATES — each of these is registered in more than one place:")
    for name, where in sorted(dupes.items()):
        print(f"  /{name}: {', '.join(where)}")
    guild_ids = {w.split("(")[-1].rstrip(")")
                 for where in dupes.values() for w in where if w != "global"}
    print("\nFix — drop the guild copies and keep the global ones:")
    for gid in sorted(guild_ids):
        print(f"  python sync_guilds.py --clear {gid}")
    print("\n(Global commands can take up to an hour to propagate; the guild "
          "copies disappear immediately.)")
else:
    print("No duplicates for THIS app. If the picker still shows each command "
          "twice, a second bot application is in the server registering the "
          "same commands — check the app name on the right of each picker row, "
          "and run this script with that bot's token.")
