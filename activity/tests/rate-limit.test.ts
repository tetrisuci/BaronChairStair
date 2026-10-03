/**
 * The request limiter, without the configuration it used to come bundled with.
 *
 * It moved out of `server/limits.ts` so the puzzle database can use it: that
 * process must never load `server/config.ts`, which throws under
 * NODE_ENV=production without the game's secrets — the reason
 * `server/tokens.ts` gives for taking its secret as an argument. So the one
 * setting the caller key read from config, whether something in front writes
 * the address headers, is a parameter here, and the last test below proves
 * nothing this module loads can reach config by any route.
 *
 * Driven through a real Hono app rather than a hand-built context, because
 * what matters is what a caller receives — the status, the body and the
 * `Retry-After` the limiter's own response carries through Hono's error
 * handling.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Context, Hono } from "hono";
import { callerKeyFor, rateLimit, type RateLimit } from "../server/rate-limit";

const MINUTE: RateLimit = { max: 2, windowMs: 60_000 };
const START = Date.UTC(2026, 9, 2, 19);

/** What Bun hands Hono as `c.env`: the server, which knows the socket's peer. */
const PEER_ADDRESS = "203.0.113.9";
const peer = { requestIP: () => ({ address: PEER_ADDRESS }) };

afterEach(() => {
  setSystemTime();
});

function limited(limit: RateLimit, keyOf: (c: Context) => string): Hono {
  const app = new Hono();
  app.use("*", rateLimit(limit, keyOf));
  app.get("/", (c) => c.text("ok"));
  return app;
}

/** Keys every request on the header a test chooses, so callers are named outright. */
const byCaller = (c: Context) => c.req.header("X-Caller") ?? "nobody";

function call(app: Hono, caller: string, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request("http://localhost/", { headers: { "X-Caller": caller, ...headers } }), peer),
  );
}

async function keyFor(
  trustProxy: boolean,
  headers: Record<string, string> = {},
  env: unknown = peer,
): Promise<string> {
  const app = new Hono();
  app.get("/", (c) => c.text(callerKeyFor(c, trustProxy)));
  const response = await app.fetch(new Request("http://localhost/", { headers }), env);
  return response.text();
}

describe("the limiter", () => {
  test("lets max through per window, then answers 429 JSON with Retry-After", async () => {
    setSystemTime(START);
    const app = limited(MINUTE, byCaller);

    expect((await call(app, "a")).status).toBe(200);
    expect((await call(app, "a")).status).toBe(200);
    const refused = await call(app, "a");

    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(await refused.json()).toEqual({ error: "Slow down a moment." });
  });

  test("counts each caller separately", async () => {
    setSystemTime(START);
    const app = limited(MINUTE, byCaller);
    await call(app, "a");
    await call(app, "a");

    expect((await call(app, "a")).status).toBe(429);
    expect((await call(app, "b")).status).toBe(200);
  });

  test("starts a new count when the window ends", async () => {
    setSystemTime(START);
    const app = limited(MINUTE, byCaller);
    await call(app, "a");
    await call(app, "a");
    expect((await call(app, "a")).status).toBe(429);

    setSystemTime(START + MINUTE.windowMs - 1);
    expect((await call(app, "a")).status).toBe(429);

    setSystemTime(START + MINUTE.windowMs);
    expect((await call(app, "a")).status).toBe(200);
  });
});

describe("who a request is counted against", () => {
  test("when trusting the proxy, prefers Cf-Connecting-Ip, then the last X-Forwarded-For entry", async () => {
    expect(
      await keyFor(true, { "Cf-Connecting-Ip": "198.51.100.7", "X-Forwarded-For": "192.0.2.1" }),
    ).toBe("ip:198.51.100.7");
    // The leading entries are whatever the client sent; the last is the one
    // our own hop appended.
    expect(await keyFor(true, { "X-Forwarded-For": "192.0.2.1, 10.0.0.2 , 198.51.100.8 " })).toBe(
      "ip:198.51.100.8",
    );
    // A header present but blank is no answer at all.
    expect(await keyFor(true, { "Cf-Connecting-Ip": "  ", "X-Forwarded-For": "198.51.100.9" })).toBe(
      "ip:198.51.100.9",
    );
    expect(await keyFor(true)).toBe(`ip:${PEER_ADDRESS}`);
  });

  test("when not trusting it, ignores both headers and keys on the peer address", async () => {
    // Both headers are mintable by anything that reaches the origin directly.
    expect(
      await keyFor(false, { "Cf-Connecting-Ip": "198.51.100.7", "X-Forwarded-For": "198.51.100.8" }),
    ).toBe(`ip:${PEER_ADDRESS}`);
  });

  test("with no peer to ask, puts every caller in ip:unknown", async () => {
    // The suite drives `fetch` with no server at all, and a runtime may offer
    // a server that cannot say. Null rather than undefined here: undefined
    // would quietly take `keyFor`'s default peer.
    expect(await keyFor(false, {}, null)).toBe("ip:unknown");
    expect(await keyFor(true, {}, {})).toBe("ip:unknown");
  });

  test("never keys on Authorization", async () => {
    // A caller chooses that header, so keying on it would be a fresh bucket per
    // request and no limit at all.
    expect(await keyFor(false, { Authorization: "Bearer one" })).toBe(
      await keyFor(false, { Authorization: "Bearer two" }),
    );

    setSystemTime(START);
    const app = limited(MINUTE, (c) => callerKeyFor(c, false));
    await call(app, "", { Authorization: "Bearer one" });
    await call(app, "", { Authorization: "Bearer two" });

    expect((await call(app, "", { Authorization: "Bearer three" })).status).toBe(429);
  });
});

describe("what the limiter loads", () => {
  /**
   * Every file a module pulls in at run time, by following its relative
   * imports, plus every package it names.
   *
   * `scanImports` drops type-only imports — `import type` and an inline
   * `{ type X }` alike — exactly as Bun's runtime does (measured on Bun 1.3.13
   * with a module whose only job was to log when loaded), so this is the
   * closure that actually runs, not the one the type checker reads.
   */
  function runtimeClosure(entry: string): { files: Set<string>; packages: Set<string> } {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const files = new Set<string>();
    const packages = new Set<string>();
    const pending = [entry];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
        if (path.startsWith(".")) pending.push(Bun.resolveSync(path, dirname(file)));
        else packages.add(path);
      }
    }
    return { files, packages };
  }

  const SERVER = resolve(import.meta.dir, "../server");
  const CONFIG = resolve(SERVER, "config.ts");

  test("imports nothing that loads server/config.ts", () => {
    const { files, packages } = runtimeClosure(resolve(SERVER, "rate-limit.ts"));

    expect([...files].filter((file) => file === CONFIG)).toEqual([]);
    expect([...packages].filter((name) => name !== "hono" && !name.startsWith("hono/"))).toEqual([]);
  });

  test("would notice if it did, because the module it came from does", () => {
    // The check above can only pass vacuously if the walk is broken. Run on the
    // file this code was moved out of, it must find config.
    expect(runtimeClosure(resolve(SERVER, "limits.ts")).files.has(CONFIG)).toBe(true);
  });
});
