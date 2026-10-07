/**
 * `prune`: old releases go, through git so the worktree list stays true — but
 * never one that state.json still points at (current or previous, the way back),
 * one a pm2 app is still running from, or the one this tool is running from.
 * The links into shared/ are taken out first, so nothing can follow them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseDir } from "../tools/deploy/layout";
import { prune } from "../tools/deploy/prune";
import { BLUE, BOT, FakeBox, NEW, OLD, START, cleanUpBoxes } from "./deploy-harness";

afterEach(cleanUpBoxes);

const sha = (digit: string) => digit.repeat(40);
const HOUR = 60 * 60_000;

/** Six releases, prepared an hour apart, oldest first; the game runs the newest. */
function boxWithReleases(): { box: FakeBox; releases: string[] } {
  const box = new FakeBox();
  const releases = ["4", "5", "6", "7", "8", "9"].map(sha);
  releases.forEach((release, index) => box.prepareRelease(release, START + index * HOUR));
  box.writeState({
    game: { activeSlot: BLUE, release: sha("9"), previous: sha("8") },
    site: { release: sha("9"), previous: sha("8") },
    bot: { release: sha("9"), previous: sha("8") },
  });
  return { box, releases };
}

function removed(box: FakeBox): string[] {
  return box.mutations()
    .filter((argv) => argv[3] === "worktree" && argv[4] === "remove")
    .map((argv) => argv[6]!);
}

describe("pruning", () => {
  test("keeps the newest N and everything state points at; removes the rest through git", async () => {
    const { box } = boxWithReleases();
    await prune(box.context(), 3);
    expect(removed(box)).toEqual([releaseDir(box.layout, sha("4")), releaseDir(box.layout, sha("5")), releaseDir(box.layout, sha("6"))]);
    expect(box.mutations().at(-1)).toEqual(["git", "-C", box.layout.repo, "worktree", "prune"]);
  });

  test("never removes a release state still names, however old", async () => {
    const { box } = boxWithReleases();
    box.writeState({
      game: { activeSlot: BLUE, release: sha("9"), previous: sha("4") },
      site: { release: sha("9"), previous: null },
      bot: { release: sha("9"), previous: null },
    });
    await prune(box.context(), 1);
    expect(removed(box)).not.toContain(releaseDir(box.layout, sha("4")));
    expect(removed(box)).not.toContain(releaseDir(box.layout, sha("9")));
  });

  test("never removes a release a pm2 app is running from, even one state has moved past", async () => {
    const { box } = boxWithReleases();
    box.addProcess(BOT, releaseDir(box.layout, sha("5")));
    await prune(box.context(), 1);
    expect(removed(box)).not.toContain(releaseDir(box.layout, sha("5")));
  });

  test("never removes the release the tool itself runs from", async () => {
    const { box } = boxWithReleases();
    await prune(box.context({ selfRelease: releaseDir(box.layout, sha("6")) }), 1);
    expect(removed(box)).not.toContain(releaseDir(box.layout, sha("6")));
  });

  test("unlinks the shared files before removing a release", async () => {
    const { box } = boxWithReleases();
    const doomed = releaseDir(box.layout, sha("4"));
    const sharedEnv = join(box.layout.shared, "activity.env");
    symlinkSync(sharedEnv, join(doomed, "activity", ".env"));
    symlinkSync(join(box.layout.shared, "bot.env"), join(doomed, ".env"));
    const linksAtRemoval: boolean[] = [];
    box.respond = (command) => {
      if (command.argv.includes("remove") && command.argv.includes(doomed)) {
        linksAtRemoval.push(existsSync(join(doomed, "activity", ".env")), existsSync(join(doomed, ".env")));
      }
      return undefined;
    };
    await prune(box.context(), 3);
    expect(linksAtRemoval).toEqual([false, false]);
    expect(existsSync(sharedEnv)).toBe(true);
    expect(existsSync(join(box.layout.shared, "bot.env"))).toBe(true);
  });

  test("a dry run removes nothing", async () => {
    const { box, releases } = boxWithReleases();
    await prune(box.context({ dryRun: true }), 1);
    expect(box.calls.filter((call) => call.mutates)).toEqual([]);
    for (const release of releases) expect(existsSync(releaseDir(box.layout, release))).toBe(true);
    expect(box.output()).toContain("would run: git -C");
  });

  test("ignores anything in releases/ that is not a release", async () => {
    const { box } = boxWithReleases();
    writeFileSync(join(box.layout.releases, "notes.txt"), "");
    await prune(box.context(), 3);
    expect(removed(box).some((dir) => dir.endsWith("notes.txt"))).toBe(false);
  });

  test("with only the releases in use, removes nothing", async () => {
    const box = new FakeBox();
    box.prepareRelease(OLD);
    box.prepareRelease(NEW);
    box.writeState({ game: { activeSlot: BLUE, release: NEW, previous: OLD } });
    await prune(box.context(), 0);
    expect(removed(box)).toEqual([]);
  });
});
