/**
 * Player settings: handling and key bindings.
 *
 * Kept in `localStorage` so they survive a reload even when the network is
 * unhappy, and mirrored to the server so they follow the player to another
 * device. Local always wins on load; the server copy is a backup, not a lock.
 */

import { DEFAULT_HANDLING, type Handling, sanitizeHandling } from "@shared/tetris/handling";
import type { Api } from "./api";
import { DEFAULT_KEYBINDS, type Keybinds, sanitizeKeybinds } from "@shared/keybinds";

/**
 * Bumped when the meaning of a stored value changes, not just its shape.
 * Version 2 moved handling from 60Hz frames to milliseconds — a DAS of 10 read
 * under the new units is 10ms, which is nothing like what the player chose, so
 * anything older is discarded rather than reinterpreted.
 */
const SETTINGS_VERSION = 2;
const STORAGE_KEY = `puzzle.settings.v${SETTINGS_VERSION}`;
/** Wait for a lull before syncing, so dragging a slider is one request. */
const SYNC_DEBOUNCE_MS = 800;

export interface Settings {
  readonly handling: Handling;
  readonly keybinds: Keybinds;
}

/** What travels to and from the server, so a stale copy can be recognised. */
interface StoredSettings extends Settings {
  readonly version: number;
}

export const DEFAULT_SETTINGS: Settings = {
  handling: DEFAULT_HANDLING,
  keybinds: DEFAULT_KEYBINDS,
};

function parse(raw: unknown): Settings {
  const value = (raw ?? {}) as Partial<Settings>;
  return {
    handling: sanitizeHandling(value.handling),
    keybinds: sanitizeKeybinds(value.keybinds),
  };
}

function readLocal(): Settings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parse(JSON.parse(raw)) : null;
  } catch {
    // Private-mode browsers and blocked storage both land here; defaults are fine.
    return null;
  }
}

function writeLocal(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Nothing to do — the in-memory copy still works for this session.
  }
}

export class SettingsStore {
  private current: Settings;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(settings: Settings) => void>();

  private constructor(
    private readonly api: Api,
    initial: Settings,
  ) {
    this.current = initial;
  }

  /**
   * Loads local settings, falling back to the server's copy.
   *
   * Local wins outright when it exists: the two carry no timestamp, so there is
   * no way to tell which is newer, and the copy on this machine is the one the
   * player last touched here.
   */
  static async load(api: Api): Promise<SettingsStore> {
    const local = readLocal();
    const store = new SettingsStore(api, local ?? DEFAULT_SETTINGS);
    if (!local) {
      try {
        const { preferences } = await api.preferences();
        const stored = preferences as StoredSettings | null;
        if (stored?.version === SETTINGS_VERSION) {
          store.replace(parse(stored), { sync: false });
        }
      } catch {
        // A missing or unreachable server copy is not worth blocking play for.
      }
    }
    return store;
  }

  get value(): Settings {
    return this.current;
  }

  subscribe(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: Partial<Settings>): void {
    this.replace({ ...this.current, ...patch }, { sync: true });
  }

  resetToDefaults(): void {
    this.replace(DEFAULT_SETTINGS, { sync: true });
  }

  private replace(next: Settings, { sync }: { sync: boolean }): void {
    this.current = next;
    writeLocal(next);
    for (const listener of this.listeners) listener(next);
    if (sync) this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.api.savePreferences({ ...this.current, version: SETTINGS_VERSION }).catch(() => {
        // Settings are already saved locally; a failed mirror is not an error
        // the player can act on.
      });
    }, SYNC_DEBOUNCE_MS);
  }
}
