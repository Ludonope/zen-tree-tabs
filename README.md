# Zen Tree Tabs

Tree Style Tab–like tab trees inside Zen's native vertical tab strip. It works with
spaces, essentials, pinned tabs, folders, split view and window sync instead of
replacing the sidebar.

## How it works

- Tabs opened from a page (links, middle-click, `target=_blank`, `window.open`)
  become children of the tab that opened them. Tabs you open yourself (Ctrl+T, the
  URL bar, bookmarks) stay top-level.
- Guide lines show the hierarchy, and the path from the root to the selected tab is
  highlighted. Hover a parent's favicon to get the twisty, then
  click to collapse or expand. A collapsed parent shows how many tabs it hides.
  Selecting a hidden tab (for example with Ctrl+Tab) expands its ancestors.
- Drag a tab onto the middle of another tab to make it a child; drop near a tab's
  top or bottom edge to place it before or after. Zen's drag-to-split still works:
  keep hovering until the split preview appears.
- Closing a parent promotes its first child, and the other children move under it.
- Moving a tab moves its whole subtree with it. The tab's parent is re-derived
  from where it lands.
- A split view acts as a single tree node and keeps its place in the tree.
- Pinning a tab, or moving it into a folder, takes it out of the tree.
- The tree is saved with the session and stays in sync across Zen's synced windows.

| Shortcut        | Action                                                    |
| --------------- | --------------------------------------------------------- |
| `Alt+Shift+→`   | Indent: become the last child of the previous sibling     |
| `Alt+Shift+←`   | Outdent: become the next sibling of the parent            |
| `Alt+Shift+↓`   | Collapse or expand the current branch                     |

The tab context menu has a **Tree** submenu with these items: collapse or expand,
close tree, close children, indent, outdent, detach from tree, and collapse or
expand all trees.

## Install

There are two ways to install Zen Tree Tabs. Both run the same code and use the same
saved trees, so you can switch between them without losing anything.

