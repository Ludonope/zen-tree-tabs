#!/usr/bin/env python3
"""Records docs/screenshots/drag-subtree.gif: a tab with children dragged onto
another tab and nested under it.

Every frame is a real screenshot taken while a drag runs through Zen's own
drag-and-drop handlers. Synthetic drags draw no cursor or drag image, so those
are composited on top. Needs ImageMagick (`magick`) and a browser running the
demo session from tools/demo.js:

  MARIONETTE_PORT=2831 tools/marionette.py evalf tools/demo.js
  MARIONETTE_PORT=2831 tools/demo-gif.py
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
from marionette import Marionette  # noqa: E402

SOURCE, TARGET = "Espresso - ", "Coffeehouse"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs/screenshots/drag-subtree.gif")
CROP = (520, 1130)  # sidebar area, device pixels
STEPS = 9

m = Marionette()
tmp = tempfile.mkdtemp(prefix="ztt-gif-")

# Select the tab to drag (a real mousedown would) and measure the rows.
geo = m.eval(f"""
const T = l => gBrowser.tabs.find(t => t.label.startsWith(l));
gBrowser.selectedTab = T({SOURCE!r});
await new Promise(r => setTimeout(r, 600));
const rect = el => {{ const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }};
return {{ dpr: devicePixelRatio, src: rect(T({SOURCE!r})), dst: rect(T({TARGET!r})) }};
""")
dpr = geo["dpr"]
sx, sy, sw, sh = geo["src"]
dx, dy, dw, dh = geo["dst"]
px = sx + 90  # pointer x, over the label (leaves room for the drag image)

frames = []  # (png, delay in 1/100 s, pointer (x, y) in CSS px or None)


def shot(delay, pointer=None):
    path = os.path.join(tmp, f"f{len(frames):02}.png")
    m.screenshot(path)
    frames.append((path, delay, pointer))


shot(120)

# Start the drag on the source tab, then move up to the target row's middle.
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
    shot(10 if i < STEPS else 90, (px, y))

m.eval(f"__zttGif.drop({px}, {end}); delete window.__zttGif; await new Promise(r => setTimeout(r, 900)); return 1;")
shot(300)

# Composite: crop to the sidebar, add the drag image and cursor.
cw, ch = CROP
ghost = os.path.join(tmp, "ghost.png")
row = (int(sx * dpr), int(sy * dpr), int(min(sw, 210) * dpr), int(sh * dpr))  # icon + title
subprocess.run(["magick", frames[0][0], "-crop", f"{row[2]}x{row[3]}+{row[0]}+{row[1]}", "+repage",
                "-alpha", "set", "-channel", "A", "-evaluate", "set", "70%", "+channel", ghost], check=True)
cursor = os.path.join(tmp, "cursor.png")
s = dpr
subprocess.run(["magick", "-size", f"{int(16 * s)}x{int(24 * s)}", "xc:none", "-stroke", "black",
                "-strokewidth", f"{1.2 * s}", "-fill", "white", "-draw",
                "polygon " + " ".join(f"{x * s},{y * s}" for x, y in
                                      [(1, 1), (1, 18), (5.5, 14), (8.5, 21), (11, 20), (8, 13.5), (14, 13.5)]),
                cursor], check=True)

final = []
for i, (path, delay, pointer) in enumerate(frames):
    out = os.path.join(tmp, f"c{i:02}.png")
    cmd = ["magick", path, "-crop", f"{cw}x{ch}+0+0", "+repage"]
    if pointer:
        x, y = pointer
        # Below-right of the cursor, like a drag image, so the row under it stays visible.
        gx, gy = int((x + 12) * dpr), int((y + 14) * dpr)
        cmd += [ghost, "-geometry", f"+{gx}+{gy}", "-composite",
                cursor, "-geometry", f"+{int(x * dpr)}+{int(y * dpr)}", "-composite"]
    subprocess.run(cmd + [out], check=True)
    final += ["-delay", str(delay), out]

subprocess.run(["magick", *final, "-resize", "75%", "-layers", "Optimize", "-loop", "0", OUT], check=True)
print(OUT, os.path.getsize(OUT) // 1024, "KiB")
