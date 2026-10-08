/**
 * A server that stays up while Vite replaces its client build must name the
 * files it now serves. Use a scratch build and a hand-turned clock so the
 * cache and the gap while a build empties dist can both be checked without
 * rebuilding or touching the checkout's real dist.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_ID_REFRESH_MS, createBuildIdReader } from "../server/build-id";
import { Lifecycle } from "../server/lifecycle";
import { BUILD_ID_FILE, BUILD_ID_HEADER } from "../shared/runtime-status";
import { writeBuildIdFile } from "../vite.config";

const directories: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "served-build-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("rechecks a rebuilt bundle after the cache interval, including a rollback", () => {
  const dir = scratch();
  let now = 0;
  writeBuildIdFile(dir, "build-old");
  const read = createBuildIdReader(dir, null, { now: () => now });
  expect(read()).toBe("build-old");

  writeBuildIdFile(dir, "build-new");
  now = BUILD_ID_REFRESH_MS - 1;
  expect(read()).toBe("build-old");
  now++;
  expect(read()).toBe("build-new");

  writeBuildIdFile(dir, "build-old");
  now += BUILD_ID_REFRESH_MS;
  expect(read()).toBe("build-old");
});

test("notices an atomic replacement even when its size and modification time match", () => {
  const dir = scratch();
  let now = 0;
  const file = join(dir, BUILD_ID_FILE);
  writeBuildIdFile(dir, "build-old");
  // Use whole seconds so the timestamp can be restored exactly on every OS.
  utimesSync(file, 1_000, 1_000);
  const old = statSync(file);
  const read = createBuildIdReader(dir, null, { now: () => now });
  expect(read()).toBe("build-old");

  writeBuildIdFile(dir, "build-new");
  utimesSync(file, old.atime, old.mtime);
  expect(statSync(file).size).toBe(old.size);
  expect(statSync(file).mtimeMs).toBe(old.mtimeMs);
  now += BUILD_ID_REFRESH_MS;
  expect(read()).toBe("build-new");
});

test("recovers from an absent or malformed build marker", () => {
  const dir = scratch();
  let now = 0;
  const read = createBuildIdReader(dir, "process-old", { now: () => now });
  expect(read()).toBe("process-old");

  writeBuildIdFile(dir, "build-new");
  now += BUILD_ID_REFRESH_MS;
  expect(read()).toBe("build-new");

  rmSync(join(dir, BUILD_ID_FILE));
  now += BUILD_ID_REFRESH_MS;
  expect(read()).toBe("process-old");

  writeFileSync(join(dir, BUILD_ID_FILE), '{"buildId":"unsafe\\nheader"}');
  now += BUILD_ID_REFRESH_MS;
  expect(read()).toBe("process-old");

  writeBuildIdFile(dir, "release+hotfix");
  now += BUILD_ID_REFRESH_MS;
  expect(read()).toBe("release+hotfix");
  expect(createBuildIdReader(scratch(), "unsafe\nheader")()).toBe("dev");
});

test("concurrent responses keep their own header and body in agreement across a rebuild", async () => {
  const dir = scratch();
  const statusFile = join(dir, "status.json");
  let current = "build-old";
  const lifecycle = new Lifecycle({
    buildId: current,
    servedBuildId: () => current,
    port: 3001,
    statusFile,
    duels: { counts: () => ({ duelsInMatch: 0, lobbies: 0 }), drain() {}, closeAll() {} },
    exit() {},
    log: { log() {}, warn() {} },
    flushMs: 0,
  });
  let finish!: () => void;
  const paused = new Promise<void>((resolve) => { finish = resolve; });
  const request = new Request("http://localhost/api/config");
  const oldReply = lifecycle.handle(request, undefined, async () => {
    await paused;
    return Response.json({ buildId: lifecycle.servedBuildId });
  });
  try {
    current = "build-new";
    const newReply = await lifecycle.handle(request, undefined, () => Response.json(lifecycle.health()));
    finish();
    const previousReply = await oldReply;
    expect(previousReply.headers.get(BUILD_ID_HEADER)).toBe("build-old");
    expect(((await previousReply.json()) as { buildId: string }).buildId).toBe("build-old");
    expect(newReply.headers.get(BUILD_ID_HEADER)).toBe("build-new");
    expect(((await newReply.json()) as { buildId: string }).buildId).toBe("build-new");
    expect(lifecycle.health().buildId).toBe("build-new");
    lifecycle.writeStatus();
    expect(JSON.parse(readFileSync(statusFile, "utf8")).buildId).toBe("build-old");
  } finally {
    finish();
    await oldReply;
    await lifecycle.stop();
  }
});
