/* This experiment runs in the parent process with chrome privileges.
 * It registers the chrome/ folder as chrome://zentreetabs/content/ and loads
 * the tree script into every Zen browser window. The script starts itself
 * (see the bootstrap at the end of chrome/tree-tabs.uc.js). */
"use strict";

/* global ExtensionAPI, Services, Cc, Ci */

const SCRIPT_URL = "chrome://zentreetabs/content/tree-tabs.uc.js";
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
    this.scriptURL = `${SCRIPT_URL}?${this.extension.version}-${Date.now()}`;

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
    if (
      topic === DELAYED_STARTUP_TOPIC &&
      subject.document?.documentElement.getAttribute("windowtype") === WINDOW_TYPE
    ) {
      this.attach(subject);
    }
  }

  attach(win) {
    if (win.gZenTreeTabs) {
      return; // already running here (possibly the Sine mod)
    }
    try {
      Services.scriptloader.loadSubScript(this.scriptURL, win);
    } catch (e) {
      console.error("zen-tree-tabs: failed to attach to window", e);
    }
  }

  detach(win) {
    // Only stop our own copy, not one loaded by Sine.
    if (win.gZenTreeTabs?.scriptURL === this.scriptURL) {
      win.gZenTreeTabs.stop();
    }
  }

  getAPI() {
    const BRANCH = "extensions.zentreetabs.";
    const prefs = Services.prefs;
    return {
      zenTreeTabs: {
        async getPrefs() {
          const out = {};
          for (const name of prefs.getChildList(BRANCH)) {
            const key = name.slice(BRANCH.length);
            switch (prefs.getPrefType(name)) {
              case prefs.PREF_BOOL:
                out[key] = prefs.getBoolPref(name);
                break;
              case prefs.PREF_INT:
                out[key] = prefs.getIntPref(name);
                break;
              case prefs.PREF_STRING:
                out[key] = prefs.getStringPref(name);
                break;
            }
          }
          return out;
        },
        async setPref(key, value) {
          if (!/^[A-Za-z0-9]+$/.test(key)) {
            throw new Error("invalid preference name");
          }
          const name = BRANCH + key;
          prefs.clearUserPref(name); // a different type may be stored
          if (typeof value === "boolean") {
            prefs.setBoolPref(name, value);
          } else if (typeof value === "number") {
            prefs.setIntPref(name, Math.round(value));
          } else {
            prefs.setStringPref(name, String(value));
          }
        },
        async resetPrefs() {
          for (const name of prefs.getChildList(BRANCH)) {
            prefs.clearUserPref(name);
          }
        },
      },
    };
  }
};
