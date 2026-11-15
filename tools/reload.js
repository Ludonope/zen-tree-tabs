// Dev only: reload tree-tabs.uc.js (and its stylesheet) in every window without restarting.
//   tools/marionette.py evalf tools/reload.js
const wins = [...Services.wm.getEnumerator("navigator:browser")];
for (const w of wins) {
  const url = new URL(w.gZenTreeTabs?.scriptURL ?? "chrome://zentreetabs/content/tree-tabs.uc.js");
  w.gZenTreeTabs?.stop();
  url.search = `?dev-${Date.now()}`;
  Services.scriptloader.loadSubScript(url.href, w);
}
await new Promise(r => setTimeout(r, 300));
return `reloaded ${wins.filter(w => w.gZenTreeTabs).length} window(s)`;
