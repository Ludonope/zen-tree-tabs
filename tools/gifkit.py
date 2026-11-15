"""Helpers for recording README GIFs from a running Zen (see gif-*.py).

Frames are real screenshots of the browser window. Screenshots don't include
the mouse cursor (or a drag image), so those are composited on top.
"""
import os
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIDEBAR_CROP = (520, 1130)  # device pixels, matches tools/demo.js at 1.6x density
CURSOR = [(1, 1), (1, 18), (5.5, 14), (8.5, 21), (11, 20), (8, 13.5), (14, 13.5)]


class Recorder:
    def __init__(self, marionette):
        self.m = marionette
        self.tmp = tempfile.mkdtemp(prefix="ztt-gif-")
        self.dpr = marionette.eval("return devicePixelRatio;")
        self.frames = []  # (png, delay in 1/100 s, pointer (x, y) in CSS px or None, overlay or None)
        self.pointer = None

    def shot(self, delay, pointer=None, overlay=None):
        path = os.path.join(self.tmp, f"f{len(self.frames):03}.png")
        self.m.screenshot(path)
        self.frames.append((path, delay, pointer, overlay))

    def sleep(self, ms):
        self.m.eval(f"await new Promise(r => setTimeout(r, {ms})); return 1;")

    # ---- real mouse input (WebDriver actions, so :hover and clicks are genuine)

    def _pointer(self, actions):
        self.m.send("WebDriver:PerformActions", {"actions": [{
            "type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": actions}]})

    def park(self):
        """Moves the real mouse over the page, away from the sidebar (not recorded)."""
        self._pointer([{"type": "pointerMove", "origin": "viewport", "x": 900, "y": 400}])
        self.pointer = None
        self.sleep(300)

    def move(self, x, y, steps=4, step_delay=5, hold=0):
        """Glide the mouse to (x, y), one frame per step; the last frame lasts `hold`."""
        x0, y0 = self.pointer or (x, y)
        for i in range(1, steps + 1):
            px, py = x0 + (x - x0) * i / steps, y0 + (y - y0) * i / steps
            self._pointer([{"type": "pointerMove", "origin": "viewport", "x": round(px), "y": round(py)}])
            self.pointer = (px, py)
            self.sleep(80)  # let hover styles apply
            self.shot(hold if i == steps and hold else step_delay, self.pointer)

    def click(self, hold=60):
        self._pointer([{"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}])
        self.sleep(350)
        self.shot(hold, self.pointer)

    # ---- output

    def crop_frame(self, index, rect_css, out_name, opacity=None):
        """Cuts a CSS-px rect out of a recorded frame (e.g. to build a drag image)."""
        x, y, w, h = (round(v * self.dpr) for v in rect_css)
        out = os.path.join(self.tmp, out_name)
        cmd = ["magick", self.frames[index][0], "-crop", f"{w}x{h}+{x}+{y}", "+repage"]
        if opacity is not None:
            cmd += ["-alpha", "set", "-channel", "A", "-evaluate", "set", f"{opacity}%", "+channel"]
        subprocess.run(cmd + [out], check=True)
        return out

    def save(self, out, crop=SIDEBAR_CROP, scale="75%"):
        s = self.dpr
        cursor = os.path.join(self.tmp, "cursor.png")
        subprocess.run(["magick", "-size", f"{int(16 * s)}x{int(24 * s)}", "xc:none", "-stroke", "black",
                        "-strokewidth", f"{1.2 * s}", "-fill", "white", "-draw",
                        "polygon " + " ".join(f"{x * s},{y * s}" for x, y in CURSOR), cursor], check=True)
        args = []
        for i, (path, delay, pointer, overlay) in enumerate(self.frames):
            frame = os.path.join(self.tmp, f"c{i:03}.png")
            cmd = ["magick", path, "-crop", f"{crop[0]}x{crop[1]}+0+0", "+repage"]
            if overlay:  # (png, x, y) in CSS px
                png, ox, oy = overlay
                cmd += [png, "-geometry", f"+{round(ox * s)}+{round(oy * s)}", "-composite"]
            if pointer:
                cmd += [cursor, "-geometry", f"+{round(pointer[0] * s)}+{round(pointer[1] * s)}", "-composite"]
            subprocess.run(cmd + [frame], check=True)
            args += ["-delay", str(delay), frame]
        subprocess.run(["magick", *args, "-resize", scale, "-layers", "Optimize", "-loop", "0", out], check=True)
        print(out, os.path.getsize(out) // 1024, "KiB")
