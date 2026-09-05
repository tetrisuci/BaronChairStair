/**
 * One archived puzzle's metadata, with the source underneath it.
 *
 * The form half of the archive tab. Five fields, each showing what is in force
 * and — when a correction has changed it — what the source says beside it, so
 * "what has somebody changed here" is answered by looking rather than by
 * remembering. Puzzle #12's title is either one string or two, and two means
 * somebody edited it.
 *
 * **The source is not the same thing for both kinds of puzzle**, and the form
 * deliberately does not say which it is looking at: a club puzzle's source is a
 * row of the sheet `bun run puzzles` rebuilds from, a player's is the
 * submission they filed. Naming that would be telling an officer something they
 * cannot act on — the correction is written the same way either way — and the
 * list beside this already says `club` or `player` on every row.
 *
 * **Nothing here decides what is legal.** The server holds a corrected title to
 * exactly the rule an author's title is held to, and its refusal is what the
 * officer is shown, word for word. The two checks this form makes are about the
 * form itself: an emptied box, which has no meaning the route can express, and
 * a rating outside the scale, which is worth catching before a round trip.
 *
 * Author-written and officer-written text is set with `textContent`. See
 * `queue.ts` for the whole of that rule.
 */

import { MAX_DIFFICULTY, MIN_DIFFICULTY } from "@shared/archive-filter";
import { dailyTierOf } from "@shared/daily";
import { el, panel } from "../src/ui/dom";
import type { PuzzleChanges, ReviewPuzzle } from "./api";
import { filedOn } from "./format";

/**
 * The caps `server/submission-input.ts` holds these same four fields to.
 *
 * Written out rather than imported, the same trade `MAX_NOTE` in `detail.ts`
 * makes: those constants live in a module that imports Hono and the override
 * store, and dragging the request path into a browser bundle to size four text
 * boxes would be far worse than four numbers living in two places. The server
 * is still the authority; these only stop a box taking text it would refuse.
 */
const MAX_TITLE = 60;
const MAX_AUTHOR = 40;
const MAX_GOAL = 120;
const MAX_SET = 40;

/**
 * The one consequence of this form that is not just typing, said once.
 *
 * `dailyTierOf` reads the difficulty, `byTier` partitions the archive with it,
 * and the daily rotation is an index into those pools derived from their size —
 * so a re-rating really does change which puzzle a future day deals. It cannot
 * touch a day anybody has played, because `day_puzzles` writes a day down the
 * first time anybody asks for it.
 */
const DIFFICULTY_NOTE =
  "Changing this moves the puzzle between the easy, medium and hard pools that future days " +
  "are dealt from; a day anybody has already played is written down and does not move.";

/**
 * Why the set box cannot be emptied.
 *
 * NULL means "use the source" in all five columns, so there is no way to say
 * "no set" — a sentinel string was the alternative and it loses twice: it is a
 * set name somebody could genuinely type, and it would make NULL mean one thing
 * in four columns and two in the fifth. See `OverrideFields`.
 */
const SET_NOTE =
  "A puzzle cannot be corrected out of a set here — an empty correction is how a field says " +
  "“use the source” — so taking one out of a set is a change to the club's sheet.";

const UNEDITABLE_NOTE =
  "Board, queue, hold, target and solution are not corrected here. A run is filed against a " +
  "puzzle id with no record of the board it was played on, so changing one of those would " +
  "rewrite what every solve already on the leaderboard was worth.";

/** What every write here has to end by saying, because none of them are live. */
const AT_NEXT_RESTART = "Players see it when the server next restarts.";

type TextField = "title" | "author" | "goal" | "set";
type Field = TextField | "difficulty";

interface TextSpec {
  readonly field: TextField;
  readonly label: string;
  readonly max: number;
  /**
   * The body that puts this one field back to its source.
   *
   * A literal object per field rather than `{ [spec.field]: null }`, because a
   * computed key over a union of names types out as an index signature and
   * gives up exactly the check that matters — that a correction names one of
   * the five fields the route will accept.
   */
  readonly revert: PuzzleChanges;
  readonly note: string | null;
}

