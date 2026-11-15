// Dev only: re-inject tree-tabs.js and tree-tabs.css into every window without restarting.
//   tools/marionette.py evalf tools/reload.js
const v = Date.now();
const wins = [...Services.wm.getEnumerator("navigator:browser")].filter(w => w.gZenTreeTabs);
for (const w of wins) {
  w.gZenTreeTabs.uninit();
  delete w.gZenTreeTabs;
  if (w.__zenTreeTabsSheet) {
    w.windowUtils.removeSheetUsingURIString(w.__zenTreeTabsSheet, w.windowUtils.AUTHOR_SHEET);
  }
  w.__zenTreeTabsSheet = `chrome://zentreetabs/content/tree-tabs.css?${v}`;
  w.windowUtils.loadSheetUsingURIString(w.__zenTreeTabsSheet, w.windowUtils.AUTHOR_SHEET);
  Services.scriptloader.loadSubScript(`chrome://zentreetabs/content/tree-tabs.js?${v}`, w);
}
for (const w of wins) w.gZenTreeTabs.init();
return `reloaded ${wins.length} window(s)`;
