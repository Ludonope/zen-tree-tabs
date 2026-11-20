/* The tab context menu's "Tree" submenu and the keyboard shortcuts. Each
 * creator returns the function that removes what it added. */
"use strict";

function createTreeMenu(ctrl) {
  const tree = ctrl.tree;
  const menu = document.getElementById("tabContextMenu");
  if (!menu) {
    return () => {};
  }
  const make = (tag, attrs = {}) => {
    const el = document.createXULElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
    return el;
  };
  const contextNode = () => {
    const tab = TabContextMenu.contextTab;
    return tab ? tree.nodeOf(tab) : null;
  };

  const separatorAbove = make("menuseparator", { id: "ztt-context-separator-above" });
  const separatorBelow = make("menuseparator", { id: "ztt-context-separator-below" });
  const submenu = make("menu", { id: "ztt-context-menu", label: "Tree" });
  const popup = make("menupopup", { id: "ztt-context-popup" });
  submenu.append(popup);
  const items = {
    toggle: { label: "Collapse Tree", pref: "keyToggle", run: n => ctrl.toggleCollapsed(n) },
    closeTree: { label: "Close Tree", run: n => ctrl.closeTree(n) },
    closeChildren: { label: "Close Children", run: n => ctrl.closeChildren(n) },
    sep1: null,
    nest: { label: "Nest Under Sibling Above", pref: "keyNest", run: n => ctrl.nestUnderSiblingAbove(n) },
    moveOut: { label: "Move Out of Parent", pref: "keyMoveOut", run: n => ctrl.moveOutOfParent(n) },
    detach: { label: "Detach from Tree", run: n => ctrl.detachFromTree(n) },
    sep2: null,
    collapseAll: { label: "Collapse All Trees", pref: "keyCollapseAll", run: () => ctrl.setAllCollapsed(true) },
    expandAll: { label: "Expand All Trees", pref: "keyExpandAll", run: () => ctrl.setAllCollapsed(false) },
  };
  const elements = {};
  for (const [name, item] of Object.entries(items)) {
    if (!item) {
      popup.append(make("menuseparator"));
      continue;
    }
    const el = make("menuitem", { id: `ztt-context-${name}`, label: item.label });
    el.addEventListener("command", () => {
      const node = contextNode();
      if (node) {
        item.run(node);
      }
    });
    popup.append(el);
    elements[name] = el;
  }
  const anchor = document.getElementById("context_closeTab");
  if (anchor) {
    anchor.before(separatorAbove, submenu, separatorBelow);
  } else {
    menu.append(separatorAbove, submenu, separatorBelow);
  }

  // Native separators next to the anchor come and go (Zen's sync separator is
  // hidden without sync), so only show ours where no visible one already sits.
  const isVisible = el => !el.hidden && getComputedStyle(el).display !== "none";
  const needsSeparator = (from, step) => {
    for (let el = from[step]; el; el = el[step]) {
      if (isVisible(el)) {
        return el.localName !== "menuseparator";
      }
    }
    return false;
  };

  const onShowing = event => {
    if (event.target !== menu) {
      return;
    }
    const node = contextNode();
    const isNode = !!node && tree.isNode(node);
    separatorAbove.hidden = separatorBelow.hidden = submenu.hidden = !isNode;
    if (!isNode) {
      return;
    }
    separatorAbove.hidden = !needsSeparator(separatorAbove, "previousElementSibling");
    separatorBelow.hidden = !needsSeparator(separatorBelow, "nextElementSibling");
    // Show the user's current shortcuts next to the items.
    const shortcutsOn = ctrl.settings.get("shortcutsEnabled");
    for (const [name, item] of Object.entries(items)) {
      if (!item?.pref) {
        continue;
      }
      const combo = shortcutsOn ? formatShortcut(ctrl.settings.get(item.pref)) : "";
      if (combo) {
        elements[name].setAttribute("acceltext", combo);
      } else {
        elements[name].removeAttribute("acceltext");
      }
    }
    const hasChildren = node.hasAttribute(ATTR.hasChildren);
    const hasParent = !!tree.parentOf(node);
    elements.toggle.setAttribute("label", tree.isCollapsed(node) ? "Expand Tree" : "Collapse Tree");
    elements.toggle.disabled = !hasChildren;
    elements.closeTree.disabled = !hasChildren;
    elements.closeChildren.disabled = !hasChildren;
    elements.nest.disabled = !tree.previousSibling(node);
    elements.moveOut.disabled = !hasParent;
    elements.detach.disabled = !hasParent;
  };
  menu.addEventListener("popupshowing", onShowing);
  return () => {
    menu.removeEventListener("popupshowing", onShowing);
    separatorAbove.remove();
    separatorBelow.remove();
    submenu.remove();
  };
}

/** Builds the XUL keys from the current settings; call the returned function to remove them. */
function createShortcuts(ctrl) {
  const tree = ctrl.tree;
  if (!ctrl.settings.get("shortcutsEnabled")) {
    return () => {};
  }
  const toggleBranch = node => {
    // Toggle the current branch: the tab itself if it has children, else its parent.
    const target = node.hasAttribute(ATTR.hasChildren) ? node : tree.parentOf(node);
    if (target) {
      ctrl.toggleCollapsed(target);
    }
  };
  // [setting, needsSelectedNode, action]
  const shortcuts = [
    ["keyNest", true, node => ctrl.nestUnderSiblingAbove(node)],
    ["keyMoveOut", true, node => ctrl.moveOutOfParent(node)],
    ["keyToggle", true, toggleBranch],
    ["keyCollapseAll", false, () => ctrl.setAllCollapsed(true)],
    ["keyExpandAll", false, () => ctrl.setAllCollapsed(false)],
  ];
  const keyset = document.createXULElement("keyset");
  keyset.id = "ztt-keyset";
  const commandset = document.createXULElement("commandset");
  commandset.id = "ztt-commandset";
  const used = new Set();
  for (const [pref, needsNode, run] of shortcuts) {
    const spec = parseShortcut(ctrl.settings.get(pref));
    if (!spec) {
      continue;
    }
    const signature = JSON.stringify(spec);
    if (used.has(signature)) {
      continue; // the same combination bound twice: first one wins
    }
    used.add(signature);
    // Keys are only active when bound to a <command>.
    const command = document.createXULElement("command");
    command.id = `ztt-cmd-${pref}`;
    command.addEventListener("command", () => {
      if (!needsNode) {
        run();
        return;
      }
      const node = tree.nodeOf(gBrowser.selectedTab);
      if (tree.isNode(node)) {
        run(node);
      }
    });
    commandset.append(command);
    const key = document.createXULElement("key");
    key.id = `ztt-key-${pref}`;
    if (spec.keycode) {
      key.setAttribute("keycode", spec.keycode);
    } else {
      key.setAttribute("key", spec.key);
    }
    if (spec.modifiers) {
      key.setAttribute("modifiers", spec.modifiers);
    }
    key.setAttribute("command", command.id);
    keyset.append(key);
  }
  document.documentElement.append(commandset, keyset);
  return () => {
    keyset.remove();
    commandset.remove();
  };
}
