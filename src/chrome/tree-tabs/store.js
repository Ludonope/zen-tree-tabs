/* Persistence and window sync. Each tab's links are saved in Zen's session
 * data (survives restarts and add-on updates) and pushed to the mirrored copy
 * of the tab in Zen's other synced windows, matched by tab id. */
"use strict";

class Store {
  /** tab -> last persisted state string, to only write/broadcast changes. */
  #saved = new WeakMap();
  #onRemoteChange;

  /** @param onRemoteChange called when another window changed one of our tabs. */
  constructor(onRemoteChange) {
    this.#onRemoteChange = onRemoteChange;
  }

  /** Serialized links of a tab ("" when it has none). */
  stateOf(tab) {
    const parent = tab.getAttribute(ATTR.parent);
    const collapsed = tab.hasAttribute(ATTR.collapsed);
    return parent || collapsed ? JSON.stringify({ parent: parent || null, collapsed }) : "";
  }

  #applyState(tab, value) {
    let state = {};
    try {
      state = value ? JSON.parse(value) : {};
    } catch {}
    if (state.parent) {
      tab.setAttribute(ATTR.parent, state.parent);
    } else {
      tab.removeAttribute(ATTR.parent);
    }
    tab.toggleAttribute(ATTR.collapsed, !!state.collapsed);
  }

  /** Reads a tab's links back from the session. */
  restore(tab) {
    const value = SessionStore.getCustomTabValue(tab, STORE_KEY) || "";
    this.#applyState(tab, value);
    this.#saved.set(tab, value);
  }

  /** Saves and broadcasts every tab whose links changed. */
  persistAll() {
    for (const tab of gBrowser.tabs) {
      this.#persist(tab);
    }
  }

  #persist(tab) {
    const value = this.stateOf(tab);
    if (this.#saved.get(tab) === value) {
      return;
    }
    this.#saved.set(tab, value);
    if (tab.closing) {
      return;
    }
    if (value) {
      SessionStore.setCustomTabValue(tab, STORE_KEY, value);
    } else {
      SessionStore.deleteCustomTabValue(tab, STORE_KEY);
    }
    for (const mirror of this.#mirrorsOf(tab)) {
      mirror.ownerDocument.defaultView.gZenTreeTabs.receiveState(mirror, value);
    }
  }

  /** Copies a tab's links from its mirror in another window, if any. */
  pull(tab) {
    for (const mirror of this.#mirrorsOf(tab)) {
      this.#applyState(tab, mirror.ownerDocument.defaultView.gZenTreeTabs.stateOf(mirror));
      return;
    }
  }

  /** Another window changed the mirrored copy of `tab`. */
  receive(tab, value) {
    if (this.stateOf(tab) !== value) {
      this.#applyState(tab, value);
      this.#onRemoteChange();
    }
  }

  *#mirrorsOf(tab) {
    if (!tab.id) {
      return;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win === window || !win.gZenTreeTabs || win.closed) {
        continue;
      }
      const mirror = win.document.getElementById(tab.id);
      if (mirror && win.gBrowser.isTab(mirror)) {
        yield mirror;
      }
    }
  }
}
