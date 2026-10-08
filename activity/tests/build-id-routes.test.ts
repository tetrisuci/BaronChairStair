/**
 * Which build answered: the header on every response, the field in
 * `/api/config`, and `/api/health`.
 *
 * An open activity compares its own compiled id with these to notice that a
 * newer one is being served, and the deploy reads them to tell the old process
 * from the new one on the same port. A route that forgot the header would make
 * that page look current forever, so this asks for it on the kinds of response
 * that are built in different places: a route, the API's 404 and the client
 * build's fallback.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_ID_HEADER } from "../shared/runtime-status";

/** The shared database every server-importing file names; see `tests/server.test.ts`. */
const DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);

let fetchApp: (request: Request) => Response | Promise<Response>;

beforeAll(async () => {
  process.env.DATABASE_PATH = DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  fetchApp = (await import("../server/index")).entrypoint.fetch;
});

const get = (path: string) => Promise.resolve(fetchApp(new Request(`http://localhost${path}`)));

describe("the build that answered", () => {
  test("/api/config names it, and so does its header", async () => {
    const response = await get("/api/config");
    const body = (await response.json()) as { buildId: unknown };
    expect(typeof body.buildId).toBe("string");
    expect((body.buildId as string).length).toBeGreaterThan(0);
    expect(response.headers.get(BUILD_ID_HEADER)).toBe(body.buildId as string);
  });

  test("/api/health answers ok, with the build and the state", async () => {
    const response = await get("/api/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; buildId: string; state: string };
    expect(body.ok).toBe(true);
    expect(body.buildId).toBe(response.headers.get(BUILD_ID_HEADER)!);
    expect(["starting", "serving", "draining", "stopping"]).toContain(body.state);
  });

  test("/api/health answers under the Discord proxy prefix too", async () => {
    const response = await get("/.proxy/api/health");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("is on every response, the errors and the client build included", async () => {
    const config = (await get("/api/config")).headers.get(BUILD_ID_HEADER);
    for (const path of ["/api/no-such-endpoint", "/api/daily", "/", "/somewhere/in/the/app"]) {
      const response = await get(path);
      await response.arrayBuffer();
      expect({ path, header: response.headers.get(BUILD_ID_HEADER) }).toEqual({ path, header: config });
    }
  });
});
