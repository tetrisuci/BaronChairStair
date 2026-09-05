/**
 * The vocabulary a goal is written in, and the rules for reading one back.
 *
 * Lifted out of `client/src/ui/builder-state.ts` unchanged. It lived in the
 * builder because the builder was the only thing that needed it — a goal was
 * text on a card, and the counters existed to help an author write the sentence
 * rather than to hold anybody to it.
 *
 * It is here now because the server has to read the same sentence. `Puzzle`
 * carries {@link ClearRequirement}s, and those are derived from exactly this
 * grammar; if the parser and the enforcement could disagree, an author would be
 * held to a rule their own builder never showed them.
 *
 * `goalFits` stayed behind. It is sized by the builder's comment budget, which
 * is a property of the blueprint format and not of goals.
 */

import type { ClearName, ClearRequirement } from "./puzzle";

function clamp(low: number, value: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * What the builder has always called a clear-and-count.
 *
 * The same shape as {@link ClearRequirement}, which is what a puzzle stores —
 * an alias rather than a second interface, so there is no pair to keep in step
 * and no conversion at the boundary between writing a goal and enforcing one.
 */
export type GoalEntry = ClearRequirement;

export interface GoalSpec {
  /** In the order the author added them, which is the order the text reads in. */
  readonly clears: readonly GoalEntry[];
  /** Garbage the solve has to send. 0 when the author has not said. */
  readonly attack: number;
}

export const EMPTY_GOAL: GoalSpec = { clears: [], attack: 0 };

/**
 * What each clear is called in a goal, singular.
 *
 * A `Record<ClearName, string>` rather than a list, so a clear added to the
 * vocabulary is a type error here instead of a type the builder silently cannot
 * name. Title case and "TSD" over "T-spin double" because that is how the
 * archive's own goals are written.
 */
export const GOAL_LABELS: Readonly<Record<ClearName, string>> = {
  single: "Single",
  double: "Double",
  triple: "Triple",
  quad: "Quad",
  tss: "TSS",
  tsd: "TSD",
  tst: "TST",
  tsmini: "T Mini",
  spin: "Spin",
  "perfect clear": "Perfect Clear",
};

/** The ten clears, in the order `ClearName` declares them. */
export const CLEAR_NAMES = Object.keys(GOAL_LABELS) as readonly ClearName[];

/** Two digits in the text, so a count can never crowd out the words around it. */
export const MAX_GOAL_COUNT = 99;
/** Three. The archive's heaviest puzzle sends 81. */
export const MAX_GOAL_ATTACK = 999;

/**
 * The other spellings a real goal uses for the same clear.
 *
 * Read-only tolerance: none of these is ever written back out. "Tetris" and
 * "Mini TSD" both appear in the archive, and a goal typed by hand is as likely
 * to say "PC" as "Perfect Clear".
 */
const EXTRA_CLEAR_ALIASES: readonly (readonly [string, ClearName])[] = [
  ["tetris", "quad"],
  ["pc", "perfect clear"],
  ["tsmini", "tsmini"],
  ["mini", "tsmini"],
  ["mini tsd", "tsmini"],
  ["t-spin mini", "tsmini"],
];

const GOAL_ALIASES: ReadonlyMap<string, ClearName> = new Map([
  ...CLEAR_NAMES.map((clear) => [GOAL_LABELS[clear].toLowerCase(), clear] as const),
  ...EXTRA_CLEAR_ALIASES,
]);

/** "2 TSDs", "1 TSD" — the plural is what makes the sentence read as written. */
function nameCount(entry: GoalEntry): string {
  const label = GOAL_LABELS[entry.clear];
  return `${entry.count} ${entry.count === 1 ? label : `${label}s`}`;
}

/** "a", "a and b", "a, b, and c" — the archive uses the Oxford comma. */
function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? "";
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
}

/**
 * The spec as the sentence a player reads. Empty when there is nothing to say.
 *
 * Counts of zero are dropped rather than printed: "0 Quad" is not a goal, it is
 * a control someone turned back down.
 */
export function formatGoal(spec: GoalSpec): string {
  const phrases = spec.clears.filter((entry) => entry.count > 0).map(nameCount);
  const attack = spec.attack > 0 ? `${spec.attack} attack` : "";
  if (phrases.length === 0) return attack === "" ? "" : `Send ${attack}`;
  return `Clear ${joinPhrases(phrases)}${attack === "" ? "" : ` for ${attack}`}`;
}

const GOAL_VERB = /^(?:clear|send|complete|perform)\s+/i;
const ATTACK_TAIL = /\s+for\s+(\d{1,3})\s+attack$/i;
const ATTACK_ALONE = /^(\d{1,3})\s+attack$/i;
/** ", and " before ", ", or the Oxford comma splits into an empty phrase. */
const GOAL_SEPARATOR = /,\s*and\s+|,\s*|\s+and\s+|\s*\+\s*/i;
const GOAL_PHRASE = /^(\d{1,2})\s*(.+)$/;

function readClear(text: string): ClearName | null {
  const label = text.trim().toLowerCase();
  // Exact first: "Spin" would otherwise be read as a plural and lose its "n".
  return GOAL_ALIASES.get(label) ?? GOAL_ALIASES.get(label.replace(/s$/, "")) ?? null;
}

/**
 * The counts behind a goal sentence, or null when it is prose.
 *
 * Null is the common answer and not a failure: most goals ever written are
 * prose, and the caller's job on null is to leave the text alone.
 */
