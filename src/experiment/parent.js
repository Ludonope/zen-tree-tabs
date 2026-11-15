/* This experiment runs in the parent process with chrome privileges.
 * It registers the chrome/ folder as chrome://zentreetabs/content/ and
 * injects the tree implementation into every Zen browser window. */
"use strict";

/* global ExtensionAPI, Services, Cc, Ci */

const SCRIPT_URL = "chrome://zentreetabs/content/tree-tabs.js";
const STYLE_URL = "chrome://zentreetabs/content/tree-tabs.css";
const WINDOW_TYPE = "navigator:browser";
const DELAYED_STARTUP_TOPIC = "browser-delayed-startup-finished";

this.zenTreeTabs = class extends ExtensionAPI {
  onStartup() {
    const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(
      Ci.amIAddonManagerStartup
    );
    const manifestURI = Services.io.newURI("manifest.json", null, this.extension.rootURI);
    this.chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "zentreetabs", "chrome/"],
    ]);
    // Cache-buster: chrome:// script/style caches would otherwise survive add-on updates.
    this.cacheKey = `${this.extension.version}-${Date.now()}`;

    for (const win of Services.wm.getEnumerator(WINDOW_TYPE)) {
      if (win.gBrowserInit?.delayedStartupFinished) {
        this.attach(win);
      }
    }
    Services.obs.addObserver(this, DELAYED_STARTUP_TOPIC);
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }
    Services.obs.removeObserver(this, DELAYED_STARTUP_TOPIC);
    for (const win of Services.wm.getEnumerator(WINDOW_TYPE)) {
      this.detach(win);
    }
    this.chromeHandle?.destruct();
    this.chromeHandle = null;
    Services.obs.notifyObservers(null, "startupcache-invalidate");
  }

  observe(subject, topic) {
    if (topic === DELAYED_STARTUP_TOPIC && subject.document?.documentElement
      .getAttribute("windowtype") === WINDOW_TYPE) {
      this.attach(subject);
    }
  }

  async attach(win) {
    if (win.gZenTreeTabs || win.__zenTreeTabsAttaching) {
      return;
    }
    win.__zenTreeTabsAttaching = true;
    try {
      // Zen builds its workspace tab containers asynchronously.
      await win.gZenStartup?.promiseInitialized;
      if (win.closed || !this.chromeHandle) {
        return;
      }
      win.__zenTreeTabsSheet = `${STYLE_URL}?${this.cacheKey}`;
      win.windowUtils.loadSheetUsingURIString(win.__zenTreeTabsSheet, win.windowUtils.AUTHOR_SHEET);
      Services.scriptloader.loadSubScript(`${SCRIPT_URL}?${this.cacheKey}`, win);
      win.gZenTreeTabs.init();
    } catch (e) {
      console.error("zen-tree-tabs: failed to attach to window", e);
    } finally {
      delete win.__zenTreeTabsAttaching;
    }
  }

  detach(win) {
    try {
      win.gZenTreeTabs?.uninit();
    } catch (e) {
      console.error("zen-tree-tabs: failed to detach from window", e);
    }
    delete win.gZenTreeTabs;
    try {
      if (win.__zenTreeTabsSheet) {
        win.windowUtils.removeSheetUsingURIString(win.__zenTreeTabsSheet, win.windowUtils.AUTHOR_SHEET);
      }
    } catch {}
    delete win.__zenTreeTabsSheet;
  }

  getAPI() {
    return { zenTreeTabs: {} };
  }
};
