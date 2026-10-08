/**
 * The command line: what the operator types, read strictly. A flag the tool
 * does not know is a mistake to stop on, never something to ignore — an
 * ignored `--dry-run` typed as `--dryrun` would deploy for real.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkCommand, parseArgs, run } from "../tools/deploy/cli";
import { FakeBox, cleanUpBoxes } from "./deploy-harness";

afterEach(cleanUpBoxes);

describe("reading the arguments", () => {
  test("a command, its operands, and flags in any position", () => {
    expect(parseArgs(["switch", "game", "main", "--allow-cold", "--dry-run"])).toEqual({
      command: "switch",
      operands: ["game", "main"],
      flags: { dryRun: true, allowCold: true, force: false, now: false, waitQuiet: false, timeoutMinutes: null, keep: null, config: null },
    });
    expect(parseArgs(["--config", "/srv/deploy.json", "status", "--wait-quiet", "--timeout", "45"]).flags).toMatchObject({
      config: "/srv/deploy.json",
      waitQuiet: true,
      timeoutMinutes: 45,
    });
    expect(parseArgs(["prune", "--keep", "2"]).flags.keep).toBe(2);
  });

  test("an unknown flag, a missing value or a bad number is an error", () => {
    expect(() => parseArgs(["deploy", "main", "--dryrun"])).toThrow(/--dryrun/);
    expect(() => parseArgs(["status", "--timeout"])).toThrow(/--timeout/);
    expect(() => parseArgs(["prune", "--keep", "many"])).toThrow(/--keep/);
  });
});

describe("flags a command does not take", () => {
  const refused: readonly (readonly string[])[] = [
    ["switch", "bot", "main", "--timeout", "5"],
    ["switch", "bot", "main", "--allow-cold"],
    ["switch", "game", "main", "--now"],
    ["switch", "site", "main", "--allow-cold"],
    ["switch", "site", "main", "--now"],
    ["deploy", "main", "--keep", "1"],
    ["deploy", "main", "--wait-quiet"],
    ["rollback", "site", "--now"],
    ["rollback", "bot", "--allow-cold"],
    ["rollback", "game", "--force"],
    ["status", "--now"],
    ["status", "--timeout", "5"],
    ["prune", "--force"],
    ["prepare", "main", "--force"],
    ["backup", "--now"],
    ["ecosystem", "--keep", "2"],
  ];

  for (const argv of refused) {
    test(`are an error, never ignored: ${argv.join(" ")}`, () => {
      const flag = argv.find((arg) => arg.startsWith("--"))!;
      expect(() => checkCommand(parseArgs(argv))).toThrow(flag);
    });
  }

  test("the ones it does take pass, and --config and --dry-run go with any command", () => {
    const accepted: readonly (readonly string[])[] = [
      ["switch", "game", "main", "--allow-cold", "--force"],
      ["switch", "site", "main", "--force"],
      ["switch", "bot", "main", "--now", "--force"],
      ["deploy", "main", "--allow-cold", "--now", "--force"],
      ["rollback", "game", "--allow-cold"],
      ["rollback", "bot", "--now"],
      ["rollback", "site"],
      ["status", "--wait-quiet", "--timeout", "5"],
      ["prune", "--keep", "1"],
      ["--dry-run", "--config", "/srv/deploy.json", "prepare", "main"],
      ["backup", "--dry-run"],
    ];
    for (const argv of accepted) expect(() => checkCommand(parseArgs(argv))).not.toThrow();
  });

  test("the command line fails with 2 before anything runs", async () => {
    const lines: string[] = [];
    expect(await run(["switch", "bot", "main", "--timeout", "5"], { out: (line) => lines.push(line) })).toBe(2);
    expect(lines.join("\n")).toContain("--timeout");
  });
});

describe("running a command", () => {
  test("no command prints the usage and fails", async () => {
    const lines: string[] = [];
    expect(await run([], { out: (line) => lines.push(line) })).toBe(2);
    expect(lines.join("\n")).toContain("Usage");
  });

  test("an unknown command or app is a usage error", async () => {
    const box = new FakeBox();
    const configPath = join(box.layout.shared, "deploy.json");
    writeFileSync(configPath, JSON.stringify({ ...box.config }));
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), host: box.host() };
    expect(await run(["--config", configPath, "launch"], io)).toBe(2);
    expect(await run(["--config", configPath, "switch", "database", "main"], io)).toBe(2);
    expect(lines.join("\n")).toContain("database");
  });

  test("a deploy error is printed plainly and fails with 1", async () => {
    const box = new FakeBox();
    const lines: string[] = [];
    const missing = join(box.layout.shared, "nope.json");
    expect(await run(["--config", missing, "status"], { out: (line) => lines.push(line), host: box.host() })).toBe(1);
    expect(lines.join("\n")).toContain("nope.json");
  });

  test("status runs against the config it is pointed at", async () => {
    const box = new FakeBox();
    const configPath = join(box.layout.shared, "deploy.json");
    writeFileSync(configPath, JSON.stringify({ ...box.config }));
    const lines: string[] = [];
    expect(await run(["--config", configPath, "status"], { out: (line) => lines.push(line), host: box.host() })).toBe(0);
    expect(lines.join("\n")).toContain("site (bcs-site");
  });
});
