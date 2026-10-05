/**
 * Which Discord server's board is on screen: a row of chips, and the address
 * that remembers the choice.
 *
 * Boards are per server, as in the game, and the choice lives in the query
 * string as `?server=<key>` so that a link to a server's board opens on that
 * board. It is a filter rather than a page: one more page identity per server
 * would mean one more thing that can 404, and v1 already settled that a
 * filter belongs in the query (`wire.ts`, `PageRoute`). A key the index does
 * not know — mistyped, or a server whose rows a rebuild no longer carries — is
 * read as "All servers" rather than as an empty board, which is the browse
 * filter's rule for junk in the address too.
 *
 * Chips are buttons with `aria-pressed`, the game's way of saying which of a
 * row of peers is on (`.btn--primary` for the eye, the attribute for a screen
 * reader). A server's label is {@link serverLabel}: its Discord name, or
 * "Unnamed server" and the start of its key.
 */

import { el } from "../../client/src/ui/dom";
import { ALL_SERVERS, type SiteServer } from "../wire";
import { serverLabel } from "./board-rows";
import type { SiteIndex } from "./data";

const PARAM = "server";

/** The server the address names, when the index knows it; null — every server — otherwise. */
export function serverFromQuery(search: string, index: Pick<SiteIndex, "serverByKey">): string | null {
  const key = new URLSearchParams(search).get(PARAM);
  return key !== null && key !== ALL_SERVERS && index.serverByKey.has(key) ? key : null;
}

/** The query string for a choice: `?server=<key>`, or nothing for every server. */
export function queryForServer(server: string | null): string {
  return server === null ? "" : `?${new URLSearchParams({ [PARAM]: server })}`;
}

/**
 * "All servers", then each server, the current one pressed. A press redraws
 * the chips at once and hands the choice to `onPick`; pressing the chip that
 * is already on does nothing.
 */
export function serverChips(
  servers: readonly SiteServer[],
  current: string | null,
  onPick: (server: string | null) => void,
): HTMLElement {
  const row = el("div", { class: "boards__tabs pdb-chips", attrs: { role: "group", "aria-label": "Server" } });
  const choices: readonly { readonly key: string | null; readonly label: string }[] = [
    { key: null, label: "All servers" },
    ...servers.map((server) => ({ key: server.key, label: serverLabel(server) })),
  ];
  const draw = (on: string | null) => {
    row.replaceChildren(
      ...choices.map((choice) =>
        el("button", {
          class: `btn btn--small${choice.key === on ? " btn--primary" : ""}`,
          text: choice.label,
          attrs: { type: "button", "aria-pressed": String(choice.key === on) },
          on: {
            click: () => {
              if (choice.key === on) return;
              draw(choice.key);
              onPick(choice.key);
            },
          },
        }),
      ),
    );
  };
  draw(current);
  return row;
}

/** The index's servers that `keys` names, in the index's order (by name, unnamed last). */
export function serversAmong(index: Pick<SiteIndex, "data">, keys: ReadonlySet<string>): SiteServer[] {
  return index.data.servers.filter((server) => keys.has(server.key));
}
