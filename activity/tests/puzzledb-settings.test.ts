/**
 * What the puzzle database reads from its environment, and what it refuses.
 *
 * Its environment comes from its own env file, `bun --env-file=puzzledb/.env`,
 * and every rule here exists because of a way that can go wrong without a
 * sound. Bun skips a mistyped env file silently, so `DATABASE_PATH` is
 * required rather than defaulted. A process started the game's way loads the
 * game's `.env`, secrets and all, so seven secrets are refused by name — and
 * never echoed, because the refusal is printed to a log. An inherited `PORT`
 * beats the env file, so the site reads a port variable of its own.
 *
 * Every problem is collected before anything is thrown, so an operator fixes
 * the file once rather than once per restart.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_PORT,
  FORBIDDEN_SECRETS,
  HOST,
  ownerWarning,
  readSettings,
  SettingsError,
  SITE_PATHS,
} from "../puzzledb/server/settings";
import { DEFAULT_TIME_ZONE } from "../shared/daily";

const DATABASE_PATH = "/srv/baronchairstair/activity/data/daily.sqlite";

const scratch: string[] = [];

afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "puzzledb-settings-"));
  scratch.push(directory);
  return directory;
}

/** The problems a refusal lists, or a failed test if there was no refusal. */
function problemsWith(env: Record<string, string | undefined>): readonly string[] {
  try {
    readSettings(env);
  } catch (error) {
    if (error instanceof SettingsError) return error.problems;
    throw error;
  }
  throw new Error(`readSettings accepted ${JSON.stringify(Object.keys(env))}`);
}

describe("the database path", () => {
  test("requires DATABASE_PATH, and an absolute one", () => {
    expect(problemsWith({}).join("\n")).toContain("DATABASE_PATH is not set");
    expect(problemsWith({ DATABASE_PATH: "   " }).join("\n")).toContain("DATABASE_PATH is not set");

    const relative = problemsWith({ DATABASE_PATH: "data/daily.sqlite" });
    expect(relative).toHaveLength(1);
    expect(relative[0]).toContain("DATABASE_PATH");
    expect(relative[0]).toContain("absolute");
    expect(relative[0]).not.toContain("data/daily.sqlite");

    expect(readSettings({ DATABASE_PATH }).databasePath).toBe(DATABASE_PATH);
  });
});

describe("the game's secrets", () => {
  test("refuses to start with any of the seven secrets set, naming it and never its value", () => {
    const names: readonly string[] = FORBIDDEN_SECRETS;
    expect([...names].sort()).toEqual(
      [
        "BOT_API_KEY",
        "DISCORD_CLIENT_SECRET",
        "DISCORD_TOKEN",
        "GITHUB_TOKEN",
        "PUZZLE_API_KEY",
        "REVIEW_SECRET",
        "SESSION_SECRET",
      ].sort(),
    );
    for (const name of FORBIDDEN_SECRETS) {
      const value = `planted-secret-value-${name.toLowerCase()}`;

      const problems = problemsWith({ DATABASE_PATH, [name]: value });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${name} is set in this process's environment`);
      expect(problems[0]).toContain("bun --env-file=puzzledb/.env");
      expect(problems.join("\n")).not.toContain(value);
    }
  });

  test("lets an empty secret through, since an empty line in an env file holds nothing", () => {
    expect(readSettings({ DATABASE_PATH, SESSION_SECRET: "" }).databasePath).toBe(DATABASE_PATH);
  });
});

