"use strict";

/* Renders the form from ZTT_SETTINGS (chrome/tree-tabs/schema.js) and saves
 * every change immediately through the experiment API; open windows apply it live. */

const api = globalThis.browser?.zenTreeTabs;
const values = {};
const rows = new Map(); // key -> { el, def }
const statusEl = document.getElementById("status");
let statusTimer = 0;

function flash(text) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.textContent = ""), 1800);
}

async function save(key, value) {
  values[key] = value;
  updateVisibility();
  try {
    await api.setPref(key, value);
    flash("Saved");
  } catch (e) {
    flash(`Could not save: ${e.message}`);
  }
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const MODIFIER_KEYS = new Set(["Alt", "Shift", "Control", "Meta", "AltGraph", "OS"]);
const KEY_NAMES = {
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
  PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End", Enter: "Enter",
  Tab: "Tab", " ": "Space", Delete: "Delete", Backspace: "Backspace", Insert: "Insert",
};

/** Turns a keydown into "Ctrl+Alt+Right", or null while only modifiers are held. */
function comboFromEvent(event) {
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }
  let name = KEY_NAMES[event.key] ?? (/^F\d{1,2}$/.test(event.key) ? event.key : null);
  if (!name) {
    // Use the physical key so Alt/Option doesn't turn letters into symbols.
    const code = event.code;
    if (/^Key[A-Z]$/.test(code)) {
      name = code.slice(3);
    } else if (/^Digit\d$/.test(code)) {
      name = code.slice(5);
    } else if (event.key.length === 1) {
      name = event.key.toUpperCase();
    } else {
      return null;
    }
  }
  const mods = [];
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (event.metaKey) mods.push("Meta");
  return { combo: [...mods, name].join("+"), hasModifier: mods.length > 0, isFunctionKey: /^F\d/.test(name) };
}

function buildControl(def) {
  switch (def.type) {
    case "bool": {
      const input = el("input", { type: "checkbox", id: `c-${def.key}` });
      input.addEventListener("change", () => save(def.key, input.checked));
      return { node: input, set: v => (input.checked = !!v) };
    }
    case "choice": {
      const select = el("select", { id: `c-${def.key}` });
      for (const [value, label] of def.choices) {
        select.append(el("option", { value, textContent: label }));
      }
      select.addEventListener("change", () => save(def.key, select.value));
      return { node: select, set: v => (select.value = v) };
    }
    case "int": {
      const range = el("input", { type: "range", id: `c-${def.key}`, min: def.min, max: def.max, step: def.step ?? 1 });
      const readout = el("span", { className: "value" });
      const show = () => (readout.textContent = `${range.value}${def.unit ?? ""}`);
      range.addEventListener("input", show);
      range.addEventListener("change", () => save(def.key, Number(range.value)));
      const wrap = el("div", { className: "control-inner" });
      wrap.style.cssText = "display:flex;gap:8px;align-items:center;width:100%";
      wrap.append(range, readout);
      return {
        node: wrap,
        set: v => {
          range.value = v;
          show();
        },
      };
    }
    case "shortcut": {
      const input = el("input", { type: "text", id: `c-${def.key}`, className: "shortcut", readOnly: true });
      const clear = el("button", { type: "button", textContent: "Clear", title: "Disable this shortcut" });
      const reset = el("button", { type: "button", textContent: "Reset", title: "Restore the default shortcut" });
      const show = v => {
        input.value = v || "";
        input.placeholder = "Click, then press keys";
        input.classList.toggle("empty", !v);
        if (!v) input.value = "";
      };
      input.addEventListener("keydown", event => {
        if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
          return; // keep keyboard navigation working
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
          input.blur();
          return;
        }
        const result = comboFromEvent(event);
        if (!result) {
          return;
        }
        if (!result.hasModifier && !result.isFunctionKey) {
          flash("Add at least one modifier (Alt, Ctrl, Shift or Meta)");
          return;
        }
        show(result.combo);
        save(def.key, result.combo);
      });
      clear.addEventListener("click", () => {
        show("");
        save(def.key, "");
      });
      reset.addEventListener("click", () => {
        show(def.default);
        save(def.key, def.default);
      });
      const wrap = el("div");
      wrap.style.cssText = "display:flex;gap:6px;align-items:center";
      wrap.append(input, clear, reset);
      return { node: wrap, set: show };
    }
  }
  return null;
}

function matches(cond, values) {
  if (!cond) return true;
  return "not" in cond ? values[cond.key] !== cond.not : values[cond.key] === cond.value;
}

function updateVisibility() {
  for (const { el: row, def } of rows.values()) {
    row.hidden = !matches(def.visibleIf, values);
  }
}

function render(stored) {
  const root = document.getElementById("root");
  root.replaceChildren();
  rows.clear();
  for (const group of ZTT_SETTINGS) {
    const fieldset = el("fieldset", {}, el("legend", { textContent: group.group }));
    for (const def of group.items) {
      const control = buildControl(def);
      values[def.key] = def.key in stored ? stored[def.key] : def.default;
      control.set(values[def.key]);
      const row = el("div", { className: def.type === "choice" ? "row wide" : "row" });
      row.append(el("label", { className: "label", htmlFor: `c-${def.key}`, textContent: def.label }));
      if (def.description) {
        row.append(el("div", { className: "desc", textContent: def.description }));
      }
      const holder = el("div", { className: "control" });
      holder.append(control.node);
      row.append(holder);
      fieldset.append(row);
      rows.set(def.key, { el: row, def });
    }
    root.append(fieldset);
  }
  updateVisibility();
}

document.getElementById("reset").addEventListener("click", async () => {
  if (!confirm("Reset every Zen Tree Tabs setting to its default?")) {
    return;
  }
  await api.resetPrefs();
  render({});
  flash("Defaults restored");
});

(async () => {
  let stored = {};
  try {
    stored = await api.getPrefs();
  } catch (e) {
    flash(`Could not load settings: ${e.message}`);
  }
  render(stored);
})();
