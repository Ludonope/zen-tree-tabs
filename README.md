# Zen Tree Tabs

Tree Style Tab–like tab trees inside Zen's native vertical tab strip. It works with
spaces, essentials, pinned tabs, folders, split view and window sync instead of
replacing the sidebar.

## How it works

- Tabs opened from a page (links, middle-click, `target=_blank`, `window.open`)
  become children of the tab that opened them. Tabs you open yourself (Ctrl+T, the
  URL bar, bookmarks) stay top-level.
- Click the twisty to collapse or expand a subtree. Selecting a hidden tab (for
  example with Ctrl+Tab) expands its ancestors.
- Closing a parent promotes its first child, and the other children move under it.
- Moving a tab moves its whole subtree with it. The tab's parent is re-derived
  from where it lands.
- Pinning a tab, or moving it into a folder or split view, takes it out of the tree.
- The tree is saved with the session and stays in sync across Zen's synced windows.

## Install

The add-on uses a privileged *experiment API* to reach Zen's tab strip, so it is
unsigned. Zen allows unsigned privileged add-ons once you set two prefs:

1. In `about:config`, set:
   - `xpinstall.signatures.required` → `false`
   - `extensions.experiments.enabled` → `true`
2. Run `tools/build.sh` to build `dist/zen-tree-tabs-<version>.xpi`.
3. In `about:addons`, open the gear menu, choose **Install Add-on From File…**, and pick
   the `.xpi`.

The add-on keeps working across Zen updates. You can disable or remove it at any time.

## Development

```sh
tools/dev.sh [--fresh]   # throwaway Zen profile, add-on loaded from src/, Marionette on :2829
tools/marionette.py eval 'return gZenTreeTabs.descendantsOf(gBrowser.selectedTab).length'
tools/marionette.py evalf tools/reload.js   # hot-reload src/chrome/tree-tabs.js into every window
tools/marionette.py shot out.png
```

Layout:

- `src/experiment/parent.js` registers `chrome://zentreetabs/` and injects into each browser window.
- `src/chrome/tree-tabs.js` holds the tree model, event handling and persistence (`window.gZenTreeTabs`).
- `src/chrome/tree-tabs.css` handles indentation, collapsing and the twisty.