/**
 * The four text fields, in the order they are shown.
 *
 * Difficulty is not in the list and is built on its own below. It is not the
 * same kind of field: it is a number where these are strings, it carries a
 * scale the server enforces, and it is the only one with a consequence beyond
 * the puzzle's own row — so it sits last, next to the sentence that says so.
 */
const TEXT_FIELDS: readonly TextSpec[] = [
  { field: "title", label: "Title", max: MAX_TITLE, revert: { title: null }, note: null },
  { field: "author", label: "Author", max: MAX_AUTHOR, revert: { author: null }, note: null },
  { field: "goal", label: "Goal", max: MAX_GOAL, revert: { goal: null }, note: null },
  { field: "set", label: "Set", max: MAX_SET, revert: { set: null }, note: SET_NOTE },
];

/**
 * What the puzzle says now, and what its source says, as text on both sides.
 *
 * Two records rather than five pairs of lookups, because every row of this form
 * asks both questions together: the box is filled from `live`, and `source`
 * decides whether there is anything to show beside it and whether that field
 * gets a Revert. Difficulty is a string here like the rest — the boxes hold
 * text, and one comparison rule across five fields is one rule to get right.
 */
/** Everybody who has corrected a field of this puzzle, in the order they did. */
function correctors(puzzle: ReviewPuzzle): string {
  const seen: string[] = [];
  for (const { by } of Object.values(puzzle.correctedBy)) {
    if (!seen.includes(by)) seen.push(by);
  }
  if (seen.length === 0) return "somebody";
  if (seen.length === 1) return seen[0]!;
  return `${seen.slice(0, -1).join(", ")} and ${seen[seen.length - 1]}`;
}

function valuesOf(puzzle: ReviewPuzzle): Readonly<Record<"live" | "source", Record<Field, string>>> {
  return {
    live: {
      title: puzzle.title,
      author: puzzle.author,
      goal: puzzle.goal,
      set: puzzle.set ?? "",
      difficulty: String(puzzle.difficulty),
    },
    source: {
      title: puzzle.original.title,
      author: puzzle.original.author,
      goal: puzzle.original.goal,
      set: puzzle.original.set ?? "",
      difficulty: String(puzzle.original.difficulty),
    },
  };
}

/**
 * The rule `readReviewedDifficulty` will hold a corrected rating to.
 *
 * The range and finiteness, and deliberately not `Number.isInteger` — which is
 * what the decision panel checks when an officer rates a *submission*. The
 * archive's column is REAL and the server does not round, so a form demanding a
 * whole number would be stricter than the rule it stands in for, and could
 * refuse to save a puzzle whose rating it had just shown.
 */
function inScale(difficulty: number): boolean {
  return (
    Number.isFinite(difficulty) && difficulty >= MIN_DIFFICULTY && difficulty <= MAX_DIFFICULTY
  );
}

interface Row {
  readonly element: HTMLElement;
  /** Null when the field matches its source and there is nothing to put back. */
  readonly revert: HTMLButtonElement | null;
}

/**
 * One field: its label, its box, what the source says, and the way back.
 *
 * The Revert button exists only where the two differ. A correction that repeats
 * its source is still recorded by the route — it does not normalise one away —
 * but there is nothing to show for it and nothing an officer would want back,
 * so it reads here as an uncorrected field. Revert all is the way out of one.
 *
 * It sends one field and sends it at once, so typing left unsaved in the other
 * boxes goes with the rebuild that follows. That is the chosen half of the
 * trade: carrying the pending edits along would make Revert also a Save, which
 * is a button doing two things, and a confirm step would be a second answer to
 * a question the officer already answered by clicking it.
 */
