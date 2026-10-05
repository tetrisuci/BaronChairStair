/**
 * The two routes behind "Hide me on db.tetrisatuci.org".
 *
 * The setting is the one promise the site makes to a player who would rather
 * not be on it, so what these tests pin is narrow and all of it matters: a
 * choice survives the round trip exactly as made, a body that is not a plain
 * yes or no changes nothing, the guest — every guest is one shared row — can
 * never hide or show anybody, and reading the setting never writes. That last
 * one is not tidiness. The site rebuilds whenever the game's database commits,
 * so a GET that wrote would rebuild the site every time somebody opened the
 * settings sheet.
 *
 * The routes are mounted on an app of their own over a store of their own,
 * the way `tests/review-auth.test.ts` mounts the review routes, rather than
 * through `server/index.ts`: that module boots a whole server against the one
 * database every route test in the run shares, and these cases need a database
 * whose every row they put there.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_KEY_PATTERN } from "../shared/site";
// Type-only, so nothing under `server/` is loaded before `beforeAll` has set the
// environment `config` reads once at import.
import type { PlayerProfile, Store as StoreType } from "../server/db";
import type { Variables } from "../server/http";

/** The file every route test names, so whichever file imports `config` first settles on it. */
const SHARED_DB = join(tmpdir(), `puzzle-routes-${process.pid}.sqlite`);
const BASE = "http://localhost";
const ROUTE = "/api/site-visibility";

const ADA: PlayerProfile = { id: "p-ada-test", username: "Ada", avatarUrl: null };
const GUILD = "g-club-test";

let auth: typeof import("../server/auth");
let Store: typeof import("../server/db").Store;
let GUEST_ID: string;
let apiError: typeof import("../server/http").apiError;
let registerSiteVisibilityRoutes: typeof import("../server/site-visibility-routes").registerSiteVisibilityRoutes;

beforeAll(async () => {
  process.env.DATABASE_PATH = SHARED_DB;
  process.env.ALLOW_GUEST_PLAY = "true";
  process.env.NODE_ENV = "test";
  delete process.env.DISCORD_CLIENT_SECRET;
  auth = await import("../server/auth");
  ({ Store } = await import("../server/db"));
  ({ apiError, GUEST_ID } = await import("../server/http"));
  ({ registerSiteVisibilityRoutes } = await import("../server/site-visibility-routes"));
});

let dir: string;
let path: string;
let store: StoreType;
let app: Hono<{ Variables: Variables }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "site-visibility-"));
  path = join(dir, "daily.sqlite");
  store = new Store(path, undefined, { timeZone: "America/Los_Angeles" });
  app = new Hono<{ Variables: Variables }>();
  registerSiteVisibilityRoutes(app, store);
  app.onError(apiError);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function tokenFor(player: PlayerProfile, guildId: string | null = null): Promise<string> {
  return (await auth.mintSession(player, guildId)).token;
}

function call(method: "GET" | "PUT", token?: string, body?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return Promise.resolve(app.fetch(new Request(BASE + ROUTE, { method, headers, body })));
}

interface VisibilityBody {
  hidden: boolean;
  playerKey: string | null;
  hasFinishedDay: boolean;
  serverKey: string | null;
}

async function read(token: string): Promise<VisibilityBody> {
  const response = await call("GET", token);
  expect(response.status).toBe(200);
  return (await response.json()) as VisibilityBody;
}

async function save(token: string, hidden: unknown): Promise<Response> {
  return call("PUT", token, JSON.stringify({ hidden }));
}

function storedChoice(playerId: string): number | null | undefined {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ site_hidden: number | null }, [string]>("SELECT site_hidden FROM players WHERE id = ?1")
      .get(playerId)?.site_hidden;
  } finally {
    db.close();
  }
}

