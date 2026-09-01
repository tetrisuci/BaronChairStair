# Puzzle — the daily Tetris puzzle

One modern Tetris puzzle a day, played inside Discord as an
[Activity](https://discord.com/developers/docs/activities/overview). Everyone
in the server gets the same puzzle, it changes at midnight, and the result
pastes into a channel as a spoiler-light grid.

The puzzles come from the Tetris at UCI puzzle archive, which stores each one as
a pair of [Blueprint](https://bp.tali.software) codes — the position and the
author's own solution. This project decodes both, replays the solution through a
real TETR.IO engine to learn what it actually sends, and uses that number as the
day's target.

```
tmp/*.csv ──► tools/build-puzzles.ts ──► data/puzzles.json ──► server ──► browser
   archive        decode + replay            138 puzzles       daily     the game
```

## What is in here

| Path | What it is |
| --- | --- |
| `shared/blueprint/` | Decoder for Blueprint `b1@…` codes: bit reader, opcodes, playfield geometry |
| `shared/tetris/` | One engine configuration, a placement pathfinder, and the run verifier |
| `shared/puzzle.ts` | The puzzle data model, shared by the build, the server, and the client |
| `shared/daily.ts` | Which puzzle belongs to which day |
| `tools/` | The build pipeline and its diagnostics |
| `server/` | Hono + Bun: OAuth exchange, daily puzzle, run verification, SQLite |
| `client/` | The activity itself — canvas playfield and interface |
| `client/public/fonts/` | Archivo and DM Mono, self-hosted (see below) |

## Running it locally

```sh
bun install
bun run puzzles       # tmp/*.csv -> data/puzzles.json  (already committed)
bun run build         # client -> dist/
bun run dev           # server on :3001, serving dist/
```

Open <http://localhost:3001>. Outside Discord there is no OAuth handshake, so
the server hands out a single local guest identity and everything else works
normally. For a live-reloading client, run `bun run dev:client` alongside
`bun run dev` and use <http://localhost:3000>.

Useful commands:

```sh
bun test                                 # decoder, verifier, routes, and archive checks
bun run tools/inspect-puzzle.ts 13 70    # why a given archive entry will not build
bun run typecheck
```

`tools/e2e-submit.ts` plays today's puzzle against a running server. It signs in
as a guest, so once Discord credentials are configured the deployment guard
switches guest play off and the script can no longer get a session. Point it at
a throwaway instance instead of the real one:

```sh
ALLOW_GUEST_PLAY=true PORT=3998 DATABASE_PATH=/tmp/e2e.sqlite bun run server/index.ts &
bun run tools/e2e-submit.ts http://localhost:3998
```

## Setting it up as a Discord Activity

1. **Create the application.** <https://discord.com/developers/applications> →
   New Application. Under *Activities → Settings*, enable Activities.
2. **Copy the credentials** from *OAuth2* into `activity/.env` as
   `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`, and set a `SESSION_SECRET`.
3. **Add exactly one OAuth2 redirect URI.** The embedded SDK never sends one —
   it expects Discord to resolve it from the application — so an app with none
   registered fails at `authorize()` with `invalid_request: Missing
   "redirect_uri" in request`, and an app with several is ambiguous. The URI is
   never navigated to in this flow, so its value barely matters;
   `https://<application id>.discordsays.com/` is the conventional choice.
4. **Expose the server over HTTPS.** Discord will not load an activity over
   plain HTTP. In development, `cloudflared tunnel --url http://localhost:3001`
   or `ngrok http 3001` is enough.
5. **Add a URL mapping.** *Activities → URL Mappings*: map the root prefix `/`
   to your public host. The client sends everything through `/.proxy` when it
   detects it is running inside Discord; the server accepts both forms, so no
   further configuration is needed.
6. **Launch it** from the activity picker in any voice channel, or post a link
   with `/puzzle play`.

The activity asks for two OAuth scopes. `identify` names the player on the
leaderboard. `guilds` lets the server confirm a player is really in the server
whose leaderboard they are writing to — without it, the guild is whatever the
client claims, and anyone could post into any server's standings.

### The bot commands

`client/puzzle_commands.py` adds `/puzzle play`, `/puzzle standings`,
and `/puzzle help` to the existing bot. It owns none of the game — it reads
two endpoints on the activity server so the two can never disagree. Set these in
the repo-root `.env`:

```
PUZZLE_APP_ID=<the application id>
PUZZLE_API=https://your-activity-host
PUZZLE_API_KEY=<same value as BOT_API_KEY in activity/.env>
```

Without `PUZZLE_APP_ID` the commands are still registered; they just explain
what is missing.

## How a run is scored

A sheet has a fixed board, a fixed queue, and a damage target taken from the
author's own solution. Reach the target and the sheet is approved. Restart as
often as you like — restarts are counted and shared, but only the attempt that
solves it is filed, and the first filing of the day is the one that sticks.

**The client never reports a score.** It submits the keys it pressed, with frame
and sub-frame timing, and the server replays them through the same engine on the
same puzzle. The number on the leaderboard is one the engine produced from
inputs somebody actually made, using the handling the attempt was played
under — which is frozen when the attempt starts, so changing it mid-run
restarts rather than scoring a game nobody played.

**Times are a claim, not a measurement.** The leaderboard ranks by *total time
on the puzzle* — wall clock from opening it to solving it, across every restart,
which is what a player actually experiences. That number comes from their own
clock and cannot be verified; the server only bounds it, so it can never be less
than the solving attempt provably took nor more than a day. The solving
attempt's own duration *is* verified, by replaying its inputs. Whether a run
solved the puzzle is fully verified; how fast is a friendly scoreboard.

## Controls

Fully rebindable, with TETR.IO handling: DAS, ARR, DCD, SDF, safe lock, DAS
cancel, 20G movement, and initial rotation/hold. Settings are stored locally and
mirrored to the player's Discord account, so they follow them to another device.

**Timings are in milliseconds**, matching the club's own board and every
handling guide worth reading. The engine works in 60Hz frames, and the
conversion happens in exactly one place — inside the engine factory — so a
duration is never accidentally read as a frame count. It is not rounded to whole
frames either: a DAS of 103ms really is 103ms. SDF stays a multiplier, because
it is a speed rather than a time.

Defaults: arrows to move and soft drop, space to hard drop, `Z`/`X` to rotate,
`A` for 180, `C` to hold, `R` to restart, `Esc` for settings.

## Look and feel

The palette, the type, and the shapes come from
[tetrisatuci.org](https://tetrisatuci.org): sun-yellow ground, plum ink, cream
cards, and the club's own seven piece colours. Two rules hold it together —
shadows are hard offsets rather than blurs, so the interface stacks like
stickers on paper, and the corner radius is small and constant.

Fonts are **self-hosted** in `client/public/fonts/`. A Discord activity runs in
a sandboxed iframe that cannot reach `fonts.googleapis.com`, so Archivo (the
heavy display face) and DM Mono (everything numeric) ship with the bundle. Both
are SIL Open Font Licence.

## Regenerating the puzzle data

`data/puzzles.json` is committed, so a checkout runs without the spreadsheet.
When the archive gains puzzles, re-export the sheets into `tmp/` and run:

```sh
bun run puzzles
```

It reports how many puzzles built, how far the replayed clears agree with the
authors' own descriptions, and every entry it had to skip with the reason. Two
of the current 140 are skipped: one answer is drawn into squares no legal
movement can reach, and one has no answer that its own pieces can produce. Both
are archive-side problems, not decoder bugs — `tools/inspect-puzzle.ts` shows
the working.