export function parseGoal(text: string): GoalSpec | null {
  const trimmed = text.trim();
  if (trimmed === "") return EMPTY_GOAL;

  let rest = trimmed.replace(GOAL_VERB, "").trim();
  let attack = 0;
  const tail = ATTACK_TAIL.exec(rest);
  if (tail) {
    attack = Number(tail[1]);
    rest = rest.slice(0, tail.index).trim();
  }

  const alone = ATTACK_ALONE.exec(rest);
  // "Send 18 attack for 18 attack" is not a sentence anybody meant.
  if (alone) return tail ? null : { clears: [], attack: Number(alone[1]) };

  const clears: GoalEntry[] = [];
  for (const part of rest.split(GOAL_SEPARATOR)) {
    const phrase = GOAL_PHRASE.exec(part.trim());
    if (!phrase) return null;
    const count = Number(phrase[1]);
    const clear = readClear(phrase[2]!);
    // A repeat means the sentence says something the counters cannot hold —
    // "2 TSDs then 2 TSDs" is an order, not a total. Left as text.
    if (clear === null || count < 1 || clears.some((entry) => entry.clear === clear)) return null;
    clears.push({ clear, count });
  }
  if (clears.length === 0) return null;
  return { clears, attack };
}

/** A count set, changed or — at zero — taken out. New clears go on the end. */
export function withGoalEntry(spec: GoalSpec, clear: ClearName, count: number): GoalSpec {
  // Zero means "take this clear out"; a negative means somebody typed a stray
  // minus. Folding the two together deleted the row on a typo while an
  // overshoot like 150 was politely clamped — the same control behaving two
  // different ways at its two ends.
  const asked = Math.floor(count);
  const capped = asked < 0 ? 1 : clamp(0, asked, MAX_GOAL_COUNT);
  if (capped === 0) {
    return { ...spec, clears: spec.clears.filter((entry) => entry.clear !== clear) };
  }
  const known = spec.clears.some((entry) => entry.clear === clear);
  return {
    ...spec,
    clears: known
      ? spec.clears.map((entry) => (entry.clear === clear ? { clear, count: capped } : entry))
      : [...spec.clears, { clear, count: capped }],
  };
}

export function withGoalAttack(spec: GoalSpec, attack: number): GoalSpec {
  return { ...spec, attack: clamp(0, Math.floor(attack) || 0, MAX_GOAL_ATTACK) };
}

/** The clears not yet in the goal — what the "add" control is allowed to offer. */
export function unusedClears(spec: GoalSpec): ClearName[] {
  const used = new Set(spec.clears.map((entry) => entry.clear));
  return CLEAR_NAMES.filter((clear) => !used.has(clear));
}

/**
 * The same grammar, forgiving of how goals were actually written.
 *
 * {@link parseGoal} is deliberately strict: its only caller was a text field,
 * and refusing to parse simply left an author's prose alone. As the input to
 * *enforcement* that strictness is a hole rather than a courtesy — 64 of the
 * archive's 138 goals fall through it, and they are the loosest phrasings,
 * which are exactly the puzzles attack-only scoring is easiest to game.
 *
 * The normalisations, each measured against the real archive:
 * - a trailing full stop ("Clear 3 TSDs.")
 * - "a"/"an" for a count of one ("Clear a TSD")
 * - a bare clear name with no count at all ("3 TST" is fine, "TSD + TST" is not)
 * - a digit run into the name ("3TSD")
 *
 * **A trailing parenthetical is stripped only when it carries no refusal.**
 * "Send a TST and TSD (no hold)" parses to the two clears and would then be
 * enforced without the clause that is the whole difficulty of the puzzle — so a
 * parenthetical containing no/not/without/never refuses instead. Losing an
 * enforceable puzzle is the cheaper mistake: it stays exactly as it is today.
 *
 * Order matters and is not obvious. Bare-name expansion runs *after* the verb
 * is stripped, or "Clear TSD + TST" becomes "1 Clear TSD + 1 TST" and fails.
 */
const TRAILING_STOPS = /[.!\s]+$/;
const PARENTHETICAL = /\s*\(([^)]*)\)\s*$/;
const REFUSAL = /\b(?:no|not|without|never|only)\b/i;
const ARTICLE = /\b(?:an?)\s+(?=[A-Za-z])/gi;
const DIGIT_RUN = /\b(\d{1,2})(?=[A-Za-z])/g;

export function parseGoalLoosely(text: string): GoalSpec | null {
  let rest = text.trim().replace(TRAILING_STOPS, "");
  if (rest === "") return null;

  const aside = PARENTHETICAL.exec(rest);
  if (aside) {
    // The clause is a constraint this vocabulary cannot hold. Enforcing what is
    // left would enforce a different, easier puzzle.
    if (REFUSAL.test(aside[1] ?? "")) return null;
    // Stops stripped again, because the first pass ran before this one and a
    // goal like "Send 3 TSDs and a TST.(ZJSOLI…)" keeps its full stop when the
    // blueprint dump behind it comes off. It cost #89 the enforcement it
    // otherwise qualifies for.
    rest = rest.slice(0, aside.index).trim().replace(TRAILING_STOPS, "");
  }

  rest = rest.replace(GOAL_VERB, "").trim();
  rest = rest.replace(DIGIT_RUN, "$1 ");
  rest = rest.replace(ARTICLE, "1 ");

  // A bare clear name, once the count-bearing forms are out of the way. Split on
  // the same separators the strict parser uses so each phrase is judged alone.
  rest = rest
    .split(GOAL_SEPARATOR)
    .map((part) => {
      const phrase = part.trim();
      if (phrase === "" || /^\d/.test(phrase)) return phrase;
      return readClear(phrase) ? `1 ${phrase}` : phrase;
    })
    .join(" and ");

  const parsed = parseGoal(rest);
  // An empty spec is what the strict parser answers for empty text. As a
  // requirement it means nothing, so it is not one.
  return parsed && parsed.clears.length > 0 ? parsed : null;
}
