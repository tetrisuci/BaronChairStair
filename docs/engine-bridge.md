# The engine bridge

How Python drives the TETR.IO engine, and the wire format between them.

---

`server/server.ts` runs the `@haelp/teto` TETR.IO engine and speaks NDJSON —
one JSON object per line — over stdin and stdout. `client/teto_client.py`
drives it. You never touch the wire format unless you are extending the server.

```python
from teto_client import TetoClient
from pathlib import Path

with TetoClient(server_dir=Path("server")) as client:
    result = client.parse_replay_file("game.ttrm")
    for clear in result["clears"]:
        print(f"[{clear['timeSeconds']:.2f}s] {clear['username']}: "
              f"{clear['clearType']} +{clear['attack']} atk")
```

On start the server writes `{"type":"ready"}` and the client blocks until it
sees it. Then:

```jsonc
// request — `id` is any string, echoed back so responses can be matched
{"id": "1", "action": "parse_replay", "replay": "<replay JSON as a string>"}

// success
{"id": "1", "status": "ok", "clears": [ /* one object per line clear */ ]}

// failure
{"id": "1", "status": "error", "message": "Invalid replay structure"}
```

`parse_replay` is the only action. The replay must be a **string**, not nested
JSON. The request itself has to fit on one line, and `json.dumps` sees to that
by escaping every newline inside the replay, so a pretty-printed file works as
well as a minified one.

Each clear carries `playerId`, `username`, `round`, `frame`, `timeSeconds`,
`piece`, `clearType`, `linesCleared`, `garbageCleared`, `attack`, `attackSent`,
`isBTB`, `b2b`, `combo` and `board`. `clearType` is one of `single`, `double`,
`triple`, `quad`, `tspinSingle`, `tspinDouble`, `tspinTriple`, `allspin` (a
non-T spin, or a T-spin mini single) or `perfectClear`.

`board` is the visible playfield just after the clear: a list of rows from the
bottom up (20 on a standard board), each a list of cells from left to right.
A cell is `null` when empty, or the engine's name for what fills it: `i`, `j`,
`l`, `o`, `s`, `t`, `z`, `gb` for garbage, or `bomb`. `client/render.py` draws
it, and `client/build_snapshots.py` reads it as the board after each window.

To add an action, extend the dispatch in `server.ts` and call it from Python
with `client._request("my_action", field="value")`.
