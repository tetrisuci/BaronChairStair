/**
 * Connecting to Discord, or standing in for it.
 *
 * Inside Discord the activity runs in an iframe that hands us an instance id
 * and expects an OAuth handshake. Outside it — the local dev server — there is
 * no handshake, so the server hands out a guest identity instead. Everything
 * downstream sees the same shape either way.
 */

import { DiscordSDK } from "@discord/embedded-app-sdk";
import { Api, type PlayerProfile } from "./api";

/** Discord serves the activity from its own origin and proxies through here. */
const PROXY_PREFIX = "/.proxy";

export interface Connection {
  readonly api: Api;
  readonly player: PlayerProfile;
  readonly guildId: string | null;
  readonly inDiscord: boolean;
  readonly guest: boolean;
}

/**
 * Names the stage a failure happened in.
 *
 * The handshake is four round trips to two different services, and every one of
 * them fails with a message that means nothing on its own — "Unexpected error",
 * "invalid_grant". Which step it came from is most of the diagnosis.
 */
async function step<T>(stage: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const detail =
      cause instanceof Error
        ? cause.message
        : typeof (cause as { message?: unknown })?.message === "string"
          ? String((cause as { message: string }).message)
          : String(cause);
    throw new Error(`Failed while ${stage}: ${detail}`, { cause });
  }
}

/**
 * Discord always launches the activity with a `frame_id` query parameter, so
 * its presence is a reliable signal without probing the RPC channel first.
 */
function looksLikeDiscord(): boolean {
  return new URLSearchParams(window.location.search).has("frame_id");
}

async function connectToDiscord(api: Api, clientId: string): Promise<Connection> {
  if (!clientId) {
    throw new Error(
      "The server has no DISCORD_CLIENT_ID configured, so the activity cannot sign in.",
    );
  }

  const sdk = new DiscordSDK(clientId);
  await step("connecting to Discord", () => sdk.ready());

  const { code } = await step("authorising", () => sdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    // `identify` names the player on the leaderboard; `guilds` lets the server
    // confirm they are really in the server whose leaderboard they are writing
    // to. Neither is used for anything else.
    scope: ["identify", "guilds"],
  }));

  const session = await step("signing in", () => api.session({ code, guildId: sdk.guildId }));
  api.setToken(session.token);

  if (session.accessToken) {
    await step("handing the token back to Discord", () =>
      sdk.commands.authenticate({ access_token: session.accessToken! }),
    );
  }

  return {
    api,
    player: session.player,
    guildId: sdk.guildId,
    inDiscord: true,
    guest: session.guest,
  };
}

async function connectAsGuest(api: Api): Promise<Connection> {
  const session = await api.session({});
  api.setToken(session.token);
  return {
    api,
    player: session.player,
    guildId: null,
    inDiscord: false,
    guest: true,
  };
}

export async function connect(): Promise<Connection> {
  const inDiscord = looksLikeDiscord();
  const api = new Api(inDiscord ? PROXY_PREFIX : "");
  const { clientId } = await api.config();
  return inDiscord ? connectToDiscord(api, clientId) : connectAsGuest(api);
}
