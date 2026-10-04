/**
 * Each page's `<title>`, description and Open Graph tags, written into the
 * built document on the server.
 *
 * A link to `/puzzle/42` pasted into Discord unfurls from the HTML the server
 * sends, and Discord runs no script, so a page that set its title only in the
 * browser would unfurl as the same nameless page for every puzzle, forever.
 * The text itself comes from `pageText` in `../wire.ts`, the function the page
 * also uses, so the unfurl and the tab always name the same thing; this module
 * only turns that text into HTML and puts it in place.
 *
 * **This is the one place on the server where text an author typed becomes
 * HTML**, and it is escaped once, here, for both of the places it lands: the
 * text of `<title>` and the value of a double-quoted attribute. The same five
 * characters are dangerous in each, so one escaper covers both.
 *
 * **It goes in by position, never by `String.replace`.** A replacement string
 * is a little language — `$&` is the match, `` $` `` everything before it,
 * `$'` everything after — so a title carrying one of those, put in with
 * `replace`, would splice copies of the template into the page, script tag
 * and all. `indexOf` and `slice` have no language to get wrong.
 */

import { type PageText, SITE_NAME } from "../wire";

/**
 * Where the head goes in the built `index.html`.
 *
 * An HTML comment because Vite keeps comments in the documents it builds, so
 * the marker survives the build exactly as written, and a template served
 * without the server — the page's own dev server — loses nothing but a title.
 */
export const HEAD_PLACEHOLDER = "<!--puzzledb:head-->";

const ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/**
 * Text made safe for an HTML text node or a quoted attribute value.
 *
 * One pass with one pattern, so nothing a replacement adds is ever escaped a
 * second time, and every `&` already in the text is: an `&lt;` an author typed
 * reaches the reader as the four characters they typed, not as the `<` it
 * names.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/**
 * The head for one page, every value escaped.
 *
 * No `og:image` and no `og:url`: both must be absolute URLs, which would make
 * the site's own origin a setting, and an unfurl with a title and a
 * description is what v1 promises. A board image is a follow-up of its own.
 */
export function renderHead(text: PageText): string {
  const title = escapeHtml(text.title);
  const description = escapeHtml(text.description);
  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta name="twitter:card" content="summary" />`,
  ].join("\n    ");
}

/**
 * The template with `head` in place of its one placeholder.
 *
 * Throws when the placeholder is missing or appears twice. Either means the
 * build is not the one this server was written against — a template edited
 * by hand, or a build from another checkout — and serving it would put the
 * head nowhere, or twice. A 500 the operator sees in the log is the better
 * failure than a page that quietly unfurls as nothing.
 */
export function injectHead(template: string, head: string): string {
  const at = template.indexOf(HEAD_PLACEHOLDER);
  if (at === -1) {
    throw new Error(`The page template has no ${HEAD_PLACEHOLDER} placeholder; rebuild the page`);
  }
  const end = at + HEAD_PLACEHOLDER.length;
  if (template.indexOf(HEAD_PLACEHOLDER, end) !== -1) {
    throw new Error(`The page template has the ${HEAD_PLACEHOLDER} placeholder more than once`);
  }
  return template.slice(0, at) + head + template.slice(end);
}
