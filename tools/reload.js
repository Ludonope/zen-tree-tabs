// Re-inject the window script into all windows without restarting (dev only).
const v = Date.now();
const wins = [...Services.wm.getEnumerator("navigator:browser")];
for (const w of wins) { w.gZenTreeTabs?.uninit(); delete w.gZenTreeTabs; Services.scriptloader.loadSubScript("chrome://zentreetabs/content/tree-tabs.js?" + v, w); }
for (const w of wins) w.gZenTreeTabs.init();
return "reloaded " + wins.length;
