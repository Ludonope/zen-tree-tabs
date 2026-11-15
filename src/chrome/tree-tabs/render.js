/* Rendering: derives depth, visibility, twisty, badge and guide lines from the
 * tree links. It never edits links, so transient orderings (e.g. while Zen
 * syncs windows or restores a session) can't corrupt the tree. */
"use strict";

class Renderer {
  #tree;
  /** Favicon geometry, see #measure(). */
  #metrics = { tabCenter: 19, groupCenter: 19, groupInset: 4, groupInsetTop: 4, groupInsetBottom: 4 };
  /** tab -> other members of its split group as of the last render. */
  splitMates = new WeakMap();

  constructor(tree) {
    this.#tree = tree;
  }

  /** Brings every tab's decorations in line with the tree. */
  render(selectedNode) {
    const tree = this.#tree;
    const info = new Map(); // node -> { depth, hidden, ancestors }
    const lastChild = new Map(); // parent node (or section) -> last child seen
    for (const section of tree.sections()) {
      let stack = [];
      for (const el of section.children) {
        if (tree.isTransparent(el)) {
          continue;
        }
        if (!tree.isNode(el)) {
          stack = [];
          continue;
        }
        const parent = tree.parentOf(el);
        const index = parent ? stack.lastIndexOf(parent) : -1;
        stack.length = index + 1; // invalid or missing parent -> shown at root
        info.set(el, {
          depth: stack.length,
          hidden: stack.some(n => tree.isCollapsed(n)),
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
    this.#measure([...info.keys()]);
    const hasLaterSibling = node => {
      const { ancestors } = info.get(node);
      return lastChild.get(ancestors.at(-1) ?? node.parentElement) !== node;
    };

    // Highlight the guides from the selected node's root down to it. A guide
    // column in a row is on the path when its ancestor is on the path and the
    // row comes before (fully lit) or is (lit down to the elbow) the path's
    // next node.
    const order = new Map([...info.keys()].map((n, i) => [n, i]));
    const path = info.has(selectedNode) ? [...info.get(selectedNode).ancestors, selectedNode] : [];
    const pathIndex = new Map(path.map((n, i) => [n, i]));
    const activeColumns = (node, ancestors) =>
      ancestors.map(a => {
        const next = path[pathIndex.get(a) + 1];
        if (!next) {
          return 0;
        }
        const delta = order.get(node) - order.get(next);
        return delta < 0 ? 1 : delta === 0 ? 2 : 0;
      });

    for (const [node, { depth, hidden, ancestors }] of info) {
      const count = descendantCounts.get(node) ?? 0;
      if (depth) {
        setAttr(node, ATTR.depth, String(depth));
      } else {
        node.removeAttribute(ATTR.depth);
      }
      setDepthVar(node, depth);
      node.toggleAttribute(ATTR.hidden, hidden);
      node.toggleAttribute(ATTR.hasChildren, count > 0);

      const lead = tree.leadOf(node);
      const members = tree.membersOf(node);
      for (const member of members) {
        this.splitMates.set(member, members.length > 1 ? members.filter(m => m !== member) : []);
        if (member !== node) {
          this.#clearComputed(member);
        }
        if (member !== lead) {
          this.#removeDecorations(member);
        }
      }
      this.#decorate(node, count, tree.isCollapsed(node), ancestors, [...ancestors.slice(1), node].map(hasLaterSibling), {
        columns: activeColumns(node, ancestors),
        stub: pathIndex.has(node) && node !== selectedNode,
      });
    }

    // Tabs and groups that are not (or no longer) tree nodes.
    for (const el of document.querySelectorAll("[ztt-depth], [ztt-has-children], [ztt-hidden], [ztt-twisty], [ztt-guides]")) {
      if (!info.has(el) && !(gBrowser.isTab(el) && info.has(tree.nodeOf(el)))) {
        this.#clearComputed(el);
        this.#removeDecorations(el);
      }
    }
  }

  /** Removes every decoration (the links stay, see ZenTreeTabs.uninit). */
  clear() {
    for (const el of document.querySelectorAll("[ztt-depth], [ztt-has-children], [ztt-hidden], [ztt-twisty], [ztt-guides]")) {
      this.#clearComputed(el);
      this.#removeDecorations(el);
    }
    for (const el of document.querySelectorAll(".ztt-twisty, .ztt-count, .ztt-guides")) {
      el.remove();
    }
  }

  #clearComputed(el) {
    for (const attr of NODE_COMPUTED_ATTRS) {
      el.removeAttribute(attr);
    }
    setDepthVar(el, 0);
  }

  #removeDecorations(tab) {
    tab.removeAttribute(ATTR.twisty);
    tab.removeAttribute(ATTR.guides);
    tab.querySelector(".ztt-guides")?.remove();
  }

