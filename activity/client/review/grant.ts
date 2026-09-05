/**
 * Taking the link out of the address bar.
 *
 * Its own module for one reason: `main.ts` boots on import, so nothing in it
 * can be driven by a test — and this is the one step of the whole sitting that
 * has to happen exactly once, in exactly this order, before anything is
 * awaited.
 */

/**
 * The grant from `#t=`, removed from the bar on the way past.
 *
 * **A fragment, not a query.** A browser never puts the fragment in the request
 * line, so the token cannot reach nginx's or Caddy's access log, the tunnel's
 * log, or whatever ships those somewhere central. Every other copy of the link
 * is one somebody can be careful with — a DM, a screenshot, a bookmark — and a
 * log entry is the one nobody can, because it is written by default, kept for
 * months, and read by whoever has the box. `?t=` was in every one of them.
 *
 * `replaceState` before a single request goes out. The bar is the last copy of
 * the link this page can do anything about, and none of those copies care that
 * the token has already been spent, because spending it is not what makes it
 * useless: it is a bearer capability with nothing written down behind it and it
 * works until it expires, for anybody.
 *
 * `pathname` alone and not `pathname + search + hash`: dropping both is the
 * entire point, and this page has neither a query nor a hash of its own to
 * carry forward.
 *
 * It is also why the review tool renders no outbound links at all. With one,
 * the token would ride out in a `Referer` to whoever owned that link, and the
 * only thing standing in the way is the header `server/static-routes.ts` sets
 * — which a proxy is free to drop.
 *
 * `?t=` is still read, once, for a link minted by an older build that somebody
 * is holding right now. It is the same token either way; only where it travels
 * differs, and refusing it would strand an officer mid-shift for no gain.
 */
export function takeGrant(): string | null {
  // `slice(1)` past the `#`. `URLSearchParams` is happy to parse `t=…` on its
  // own, and the hash is written by `review-link.ts` in exactly that shape.
  const fragment = new URLSearchParams(window.location.hash.slice(1)).get("t");
  const grant = fragment ?? new URLSearchParams(window.location.search).get("t");
  if (!grant) return null;
  window.history.replaceState(null, "", window.location.pathname);
  return grant;
}
