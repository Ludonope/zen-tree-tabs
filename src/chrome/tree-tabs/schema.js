/* The settings schema: the single source of truth for every option, its type,
 * default and limits. Loaded by the browser-window script (settings.js) AND by
 * the options page (options/options.html), so they can never disagree.
 *
 * Types: "bool", "int" (min/max/step/unit), "choice" (choices: [[value, label]]),
 * "shortcut" (a string like "Alt+Shift+Right", "" = disabled).
 * `visibleIf: { key, value }` / `{ key, not }` hides an option in the UI. */
"use strict";

const ZTT_PREF_BRANCH = "extensions.zentreetabs.";

const ZTT_SETTINGS = [
  {
    group: "New tabs",
    items: [
      {
        key: "newTabMode",
        type: "choice",
        default: "current",
        label: "New tabs become children of",
        description: "Which newly opened tabs are nested automatically.",
        choices: [
          ["links", "The tab they were opened from (links, window.open)"],
          ["current", "The currently selected tab, including New Tab button and Ctrl+T"],
          ["none", "Nothing: never nest automatically"],
        ],
      },
    ],
  },
  {
    group: "Closing tabs",
    items: [
      {
        key: "closeParentMode",
        type: "choice",
        default: "collapsed",
        label: "When closing a tab that has children",
        description: "What happens to the tabs nested under a tab you close.",
        choices: [
          ["promote", "Move the children up one level"],
          ["collapsed", "Close the whole branch if the tab is collapsed, otherwise move children up"],
          ["always", "Always close the whole branch"],
        ],
      },
      {
        key: "closeWarning",
        type: "bool",
        default: true,
        label: "Ask before closing a whole branch",
        description: "Shows a confirmation naming how many nested tabs will also close.",
        visibleIf: { key: "closeParentMode", not: "promote" },
      },
      {
        key: "closeWarningMin",
        type: "int",
        default: 1,
        min: 1,
        max: 50,
        step: 1,
        unit: "",
        label: "Only ask when at least this many nested tabs would close",
        visibleIf: { key: "closeParentMode", not: "promote" },
      },
    ],
  },
  {
    group: "Collapsing",
    items: [
      {
        key: "autoCollapse",
        type: "choice",
        default: "off",
        label: "Auto-collapse other trees",
        description: "Runs whenever you switch to another tab.",
        choices: [
          ["off", "Off"],
          ["roots", "Collapse top-level trees that don't contain the active tab"],
          ["branches", "Collapse every branch that isn't on the active tab's path (accordion)"],
        ],
      },
    ],
  },
  {
    group: "Keyboard shortcuts",
    items: [
      { key: "shortcutsEnabled", type: "bool", default: true, label: "Enable tree shortcuts" },
      {
        key: "keyNest",
        type: "shortcut",
        default: "Alt+Shift+Right",
        label: "Nest under sibling above",
        visibleIf: { key: "shortcutsEnabled", value: true },
      },
      {
        key: "keyMoveOut",
        type: "shortcut",
        default: "Alt+Shift+Left",
        label: "Move out of parent",
        visibleIf: { key: "shortcutsEnabled", value: true },
      },
      {
        key: "keyToggle",
        type: "shortcut",
        default: "Alt+Shift+Down",
        label: "Collapse / expand branch",
        visibleIf: { key: "shortcutsEnabled", value: true },
      },
      {
        key: "keyCollapseAll",
        type: "shortcut",
        default: "Alt+Down",
        label: "Collapse all trees",
        visibleIf: { key: "shortcutsEnabled", value: true },
      },
      {
        key: "keyExpandAll",
        type: "shortcut",
        default: "Alt+Up",
        label: "Expand all trees",
        visibleIf: { key: "shortcutsEnabled", value: true },
      },
    ],
  },
  {
    group: "Appearance: lines & indentation",
    items: [
      { key: "indentSize", type: "int", default: 20, min: 8, max: 40, step: 1, unit: " px", label: "Indent per level" },
      {
        key: "guideStyle",
        type: "choice",
        default: "solid",
        label: "Line style",
        choices: [
          ["solid", "Solid"],
          ["dashed", "Dashed"],
          ["dotted", "Dotted"],
        ],
      },
      { key: "guideWidth", type: "int", default: 1, min: 1, max: 3, step: 1, unit: " px", label: "Line thickness" },
      { key: "guideOpacity", type: "int", default: 20, min: 5, max: 80, step: 1, unit: "%", label: "Line opacity" },
      {
        key: "guideActiveOpacity",
        type: "int",
        default: 85,
        min: 20,
        max: 100,
        step: 1,
        unit: "%",
        label: "Opacity of the active tab's path",
      },
      {
        key: "guideGap",
        type: "int",
        default: 6,
        min: 0,
        max: 10,
        step: 1,
        unit: " px",
        label: "Gap between lines and favicon",
        description: "How far the branch lines stay away from the icon they point at.",
      },
      {
        key: "guideTopGap",
        type: "int",
        default: 6,
        min: 0,
        max: 14,
        step: 1,
        unit: " px",
        label: "Gap below the parent favicon",
        description: "Where the vertical line starts under a parent tab's icon (the top favicon of a branch).",
      },
    ],
  },
  {
    group: "Appearance: shading",
    items: [
      {
        key: "depthTint",
        type: "bool",
        default: false,
        label: "Tint nested rows by depth",
        description: "Deeper rows get a slightly stronger neutral shade.",
      },
      {
        key: "depthTintStrength",
        type: "int",
        default: 3,
        min: 1,
        max: 10,
        step: 1,
        unit: "% per level",
        label: "Depth tint strength",
        visibleIf: { key: "depthTint", value: true },
      },
      {
        key: "treeColors",
        type: "choice",
        default: "both",
        label: "Colour each tree differently",
        description: "Every tree gets its own hue, kept stable per tree.",
        choices: [
          ["off", "Off"],
          ["rows", "Shade the rows"],
          ["guides", "Colour the lines"],
          ["both", "Rows and lines"],
        ],
      },
      {
        key: "treeColorStrength",
        type: "int",
        default: 15,
        min: 2,
        max: 25,
        step: 1,
        unit: "%",
        label: "Row shading strength",
        visibleIf: { key: "treeColors", not: "off" },
      },
    ],
  },
];
