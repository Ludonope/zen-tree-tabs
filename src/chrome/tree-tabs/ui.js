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

  const separator = make("menuseparator", { id: "ztt-context-separator" });
  const submenu = make("menu", { id: "ztt-context-menu", label: "Tree" });
  const popup = make("menupopup", { id: "ztt-context-popup" });
  submenu.append(popup);
  const items = {
    toggle: { label: "Collapse Tree", run: n => ctrl.toggleCollapsed(n) },
    closeTree: { label: "Close Tree", run: n => ctrl.closeTree(n) },
    closeChildren: { label: "Close Children", run: n => ctrl.closeChildren(n) },
    sep1: null,
    indent: { label: "Indent", key: "Alt+Shift+→", run: n => ctrl.indent(n) },
    outdent: { label: "Outdent", key: "Alt+Shift+←", run: n => ctrl.outdent(n) },
    detach: { label: "Detach from Tree", run: n => ctrl.detachFromTree(n) },
    sep2: null,
    collapseAll: { label: "Collapse All Trees", run: () => ctrl.setAllCollapsed(true) },
    expandAll: { label: "Expand All Trees", run: () => ctrl.setAllCollapsed(false) },
  };
  const elements = {};
  for (const [name, item] of Object.entries(items)) {
    if (!item) {
      popup.append(make("menuseparator"));
      continue;
    }
    const el = make("menuitem", { id: `ztt-context-${name}`, label: item.label });
    if (item.key) {
      el.setAttribute("acceltext", item.key);
    }
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
    anchor.before(separator, submenu);
  } else {
    menu.append(separator, submenu);
  }

  const onShowing = event => {
    if (event.target !== menu) {
      return;
    }
    const node = contextNode();
    const isNode = !!node && tree.isNode(node);
    separator.hidden = submenu.hidden = !isNode;
    if (!isNode) {
      return;
    }
    const hasChildren = node.hasAttribute(ATTR.hasChildren);
    const hasParent = !!tree.parentOf(node);
    elements.toggle.setAttribute("label", tree.isCollapsed(node) ? "Expand Tree" : "Collapse Tree");
    elements.toggle.disabled = !hasChildren;
    elements.closeTree.disabled = !hasChildren;
    elements.closeChildren.disabled = !hasChildren;
    elements.indent.disabled = !tree.previousSibling(node);
    elements.outdent.disabled = !hasParent;
    elements.detach.disabled = !hasParent;
  };
  menu.addEventListener("popupshowing", onShowing);
  return () => {
    menu.removeEventListener("popupshowing", onShowing);
    separator.remove();
    submenu.remove();
  };
}

function createShortcuts(ctrl) {
  const tree = ctrl.tree;
  const keyset = document.createXULElement("keyset");
  keyset.id = "ztt-keyset";
  const commandset = document.createXULElement("commandset");
  commandset.id = "ztt-commandset";
  const shortcuts = [
    ["VK_RIGHT", node => ctrl.indent(node)],
    ["VK_LEFT", node => ctrl.outdent(node)],
    [
      "VK_DOWN",
      node => {
        // Toggle the current branch: the tab itself if it has children, else its parent.
        const target = node.hasAttribute(ATTR.hasChildren) ? node : tree.parentOf(node);
        if (target) {
          ctrl.toggleCollapsed(target);
        }
      },
    ],
  ];
  for (const [keycode, run] of shortcuts) {
    // Keys are only active when bound to a <command>.
    const command = document.createXULElement("command");
    command.id = `ztt-cmd-${keycode}`;
    command.addEventListener("command", () => {
      const node = tree.nodeOf(gBrowser.selectedTab);
      if (tree.isNode(node)) {
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
  return () => {
    keyset.remove();
    commandset.remove();
  };
}
