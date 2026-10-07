/**
 * The field names of a published line and of the alternates page's body,
 * pinned for both halves.
 *
 * The build writes `/data/alternates.json` and each puzzle body's lines; the
 * page reads them. A field spelt `foundDay` on one side and `day` on the other
 * is a column of dashes that fails nothing, so each shape's keys are spelt out
 * here once, as in `puzzledb-wire-profiles.test.ts`: the type checker refuses a
 * key the shape lacks and a key the shape has that this file does not.
 *
 * **What is not here matters as much.** A line carries the day it was found and
 * never the time, and never anything about who found it; the alternates row
 * leaves the steps out, which the puzzle's own body carries, so the one body
 * that lists every line stays small.
 */

import { describe, expect, test } from "bun:test";
import type { SiteLine } from "../puzzledb/wire";
import type { SiteAlternateRow, SiteAlternatesBody } from "../puzzledb/wire-alternates";

/** Every key of `T`, and only those: an object literal of this type is the key list, checked both ways. */
type EveryKey<T> = { readonly [K in keyof T]-?: true };

const sorted = (keys: object): string[] => Object.keys(keys).sort();

describe("a published line", () => {
  test("carries its position, the day it was found, what it sent and made, and its steps: nothing about who", () => {
    const keys: EveryKey<SiteLine> = { position: true, day: true, attack: true, clears: true, steps: true };

    expect(sorted(keys)).toEqual(["attack", "clears", "day", "position", "steps"]);
  });
});

describe("the alternates body", () => {
  test("a row names its puzzle and position, the day found, attack, length and clears, and no steps", () => {
    const keys: EveryKey<SiteAlternateRow> = {
      puzzleId: true,
      position: true,
      day: true,
      attack: true,
      pieces: true,
      clears: true,
    };
    const row: SiteAlternateRow = { puzzleId: 42, position: 2, day: 274, attack: 10, pieces: 9, clears: ["tsd"] };

    expect(sorted(keys)).toEqual(["attack", "clears", "day", "pieces", "position", "puzzleId"]);
    expect(sorted(row)).toEqual(sorted(keys));
  });

  test("the body is the build time and the rows", () => {
    const keys: EveryKey<SiteAlternatesBody> = { builtAt: true, lines: true };

    expect(sorted(keys)).toEqual(["builtAt", "lines"]);
  });
});
