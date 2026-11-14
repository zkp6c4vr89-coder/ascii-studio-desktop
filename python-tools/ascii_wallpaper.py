"""Animated ASCII wallpaper for macOS.

  python ascii_wallpaper.py                       # character rain
  python ascii_wallpaper.py ~/Movies/clip.mp4     # your video, looping, as ASCII
  python ascii_wallpaper.py photo.jpg --style mono --shimmer 0.8

macOS has no setting for custom moving wallpapers, so (like Plash or Wallpaper
Engine) this puts a borderless window on every screen *below the desktop icons*.
The window shows web/wallpaper.html, which draws on the GPU, so it stays light.
A menu-bar icon (the ▚ symbol) lets you pause, change the source, or quit.
"""

from __future__ import annotations

import _venv  # noqa: F401  (restarts with the project Python if needed)

import argparse
import mimetypes
import re
import secrets
import subprocess
import threading
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import objc
from AppKit import (
    NSApp,
    NSApplication,
    NSApplicationActivationPolicyAccessory,
    NSApplicationDidChangeScreenParametersNotification,
    NSBackingStoreBuffered,
    NSColor,
    NSMenu,
    NSMenuItem,
    NSModalResponseOK,
    NSOpenPanel,
    NSScreen,
    NSStatusBar,
    NSVariableStatusItemLength,
    NSWindow,
    NSWindowCollectionBehaviorCanJoinAllSpaces,
    NSWindowCollectionBehaviorIgnoresCycle,
    NSWindowCollectionBehaviorStationary,
    NSWindowStyleMaskBorderless,
)
from Foundation import NSURL, NSNotificationCenter, NSObject, NSTimer, NSURLRequest
from PyObjCTools import AppHelper
from Quartz import CGWindowLevelForKey, kCGDesktopWindowLevelKey
from WebKit import WKWebView, WKWebViewConfiguration

WEB_DIR = Path(__file__).resolve().parent.parent / "web"   # the app's copy of the website (see sync_web.py)
STYLES = ("colour", "matrix", "mono")


# ---------- tiny local web server: the page + your media file ----------
# Only this app should be able to read it. Every run gets a secret random path prefix, and
# requests must be addressed to 127.0.0.1:<port> exactly, which also defeats DNS-rebinding
# tricks where a website points its own domain name at your computer.
TOKEN = secrets.token_urlsafe(18)


class Handler(SimpleHTTPRequestHandler):
    media: Path | None = None
    port: int = 0

    def log_message(self, *args):  # keep the terminal quiet
        pass

    def _allowed(self) -> bool:
        prefix = f"/{TOKEN}/"
        if self.headers.get("Host") != f"127.0.0.1:{Handler.port}" or not self.path.startswith(prefix):
            self.send_error(404)
            return False
        self.path = "/" + self.path[len(prefix):]
        return True

    def list_directory(self, path):  # never list folders
        self.send_error(404)
        return None

    def do_HEAD(self):
        if self._allowed():
            super().do_HEAD()

    def do_GET(self):
        if not self._allowed():
            return
        if self.path.startswith("/media/"):
            self._send_media()
        else:
            super().do_GET()

    def _send_media(self):
        f = Handler.media
        if not f or not f.exists():
            self.send_error(404)
            return
        size = f.stat().st_size
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range") or "")
        if m:  # video players ask for byte ranges, Safari/WebKit insists on it
            if m[1]:
                start = int(m[1])
                end = min(int(m[2]), size - 1) if m[2] else size - 1
            elif m[2]:
                start = max(0, size - int(m[2]))
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(f, "rb") as fh:
            fh.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = fh.read(min(1 << 20, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(chunk)


def start_server() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(WEB_DIR)))
    Handler.port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return Handler.port


def on_battery() -> bool:
    out = subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True).stdout
    return "Battery Power" in out


