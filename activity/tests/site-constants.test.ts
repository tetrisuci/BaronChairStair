/**
 * The names db.tetrisatuci.org gives players and servers, and the one name it
 * must never give anybody.
 *
 * A public key is the only handle the site has on a person, so its shape is a
 * privacy rule rather than a style: the v1 leak scans look for any run of
 * seventeen digits, because that is what a Discord id looks like, and those
 * scans stay meaningful only while no key the site prints can contain one.
 * The alphabet is also the one a human copies a link out of, which is why the
 * look-alike characters are missing from it, and these tests pin both.
 */

import { describe, expect, test } from "bun:test";
import { GUEST_ID as HTTP_GUEST_ID } from "../server/http";
import {
  GUEST_ID,
  PUBLIC_KEY_ALPHABET,
  PUBLIC_KEY_LENGTH,
  PUBLIC_KEY_PATTERN,
  SITE_ORIGIN,
} from "../shared/site";

/** A key of the right shape, drawn the way the game will draw one. */
function keyLike(seed: number): string {
  let key = "";
  let state = seed;
  for (let i = 0; i < PUBLIC_KEY_LENGTH; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    key += PUBLIC_KEY_ALPHABET[state % PUBLIC_KEY_ALPHABET.length];
  }
  return key;
}

describe("the public key alphabet", () => {
  test("leaves out every character a reader could mistake for another", () => {
    for (const lookalike of ["0", "1", "i", "l", "o"]) {
      expect(PUBLIC_KEY_ALPHABET).not.toContain(lookalike);
    }
  });

  test("is lower case, has no repeats, and is the 31 characters the pattern admits", () => {
    expect(PUBLIC_KEY_ALPHABET).toBe(PUBLIC_KEY_ALPHABET.toLowerCase());
    expect(new Set(PUBLIC_KEY_ALPHABET).size).toBe(PUBLIC_KEY_ALPHABET.length);
    expect(PUBLIC_KEY_ALPHABET).toHaveLength(31);
    expect(PUBLIC_KEY_LENGTH).toBe(10);
    // Every character of the alphabet is one the pattern takes, and nothing else is.
    for (let code = 0x20; code < 0x7f; code++) {
      const ch = String.fromCharCode(code);
      expect(PUBLIC_KEY_PATTERN.test(ch.repeat(PUBLIC_KEY_LENGTH))).toBe(PUBLIC_KEY_ALPHABET.includes(ch));
    }
  });
});

describe("the public key pattern", () => {
  test("accepts keys of the generated shape", () => {
    const keys = Array.from({ length: 200 }, (_, i) => keyLike(i + 1));

    expect(keys.filter((key) => !PUBLIC_KEY_PATTERN.test(key))).toEqual([]);
    expect(PUBLIC_KEY_PATTERN.test("23456789ab")).toBe(true);
    expect(PUBLIC_KEY_PATTERN.test("zyxwvutsrq")).toBe(true);
  });

  test("rejects every other shape, so a stray path is a 404 and not a lookup", () => {
    const strays = [
      "",
      "23456789a",
      "23456789abc",
      "23456789AB",
      "0123456789",
      "1abcdefghj",
      "abcdefghjl",
      "abcdefghjo",
      "abcdefghji",
      "abcdefghj ",
      " abcdefghj",
      "abcdefghj\n",
      "abcdefghj-",
      "12345678901234567",
      "guest",
    ];

    expect(strays.filter((key) => PUBLIC_KEY_PATTERN.test(key))).toEqual([]);
  });

  test("is anchored, so it cannot match a key inside a longer string", () => {
    expect(PUBLIC_KEY_PATTERN.test("/player/23456789ab")).toBe(false);
    expect(PUBLIC_KEY_PATTERN.test("23456789ab23456789ab")).toBe(false);
  });

  test("admits no key that could hold a Discord id's run of seventeen digits", () => {
    // Shorter than the run, so this holds for any choice of characters — and
    // the v1 `/\d{17,}/` leak scans keep working on everything the site prints.
    expect(PUBLIC_KEY_LENGTH).toBeLessThan(17);
    const allDigits = "23456789".repeat(3).slice(0, PUBLIC_KEY_LENGTH);
    expect(PUBLIC_KEY_PATTERN.test(allDigits)).toBe(true);
    expect(/\d{17,}/.test(allDigits)).toBe(false);
  });
});

describe("the other names the two halves share", () => {
  test("the site lives at one origin, with no trailing slash to double up a path", () => {
    expect(SITE_ORIGIN).toBe("https://db.tetrisatuci.org");
    expect(new URL(`${SITE_ORIGIN}/leaderboards`).pathname).toBe("/leaderboards");
  });

  test("the guest identity is one string, and the game's HTTP layer hands out the same one", () => {
    expect(GUEST_ID).toBe("guest");
    expect(HTTP_GUEST_ID).toBe(GUEST_ID);
    // Never a key: a guest has no page on the site.
    expect(PUBLIC_KEY_PATTERN.test(GUEST_ID)).toBe(false);
  });
});
