/**
 * The officers' review tool: the second page this build produces.
 *
 * It is opened from a link minted on the VPS by `bun run review-link`, and the
 * first thing it does is spend that link and forget it.
 *
 * Nothing here is the activity. There is no Discord SDK, no player session, no
 * settings and no `/.proxy` prefix; this runs in an ordinary browser tab. What
 * it borrows from `client/src` is the parts that draw a board and step a solve,
 * and the club's two stylesheets — see `review.css` for why only two.
 */

import "../src/styles/tokens.css";
import "../src/styles/panels.css";
import "./review.css";

import { ReviewApi } from "./api";
import { takeGrant } from "./grant";
import { ReviewPage } from "./page";
import { sentenceFor, stop } from "./refusal";

async function boot(): Promise<void> {
  const root = document.getElementById("review");
  if (!root) throw new Error("Missing #review mount point");

  const grant = takeGrant();
  if (!grant) {
    stop(root, "Open this page from the link you were sent — it carries the way in.");
    return;
  }

  const api = new ReviewApi();
  let reviewer: string;
  try {
    reviewer = await api.signIn(grant);
  } catch (error) {
    stop(root, sentenceFor(error));
    return;
  }

  await new ReviewPage(root, api, reviewer).showQueue();
}

void boot();
