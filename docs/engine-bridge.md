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
{"id": "1", "action": "parse_replay", "replay": "<minified replay JSON as a string>"}

// success
{"id": "1", "status": "ok", "clears": [ /* one object per line clear */ ]}

// failure
{"id": "1", "status": "error", "message": "Invalid replay structure"}
```

`parse_replay` is the only action. The replay must be a **string**, not nested
JSON, and on a single line — TETR.IO's own files are already minified, so this
has never come up in practice.

Each clear carries `playerId`, `username`, `round`, `frame`, `timeSeconds`,
`piece`, `clearType`, `linesCleared`, `garbageCleared`, `attack`, `attackSent`,
`isBTB`, `b2b` and `combo`. `clearType` is one of `single`, `double`, `triple`,
`quad`, `tspinSingle`, `tspinDouble`, `tspinTriple`, `allspin` (a non-T spin,
or a mini) or `perfectClear`.

To add an action, extend the dispatch in `server.ts` and call it from Python
with `client._request("my_action", field="value")`.
