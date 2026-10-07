/**
 * `prepare <ref>`: a release is built and checked in its own directory while
 * players keep using the old one. The marker that says "this release may be
 * switched to" is written only when every check passed, so a half-built
 * release can never be deployed by mistake.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../tools/deploy/host";
import { releaseDir } from "../tools/deploy/layout";
import { prepare } from "../tools/deploy/prepare";
import { MARKER_FILE, isPrepared } from "../tools/deploy/release";
import { FakeBox, NEW, cleanUpBoxes } from "./deploy-harness";

afterEach(cleanUpBoxes);

const BUN = "/opt/bun/bin/bun";
const PYTHON = "/opt/bcs/venv/bin/python";

function describeCall(call: Command): string {
  const env = Object.entries(call.env ?? {}).map(([key, value]) => `${key}=${value} `).join("");
  return `${env}${call.argv.join(" ")}`;
}

/** A box whose client build writes its id, as the real one does. */
function buildingBox(): FakeBox {
  const box = new FakeBox();
  const build = box.respond;
  box.respond = (command) => {
    if (command.argv.join(" ") === `${BUN} run build`) box.writeBuildId(command.env?.BUILD_ID ?? "");
    return build(command);
  };
  return box;
}

describe("a release that passes every check", () => {
  test("is fetched, checked out, linked, installed, checked and built, in that order", async () => {
    const box = buildingBox();
    const sha = await prepare(box.context(), "main");
    expect(sha).toBe(NEW);

    const dir = releaseDir(box.layout, NEW);
    const activity = join(dir, "activity");
    const repo = box.layout.repo;
    expect(box.calls.map(describeCall)).toEqual([
      `git -C ${repo} fetch --prune origin`,
      `git -C ${repo} rev-parse --verify --quiet refs/remotes/origin/main^{commit}`,
      `git -C ${repo} worktree add --detach ${dir} ${NEW}`,
      `${BUN} install --frozen-lockfile`,
      `${BUN} install --frozen-lockfile`,
      `${PYTHON} -m py_compile client/changelog.py client/discord_bot.py`,
      `${PYTHON} -m unittest discover -p test_*.py`,
      `${BUN} x tsc --noEmit`,
      `${BUN} test`,
      `BUILD_ID=${NEW} ${BUN} run build`,
      `${BUN} run build:puzzledb`,
    ]);
    expect(box.calls.slice(3).map((call) => call.cwd)).toEqual([
      dir,
      activity,
      dir,
      join(dir, "client"),
      activity,
      activity,
      activity,
      activity,
    ]);
    expect(isPrepared(box.layout, NEW)).toBe(true);
  });

  test("links the shared environment files into the release", async () => {
    const box = buildingBox();
    await prepare(box.context(), NEW);
    const dir = releaseDir(box.layout, NEW);
    const shared = box.layout.shared;
    expect(readlinkSync(join(dir, "activity", ".env"))).toBe(join(shared, "activity.env"));
    expect(readlinkSync(join(dir, ".env"))).toBe(join(shared, "bot.env"));
    expect(existsSync(join(dir, "activity", "data", "solutions.json"))).toBe(false);
  });

  test("links solutions.json only when the box has one", async () => {
    const box = buildingBox();
    writeFileSync(join(box.layout.shared, "solutions.json"), "[]");
    await prepare(box.context(), NEW);
    const link = join(releaseDir(box.layout, NEW), "activity", "data", "solutions.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(box.layout.shared, "solutions.json"));
  });

  test("the marker records when and what was checked", async () => {
    const box = buildingBox();
    await prepare(box.context(), NEW);
    const marker = JSON.parse(readFileSync(join(releaseDir(box.layout, NEW), MARKER_FILE), "utf8"));
    expect(marker.sha).toBe(NEW);
    expect(marker.preparedAt).toBe(new Date(box.now).toISOString());
    expect(marker.checks).toContain("bun test");
  });

  test("an already prepared release is left alone", async () => {
    const box = buildingBox();
    box.prepareRelease(NEW);
    await prepare(box.context(), "main");
    expect(box.calls.map((call) => call.argv[3])).toEqual(["fetch", "rev-parse"]);
    expect(box.output()).toContain("already prepared");
  });
});

describe("a release that fails", () => {
  test("stops at the failing check, runs nothing after it, and writes no marker", async () => {
    const box = buildingBox();
    const build = box.respond;
    box.respond = (command) =>
      command.argv.join(" ") === `${BUN} x tsc --noEmit`
        ? { code: 2, stdout: "server/index.ts(1,1): error TS2304: Cannot find name 'x'.", stderr: "" }
        : build(command);

    await expect(prepare(box.context(), NEW)).rejects.toThrow(/tsc failed[\s\S]*error TS2304/);
    expect(box.calls.some((call) => call.argv.includes("test"))).toBe(false);
    expect(box.calls.some((call) => call.argv.includes("build"))).toBe(false);
    expect(isPrepared(box.layout, NEW)).toBe(false);
  });

  test("a test run that does not report 0 fail fails, whatever its exit code", async () => {
    const box = buildingBox();
    const build = box.respond;
    box.respond = (command) =>
      command.argv.join(" ") === `${BUN} test`
        ? { code: 0, stdout: "", stderr: " 1210 pass\n 3 fail\n" }
        : build(command);
    await expect(prepare(box.context(), NEW)).rejects.toThrow(/0 fail/);
    expect(isPrepared(box.layout, NEW)).toBe(false);
  });

  test("a client build that did not record the release's id fails", async () => {
    const box = new FakeBox();
    await expect(prepare(box.context(), NEW)).rejects.toThrow(/build\.json/);
    expect(isPrepared(box.layout, NEW)).toBe(false);
  });

  test("a missing shared environment file stops it before anything is checked out", async () => {
    const box = buildingBox();
    const { rmSync } = await import("node:fs");
    rmSync(join(box.layout.shared, "bot.env"));
    await expect(prepare(box.context(), NEW)).rejects.toThrow(/bot\.env/);
    expect(box.calls.some((call) => call.argv.includes("worktree"))).toBe(false);
  });

  test("a bot.env that sets a variable the ecosystem owns stops it before anything runs: the bot's tests would load it", async () => {
    const box = buildingBox();
    writeFileSync(join(box.layout.shared, "bot.env"), "STATS_DB=/srv/old/stats.db\nDISCORD_TOKEN=token-value\n");
    const error = (await prepare(box.context(), NEW).catch((caught: unknown) => caught)) as Error;
    expect(error.message).toContain("STATS_DB");
    expect(error.message).not.toContain("/srv/old");
    expect(error.message).not.toContain("token-value");
    expect(box.calls.some((call) => call.argv.includes("worktree"))).toBe(false);
  });

  test("a ref that does not resolve says so", async () => {
    const box = buildingBox();
    await expect(prepare(box.context(), "no-such-branch")).rejects.toThrow(/no-such-branch/);
  });

  test("a failed release is rechecked in place on the next prepare, without a second checkout", async () => {
    const box = buildingBox();
    const build = box.respond;
    let failing = true;
    box.respond = (command) =>
      failing && command.argv.join(" ") === `${BUN} test` ? { code: 1, stdout: "", stderr: " 1 fail\n" } : build(command);
    await expect(prepare(box.context(), NEW)).rejects.toThrow();
    failing = false;
    box.calls.length = 0;
    await prepare(box.context(), NEW);
    expect(box.calls.some((call) => call.argv.includes("worktree"))).toBe(false);
    expect(isPrepared(box.layout, NEW)).toBe(true);
  });
});
