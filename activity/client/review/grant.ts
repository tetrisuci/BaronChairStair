/**
 * Taking the link out of the address bar.
 *
 * Its own module for one reason: `main.ts` boots on import, so nothing in it
 * can be driven by a test — and this is the one step of the whole sitting that
 * has to happen exactly once, in exactly this order, before anything is
 * awaited.
 */

/**
 * The grant from `?t=`, removed from the bar on the way past.
 *
 * `replaceState` before a single request goes out. The bar is the last copy of
 * the link this page can do anything about — a screenshot of the queue, a
 * bookmark, somebody reading over a shoulder — and none of those care that the
 * token has already been spent, because spending it is not what makes it
 * useless: it is a bearer capability with nothing written down behind it and it
 * works until it expires, for anybody.
 *
 * `pathname` and not `pathname + search + hash`: dropping the query string is
 * the entire point, and this page has no hash of its own to carry forward.
 *
 * It is also why the review tool renders no outbound links at all. With one,
 * the token would ride out in a `Referer` to whoever owned that link, and the
 * only thing standing in the way is the header `server/static-routes.ts` sets
 * — which a proxy is free to drop.
 */
export function takeGrant(): string | null {
  const grant = new URLSearchParams(window.location.search).get("t");
  if (!grant) return null;
  window.history.replaceState(null, "", window.location.pathname);
  return grant;
}
