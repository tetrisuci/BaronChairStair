/**
 * `shared/deploy.json`: the one place the deploy learns which pm2 apps are
 * its own. A typo here is how a deploy ends up acting on the wrong process —
 * DIAYN runs under the same pm2 — so the file is checked strictly, every
 * problem is reported at once, and nothing runs until it is right.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertManaged, managedNames, parseConfig } from "../tools/deploy/config";

const VALID = {
  home: "/home/bcs/bcs",
  pm2: { bot: "bcs-bot", gameSlots: ["bcs-game-blue", "bcs-game-green"], site: "bcs-site" },
  gamePort: 3001,
  sitePort: 3002,
  botPython: "/home/bcs/bcs/shared/venv/bin/python",
};

function parse(fields: Record<string, unknown>) {
  return parseConfig(JSON.stringify(fields), "deploy.json");
}

function problemsOf(fields: Record<string, unknown>): string {
  try {
    parse(fields);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the config to be refused");
}

describe("a valid deploy.json", () => {
  test("fills every optional field with its default", () => {
    const config = parse(VALID);
    expect(config.home).toBe("/home/bcs/bcs");
    expect(config.pm2.gameSlots).toEqual(["bcs-game-blue", "bcs-game-green"]);
    expect(config.drainLimitMinutes).toBe(20);
    expect(config.botQuietSeconds).toBe(60);
    expect(config.botQuietLimitMinutes).toBe(30);
    expect(config.keepReleases).toBe(3);
    expect(config.bun).toBeNull();
    expect(config.botFiles).toEqual(["client/**", "server/**", "package.json", "bun.lock", "changelog.json"]);
  });

  test("keeps the values it is given", () => {
    const config = parse({ ...VALID, drainLimitMinutes: 5, keepReleases: 1, bun: "/usr/local/bin/bun", botFiles: ["client/**"] });
    expect(config.drainLimitMinutes).toBe(5);
    expect(config.keepReleases).toBe(1);
    expect(config.bun).toBe("/usr/local/bin/bun");
    expect(config.botFiles).toEqual(["client/**"]);
  });

  test("the shipped example is itself valid", () => {
    const text = readFileSync(join(import.meta.dir, "../tools/deploy/deploy.example.json"), "utf8");
    expect(() => parseConfig(text, "deploy.example.json")).not.toThrow();
  });
});

describe("a deploy.json that is refused", () => {
  test("not JSON, or not an object", () => {
    expect(() => parseConfig("{", "deploy.json")).toThrow(/deploy.json is not valid JSON/);
    expect(() => parseConfig("[]", "deploy.json")).toThrow(/one JSON object/);
  });

  test("every problem is listed, not just the first", () => {
    const message = problemsOf({ ...VALID, home: "bcs", botPython: "python3", gamePort: 0 });
    expect(message).toContain("home must be an absolute path");
    expect(message).toContain("botPython must be an absolute path");
    expect(message).toContain("gamePort must be a whole number from 1 to 65535");
  });

  test("a misspelt field is an error, not silently ignored", () => {
    expect(problemsOf({ ...VALID, drainLimitMinute: 5 })).toContain('unknown field "drainLimitMinute"');
  });

  test("pm2 names must be distinct, and there must be exactly two game slots", () => {
    expect(problemsOf({ ...VALID, pm2: { ...VALID.pm2, site: "bcs-bot" } })).toContain("must all be different");
    expect(problemsOf({ ...VALID, pm2: { ...VALID.pm2, gameSlots: ["a", "a"] } })).toContain("must all be different");
    expect(problemsOf({ ...VALID, pm2: { ...VALID.pm2, gameSlots: ["only-one"] } })).toContain("exactly two");
  });

  test("names pm2 would read as something else are refused", () => {
    expect(problemsOf({ ...VALID, pm2: { ...VALID.pm2, bot: "all" } })).toContain('"all"');
    expect(problemsOf({ ...VALID, pm2: { ...VALID.pm2, bot: "3" } })).toContain('"3"');
    expect(problemsOf({ ...VALID, pm2: { ...VALID.pm2, site: "my site" } })).toContain('"my site"');
  });

  test("a game slot named bot would share the bot's status file", () => {
    expect(problemsOf({ ...VALID, pm2: { ...VALID.pm2, gameSlots: ["bot", "green"] } })).toContain("bot.json");
  });

  test("the game and the site cannot share a port", () => {
    expect(problemsOf({ ...VALID, sitePort: 3001 })).toContain("gamePort and sitePort must differ");
  });

  test("numbers must make sense", () => {
    expect(problemsOf({ ...VALID, drainLimitMinutes: 0 })).toContain("drainLimitMinutes");
    expect(problemsOf({ ...VALID, botQuietSeconds: -1 })).toContain("botQuietSeconds");
    expect(problemsOf({ ...VALID, keepReleases: 1.5 })).toContain("keepReleases");
    expect(problemsOf({ ...VALID, botFiles: [] })).toContain("botFiles");
  });
});

describe("the names the deploy may act on", () => {
  test("are exactly the four in the config", () => {
    const config = parse(VALID);
    expect([...managedNames(config)].sort()).toEqual(["bcs-bot", "bcs-game-blue", "bcs-game-green", "bcs-site"]);
    expect(() => assertManaged(config, "bcs-site")).not.toThrow();
  });

  test("anything else — DIAYN, or all — is refused", () => {
    const config = parse(VALID);
    expect(() => assertManaged(config, "diayn")).toThrow(/not named in deploy.json/);
    expect(() => assertManaged(config, "all")).toThrow(/not named in deploy.json/);
  });
});
