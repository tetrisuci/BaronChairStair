/**
 * What a reviewer is told when something has gone wrong, and the screen it is
 * told on.
 *
 * Its own module because two very different moments need the same words: the
 * exchange at the door, before there is a page at all, and a call two hours
 * later when the token has run out under an officer mid-decision.
 */

import { ApiError } from "../src/api";
import { el, panel, replaceChildren } from "../src/ui/dom";

/**
 * The one sentence, for every 401.
 *
 * The server can tell an expired link from a mangled one from a signature
 * minted under a since-rotated secret, and it says which in the response body.
 * The officer cannot use the difference: there is no renewal here and there is
 * not going to be one, so the action is the same in all three cases and it is
 * to ask the person with SSH for another link. The server's own wording goes to
 * the console, where somebody debugging a link that was truncated in a DM will
 * think to look.
 */
export const EXPIRED = "This link has expired. Ask for a new one.";

export function isExpired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** The sentence to show for anything that went wrong. Logs the real one. */
export function sentenceFor(error: unknown): string {
  console.error("[review]", error);
  if (isExpired(error)) return EXPIRED;
  if (error instanceof ApiError) return error.message;
  return "The review queue could not be opened. The reason is in the console.";
}

/** Replaces the page with one sentence, when there is nothing left to do on it. */
export function stop(root: HTMLElement, sentence: string): void {
  replaceChildren(
    root,
    panel("Review", { class: "review__stop" }, el("p", { class: "review__note", text: sentence })),
  );
}
