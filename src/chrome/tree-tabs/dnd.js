/* Drop-as-child for Zen's tab drag and drop. Zen keeps handling the drag; we
 * wrap its handlers to add a middle-of-the-row zone: hovering it outlines the
 * row, and dropping there makes the dragged tabs that row's children. */
"use strict";

class DragAndDrop {
  #tree;
  #onDrop;
  #target = null;
  /** Explicit "drop as child" being applied: { parent, nodes: Set }. */
  intent = null;

  /** @param onDrop called after a drop as child, to process the resulting moves. */
  constructor(tree, onDrop) {
    this.#tree = tree;
    this.#onDrop = onDrop;
  }

  /** Wraps Zen's drag handlers; returns the function that unwraps them. */
  attach() {
    const dnd = gBrowser.tabContainer.tabDragAndDrop;
    if (!dnd) {
      return () => {};
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
      const target = self.#target;
      const nodes = self.#draggedNodes(event);
      const splitting = !!document.querySelector("zen-split-fake-tab");
      self.#setTarget(null);
      if (target && nodes && !splitting) {
        self.intent = { parent: target, nodes: new Set(nodes) };
      }
      try {
        return handle_drop.call(this, event);
      } finally {
        self.#applyIntent();
      }
    };
    dnd.handle_dragend = function (event) {
      self.#setTarget(null);
      return handle_dragend.call(this, event);
    };
    return () => {
      // The originals live on the prototype.
      delete dnd.handle_dragover;
      delete dnd.handle_drop;
      delete dnd.handle_dragend;
      this.#setTarget(null);
    };
  }

  #draggedNodes(event) {
    const dragged = event.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
    const movingTabs = dragged?._dragData?.movingTabs;
    if (!movingTabs?.length || !movingTabs.every(t => gBrowser.isTab(t))) {
      return null;
    }
    return [...new Set(movingTabs.map(t => this.#tree.nodeOf(t)))];
  }

  #onDragOver(event) {
    const tree = this.#tree;
    const dragged = event.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
    const nodes = this.#draggedNodes(event);
    const row = event.target.closest?.(".tabbrowser-tab");
    const target = row && tree.nodeOf(row);
    let valid =
      nodes &&
      target &&
      isSidebarExpanded() &&
      tree.isNode(target) &&
      nodes.every(n => tree.isNode(n) && n !== target && !tree.isAncestor(n, target)) &&
      !document.querySelector("zen-split-fake-tab");
    if (valid) {
      const rect = window.windowUtils.getBoundsWithoutFlushing(target);
      const ratio = (event.clientY - rect.top) / rect.height;
      valid = ratio >= CHILD_DROP_ZONE[0] && ratio <= CHILD_DROP_ZONE[1];
    }
    if (!valid) {
      this.#setTarget(null);
      return;
    }
    this.#setTarget(target);
    // Make Zen drop the tabs right after the target: they become its first children.
    dragged._dragData.dropElement = target;
    dragged._dragData.dropBefore = false;
  }

  #setTarget(node) {
    if (this.#target === node) {
      return;
    }
    this.#target?.removeAttribute(ATTR.dropTarget);
    this.#target = node;
    node?.setAttribute(ATTR.dropTarget, "true");
    document.documentElement.toggleAttribute("ztt-dropping-child", !!node);
  }

  #applyIntent() {
    const tree = this.#tree;
    const intent = this.intent;
    if (!intent) {
      return;
    }
    if (!intent.parent.isConnected || !tree.isNode(intent.parent)) {
      this.intent = null;
      return;
    }
    for (const node of intent.nodes) {
      // Keep dragged children attached to a dragged parent.
      if (node.isConnected && !intent.nodes.has(tree.parentOf(node))) {
        tree.setParent(node, intent.parent);
      }
    }
    tree.setCollapsedAttr(intent.parent, false);
    this.#onDrop(); // its flush clears the intent once the moves are processed
  }
}
