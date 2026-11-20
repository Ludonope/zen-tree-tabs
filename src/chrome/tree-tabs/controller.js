/* Wires everything together: listens to Zen's tab events, turns them into
 * tree edits, and re-renders. Event handlers and user actions are the only
 * code that changes links; rendering just reflects them.
 *
 * The instance is window.gZenTreeTabs (see tree-tabs.uc.js). */
"use strict";

const TAB_EVENTS = [
  "TabOpen",
  "TabClose",
  "TabMove",
  "TabSelect",
  "TabPinned",
  "TabGrouped",
  "TabUngrouped",
  "ZenSplitViewTabsSplit",
  "ZenTabRemovedFromSplit",
  "TabGroupRemoved",
  "SSTabRestoring",
];

const APPEARANCE_VARS = [
  "--ztt-indent-step",
  "--ztt-guide-style",
  "--ztt-guide-width",
  "--ztt-guide-opacity",
  "--ztt-guide-active-opacity",
  "--ztt-guide-gap",
  "--ztt-guide-top-gap",
  "--ztt-depth-tint",
  "--ztt-tree-strength",
];

class ZenTreeTabs {
  settings = new Settings();
  tree = new Tree();
  renderer = new Renderer(this.tree, this.settings);
  store = new Store(() => this.scheduleFlush());
  dnd = new DragAndDrop(this.tree, () => this.scheduleFlush());

  #flushQueued = false;
  /** new tab -> the tab that was selected when it opened */
  #pendingOpens = new Map();
  #autoCollapsePending = false;
  /** Tabs we are closing ourselves (or that a bulk close already planned): not re-planned. */
  #closeMarks = new Set();
  #shortcutsCleanup = null;
  #pendingMoves = new Set();
  #pendingGrouped = new Set();
  #cleanups = [];
  #stopped = false;

  // ------------------------------------------------------------ lifecycle

  init() {
    this.#applyAppearance();
    for (const type of TAB_EVENTS) {
      window.addEventListener(type, this);
    }
    window.addEventListener("mousedown", this, true);
    window.addEventListener("click", this, true);
    this.#cleanups.push(
      () => {
        for (const type of TAB_EVENTS) {
          window.removeEventListener(type, this);
        }
        window.removeEventListener("mousedown", this, true);
        window.removeEventListener("click", this, true);
      },
      this.dnd.attach(),
      createTreeMenu(this),
      () => this.#shortcutsCleanup?.(),
      this.#guardClosing(),
      () => this.settings.dispose()
    );
    this.#shortcutsCleanup = createShortcuts(this);
    this.settings.onChange(() => {
      this.#applyAppearance();
      this.#shortcutsCleanup?.();
      this.#shortcutsCleanup = createShortcuts(this);
      this.rebuild();
    });

