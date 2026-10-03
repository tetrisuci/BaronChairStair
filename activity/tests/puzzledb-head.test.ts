/**
 * Every page's head, written by the server: what a shared link unfurls with.
 *
 * This is the one place on the server where text an author typed becomes
 * HTML, so two things are held here rather than hoped for.
 *
 * **It is escaped wherever it lands** — the title and every attribute. A
 * puzzle called `"><script>alert(1)</script>` must reach a reader as that
 * title, and the check is a real parser reading the result back, not a search
 * for the escaped spelling, which would pass an escaper that forgot a quote.
 *
 * **It goes in by position, never by `String.replace`.** A replacement string
 * is a little language of its own: `$&` is the match, `` $` `` everything
 * before it and `$'` everything after. A title carrying those, put in with
 * `replace`, splices copies of the template into itself — the page's script
 * tag included — and the control below shows that it does, so the test cannot
 * be passing by accident.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { escapeHtml, HEAD_PLACEHOLDER, injectHead, renderHead } from "../puzzledb/server/head";
import { type PageText, SITE_NAME } from "../puzzledb/wire";

/** A page template as the build writes it: the placeholder in the head, one module script. */
const TEMPLATE = [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="utf-8" />',
  `    ${HEAD_PLACEHOLDER}`,
  '    <script type="module" crossorigin src="/assets/index-abc123.js"></script>',
  "  </head>",
  '  <body><div id="puzzledb" class="pdb"></div></body>',
  "</html>",
].join("\n");

const window = new Window({
  url: "https://local.test/",
  // Parsing only: nothing in a template is fetched or run.
  settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
});

afterAll(async () => {
  // happy-dom holds timers, observers and the whole tree until it is told to stop.
  await window.happyDOM.close();
});

/** The document a browser would build from `html`, entities decoded. */
function parsed(html: string) {
  return new window.DOMParser().parseFromString(html, "text/html");
}

function metaContent(html: string, selector: string): string | null {
  return parsed(html).querySelector(selector)?.getAttribute("content") ?? null;
}

/** How many `<script>` elements an HTML parser finds: a second one is markup that escaped. */
async function scriptTags(html: string): Promise<number> {
  let count = 0;
  await new HTMLRewriter()
    .on("script", {
      element() {
        count += 1;
      },
    })
    .transform(new Response(html))
    .text();
  return count;
}

describe("escaping", () => {
  test("escapes author-typed text in the title and every attribute", async () => {
    const hostile: PageText = {
      title: `"><script>alert(1)</script>`,
      description: `Tom & Jerry's "best" <b>puzzle</b> &amp; more`,
    };

    const html = injectHead(TEMPLATE, renderHead(hostile));
    const page = parsed(html);

    // Read back by a parser, every value is exactly what the author typed.
    expect(page.title).toBe(hostile.title);
    expect(metaContent(html, 'meta[name="description"]')).toBe(hostile.description);
    expect(metaContent(html, 'meta[property="og:title"]')).toBe(hostile.title);
    expect(metaContent(html, 'meta[property="og:description"]')).toBe(hostile.description);
    // And none of it became markup.
    expect(page.querySelectorAll("b")).toHaveLength(0);
    expect(await scriptTags(html)).toBe(1);
  });

  test("escapes the five characters HTML gives meaning, ampersand first", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
    // An entity an author typed stays the text they typed, not the character it names.
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("plain text — and an emoji 🧩")).toBe("plain text — and an emoji 🧩");
  });
});

describe("injection", () => {
  const SPLICERS = "$& and $` and $'";
  const SPLICED_TEXT: PageText = { title: SPLICERS, description: SPLICERS };

  test("injects by position, so a title containing $&, $` or $' arrives literally", async () => {
    const html = injectHead(TEMPLATE, renderHead(SPLICED_TEXT));

    expect(parsed(html).title).toBe(SPLICERS);
    expect(metaContent(html, 'meta[name="description"]')).toBe(SPLICERS);
    expect(await scriptTags(html)).toBe(1);

    // And the bare characters, where a parser would read anything spliced in
    // as markup: the template keeps its one script tag.
    const at = TEMPLATE.indexOf(HEAD_PLACEHOLDER);
    const bare = injectHead(TEMPLATE, SPLICERS);
    expect(bare).toBe(TEMPLATE.slice(0, at) + SPLICERS + TEMPLATE.slice(at + HEAD_PLACEHOLDER.length));
    expect(await scriptTags(bare)).toBe(1);
  });

  test("would notice String.replace, which splices the template into itself", async () => {
    // The controls: the same heads, put in the way this module must not. The
    // title fills with pieces of the template, and `$'` copies everything
    // after the placeholder — the page's script tag included.
    const replacedTitle = parsed(TEMPLATE.replace(HEAD_PLACEHOLDER, renderHead(SPLICED_TEXT))).title;

    expect(replacedTitle).not.toBe(SPLICERS);
    expect(await scriptTags(TEMPLATE.replace(HEAD_PLACEHOLDER, SPLICERS))).toBe(2);
  });

  test("refuses a template without the placeholder, or with two", () => {
    const twice = TEMPLATE.replace("</head>", `${HEAD_PLACEHOLDER}</head>`);

    expect(() => injectHead("<!doctype html><html><head></head></html>", "<title>x</title>")).toThrow(
      /placeholder/,
    );
    expect(() => injectHead(twice, "<title>x</title>")).toThrow(/placeholder/);
  });
});

describe("what a head says", () => {
  test("renders the title, description, og:site_name, og:type, og:title, og:description and twitter:card", () => {
    const text: PageText = { title: "#42 Jelly — Puzzle archive", description: "Hard · difficulty 6. Clear 3 TSTs" };

    const html = injectHead(TEMPLATE, renderHead(text));

    expect(parsed(html).title).toBe(text.title);
    expect(metaContent(html, 'meta[name="description"]')).toBe(text.description);
    expect(metaContent(html, 'meta[property="og:site_name"]')).toBe(SITE_NAME);
    expect(metaContent(html, 'meta[property="og:type"]')).toBe("website");
    expect(metaContent(html, 'meta[property="og:title"]')).toBe(text.title);
    expect(metaContent(html, 'meta[property="og:description"]')).toBe(text.description);
    expect(metaContent(html, 'meta[name="twitter:card"]')).toBe("summary");
    // No image and no canonical URL, so the site needs no setting for its own origin.
    expect(metaContent(html, 'meta[property="og:image"]')).toBeNull();
    expect(metaContent(html, 'meta[property="og:url"]')).toBeNull();
    expect(parsed(html).querySelectorAll("title")).toHaveLength(1);
  });
});