- **[As a Sine mod](#as-a-sine-mod).** Best if you already use the
  [Sine](https://github.com/CosmoCreeper/Sine) mod manager. You get updates from
  inside Zen, and there's nothing to change in `about:config`.
- **[As an add-on (`.xpi`)](#as-an-add-on-xpi).** Needs no extra tools, only two
  prefs.

If both are installed, only one copy runs and the other stays idle.

### As a Sine mod

You need Sine installed already. See
[Sine's installation guide](https://github.com/sineorg/docs/blob/main/src/installation.md).

1. Open Zen's settings and go to Sine's page.
2. Zen Tree Tabs isn't in Sine's store yet, so Sine treats it as an unofficial mod
   and won't run its JavaScript by default. Turn on **Enable installing JS from
   unofficial sources**, which is the `sine.allow-unsafe-js` pref. This lets any
   mod you install from a GitHub link run code with full browser access, so only
   install mods you trust.
3. In the install field, enter `Ludonope/zen-tree-tabs` and install.
4. Restart Zen if Sine asks you to.

Sine checks the repository for updates. To remove the mod, use Sine's mod list. You
can disable it from there too, without restarting.

### As an add-on (`.xpi`)

The add-on comes as a single `.xpi` file. Get the latest one from the
[Releases page](https://github.com/Ludonope/zen-tree-tabs/releases), or build it
yourself (see [Distributing](#distributing)).

#### Why it needs two prefs

To change Zen's own tab strip, the add-on has to run with full browser privileges
through a WebExtension *experiment API*. Mozilla's add-on site (AMO) only signs
experiment add-ons made by Mozilla itself, so this add-on is unsigned. Zen's
release builds still accept unsigned and experiment add-ons, but only once you turn
two prefs on.

> [!WARNING]
> `xpinstall.signatures.required = false` turns off the signature check for **every**
> add-on in that profile, not just this one. Only install `.xpi` files from sources
> you trust. Also note that this add-on, like any experiment add-on, has full access
> to the browser.

#### Steps

Do this once for each Zen profile:

1. Open `about:config` and accept the warning.
2. Set these two prefs. Double-click a pref to toggle it.
   - `xpinstall.signatures.required` → `false`
   - `extensions.experiments.enabled` → `true`
3. Open `about:addons`, click the gear icon, and choose **Install Add-on From File…**.
   Pick `zen-tree-tabs-<version>.xpi` and confirm. You can also drag the `.xpi` onto
   a Zen window.

The add-on starts right away, without a restart. Your existing tabs stay flat; new
trees form as you open links. It should now appear as **Zen Tree Tabs** in
`about:addons`.

**Troubleshooting**

- **Zen says the add-on could not be verified.** `xpinstall.signatures.required` is
  still `true` in **this** profile. Prefs are per profile, so check `about:profiles` to
  see which one you're in.
- **The add-on is listed and enabled, but links don't nest.** It was installed before
  `extensions.experiments.enabled` was set to `true`. Set the pref, then disable and
  re-enable the add-on in `about:addons`, or restart Zen.

#### Setting it up with a script (many profiles or machines)

Instead of using `about:config`, put the two prefs in a `user.js` file in the
profile folder. Zen applies it at every startup:

```js
// <profile folder>/user.js
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.experiments.enabled", true);
```

You can find the profile folder in `about:profiles`. On Linux it's usually
`~/.zen/<id>.<name>/`. Restart Zen, then install the `.xpi` as in step 3.

#### Updating

Install the newer `.xpi` the same way. It has the same add-on ID, so it replaces the
old version in place. Your trees are stored in Zen's session data, not in the
add-on, so they carry over.

The add-on doesn't update itself, so check the Releases page for new versions.

#### Uninstalling

Remove the add-on in `about:addons`. The indentation and decorations disappear
immediately, and no tabs are hidden or lost. If you don't use other unsigned
add-ons, you can then set the two prefs back to their defaults (right-click the
pref in `about:config` and choose **Reset**).

#### Compatibility

- This version was developed and tested with Zen 1.21.6b (Gecko 152) on Linux.
- It hooks into Zen internals (tab containers, split view, drag and drop), so a
  major Zen update can break parts of it. If tabs act strangely after a Zen update,
  disable the add-on: your tabs stay intact.
- Any Zen build that allows unsigned add-ons when `xpinstall.signatures.required` is
  `false` can run it. This is true of official Zen release builds on Linux.

## Distributing

To publish a new version:

1. Bump `version` in [src/manifest.json](src/manifest.json) and in
   [theme.json](theme.json). Zen only treats a higher version number as an upgrade.
2. Run `tools/build.sh` to build `dist/zen-tree-tabs-<version>.xpi`. The file is a
   plain zip of `src/` and is gitignored.
3. Tag the commit and attach the `.xpi` to a GitHub release, for example:

   ```sh
   git tag v0.3.1 && git push origin v0.3.1
   gh release create v0.3.1 dist/zen-tree-tabs-0.3.1.xpi --title "v0.3.1" --notes "…"
   ```

Don't change the add-on ID (`zen-tree-tabs@ludonope` in the manifest). Zen uses it to
recognize updates, so a different ID would install a second copy alongside the
first.

### Sine

Sine installs the mod straight from this repository, using
[theme.json](theme.json) at the repository root. So pushing to `main` is what
publishes a new version to Sine users.

- Keep `version` in `theme.json` the same as in `src/manifest.json`. `tools/build.sh`
  refuses to build if they differ.
- Sine downloads the whole repository, and `theme.json` points straight at
  `src/chrome/tree-tabs.uc.js`. That script loads `tree-tabs.css` from its own folder,
  so the mod and the add-on share the same files.
- Don't change the mod `id` (`zen-tree-tabs`). Sine stores the mod in a folder
  named after it.
- To get the mod listed in Sine's store, open a submission issue on
  [sineorg/store](https://github.com/sineorg/store). Once it's listed, users no
  longer need the "unofficial sources" option.

## Development

```sh
tools/dev.sh [--fresh]   # throwaway Zen profile, add-on loaded from src/, Marionette on :2829
tools/marionette.py eval 'return gZenTreeTabs.descendantsOf(gBrowser.selectedTab).length'
tools/marionette.py evalf tools/reload.js   # hot-reload tree-tabs.uc.js and its CSS into every window
tools/marionette.py shot out.png
tools/zoom.sh out.png        # zoomed screenshot of the sidebar
```

`tools/fixture.js` builds a sample tree and `tools/drag.js` simulates a drag through
Zen's handlers. Both expect test pages served on `127.0.0.1:8765`.

Layout:

- `src/chrome/tree-tabs.uc.js` holds the tree model, event handling and persistence
  (`window.gZenTreeTabs`). It starts itself, so the same file serves both loaders.
- `src/experiment/parent.js` is the add-on loader. It registers `chrome://zentreetabs/`
  and loads the script into each browser window.
- `theme.json` is the Sine loader. It points Sine at the same script.
- `src/chrome/tree-tabs.css` handles indentation, collapsing and the twisty.
