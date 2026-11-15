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
 *
 * Tree *nodes* are the direct children of a space's normal tab list: a tab,
 * or a split-view group acting as a single node. A split group takes its
 * parent from its member tabs, and a tab whose parent is any member of a
 * group is a child of that group.
 *
 * Node order is the DOM order; a node's subtree always directly follows it.
 * Event handlers (open/close/move/pin/user actions) are the only code that
 * changes links. rebuild() is idempotent: it derives depth, visibility and
 * decorations from the links and never edits them, so transient orderings
 * (e.g. while Zen syncs windows or restores a session) cannot corrupt the tree.
 */
"use strict";

(function () {
  const ATTR = {
    parent: "ztt-parent",
    collapsed: "ztt-collapsed",
    // Computed by rebuild(), on nodes:
    depth: "ztt-depth",
    hasChildren: "ztt-has-children",
    hidden: "ztt-hidden",
    // Computed by rebuild(), on the tab showing a node's decorations:
    twisty: "ztt-twisty", // "open" | "closed"
    guides: "ztt-guides",
    // Drag and drop feedback:
    dropTarget: "ztt-drop-target",
  };
  const NODE_COMPUTED_ATTRS = [ATTR.depth, ATTR.hasChildren, ATTR.hidden];
  const STORE_KEY = "zenTreeTabs";
  const SECTION_CLASS = "zen-workspace-normal-tabs-section";
  const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
  const INDENT_PX = 18;
  const CHILD_DROP_ZONE = [0.25, 0.75]; // middle band of a row = drop as child
  const MAX_DEPTH_WALK = 1000;
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

  class ZenTreeTabs {
    #flushQueued = false;
    #internalMove = 0;
    #pendingOpens = new Set();
    #pendingMoves = new Set();
    #pendingGrouped = new Set();
    /** tab -> last persisted state string, to only write/broadcast changes. */
    #saved = new WeakMap();
    /** tab -> other members of its split group as of the last rebuild. */
    #splitMates = new WeakMap();
    /** Explicit "drop as child" from drag and drop: { parent, nodes:Set }. */
    #dropIntent = null;
    #dropTarget = null;
    #iconCenter = 0;
    #cleanups = [];

    // ---------------------------------------------------------------- setup

    init() {
      document.documentElement.style.setProperty("--ztt-indent-step", `${INDENT_PX}px`);
      for (const type of TAB_EVENTS) {
        window.addEventListener(type, this);
      }
      window.addEventListener("mousedown", this, true);
      window.addEventListener("click", this, true);
      this.#cleanups.push(() => {
        for (const type of TAB_EVENTS) {
          window.removeEventListener(type, this);
        }
        window.removeEventListener("mousedown", this, true);
        window.removeEventListener("click", this, true);
      });
      this.#patchDragAndDrop();
      this.#createContextMenu();
      this.#createShortcuts();

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
      for (const cleanup of this.#cleanups.reverse()) {
        try {
          cleanup();
        } catch (e) {
          console.error(e);
        }
      }
      this.#cleanups = [];
      // Leave ztt-parent/ztt-collapsed alone: they are harmless without the
      // stylesheet and let a re-enabled add-on pick the tree back up.
      for (const el of document.querySelectorAll("[ztt-depth], [ztt-has-children], [ztt-hidden], [ztt-twisty], [ztt-guides]")) {
        this.#clearComputed(el);
        this.#removeDecorations(el);
      }
      for (const el of document.querySelectorAll(".ztt-twisty, .ztt-count, .ztt-guides")) {
        el.remove();
      }
      document.documentElement.style.removeProperty("--ztt-indent-step");
      document.documentElement.style.removeProperty("--ztt-icon-center");
    }

    handleEvent(event) {
      const target = event.target;
      switch (event.type) {
        case "TabOpen":
          this.#pendingOpens.add(target);
          this.scheduleFlush();
          break;
        case "TabClose":
          this.#onTabClose(target);
          break;
        case "TabMove":
        case "TabUngrouped":
        case "ZenSplitViewTabsSplit":
        case "ZenTabRemovedFromSplit":
          if (!this.#internalMove && !this.#isMirroredChange()) {
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
          break;
        case "TabPinned":
          this.#detach(target);
          break;
        case "SSTabRestoring":
          this.#restoreTab(target);
          this.scheduleFlush();
          break;
        case "mousedown":
        case "click":
          this.#onTwistyMouse(event);
          break;
      }
    }

    // --------------------------------------------------------------- nodes

    #splitGroupOf(tab) {
      const group = tab.group;
      return group?.hasAttribute("split-view-group") ? group : null;
    }

    /** The tree node a tab belongs to: its split-view group, or itself. */
    nodeOf(tab) {
      return this.#splitGroupOf(tab) ?? tab;
    }

    isNode(el) {
      if (!el?.parentElement?.classList.contains(SECTION_CLASS)) {
        return false;
      }
      if (gBrowser.isTab(el)) {
        return !el.pinned && !el.hasAttribute("zen-empty-tab") && !el.hasAttribute("zen-glance-tab");
      }
      return gBrowser.isTabGroup(el) && el.hasAttribute("split-view-group") && this.#membersOf(el).length > 0;
    }

    #membersOf(node) {
      return gBrowser.isTab(node) ? [node] : node.tabs.filter(t => !t.closing);
    }

    /** The tab that represents a node: links point to it, decorations live on it. */
    #leadOf(node) {
      return this.#membersOf(node)[0] ?? null;
    }

    /** Items the tree logic steps over without breaking a tree. */
    #isTransparent(el) {
      if (gBrowser.isTabGroup(el)) {
        // A split group being dissolved.
        return el.hasAttribute("split-view-group") && !el.tabs.some(t => !t.closing);
      }
      return (
        gBrowser.isTab(el) &&
        (el.closing || el.hidden || el.hasAttribute("zen-glance-tab") || el.hasAttribute("zen-empty-tab"))
      );
    }

    #allNodes() {
      const nodes = [];
      for (const section of document.querySelectorAll(`.${SECTION_CLASS}`)) {
        for (const el of section.children) {
          if (!this.#isTransparent(el) && this.isNode(el)) {
            nodes.push(el);
          }
        }
      }
      return nodes;
    }

    #nextNode(node) {
      for (let el = node.nextElementSibling; el; el = el.nextElementSibling) {
        if (!this.#isTransparent(el)) {
          return this.isNode(el) ? el : null;
        }
      }
      return null;
    }

    #previousNode(node) {
      for (let el = node.previousElementSibling; el; el = el.previousElementSibling) {
        if (!this.#isTransparent(el)) {
          return this.isNode(el) ? el : null;
        }
      }
      return null;
    }

    #parentTabOf(tab) {
      const id = tab.getAttribute(ATTR.parent);
      if (!id) {
        return null;
      }
      const parent = document.getElementById(id);
      return parent !== tab && gBrowser.isTab(parent) ? parent : null;
    }

    parentOf(node) {
      for (const member of this.#membersOf(node)) {
        const parentTab = this.#parentTabOf(member);
        if (parentTab) {
          const parent = this.nodeOf(parentTab);
          if (parent !== node) {
            return parent;
          }
        }
      }
      return null;
    }

    isAncestor(ancestor, node) {
      let current = node;
      for (let i = 0; i < MAX_DEPTH_WALK && current; i++) {
        current = this.parentOf(current);
        if (current === ancestor) {
          return true;
        }
      }
      return false;
    }

    /** Direct children, in tab order. Works for a node that is closing. */
    childrenOf(node) {
      return this.#allNodes().filter(n => n !== node && this.parentOf(n) === node);
    }

    /** All descendants, in tab order. */
    descendantsOf(node) {
      return this.#allNodes().filter(n => n !== node && this.isAncestor(node, n));
    }

    #isCollapsed(node) {
      return this.#membersOf(node).some(t => t.hasAttribute(ATTR.collapsed));
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

    /** The parent id a node links to outside of itself (may be dangling). */
    #parentIdOf(node) {
      const members = this.#membersOf(node);
      for (const member of members) {
        const id = member.getAttribute(ATTR.parent);
        if (id && !members.some(m => m.id === id)) {
          return id;
        }
      }
      return null;
    }

    #setParentId(node, id) {
      for (const member of this.#membersOf(node)) {
        if (id) {
          member.setAttribute(ATTR.parent, id);
        } else {
          member.removeAttribute(ATTR.parent);
        }
      }
    }

    #setParent(node, parent) {
      this.#setParentId(node, parent ? this.#idOf(this.#leadOf(parent)) : null);
    }

    #setCollapsedAttr(node, collapsed) {
      for (const member of this.#membersOf(node)) {
        member.toggleAttribute(ATTR.collapsed, collapsed);
      }
    }

    /**
     * Removes `node` from the tree, keeping its subtree together: the first
     * child takes its place and the other children become that child's children.
     */
    #promoteChildren(node) {
      const [first, ...rest] = this.childrenOf(node);
      if (!first) {
        return;
      }
      this.#setParentId(first, this.#parentIdOf(node));
      this.#setCollapsedAttr(first, this.#isCollapsed(node));
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

    #moveNodesAfter(nodes, target) {
      this.#internalMove++;
      try {
        gBrowser.moveTabsAfter(nodes, target);
      } finally {
        this.#internalMove--;
      }
    }

    /** Node plus descendants, for moving a whole subtree. */
    #subtreeOf(node) {
      return [node, ...this.descendantsOf(node)];
    }

    setCollapsed(node, collapsed) {
      if (collapsed === this.#isCollapsed(node)) {
        return;
      }
      if (collapsed && this.isAncestor(node, this.nodeOf(gBrowser.selectedTab))) {
        gBrowser.selectedTab = this.#leadOf(node);
      }
      this.#setCollapsedAttr(node, collapsed);
      this.rebuild();
    }

    toggleCollapsed(node) {
      this.setCollapsed(node, !this.#isCollapsed(node));
    }

    setAllCollapsed(collapsed) {
      const selected = this.nodeOf(gBrowser.selectedTab);
      for (const node of this.#allNodes()) {
        if (node.hasAttribute(ATTR.hasChildren)) {
          if (collapsed && this.isAncestor(node, selected) && !this.parentOf(node)) {
            gBrowser.selectedTab = this.#leadOf(node);
          }
          this.#setCollapsedAttr(node, collapsed);
        }
      }
      this.rebuild();
    }

    #expandAncestors(node) {
      for (let p = this.parentOf(node), i = 0; p && i < MAX_DEPTH_WALK; p = this.parentOf(p), i++) {
        this.#setCollapsedAttr(p, false);
      }
      this.rebuild();
    }

    /** Make `node` the last child of its previous sibling. */
    indent(node) {
      if (!this.isNode(node)) {
        return;
      }
      const parent = this.parentOf(node);
      let sibling = this.#previousNode(node);
      while (sibling && sibling !== parent && this.parentOf(sibling) !== parent) {
        sibling = this.#previousNode(sibling);
      }
      if (!sibling || sibling === parent) {
        return;
      }
      this.#setParent(node, sibling);
      this.#setCollapsedAttr(sibling, false);
      this.rebuild();
    }

    /** Make `node` the next sibling of its parent. */
    outdent(node) {
      const parent = this.isNode(node) && this.parentOf(node);
      if (!parent) {
        return;
      }
      const subtree = this.#subtreeOf(node);
      const last = this.descendantsOf(parent).filter(n => !subtree.includes(n)).at(-1) ?? parent;
      if (this.#nextNode(last) !== node) {
        this.#moveNodesAfter(subtree, last);
      }
      this.#setParentId(node, this.#parentIdOf(parent));
      this.rebuild();
    }

    /** Make `node` (with its subtree) a top-level node right after its current tree. */
    detachFromTree(node) {
      if (!this.isNode(node) || !this.parentOf(node)) {
        return;
      }
      let root = node;
      while (this.parentOf(root)) {
        root = this.parentOf(root);
      }
      const subtree = this.#subtreeOf(node);
      const last = this.descendantsOf(root).filter(n => !subtree.includes(n)).at(-1) ?? root;
      if (this.#nextNode(last) !== node) {
        this.#moveNodesAfter(subtree, last);
      }
      this.#setParent(node, null);
      this.rebuild();
    }

    #tabsOf(nodes) {
      return nodes.flatMap(n => this.#membersOf(n));
    }

    closeTree(node) {
      gBrowser.removeTabs(this.#tabsOf(this.#subtreeOf(node)));
    }

    closeChildren(node) {
      gBrowser.removeTabs(this.#tabsOf(this.descendantsOf(node)));
    }

    // ------------------------------------------------------- event logic

    #onTabOpen(tab) {
      let opener = tab.openerTab;
      if (opener?.hasAttribute("zen-glance-tab")) {
        opener = gZenGlanceManager.getTabOrGlanceParent(opener);
      }
      if (!opener || opener.closing || !this.isNode(tab) || tab.hasAttribute(ATTR.parent)) {
        return;
      }
      const parent = this.nodeOf(opener);
      if (!this.isNode(parent) || parent.parentElement !== tab.parentElement) {
        return;
      }
      this.#setParent(tab, parent);
      this.#setCollapsedAttr(parent, false);
      // New children go to the end of the opener's subtree.
      const last = this.descendantsOf(parent).filter(n => n !== tab).at(-1) ?? parent;
      if (this.#nextNode(last) !== tab) {
        this.#moveNodesAfter([tab], last);
      }
    }

    #onTabClose(tab) {
      // Zen may already have dissolved the split group, so use the remembered mates.
      const others = (this.#splitMates.get(tab) ?? []).filter(t => t.isConnected && !t.closing);
      if (others.length) {
        // The split group lives on: hand this tab's links over to another member.
        const heir = others[0];
        const ownParentId = tab.getAttribute(ATTR.parent);
        const parentId =
          ownParentId && !others.some(t => t.id === ownParentId)
            ? ownParentId
            : others.map(t => t.getAttribute(ATTR.parent)).find(id => id && id !== tab.id && !others.some(t => t.id === id)) ?? null;
        const collapsed = tab.hasAttribute(ATTR.collapsed) || others.some(t => t.hasAttribute(ATTR.collapsed));
        for (const t of gBrowser.tabs) {
          if (t.getAttribute(ATTR.parent) === tab.id) {
            this.#setParent(t, heir);
          }
        }
        for (const member of others) {
          this.#setParentId(member, parentId);
          member.toggleAttribute(ATTR.collapsed, collapsed);
        }
      } else {
        this.#promoteChildren(tab);
      }
      this.scheduleFlush();
    }

    /** A node was moved by something other than us: keep its subtree with it and re-derive its parent. */
    #onNodeMoved(node) {
      if (!this.isNode(node)) {
        return;
      }
      let descendants = this.descendantsOf(node);
      if (descendants.some(d => d.parentElement !== node.parentElement)) {
        // Moved to another space: it leaves its tree behind.
        this.#promoteChildren(node);
        this.#setCollapsedAttr(node, false);
        descendants = [];
      } else if (descendants.length) {
        const inPlace = descendants.every((d, i) => this.#nextNode(i ? descendants[i - 1] : node) === d);
        if (!inPlace) {
          this.#moveNodesAfter(descendants, node);
        }
      }

      if (this.#dropIntent?.nodes.has(node)) {
        return; // Parent set explicitly by the drop.
      }
      const next = this.#nextNode(descendants.at(-1) ?? node);
      const nextParent = next ? this.parentOf(next) : null;
      const oldParent = this.parentOf(node);
      let newParent = nextParent;
      if (oldParent && this.#isInsideSubtree(node, oldParent)) {
        // Still among its siblings: keep the parent, unless the next node needs
        // a deeper one to stay attached to its own parent.
        newParent = nextParent && this.isAncestor(oldParent, nextParent) ? nextParent : oldParent;
      }
      if (newParent !== oldParent || (!newParent && this.#parentIdOf(node)) || !gBrowser.isTab(node)) {
        // For split groups this also gives every member the same parent, so
        // whichever tab survives the split keeps the group's place.
        this.#setParent(node, newParent);
      }
    }

    /** Whether `node` sits inside `ancestor`'s subtree region (only its descendants in between). */
    #isInsideSubtree(node, ancestor) {
      if (ancestor.parentElement !== node.parentElement) {
        return false;
      }
      for (let el = this.#nextNode(ancestor); el; el = this.#nextNode(el)) {
        if (el === node) {
          return true;
        }
        if (!this.isAncestor(ancestor, el)) {
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
      if (event.button !== 0) {
        return;
      }
      const tab = event.target.closest?.(`.tabbrowser-tab[${ATTR.twisty}]`);
      const icon = event.target.closest?.(".tab-icon-stack");
      if (!tab || !icon || !tab.contains(icon) || !this.#isSidebarExpanded()) {
        return;
      }
      // Keep the tab from being selected or dragged.
      event.stopPropagation();
      event.preventDefault();
      if (event.type === "click") {
        this.toggleCollapsed(this.nodeOf(tab));
      }
    }

    #isSidebarExpanded() {
      return document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
    }

    // ------------------------------------------------------ drag and drop

    #patchDragAndDrop() {
      const dnd = gBrowser.tabContainer.tabDragAndDrop;
      if (!dnd) {
        return;
      }
      const self = this;
      const { handle_dragover, handle_drop, handle_dragend } = dnd;
      dnd.handle_dragover = function (event) {
        const result = handle_dragover.call(this, event);
        try {
          self.#onDragOver(event);
        } catch (e) {
          console.error(e);
        }
        return result;
      };
      dnd.handle_drop = function (event) {
        const target = self.#dropTarget;
        const nodes = self.#draggedNodes(event);
        const splitting = !!document.querySelector("zen-split-fake-tab");
        self.#setDropTarget(null);
        if (target && nodes && !splitting) {
          self.#dropIntent = { parent: target, nodes: new Set(nodes) };
        }
        try {
          return handle_drop.call(this, event);
        } finally {
          self.#applyDropIntent();
        }
      };
      dnd.handle_dragend = function (event) {
        self.#setDropTarget(null);
        return handle_dragend.call(this, event);
      };
      this.#cleanups.push(() => {
        // The originals live on the prototype.
        delete dnd.handle_dragover;
        delete dnd.handle_drop;
        delete dnd.handle_dragend;
        this.#setDropTarget(null);
      });
    }

    #draggedNodes(event) {
      const dragged = event.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
      const movingTabs = dragged?._dragData?.movingTabs;
      if (!movingTabs?.length || !movingTabs.every(t => gBrowser.isTab(t))) {
        return null;
      }
      return [...new Set(movingTabs.map(t => this.nodeOf(t)))];
    }

    #onDragOver(event) {
      const dragged = event.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
      const nodes = this.#draggedNodes(event);
      const row = event.target.closest?.(".tabbrowser-tab");
      const target = row && this.nodeOf(row);
      let valid =
        nodes &&
        target &&
        this.#isSidebarExpanded() &&
        this.isNode(target) &&
        nodes.every(n => this.isNode(n) && n !== target && !this.isAncestor(n, target)) &&
        !document.querySelector("zen-split-fake-tab");
      if (valid) {
        const rect = window.windowUtils.getBoundsWithoutFlushing(target);
        const ratio = (event.clientY - rect.top) / rect.height;
        valid = ratio >= CHILD_DROP_ZONE[0] && ratio <= CHILD_DROP_ZONE[1];
      }
      if (!valid) {
        this.#setDropTarget(null);
        return;
      }
      this.#setDropTarget(target);
      // Make Zen drop the tabs right after the target: they become its first children.
      dragged._dragData.dropElement = target;
      dragged._dragData.dropBefore = false;
    }

    #setDropTarget(node) {
      if (this.#dropTarget === node) {
        return;
      }
      this.#dropTarget?.removeAttribute(ATTR.dropTarget);
      this.#dropTarget = node;
      node?.setAttribute(ATTR.dropTarget, "true");
      document.documentElement.toggleAttribute("ztt-dropping-child", !!node);
    }

    #applyDropIntent() {
      const intent = this.#dropIntent;
      if (!intent) {
        return;
      }
      if (!intent.parent.isConnected || !this.isNode(intent.parent)) {
        this.#dropIntent = null;
        return;
      }
      for (const node of intent.nodes) {
        // Keep dragged children attached to a dragged parent.
        if (node.isConnected && !intent.nodes.has(this.parentOf(node))) {
          this.#setParent(node, intent.parent);
        }
      }
      this.#setCollapsedAttr(intent.parent, false);
      this.scheduleFlush(); // The flush clears the intent once moves are processed.
    }

    // ------------------------------------------------- menu & shortcuts

    #createContextMenu() {
      const menu = document.getElementById("tabContextMenu");
      if (!menu) {
        return;
      }
      const make = (tag, attrs) => {
        const el = document.createXULElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
          el.setAttribute(k, v);
        }
        return el;
      };
      const separator = make("menuseparator", { id: "ztt-context-separator" });
      const submenu = make("menu", { id: "ztt-context-menu", label: "Tree" });
      const popup = make("menupopup", { id: "ztt-context-popup" });
      submenu.append(popup);
      const items = {
        toggle: { label: "Collapse Tree", run: n => this.toggleCollapsed(n) },
        closeTree: { label: "Close Tree", run: n => this.closeTree(n) },
        closeChildren: { label: "Close Children", run: n => this.closeChildren(n) },
        sep1: null,
        indent: { label: "Indent", key: "Alt+Shift+→", run: n => this.indent(n) },
        outdent: { label: "Outdent", key: "Alt+Shift+←", run: n => this.outdent(n) },
        detach: { label: "Detach from Tree", run: n => this.detachFromTree(n) },
        sep2: null,
        collapseAll: { label: "Collapse All Trees", run: () => this.setAllCollapsed(true) },
        expandAll: { label: "Expand All Trees", run: () => this.setAllCollapsed(false) },
      };
      const elements = {};
      for (const [name, item] of Object.entries(items)) {
        if (!item) {
          popup.append(make("menuseparator", {}));
          continue;
        }
        const el = make("menuitem", { id: `ztt-context-${name}`, label: item.label });
        if (item.key) {
          el.setAttribute("acceltext", item.key);
        }
        el.addEventListener("command", () => {
          const node = this.#contextNode();
          if (node) {
            item.run(node);
          }
        });
        popup.append(el);
        elements[name] = el;
      }
      const anchor = document.getElementById("context_closeTab");
      if (anchor) {
        anchor.before(separator, submenu);
      } else {
        menu.append(separator, submenu);
      }

      const onShowing = event => {
        if (event.target !== menu) {
          return;
        }
        const node = this.#contextNode();
        const isNode = !!node && this.isNode(node);
        separator.hidden = submenu.hidden = !isNode;
        if (!isNode) {
          return;
        }
        const hasChildren = node.hasAttribute(ATTR.hasChildren);
        const parent = this.parentOf(node);
        elements.toggle.setAttribute("label", this.#isCollapsed(node) ? "Expand Tree" : "Collapse Tree");
        elements.toggle.disabled = !hasChildren;
        elements.closeTree.disabled = !hasChildren;
        elements.closeChildren.disabled = !hasChildren;
        elements.outdent.disabled = !parent;
        elements.detach.disabled = !parent;
        let sibling = this.#previousNode(node);
        while (sibling && sibling !== parent && this.parentOf(sibling) !== parent) {
          sibling = this.#previousNode(sibling);
        }
        elements.indent.disabled = !sibling || sibling === parent;
      };
      menu.addEventListener("popupshowing", onShowing);
      this.#cleanups.push(() => {
        menu.removeEventListener("popupshowing", onShowing);
        separator.remove();
        submenu.remove();
      });
    }

    #contextNode() {
      const tab = TabContextMenu.contextTab;
      return tab ? this.nodeOf(tab) : null;
    }

    #createShortcuts() {
      const keyset = document.createXULElement("keyset");
      keyset.id = "ztt-keyset";
      const commandset = document.createXULElement("commandset");
      commandset.id = "ztt-commandset";
      const shortcuts = [
        ["VK_RIGHT", node => this.indent(node)],
        ["VK_LEFT", node => this.outdent(node)],
        [
          "VK_DOWN",
          node => {
            // Toggle the current branch: the tab itself if it has children, else its parent.
            const target = node.hasAttribute(ATTR.hasChildren) ? node : this.parentOf(node);
            if (target) {
              this.toggleCollapsed(target);
            }
          },
        ],
      ];
      for (const [keycode, run] of shortcuts) {
        // Keys are only active when bound to a <command>.
        const command = document.createXULElement("command");
        command.id = `ztt-cmd-${keycode}`;
        command.addEventListener("command", () => {
          const node = this.nodeOf(gBrowser.selectedTab);
          if (this.isNode(node)) {
            run(node);
          }
        });
        commandset.append(command);
        const key = document.createXULElement("key");
        key.id = `ztt-key-${keycode}`;
        key.setAttribute("keycode", keycode);
        key.setAttribute("modifiers", "alt,shift");
        key.setAttribute("command", command.id);
        keyset.append(key);
      }
      document.documentElement.append(commandset, keyset);
      this.#cleanups.push(() => {
        keyset.remove();
        commandset.remove();
      });
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

        const grouped = [...this.#pendingGrouped];
        this.#pendingGrouped.clear();
        for (const tab of grouped) {
          // Folders take tabs out of the tree; split views keep them in as a group node.
          if (tab.isConnected && tab.group && !this.#splitGroupOf(tab)) {
            this.#detach(tab);
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
      } catch (e) {
        console.error("zen-tree-tabs: flush failed", e);
      }
      this.#dropIntent = null;
      this.rebuild();
    }

    // ---------------------------------------------------------- rebuild

    /** Recomputes depth, visibility and decorations from the links. Never edits links. */
    rebuild() {
      const info = new Map(); // node -> { depth, hidden, ancestors }
      const lastChild = new Map(); // parent node (or section) -> last child seen
      for (const section of document.querySelectorAll(`.${SECTION_CLASS}`)) {
        let stack = [];
        for (const el of section.children) {
          if (this.#isTransparent(el)) {
            continue;
          }
          if (!this.isNode(el)) {
            stack = [];
            continue;
          }
          const parent = this.parentOf(el);
          const index = parent ? stack.lastIndexOf(parent) : -1;
          stack.length = index + 1; // invalid or missing parent -> shown at root
          info.set(el, {
            depth: stack.length,
            hidden: stack.some(n => this.#isCollapsed(n)),
            ancestors: [...stack],
          });
          lastChild.set(stack.at(-1) ?? section, el);
          stack.push(el);
        }
      }

      const descendantCounts = new Map();
      for (const { ancestors } of info.values()) {
        for (const a of ancestors) {
          descendantCounts.set(a, (descendantCounts.get(a) ?? 0) + 1);
        }
      }
      const hasLaterSibling = node => {
        const { ancestors } = info.get(node);
        return lastChild.get(ancestors.at(-1) ?? node.parentElement) !== node;
      };

      for (const [node, { depth, hidden, ancestors }] of info) {
        const count = descendantCounts.get(node) ?? 0;
        if (depth) {
          node.setAttribute(ATTR.depth, depth);
          node.style.setProperty("--ztt-depth", depth);
        } else {
          node.removeAttribute(ATTR.depth);
          node.style.removeProperty("--ztt-depth");
        }
        node.toggleAttribute(ATTR.hidden, hidden);
        node.toggleAttribute(ATTR.hasChildren, count > 0);

        const lead = this.#leadOf(node);
        const members = this.#membersOf(node);
        for (const member of members) {
          this.#splitMates.set(member, members.length > 1 ? members.filter(m => m !== member) : []);
          if (member !== node) {
            this.#clearComputed(member);
          }
          if (member !== lead) {
            this.#removeDecorations(member);
          }
        }
        this.#decorate(lead, count, this.#isCollapsed(node), depth, [...ancestors.slice(1), node].map(hasLaterSibling));
      }

      // Tabs and groups that are not (or no longer) tree nodes.
      for (const el of document.querySelectorAll("[ztt-depth], [ztt-has-children], [ztt-hidden], [ztt-twisty], [ztt-guides]")) {
        if (!info.has(el) && !(gBrowser.isTab(el) && info.has(this.nodeOf(el)))) {
          this.#clearComputed(el);
          this.#removeDecorations(el);
        }
      }
      for (const tab of gBrowser.tabs) {
        this.#persist(tab);
      }
    }

    #clearComputed(el) {
      for (const attr of NODE_COMPUTED_ATTRS) {
        el.removeAttribute(attr);
      }
      el.style.removeProperty("--ztt-depth");
    }

    #removeDecorations(tab) {
      tab.removeAttribute(ATTR.twisty);
      tab.removeAttribute(ATTR.guides);
      tab.querySelector(".ztt-guides")?.remove();
    }

    /**
     * Twisty + collapsed badge on the favicon, and the guide lines left of the node.
     *
     * @param continues  for each level 1..depth, whether the node on this tab's
     *                   path at that level has a later sibling (line goes on below).
     */
    #decorate(tab, count, collapsed, depth, continues) {
      if (count) {
        const icon = tab.querySelector(".tab-icon-stack");
        if (icon && !icon.querySelector(".ztt-twisty")) {
          const twisty = document.createXULElement("image");
          twisty.className = "ztt-twisty";
          const badge = document.createElement("span");
          badge.className = "ztt-count";
          icon.append(twisty, badge);
        }
        tab.setAttribute(ATTR.twisty, collapsed ? "closed" : "open");
        const badge = tab.querySelector(".ztt-count");
        if (badge) {
          badge.textContent = count > 99 ? "99+" : String(count);
        }
      } else {
        tab.removeAttribute(ATTR.twisty);
      }

      const stub = count > 0 && !collapsed; // line from the favicon down to the first child
      if (!depth && !stub) {
        tab.removeAttribute(ATTR.guides);
        tab.querySelector(".ztt-guides")?.remove();
        return;
      }
      // x positions are relative to the depth-0 tab edge, i.e. the guides' start.
      const center = this.#measureIconCenter(tab);
      const ownCenter = depth * INDENT_PX + center;
      const line = (x, y, w, h) =>
        `linear-gradient(var(--ztt-guide-color), var(--ztt-guide-color)) ${x}px ${y} / ${w} ${h} no-repeat`;
      const layers = [];
      for (let level = 1; level < depth; level++) {
        if (continues[level - 1]) {
          layers.push(line((level - 1) * INDENT_PX + center, "top", "1px", "100%"));
        }
      }
      if (depth) {
        const x = (depth - 1) * INDENT_PX + center;
        const elbowEnd = ownCenter - 11; // stop just before the favicon
        layers.push(line(x, "top", "1px", continues[depth - 1] ? "100%" : "50%"));
        layers.push(line(x, "center", `${elbowEnd - x}px`, "1px"));
      }
      if (stub) {
        layers.push(line(ownCenter, "bottom", "1px", "calc(50% - 10px)"));
      }
      const css = `left:${-depth * INDENT_PX}px;width:${ownCenter + 1}px;background:${layers.join(",")}`;

      let guides = tab.querySelector(":scope > .ztt-guides");
      if (!guides) {
        guides = document.createElement("div");
        guides.className = "ztt-guides";
        // Appended last: Zen's split preview inserts relative to the tab's first child.
        tab.append(guides);
      }
      if (guides.style.cssText !== css) {
        guides.style.cssText = css;
      }
      tab.setAttribute(ATTR.guides, "true");
    }

    /** Horizontal distance from a tab's start edge to its favicon's center. */
    #measureIconCenter(tab) {
      if (!this.#iconCenter) {
        const image = tab.querySelector(".tab-icon-image");
        const tabRect = window.windowUtils.getBoundsWithoutFlushing(tab);
        const imageRect = image && window.windowUtils.getBoundsWithoutFlushing(image);
        if (imageRect?.width) {
          this.#iconCenter = Math.round(imageRect.left + imageRect.width / 2 - tabRect.left);
          document.documentElement.style.setProperty("--ztt-icon-center", `${this.#iconCenter}px`);
        }
      }
      return this.#iconCenter || 16;
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