  /**
   * Twisty + collapsed badge on the favicon, and the guide lines left of the node.
   *
   * @param ancestors  the node's ancestors, root first.
   * @param continues  for each level 1..depth, whether the node on this tab's
   *                   path at that level has a later sibling (line goes on below).
   * @param active     highlight of the selected tab's path: `columns[k]` is 0
   *                   (off), 1 (whole row) or 2 (down to this node) for the
   *                   ancestor-k column; `stub` lights the line under the favicon.
   */
  #decorate(node, count, collapsed, ancestors, continues, active) {
    const tab = this.#tree.leadOf(node);
    if (count) {
      const icon = tab.querySelector(".tab-icon-stack");
      if (icon && !icon.querySelector(".ztt-twisty")) {
        const twisty = document.createXULElement("image");
        twisty.className = "ztt-twisty";
        const badge = document.createElement("span");
        badge.className = "ztt-count";
        icon.append(twisty, badge);
      }
      setAttr(tab, ATTR.twisty, collapsed ? "closed" : "open");
      const badge = tab.querySelector(".ztt-count");
      const text = count > 99 ? "99+" : String(count);
      if (badge && badge.textContent !== text) {
        badge.textContent = text;
      }
    } else {
      tab.removeAttribute(ATTR.twisty);
    }

    const depth = ancestors.length;
    const stub = count > 0 && !collapsed; // line from the favicon down to the first child
    if (!depth && !stub) {
      tab.removeAttribute(ATTR.guides);
      tab.querySelector(".ztt-guides")?.remove();
      return;
    }
    // x positions are relative to the edge of a depth-0 node, where the guides start.
    const metrics = this.#metrics;
    const centerOf = n => (gBrowser.isTab(n) ? metrics.tabCenter : metrics.groupCenter);
    // A split group's guides live in its lead tab, which is inset within the group.
    const isTab = gBrowser.isTab(node);
    const inset = isTab ? 0 : metrics.groupInset;
    const insetTop = isTab ? 0 : metrics.groupInsetTop;
    const insetBottom = isTab ? 0 : metrics.groupInsetBottom;
    const ownCenter = depth * INDENT_PX + centerOf(node);
    // Segments are bordered elements rather than background gradients: borders
    // snap to whole device pixels, so every segment has the same crisp
    // thickness at any zoom level (gradients blur across 1 or 2 pixels).
    const segments = []; // [x, kind ("full" | "stub" | "elbow"), lit, width]
    for (let k = 0; k < depth - 1; k++) {
      if (continues[k]) {
        segments.push([k * INDENT_PX + centerOf(ancestors[k]), "full", active.columns[k] === 1]);
      }
    }
    const ownColumn = active.columns[depth - 1];
    if (depth) {
      const x = (depth - 1) * INDENT_PX + centerOf(ancestors.at(-1));
      if (continues[depth - 1]) {
        segments.push([x, "full", ownColumn === 1]);
      }
      // Rounded branch into the favicon: always for the last child, and for a
      // middle child when the highlighted path turns into it.
      if (!continues[depth - 1] || ownColumn === 2) {
        segments.push([x, "elbow", ownColumn === 2, ownCenter - 11 - x]);
      }
    }
    if (stub) {
      segments.push([ownCenter, "stub", active.stub]);
    }
    const css =
      `left:${-(depth * INDENT_PX + inset)}px;width:${ownCenter + 1}px;` +
      `top:${-insetTop}px;bottom:${-insetBottom}px`;

    let guides = tab.querySelector(":scope > .ztt-guides");
    if (!guides) {
      guides = document.createElement("div");
      guides.className = "ztt-guides";
      // Appended last: Zen's split preview inserts relative to the tab's first child.
      tab.append(guides);
    }
    // Compare with what we last wrote: the browser re-serializes cssText differently.
    if (guides.dataset.css !== css) {
      guides.dataset.css = css;
      guides.style.cssText = css;
    }
    const signature = JSON.stringify(segments);
    if (guides.dataset.segments !== signature) {
      guides.dataset.segments = signature;
      guides.replaceChildren(
        ...segments.map(([x, kind, lit, width]) => {
          const el = document.createElement("div");
          el.className = "ztt-line";
          el.setAttribute("kind", kind);
          el.toggleAttribute("lit", lit);
          el.style.left = `${x}px`;
          if (width) {
            el.style.width = `${width}px`;
          }
          return el;
        })
      );
    }
    setAttr(tab, ATTR.guides, "true");
  }

  /**
   * Favicon center relative to a node's start edge, for tabs and for split
   * groups (whose lead tab is inset and padded differently), re-measured on
   * every render so density/theme changes are picked up.
   */
  #measure(nodes) {
    const bounds = el => window.windowUtils.getBoundsWithoutFlushing(el);
    const iconCenter = (node, lead) => {
      const image = lead.querySelector(".tab-icon-image");
      const rect = image && bounds(image);
      return rect?.width ? rect.left + rect.width / 2 - bounds(node).left : null;
    };
    const tab = nodes.find(n => gBrowser.isTab(n) && !n.hasAttribute(ATTR.hidden));
    const group = nodes.find(n => !gBrowser.isTab(n) && !n.hasAttribute(ATTR.hidden));
    const tabCenter = tab && iconCenter(tab, tab);
    if (tabCenter) {
      this.#metrics.tabCenter = Math.round(tabCenter);
    }
    const lead = group && this.#tree.leadOf(group);
    const groupCenter = lead && iconCenter(group, lead);
    if (groupCenter) {
      const leadRect = bounds(lead);
      const groupRect = bounds(group);
      Object.assign(this.#metrics, {
        groupCenter: Math.round(groupCenter),
        groupInset: Math.round(leadRect.left - groupRect.left),
        groupInsetTop: Math.round(leadRect.top - groupRect.top),
        groupInsetBottom: Math.round(groupRect.bottom - leadRect.bottom),
      });
    }
  }
}
