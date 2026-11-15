// Builds the README demo session (see tools/demo-gif.py): real sites, opened as if by clicking links.
//   tools/marionette.py evalf tools/demo.js
const wait = ms => new Promise(r => setTimeout(r, ms));
await gZenStartup.promiseInitialized;
Services.prefs.setIntPref("media.autoplay.default", 5); // never play videos
gNavToolbox.style.width = "330px";

const wiki = a => `https://en.wikipedia.org/wiki/${a}`;
const yt = id => `https://www.youtube.com/watch?v=${id}`;
const old = gBrowser.tabs.filter(t => !t.hasAttribute("zen-empty-tab") && !t.pinned);
const tabs = {};
const open = (name, url, opener) => {
  tabs[name] = gBrowser.addTrustedTab(url, opener ? { openerBrowser: tabs[opener].linkedBrowser } : {});
  return wait(250);
};

// New top-level tabs go to the top of the list, so open the last tree first.
await open("zen", "https://github.com/zen-browser/desktop");
await open("issues", "https://github.com/zen-browser/desktop/issues", "zen");
await open("mdn", "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs", "zen");
await open("sine", "https://github.com/CosmoCreeper/Sine", "zen");

await open("yt", yt("xb3IxAr4RCo"));
await open("birth", yt("I8uStVXNf0M"), "yt");
await open("cutaway", yt("5igXx83J_Iw"), "yt");
await open("boilers", yt("OUywoRs4meY"), "cutaway");
await open("what", yt("ra7ZssauVAw"), "yt");

await open("coffee", wiki("Coffee"));
await open("history", wiki("History_of_coffee"), "coffee");
await open("ethiopia", wiki("Ethiopia"), "history");
await open("kaffa", wiki("Kaffa_Province"), "ethiopia");
await open("coffeehouse", wiki("Coffeehouse"), "history");
await open("espresso", wiki("Espresso"), "coffee");
await open("machine", wiki("Espresso_machine"), "espresso");
await open("moriondo", wiki("Angelo_Moriondo"), "machine");
await open("latte", wiki("Caffè_latte"), "espresso");

for (const t of old) {
  gBrowser.removeTab(t, { animate: false });
}
await wait(6000); // let titles and favicons load

gZenViewSplitter.splitTabs([tabs.mdn, tabs.sine]);
await wait(1500);
gBrowser.selectedTab = tabs.moriondo;
await wait(800);
gZenTreeTabs.setCollapsed(gZenTreeTabs.nodeOf(tabs.yt), true);
await wait(500);
return gBrowser.tabs
  .filter(t => !t.hasAttribute("zen-empty-tab"))
  .map(t => `${"  ".repeat(+(t.getAttribute("ztt-depth") ?? t.group?.getAttribute("ztt-depth") ?? 0))}${t.label}`);
