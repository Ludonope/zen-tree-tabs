"""Helpers for recording README GIFs from a running Zen (see gif-*.py).

Frames are real screenshots of the browser window. Screenshots don't include
the mouse cursor (or a drag image), so those are composited on top.
"""
import math
import os
import random
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIDEBAR_CROP = (520, 1130)  # device pixels, matches tools/demo.js at 1.6x density
CURSOR = [(1, 1), (1, 18), (5.5, 14), (8.5, 21), (11, 20), (8, 13.5), (14, 13.5)]


class Recorder:
    def __init__(self, marionette, seed=7):
        self.m = marionette
        self.rng = random.Random(seed)  # seeded: re-recording gives the same motion
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

    def jitter(self, x, y, radius):
        """A point near (x, y), so landings aren't pixel-perfect."""
        angle = self.rng.uniform(0, 2 * math.pi)
        dist = radius * math.sqrt(self.rng.random())
        return x + dist * math.cos(angle), y + dist * math.sin(angle)

    FRAME_MS = 30

    def _frame(self, x, y, delay_ms=FRAME_MS):
        self._pointer([{"type": "pointerMove", "origin": "viewport", "x": round(x), "y": round(y)}])
        self.pointer = (x, y)
        self.sleep(40)  # let hover styles apply
        self.shot(max(2, round(delay_ms / 10)), self.pointer)

    def _stroke(self, x, y, duration, bend, skew):
        """One continuous hand movement: curved path, smooth start and stop
        (minimum-jerk profile), peak speed shifted early by `skew` < 1."""
        x0, y0 = self.pointer
        dx, dy = x - x0, y - y0
        dist = math.hypot(dx, dy) or 1
        cx = x0 + dx / 2 - dy / dist * bend * dist
        cy = y0 + dy / 2 + dx / dist * bend * dist
        steps = max(2, round(duration * 1000 / self.FRAME_MS))
        for i in range(1, steps + 1):
            u = (i / steps) ** skew
            t = u ** 3 * (10 - 15 * u + 6 * u * u)
            self._frame((1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x,
                        (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y)

    def glide(self, x, y):
        """Moves to (x, y) the way a hand aims: a quick main movement that lands a
        little off (short or past), then a small, slower correction."""
        x0, y0 = self.pointer or (x, y)
        dist = math.hypot(x - x0, y - y0)
        if dist < 1:
            return
        duration = 0.10 + 0.09 * math.log2(dist / 6 + 1)  # Fitts-like: long moves aren't proportionally slower
        error = min(7, 0.07 * dist)
        ux, uy = (x - x0) / dist, (y - y0) / dist
        along, across = self.rng.uniform(-0.6, 1.0) * error, self.rng.uniform(-0.5, 0.5) * error
        aim = (x + ux * along - uy * across, y + uy * along + ux * across)
        self._stroke(*aim, duration * 0.85, self.rng.uniform(-0.12, 0.12), skew=0.8)
        if error > 1.5:
            self._stroke(x, y, 0.08 + 0.02 * error, self.rng.uniform(-0.05, 0.05), skew=1.0)

    def idle(self, seconds):
        """Holds still the way a resting hand does: tiny random drift."""
        ax, ay = self.pointer
        elapsed = 0
        while elapsed < seconds * 1000:
            dt = self.rng.randint(130, 260)
            x, y = self.pointer
            # Random walk, gently pulled back toward where the pause began.
            x += self.rng.uniform(-0.8, 0.8) + (ax - x) * 0.3
            y += self.rng.uniform(-0.8, 0.8) + (ay - y) * 0.3
            self._frame(x, y, dt)
            elapsed += dt

    def click(self):
        self._pointer([{"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}])
        self.sleep(250)
        self.shot(round(self.FRAME_MS / 10), self.pointer)

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
