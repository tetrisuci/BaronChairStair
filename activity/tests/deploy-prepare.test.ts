/**
 * `prepare <ref>`: a release is built and checked in its own directory while
 * players keep using the old one. The marker that says "this release may be
 * switched to" is written only when every check passed, so a half-built
 * release can never be deployed by mistake.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../tools/deploy/host";
import { releaseDir } from "../tools/deploy/layout";
import { prepare } from "../tools/deploy/prepare";
import { isPrepared, listReleases, markerPath } from "../tools/deploy/release";
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
      `DATABASE_PATH=${join(activity, "data", "prepare-test.sqlite")} ${BUN} test`,
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
    const marker = JSON.parse(readFileSync(markerPath(box.layout, NEW), "utf8"));
    expect(marker.sha).toBe(NEW);
    expect(marker.preparedAt).toBe(new Date(box.now).toISOString());
    expect(marker.checks).toContain("bun test");
  });

  /*
   * The site's guide ends *Verify it publicly* with "`git status` from the
   * repository root must be clean", run from the release. A marker inside the
   * checkout was the one untracked file there, so that check was red on every
   * release of a migrated box.
   */
  test("the marker is written beside the release, never inside its checkout", async () => {
    const box = buildingBox();
    await prepare(box.context(), NEW);
    const dir = releaseDir(box.layout, NEW);
    expect(markerPath(box.layout, NEW)).toBe(`${dir}.prepared`);
    expect(readdirSync(dir).sort()).toEqual([".env", "activity", "client"]);
    expect(listReleases(box.layout).map((release) => release.sha)).toEqual([NEW]);
  });

  test("a marker whose release directory is gone vouches for nothing", () => {
    const box = new FakeBox();
    const dir = box.prepareRelease(NEW);
    rmSync(dir, { recursive: true });
    expect(existsSync(markerPath(box.layout, NEW))).toBe(true);
    expect(isPrepared(box.layout, NEW)).toBe(false);
  });

  test("an already prepared release is left alone", async () => {
    const box = buildingBox();
    box.prepareRelease(NEW);
    await prepare(box.context(), "main");
    expect(box.calls.map((call) => call.argv[3])).toEqual(["fetch", "rev-parse"]);
    expect(box.output()).toContain("already prepared");
  });

  test("preparing it again runs nothing, keeps its links and its marker, and puts back a link that went missing", async () => {
    const box = buildingBox();
    await prepare(box.context(), NEW);
    const dir = releaseDir(box.layout, NEW);
    const marker = readFileSync(markerPath(box.layout, NEW), "utf8");
    rmSync(join(dir, ".env"));
    box.calls.length = 0;
    box.now += 60_000;

    await prepare(box.context(), NEW);

    expect(box.calls.map((call) => call.argv[3])).toEqual(["fetch", "rev-parse"]);
    expect(readlinkSync(join(dir, ".env"))).toBe(join(box.layout.shared, "bot.env"));
    expect(readlinkSync(join(dir, "activity", ".env"))).toBe(join(box.layout.shared, "activity.env"));
    expect(readFileSync(markerPath(box.layout, NEW), "utf8")).toBe(marker);
  });
});

/*
 * prepare's `bun test` runs in the release, beside links into shared/. Bun
 * loads the `.env` of its working directory, and shared/activity.env names the
 * live database as DATABASE_PATH: a test file that loaded the server's config
 * before any test set its own scratch path would have fixed the live file for
 * the whole run, and every later route test would have written players, runs
 * and submissions into it — on whichever box orders its test files that way.
 */
describe("the checks never reach a live database or a secret", () => {
  /** Whether either env link existed, at each command that is not git: every install, check and build. */
  function envLinksAtEachCommand(box: FakeBox): boolean[] {
    const dir = releaseDir(box.layout, NEW);
    const seen: boolean[] = [];
    const respond = box.respond;
    box.respond = (command) => {
      if (command.argv[0] !== "git") seen.push([join(dir, ".env"), join(dir, "activity", ".env")].some(isLink));
      return respond(command);
    };
    return seen;
  }

  test("bun test gets DATABASE_PATH set to a scratch file in the release, which beats any .env", async () => {
    const box = buildingBox();
    await prepare(box.context(), NEW);
    const test = box.calls.find((call) => call.argv.join(" ") === `${BUN} test`)!;
    const scratch = join(releaseDir(box.layout, NEW), "activity", "data", "prepare-test.sqlite");
    expect(test.env).toEqual({ DATABASE_PATH: scratch });
    expect(test.env!.DATABASE_PATH).not.toBe(join(box.layout.shared, "daily.sqlite"));
  });

  test("the env files are linked only once every install, check, test and build has passed", async () => {
    const box = buildingBox();
    const seen = envLinksAtEachCommand(box);
    await prepare(box.context(), NEW);
    expect(seen).toEqual([false, false, false, false, false, false, false, false]);
    const dir = releaseDir(box.layout, NEW);
    expect(readlinkSync(join(dir, ".env"))).toBe(join(box.layout.shared, "bot.env"));
    expect(readlinkSync(join(dir, "activity", ".env"))).toBe(join(box.layout.shared, "activity.env"));
  });

  test("the answer keys are linked before the checks: the tests only read them", async () => {
    const box = buildingBox();
    writeFileSync(join(box.layout.shared, "solutions.json"), "[]");
    const link = join(releaseDir(box.layout, NEW), "activity", "data", "solutions.json");
    let linkedAtTest = false;
    const respond = box.respond;
    box.respond = (command) => {
      if (command.argv.join(" ") === `${BUN} test`) linkedAtTest = isLink(link);
      return respond(command);
    };
    await prepare(box.context(), NEW);
    expect(linkedAtTest).toBe(true);
  });

  test("a failed check leaves no link into shared/ at all", async () => {
    const box = buildingBox();
    writeFileSync(join(box.layout.shared, "solutions.json"), "[]");
    const respond = box.respond;
    box.respond = (command) =>
      command.argv.join(" ") === `${BUN} test` ? { code: 1, stdout: "", stderr: " 2 fail\n" } : respond(command);
    await expect(prepare(box.context(), NEW)).rejects.toThrow(/bun test failed/);
    const dir = releaseDir(box.layout, NEW);
    for (const link of [".env", "activity/.env", "activity/data/solutions.json"]) expect(isLink(join(dir, link))).toBe(false);
    expect(isPrepared(box.layout, NEW)).toBe(false);
  });

  test("a release rechecked in place loses env links an earlier run left before its checks run", async () => {
    const box = buildingBox();
    const dir = box.prepareRelease(NEW);
    rmSync(markerPath(box.layout, NEW));
    symlinkSync(join(box.layout.shared, "activity.env"), join(dir, "activity", ".env"));
    symlinkSync(join(box.layout.shared, "bot.env"), join(dir, ".env"));
    const seen = envLinksAtEachCommand(box);
    await prepare(box.context(), NEW);
    expect(seen).toHaveLength(8);
    expect(seen.every((there) => !there)).toBe(true);
    expect(isPrepared(box.layout, NEW)).toBe(true);
  });

  test("a real .env in a release being rechecked is refused before any check: the tests would load it", async () => {
    const box = buildingBox();
    const dir = box.prepareRelease(NEW);
    rmSync(markerPath(box.layout, NEW));
    writeFileSync(join(dir, "activity", ".env"), "DATABASE_PATH=/srv/live/daily.sqlite\n");
    await expect(prepare(box.context(), NEW)).rejects.toThrow(/activity\/\.env is not a link/);
    expect(box.calls.some((call) => call.argv[0] === BUN)).toBe(false);
  });
});

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

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
