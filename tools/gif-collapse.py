#!/usr/bin/env python3
"""Records docs/screenshots/collapse.gif: collapsing and expanding branches by
hovering a parent's icon and clicking the twisty, with real mouse input.

Needs ImageMagick and a browser running the demo session:

  MARIONETTE_PORT=2831 tools/marionette.py evalf tools/demo.js
  MARIONETTE_PORT=2831 tools/gif-collapse.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from gifkit import ROOT, Recorder  # noqa: E402
from marionette import Marionette  # noqa: E402

rec = Recorder(Marionette())
rng = rec.rng


def icon(label):
    """Center of a tab's favicon, in CSS px."""
    return tuple(rec.m.eval(f"""
const tab = gBrowser.tabs.find(t => t.label.startsWith({label!r}));
const r = tab.querySelector(".tab-icon-image").getBoundingClientRect();
return [r.left + r.width / 2, r.top + r.height / 2];"""))


def press(label):
    """Aim at the icon (the twisty appears on hover), a brief beat, click."""
    rec.glide(*rec.jitter(*icon(label), 3))
    rec.idle(rng.uniform(0.12, 0.3))
    rec.click()


def relax():
    """After a click the hand eases off the icon a little (revealing the badge)."""
    x, y = rec.pointer
    rec.glide(x + rng.uniform(14, 30), y + rng.uniform(5, 13))


rec.park()
# The hand starts resting lower in the list; the loop also ends there.
x, y = icon("Latte")
start = (x + rng.uniform(150, 200), y + rng.uniform(-6, 6))
rec.pointer = start
rec.idle(0.7)

press("History of coffee")   # collapse a branch: badge shows 3
relax()
rec.idle(0.8)
press("Coffee - ")           # collapse the whole tree: badge shows 8
relax()
rec.idle(1.3)                # a bigger change, looked at a bit longer
press("Coffee - ")           # expand it again: the inner branch stays collapsed
rec.idle(0.7)
press("History of coffee")   # and expand that too
relax()
rec.idle(1.0)
rec.glide(*start)            # drift back so the loop is seamless
rec.idle(0.5)
rec.save(os.path.join(ROOT, "docs/screenshots/collapse.gif"))
