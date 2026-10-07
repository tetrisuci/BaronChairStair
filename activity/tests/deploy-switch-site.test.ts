/**
 * `switch site <sha>`: the site holds nothing but a dataset it rebuilds at
 * boot, so it is replaced outright — delete, start, wait for /health — at the
 * cost of a second or two of 502. It refuses to bind the port beside another
 * copy, which is why there is no overlap to arrange.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { switchSite } from "../tools/deploy/switch-site";
import { FakeBox, NEW, NEWER, OLD, SITE, cleanUpBoxes } from "./deploy-harness";

afterEach(cleanUpBoxes);

const OPTIONS = { force: false };

function siteBox(healthyAfterMs: number | null = 2_000): FakeBox {
  const box = new FakeBox();
  box.prepareRelease(OLD);
  box.prepareRelease(NEW);
  box.writeState({ site: { release: OLD, previous: null } });
  box.addProcess(SITE, join(box.layout.releases, OLD, "activity"));
  let startedAt: number | null = null;
  box.onStart = () => {
    startedAt = box.now;
  };
  box.probe = (url, now) => {
    if (url !== "http://127.0.0.1:3002/health") return null;
    if (startedAt === null || healthyAfterMs === null || now - startedAt < healthyAfterMs) return null;
    return { status: 200, buildId: null, body: '{"ok":true,"puzzles":312}' };
  };
  return box;
}

describe("switching the site", () => {
  test("deletes the old one, starts the new one, and waits for /health ok", async () => {
    const box = siteBox();
    await switchSite(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([
      ["delete", SITE],
      ["start", box.layout.ecosystem, "--only", SITE],
      ["save"],
    ]);
    expect(box.readState().site).toEqual({ release: NEW, previous: OLD });
    expect(box.processes.get(SITE)!.cwd).toBe(join(box.layout.releases, NEW, "activity"));
  });

  test("a site that is not running is simply started", async () => {
    const box = siteBox();
    box.processes.clear();
    await switchSite(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([["start", box.layout.ecosystem, "--only", SITE], ["save"]]);
  });

  test("/health answering ok:false does not count", async () => {
    const box = siteBox();
    box.probe = () => ({ status: 503, buildId: null, body: '{"ok":false}' });
    await expect(switchSite(box.context(), NEW, OPTIONS)).rejects.toThrow(/health/);
  });

  test("a site that never comes up fails, is left running for its logs, and can be rolled back", async () => {
    const box = siteBox(null);
    await expect(switchSite(box.context(), NEW, OPTIONS)).rejects.toThrow(/rollback site/);
    expect(box.pm2Mutations()).toEqual([["delete", SITE], ["start", box.layout.ecosystem, "--only", SITE]]);
    expect(box.readState().site).toEqual({ release: NEW, previous: OLD });
  });

  test("pm2 refusing to start it still records the way back", async () => {
    const box = siteBox();
    box.respond = (command) =>
      command.argv[1] === "start" ? { code: 1, stdout: "", stderr: "[PM2][ERROR] File ecosystem.config.cjs malformed" } : undefined;
    await expect(switchSite(box.context(), NEW, OPTIONS)).rejects.toThrow(/rollback site/);
    expect(box.readState().site).toEqual({ release: NEW, previous: OLD });
  });

  test("the release it already runs is not restarted without --force", async () => {
    const box = siteBox();
    box.writeState({ site: { release: NEW, previous: OLD } });
    await switchSite(box.context(), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([]);
    await switchSite(box.context(), NEW, { force: true });
    expect(box.pm2Mutations()).toHaveLength(3);
  });

  test("a missing shared/daily.sqlite is refused before the site is touched", async () => {
    const box = siteBox();
    rmSync(join(box.layout.shared, "daily.sqlite"));
    await expect(switchSite(box.context(), NEW, OPTIONS)).rejects.toThrow(/daily\.sqlite/);
    expect(box.pm2Mutations()).toEqual([]);
  });

  test("an unprepared release is refused", async () => {
    const box = siteBox();
    await expect(switchSite(box.context(), NEWER, OPTIONS)).rejects.toThrow(/not prepared/);
    expect(box.pm2Mutations()).toEqual([]);
  });
});