function editRow(options: {
  readonly label: string;
  readonly box: HTMLInputElement;
  /** Shown after the box; the tier readout, on the one row that has one. */
  readonly beside: HTMLElement | null;
  /** The source's own value, or null when it is what the box already holds. */
  readonly source: string | null;
  readonly onRevert: () => void;
  readonly note: string | null;
}): Row {
  const revert =
    options.source === null
      ? null
      : el("button", {
          class: "btn btn--small",
          text: "Revert",
          attrs: { type: "button" },
          on: { click: options.onRevert },
        });

  return {
    revert,
    element: el(
      "div",
      { class: "review__edit" },
      el("span", { class: "explore__label", text: options.label }),
      el("span", { class: "explore__controls" }, options.box, options.beside),
      revert,
      options.source === null
        ? null
        : el("span", {
            class: "review__was",
            // An empty source is only ever the set field, and "none" is what it
            // means — a puzzle the club's sheet never put in a set.
            text: options.source === "" ? "source: none" : `source: ${options.source}`,
          }),
      options.note ? el("p", { class: "review__note", text: options.note }) : null,
    ),
  };
}

export interface CorrectionHandlers {
  onSave(changes: PuzzleChanges): Promise<ReviewPuzzle>;
  onRevert(): Promise<{ reverted: boolean; puzzle: ReviewPuzzle }>;
  /** What came back, and the sentence to show the officer beside it. */
  onSaved(puzzle: ReviewPuzzle, said: string): void;
}

/** What the officer has altered, and what stops it being sent. */
interface Reading {
  readonly changes: PuzzleChanges;
  readonly refusal: string | null;
  /** Whether anything at all differs from what is in force. */
  readonly touched: boolean;
}