describe("who may ask", () => {
  test("both routes answer 401 without a session", async () => {
    expect((await call("GET")).status).toBe(401);
    expect((await call("PUT", undefined, JSON.stringify({ hidden: true }))).status).toBe(401);
  });

  test("the guest may read, and is refused a save with a sentence saying why", async () => {
    const guest = await tokenFor({ id: GUEST_ID, username: GUEST_ID, avatarUrl: null });

    const shown = await read(guest);
    const refused = await save(guest, true);

    expect(shown).toEqual({ hidden: false, playerKey: null, hasFinishedDay: false, serverKey: null });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "A guest has no name on the site — sign in through Discord to choose",
    );
    expect(storedChoice(GUEST_ID)).toBeUndefined();
  });
});

describe("the setting", () => {
  test("a player who never chose is shown, under their own key", async () => {
    store.upsertPlayer(ADA);

    const body = await read(await tokenFor(ADA));

    expect(body.hidden).toBe(false);
    expect(body.playerKey).toMatch(PUBLIC_KEY_PATTERN);
    expect(body.hasFinishedDay).toBe(false);
    expect(body.serverKey).toBeNull();
    expect(storedChoice(ADA.id)).toBeNull();
  });

  test("a choice survives the round trip, and showing again brings back the same key", async () => {
    store.upsertPlayer(ADA);
    const token = await tokenFor(ADA);
    const before = await read(token);

    const hid = await save(token, true);
    const hiddenBody = (await hid.json()) as VisibilityBody;
    const whileHidden = await read(token);
    const showed = (await (await save(token, false)).json()) as VisibilityBody;

    expect(hid.status).toBe(200);
    expect(hiddenBody).toEqual({ ...before, hidden: true, playerKey: null });
    expect(whileHidden).toEqual(hiddenBody);
    expect(storedChoice(ADA.id)).toBe(0);
    expect(showed).toEqual(before);
  });

  test("a save from a session this database has no row for files the player first", async () => {
    // A session outlives the database it was minted against: a restore from a
    // backup, or a box swapped under a token still in somebody's client.
    const token = await tokenFor(ADA);

    const response = await save(token, true);

    expect(response.status).toBe(200);
    expect(storedChoice(ADA.id)).toBe(1);
  });

  test.each([
    ["a string", JSON.stringify({ hidden: "true" })],
    ["a number", JSON.stringify({ hidden: 1 })],
    ["null", JSON.stringify({ hidden: null })],
    ["a missing field", JSON.stringify({})],
    ["no body at all", undefined],
  ])("%s is a 400 that changes nothing", async (_label, body) => {
    store.upsertPlayer(ADA);

    const response = await call("PUT", await tokenFor(ADA), body);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("hidden must be true or false");
    expect(storedChoice(ADA.id)).toBeNull();
  });
});

describe("the server's key", () => {
  test("is the key of the session's server once the game knows it", async () => {
    store.upsertPlayer(ADA);
    store.siteIdentity.recordGuild(GUILD, "Tetris Club");

    const body = await read(await tokenFor(ADA, GUILD));

    expect(body.serverKey).toBe(store.siteIdentity.serverKey(GUILD));
    expect(body.serverKey).toMatch(PUBLIC_KEY_PATTERN);
  });

  test("is null for a server no run or sign-in has named, and is not drawn by the read", async () => {
    store.upsertPlayer(ADA);

    const body = await read(await tokenFor(ADA, GUILD));

    expect(body.serverKey).toBeNull();
    expect(store.siteIdentity.serverKey(GUILD)).toBeNull();
  });
});

describe("reading writes nothing", () => {
  test("a GET leaves the database's data_version where it was", async () => {
    // `PRAGMA data_version` is what the site's refresher polls, and it moves
    // only when *another* connection commits — which is exactly what a write
    // from this route would be, seen from the site.
    store.upsertPlayer(ADA);
    store.siteIdentity.recordGuild(GUILD, "Tetris Club");
    const token = await tokenFor(ADA, GUILD);
    const site = new Database(path, { readonly: true });
    const version = () => site.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version;
    const before = version();

    await read(token);
    await read(await tokenFor(ADA, "g-never-seen"));

    expect(version()).toBe(before);
    site.close();
  });
});
