import "./styles/tokens.css";
import "./styles/sheet.css";
import "./styles/panels.css";
import "./styles/home.css";
import "./styles/overlays.css";
import "./styles/narrow.css";

import { App } from "./app";
import { connect } from "./discord";
import { SettingsStore } from "./settings";

async function boot(): Promise<void> {
  const root = document.getElementById("sheet");
  if (!root) throw new Error("Missing #sheet mount point");

  try {
    const connection = await connect();
    const settings = await SettingsStore.load(connection.api, connection.player.id);
    await new App(root, connection, settings).start();
  } catch (error) {
    console.error("[puzzle] failed to start", error);
    showFatal(root, describeError(error));
  }
}

/**
 * Anything can be thrown, and the embedded SDK in particular rejects with plain
 * `{ code, message }` objects rather than Errors. Reporting only `Error`s threw
 * away the reason at the one moment it was needed.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof message === "string") {
      return code === undefined ? message : `${message} (code ${String(code)})`;
    }
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to the generic message below.
    }
  }
  return "The activity could not start.";
}

function showFatal(root: HTMLElement, detail: string): void {
  root.replaceChildren();
  const title = document.createElement("p");
  title.className = "fatal__title";
  title.textContent = "Could not start";
  const message = document.createElement("p");
  message.className = "fatal__detail";
  message.textContent = detail;
  const hint = document.createElement("p");
  hint.className = "fatal__detail";
  hint.textContent = "The full error is in the console.";
  root.append(title, message, hint);
}

void boot();