export function createCorrectionView(
  puzzle: ReviewPuzzle,
  handlers: CorrectionHandlers,
  flash?: string,
): HTMLElement {
  const values = valuesOf(puzzle);

  const textBox = (label: string, max: number, value: string) =>
    el("input", {
      class: "build__field",
      attrs: { type: "text", maxlength: max, value, "aria-label": label },
    });

  const boxes: Readonly<Record<TextField, HTMLInputElement>> = {
    title: textBox("Title", MAX_TITLE, values.live.title),
    author: textBox("Author", MAX_AUTHOR, values.live.author),
    goal: textBox("Goal", MAX_GOAL, values.live.goal),
    set: textBox("Set", MAX_SET, values.live.set),
  };
  const rating = el("input", {
    class: "explore__number",
    attrs: {
      type: "number",
      min: MIN_DIFFICULTY,
      max: MAX_DIFFICULTY,
      step: 1,
      value: values.live.difficulty,
      "aria-label": "Difficulty",
    },
  });
  // Derived live rather than printed as a table of bands, so this page cannot
  // drift from `dailyTierOf` — the same reason the decision panel derives it.
  const tier = el("span", { class: "review__tier" });

  const status = el("p", {
    class: `review__status${flash ? " review__status--good" : ""}`,
    text: flash ?? "",
    attrs: { role: "status", "aria-live": "polite" },
  });
  const save = el("button", { class: "btn btn--primary", text: "Save", attrs: { type: "button" } });
  const revertAll = el("button", { class: "btn", text: "Revert all", attrs: { type: "button" } });

  const say = (message: string, tone: "bad" | "good") => {
    status.textContent = message;
    status.className = `review__status review__status--${tone}`;
  };

  let sending = false;

  /**
   * Every write this form can start, with the buttons shut while one is out.
   *
   * Not the guard the decision panel needs — a second PATCH is not refused, it
   * simply wins — but a second click sends the same correction again and the
   * officer is then shown an answer they cannot tell apart from a slow first
   * one. Nothing re-enables on success: `onSaved` replaces this whole view with
   * one built from what came back.
   */
  const send = async (work: () => Promise<{ puzzle: ReviewPuzzle; said: string }>) => {
    sending = true;
    refresh();
    say("Saving…", "good");
    try {
      const done = await work();
      handlers.onSaved(done.puzzle, done.said);
    } catch (error) {
      // The server's own words, unedited. That route knows things this page
      // does not: which field it refused, why, and whether the puzzle is even
      // there — and a sentence of ours would be a worse answer to all three.
      say(error instanceof Error ? error.message : "That did not go through.", "bad");
      sending = false;
      refresh();
    }
  };

  const correct = (changes: PuzzleChanges, said: string) =>
    void send(async () => ({ puzzle: await handlers.onSave(changes), said }));

  function read(): Reading {
    const typed: Readonly<Record<TextField, string>> = {
      title: boxes.title.value.trim(),
      author: boxes.author.value.trim(),
      goal: boxes.goal.value.trim(),
      set: boxes.set.value.trim(),
    };
    const rated = rating.value.trim();
    const ratingChanged = rated !== values.live.difficulty;
    const touched =
      ratingChanged || TEXT_FIELDS.some((spec) => typed[spec.field] !== values.live[spec.field]);

    // An emptied box is the one thing this form refuses on its own account, and
    // it is not a rule about the data: null already means "use the source" in
    // every column, so there is no body that says "this field is now blank".
    // Sending "" instead would be answered by the route with "A title is
    // required", which is true and does not say what to do about it.
    const emptied = TEXT_FIELDS.filter(
      (spec) => typed[spec.field] === "" && values.live[spec.field] !== "",
    );

    const refusal =
      emptied.length > 0
        ? `${emptied.map((spec) => spec.label).join(" and ")} cannot be left empty — ` +
          "use Revert beside a field to put the source back."
        : ratingChanged && !inScale(Number(rated))
          ? `Give it a difficulty between ${MIN_DIFFICULTY} and ${MAX_DIFFICULTY} first.`
          : null;

    // The five written out rather than accumulated in a loop: `difficulty` is a
    // number where the other four are strings, and a computed key over the
    // union of field names would widen both to `string | number` at exactly the
    // point the route is strictest about which it is handed. A field that has
    // not moved is absent, which is what tells the route to leave it alone.
    const changes: PuzzleChanges = {
      ...(typed.title !== values.live.title ? { title: typed.title } : {}),
      ...(typed.author !== values.live.author ? { author: typed.author } : {}),
      ...(typed.goal !== values.live.goal ? { goal: typed.goal } : {}),
      ...(typed.set !== values.live.set ? { set: typed.set } : {}),
      ...(ratingChanged ? { difficulty: Number(rated) } : {}),
    };
    return { changes, refusal, touched };
  }

  const rows: readonly Row[] = [
    ...TEXT_FIELDS.map((spec) =>
      editRow({
        label: spec.label,
        box: boxes[spec.field],
        beside: null,
        source:
          values.live[spec.field] === values.source[spec.field] ? null : values.source[spec.field],
        onRevert: () =>
          correct(
            spec.revert,
            `${spec.label} is back to what the source says. ${AT_NEXT_RESTART}`,
          ),
        note: spec.note,
      }),
    ),
    editRow({
      label: "Difficulty",
      box: rating,
      beside: tier,
      source:
        values.live.difficulty === values.source.difficulty ? null : values.source.difficulty,
      onRevert: () =>
        correct({ difficulty: null }, `Difficulty is back to what the source says. ${AT_NEXT_RESTART}`),
      note: DIFFICULTY_NOTE,
    }),
  ];

  const reverts = rows.flatMap((row) => (row.revert ? [row.revert] : []));

  function refresh(): void {
    const reading = read();
    const rated = Number(rating.value);
    // Blank while the box holds something the server would refuse: `Number("")`
    // is 0 and 0 is a tier — hard, as it happens — so an emptied box would
    // otherwise sit there naming one.
    tier.textContent = inScale(rated) ? dailyTierOf({ difficulty: rated }) : "";
    // Left enabled when there is a refusal to give, so that clicking it answers
    // the officer rather than doing nothing: a disabled button is not an answer.
    save.disabled = sending || !reading.touched;
    revertAll.disabled = sending || !puzzle.overridden;
    for (const button of reverts) button.disabled = sending;
  }

  for (const box of [...Object.values(boxes), rating]) {
    box.addEventListener("input", refresh);
  }

  save.addEventListener("click", () => {
    const reading = read();
    if (reading.refusal) {
      say(reading.refusal, "bad");
      return;
    }
    correct(reading.changes, `Saved. ${AT_NEXT_RESTART}`);
  });

  revertAll.addEventListener("click", () =>
    void send(async () => {
      const { reverted, puzzle: back } = await handlers.onRevert();
      return {
        puzzle: back,
        said: reverted
          ? `Puzzle #${puzzle.id} is back to its source. ${AT_NEXT_RESTART}`
          : `There was nothing to revert — puzzle #${puzzle.id} already matches its source.`,
      };
    }),
  );

  refresh();

  return panel(
    `Puzzle #${puzzle.id}`,
    {},
    el(
      "div",
      { class: "review__step" },
      el("span", { class: "label", text: puzzle.community ? "from a player" : "from the club" }),
      el("span", {
        class: "label",
        // Names, plural, and never one name over the whole card. Each is the
        // review grant's subject — an attribution somebody typed into a shell,
        // never an identity anything checked — and the row's single
        // `updated_by` named whoever wrote last, so this line used to credit
        // one officer for another's corrections.
        text: puzzle.overridden
          ? `corrected by ${correctors(puzzle)} · ${filedOn(puzzle.updatedAt ?? Number.NaN)}`
          : "no correction on file",
      }),
    ),
    // Only when it is true, so the ordinary case gains no furniture. The
    // fields above show the *source* in this state — the server is serving
    // those — so without this line the officer reads their correction as
    // having silently vanished.
    puzzle.shelved
      ? el("p", {
          class: "review__status review__status--bad",
          text:
            "This correction is on file but not in force — the server is serving the " +
            "source. Either this row is malformed, or the corrected archive left a daily " +
            "band with no puzzle in it and every correction was refused together. The " +
            "service log names which.",
        })
      : null,
    ...rows.map((row) => row.element),
    el("p", { class: "review__note", text: UNEDITABLE_NOTE }),
    el("div", { class: "btnrow" }, save, revertAll),
    status,
  );
}

