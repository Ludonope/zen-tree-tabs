/* Constants and small DOM helpers shared by every part (loaded first). */
"use strict";

const ATTR = {
  // The tree itself, persisted:
  parent: "ztt-parent",
  collapsed: "ztt-collapsed",
  // Computed by the renderer, on nodes:
  depth: "ztt-depth",
  hasChildren: "ztt-has-children",
  hidden: "ztt-hidden",
  hue: "ztt-hue", // node belongs to a tree; its colour is in --ztt-hue
  // Computed by the renderer, on the tab showing a node's decorations:
  twisty: "ztt-twisty", // "open" | "closed"
  guides: "ztt-guides",
  // Drag and drop feedback:
  dropTarget: "ztt-drop-target",
};
const NODE_COMPUTED_ATTRS = [ATTR.depth, ATTR.hasChildren, ATTR.hidden, ATTR.hue];
const STORE_KEY = "zenTreeTabs";
const SECTION_CLASS = "zen-workspace-normal-tabs-section";
const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
const INDENT_PX = 18; // default; the "indentSize" setting overrides it
const CHILD_DROP_ZONE = [0.25, 0.75]; // middle band of a row = drop as child
const MAX_DEPTH_WALK = 1000;

// The renderer runs on every tab switch: only touch the DOM when a value really
// changes, so it doesn't trigger restyles or wake other attribute observers.
const setAttr = (el, name, value) => {
  if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
};

const setStyleVar = (el, name, value) => {
  value = value === "" || value == null ? "" : String(value);
  if (el.style.getPropertyValue(name) !== value) {
    if (value) {
      el.style.setProperty(name, value);
    } else {
      el.style.removeProperty(name);
    }
  }
};

const setDepthVar = (el, depth) => setStyleVar(el, "--ztt-depth", depth || "");
const setHueVar = (el, hue) => setStyleVar(el, "--ztt-hue", hue ?? "");

const isSidebarExpanded = () => document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