# ---------- the app ----------
class Controller(NSObject):
    def initWithArgs_port_(self, args, port):
        self = objc.super(Controller, self).init()
        if self is None:
            return None
        self.args, self.port = args, port
        self.media_version = 0
        self.windows, self.views = [], []
        self.paused = False
        if args.file:
            self.set_media(Path(args.file).expanduser().resolve())
        return self

    # --- helpers (plain Python, not Objective-C methods)
    @objc.python_method
    def set_media(self, path: Path | None):
        Handler.media = path
        self.media_version += 1

    @objc.python_method
    def page_url(self) -> str:
        a = self.args
        q = {"style": a.style, "cell": a.cell, "glow": a.glow, "fps": self.fps()}
        if a.shimmer is not None:
            q["shimmer"] = a.shimmer
        if Handler.media:
            q["src"] = f"/{TOKEN}/media/{self.media_version}/{urllib.parse.quote(Handler.media.name)}"
        return f"http://127.0.0.1:{self.port}/{TOKEN}/wallpaper.html?{urllib.parse.urlencode(q)}"

    @objc.python_method
    def fps(self) -> int:
        return self.args.battery_fps if on_battery() else self.args.fps

    @objc.python_method
    def js(self, code: str):
        for v in self.views:
            v.evaluateJavaScript_completionHandler_(code, None)

    @objc.python_method
    def build_windows(self):
        for w in self.windows:
            w.orderOut_(None)
        self.windows, self.views = [], []
        level = CGWindowLevelForKey(kCGDesktopWindowLevelKey)
        behaviour = (NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary
                     | NSWindowCollectionBehaviorIgnoresCycle)
        for screen in NSScreen.screens():
            frame = screen.frame()
            win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
                frame, NSWindowStyleMaskBorderless, NSBackingStoreBuffered, False)
            win.setLevel_(level)
            win.setCollectionBehavior_(behaviour)
            win.setIgnoresMouseEvents_(True)     # clicks go through to the desktop
            win.setBackgroundColor_(NSColor.blackColor())
            win.setHasShadow_(False)
            win.setReleasedWhenClosed_(False)
            cfg = WKWebViewConfiguration.alloc().init()
            cfg.setMediaTypesRequiringUserActionForPlayback_(0)   # allow muted autoplay
            view = WKWebView.alloc().initWithFrame_configuration_(((0, 0), (frame.size.width, frame.size.height)), cfg)
            view.loadRequest_(NSURLRequest.requestWithURL_(NSURL.URLWithString_(self.page_url())))
            win.setContentView_(view)
            win.setFrame_display_(frame, True)
            win.orderFront_(None)
            self.windows.append(win)
            self.views.append(view)
        print(f"wallpaper on {len(self.windows)} screen(s)")

    @objc.python_method
    def build_menu(self):
        self.item = NSStatusBar.systemStatusBar().statusItemWithLength_(NSVariableStatusItemLength)
        self.item.button().setTitle_("▚")
        menu = NSMenu.alloc().init()

        def add(title, action):
            mi = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, action, "")
            mi.setTarget_(self)
            menu.addItem_(mi)
            return mi

        self.pause_item = add("Pause", "togglePause:")
        add("Choose photo or video…", "chooseFile:")
        add("Character rain", "useRain:")
        add("Next style", "nextStyle:")
        menu.addItem_(NSMenuItem.separatorItem())
        add("Quit ASCII Wallpaper", "quit:")
        self.item.setMenu_(menu)

    # --- Objective-C actions (menu items, timers, notifications)
    def togglePause_(self, _):
        self.paused = not self.paused
        self.js("window.wallpaper && window.wallpaper.toggle()")
        self.pause_item.setTitle_("Resume" if self.paused else "Pause")

    def chooseFile_(self, _):
        NSApp.activateIgnoringOtherApps_(True)
        panel = NSOpenPanel.openPanel()
        panel.setAllowsMultipleSelection_(False)
        if panel.runModal() == NSModalResponseOK:
            self.set_media(Path(panel.URLs()[0].path()))
            self.build_windows()

    def useRain_(self, _):
        self.set_media(None)
        self.args.style = "matrix"
        self.build_windows()

    def nextStyle_(self, _):
        self.args.style = STYLES[(STYLES.index(self.args.style) + 1) % len(STYLES)]
        self.build_windows()

    def screensChanged_(self, _):
        self.build_windows()

    def checkPower_(self, _):
        self.js(f"window.wallpaper && window.wallpaper.setFps({self.fps()})")

    def selfCheck_(self, _):
        def report(result, error):
            print("page check:", result if result else error)
        if self.views:
            self.views[0].evaluateJavaScript_completionHandler_(
                "JSON.stringify({canvas: [document.getElementById('out').width, document.getElementById('out').height],"
                " running: !!window.wallpaper})", report)

    def quit_(self, _):
        NSApp.terminate_(None)


def main():
    p = argparse.ArgumentParser(description="Animated ASCII wallpaper")
    p.add_argument("file", nargs="?", help="photo or video (leave out for character rain)")
    p.add_argument("--style", choices=STYLES)
    p.add_argument("--cell", type=float, default=7, help="character width in points")
    p.add_argument("--glow", type=float, default=0.5)
    p.add_argument("--shimmer", type=float, help="0..1, photos default to 0.6")
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--battery-fps", type=int, default=15)
    args = p.parse_args()
    args.style = args.style or ("colour" if args.file else "matrix")

    port = start_server()
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)   # no Dock icon
    ctl = Controller.alloc().initWithArgs_port_(args, port)
    ctl.build_menu()
    ctl.build_windows()
    NSNotificationCenter.defaultCenter().addObserver_selector_name_object_(
        ctl, "screensChanged:", NSApplicationDidChangeScreenParametersNotification, None)
    NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(60, ctl, "checkPower:", None, True)
    NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(3, ctl, "selfCheck:", None, False)
    print("running. Quit from the ▚ menu-bar icon (or Ctrl+C here).")
    AppHelper.runEventLoop(installInterrupt=True)


if __name__ == "__main__":
    main()
