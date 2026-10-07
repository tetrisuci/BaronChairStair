/**
 * The game's build names itself, twice: compiled into the client, and written
 * beside it as `build.json`.
 *
 * The two have to agree. The server reads `build.json` at boot and sends it as
 * `X-Build-Id` on every response; a page compiled from a different build sees
 * a different id and offers a reload. So one id, resolved once per build, goes
 * into both — and this checks the resolving, the file, and that the config
 * actually wires both halves to it, without running a build (which takes
 * seconds and writes a directory; the deploy guide runs the real one).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import viteConfig, { BUILD_ID_DEFINE, buildIdPlugin, resolveBuildId, writeBuildIdFile } from "../vite.config";
import { BUILD_ID_FILE } from "../shared/runtime-status";
import { DEV_BUILD_ID } from "../client/src/build-id";

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "build-id-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("resolveBuildId", () => {
  test("BUILD_ID wins when the deploy sets it", () => {
    expect(resolveBuildId({ BUILD_ID: "0fcedc3" }, () => "a1b2c3d")).toBe("0fcedc3");
  });

  test("surrounding whitespace is not part of it", () => {
    expect(resolveBuildId({ BUILD_ID: " 0fcedc3\n" }, () => null)).toBe("0fcedc3");
  });

  test("without it, the checkout's commit", () => {
    expect(resolveBuildId({}, () => "a1b2c3d")).toBe("a1b2c3d");
    expect(resolveBuildId({ BUILD_ID: "" }, () => "a1b2c3d")).toBe("a1b2c3d");
  });

  test("without either, dev — which never offers an update", () => {
    expect(resolveBuildId({}, () => null)).toBe(DEV_BUILD_ID);
  });

  test("a commit that is not an id is dev rather than a header nobody can send", () => {
    expect(resolveBuildId({}, () => "fatal: not a git repository")).toBe(DEV_BUILD_ID);
  });

  test("a BUILD_ID that is not an id stops the build instead of shipping it", () => {
    expect(() => resolveBuildId({ BUILD_ID: "release 12" }, () => null)).toThrow(/BUILD_ID/);
    expect(() => resolveBuildId({ BUILD_ID: "x".repeat(65) }, () => null)).toThrow(/BUILD_ID/);
  });
});

describe("build.json", () => {
  test("holds the id and nothing else", () => {
    const dir = join(scratch, "plain");
    writeBuildIdFile(dir, "0fcedc3");

    expect(JSON.parse(readFileSync(join(dir, BUILD_ID_FILE), "utf8"))).toEqual({ buildId: "0fcedc3" });
  });

  test("is written whole, with no temporary file left beside it", () => {
    const dir = join(scratch, "whole");
    writeBuildIdFile(dir, "a1b2c3d");
    writeBuildIdFile(dir, "e4f5a6b");

    expect(readdirSync(dir)).toEqual([BUILD_ID_FILE]);
    expect(JSON.parse(readFileSync(join(dir, BUILD_ID_FILE), "utf8")).buildId).toBe("e4f5a6b");
  });

  test("the plugin writes it into the directory the bundle was written to", async () => {
    const dir = join(scratch, "plugin");
    const plugin = buildIdPlugin("0fcedc3");
    const hook = plugin.writeBundle as unknown as (this: unknown, options: { dir?: string }) => void | Promise<void>;

    await hook.call(null, { dir });

    expect(JSON.parse(readFileSync(join(dir, BUILD_ID_FILE), "utf8"))).toEqual({ buildId: "0fcedc3" });
  });

  test("the plugin runs only for a build, never for the dev server", () => {
    expect(buildIdPlugin("0fcedc3").apply).toBe("build");
  });

  test("an output with no directory is refused rather than written somewhere else", () => {
    const hook = buildIdPlugin("0fcedc3").writeBundle as unknown as (this: unknown, options: { dir?: string }) => void;

    expect(() => hook.call(null, {})).toThrow(/directory/);
  });
});

describe("the game's config", () => {
  const plugins = (viteConfig.plugins ?? []) as Plugin[];
  const plugin = plugins.find((candidate) => candidate?.name === buildIdPlugin("x").name);
  const define = viteConfig.define ?? {};

  test("compiles the id into the client under the name build-id.ts reads", () => {
    expect(BUILD_ID_DEFINE).toBe("__BUILD_ID__");
    const compiled = define[BUILD_ID_DEFINE];
    expect(typeof compiled).toBe("string");
    expect(JSON.parse(compiled as string)).toBe(resolveBuildId());
    expect(readFileSync("client/src/build-id.ts", "utf8")).toContain(BUILD_ID_DEFINE);
  });

  test("writes build.json with the same id it compiled in", async () => {
    expect(plugin).toBeDefined();
    const dir = join(scratch, "config");
    const hook = plugin!.writeBundle as unknown as (this: unknown, options: { dir?: string }) => void;

    await hook.call(null, { dir });

    const written = JSON.parse(readFileSync(join(dir, BUILD_ID_FILE), "utf8")).buildId;
    expect(written).toBe(JSON.parse(define[BUILD_ID_DEFINE] as string));
  });

  test("still builds the review page with the game", () => {
    const input = viteConfig.build?.rollupOptions?.input as Record<string, string>;

    expect(Object.keys(input).sort()).toEqual(["main", "review"]);
  });
});