/**
 * The form half of an orphaned correction: an explanation and one button.
 *
 * A correction row whose puzzle has left `data/puzzles.json`. There is nothing
 * to correct — no source to compare against and no live values to edit — so
 * this is not `createCorrectionView` with the boxes hidden. It is the other
 * thing an officer can do with one, said plainly.
 *
 * It matters more than tidiness: the archive merge is by id alone, so a
 * correction left behind at #57 is inherited by whatever the club numbers 57
 * next, and the officer would be looking at a title nobody typed.
 */
export function orphanPanel(id: number, flash: string | undefined, onDelete: () => void): HTMLElement {
  const remove = el("button", {
    class: "btn btn--small",
    text: "Delete this correction",
    attrs: { type: "button" },
    on: { click: onDelete },
  });
  return panel(
    `Puzzle #${id}`,
    {},
    el("p", {
      class: "review__note",
      text:
        `There is no puzzle #${id} in the archive any more — almost always because ` +
        "`bun run puzzles` rebuilt the file from a sheet that no longer has it. The " +
        "correction is still on file, and the merge is by id, so whatever the club " +
        `numbers ${id} next would inherit it.`,
    }),
    el("div", { class: "btnrow" }, remove),
    el("p", {
      class: `review__status${flash ? " review__status--good" : ""}`,
      text: flash ?? "",
    }),
  );
}
