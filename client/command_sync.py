"""
command_sync.py
~~~~~~~~~~~~~~~
Write the global slash commands to Discord only when they have changed.

`on_ready` fires on every start **and on every reconnect** — a gateway blip
is enough — and it used to read the global commands back and bulk-overwrite
them each time. That is two rate-limited calls on every restart and every
reconnect, a slower boot, and a propagation flicker in every server, all to
write a tree identical to the one already there.

So the bot hashes the payload it would send and keeps the hash in
`stats.db`, under the application's id. When the stored hash matches, it
skips the read and the write entirely, which makes a reconnect free and a
restart one Discord login shorter. When the hash differs or is missing, it
syncs as before and stores the new hash — after the write succeeds, never
before, so a failed sync is retried at the next ready.

What a hash cannot see is Discord's side changing under it: somebody running
another copy of this application with a different tree, or deleting commands
in the developer portal. `FORCE_COMMAND_SYNC=1` syncs regardless, for that
case. A new or changed command still appears on the restart that ships it,
because the hash moves with it; `DEPLOY.md`'s "a new slash command needs a
restart" stays true.

Stdlib only, and no Discord types in the signatures, so it can be tested on
a box with no discord.py installed — the same reason `sync_window.py` is.
"""

import hashlib
import json
import sqlite3
import sys
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence

#: Discord creates this command itself when an application has Activities
#: enabled — it is the entry the app launcher shows. discord.py has no concept
#: of it, so a plain tree.sync() leaves it out of the bulk payload, Discord
#: reads that as a request to delete it, and rejects the whole update (error
#: 50240). It is carried over from what Discord holds, and kept out of the
#: hash: it is Discord's, not this bot's, and the bot never changes it.
ENTRY_POINT_COMMAND_TYPE = 4

#: Set to sync on the next ready even when the tree has not changed.
FORCE_ENV = "FORCE_COMMAND_SYNC"
_ON = {"1", "true", "yes", "on"}

Payload = Sequence[Mapping]


def init_db(db: sqlite3.Connection) -> None:
    """
    Creates the table. Called once at boot, like `sync_window.init_db`.

    One row per scope — `global:<application id>` — holding the hash of the
    last tree written there and when. Keyed by application so a `stats.db`
    copied from a test application cannot vouch for this one's commands.
    """
    db.execute("""
        CREATE TABLE IF NOT EXISTS command_sync (
            scope     TEXT    PRIMARY KEY,
            hash      TEXT    NOT NULL,
            synced_at INTEGER NOT NULL
        )
    """)
    db.commit()


def scope_for(application_id: int) -> str:
    return f"global:{application_id}"


def forced(environ: Mapping[str, str]) -> bool:
    """Whether `FORCE_COMMAND_SYNC` asks for a sync whatever the hash says."""
    return environ.get(FORCE_ENV, "").strip().lower() in _ON


def payload_hash(payload: Payload) -> str:
    """
    A hash of the tree as Discord would receive it.

    Keys are sorted, so how a dict happened to be built does not matter, and
    the commands are sorted by type and name, because the order they were
    registered in means nothing to Discord. Everything inside a command keeps
    its order: options are shown in the order sent, so two orders are two
    trees.
    """
    ordered = sorted(payload, key=lambda c: (c.get("type", 1), c.get("name", "")))
    canonical = json.dumps(ordered, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def stored_hash(db: sqlite3.Connection, scope: str) -> str | None:
    row = db.execute("SELECT hash FROM command_sync WHERE scope = ?", (scope,)).fetchone()
    return None if row is None else str(row[0])


def record_sync(db: sqlite3.Connection, scope: str, digest: str, synced_at: int) -> None:
    db.execute(
        "INSERT INTO command_sync (scope, hash, synced_at) VALUES (?, ?, ?) "
        "ON CONFLICT(scope) DO UPDATE SET hash = excluded.hash, synced_at = excluded.synced_at",
        (scope, digest, synced_at),
    )
    db.commit()


async def global_payload(tree) -> list[dict]:
    """
    The global commands as discord.py's own `tree.sync()` would send them.

    Reaches into discord.py internals because 2.7.1 has no public way to build
    the payload without sending it: `_get_all_commands`,
    `get_translated_payload` and `to_dict` have all changed shape across the
    2.x line (`to_dict` took no argument before 2.4), so a dependency bump can
    break this. Written against **discord.py 2.7.1**.
    """
    commands = tree._get_all_commands(guild=None)
    translator = tree.translator
    if translator:
        return [await c.get_translated_payload(tree, translator) for c in commands]
    return [c.to_dict(tree) for c in commands]


def _unchanged(db: sqlite3.Connection | None, scope: str, digest: str) -> bool:
    if db is None:
        return False
    try:
        return stored_hash(db, scope) == digest
    except sqlite3.Error as exc:
        # Unreadable is treated as missing: syncing an unchanged tree costs a
        # rate-limited call; skipping a changed one costs a missing command.
        print(f"command sync: cannot read command_sync ({exc}); syncing", file=sys.stderr)
        return False


async def sync_if_changed(
    *,
    payload: Payload,
    scope: str,
    db: sqlite3.Connection | None,
    force: bool,
    fetch_existing: Callable[[], Awaitable[list]],
    overwrite: Callable[[list], Awaitable[object]],
    now: Callable[[], float] = time.time,
) -> bool:
    """
    Writes `payload` to Discord unless it is the tree last written there.
    True if it synced.

    `fetch_existing` and `overwrite` are the two HTTP calls; neither is made
    on a skip. A failed overwrite raises, as it did before, and stores
    nothing. `db` is None when the table could not be made, and then every
    ready syncs, which is how the bot behaved before the hash existed.
    """
    digest = payload_hash(payload)
    if not force and _unchanged(db, scope, digest):
        print(f"commands unchanged since the last sync ({digest[:12]}); skipped. "
              f"{FORCE_ENV}=1 forces one.", file=sys.stderr)
        return False

    existing = await fetch_existing()
    entry_points = [c for c in existing if c.get("type") == ENTRY_POINT_COMMAND_TYPE]
    await overwrite([*payload, *entry_points])
    print(f"commands synced ({digest[:12]}{', forced' if force else ''})", file=sys.stderr)

    if db is not None:
        try:
            record_sync(db, scope, digest, int(now()))
        except sqlite3.Error as exc:
            print(f"command sync: synced, but cannot record it in command_sync ({exc}); "
                  "the next ready will sync again", file=sys.stderr)
    return True