describe("one refusal", () => {
  test("collects every problem into one refusal", () => {
    let refusal: unknown;
    try {
      readSettings({
        SESSION_SECRET: "planted-one",
        DISCORD_TOKEN: "planted-two",
        PUZZLEDB_PORT: "http",
        DAILY_RESET_TIMEZONE: "Mars/Olympus_Mons",
      });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(SettingsError);
    const { problems, message } = refusal as SettingsError;
    expect(problems).toHaveLength(5);
    expect(problems.filter((problem) => problem.startsWith("SESSION_SECRET"))).toHaveLength(1);
    expect(problems.filter((problem) => problem.startsWith("DISCORD_TOKEN"))).toHaveLength(1);
    expect(problems.filter((problem) => problem.startsWith("DATABASE_PATH"))).toHaveLength(1);
    expect(problems.filter((problem) => problem.startsWith("PUZZLEDB_PORT"))).toHaveLength(1);
    expect(problems.filter((problem) => problem.startsWith("DAILY_RESET_TIMEZONE"))).toHaveLength(1);
    expect(message).not.toContain("planted-");
    expect(Object.isFrozen(problems)).toBe(true);
  });
});

describe("the port", () => {
  test("reads its port from PUZZLEDB_PORT, defaults to 3002, accepts 0, and never reads PORT", () => {
    expect(DEFAULT_PORT).toBe(3002);
    expect(readSettings({ DATABASE_PATH }).port).toBe(DEFAULT_PORT);
    expect(readSettings({ DATABASE_PATH, PUZZLEDB_PORT: "" }).port).toBe(DEFAULT_PORT);
    expect(readSettings({ DATABASE_PATH, PUZZLEDB_PORT: "0" }).port).toBe(0);
    expect(readSettings({ DATABASE_PATH, PUZZLEDB_PORT: "65535" }).port).toBe(65535);
    expect(readSettings({ DATABASE_PATH, PUZZLEDB_PORT: " 4100 " }).port).toBe(4100);
    // The game's PORT is inherited whenever the site is started from a shell
    // that has it, and an inherited variable beats the env file.
    expect(readSettings({ DATABASE_PATH, PORT: "3001" }).port).toBe(DEFAULT_PORT);
    expect(readSettings({ DATABASE_PATH, PORT: "3001", PUZZLEDB_PORT: "4100" }).port).toBe(4100);

    for (const junk of ["http", "-1", "65536", "3002.5", "1e3", "0x10", "+80"]) {
      const problems = problemsWith({ DATABASE_PATH, PUZZLEDB_PORT: junk });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toStartWith("PUZZLEDB_PORT");
    }
  });

  test("binds loopback only", () => {
    expect(HOST).toBe("127.0.0.1");
  });
});

describe("the time zone", () => {
  test("defaults the zone to America/Los_Angeles like the game, and refuses an unknown one with the game's message", () => {
    expect(DEFAULT_TIME_ZONE).toBe("America/Los_Angeles");
    expect(readSettings({ DATABASE_PATH }).timeZone).toBe(DEFAULT_TIME_ZONE);
    expect(readSettings({ DATABASE_PATH, DAILY_RESET_TIMEZONE: "  " }).timeZone).toBe(DEFAULT_TIME_ZONE);
    expect(readSettings({ DATABASE_PATH, DAILY_RESET_TIMEZONE: " Europe/Paris " }).timeZone).toBe(
      "Europe/Paris",
    );

    expect(problemsWith({ DATABASE_PATH, DAILY_RESET_TIMEZONE: "Mars/Olympus_Mons" })).toEqual([
      'DAILY_RESET_TIMEZONE "Mars/Olympus_Mons" is not a known IANA time zone',
    ]);
  });
});

describe("the files beside the code", () => {
  test("finds the data files beside the code, not in the working directory", () => {
    // Resolved from this file's own place in the tree, which is where the
    // site's code sits too — whatever directory the process was started in.
    const activity = resolve(import.meta.dir, "..");

    expect(SITE_PATHS.puzzles).toBe(join(activity, "data/puzzles.json"));
    expect(SITE_PATHS.trackedArchive).toBe(join(activity, "data/archive/puzzles.sqlite"));
    expect(SITE_PATHS.buildRoot).toBe(join(activity, "puzzledb/dist"));
    expect(Object.isFrozen(SITE_PATHS)).toBe(true);
  });
});

describe("who owns the database", () => {
  const me = process.getuid?.();

  function ownedFile(): string {
    const path = join(scratchDirectory(), "daily.sqlite");
    writeFileSync(path, "");
    return path;
  }

  test.skipIf(me === undefined)("warns when the database belongs to another user, naming both uids", () => {
    const path = ownedFile();

    const warning = ownerWarning(path, me! + 1);

    expect(warning).toContain(`this process runs as uid ${me! + 1}`);
    expect(warning).toContain(`${path} belongs to uid ${me}`);
    expect(warning).toContain("-wal and -shm");
  });

  test.skipIf(me === undefined)("asks the directory when the file is not there yet", () => {
    const directory = scratchDirectory();
    const path = join(directory, "daily.sqlite");

    expect(ownerWarning(path, me! + 1)).toContain(`${directory} belongs to uid ${me}`);
    expect(ownerWarning(path, me!)).toBeNull();
  });

  test.skipIf(me === undefined)("says nothing when it is ours or absent", () => {
    const nowhere = join(scratchDirectory(), "gone", "deeper", "daily.sqlite");

    expect(ownerWarning(ownedFile(), me!)).toBeNull();
    expect(ownerWarning(ownedFile())).toBeNull();
    expect(ownerWarning(nowhere, me! + 1)).toBeNull();
  });

  // Root reads through any permission, so the refusal below never happens for it.
  test.skipIf(me === undefined || me === 0)("says what stopped it looking, rather than nothing", () => {
    // Permission denied is not the same answer as "nothing is there", and it
    // is the very failure the warning exists for.
    const locked = join(scratchDirectory(), "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "daily.sqlite"), "");
    chmodSync(locked, 0o000);
    try {
      const warning = ownerWarning(join(locked, "daily.sqlite"), me!);

      expect(warning).toContain(`could not check who owns ${join(locked, "daily.sqlite")}`);
      expect(warning).toContain("EACCES");
    } finally {
      // So the scratch directory can be removed.
      chmodSync(locked, 0o700);
    }
  });
});
