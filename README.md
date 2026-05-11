# teto-python

A Python ↔ TypeScript bridge that lets you drive the `@haelp/teto` TETR.IO
engine from Python. The Bun server runs the engine; your Python code sends
replay JSON and receives structured clear events with in-game timestamps.

```
teto-python/
├── server/
│   ├── server.ts       ← Bun NDJSON stdio server (the engine side)
│   ├── package.json
│   └── tsconfig.json
└── client/
    ├── teto_client.py  ← Python client library
    └── example.py      ← Usage example
```

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Bun** | ≥ 1.2 | `curl -fsSL https://bun.sh/install \| bash` |
| **Python** | ≥ 3.9 | https://python.org |

No extra Python packages are required — only the standard library is used.

---

## Setup (one time)

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
# Restart your terminal, then verify:
bun --version
```

On Windows, use the PowerShell installer from https://bun.sh

### 2. Install the server dependencies

```bash
bun install
```

This pulls in `@haelp/teto` (the Triangle.js Tetris engine). That's the only
runtime dependency.

### 3. (Optional) Verify the server starts

```bash
bun server/server.ts
# Should print: {"type":"ready"}
# Press Ctrl-C to stop.
```

---

## Usage

### From Python

```python
from teto_client import TetoClient
from pathlib import Path

with TetoClient(server_dir=Path("server")) as client:

    # Parse a replay file
    result = client.parse_replay_file("my_game.ttrm")

    for clear in result["clears"]:
        print(
            f"[{clear['timeSeconds']:.2f}s] "
            f"{clear['username']}: {clear['clearType']} "
            f"({clear['linesCleared']} lines, +{clear['attack']} atk)"
        )
```

### Run the example

```bash
cd teto-python/client
python example.py /path/to/replay.ttrm
```

---

## Protocol reference

The Python client and Bun server talk NDJSON (one JSON object per line) over
stdin/stdout. You never need to touch this layer directly, but it's documented
here if you want to extend the server.

### Startup handshake

Immediately after the server starts it writes:

```json
{"type": "ready"}
```

The Python client blocks on `.readline()` until it sees this before sending
any requests.

### Request format

```json
{"id": "1", "action": "parse_replay", "replay": "<minified replay JSON>"}
```

- `id` — any string; echoed back in the response so you can match them.
- `action` — currently only `"parse_replay"` is supported.
- `replay` — the full TETR.IO replay JSON as a **string** (not nested JSON).
  Must be on a single line (no embedded newlines). TETR.IO replay files are
  already minified, so this is never an issue in practice.

### Success response

```json
{
  "id": "1",
  "status": "ok",
  "clears": [
    {
      "playerId":      "abc123",
      "username":      "frey",
      "round":         0,
      "frame":         312,
      "timeSeconds":   5.2,
      "piece":         "T",
      "clearType":     "tspinDouble",
      "linesCleared":  2,
      "garbageCleared":0,
      "attack":        4,
      "attackSent":    4,
      "isBTB":         true,
      "b2b":           3,
      "combo":         -1
    }
  ]
}
```

### Error response

```json
{"id": "1", "status": "error", "message": "Invalid replay structure"}
```

---

## Clear types

| `clearType`    | Description                                    |
|----------------|------------------------------------------------|
| `single`       | 1-line clear, no spin                          |
| `double`       | 2-line clear, no spin                          |
| `triple`       | 3-line clear, no spin                          |
| `quad`         | 4-line clear (Tetris)                          |
| `tspinSingle`  | T-Spin Single                                  |
| `tspinDouble`  | T-Spin Double                                  |
| `tspinTriple`  | T-Spin Triple                                  |
| `allspin`      | All-Spin clear (non-T piece spin, or mini)     |
| `perfectClear` | Board fully cleared                            |

---

## Extending the server

To add a new action, add a branch inside the `for await (const line of rl)`
loop in `server.ts`:

```typescript
} else if (action === "my_action") {
  // do something with request fields
  respond({ id, status: "ok", result: "..." });
}
```

Then call it from Python:

```python
result = client._request("my_action", myField="value")
```