    for (const tab of gBrowser.tabs) {
      this.store.restore(tab);
    }
    // Windows that mirror ours (Zen window sync) hold the freshest state.
    for (const tab of gBrowser.tabs) {
      this.store.pull(tab);
    }
    this.rebuild();
  }

  uninit() {
    this.#stopped = true; // a flush still queued must not redecorate afterwards
    for (const cleanup of this.#cleanups.reverse()) {
      try {
        cleanup();
      } catch (e) {
        console.error(e);
      }
    }
    this.#cleanups = [];
    // Leave ztt-parent/ztt-collapsed alone: they are harmless without the
    // stylesheet and let a re-enabled mod pick the tree back up.
    this.renderer.clear();
    const root = document.documentElement;
    for (const name of APPEARANCE_VARS) {
      root.style.removeProperty(name);
    }
    root.removeAttribute("ztt-depth-tint");
    root.removeAttribute("ztt-tree-colors");
  }

  /** Pushes the appearance settings to the stylesheet as variables and attributes. */
  #applyAppearance() {
    const s = this.settings;
    const root = document.documentElement;
    const vars = {
      "--ztt-indent-step": `${s.get("indentSize")}px`,
      "--ztt-guide-style": s.get("guideStyle"),
      "--ztt-guide-width": `${s.get("guideWidth")}px`,
      "--ztt-guide-opacity": `${s.get("guideOpacity")}%`,
      "--ztt-guide-active-opacity": `${s.get("guideActiveOpacity")}%`,
      "--ztt-guide-gap": `${s.get("guideGap")}px`,
      "--ztt-guide-top-gap": `${s.get("guideTopGap")}px`,
      "--ztt-depth-tint": `${s.get("depthTintStrength")}%`,
      "--ztt-tree-strength": `${s.get("treeColorStrength")}%`,
    };
    for (const [name, value] of Object.entries(vars)) {
      setStyleVar(root, name, value);
    }
    root.toggleAttribute("ztt-depth-tint", s.get("depthTint"));
    const colors = s.get("treeColors");
    if (colors === "off") {
      root.removeAttribute("ztt-tree-colors");
    } else {
      root.setAttribute("ztt-tree-colors", colors);
    }
  }

  // --------------------------------------------------------------- events

  handleEvent(event) {
    const target = event.target;
    switch (event.type) {
      case "TabOpen": {
        // The new tab isn't selected yet; remember what was, for "child of current tab".
        const selected = gBrowser.selectedTab;
        this.#pendingOpens.set(target, selected === target ? (target.owner ?? null) : selected);
        this.scheduleFlush();
        break;
      }
      case "TabClose":
        this.#onTabClose(target);
        break;
      case "TabMove":
      case "TabUngrouped":
      case "ZenSplitViewTabsSplit":
      case "ZenTabRemovedFromSplit":
        if (!this.tree.internalMoves && !this.#isMirroredChange()) {
          this.#pendingMoves.add(target);
        }
        this.scheduleFlush();
        break;
      case "TabGrouped":
        this.#pendingGrouped.add(target);
        this.scheduleFlush();
        break;
      case "TabGroupRemoved":
        // The emptied group element can outlive the last tab move.
        setTimeout(() => this.scheduleFlush(), 0);
        break;
      case "TabSelect":
        if (this.nodeOf(target).hasAttribute(ATTR.hidden)) {
          this.#expandAncestors(this.nodeOf(target));
        }
        this.#autoCollapsePending = true; // done in the flush, once new tabs are nested
        this.scheduleFlush(); // highlight the new active path
        break;
      case "TabPinned":
        this.tree.detach(target);
        this.scheduleFlush();
        break;
      case "SSTabRestoring":
        this.store.restore(target);
        this.scheduleFlush();
        break;
      case "mousedown":
      case "click":
        this.#onTwistyMouse(event);
        break;
    }
  }

  #onTabOpen(tab, selectedBefore) {
    const tree = this.tree;
    const mode = this.settings.get("newTabMode");
    if (mode === "none") {
      return;
    }
    let opener = tab.openerTab;
    if (opener?.hasAttribute("zen-glance-tab")) {
      opener = gZenGlanceManager.getTabOrGlanceParent(opener);
    }
    if (
      !opener &&
      mode === "current" &&
      selectedBefore &&
      !selectedBefore.closing &&
      // Not tabs that appear for other reasons: restored sessions, or mirrors of
      // a tab the user opened in another synced window (that window nests it).
      !tab.hasAttribute("pending") &&
      !tab.pinned &&
      !this.#isMirroredChange() &&
      !this.store.hasMirror(tab)
    ) {
      opener = selectedBefore;
    }
    if (!opener || opener.closing || !tree.isNode(tab) || tab.hasAttribute(ATTR.parent)) {
      return;
    }
    const parent = tree.nodeOf(opener);
    if (!tree.isNode(parent) || parent.parentElement !== tab.parentElement) {
      return;
    }
    tree.setParent(tab, parent);
    tree.setCollapsedAttr(parent, false);
    // New children go to the end of the opener's subtree.
    const last = tree.descendantsOf(parent).filter(n => n !== tab).at(-1) ?? parent;
    if (tree.nextNode(last) !== tab) {
      tree.moveNodesAfter([tab], last);
    }
  }

  #onTabClose(tab) {
    const tree = this.tree;
    // Zen may already have dissolved the split group, so use the remembered mates.
    const others = (this.renderer.splitMates.get(tab) ?? []).filter(t => t.isConnected && !t.closing);
    if (others.length) {
      // The split group lives on: hand this tab's links over to another member.
      const heir = others[0];
      const isOutside = id => id && id !== tab.id && !others.some(t => t.id === id);
      const ownParentId = tab.getAttribute(ATTR.parent);
      const parentId = isOutside(ownParentId)
        ? ownParentId
        : (others.map(t => t.getAttribute(ATTR.parent)).find(isOutside) ?? null);
      const collapsed = tab.hasAttribute(ATTR.collapsed) || others.some(t => t.hasAttribute(ATTR.collapsed));
      for (const t of gBrowser.tabs) {
        if (t.getAttribute(ATTR.parent) === tab.id) {
          tree.setParent(t, heir);
        }
      }
      for (const member of others) {
        tree.setParentId(member, parentId);
        member.toggleAttribute(ATTR.collapsed, collapsed);
      }
    } else {
      tree.promoteChildren(tab);
    }
    this.scheduleFlush();
  }

  /** A node was moved by something other than us: keep its subtree with it and re-derive its parent. */
  #onNodeMoved(node) {
    const tree = this.tree;
    if (!tree.isNode(node)) {
      return;
    }
    let descendants = tree.descendantsOf(node);
    if (descendants.some(d => d.parentElement !== node.parentElement)) {
      // Moved to another space: it leaves its tree behind.
      tree.promoteChildren(node);
      tree.setCollapsedAttr(node, false);
      descendants = [];
    } else if (descendants.length) {
      const inPlace = descendants.every((d, i) => tree.nextNode(i ? descendants[i - 1] : node) === d);
      if (!inPlace) {
        tree.moveNodesAfter(descendants, node);
      }
    }

    if (this.dnd.intent?.nodes.has(node)) {
      return; // Parent set explicitly by the drop.
    }
    const next = tree.nextNode(descendants.at(-1) ?? node);
    const nextParent = next ? tree.parentOf(next) : null;
    const oldParent = tree.parentOf(node);
    let newParent = nextParent;
    if (oldParent && tree.isInsideSubtree(node, oldParent)) {
      // Still among its siblings: keep the parent, unless the next node needs
      // a deeper one to stay attached to its own parent.
      newParent = nextParent && tree.isAncestor(oldParent, nextParent) ? nextParent : oldParent;
    }
    if (newParent !== oldParent || (!newParent && tree.parentIdOf(node)) || !gBrowser.isTab(node)) {
      // For split groups this also gives every member the same parent, so
      // whichever tab survives the split keeps the group's place.
      tree.setParent(node, newParent);
    }
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
    if (event.button !== 0) {
      return;
    }
    const tab = event.target.closest?.(`.tabbrowser-tab[${ATTR.twisty}]`);
    const icon = event.target.closest?.(".tab-icon-stack");
    if (!tab || !icon || !tab.contains(icon) || !isSidebarExpanded()) {
      return;
    }
    // Keep the tab from being selected or dragged.
    event.stopPropagation();
    event.preventDefault();
    if (event.type === "click") {
      this.toggleCollapsed(this.nodeOf(tab));
    }
  }

  // ---------------------------------------------------------------- flush

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
    if (this.#stopped) {
      return;
    }
    try {
      const opens = [...this.#pendingOpens];
      this.#pendingOpens.clear();
      for (const [tab, selectedBefore] of opens) {
        this.store.pull(tab);
        this.#onTabOpen(tab, selectedBefore);
      }

      const grouped = [...this.#pendingGrouped];
      this.#pendingGrouped.clear();
      for (const tab of grouped) {
        // Folders take tabs out of the tree; split views keep them in as a group node.
        if (tab.isConnected && tab.group && !this.tree.splitGroupOf(tab)) {
          this.tree.detach(tab);
        }
      }

      const moved = new Set();
      for (const el of this.#pendingMoves) {
        if (el.isConnected) {
          moved.add(gBrowser.isTab(el) ? this.nodeOf(el) : el);
        }
      }
      this.#pendingMoves.clear();
      const sorted = [...moved].sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      );
      for (const node of sorted) {
        this.#onNodeMoved(node);
      }

      if (this.#autoCollapsePending) {
        this.#autoCollapsePending = false;
        this.#autoCollapse(this.nodeOf(gBrowser.selectedTab));
      }
    } catch (e) {
      console.error("zen-tree-tabs: flush failed", e);
    }
    this.dnd.intent = null;
    this.rebuild();
  }

  /** Re-renders and saves. Never edits links. */
  rebuild() {
    this.renderer.render(this.nodeOf(gBrowser.selectedTab));
    this.store.persistAll();
  }

  // --------------------------------------------------------- user actions

  setCollapsed(node, collapsed) {
    const tree = this.tree;
    if (collapsed === tree.isCollapsed(node)) {
      return;
    }
    if (collapsed && tree.isAncestor(node, this.nodeOf(gBrowser.selectedTab))) {
      gBrowser.selectedTab = tree.leadOf(node);
    }
    tree.setCollapsedAttr(node, collapsed);
    this.rebuild();
  }

  toggleCollapsed(node) {
    this.setCollapsed(node, !this.tree.isCollapsed(node));
  }

  setAllCollapsed(collapsed) {
    const tree = this.tree;
    const selected = this.nodeOf(gBrowser.selectedTab);
    for (const node of tree.allNodes()) {
      if (node.hasAttribute(ATTR.hasChildren)) {
        if (collapsed && tree.isAncestor(node, selected) && !tree.parentOf(node)) {
          gBrowser.selectedTab = tree.leadOf(node);
        }
        tree.setCollapsedAttr(node, collapsed);
      }
    }
    this.rebuild();
  }

  #expandAncestors(node) {
    const tree = this.tree;
    for (let p = tree.parentOf(node), i = 0; p && i < MAX_DEPTH_WALK; p = tree.parentOf(p), i++) {
      tree.setCollapsedAttr(p, false);
    }
    this.rebuild();
  }

  /** "Nest Under Sibling Above": `node` becomes the last child of its previous sibling. */
  nestUnderSiblingAbove(node) {
    const tree = this.tree;
    const sibling = tree.isNode(node) && tree.previousSibling(node);
    if (!sibling) {
      return;
    }
    tree.setParent(node, sibling);
    tree.setCollapsedAttr(sibling, false);
    this.rebuild();
  }

  /** "Move Out of Parent": `node` (with its subtree) becomes its parent's next sibling. */
  moveOutOfParent(node) {
    const tree = this.tree;
    const parent = tree.isNode(node) && tree.parentOf(node);
    if (!parent) {
      return;
    }
    this.#moveSubtreeAfterTree(node, parent);
    tree.setParentId(node, tree.parentIdOf(parent));
    this.rebuild();
  }

  /** Make `node` (with its subtree) a top-level node right after its current tree. */
  detachFromTree(node) {
    const tree = this.tree;
    if (!tree.isNode(node) || !tree.parentOf(node)) {
      return;
    }
    let root = node;
    while (tree.parentOf(root)) {
      root = tree.parentOf(root);
    }
    this.#moveSubtreeAfterTree(node, root);
    tree.setParent(node, null);
    this.rebuild();
  }

  /** Moves `node`'s subtree right after the end of `ancestor`'s subtree. */
  #moveSubtreeAfterTree(node, ancestor) {
    const tree = this.tree;
    const subtree = tree.subtreeOf(node);
    const last = tree.descendantsOf(ancestor).filter(n => !subtree.includes(n)).at(-1) ?? ancestor;
    if (tree.nextNode(last) !== node) {
      tree.moveNodesAfter(subtree, last);
    }
  }

  closeTree(node) {
    this.#removeTabsDirectly(this.tree.tabsOf(this.tree.subtreeOf(node)));
  }

  closeChildren(node) {
    this.#removeTabsDirectly(this.tree.tabsOf(this.tree.descendantsOf(node)));
  }

  /** Closes tabs without the close-branch planning or warning (the user asked for exactly these). */
  #removeTabsDirectly(tabs) {
    this.#withMarks(tabs, () => gBrowser.removeTabs(tabs));
  }

  #withMarks(tabs, fn) {
    for (const t of tabs) {
      this.#closeMarks.add(t);
    }
    try {
      return fn();
    } finally {
      // Cleared later: a close can finish asynchronously, or be cancelled by a prompt.
      setTimeout(() => {
        for (const t of tabs) {
          this.#closeMarks.delete(t);
        }
      }, 1500);
    }
  }

  // ---------------------------------------------------- close-branch logic

  /**
   * Wraps gBrowser.removeTab / removeTabs. When the setting asks for it, closing a
   * tab that has children also closes them (after an optional warning); otherwise
   * everything is passed straight through and #onTabClose promotes the children.
   * Returns the function that restores the originals.
   */
  #guardClosing() {
    const self = this;
    const { removeTab, removeTabs } = gBrowser;
    gBrowser.removeTab = function (tab, options) {
      if (self.#closeMarks.has(tab)) {
        return removeTab.call(this, tab, options);
      }
      const plan = self.#planClose([tab]);
      if (!plan) {
        return removeTab.call(this, tab, options);
      }
      if (!self.#confirmClose(plan)) {
        return undefined;
      }
      return self.#withMarks(plan.tabs, () => removeTabs.call(this, plan.tabs));
    };
    gBrowser.removeTabs = function (tabs, options) {
      const list = [...tabs];
      if (list.every(t => self.#closeMarks.has(t))) {
        return removeTabs.call(this, tabs, options);
      }
      const plan = self.#planClose(list);
      if (plan && !self.#confirmClose(plan)) {
        return undefined;
      }
      const all = plan ? plan.tabs : list;
      return self.#withMarks(all, () => removeTabs.call(this, all, options));
    };
    return () => {
      // The originals live on the prototype.
      delete gBrowser.removeTab;
      delete gBrowser.removeTabs;
    };
  }

  /** Which extra tabs close with `tabs` under the current setting, or null for none. */
  #planClose(tabs) {
    const mode = this.settings.get("closeParentMode");
    if (mode === "promote") {
      return null;
    }
    const tree = this.tree;
    const closing = new Set(tabs);
    const all = new Set(tabs);
    const extra = [];
    for (const tab of tabs) {
      if (!gBrowser.isTab(tab)) {
        continue;
      }
      const node = tree.nodeOf(tab);
      // A split view that lives on keeps its place; only a node closing entirely takes its branch along.
      if (!tree.isNode(node) || !tree.membersOf(node).every(m => closing.has(m))) {
        continue;
      }
      if (mode === "collapsed" && !tree.isCollapsed(node)) {
        continue;
      }
      for (const t of tree.tabsOf(tree.descendantsOf(node))) {
        if (!all.has(t)) {
          all.add(t);
          extra.push(t);
        }
      }
    }
    return extra.length ? { tabs: [...all], extra } : null;
  }

  #confirmClose(plan) {
    const settings = this.settings;
    const n = plan.extra.length;
    if (!settings.get("closeWarning") || n < settings.get("closeWarningMin")) {
      return true;
    }
    const check = { value: false };
    const ok = Services.prompt.confirmCheck(
      window,
      "Close whole branch?",
      n === 1
        ? "Closing this tab will also close 1 tab nested under it."
        : `Closing this tab will also close ${n} tabs nested under it.`,
      "Don't ask me again",
      check
    );
    if (ok && check.value) {
      settings.set("closeWarning", false);
    }
    return ok;
  }

  // ---------------------------------------------------------- auto-collapse

  /** Collapses branches that don't lead to the selected node, per the "autoCollapse" setting. */
  #autoCollapse(selected) {
    const mode = this.settings.get("autoCollapse");
    const tree = this.tree;
    if (mode === "off" || !tree.isNode(selected)) {
      return;
    }
    const path = new Set([selected]);
    for (let p = tree.parentOf(selected), i = 0; p && i < MAX_DEPTH_WALK; p = tree.parentOf(p), i++) {
      path.add(p);
    }
    for (const node of tree.allNodes()) {
      if (node.parentElement !== selected.parentElement || path.has(node)) {
        continue; // other spaces are left alone
      }
      if (mode === "roots" && tree.parentOf(node)) {
        continue;
      }
      if (node.hasAttribute(ATTR.hasChildren)) {
        tree.setCollapsedAttr(node, true);
      }
    }
  }

  // ------------------------------------- public API (other windows, tools)

  nodeOf(tab) {
    return this.tree.nodeOf(tab);
  }

  descendantsOf(node) {
    return this.tree.descendantsOf(node);
  }

  /** Called by another window when the mirrored copy of `tab` changed. */
  receiveState(tab, value) {
    this.store.receive(tab, value);
  }

  stateOf(tab) {
    return this.store.stateOf(tab);
  }
}

this.ZenTreeTabs = ZenTreeTabs;
