#!/usr/bin/env python3
"""Minimal Marionette client for driving a dev Zen instance (chrome context).

Usage:
  marionette.py eval  'return gBrowser.tabs.length'      # run chrome JS, print JSON result
  marionette.py evalf path/to/script.js                  # same, script from file
  marionette.py shot  out.png                             # screenshot of the browser window
  marionette.py content 'document.querySelector("a").click()'  # run JS in the selected tab
  marionette.py click '#link' [button]                    # real (trusted) click in the selected tab
  marionette.py chromeclick '.ztt-twisty' [button]        # real click on browser UI
"""
import base64
import json
import os
import socket
import sys
import time

PORT = int(os.environ.get("MARIONETTE_PORT", "2829"))


class Marionette:
    def __init__(self, port=PORT):
        deadline = time.time() + 40  # the browser may still be starting
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=60)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)
        self.msg_id = 0
        self._recv()  # hello
        self.send("WebDriver:NewSession", {"capabilities": {}})
        self.send("Marionette:SetContext", {"value": "chrome"})

    def _recv(self):
        buf = b""
        while b":" not in buf:
            buf += self.sock.recv(1)
        length, rest = buf.split(b":", 1)
        length = int(length)
        while len(rest) < length:
            rest += self.sock.recv(length - len(rest))
        return json.loads(rest)

    def send(self, name, params):
        self.msg_id += 1
        data = json.dumps([0, self.msg_id, name, params]).encode()
        self.sock.sendall(str(len(data)).encode() + b":" + data)
        while True:
            msg = self._recv()
            if msg[0] == 1 and msg[1] == self.msg_id:
                if msg[2]:
                    raise RuntimeError(json.dumps(msg[2], indent=1))
                return msg[3]

    def eval(self, script, args=()):
        # Async wrapper so scripts may use await; last arg is the resolve callback.
        wrapped = (
            "const [resolve] = [arguments[arguments.length - 1]];"
            "(async () => {" + script + "})().then(resolve, e => resolve({__error: String(e) + '\\n' + e.stack}));"
        )
        res = self.send(
            "WebDriver:ExecuteAsyncScript",
            {"script": wrapped, "args": list(args), "scriptTimeout": 30000},
        )
        return res.get("value") if isinstance(res, dict) else res

    def screenshot(self, path):
        res = self.send("WebDriver:TakeScreenshot", {"full": False})
        with open(path, "wb") as f:
            f.write(base64.b64decode(res["value"]))


def main():
    cmd, arg = sys.argv[1], sys.argv[2]
    m = Marionette()
    if cmd == "eval":
        print(json.dumps(m.eval(arg), indent=1))
    elif cmd == "evalf":
        with open(arg) as f:
            print(json.dumps(m.eval(f.read()), indent=1))
    elif cmd == "content":
        m.send("Marionette:SetContext", {"value": "content"})
        res = m.send("WebDriver:ExecuteScript", {"script": arg, "args": []})
        print(json.dumps(res.get("value"), indent=1))
    elif cmd in ("click", "chromeclick"):
        if cmd == "click":
            m.send("Marionette:SetContext", {"value": "content"})
        el = m.send("WebDriver:FindElement", {"using": "css selector", "value": arg})["value"]
        button = int(sys.argv[3]) if len(sys.argv) > 3 else 0
        m.send("WebDriver:PerformActions", {"actions": [{
            "type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"},
            "actions": [
                {"type": "pointerMove", "origin": el, "x": 0, "y": 0},
                {"type": "pointerDown", "button": button},
                {"type": "pointerUp", "button": button},
            ]}]})
        m.send("WebDriver:ReleaseActions", {})
    elif cmd == "shot":
        m.screenshot(arg)
        print(arg)
    else:
        sys.exit(f"unknown command {cmd}")
    m.send("WebDriver:DeleteSession", {})


if __name__ == "__main__":
    main()
