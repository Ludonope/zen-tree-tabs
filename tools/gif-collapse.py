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


def icon(label):
    """Center of a tab's favicon, in CSS px."""
    return tuple(rec.m.eval(f"""
const tab = gBrowser.tabs.find(t => t.label.startsWith({label!r}));
const r = tab.querySelector(".tab-icon-image").getBoundingClientRect();
return [r.left + r.width / 2, r.top + r.height / 2];"""))


def toggle(label, hold_after=110):
    """Hover the icon (twisty appears), click it, then move onto the title."""
    x, y = icon(label)
    rec.move(x, y, steps=4, hold=60)
    rec.click(hold=50)
    rec.move(x + 120, y, steps=3, hold=hold_after)


rec.park()
x, y = icon("History of coffee")
rec.move(x + 120, y, steps=1, hold=100)  # start resting on a title
toggle("History of coffee")     # collapse a branch: badge shows 3
toggle("Coffee - ")             # collapse the whole tree: badge shows 8
toggle("Coffee - ", 100)        # expand it again: the inner branch stays collapsed
toggle("History of coffee", 250)  # and expand that too
rec.save(os.path.join(ROOT, "docs/screenshots/collapse.gif"))
