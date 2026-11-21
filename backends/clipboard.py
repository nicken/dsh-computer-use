#!/usr/bin/env python3
"""dsh-computer-use — X11 clipboard helper (GTK selection owner).

Used by the Linux adapter so `type` can inject text through the clipboard
(Ctrl+V) instead of raw key events: raw key events go through XIM/ibus, so an
active CJK input method can turn "a.b.c" into pinyin candidates and drop dots.

Modes (spawned by backends/linux-adapter.mjs, not by hand):

  python3 clipboard.py set <base64-text> [holdSeconds]
      Own CLIPBOARD with the decoded text, print READY on stdout, then serve
      selection requests until holdSeconds elapse or SIGTERM arrives.

  python3 clipboard.py get [timeoutSeconds]
      Request the clipboard text and print it base64-encoded (empty when there
      is no owner). Exits after the reply or the timeout.
"""

import base64
import signal
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gtk, Gdk, GLib  # noqa: E402


def clipboard():
    return Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)


def do_set(text, hold_seconds):
    cb = clipboard()
    cb.set_text(text, -1)
    # Ask a clipboard manager to take over when one exists; the hold window
    # below keeps serving paste requests when none does.
    cb.store()

    loop = GLib.MainLoop()

    def stop(_signum=None, _frame=None):
        loop.quit()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    GLib.timeout_add(int(hold_seconds * 1000), stop)
    print("READY", flush=True)
    loop.run()


def do_get(timeout_seconds):
    cb = clipboard()
    result = {"text": None}
    loop = GLib.MainLoop()

    def on_text(*args):
        # GTK3's Python override passes (clipboard, text) while C callbacks get
        # an extra user_data argument; accept both.
        result["text"] = args[1] if len(args) > 1 else None
        loop.quit()

    def on_timeout():
        loop.quit()
        return False

    cb.request_text(on_text)
    GLib.timeout_add(int(timeout_seconds * 1000), on_timeout)
    loop.run()
    text = result["text"] or ""
    sys.stdout.write(base64.b64encode(text.encode("utf-8")).decode("ascii") + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        print("usage: clipboard.py set|get ...", file=sys.stderr)
        return 2
    mode = sys.argv[1]
    if mode == "set":
        text = base64.b64decode(sys.argv[2]).decode("utf-8") if len(sys.argv) > 2 and sys.argv[2] else ""
        hold = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0
        do_set(text, hold)
        return 0
    if mode == "get":
        timeout = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
        do_get(timeout)
        return 0
    print(f"unknown mode {mode}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
