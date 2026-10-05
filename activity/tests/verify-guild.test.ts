/**
 * What the sign-in keeps of a player's server, and what it does with it.
 *
 * `verifyGuild` used to keep only the id, because the id was all the game
 * needed: it decides whose leaderboard a run lands on. db.tetrisatuci.org needs
 * a name to put over that leaderboard, and Discord already sends one in the
 * same answer, so the sign-in now keeps it — and is the one place that has to
 * decide what "a name" may contain before it is written down for strangers to
 * read. Each case below is one way Discord's answer could be other than a
 * tidy string.
 *
 * The last block is about failure. Recording the name is a side errand of
 * signing in, and a sign-in that failed because a write for a different
 * website failed would be the worst trade in the codebase.
 *
 * Discord is a stubbed `fetch`; nothing here leaves the process.
 */

import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The file every route test names, so whichever file imports `config` first settles on it. */
const SHARED_DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);
const CLAIMED = "g-claimed-test";

let verifyGuild: typeof import("../server/auth").verifyGuild;
let recordSignInGuild: typeof import("../server/site-visibility-routes").recordSignInGuild;

beforeAll(async () => {
  process.env.DATABASE_PATH = SHARED_DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  ({ verifyGuild } = await import("../server/auth"));
  ({ recordSignInGuild } = await import("../server/site-visibility-routes"));
});

const realFetch = globalThis.fetch;
let calls = 0;

afterEach(() => {
  globalThis.fetch = realFetch;
  calls = 0;
});

/** Discord answering `/users/@me/guilds` with `body`, or with `status` and no list. */
function discordSays(body: unknown, status = 200): void {
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

async function nameFor(name: unknown): Promise<string | null | undefined> {
  discordSays([{ id: "g-other-test", name: "Elsewhere" }, { id: CLAIMED, name }]);
  return (await verifyGuild("token", CLAIMED))?.name;
}

describe("the name Discord gave", () => {
  test("is kept beside the id, trimmed", async () => {
    discordSays([{ id: CLAIMED, name: "  Tetris at UCI  " }]);

    expect(await verifyGuild("token", CLAIMED)).toEqual({ id: CLAIMED, name: "Tetris at UCI" });
  });

  test.each([
    ["missing", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { text: "Club" }],
    ["empty", ""],
    ["only spaces and control characters", " \u0000\t\n "],
  ])("is null when %s, and the membership still counts", async (_label, name) => {
    discordSays([{ id: CLAIMED, name }]);

    expect(await verifyGuild("token", CLAIMED)).toEqual({ id: CLAIMED, name: null });
  });

  test("loses control and direction-override characters, and keeps everything else", async () => {
    // U+202E would turn every character after the name around on the site's
    // page; a newline would break a chip in two. The emoji's joiner is a
    // format character too, and must survive, or a family becomes four people.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";

    expect(await nameFor(`Club\u0000\u0007 ‮yalp‬ ${family}\r\n`)).toBe(
      `Club yalp ${family}`,
    );
  });

  test("is clipped to a hundred code points, never through the middle of one", async () => {
    const long = "\u{1F7E6}".repeat(150);

    const name = await nameFor(long);

    expect(Array.from(name ?? "")).toHaveLength(100);
    expect(name).toBe("\u{1F7E6}".repeat(100));
  });

  test("is not left ending in a space by the clip", async () => {
    expect(await nameFor(`${"a".repeat(99)} b`)).toBe("a".repeat(99));
  });
});

describe("a server the player is not in", () => {
  test("is null whatever its name", async () => {
    discordSays([{ id: "g-other-test", name: "Elsewhere" }]);

    expect(await verifyGuild("token", CLAIMED)).toBeNull();
  });

  test("no claim asks Discord nothing", async () => {
    discordSays([{ id: CLAIMED, name: "Club" }]);

    expect(await verifyGuild("token", null)).toBeNull();
    expect(calls).toBe(0);
  });

  test.each([
    ["Discord refuses", () => discordSays({ message: "401: Unauthorized" }, 401)],
    ["the answer is not a list", () => discordSays({ id: CLAIMED, name: "Club" })],
    [
      "the request throws",
      () => {
        globalThis.fetch = (async () => {
          throw new TypeError("network down");
        }) as unknown as typeof fetch;
      },
    ],
  ])("is null when %s", async (_label, arrange) => {
    arrange();

    expect(await verifyGuild("token", CLAIMED)).toBeNull();
  });
});

describe("recording it at sign-in", () => {
  test("hands the verified server and its name to the identity", () => {
    const recorded: [string, string | null][] = [];

    recordSignInGuild({ recordGuild: (id, name) => void recorded.push([id, name]) }, {
      id: CLAIMED,
      name: "Club",
    });

    expect(recorded).toEqual([[CLAIMED, "Club"]]);
  });

  test("records nothing for a sign-in with no verified server", () => {
    let recorded = 0;

    recordSignInGuild({ recordGuild: () => void (recorded += 1) }, null);

    expect(recorded).toBe(0);
  });

  test("survives a throwing write, and says so in the log", () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = {
        recordGuild: () => {
          throw new Error("database is locked");
        },
      };

      expect(() => recordSignInGuild(failing, { id: CLAIMED, name: "Club" })).not.toThrow();
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toStartWith("[site-identity]");
    } finally {
      logged.mockRestore();
    }
  });
});
