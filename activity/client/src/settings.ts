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
import {
  type ArchiveFilter,
  DEFAULT_ARCHIVE_FILTER,
  sanitizeArchiveFilter,
} from "@shared/archive-filter";

/**
 * Bumped when the meaning of a stored value changes, not just its shape.
 * Version 2 moved handling from 60Hz frames to milliseconds — a DAS of 10 read
 * under the new units is 10ms, which is nothing like what the player chose, so
 * anything older is discarded rather than reinterpreted.
 */
const SETTINGS_VERSION = 2;

/**
 * Local settings are stored per player, not per browser.
 *
 * `localStorage` is scoped to the origin, and the activity has one origin for
 * everybody, so a single unqualified key is shared by every Discord account
 * that has ever opened the activity in this browser. Because local settings win
 * on load, the second player to sit down would inherit the first player's
 * bindings — and then, on their first change, sync those over their own saved
 * settings on the server. The player id keeps the two apart.
 *
 * Players who had settings under the old shared key fall through to their
 * server copy, which is written automatically on every change, so in practice
 * only somebody who has never once been online loses anything.
 */
function storageKey(playerId: string): string {
  return `puzzle.settings.v${SETTINGS_VERSION}.${playerId}`;
}
/** Wait for a lull before syncing, so dragging a slider is one request. */
const SYNC_DEBOUNCE_MS = 800;

export interface Settings {
  readonly handling: Handling;
  readonly keybinds: Keybinds;
  /** What the explorer is showing, and what a random puzzle is drawn from. */
  readonly filter: ArchiveFilter;
}

/** What travels to and from the server, so a stale copy can be recognised. */
interface StoredSettings extends Settings {
  readonly version: number;
}

export const DEFAULT_SETTINGS: Settings = {
  handling: DEFAULT_HANDLING,
  keybinds: DEFAULT_KEYBINDS,
  filter: DEFAULT_ARCHIVE_FILTER,
};

function parse(raw: unknown): Settings {
  const value = (raw ?? {}) as Partial<Settings>;
  return {
    handling: sanitizeHandling(value.handling),
    keybinds: sanitizeKeybinds(value.keybinds),
    filter: sanitizeArchiveFilter(value.filter),
  };
}

function readLocal(key: string): Settings | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? parse(JSON.parse(raw)) : null;
  } catch {
    // Private-mode browsers and blocked storage both land here; defaults are fine.
    return null;
  }
}

function writeLocal(key: string, settings: Settings): void {
  try {
    localStorage.setItem(key, JSON.stringify(settings));
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
    private readonly key: string,
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
  static async load(api: Api, playerId: string): Promise<SettingsStore> {
    const key = storageKey(playerId);
    const local = readLocal(key);
    const store = new SettingsStore(api, key, local ?? DEFAULT_SETTINGS);
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
    writeLocal(this.key, next);
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
