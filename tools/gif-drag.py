#!/usr/bin/env python3
"""Records docs/screenshots/drag-subtree.gif: a tab with children dragged onto
another tab and nested under it.

The drag runs through Zen's own drag-and-drop handlers (synthetic drag events;
real ones can't be scripted), so the cursor and drag image are drawn on top.
Needs ImageMagick and a browser running the demo session:

  MARIONETTE_PORT=2831 tools/marionette.py evalf tools/demo.js
  MARIONETTE_PORT=2831 tools/gif-drag.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from gifkit import ROOT, Recorder  # noqa: E402
from marionette import Marionette  # noqa: E402

SOURCE, TARGET = "Espresso - ", "Coffeehouse"
STEPS = 9

rec = Recorder(Marionette())
m = rec.m
rec.park()  # no leftover hover effects in the sidebar

# Select the tab to drag (a real mousedown would) and measure the rows.
geo = m.eval(f"""
const T = l => gBrowser.tabs.find(t => t.label.startsWith(l));
gBrowser.selectedTab = T({SOURCE!r});
await new Promise(r => setTimeout(r, 600));
const rect = el => {{ const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }};
return {{ src: rect(T({SOURCE!r})), dst: rect(T({TARGET!r})) }};
""")
sx, sy, sw, sh = geo["src"]
dx, dy, dw, dh = geo["dst"]
px = sx + 90  # pointer x, over the label (leaves room for the drag image)

rec.shot(120)
ghost = rec.crop_frame(0, (sx, sy, min(sw, 210), sh), "ghost.png", opacity=70)  # icon + title

m.eval(f"""
const T = l => gBrowser.tabs.find(t => t.label.startsWith(l));
const src = T({SOURCE!r});
const dt = new DataTransfer();
const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, {{
  bubbles: true, cancelable: true, dataTransfer: dt,
  clientX: x, clientY: y, screenX: mozInnerScreenX + x, screenY: mozInnerScreenY + y }}));
const under = (x, y) => document.elementFromPoint(x, y)?.closest(".tabbrowser-tab") ?? src;
window.__zttGif = {{
  over: (x, y) => fire(under(x, y), "dragover", x, y),
  drop: (x, y) => {{ fire(under(x, y), "drop", x, y); fire(src, "dragend", x, y); }},
}};
fire(src, "dragstart", {px}, {sy + sh / 2});
dt.dropEffect = "move";
return true;
""")
start, end = sy + sh / 2, dy + dh / 2
for i in range(STEPS + 1):
    y = start + (end - start) * i / STEPS
    m.eval(f"__zttGif.over({px}, {y}); await new Promise(r => setTimeout(r, 60)); return 1;")
    # Drag image below-right of the cursor, so the row under it stays visible.
    rec.shot(10 if i < STEPS else 90, (px, y), (ghost, px + 12, y + 14))

m.eval(f"__zttGif.drop({px}, {end}); delete window.__zttGif; await new Promise(r => setTimeout(r, 900)); return 1;")
rec.shot(300)
rec.save(os.path.join(ROOT, "docs/screenshots/drag-subtree.gif"))
