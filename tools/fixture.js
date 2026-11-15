// Dev fixture: replaces the space's tabs with a sample tree served from
// http://127.0.0.1:8765/<name>.html (see tools/README or serve any folder).
const wait = ms => new Promise(r => setTimeout(r, ms));
await gZenStartup.promiseInitialized;
const url = n => `http://127.0.0.1:8765/${n}.html`;
const old = gBrowser.tabs.filter(t => !t.hasAttribute("zen-empty-tab") && !t.pinned);
const open = (n, opener) => gBrowser.addTrustedTab(url(n), opener ? { openerBrowser: opener.linkedBrowser } : {});
const root2 = open("root2"); await wait(150);
const root = open("root"); await wait(150);
const a = open("a", root); await wait(150);
const a1 = open("a1", a); await wait(150);
const a2 = open("a2", a); await wait(150);
const a2x = open("a2x", a2); await wait(150);
const b = open("b", root); await wait(150);
const c = open("c", root); await wait(150);
const c1 = open("c1", c); await wait(150);
gBrowser.selectedTab = root;
for (const t of old) gBrowser.removeTab(t, { animate: false });
await wait(1500);
return gBrowser.tabs.filter(t => !t.hasAttribute("zen-empty-tab")).map(t => `${"  ".repeat(+t.getAttribute("ztt-depth") || 0)}${t.label}`);
