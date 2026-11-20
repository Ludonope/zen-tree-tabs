/* Typed, validated access to the add-on's preferences (extensions.zentreetabs.*),
 * with change notifications. The options page writes the prefs through the
 * experiment API; every browser window observes them and applies live. */
"use strict";

class Settings {
  #branch = Services.prefs.getBranch(ZTT_PREF_BRANCH);
  #defs = new Map();
  #listeners = new Set();
  #queued = false;
  #disposed = false;

  constructor() {
    for (const group of ZTT_SETTINGS) {
      for (const item of group.items) {
        this.#defs.set(item.key, item);
      }
    }
    this.#branch.addObserver("", this);
  }

  /** The current value of `key`, always valid (falls back to the default). */
  get(key) {
    const def = this.#defs.get(key);
    if (!def) {
      throw new Error(`zen-tree-tabs: unknown setting ${key}`);
    }
    try {
      switch (def.type) {
        case "bool":
          return this.#branch.getBoolPref(key, def.default);
        case "int": {
          const value = this.#branch.getIntPref(key, def.default);
          return Math.min(def.max, Math.max(def.min, value));
        }
        case "choice": {
          const value = this.#branch.getStringPref(key, def.default);
          return def.choices.some(([v]) => v === value) ? value : def.default;
        }
        default:
          return this.#branch.getStringPref(key, def.default);
      }
    } catch {
      return def.default; // a pref of the wrong type
    }
  }

  set(key, value) {
    const def = this.#defs.get(key);
    if (!def) {
      return;
    }
    this.#branch.clearUserPref(key);
    if (typeof value === "boolean") {
      this.#branch.setBoolPref(key, value);
    } else if (typeof value === "number") {
      this.#branch.setIntPref(key, Math.round(value));
    } else {
      this.#branch.setStringPref(key, String(value));
    }
  }

  /** Calls `fn` (once per burst of changes) after any setting changed. */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  observe() {
    if (this.#queued || this.#disposed) {
      return;
    }
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      if (this.#disposed) {
        return;
      }
      for (const fn of this.#listeners) {
        try {
          fn();
        } catch (e) {
          console.error("zen-tree-tabs: settings listener failed", e);
        }
      }
    });
  }

  dispose() {
    this.#disposed = true;
    this.#listeners.clear();
    try {
      this.#branch.removeObserver("", this);
    } catch {}
  }
}

/**
 * Parses "Alt+Shift+Right" into the attributes of a XUL <key>, or null.
 * Modifiers: Alt, Shift, Ctrl/Control, Meta/Cmd, Accel. The key is a single
 * character, an arrow/navigation key name, or F1-F24.
 */
function parseShortcut(text) {
  const parts = String(text ?? "")
    .split("+")
    .map(s => s.trim())
    .filter(Boolean);
  if (!parts.length) {
    return null;
  }
  const MODIFIERS = { alt: "alt", option: "alt", shift: "shift", ctrl: "control", control: "control", meta: "meta", cmd: "meta", command: "meta", accel: "accel" };
  const KEYCODES = {
    left: "VK_LEFT", right: "VK_RIGHT", up: "VK_UP", down: "VK_DOWN",
    home: "VK_HOME", end: "VK_END", pageup: "VK_PAGE_UP", pagedown: "VK_PAGE_DOWN",
    enter: "VK_RETURN", return: "VK_RETURN", tab: "VK_TAB", space: "VK_SPACE",
    delete: "VK_DELETE", backspace: "VK_BACK", escape: "VK_ESCAPE", insert: "VK_INSERT",
  };
  const modifiers = new Set();
  let main = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIERS[lower]) {
      modifiers.add(MODIFIERS[lower]);
    } else if (main === null) {
      main = part;
    } else {
      return null; // two non-modifier keys
    }
  }
  if (main === null) {
    return null;
  }
  const lower = main.toLowerCase();
  const result = { modifiers: [...modifiers].join(",") };
  if (KEYCODES[lower]) {
    result.keycode = KEYCODES[lower];
  } else if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) {
    result.keycode = `VK_${lower.toUpperCase()}`;
  } else if ([...main].length === 1) {
    result.key = lower;
  } else {
    return null;
  }
  return result;
}

/** "Alt+Shift+Right" -> "Alt+Shift+→", for the context menu. */
function formatShortcut(text) {
  return String(text ?? "")
    .replace(/\bRight\b/g, "→")
    .replace(/\bLeft\b/g, "←")
    .replace(/\bUp\b/g, "↑")
    .replace(/\bDown\b/g, "↓");
}

this.Settings = Settings;
this.parseShortcut = parseShortcut;
this.formatShortcut = formatShortcut;
