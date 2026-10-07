/**
 * `switch site <sha>`: the site holds nothing but a dataset it rebuilds at
 * boot, so it is replaced outright — delete, start, wait for /health — at the
 * cost of a second or two of 502. It refuses to bind the port beside another
 * copy, which is why there is no overlap to arrange.
 *
 * And because /health carries no build id, an ok from it proves only that
 * something answers the port. The rehearsal had a site started by hand answer
 * it while the new one died with EADDRINUSE, and the switch said it was done.
 * So nothing may answer the port before the new site starts, and pm2 must show
 * the new site online on one pid, and the same pid a few seconds later.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { switchSite } from "../tools/deploy/switch-site";
import { FakeBox, NEW, NEWER, OLD, SITE, cleanUpBoxes } from "./deploy-harness";

afterEach(cleanUpBoxes);

const OPTIONS = { force: false };
const HEALTH_URL = "http://127.0.0.1:3002/health";
const HEALTHY = { status: 200, buildId: null, body: '{"ok":true,"puzzles":312}' };

/** A box running the site on OLD, whose new site answers /health `healthyAfterMs` after pm2 starts it. */
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
    if (url !== HEALTH_URL) return null;
    if (startedAt === null || healthyAfterMs === null || now - startedAt < healthyAfterMs) return null;
    return HEALTHY;
  };
  return box;
}

/** Also run `then` whenever pm2 starts the site, after what `siteBox` already does. */
function onSiteStart(box: FakeBox, then: (pid: number) => void): void {
  const before = box.onStart;
  box.onStart = (name, app, pid) => {
    before(name, app, pid);
    if (name === SITE) then(pid);
  };
}

/** The clock at every `pm2 jlist` once the new site has started. */
function jlistReadsAfterStart(box: FakeBox): number[] {
  const reads: number[] = [];
  let started = false;
  onSiteStart(box, () => {
    started = true;
  });
  box.respond = (command) => {
    if (started && command.argv.join(" ") === "pm2 jlist") reads.push(box.now);
    return undefined;
  };
  return reads;
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
    let started = false;
    onSiteStart(box, () => {
      started = true;
    });
    box.probe = () => (started ? { status: 503, buildId: null, body: '{"ok":false}' } : null);
    await expect(switchSite(box.context(), NEW, OPTIONS)).rejects.toThrow(/did not answer \/health with ok:true/);
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

describe("an ok from /health is not taken as the new site's own", () => {
  test("done only once pm2 shows the new site online on one pid, and the same pid 5 s later", async () => {
    const box = siteBox();
    const reads = jlistReadsAfterStart(box);
    await switchSite(box.context(), NEW, OPTIONS);
    expect(reads).toHaveLength(2);
    expect(reads[1]! - reads[0]!).toBeGreaterThanOrEqual(5_000);
    const pid = box.processes.get(SITE)!.pid;
    expect(box.output()).toContain(`site: ${SITE} serves 2222222 (pid ${pid}, online and unchanged for 5 s)`);
    expect(box.pm2Mutations().at(-1)).toEqual(["save"]);
  });

  test("a new site that died at start fails, though /health answered ok", async () => {
    const box = siteBox();
    onSiteStart(box, () => {
      // It died at once (EADDRINUSE), and pm2 gave up on it; something else answers the port.
      const site = box.processes.get(SITE)!;
      box.alive.delete(site.pid);
      site.status = "errored";
      site.pid = 0;
    });
    const switched = switchSite(box.context(), NEW, OPTIONS);
    await expect(switched).rejects.toThrow(/pm2 shows it errored/);
    await expect(switched).rejects.toThrow(/cannot tell[\s\S]*ss -ltnp[\s\S]*lsof -nP -iTCP:3002[\s\S]*rollback site/);
    // No `pm2 save`: pm2's saved list still brings back the old site on a reboot.
    expect(box.pm2Mutations()).toEqual([["delete", SITE], ["start", box.layout.ecosystem, "--only", SITE]]);
    expect(box.readState().site).toEqual({ release: NEW, previous: OLD });
  });

  test("a new site pm2 keeps restarting fails: its pid changes while /health answers ok", async () => {
    const box = siteBox();
    let startedAt = 0;
    let firstPid = 0;
    onSiteStart(box, (pid) => {
      startedAt = box.now;
      firstPid = pid;
    });
    // It dies every 4 s, after building its dataset, and pm2 starts it again with a new pid.
    box.respond = (command) => {
      const site = box.processes.get(SITE);
      if (command.argv.join(" ") !== "pm2 jlist" || !site || firstPid === 0) return undefined;
      box.alive.delete(site.pid);
      site.pid = firstPid + 100 * Math.floor((box.now - startedAt) / 4_000);
      box.alive.add(site.pid);
      return undefined;
    };
    const switched = switchSite(box.context(), NEW, OPTIONS);
    await expect(switched).rejects.toThrow(/pm2 restarted it: pid (\d+) became pid (?!\1\b)\d+, 5 s after \/health answered ok/);
    await expect(switched).rejects.toThrow(/cannot tell[\s\S]*ss -ltnp[\s\S]*rollback site/);
    expect(box.pm2Mutations().some((argv) => argv[0] === "save")).toBe(false);
    expect(box.readState().site).toEqual({ release: NEW, previous: OLD });
  });

  test("something already answering the port is refused before anything starts", async () => {
    const box = siteBox();
    // pm2 runs no site under the configured name (deploy.json names the wrong app),
    // and the old one, started some other way, still answers the port.
    box.processes.clear();
    box.probe = (url) => (url === HEALTH_URL ? HEALTHY : null);
    const switched = switchSite(box.context(), NEW, OPTIONS);
    await expect(switched).rejects.toThrow(/pm2 runs no bcs-site[\s\S]*EADDRINUSE[\s\S]*ss -ltnp[\s\S]*lsof/);
    expect(box.pm2Mutations()).toEqual([]);
    expect(box.readState().site).toEqual({ release: OLD, previous: null });
  });

  test("something still answering once the old site is deleted is refused before the new one starts", async () => {
    const box = siteBox();
    box.probe = (url) => (url === HEALTH_URL ? HEALTHY : null);
    await expect(switchSite(box.context(), NEW, OPTIONS)).rejects.toThrow(/after `pm2 delete bcs-site`[\s\S]*ss -ltnp/);
    expect(box.pm2Mutations()).toEqual([["delete", SITE]]);
    expect(box.readState().site).toEqual({ release: OLD, previous: null });
  });

  test("a port still closing when the old site is deleted is waited for", async () => {
    const box = siteBox();
    let deletedAt: number | null = null;
    box.respond = (command) => {
      if (command.argv.join(" ") === `pm2 delete ${SITE}`) deletedAt = box.now;
      return undefined;
    };
    const siteProbe = box.probe;
    box.probe = (url, now) => (deletedAt !== null && now - deletedAt < 2_000 ? HEALTHY : siteProbe(url, now));
    await switchSite(box.context(), NEW, OPTIONS);
    expect(box.readState().site).toEqual({ release: NEW, previous: OLD });
  });

  test("a dry run says it would check the port and confirm through pm2, and sends nothing", async () => {
    const box = siteBox();
    await switchSite(box.context({ dryRun: true }), NEW, OPTIONS);
    expect(box.pm2Mutations()).toEqual([]);
    expect(box.output()).toContain(`would check that nothing answers ${HEALTH_URL} before ${SITE} starts`);
    expect(box.output()).toContain(`would confirm through pm2 that ${SITE} is online and keeps one pid for 5 s`);
  });
});
