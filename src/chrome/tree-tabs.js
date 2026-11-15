/* Tree tabs for Zen's native vertical tab strip.
 *
 * Loaded into every browser window by experiment/parent.js; exposes
 * window.gZenTreeTabs.
 *
 * Model
 * -----
 * The tree lives on the tab elements themselves:
 *   ztt-parent="<id>"  the parent tab's DOM id. Zen gives every tab a stable
 *                      id (its window-sync id), persisted across sessions and
 *                      shared by the mirrored copies of a tab in other windows.
 *   ztt-collapsed      the tab's children are hidden.
 * Tab order is the DOM order; a tab's subtree always directly follows it.
 *
 * Event handlers (open/close/move/pin/user actions) are the only code that
 * changes links. rebuild() is idempotent: it derives depth, visibility and
 * twisties from the links and never edits them, so transient orderings (e.g.
 * while Zen syncs windows or restores a session) cannot corrupt the tree.
 */
"use strict";

(function () {
  const ATTR = {
    parent: "ztt-parent",
    collapsed: "ztt-collapsed",
    // Computed by rebuild():
    depth: "ztt-depth",
    hasChildren: "ztt-has-children",
    hidden: "ztt-hidden",
  };
  const COMPUTED_ATTRS = [ATTR.depth, ATTR.hasChildren, ATTR.hidden];
  const STORE_KEY = "zenTreeTabs";
  const TAB_EVENTS = [
    "TabOpen",
    "TabClose",
    "TabMove",
    "TabSelect",
    "TabPinned",
    "TabGrouped",
    "SSTabRestoring",
  ];
  const MAX_DEPTH_WALK = 1000;

  class ZenTreeTabs {
    #flushQueued = false;
    #internalMove = 0;
    #pendingOpens = new Set();
    #pendingMoves = new Set();
    /** tab -> last persisted state string, to only write/broadcast changes. */
    #saved = new WeakMap();

    // ---------------------------------------------------------------- setup

    init() {
      for (const type of TAB_EVENTS) {
        window.addEventListener(type, this);
      }
      window.addEventListener("mousedown", this, true);
      window.addEventListener("click", this, true);

      for (const tab of gBrowser.tabs) {
        this.#restoreTab(tab);
      }
      // Windows that mirror ours (Zen window sync) hold the freshest state.
      for (const tab of gBrowser.tabs) {
        this.#pullFromOtherWindows(tab);
      }
      this.rebuild();
    }

    uninit() {
      for (const type of TAB_EVENTS) {
        window.removeEventListener(type, this);
      }
      window.removeEventListener("mousedown", this, true);
      window.removeEventListener("click", this, true);
      // Leave ztt-parent/ztt-collapsed alone: they are harmless without the
      // stylesheet and let a re-enabled add-on pick the tree back up.
      for (const tab of gBrowser.tabs) {
        this.#clearComputed(tab);
        tab.querySelector(".ztt-twisty")?.remove();
      }
    }

    handleEvent(event) {
      const tab = event.target;
      switch (event.type) {
        case "TabOpen":
          this.#pendingOpens.add(tab);
          this.scheduleFlush();
          break;
        case "TabClose":
          this.#onTabClose(tab);
          break;
        case "TabMove":
          if (!this.#internalMove && !this.#isMirroredChange()) {
            this.#pendingMoves.add(tab);
          }
          this.scheduleFlush();
          break;
        case "TabSelect":
          if (tab.hasAttribute(ATTR.hidden)) {
            this.#expandAncestors(tab);
          }
          break;
        case "TabPinned":
        case "TabGrouped":
          this.#detach(tab);
          break;
        case "SSTabRestoring":
          this.#restoreTab(tab);
          this.scheduleFlush();
          break;
        case "mousedown":
        case "click":
          this.#onTwistyMouse(event);
          break;
      }
    }

    // -------------------------------------------------------- tree queries

    /** Whether the tab takes part in the tree (unpinned, in a space's normal tab list). */
    isTreeTab(tab) {
      return (
        gBrowser.isTab(tab) &&
        tab.isConnected &&
        !tab.pinned &&
        !tab.hasAttribute("zen-empty-tab") &&
        !tab.hasAttribute("zen-glance-tab") &&
        !!tab.parentElement?.classList.contains("zen-workspace-normal-tabs-section")
      );
    }

    parentOf(tab) {
      const id = tab.getAttribute(ATTR.parent);
      if (!id) {
        return null;
      }
      const parent = document.getElementById(id);
      return parent !== tab && gBrowser.isTab(parent) && !parent.closing ? parent : null;
    }

    isAncestor(ancestor, tab) {
      let current = tab;
      for (let i = 0; i < MAX_DEPTH_WALK && current; i++) {
        current = this.parentOf(current);
        if (current === ancestor) {
          return true;
        }
      }
      return false;
    }

    /** Direct children, in tab order. */
    childrenOf(tab) {
      // Compares ids directly so it also works for a tab that is closing.
      return tab.id
        ? gBrowser.tabs.filter(t => !t.closing && t !== tab && t.getAttribute(ATTR.parent) === tab.id)
        : [];
    }

    /** All descendants, in tab order. */
    descendantsOf(tab) {
      return gBrowser.tabs.filter(t => !t.closing && t !== tab && this.isAncestor(tab, t));
    }

    /** Next tab in the same container that takes part in the tree. */
    #nextTreeTab(tab) {
      for (let el = tab.nextElementSibling; el; el = el.nextElementSibling) {
        if (this.#isTransparent(el)) {
          continue;
        }
        return this.isTreeTab(el) ? el : null;
      }
      return null;
    }

    /** Tabs that rebuild/neighbour logic steps over without breaking a tree. */
    #isTransparent(el) {
      return (
        gBrowser.isTab(el) &&
        (el.closing || el.hidden || el.hasAttribute("zen-glance-tab") || el.hasAttribute("zen-empty-tab"))
      );
    }

    // -------------------------------------------------------- tree editing

    #idOf(tab) {
      if (!tab.id) {
        // Zen assigns ids to every tab of synced windows; private / workspace-less
        // windows don't get one, so give the tab a local one.
        tab.id = `ztt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      }
      return tab.id;
    }

    #setParent(tab, parent) {
      if (parent) {
        tab.setAttribute(ATTR.parent, this.#idOf(parent));
      } else {
        tab.removeAttribute(ATTR.parent);
      }
    }

    /**
     * Removes `tab` from the tree, keeping its subtree together: the first
     * child takes its place and the other children become that child's children.
     */
    #promoteChildren(tab) {
      const [first, ...rest] = this.childrenOf(tab);
      if (!first) {
        return;
      }
      const grandParentId = tab.getAttribute(ATTR.parent);
      if (grandParentId) {
        first.setAttribute(ATTR.parent, grandParentId);
      } else {
        first.removeAttribute(ATTR.parent);
      }
      first.toggleAttribute(ATTR.collapsed, tab.hasAttribute(ATTR.collapsed));
      for (const child of rest) {
        this.#setParent(child, first);
      }
    }

    #detach(tab) {
      this.#promoteChildren(tab);
      tab.removeAttribute(ATTR.parent);
      tab.removeAttribute(ATTR.collapsed);
      this.scheduleFlush();
    }

    #moveTabsAfter(tabs, target) {
      this.#internalMove++;
      try {
        gBrowser.moveTabsAfter(tabs, target);
      } finally {
        this.#internalMove--;
      }
    }

    setCollapsed(tab, collapsed) {
      if (collapsed === tab.hasAttribute(ATTR.collapsed)) {
        return;
      }
      if (collapsed && this.isAncestor(tab, gBrowser.selectedTab)) {
        gBrowser.selectedTab = tab;
      }
      tab.toggleAttribute(ATTR.collapsed, collapsed);
      this.rebuild();
    }

    toggleCollapsed(tab) {
      this.setCollapsed(tab, !tab.hasAttribute(ATTR.collapsed));
    }

    #expandAncestors(tab) {
      for (let p = this.parentOf(tab), i = 0; p && i < MAX_DEPTH_WALK; p = this.parentOf(p), i++) {
        p.removeAttribute(ATTR.collapsed);
      }
      this.rebuild();
    }

    // ------------------------------------------------------- event logic

    #onTabOpen(tab) {
      let opener = tab.openerTab;
      if (opener?.hasAttribute("zen-glance-tab")) {
        opener = gZenGlanceManager.getTabOrGlanceParent(opener);
      }
      if (
        !opener ||
        opener.closing ||
        !this.isTreeTab(tab) ||
        !this.isTreeTab(opener) ||
        opener.parentElement !== tab.parentElement ||
        tab.hasAttribute(ATTR.parent)
      ) {
        return;
      }
      this.#setParent(tab, opener);
      opener.removeAttribute(ATTR.collapsed);
      // New children go to the end of the opener's subtree.
      const last = this.descendantsOf(opener).filter(t => t !== tab).at(-1) ?? opener;
      if (this.#nextTreeTab(last) !== tab) {
        this.#moveTabsAfter([tab], last);
      }
    }

    #onTabClose(tab) {
      this.#promoteChildren(tab);
      this.scheduleFlush();
    }

    /** A tab was moved by something other than us: keep its subtree with it and re-derive its parent. */
    #onTabMoved(tab) {
      if (!this.isTreeTab(tab)) {
        return;
      }
      let descendants = this.descendantsOf(tab);
      if (descendants.some(d => d.parentElement !== tab.parentElement)) {
        // Moved to another space: it leaves its tree behind.
        this.#promoteChildren(tab);
        tab.removeAttribute(ATTR.collapsed);
        descendants = [];
      } else if (descendants.length) {
        const inPlace = descendants.every((d, i) => this.#nextTreeTab(i ? descendants[i - 1] : tab) === d);
        if (!inPlace) {
          this.#moveTabsAfter(descendants, tab);
        }
      }

      const next = this.#nextTreeTab(descendants.at(-1) ?? tab);
      const nextParent = next ? this.parentOf(next) : null;
      const oldParent = this.parentOf(tab);
      let newParent = nextParent;
      if (oldParent && this.#isInsideSubtree(tab, oldParent)) {
        // Still among its siblings: keep the parent, unless the next tab needs
        // a deeper one to stay attached to its own parent.
        newParent = nextParent && this.isAncestor(oldParent, nextParent) ? nextParent : oldParent;
      }
      this.#setParent(tab, newParent);
    }

    /** Whether `tab` sits inside `ancestor`'s subtree region (only its descendants in between). */
    #isInsideSubtree(tab, ancestor) {
      if (ancestor.parentElement !== tab.parentElement) {
        return false;
      }
      for (let el = ancestor.nextElementSibling; el; el = el.nextElementSibling) {
        if (el === tab) {
          return true;
        }
        if (this.#isTransparent(el)) {
          continue;
        }
        if (!this.isTreeTab(el) || !this.isAncestor(ancestor, el)) {
          return false;
        }
      }
      return false;
    }

    /**
     * Zen mirrors tab moves into every synced window. Those replayed moves are
     * already reflected by the tree state pushed from the window the user acts in.
     */
    #isMirroredChange() {
      const active = Services.focus.activeWindow;
      return !!active && active !== window && !!active.gZenTreeTabs;
    }

    #onTwistyMouse(event) {
      const twisty = event.target.closest?.(".ztt-twisty");
      if (!twisty || event.button !== 0) {
        return;
      }
      // Keep the tab from being selected or dragged.
      event.stopPropagation();
      event.preventDefault();
      if (event.type === "click") {
        this.toggleCollapsed(twisty.closest(".tabbrowser-tab"));
      }
    }

    // ------------------------------------------------------------ flush

    scheduleFlush() {
      if (this.#flushQueued) {
        return;
      }
      this.#flushQueued = true;
      // After the current event (and Zen's own synchronous handling) completes.
      queueMicrotask(() => this.#flush());
    }

    #flush() {
      this.#flushQueued = false;
      try {
        const opens = [...this.#pendingOpens];
        this.#pendingOpens.clear();
        for (const tab of opens) {
          this.#pullFromOtherWindows(tab);
          this.#onTabOpen(tab);
        }
        const moves = [...this.#pendingMoves].filter(t => t.isConnected);
        this.#pendingMoves.clear();
        moves.sort((a, b) => a._tPos - b._tPos);
        for (const tab of moves) {
          this.#onTabMoved(tab);
        }
      } catch (e) {
        console.error("zen-tree-tabs: flush failed", e);
      }
      this.rebuild();
    }

    // ---------------------------------------------------------- rebuild

    /** Recomputes depth, visibility and twisties from the links. Never edits links. */
    rebuild() {
      const hasChildren = new Set();
      let stack = [];
      let container = null;
      for (const tab of gBrowser.tabs) {
        if (this.#isTransparent(tab)) {
          continue;
        }
        if (!this.isTreeTab(tab)) {
          this.#clearComputed(tab);
          container = null;
          continue;
        }
        if (tab.parentElement !== container) {
          container = tab.parentElement;
          stack = [];
        }
        const parent = this.parentOf(tab);
        const index = parent ? stack.lastIndexOf(parent) : -1;
        stack.length = index + 1; // invalid or missing parent -> shown at root
        const depth = stack.length;
        if (depth) {
          hasChildren.add(stack[depth - 1]);
        }
        this.#setComputed(tab, depth, stack.some(t => t.hasAttribute(ATTR.collapsed)));
        stack.push(tab);
      }
      for (const tab of gBrowser.tabs) {
        const has = hasChildren.has(tab);
        tab.toggleAttribute(ATTR.hasChildren, has);
        if (has) {
          this.#ensureTwisty(tab);
        }
        this.#persist(tab);
      }
    }

    #setComputed(tab, depth, hidden) {
      if (depth) {
        tab.setAttribute(ATTR.depth, depth);
        tab.style.setProperty("--ztt-depth", depth);
      } else {
        tab.removeAttribute(ATTR.depth);
        tab.style.removeProperty("--ztt-depth");
      }
      tab.toggleAttribute(ATTR.hidden, hidden);
    }

    #clearComputed(tab) {
      for (const attr of COMPUTED_ATTRS) {
        tab.removeAttribute(attr);
      }
      tab.style.removeProperty("--ztt-depth");
    }

    #ensureTwisty(tab) {
      if (tab.querySelector(".ztt-twisty")) {
        return;
      }
      const content = tab.querySelector(".tab-content");
      if (!content) {
        return;
      }
      const twisty = document.createXULElement("image");
      twisty.className = "ztt-twisty";
      twisty.setAttribute("role", "button");
      content.prepend(twisty);
    }

    // ------------------------------------------- persistence & window sync

    #stateOf(tab) {
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

    #restoreTab(tab) {
      const value = SessionStore.getCustomTabValue(tab, STORE_KEY) || "";
      this.#applyState(tab, value);
      this.#saved.set(tab, value);
    }

    #persist(tab) {
      const value = this.#stateOf(tab);
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
      this.#pushToOtherWindows(tab, value);
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

    #pushToOtherWindows(tab, value) {
      for (const mirror of this.#mirrorsOf(tab)) {
        mirror.ownerDocument.defaultView.gZenTreeTabs.receiveState(mirror, value);
      }
    }

    #pullFromOtherWindows(tab) {
      for (const mirror of this.#mirrorsOf(tab)) {
        this.#applyState(tab, mirror.ownerDocument.defaultView.gZenTreeTabs.stateOf(mirror));
        return;
      }
    }

    /** Called by another window when the mirrored copy of `tab` changed. */
    receiveState(tab, value) {
      if (this.#stateOf(tab) !== value) {
        this.#applyState(tab, value);
        this.scheduleFlush();
      }
    }

    stateOf(tab) {
      return this.#stateOf(tab);
    }
  }

  window.gZenTreeTabs = new ZenTreeTabs();
})();
