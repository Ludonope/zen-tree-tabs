/* The tree model: queries and link edits.
 *
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
 */
"use strict";

class Tree {
  /** > 0 while we move tabs ourselves, so those moves aren't treated as the user's. */
  internalMoves = 0;

  // ------------------------------------------------------------------ nodes

  splitGroupOf(tab) {
    const group = tab.group;
    return group?.hasAttribute("split-view-group") ? group : null;
  }

  /** The tree node a tab belongs to: its split-view group, or itself. */
  nodeOf(tab) {
    return this.splitGroupOf(tab) ?? tab;
  }

  isNode(el) {
    if (!el?.parentElement?.classList.contains(SECTION_CLASS)) {
      return false;
    }
    if (gBrowser.isTab(el)) {
      return !el.pinned && !el.hasAttribute("zen-empty-tab") && !el.hasAttribute("zen-glance-tab");
    }
    return gBrowser.isTabGroup(el) && el.hasAttribute("split-view-group") && this.membersOf(el).length > 0;
  }

  membersOf(node) {
    return gBrowser.isTab(node) ? [node] : node.tabs.filter(t => !t.closing);
  }

  /** The tab that represents a node: links point to it, decorations live on it. */
  leadOf(node) {
    return this.membersOf(node)[0] ?? null;
  }

  tabsOf(nodes) {
    return nodes.flatMap(n => this.membersOf(n));
  }

  /** Items the tree logic steps over without breaking a tree. */
  isTransparent(el) {
    if (gBrowser.isTabGroup(el)) {
      // A split group being dissolved.
      return el.hasAttribute("split-view-group") && !el.tabs.some(t => !t.closing);
    }
    return (
      gBrowser.isTab(el) &&
      (el.closing || el.hidden || el.hasAttribute("zen-glance-tab") || el.hasAttribute("zen-empty-tab"))
    );
  }

  sections() {
    return document.querySelectorAll(`.${SECTION_CLASS}`);
  }

  allNodes() {
    const nodes = [];
    for (const section of this.sections()) {
      for (const el of section.children) {
        if (!this.isTransparent(el) && this.isNode(el)) {
          nodes.push(el);
        }
      }
    }
    return nodes;
  }

  nextNode(node) {
    for (let el = node.nextElementSibling; el; el = el.nextElementSibling) {
      if (!this.isTransparent(el)) {
        return this.isNode(el) ? el : null;
      }
    }
    return null;
  }

  previousNode(node) {
    for (let el = node.previousElementSibling; el; el = el.previousElementSibling) {
      if (!this.isTransparent(el)) {
        return this.isNode(el) ? el : null;
      }
    }
    return null;
  }

  // ------------------------------------------------------------- relations

  parentTabOf(tab) {
    const id = tab.getAttribute(ATTR.parent);
    if (!id) {
      return null;
    }
    const parent = document.getElementById(id);
    return parent !== tab && gBrowser.isTab(parent) ? parent : null;
  }

  parentOf(node) {
    for (const member of this.membersOf(node)) {
      const parentTab = this.parentTabOf(member);
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
    return this.allNodes().filter(n => n !== node && this.parentOf(n) === node);
  }

  /** All descendants, in tab order. */
  descendantsOf(node) {
    return this.allNodes().filter(n => n !== node && this.isAncestor(node, n));
  }

  /** Node plus descendants, for moving or closing a whole subtree. */
  subtreeOf(node) {
    return [node, ...this.descendantsOf(node)];
  }

  /** The closest earlier node with the same parent, or null. */
  previousSibling(node) {
    const parent = this.parentOf(node);
    let sibling = this.previousNode(node);
    while (sibling && sibling !== parent && this.parentOf(sibling) !== parent) {
      sibling = this.previousNode(sibling);
    }
    return sibling && sibling !== parent ? sibling : null;
  }

  /** Whether `node` sits inside `ancestor`'s subtree region (only its descendants in between). */
  isInsideSubtree(node, ancestor) {
    if (ancestor.parentElement !== node.parentElement) {
      return false;
    }
    for (let el = this.nextNode(ancestor); el; el = this.nextNode(el)) {
      if (el === node) {
        return true;
      }
      if (!this.isAncestor(ancestor, el)) {
        return false;
      }
    }
    return false;
  }

  isCollapsed(node) {
    return this.membersOf(node).some(t => t.hasAttribute(ATTR.collapsed));
  }

  // ------------------------------------------------------------- link edits

  idOf(tab) {
    if (!tab.id) {
      // Zen assigns ids to every tab of synced windows; private / workspace-less
      // windows don't get one, so give the tab a local one.
      tab.id = `ztt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    }
    return tab.id;
  }

  /** The parent id a node links to outside of itself (may be dangling). */
  parentIdOf(node) {
    const members = this.membersOf(node);
    for (const member of members) {
      const id = member.getAttribute(ATTR.parent);
      if (id && !members.some(m => m.id === id)) {
        return id;
      }
    }
    return null;
  }

  setParentId(node, id) {
    for (const member of this.membersOf(node)) {
      if (id) {
        member.setAttribute(ATTR.parent, id);
      } else {
        member.removeAttribute(ATTR.parent);
      }
    }
  }

  setParent(node, parent) {
    this.setParentId(node, parent ? this.idOf(this.leadOf(parent)) : null);
  }

  setCollapsedAttr(node, collapsed) {
    for (const member of this.membersOf(node)) {
      member.toggleAttribute(ATTR.collapsed, collapsed);
    }
  }

  /**
   * Removes `node` from the tree, keeping its subtree together: the first
   * child takes its place and the other children become that child's children.
   */
  promoteChildren(node) {
    const [first, ...rest] = this.childrenOf(node);
    if (!first) {
      return;
    }
    this.setParentId(first, this.parentIdOf(node));
    this.setCollapsedAttr(first, this.isCollapsed(node));
    for (const child of rest) {
      this.setParent(child, first);
    }
  }

  /** Takes a tab out of the tree (pinned, put in a folder), its children closing ranks. */
  detach(tab) {
    this.promoteChildren(tab);
    tab.removeAttribute(ATTR.parent);
    tab.removeAttribute(ATTR.collapsed);
  }

  moveNodesAfter(nodes, target) {
    this.internalMoves++;
    try {
      gBrowser.moveTabsAfter(nodes, target);
    } finally {
      this.internalMoves--;
    }
  }
}
